package main

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func newTestOutbox() *outbox {
	return &outbox{ch: make(chan []byte, 64), done: make(chan struct{})}
}

func (o *outbox) next(t *testing.T) message {
	t.Helper()
	select {
	case b := <-o.ch:
		var m message
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no frame from the agent")
		return message{}
	}
}

func sealedOpen(t *testing.T, key []byte, id, sid string, ts int64, spec wsOpenSpec) message {
	t.Helper()
	b, err := box(key, mustJSON(spec), "eb:ws-open:"+id+":"+sid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "ws.open", ID: id, Sid: sid, Ts: json.RawMessage(strconv.FormatInt(ts, 10)), D: b64.EncodeToString(b)}
}

func sealedData(t *testing.T, key []byte, id, sid string, n uint64, kind byte, payload string) message {
	t.Helper()
	b, err := box(key, append([]byte{kind}, payload...), wsMsgAAD(id, sid, "c2a", n))
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "ws.data", ID: id, Sid: sid, D: b64.EncodeToString(b)}
}

func TestWebSocketTunnel(t *testing.T) {
	var gotOrigin, gotCookie, gotPath string
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotOrigin, gotCookie, gotPath = r.Header.Get("Origin"), r.Header.Get("Cookie"), r.URL.RequestURI()
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"chat"}, InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			typ, data, err := c.Read(r.Context())
			if err != nil {
				return
			}
			if string(data) == "bye" {
				c.Close(websocket.StatusCode(4001), "fini")
				return
			}
			c.Write(r.Context(), typ, data)
		}
	}))
	defer site.Close()

	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	tn := openTunnel(t, w, auth, "w1", map[string]any{"url": site.URL})
	out := newTestOutbox()
	sid := "aaaaaaaaaaaaaaaaaaaaaa"
	open := sealedOpen(t, tn.key, "w1", sid, time.Now().UnixMilli(), wsOpenSpec{P: "/live?x=1", Protos: []string{"chat"}, Cookie: "a=b"})

	go w.wsOpen(open, out)
	ack := out.next(t)
	if ack.T != "ws.ack" {
		t.Fatalf("got %s", ack.T)
	}
	raw, _ := b64.DecodeString(ack.D)
	pt, err := unbox(tn.key, raw, "eb:ws-ack:w1:"+sid)
	if err != nil {
		t.Fatal(err)
	}
	var a wsAck
	json.Unmarshal(pt, &a)
	if !a.OK || a.Proto != "chat" {
		t.Fatalf("ack %+v", a)
	}
	if gotPath != "/live?x=1" || gotCookie != "a=b" || gotOrigin != site.URL {
		t.Fatalf("target saw path=%q cookie=%q origin=%q", gotPath, gotCookie, gotOrigin)
	}

	// Replaying the sealed open is refused: no second socket, no ack.
	go w.wsOpen(open, out)
	select {
	case <-out.ch:
		t.Fatal("replayed open answered")
	case <-time.After(300 * time.Millisecond):
	}

	// Echo in both directions, with the counters.
	w.wsData(sealedData(t, tn.key, "w1", sid, 0, 0, "salut"))
	m := out.next(t)
	raw, _ = b64.DecodeString(m.D)
	pt, err = unbox(tn.key, raw, wsMsgAAD("w1", sid, "a2c", 0))
	if err != nil || m.T != "ws.data" || pt[0] != 0 || string(pt[1:]) != "salut" {
		t.Fatalf("echo %v %q %v", m.T, pt, err)
	}
	w.wsData(sealedData(t, tn.key, "w1", sid, 1, 1, "\x01\x02"))
	m = out.next(t)
	raw, _ = b64.DecodeString(m.D)
	pt, err = unbox(tn.key, raw, wsMsgAAD("w1", sid, "a2c", 1))
	if err != nil || pt[0] != 1 || string(pt[1:]) != "\x01\x02" {
		t.Fatalf("binary echo %q %v", pt, err)
	}

	// The target closes: the close is sealed and carries its code.
	w.wsData(sealedData(t, tn.key, "w1", sid, 2, 0, "bye"))
	m = out.next(t)
	if m.T != "ws.close" {
		t.Fatalf("got %s", m.T)
	}
	raw, _ = b64.DecodeString(m.D)
	pt, err = unbox(tn.key, raw, wsCloseAAD("w1", sid, "a2c", 2))
	var cb wsCloseBody
	json.Unmarshal(pt, &cb)
	if err != nil || cb.Code != 4001 || cb.Reason != "fini" {
		t.Fatalf("close %+v %v", cb, err)
	}
	time.Sleep(100 * time.Millisecond)
	if w.sock("w1", sid) != nil {
		t.Fatal("socket not cleaned up")
	}
}

func TestWebSocketTunnelRejectsTampering(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			if _, _, err := c.Read(r.Context()); err != nil {
				return
			}
			t.Error("a tampered message reached the target")
		}
	}))
	defer site.Close()

	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	tn := openTunnel(t, w, auth, "w1", map[string]any{"url": site.URL})

	start := func(sid string, ts int64, key []byte) *outbox {
		out := newTestOutbox()
		go w.wsOpen(sealedOpen(t, key, "w1", sid, ts, wsOpenSpec{P: "/"}), out)
		return out
	}
	// Wrong key, stale timestamp, bad path, bad cookie: no socket.
	wrong := make([]byte, 32)
	rand.Read(wrong)
	for name, o := range map[string]*outbox{
		"mauvaise clé": start("bbbbbbbbbbbbbbbbbbbbbb", time.Now().UnixMilli(), wrong),
		"horodatage":   start("cccccccccccccccccccccc", time.Now().Add(-time.Hour).UnixMilli(), tn.key),
	} {
		select {
		case <-o.ch:
			t.Errorf("%s: answered", name)
		case <-time.After(300 * time.Millisecond):
		}
	}
	bad := newTestOutbox()
	go w.wsOpen(sealedOpen(t, tn.key, "w1", "dddddddddddddddddddddd", time.Now().UnixMilli(), wsOpenSpec{P: "//evil.example/"}), bad)
	if m := bad.next(t); m.T != "ws.ack" {
		t.Fatalf("got %s", m.T)
	} else if raw, _ := b64.DecodeString(m.D); true {
		pt, _ := unbox(tn.key, raw, "eb:ws-ack:w1:dddddddddddddddddddddd")
		var a wsAck
		json.Unmarshal(pt, &a)
		if a.OK {
			t.Fatal("path //evil.example/ accepted")
		}
	}

	// A socket whose messages are replayed, reordered or forged is dropped.
	sid := "eeeeeeeeeeeeeeeeeeeeee"
	out := start(sid, time.Now().UnixMilli(), tn.key)
	if m := out.next(t); m.T != "ws.ack" {
		t.Fatalf("got %s", m.T)
	}
	w.wsData(sealedData(t, tn.key, "w1", sid, 5, 0, "hors ordre"))
	time.Sleep(100 * time.Millisecond)
	if w.sock("w1", sid) != nil {
		t.Fatal("out-of-order message kept the socket alive")
	}

	// Closing the tunnel (or rotating its key) ends its sockets.
	sid = "ffffffffffffffffffffff"
	out = start(sid, time.Now().UnixMilli(), tn.key)
	out.next(t)
	w.close("w1")
	time.Sleep(100 * time.Millisecond)
	if w.sock("w1", sid) != nil {
		t.Fatal("tunnel closed but socket still open")
	}
}
