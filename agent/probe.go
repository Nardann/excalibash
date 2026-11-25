package main

import (
	"context"
	"encoding/json"
	"net/netip"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// Reachability probes for the cables of a diagram: the machine's owner asks "can this machine
// reach these addresses?". The request is boxed under the machine auth key (shared only with
// the owner), so the server can neither read the addresses nor make the agent probe anything.
// Each address is checked with the system's ping, given as a plain argument (never a shell).

const (
	maxProbeTargets = 32
	probeParallel   = 8
	probeTimeout    = 3 * time.Second
)

type probeHub struct {
	mu     sync.Mutex
	auth   []byte
	nonces map[string]time.Time // request ids seen recently, against replays
}

func newProbeHub(auth []byte) *probeHub {
	return &probeHub{auth: auth, nonces: map[string]time.Time{}}
}

type probeResult struct {
	Up bool    `json:"up"`
	Ms float64 `json:"ms,omitempty"`
}

// handle answers one probe request: box(auth, {targets}, "eb:probe:<rid>:<ts>") in, the results
// boxed under "eb:probe-res:<rid>" out. It runs in its own goroutine.
func (p *probeHub) handle(msg message, out *outbox) {
	ts, err := strconv.ParseInt(string(msg.Ts), 10, 64)
	if err != nil || msg.Rid == "" || len(msg.Rid) > 64 {
		return
	}
	if skew := time.Since(time.UnixMilli(ts)); skew > inputMaxSkew || skew < -inputMaxSkew {
		debugf("probe %s: timestamp out of window", msg.Rid)
		return
	}
	data, err := b64.DecodeString(msg.D)
	if err != nil {
		return
	}
	pt, err := unbox(p.auth, data, "eb:probe:"+msg.Rid+":"+strconv.FormatInt(ts, 10))
	if err != nil {
		debugf("probe %s: authentication failed", msg.Rid)
		return
	}
	if !p.fresh(msg.Rid) {
		return
	}
	var req struct {
		Targets []string `json:"targets"`
	}
	if json.Unmarshal(pt, &req) != nil || len(req.Targets) > maxProbeTargets {
		return
	}
	results := probeAll(req.Targets, ping)
	plain, _ := json.Marshal(map[string]any{"r": results})
	boxed, err := box(p.auth, plain, "eb:probe-res:"+msg.Rid)
	if err != nil {
		return
	}
	out.send(message{T: "probe.res", Rid: msg.Rid, D: b64.EncodeToString(boxed)})
}

// fresh records a request id, and refuses one already seen.
func (p *probeHub) fresh(rid string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	for n, at := range p.nonces {
		if now.Sub(at) > nonceLifetime {
			delete(p.nonces, n)
		}
	}
	if _, seen := p.nonces[rid]; seen {
		return false
	}
	p.nonces[rid] = now
	return true
}

// probeAll pings every valid address (a few at a time); anything that is not a plain IP
// address is left out of the answer.
func probeAll(targets []string, pinger func(netip.Addr) probeResult) map[string]probeResult {
	results := map[string]probeResult{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, probeParallel)
	for _, t := range targets {
		addr, err := netip.ParseAddr(t)
		if err != nil || addr.Zone() != "" || addr.IsUnspecified() || addr.IsMulticast() {
			continue
		}
		mu.Lock()
		_, dup := results[t]
		results[t] = probeResult{}
		mu.Unlock()
		if dup {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(key string, a netip.Addr) {
			defer wg.Done()
			defer func() { <-sem }()
			r := pinger(a)
			mu.Lock()
			results[key] = r
			mu.Unlock()
		}(t, addr)
	}
	wg.Wait()
	return results
}

var pingTime = regexp.MustCompile(`time[=<]\s*([0-9.]+)\s*ms`)

// pingArgs is the system ping command for one echo request with a short timeout.
func pingArgs(addr netip.Addr) (string, []string) {
	ip := addr.Unmap().String()
	v6 := addr.Unmap().Is6()
	switch runtime.GOOS {
	case "darwin":
		if v6 {
			return "ping6", []string{"-n", "-c", "1", ip}
		}
		return "ping", []string{"-n", "-c", "1", "-t", "2", ip}
	default: // Linux (iputils, busybox)
		args := []string{"-n", "-c", "1", "-W", "2"}
		if v6 {
			args = append(args, "-6")
		}
		return "ping", append(args, ip)
	}
}

// ping sends one echo request; a missing ping command or a timeout reads as unreachable.
func ping(addr netip.Addr) probeResult {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	name, args := pingArgs(addr)
	cmd := exec.CommandContext(ctx, name, args...)
	start := time.Now()
	outb, err := cmd.Output()
	if err != nil {
		return probeResult{}
	}
	r := probeResult{Up: true, Ms: float64(time.Since(start).Microseconds()) / 1000}
	if m := pingTime.FindSubmatch(outb); m != nil {
		if v, err := strconv.ParseFloat(string(m[1]), 64); err == nil {
			r.Ms = v
		}
	}
	return r
}
