package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// term drives a remote source directly, as the session pump would.
type term struct {
	r    *remote
	mu   sync.Mutex
	out  bytes.Buffer
	done chan struct{}
}

func startTerm(t *testing.T, tg target) *term {
	t.Helper()
	tm := &term{r: startRemote(tg, 80, 24), done: make(chan struct{})}
	go func() {
		defer close(tm.done)
		buf := make([]byte, 4096)
		for {
			n, err := tm.r.Read(buf)
			tm.mu.Lock()
			tm.out.Write(buf[:n])
			tm.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	t.Cleanup(func() {
		tm.r.kill()
		tm.r.wait()
		tm.r.close()
	})
	return tm
}

func (tm *term) output() string {
	tm.mu.Lock()
	defer tm.mu.Unlock()
	return tm.out.String()
}

func (tm *term) waitFor(t *testing.T, want string) {
	t.Helper()
	waitUntil(t, func() bool { return strings.Contains(tm.output(), want) }, "output %q, got %q", want, tm.output)
}

func (tm *term) send(s string) { tm.r.Write([]byte(s)) }

func (tm *term) exit(t *testing.T) int {
	t.Helper()
	select {
	case <-tm.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("remote session did not end; output %q", tm.output())
	}
	return tm.r.wait()
}

func waitUntil(t *testing.T, cond func() bool, format string, want any, got func() string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for "+format, want, got())
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func listen(t *testing.T) (net.Listener, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln, ln.Addr().(*net.TCPAddr).Port
}

func TestParseTarget(t *testing.T) {
	ok := map[string]target{
		`{"kind":"telnet","host":"192.168.1.1"}`:                          {Kind: "telnet", Host: "192.168.1.1", Port: 23, HostKeyCheck: "tofu"},
		`{"kind":"ssh","host":"fe80::1","user":"admin@corp","x":1}`:       {Kind: "ssh", Host: "fe80::1", Port: 22, User: "admin@corp", HostKeyCheck: "tofu"},
		`{"kind":"raw","host":"ts.local","port":7001}`:                    {Kind: "raw", Host: "ts.local", Port: 7001, HostKeyCheck: "tofu"},
		`{"kind":"ssh","host":"h","port":2222,"hostKeyCheck":"off"}`:      {Kind: "ssh", Host: "h", Port: 2222, HostKeyCheck: "off"},
		`{"kind":"ssh","host":"h","legacyKex":true,"legacyCiphers":true}`: {Kind: "ssh", Host: "h", Port: 22, LegacyKex: true, LegacyCiphers: true, HostKeyCheck: "tofu"},
		`{"kind":"telnet","host":"sw","via":[{"host":"r1","user":"a"},{"kind":"ssh","host":"r2","port":2222}]}`: {
			Kind: "telnet", Host: "sw", Port: 23, HostKeyCheck: "tofu",
			Via: []target{{Kind: "ssh", Host: "r1", Port: 22, User: "a", HostKeyCheck: "tofu"}, {Kind: "ssh", Host: "r2", Port: 2222, HostKeyCheck: "tofu"}},
		},
	}
	for in, want := range ok {
		got, err := parseTarget(json.RawMessage(in))
		if err != nil || !reflect.DeepEqual(*got, want) {
			t.Errorf("parseTarget(%s) = %+v, %v; want %+v", in, got, err, want)
		}
	}
	bad := []string{
		``, `null`, `[]`, `"ssh"`,
		`{"kind":"rlogin","host":"h","port":1}`,
		`{"kind":"ssh","host":"","port":22}`,
		`{"kind":"ssh","host":"a b","port":22}`,
		`{"kind":"ssh","host":"[::1]","port":22}`,
		`{"kind":"ssh","host":"` + strings.Repeat("a", 254) + `","port":22}`,
		`{"kind":"raw","host":"h"}`,
		`{"kind":"ssh","host":"h","port":0.5}`,
		`{"kind":"ssh","host":"h","port":"22"}`,
		`{"kind":"ssh","host":"h","port":65536}`,
		`{"kind":"ssh","host":"h","port":-1}`,
		`{"kind":"ssh","host":"h","user":"root;id"}`,
		`{"kind":"ssh","host":"h","user":"` + strings.Repeat("u", 65) + `"}`,
		`{"kind":"ssh","host":"h","hostKeyCheck":"yes"}`,
		`{"kind":"ssh","host":"h","legacyKex":"true"}`,
		`{"kind":"ssh","host":"h","via":[{"kind":"telnet","host":"r1"}]}`,
		`{"kind":"ssh","host":"h","via":[{"host":"a b"}]}`,
		`{"kind":"ssh","host":"h","via":[{"host":"r1","via":[{"host":"r0"}]}]}`,
		`{"kind":"ssh","host":"h","via":"r1"}`,
		`{"kind":"ssh","host":"h","via":[` + strings.TrimSuffix(strings.Repeat(`{"host":"r"},`, 9), ",") + `]}`,
	}
	for _, in := range bad {
		if got, err := parseTarget(json.RawMessage(in)); err == nil {
			t.Errorf("parseTarget(%s) accepted: %+v", in, got)
		}
	}
}

// remoteKey issues a terminal key with a target, as the owner's browser does for a remote session.
func (h *harness) remoteKey(t *testing.T, id string, tg any) string {
	t.Helper()
	key := make([]byte, 32)
	rand.Read(key)
	h.keys[id] = key
	pt, _ := json.Marshal(map[string]any{"k": b64.EncodeToString(key), "target": tg})
	sealed, err := box(machineAuthKey(h.priv), pt, "eb:term:"+id)
	if err != nil {
		t.Fatal(err)
	}
	return b64.EncodeToString(sealed)
}

func TestRemoteInvalidTarget(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello

	for i, tg := range []any{
		map[string]any{"kind": "ssh", "host": "-oProxyCommand=x", "port": 22, "user": "a b"},
		map[string]any{"kind": "telnet", "host": "h", "port": 70000},
		nil,
	} {
		id := "bad" + string(rune('a'+i))
		send(t, c, message{T: "open", ID: id, Key: h.remoteKey(t, id, tg)})
		m := recv(t, c)
		if m.T != "exit" || m.ID != id || m.Code == nil || *m.Code != -1 || !strings.Contains(m.Error, "cible distante invalide") {
			t.Fatalf("expected exit -1 with a target error, got %+v", m)
		}
	}
	// A payload that is neither 32 bytes nor JSON is an invalid key.
	sealed, _ := box(machineAuthKey(h.priv), []byte("not a key"), "eb:term:x1")
	send(t, c, message{T: "open", ID: "x1", Key: b64.EncodeToString(sealed)})
	if m := recv(t, c); m.T != "exit" || m.Error != "clé de terminal invalide" {
		t.Fatalf("expected invalid key, got %+v", m)
	}
}

// The historical payload (the bare 32-byte key) still opens the machine's own shell.
func TestRawKeyOpensLocalShell(t *testing.T) {
	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello
	send(t, c, message{T: "open", ID: "l1", Key: h.sealedKey(t, "l1")})
	if m := recv(t, c); m.T != "opened" || m.Pid == 0 {
		t.Fatalf("expected a local process, got %+v", m)
	}
	h.waitGen(t, c, "l1")
	send(t, c, h.input(t, "l1", "tab", 1, now(), "echo local-$EXCALIBASH\n"))
	h.waitOutput(t, c, "l1", "local-1")
	send(t, c, message{T: "close", ID: "l1"})
}

// Raw TCP through the whole encrypted session: connect, echo, remote close, exit 0.
func TestRawTCPSession(t *testing.T) {
	ln, port := listen(t)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		buf := make([]byte, 64)
		n, _ := conn.Read(buf)
		conn.Write(append([]byte("echo:"), buf[:n]...))
		conn.Close()
	}()

	base, conns := fakeServer(t)
	h := newHarness(t)
	startAgent(t, base, h)
	c := <-conns
	recv(t, c) // hello
	send(t, c, message{T: "open", ID: "r1", Key: h.remoteKey(t, "r1", map[string]any{"kind": "raw", "host": "127.0.0.1", "port": port})})
	if m := recv(t, c); m.T != "opened" || m.Pid != 0 {
		t.Fatalf("expected opened without pid, got %+v", m)
	}
	h.waitGen(t, c, "r1")
	h.waitOutput(t, c, "r1", "(raw) depuis")
	send(t, c, h.input(t, "r1", "tab", 1, now(), "ping\xff\r"))
	h.waitOutput(t, c, "r1", "echo:ping\xff\r")
	h.waitOutput(t, c, "r1", "Connexion fermée par 127.0.0.1.")
	for {
		m := recv(t, c)
		if m.T == "exit" && m.ID == "r1" {
			if m.Code == nil || *m.Code != 0 {
				t.Fatalf("expected exit 0, got %+v", m)
			}
			return
		}
	}
}

func TestRemoteUnreachable(t *testing.T) {
	ln, port := listen(t)
	ln.Close()
	tm := startTerm(t, target{Kind: "raw", Host: "127.0.0.1", Port: port})
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if out := tm.output(); !strings.Contains(out, "Impossible de joindre 127.0.0.1:") {
		t.Fatalf("unexpected output %q", out)
	}
}

func TestRemoteKill(t *testing.T) {
	ln, port := listen(t)
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			defer conn.Close()
			io.Copy(io.Discard, conn)
		}
	}()
	tm := startTerm(t, target{Kind: "raw", Host: "127.0.0.1", Port: port})
	tm.waitFor(t, "depuis")
	time.Sleep(50 * time.Millisecond)
	tm.r.kill()
	if code := tm.exit(t); code != 129 {
		t.Fatalf("exit code %d, want 129", code)
	}
	if strings.Contains(tm.output(), "Connexion fermée") {
		t.Fatal("a session closed by the user must not report a remote close")
	}
}

func TestReadLine(t *testing.T) {
	pr, pw := io.Pipe()
	go io.Copy(io.Discard, pr)
	defer pw.Close()
	lr := &remote{in: newInputQueue(), outW: pw}
	lr.in.push([]byte("ab\x7fc\x08\x08xé\x7fy\x1b[Dz\r\nnext\n"))
	if line, err := lr.readLine(true); err != nil || line != "xyz" {
		t.Fatalf("readLine = %q, %v", line, err)
	}
	if line, err := lr.readLine(false); err != nil || line != "next" {
		t.Fatalf("second line = %q, %v (CR LF must count once)", line, err)
	}
	lr.in.push([]byte("abc\x03"))
	if _, err := lr.readLine(true); err != errAborted {
		t.Fatalf("Ctrl+C gave %v", err)
	}
}
