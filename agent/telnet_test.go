package main

import (
	"bytes"
	"net"
	"sync"
	"testing"
)

// fakeTelnet records what the client sends on its single connection.
type fakeTelnet struct {
	mu   sync.Mutex
	got  []byte
	conn net.Conn
	ok   chan struct{}
}

func newFakeTelnet(t *testing.T) (*fakeTelnet, int) {
	ln, port := listen(t)
	f := &fakeTelnet{ok: make(chan struct{})}
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		f.conn = conn
		close(f.ok)
		buf := make([]byte, 1024)
		for {
			n, err := conn.Read(buf)
			f.mu.Lock()
			f.got = append(f.got, buf[:n]...)
			f.mu.Unlock()
			if err != nil {
				return
			}
		}
	}()
	return f, port
}

func (f *fakeTelnet) received() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.got)
}

func (f *fakeTelnet) waitFor(t *testing.T, seq ...byte) {
	t.Helper()
	waitUntil(t, func() bool { return bytes.Contains([]byte(f.received()), seq) }, "client to send %q, got %q", seq, f.received)
}

func TestTelnetNegotiation(t *testing.T) {
	f, port := newFakeTelnet(t)
	tm := startTerm(t, target{Kind: "telnet", Host: "127.0.0.1", Port: port})
	<-f.ok

	// The client offers NAWS on its own.
	f.waitFor(t, tnIAC, tnWILL, optNAWS)
	f.conn.Write([]byte{
		tnIAC, tnWILL, optEcho, tnIAC, tnWILL, optSGA, // accepted
		tnIAC, tnDO, optNAWS, tnIAC, tnDO, optTType, // accepted
		tnIAC, tnWILL, 0, tnIAC, tnDO, 39, // BINARY, NEW-ENVIRON: refused
		tnIAC, tnSB, optTType, ttypeSend, tnIAC, tnSE,
	})
	f.waitFor(t, tnIAC, tnDO, optEcho)
	f.waitFor(t, tnIAC, tnDO, optSGA)
	f.waitFor(t, tnIAC, tnSB, optNAWS, 0, 80, 0, 24, tnIAC, tnSE)
	f.waitFor(t, tnIAC, tnWILL, optTType)
	f.waitFor(t, tnIAC, tnDONT, 0)
	f.waitFor(t, tnIAC, tnWONT, 39)
	f.waitFor(t, append(append([]byte{tnIAC, tnSB, optTType, ttypeIS}, "XTERM-256COLOR"...), tnIAC, tnSE)...)
	if bytes.Count([]byte(f.received()), []byte{tnIAC, tnWILL, optNAWS}) != 1 {
		t.Fatalf("NAWS offered more than once: %q", f.received())
	}

	// NAWS follows resizes; a 255 in the size is escaped.
	tm.r.resize(300, 255)
	f.waitFor(t, tnIAC, tnSB, optNAWS, 1, 44, 0, 255, 255, tnIAC, tnSE)

	// Input: 0xFF doubled, a bare CR sent as CR LF, CR LF kept.
	tm.send("a\xffb\r")
	f.waitFor(t, 'a', 0xff, 0xff, 'b', '\r', '\n')
	tm.send("c\r\nd")
	f.waitFor(t, 'c', '\r', '\n', 'd')

	// Output: commands stripped, CR NUL is a CR, IAC IAC is 0xFF, split commands handled.
	f.conn.Write([]byte("hi\r\x00there\r\n\xff\xff!" + "\xff"))
	f.conn.Write([]byte{tnNOP(), 'o', 'k'})
	tm.waitFor(t, "hi\rthere\r\n\xff!ok")

	f.conn.Close()
	if code := tm.exit(t); code != 0 {
		t.Fatalf("exit code %d, want 0", code)
	}
	tm.waitFor(t, "Connexion fermée par 127.0.0.1.")
}

func tnNOP() byte { return 241 }
