package main

import (
	"crypto/rand"
	"encoding/json"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"testing"
	"time"
)

// probeRequest builds a request the way the owner's browser issues it.
func probeRequest(t *testing.T, auth []byte, rid string, ts int64, targets []string) message {
	t.Helper()
	return probeRequestKind(t, auth, rid, ts, "", targets)
}

// probeRequestKind is probeRequest with a kind ("" leaves the field out, as an older web does).
func probeRequestKind(t *testing.T, auth []byte, rid string, ts int64, kind string, targets []string) message {
	t.Helper()
	body := map[string]any{"targets": targets}
	if kind != "" {
		body["kind"] = kind
	}
	pt, _ := json.Marshal(body)
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
	var mu sync.Mutex
	var pinged []string
	fake := func(a netip.Addr) probeResult {
		// probeAll pings in parallel.
		mu.Lock()
		defer mu.Unlock()
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

func answerOf(t *testing.T, auth []byte, rid string, m *message) map[string]json.RawMessage {
	t.Helper()
	if m == nil || m.T != "probe.res" || m.Rid != rid {
		t.Fatalf("no answer: %+v", m)
	}
	data, _ := b64.DecodeString(m.D)
	pt, err := unbox(auth, data, "eb:probe-res:"+rid)
	if err != nil {
		t.Fatal("answer not boxed under the machine auth key")
	}
	var res map[string]json.RawMessage
	if json.Unmarshal(pt, &res) != nil {
		t.Fatal("bad answer")
	}
	return res
}

func TestProbeKindDispatch(t *testing.T) {
	auth := make([]byte, 32)
	rand.Read(auth)
	p := newProbeHub(auth)
	out, next := capture()
	now := time.Now().UnixMilli()

	// kind "ifaces": the interfaces, no ping results; the machine has at least a loopback.
	go p.handle(probeRequestKind(t, auth, "i1", now, "ifaces", nil), out)
	res := answerOf(t, auth, "i1", next())
	if _, ok := res["r"]; ok {
		t.Fatal("ifaces answer carries ping results")
	}
	var ifaces []ifaceInfo
	if json.Unmarshal(res["ifaces"], &ifaces) != nil || len(ifaces) == 0 {
		t.Fatalf("no interfaces in %s", res["ifaces"])
	}
	for _, i := range ifaces {
		if i.Name == "" || i.Addrs == nil {
			t.Fatalf("incomplete interface %+v", i)
		}
	}

	// An old request, without kind, still pings and does not return interfaces.
	go p.handle(probeRequestKind(t, auth, "p1", now, "", []string{"127.0.0.1"}), out)
	res = answerOf(t, auth, "p1", next())
	if _, ok := res["ifaces"]; ok {
		t.Fatal("ping answer carries interfaces")
	}
	var r map[string]probeResult
	if json.Unmarshal(res["r"], &r) != nil || !r["127.0.0.1"].Up {
		t.Fatalf("ping not answered: %s", res["r"])
	}

	// An unknown kind is not answered; the rid stays usable only once.
	go p.handle(probeRequestKind(t, auth, "x1", now, "shell", nil), out)
	if m := next(); m != nil {
		t.Fatalf("unknown kind answered: %+v", m)
	}
}

func TestIfaceAnswerAndCaps(t *testing.T) {
	_, v4, _ := net.ParseCIDR("10.0.0.0/24")
	v4.IP = net.ParseIP("10.0.0.1").To4()
	_, v6, _ := net.ParseCIDR("fe80::/64")
	v6.IP = net.ParseIP("fe80::1")
	mac, _ := net.ParseMAC("52:54:00:12:34:56")
	small := func() ([]net.Interface, func(net.Interface) ([]net.Addr, error), error) {
		list := []net.Interface{
			{Name: "eth0", MTU: 1500, HardwareAddr: mac, Flags: net.FlagUp | net.FlagRunning},
			{Name: "eth1", MTU: 9000, Flags: 0},
		}
		return list, func(i net.Interface) ([]net.Addr, error) {
			if i.Name == "eth0" {
				return []net.Addr{v4, v6}, nil
			}
			return nil, nil
		}, nil
	}
	got := listIfaces(small)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
	e0, e1 := got[0], got[1]
	if e0.Name != "eth0" || !e0.Up || !e0.Running || e0.MTU != 1500 || e0.MAC != "52:54:00:12:34:56" || len(e0.Addrs) != 2 || e0.Addrs[0] != "10.0.0.1/24" || e0.Addrs[1] != "fe80::1/64" {
		t.Fatalf("eth0: %+v", e0)
	}
	if e1.Up || e1.Running || e1.Addrs == nil || len(e1.Addrs) != 0 {
		t.Fatalf("eth1: %+v", e1)
	}
	if b, _ := json.Marshal(e1); !json.Valid(b) || string(b) == "" {
		t.Fatal("bad json")
	}

	// Caps: 300 interfaces with 100 addresses each.
	many := func() ([]net.Interface, func(net.Interface) ([]net.Addr, error), error) {
		var list []net.Interface
		for i := 0; i < 300; i++ {
			list = append(list, net.Interface{Name: "veth" + strconv.Itoa(i), Flags: net.FlagUp})
		}
		return list, func(net.Interface) ([]net.Addr, error) {
			var a []net.Addr
			for i := 0; i < 100; i++ {
				a = append(a, v4)
			}
			return a, nil
		}, nil
	}
	got = listIfaces(many)
	if len(got) != maxProbeIfaces {
		t.Fatalf("interfaces not capped: %d", len(got))
	}
	for _, i := range got {
		if len(i.Addrs) != maxIfaceAddrs {
			t.Fatalf("addresses not capped: %d", len(i.Addrs))
		}
	}
}
