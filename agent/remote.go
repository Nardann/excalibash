package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"strconv"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

// Remote sessions: the owner seals a target (telnet, ssh or raw TCP) with the terminal key, and
// this agent connects to it. The session stays the same encrypted stream as a local shell;
// only its source changes.

const (
	dialTimeout   = 10 * time.Second
	maxInputQueue = 1 << 20
	maxLineLen    = 1024
)

var (
	errTarget  = errors.New("cible distante invalide")
	errAborted = errors.New("saisie annulée")

	targetHost = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`)
	targetUser = regexp.MustCompile(`^[A-Za-z0-9._@\-]{0,64}$`)
)

type target struct {
	Kind          string `json:"kind"`
	Host          string `json:"host"`
	Port          int    `json:"port"`
	User          string `json:"user"`
	LegacyKex     bool   `json:"legacyKex"`
	LegacyHostKey bool   `json:"legacyHostKey"`
	LegacyCiphers bool   `json:"legacyCiphers"`
	HostKeyCheck  string `json:"hostKeyCheck"`
}

func badTarget(why string) error { return fmt.Errorf("%w : %s", errTarget, why) }

func parseTarget(raw json.RawMessage) (*target, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, badTarget("cible absente")
	}
	var t target
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, badTarget("format incorrect")
	}
	switch t.Kind {
	case "telnet", "ssh", "raw":
	default:
		return nil, badTarget("type de connexion inconnu")
	}
	if !targetHost.MatchString(t.Host) {
		return nil, badTarget("adresse d'hôte incorrecte")
	}
	if t.Port == 0 && t.Kind != "raw" {
		t.Port = map[string]int{"telnet": 23, "ssh": 22}[t.Kind]
	}
	if t.Port < 1 || t.Port > 65535 {
		return nil, badTarget("port hors de 1 à 65535")
	}
	if !targetUser.MatchString(t.User) {
		return nil, badTarget("nom d'utilisateur incorrect")
	}
	switch t.HostKeyCheck {
	case "":
		t.HostKeyCheck = "tofu"
	case "tofu", "off":
	default:
		return nil, badTarget("vérification de clé d'hôte inconnue")
	}
	return &t, nil
}

func (t target) addr() string { return net.JoinHostPort(t.Host, strconv.Itoa(t.Port)) }

// remote runs a connection in its own goroutine. Its output goes through a pipe read by the
// session pump; keystrokes are queued for the connection or for an interactive prompt.
type remote struct {
	t      target
	out    *io.PipeReader
	outW   *io.PipeWriter
	in     *inputQueue
	ctx    context.Context
	cancel context.CancelFunc
	ended  chan struct{}
	code   int

	mu       sync.Mutex
	cols     uint16
	rows     uint16
	onResize func(cols, rows uint16)
}

func startRemote(t target, cols, rows uint16) *remote {
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	r := &remote{
		t: t, out: pr, outW: pw, in: newInputQueue(), ctx: ctx, cancel: cancel,
		ended: make(chan struct{}), cols: cols, rows: rows,
	}
	go func() {
		hostname, _ := os.Hostname()
		r.printf("\x1b[90mConnexion à %s (%s) depuis %s…\x1b[0m\r\n", t.addr(), t.Kind, hostname)
		var code int
		switch t.Kind {
		case "telnet":
			code = r.runTelnet()
		case "ssh":
			code = r.runSSH()
		default:
			code = r.runRaw()
		}
		if ctx.Err() != nil {
			code = 128 + int(syscall.SIGHUP) // what a killed local shell reports
		}
		r.code = code
		cancel()
		r.in.close()
		pw.Close()
		close(r.ended)
	}()
	return r
}

func (r *remote) Read(p []byte) (int, error) { return r.out.Read(p) }

func (r *remote) Write(p []byte) (int, error) {
	if err := r.in.push(p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func (r *remote) kill()     { r.cancel(); r.in.close() }
func (r *remote) wait() int { <-r.ended; return r.code }
func (r *remote) close()    { r.out.Close() }
func (r *remote) pid() int  { return 0 }

func (r *remote) describe() string {
	if r.t.User != "" {
		return r.t.Kind + " " + r.t.User + "@" + r.t.addr()
	}
	return r.t.Kind + " " + r.t.addr()
}

func (r *remote) resize(cols, rows uint16) {
	r.mu.Lock()
	r.cols, r.rows = cols, rows
	fn := r.onResize
	r.mu.Unlock()
	if fn != nil {
		fn(cols, rows)
	}
}

func (r *remote) size() (cols, rows uint16) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cols, r.rows
}

// setResize installs the handler for later resizes once the connection can carry them.
func (r *remote) setResize(fn func(cols, rows uint16)) {
	r.mu.Lock()
	r.onResize = fn
	r.mu.Unlock()
}

func (r *remote) printf(format string, args ...any) {
	fmt.Fprintf(r.outW, format, args...)
}

// dial opens the TCP connection, closed as soon as the session is killed.
func (r *remote) dial() (net.Conn, bool) {
	d := net.Dialer{Timeout: dialTimeout}
	conn, err := d.DialContext(r.ctx, "tcp", r.t.addr())
	if err != nil {
		if r.ctx.Err() == nil {
			var op *net.OpError
			if errors.As(err, &op) {
				err = op.Err
			}
			r.printf("Impossible de joindre %s : %v\r\n", r.t.addr(), err)
		}
		return nil, false
	}
	context.AfterFunc(r.ctx, func() { conn.Close() })
	return conn, true
}

// closedBy reports the end of the connection, unless the session itself was closed.
func (r *remote) closedBy() {
	if r.ctx.Err() == nil {
		r.printf("\r\nConnexion fermée par %s.\r\n", r.t.Host)
	}
}

// pumpInput forwards keystrokes to w until the session ends.
func (r *remote) pumpInput(w io.Writer) {
	buf := make([]byte, readChunk)
	for {
		n, err := r.in.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (r *remote) runRaw() int {
	conn, ok := r.dial()
	if !ok {
		return 1
	}
	defer conn.Close()
	go r.pumpInput(conn)
	_, _ = io.Copy(r.outW, conn)
	r.closedBy()
	return 0
}

// readLine reads one line typed in the terminal, for login prompts. Without echo nothing is
// shown (passwords). Ctrl+C aborts with errAborted.
func (r *remote) readLine(echo bool) (string, error) {
	var line []byte
	b := make([]byte, 1)
	esc := 0 // 1 after ESC, 2 inside a CSI/SS3 sequence (arrow keys…), which is skipped
	for {
		if _, err := r.in.Read(b); err != nil {
			return "", err
		}
		c := b[0]
		switch {
		case esc == 1:
			esc = 0
			if c == '[' || c == 'O' {
				esc = 2
			}
		case esc == 2:
			if c >= 0x40 && c <= 0x7e {
				esc = 0
			}
		case c == '\r' || c == '\n':
			if c == '\r' {
				r.in.dropNext('\n')
			}
			r.printf("\r\n")
			return string(line), nil
		case c == 0x03:
			r.printf("^C\r\n")
			return "", errAborted
		case c == 0x7f || c == 0x08:
			if len(line) > 0 {
				_, n := utf8.DecodeLastRune(line)
				line = line[:len(line)-n]
				if echo {
					r.printf("\b \b")
				}
			}
		case c == 0x1b:
			esc = 1
		case c < 0x20:
		default:
			if len(line) < maxLineLen {
				line = append(line, c)
				if echo {
					_, _ = r.outW.Write(b)
				}
			}
		}
	}
}

// inputQueue buffers keystrokes so that a slow remote never blocks the agent's connection.
type inputQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buf    []byte
	closed bool
}

func newInputQueue() *inputQueue {
	q := &inputQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *inputQueue) push(p []byte) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return os.ErrClosed
	}
	if len(q.buf)+len(p) > maxInputQueue {
		debugf("remote input queue full, dropping %d bytes", len(p))
		return nil
	}
	q.buf = append(q.buf, p...)
	q.cond.Signal()
	return nil
}

func (q *inputQueue) Read(p []byte) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.buf) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.buf) == 0 {
		return 0, io.EOF
	}
	n := copy(p, q.buf)
	q.buf = q.buf[n:]
	return n, nil
}

// dropNext discards c if it is the next byte already queued (the LF of a pasted CR LF).
func (q *inputQueue) dropNext(c byte) {
	q.mu.Lock()
	if len(q.buf) > 0 && q.buf[0] == c {
		q.buf = q.buf[1:]
	}
	q.mu.Unlock()
}

func (q *inputQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}
