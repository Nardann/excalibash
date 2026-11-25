package main

import (
	"crypto/rand"
	"encoding/json"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

// probeRequest builds a request the way the owner's browser issues it.
func probeRequest(t *testing.T, auth []byte, rid string, ts int64, targets []string) message {
	t.Helper()
	pt, _ := json.Marshal(map[string]any{"targets": targets})
	boxed, err := box(auth, pt, "eb:probe:"+rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "probe", Rid: rid, Ts: json.RawMessage(strconv.FormatInt(ts, 10)), D: b64.EncodeToString(boxed)}
}

// capture returns an outbox and a function reading the next frame sent to it (or nil).
func capture() (*outbox, func() *message) {
	out := &outbox{ch: make(chan []byte, 8), done: make(chan struct{})}
	return out, func() *message {
		select {
		case b := <-out.ch:
			var m message
			json.Unmarshal(b, &m)
			return &m
		case <-time.After(5 * time.Second):
			return nil
		}
	}
}

func TestProbeAnswersOwnerRequest(t *testing.T) {
	auth := make([]byte, 32)
	rand.Read(auth)
	p := newProbeHub(auth)
	out, next := capture()
	go p.handle(probeRequest(t, auth, "r1", time.Now().UnixMilli(), []string{"127.0.0.1"}), out)
	m := next()
	if m == nil || m.T != "probe.res" || m.Rid != "r1" {
		t.Fatalf("no answer: %+v", m)
	}
	data, _ := b64.DecodeString(m.D)
	pt, err := unbox(auth, data, "eb:probe-res:r1")
	if err != nil {
		t.Fatal("answer not boxed under the machine auth key")
	}
	var res struct {
		R map[string]probeResult `json:"r"`
	}
	if json.Unmarshal(pt, &res) != nil {
		t.Fatal("bad answer")
	}
	if _, ok := res.R["127.0.0.1"]; !ok {
		t.Fatalf("127.0.0.1 missing from %v", res.R)
	}
}

func TestProbeRefusesForgedOldAndReplayed(t *testing.T) {
	auth := make([]byte, 32)
	rand.Read(auth)
	other := make([]byte, 32)
	rand.Read(other)
	p := newProbeHub(auth)
	now := time.Now().UnixMilli()

	out, next := capture()
	// Not boxed by the owner (the server or anyone without the auth key).
	go p.handle(probeRequest(t, other, "forged", now, []string{"127.0.0.1"}), out)
	if m := next(); m != nil {
		t.Fatalf("forged request answered: %+v", m)
	}
	// Outside the time window.
	go p.handle(probeRequest(t, auth, "old", now-int64(inputMaxSkew/time.Millisecond)-60_000, []string{"127.0.0.1"}), out)
	if m := next(); m != nil {
		t.Fatalf("stale request answered: %+v", m)
	}
	// The same request twice.
	req := probeRequest(t, auth, "once", now, []string{"127.0.0.1"})
	go p.handle(req, out)
	if m := next(); m == nil {
		t.Fatal("first request not answered")
	}
	go p.handle(req, out)
	if m := next(); m != nil {
		t.Fatalf("replayed request answered: %+v", m)
	}
}

func TestProbeOnlyPingsPlainAddresses(t *testing.T) {
	var pinged []string
	fake := func(a netip.Addr) probeResult {
		pinged = append(pinged, a.String())
		return probeResult{Up: true, Ms: 1}
	}
	targets := []string{"10.0.0.1", "10.0.0.1", "fe80::1", "-c 100 10.0.0.2", "example.com", "0.0.0.0", "224.0.0.1", "fe80::1%eth0", "10.0.0.3; rm -rf /"}
	r := probeAll(targets, fake)
	if len(r) != 2 || !r["10.0.0.1"].Up || !r["fe80::1"].Up {
		t.Fatalf("unexpected results %v", r)
	}
	if len(pinged) != 2 {
		t.Fatalf("pinged %v", pinged)
	}
}

func TestPingArgsNeverTakeOptionsFromTheAddress(t *testing.T) {
	for _, s := range []string{"10.0.0.1", "2001:db8::1", "::ffff:10.0.0.1"} {
		name, args := pingArgs(netip.MustParseAddr(s))
		if name == "" || len(args) == 0 || args[len(args)-1][0] == '-' {
			t.Fatalf("%s: %s %v", s, name, args)
		}
	}
}
