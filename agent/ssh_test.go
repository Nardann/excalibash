package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// fakeSSH is an in-process server: user admin, password "secret". The shell prints a banner,
// echoes input and exits with status 3 on "q".
type fakeSSH struct {
	port    int
	key     ssh.Signer
	mu      sync.Mutex
	pty     string
	windows []string
}

func (f *fakeSSH) record(s string, pty bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if pty {
		f.pty = s
	} else {
		f.windows = append(f.windows, s)
	}
}

func (f *fakeSSH) state() (string, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.pty, append([]string(nil), f.windows...)
}

func newSignerT(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newFakeSSH(t *testing.T, key ssh.Signer, algos *ssh.Config) *fakeSSH {
	t.Helper()
	ln, port := listen(t)
	f := &fakeSSH{port: port, key: key}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if c.User() == "admin" && string(pw) == "secret" {
				return nil, nil
			}
			return nil, ssh.ErrNoAuth
		},
	}
	if algos != nil {
		cfg.Config = *algos
	}
	cfg.AddHostKey(key)
	go func() {
		for {
			nc, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(nc, cfg)
		}
	}()
	return f
}

func (f *fakeSSH) serve(nc net.Conn, cfg *ssh.ServerConfig) {
	defer nc.Close()
	conn, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer conn.Close()
	go ssh.DiscardRequests(reqs)
	for nch := range chans {
		ch, creqs, err := nch.Accept()
		if err != nil {
			return
		}
		go func() {
			for req := range creqs {
				switch req.Type {
				case "pty-req":
					var p struct {
						Term          string
						Cols, Rows    uint32
						Width, Height uint32
						Modes         string
					}
					ssh.Unmarshal(req.Payload, &p)
					f.record(p.Term+" "+itoa(p.Cols)+"x"+itoa(p.Rows), true)
					req.Reply(true, nil)
				case "window-change":
					f.record(itoa(binary.BigEndian.Uint32(req.Payload))+"x"+itoa(binary.BigEndian.Uint32(req.Payload[4:])), false)
				case "shell":
					req.Reply(true, nil)
					go func() {
						ch.Write([]byte("welcome\r\n"))
						buf := make([]byte, 256)
						for {
							n, err := ch.Read(buf)
							if err != nil {
								return
							}
							if strings.Contains(string(buf[:n]), "q") {
								ch.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{3}))
								ch.Close()
								return
							}
							ch.Write(buf[:n])
						}
					}()
				default:
					req.Reply(false, nil)
				}
			}
		}()
	}
}

func itoa(v uint32) string { return strconv.FormatUint(uint64(v), 10) }

// isolate keeps known_hosts and ~/.ssh inside the test's own directory.
func isolate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config"))
	return filepath.Join(dir, "config", "excalibash", "known_hosts")
}

func TestSSHPasswordAndTOFU(t *testing.T) {
	known := isolate(t)
	f := newFakeSSH(t, newSignerT(t), nil)
	tm := startTerm(t, target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, HostKeyCheck: "tofu"})

	tm.waitFor(t, "login as: ")
	tm.send("admin\r")
	tm.waitFor(t, "admin@127.0.0.1's password: ")
	tm.send("wrong\r")
	tm.waitFor(t, "Accès refusé.")
	tm.send("secret\r")
	tm.waitFor(t, "welcome")
	if out := tm.output(); strings.Contains(out, "wrong") || strings.Contains(out, "secret") {
		t.Fatalf("password echoed: %q", out)
	}
	if !strings.Contains(tm.output(), "Première connexion") || !strings.Contains(tm.output(), ssh.FingerprintSHA256(f.key.PublicKey())) {
		t.Fatalf("first connection must show the fingerprint: %q", tm.output())
	}
	st, err := os.Stat(known)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("known_hosts: %v %v", st, err)
	}
	b, _ := os.ReadFile(known)
	if want := knownhosts.Line([]string{knownhosts.Normalize(tm.r.t.addr())}, f.key.PublicKey()); strings.TrimSpace(string(b)) != want {
		t.Fatalf("known_hosts = %q, want %q", b, want)
	}

	tm.send("hello")
	tm.waitFor(t, "hello")
	tm.r.resize(120, 40)
	waitUntil(t, func() bool { _, w := f.state(); return len(w) == 1 && w[0] == "120x40" }, "window-change %s, got %s", "120x40", func() string { _, w := f.state(); return strings.Join(w, ",") })
	if pty, _ := f.state(); pty != "xterm-256color 80x24" {
		t.Fatalf("pty request %q", pty)
	}
	tm.send("q")
	if code := tm.exit(t); code != 3 {
		t.Fatalf("exit code %d, want the remote status 3", code)
	}
	tm.waitFor(t, "Connexion fermée par 127.0.0.1.")

	// Second connection: the pinned key is accepted silently.
	tm2 := startTerm(t, target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, User: "admin", HostKeyCheck: "tofu"})
	tm2.waitFor(t, "password: ")
	tm2.send("secret\r")
	tm2.waitFor(t, "welcome")
	if strings.Contains(tm2.output(), "Première connexion") {
		t.Fatal("known host reported as new")
	}
}

func TestSSHHostKeyChanged(t *testing.T) {
	known := isolate(t)
	f := newFakeSSH(t, newSignerT(t), nil)
	old := newSignerT(t)
	os.MkdirAll(filepath.Dir(known), 0o700)
	addr := target{Host: "127.0.0.1", Port: f.port}.addr()
	os.WriteFile(known, []byte(knownhosts.Line([]string{knownhosts.Normalize(addr)}, old.PublicKey())+"\n"), 0o600)

	tm := startTerm(t, target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, User: "admin", HostKeyCheck: "tofu"})
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	out := tm.output()
	for _, want := range []string{"a changé", ssh.FingerprintSHA256(old.PublicKey()), ssh.FingerprintSHA256(f.key.PublicKey()), known} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %q", want, out)
		}
	}
	if strings.Contains(out, "password") {
		t.Fatal("authentication attempted with a changed host key")
	}

	// "off" connects anyway, with a warning.
	tm2 := startTerm(t, target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, User: "admin", HostKeyCheck: "off"})
	tm2.waitFor(t, "n'est pas vérifiée")
	tm2.waitFor(t, "password: ")
}

func TestSSHLegacyAlgorithms(t *testing.T) {
	isolate(t)
	f := newFakeSSH(t, newSignerT(t), &ssh.Config{
		KeyExchanges: []string{ssh.InsecureKeyExchangeDH1SHA1},
		Ciphers:      []string{ssh.InsecureCipherAES128CBC},
	})
	tg := target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, User: "admin", HostKeyCheck: "tofu"}
	tm := startTerm(t, tg)
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if !strings.Contains(tm.output(), "Essayer l'option “Équipement ancien”") {
		t.Fatalf("missing legacy hint: %q", tm.output())
	}

	tg.LegacyKex, tg.LegacyCiphers = true, true
	tm2 := startTerm(t, tg)
	tm2.waitFor(t, "password: ")
	tm2.send("secret\r")
	tm2.waitFor(t, "welcome")
}

func TestSSHAbortAtPrompt(t *testing.T) {
	isolate(t)
	f := newFakeSSH(t, newSignerT(t), nil)
	tm := startTerm(t, target{Kind: "ssh", Host: "127.0.0.1", Port: f.port, User: "admin", HostKeyCheck: "tofu"})
	tm.waitFor(t, "password: ")
	tm.send("sec\x03")
	if code := tm.exit(t); code != 1 {
		t.Fatalf("exit code %d, want 1", code)
	}
	if out := tm.output(); strings.Count(out, "password: ") != 1 || strings.Contains(out, "Authentification") {
		t.Fatalf("Ctrl+C must stop authentication: %q", out)
	}
}
