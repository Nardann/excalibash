package main

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeServer accepts agent connections and hands them to the test.
func fakeServer(t *testing.T) (string, chan *websocket.Conn) {
	t.Helper()
	conns := make(chan *websocket.Conn, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent" || r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		conns <- c
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv.URL, conns
}

func recv(t *testing.T, c *websocket.Conn) message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m message
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return m
}

func send(t *testing.T, c *websocket.Conn, m message) {
	t.Helper()
	b, _ := json.Marshal(m)
	if err := c.Write(context.Background(), websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// harness plays the server side: it knows the machine key and the terminal keys.
type harness struct {
	priv *ecdh.PrivateKey
	keys map[string][]byte
	prev map[string][][]byte // keys replaced by a rekey, for output still in flight
	// last output seq seen per terminal and gen, to check strict ordering
	last map[string]uint64
	gen  map[string]string // current gen per terminal, learned from output
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &harness{priv: priv, keys: map[string][]byte{}, prev: map[string][][]byte{}, last: map[string]uint64{}, gen: map[string]string{}}
}

// sealedKey creates a fresh terminal key for id, issued under the owner's machine auth key.
func (h *harness) sealedKey(t *testing.T, id string) string {
	t.Helper()
	key := make([]byte, 32)
	rand.Read(key)
	h.keys[id] = key
	sealed, err := box(machineAuthKey(h.priv), key, "eb:term:"+id)
	if err != nil {
		t.Fatal(err)
	}
	return b64.EncodeToString(sealed)
}

func (h *harness) input(t *testing.T, id, sender string, k uint64, ts int64, text string) message {
	t.Helper()
	aad := fmt.Sprintf("eb:term-in:%s:%s:%s:%d:%d", id, h.gen[id], sender, k, ts)
	d, err := box(h.keys[id], []byte(text), aad)
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "input", ID: id, S: sender, K: k, Ts: json.RawMessage(strconv.FormatInt(ts, 10)), D: b64.EncodeToString(d)}
}

// decrypt verifies and opens an output frame.
func (h *harness) decrypt(t *testing.T, m message) string {
	t.Helper()
	slot := m.ID + "/" + m.Gen
	if m.Seq <= h.last[slot] {
		t.Fatalf("output seq %d not increasing (last %d)", m.Seq, h.last[slot])
	}
	h.last[slot] = m.Seq
	h.gen[m.ID] = m.Gen
	data, err := b64.DecodeString(m.D)
	if err != nil {
		t.Fatal(err)
	}
	aad := fmt.Sprintf("eb:term-out:%s:%s:%d", m.ID, m.Gen, m.Seq)
	pt, err := unbox(h.keys[m.ID], data, aad)
	for _, k := range h.prev[m.ID] {
		if err == nil {
			break
		}
		pt, err = unbox(k, data, aad)
	}
	if err != nil {
		t.Fatalf("cannot decrypt output: %v", err)
	}
	return string(pt)
}

// waitOutput reads frames until the decrypted output of id contains want.
func (h *harness) waitOutput(t *testing.T, c *websocket.Conn, id, want string) string {
	t.Helper()
	var got strings.Builder
	for !strings.Contains(got.String(), want) {
		m := recv(t, c)
		if m.T == "output" && m.ID == id {
			got.WriteString(h.decrypt(t, m))
		}
	}
	return got.String()
}

// waitGen reads frames until the agent announced the current gen of id (sent on open and rekey).
func (h *harness) waitGen(t *testing.T, c *websocket.Conn, id string) {
	t.Helper()
	for {
		m := recv(t, c)
		if m.T == "output" && m.ID == id {
			h.decrypt(t, m)
			return
		}
	}
}

func startAgent(t *testing.T, base string, h *harness) {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	endpoint, err := agentEndpoint(base)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	mgr := newManager(h.priv)
	done := make(chan struct{})
	go func() {
		run(ctx, config{endpoint: endpoint, token: "secret", name: "test"}, mgr)
		mgr.closeAll()
		close(done)
	}()
	t.Cleanup(func() { cancel(); <-done })
}

func now() int64 { return time.Now().UnixMilli() }

func TestOpenInputClose(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns

	hello := recv(t, c)
	if hello.T != "hello" || hello.Name != "test" || hello.OS == "" {
		t.Fatalf("unexpected hello: %+v", hello)
	}

	send(t, c, message{T: "open", ID: "t1", Cols: 100, Rows: 30, Key: h.sealedKey(t, "t1")})
	if m := recv(t, c); m.T != "opened" || m.ID != "t1" || m.Pid == 0 {
		t.Fatalf("expected opened, got %+v", m)
	}
	h.waitGen(t, c, "t1")

	send(t, c, message{T: "ping", Ts: json.RawMessage("123")})
	if m := recv(t, c); m.T != "pong" || string(m.Ts) != "123" {
		t.Fatalf("expected pong 123, got %+v", m)
	}

	first := h.input(t, "t1", "tabA", 1, now(), "echo h''i\n")
	send(t, c, first)
	h.waitOutput(t, c, "t1", "hi")

	// Replaying the same frame, a lower counter, a stale or a forged frame does nothing.
	send(t, c, first)
	send(t, c, h.input(t, "t1", "tabA", 1, now(), "echo rep''lay\n"))
	send(t, c, h.input(t, "t1", "tabB", 1, now()-6*60*1000, "echo st''ale\n"))
	forged := h.input(t, "t1", "tabC", 1, now(), "echo for''ged\n")
	forged.K = 2 // counter no longer matches the AAD
	send(t, c, forged)

	// Another sender has its own counter; inputs are handled in order, so any
	// output of the rejected frames would show up before "bob".
	send(t, c, h.input(t, "t1", "tabB", 1, now(), "echo b''ob\n"))
	out := h.waitOutput(t, c, "t1", "bob")
	for _, bad := range []string{"replay", "stale", "forged"} {
		if strings.Contains(out, bad) {
			t.Fatalf("rejected input %q reached the shell", bad)
		}
	}

	send(t, c, message{T: "close", ID: "t1"})
	for {
		m := recv(t, c)
		if m.T == "exit" && m.ID == "t1" {
			if m.Code == nil {
				t.Fatal("exit without code")
			}
			break
		}
	}
}

func TestInvalidKey(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello

	other := newHarness(t)
	send(t, c, message{T: "open", ID: "t3", Key: other.sealedKey(t, "t3")})
	m := recv(t, c)
	if m.T != "exit" || m.ID != "t3" || m.Code == nil || *m.Code != -1 || m.Error == "" {
		t.Fatalf("expected exit -1, got %+v", m)
	}
	// A key sealed for another terminal id is refused too.
	send(t, c, message{T: "open", ID: "t4", Key: h.sealedKey(t, "t5")})
	if m := recv(t, c); m.T != "exit" || m.ID != "t4" {
		t.Fatalf("expected exit for mismatched id, got %+v", m)
	}
}

func TestRekey(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello

	send(t, c, message{T: "open", ID: "t6", Key: h.sealedKey(t, "t6")})
	recv(t, c) // opened
	h.waitGen(t, c, "t6")
	send(t, c, h.input(t, "t6", "tab", 1, now(), "echo be''fore\n"))
	h.waitOutput(t, c, "t6", "before")

	oldKey := h.keys["t6"]
	h.prev["t6"] = [][]byte{oldKey}
	oldGen := h.gen["t6"]
	send(t, c, message{T: "rekey", ID: "t6", Key: h.sealedKey(t, "t6")})
	// Output of the old gen may still be in flight: wait for the announce of the new one.
	deadline := time.Now().Add(5 * time.Second)
	for h.gen["t6"] == oldGen {
		if time.Now().After(deadline) {
			t.Fatal("rekey did not start a new gen")
		}
		h.waitGen(t, c, "t6")
	}
	// Input under the old key is now refused.
	stale := h.keys["t6"]
	h.keys["t6"] = oldKey
	old := h.input(t, "t6", "tab", 2, now(), "echo ol''dkey\n")
	h.keys["t6"] = stale
	send(t, c, old)
	send(t, c, h.input(t, "t6", "tab", 1, now(), "echo af''ter\n"))
	out := h.waitOutput(t, c, "t6", "after")
	if strings.Contains(out, "oldkey") {
		t.Fatal("input under the old key was accepted after rekey")
	}
	send(t, c, message{T: "close", ID: "t6"})
}

func TestReconnectKeepsSession(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello

	send(t, c, message{T: "open", ID: "t2", Key: h.sealedKey(t, "t2")})
	recv(t, c) // opened
	h.waitGen(t, c, "t2")
	send(t, c, h.input(t, "t2", "tab", 1, now(), "sleep 0.5; echo la''ter\n"))
	c.Close(websocket.StatusGoingAway, "bye")

	c2 := <-conns
	hello := recv(t, c2)
	if hello.T != "hello" || !slices.Contains(hello.Sessions, "t2") {
		t.Fatalf("expected t2 in hello sessions, got %+v", hello)
	}
	h.waitOutput(t, c2, "t2", "later")
	send(t, c2, message{T: "close", ID: "t2"})
}

func TestAgentEndpoint(t *testing.T) {
	cases := map[string]string{
		"https://x.example.com":     "wss://x.example.com/agent",
		"http://localhost:3000/":    "ws://localhost:3000/agent",
		"wss://x.example.com/sub/":  "wss://x.example.com/sub/agent",
		"x.example.com":             "wss://x.example.com/agent",
		"ws://localhost:3000/agent": "ws://localhost:3000/agent",
	}
	for in, want := range cases {
		got, err := agentEndpoint(in)
		if err != nil || got != want {
			t.Errorf("agentEndpoint(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
}

// A key sealed to the machine's public key (what a server knowing that key could forge)
// is refused: only the owner, who holds the machine auth key, can issue terminal keys.
func TestSealedKeyRefused(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello
	key := make([]byte, 32)
	rand.Read(key)
	sealed, err := seal(h.priv.PublicKey(), key, "eb:term:t9")
	if err != nil {
		t.Fatal(err)
	}
	send(t, c, message{T: "open", ID: "t9", Key: b64.EncodeToString(sealed)})
	if m := recv(t, c); m.T != "exit" || m.ID != "t9" {
		t.Fatalf("expected refusal, got %+v", m)
	}
}

// Input captured in one gen cannot be replayed after a restart of the same terminal.
func TestInputBoundToGen(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello
	key := h.sealedKey(t, "t8")
	send(t, c, message{T: "open", ID: "t8", Key: key})
	recv(t, c) // opened
	h.waitGen(t, c, "t8")
	captured := h.input(t, "t8", "tab", 1, now(), "echo fi''rst\n")
	send(t, c, captured)
	h.waitOutput(t, c, "t8", "first")
	send(t, c, message{T: "close", ID: "t8"})
	for m := recv(t, c); m.T != "exit"; m = recv(t, c) {
	}
	// Same terminal id and key, new shell (what a restart does).
	send(t, c, message{T: "open", ID: "t8", Key: key})
	recv(t, c) // opened
	h.waitGen(t, c, "t8")
	send(t, c, captured)
	send(t, c, h.input(t, "t8", "tab2", 1, now(), "echo se''cond\n"))
	if out := h.waitOutput(t, c, "t8", "second"); strings.Contains(out, "first") {
		t.Fatal("input from a previous gen was replayed into the new shell")
	}
	send(t, c, message{T: "close", ID: "t8"})
}
