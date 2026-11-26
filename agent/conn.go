package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"os"
	"runtime"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

const (
	minBackoff   = time.Second
	maxBackoff   = 30 * time.Second
	writeTimeout = 10 * time.Second
	outboxSize   = 1024
)

// message is the union of every frame exchanged with the server (see
// docs/SECURITY.md). Binary fields (d, key) carry unpadded base64url envelopes.
type message struct {
	T        string          `json:"t"`
	ID       string          `json:"id,omitempty"`
	D        string          `json:"d,omitempty"`
	Key      string          `json:"key,omitempty"`
	Gen      string          `json:"gen,omitempty"`
	Seq      uint64          `json:"seq,omitempty"`
	S        string          `json:"s,omitempty"`
	K        uint64          `json:"k,omitempty"`
	Cols     uint16          `json:"cols,omitempty"`
	Rows     uint16          `json:"rows,omitempty"`
	Shell    string          `json:"shell,omitempty"`
	Pid      int             `json:"pid,omitempty"`
	Code     *int            `json:"code,omitempty"`
	Error    string          `json:"error,omitempty"`
	Ts       json.RawMessage `json:"ts,omitempty"`
	Hostname string          `json:"hostname,omitempty"`
	Name     string          `json:"name,omitempty"`
	OS       string          `json:"os,omitempty"`
	Arch     string          `json:"arch,omitempty"`
	Version  string          `json:"version,omitempty"`
	Sessions []string        `json:"sessions,omitempty"`
	Rid      string          `json:"rid,omitempty"`
	Sid      string          `json:"sid,omitempty"`
	N        *int            `json:"n,omitempty"`
	End      bool            `json:"end,omitempty"`
}

// outbox serialises writes to one connection through a single writer goroutine.
type outbox struct {
	ch   chan []byte
	done chan struct{}
}

// send queues a frame; it returns false if the connection is gone or saturated.
func (o *outbox) send(msg message) bool {
	b, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	select {
	case <-o.done:
		return false
	default:
	}
	select {
	case o.ch <- b:
		return true
	case <-o.done:
		return false
	case <-time.After(writeTimeout):
		return false
	}
}

// run keeps the agent connected until ctx is cancelled.
func run(ctx context.Context, cfg config, mgr *manager) {
	backoff := minBackoff
	for ctx.Err() == nil {
		start := time.Now()
		err := connectOnce(ctx, cfg, mgr)
		if ctx.Err() != nil {
			return
		}
		if time.Since(start) > time.Minute {
			backoff = minBackoff
		}
		delay := backoff/2 + rand.N(backoff/2+1)
		log.Printf("disconnected: %v (retry in %s)", err, delay.Round(100*time.Millisecond))
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// serverLink is the TCP connection of the agent to the server (or its proxy): packet captures
// leave it out, or capturing on the interface that carries it would capture its own upload.
type serverLink struct{ local, remote netip.AddrPort }

var currentLink atomic.Pointer[serverLink]

// recordLink wraps a transport's dialer to remember the addresses of the connection it opens.
func recordLink(tr *http.Transport) *http.Transport {
	dial := tr.DialContext
	if dial == nil {
		dial = (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	}
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := dial(ctx, network, addr)
		if err == nil {
			l, lok := c.LocalAddr().(*net.TCPAddr)
			r, rok := c.RemoteAddr().(*net.TCPAddr)
			if lok && rok {
				currentLink.Store(&serverLink{local: l.AddrPort(), remote: r.AddrPort()})
			}
		}
		return c, err
	}
	return tr
}

// connectOnce handles a single websocket connection lifetime.
func connectOnce(ctx context.Context, cfg config, mgr *manager) error {
	opts := &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": {"Bearer " + cfg.token}},
	}
	tr, _ := httpTransport(cfg.insecure, cfg.pin).(*http.Transport)
	if tr == nil {
		tr = http.DefaultTransport.(*http.Transport).Clone()
	}
	opts.HTTPClient = &http.Client{Transport: recordLink(tr)}
	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	c, resp, err := websocket.Dial(dialCtx, cfg.endpoint, opts)
	cancelDial()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return errors.New("token rejected (401)")
		}
		return err
	}
	c.SetReadLimit(64 << 20) // web tunnel requests can carry uploads
	defer c.CloseNow()

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	out := &outbox{ch: make(chan []byte, outboxSize), done: make(chan struct{})}
	writerErr := make(chan error, 1)
	go func() {
		defer close(out.done)
		for {
			select {
			case <-connCtx.Done():
				writerErr <- connCtx.Err()
				return
			case b := <-out.ch:
				wctx, wcancel := context.WithTimeout(connCtx, writeTimeout)
				err := c.Write(wctx, websocket.MessageText, b)
				wcancel()
				if err != nil {
					writerErr <- err
					cancel()
					return
				}
			}
		}
	}()

	hostname, _ := os.Hostname()
	out.send(message{
		T: "hello", Hostname: hostname, Name: cfg.name, OS: runtime.GOOS, Arch: runtime.GOARCH,
		Version: version, Shell: pickShell(), Sessions: mgr.ids(),
	})
	mgr.attach(out)
	defer mgr.detach(out)
	log.Printf("connected as %q", cfg.name)

	for {
		_, data, err := c.Read(connCtx)
		if err != nil {
			cancel()
			<-out.done
			select {
			case werr := <-writerErr:
				if !errors.Is(werr, context.Canceled) {
					return werr
				}
			default:
			}
			if ctx.Err() != nil {
				c.Close(websocket.StatusNormalClosure, "agent shutting down")
			}
			return err
		}
		var msg message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("bad frame: %v", err)
			continue
		}
		handle(msg, mgr, out)
	}
}

func handle(msg message, mgr *manager, out *outbox) {
	switch msg.T {
	case "open":
		if msg.ID != "" {
			mgr.open(msg, out)
		}
	case "input":
		mgr.input(msg)
	case "rekey":
		mgr.rekey(msg)
	case "resize":
		mgr.resize(msg.ID, msg.Cols, msg.Rows)
	case "close":
		mgr.kill(msg.ID)
	case "ping":
		out.send(message{T: "pong", Ts: msg.Ts})
	case "web.open":
		mgr.web.open(msg)
	case "web.close":
		mgr.web.close(msg.ID)
	case "http":
		go mgr.web.request(msg, out)
	case "probe":
		go mgr.probe.handle(msg, out)
	case "ws.open":
		go mgr.web.wsOpen(msg, out)
	case "ws.data":
		mgr.web.wsData(msg)
	case "ws.close":
		mgr.web.wsClose(msg)
	case "file":
		mgr.files.handle(msg, out)
	}
}
