package main

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestCaptureValidation(t *testing.T) {
	for _, iface := range []string{"eth0", "wlan0", "br-lan", "eth0.100", "enp0s3:1", "veth@if3"} {
		if _, err := validateCapture(iface, ""); err != nil {
			t.Errorf("iface %q refused: %v", iface, err)
		}
	}
	for _, iface := range []string{"", "-w", "eth0;rm", "$(x)", "eth0 -w /etc/x", "a/b", "eth0\n", "-i", strings.Repeat("a", 33), "`id`"} {
		if _, err := validateCapture(iface, ""); err == nil {
			t.Errorf("iface %q accepted", iface)
		}
	}
	args, err := validateCapture("eth0", "tcp port 80 and not (host 10.0.0.1)")
	if err != nil || args[len(args)-1] != "10.0.0.1)" || args[0] != "-i" {
		t.Fatalf("valid filter: %v %v", args, err)
	}
	for _, filter := range []string{"-w /etc/x", "port 80 -z /bin/sh", "tcp;rm", "$(x)", "host `id`", "a'b", "\"x\"", strings.Repeat("a ", 33), strings.Repeat("a", 65)} {
		if _, err := validateCapture("eth0", filter); err == nil {
			t.Errorf("filter %q accepted", filter)
		}
	}
	// "--" ends tcpdump's options before the expression.
	args, _ = validateCapture("lo", "tcp")
	if args[len(args)-2] != "--" {
		t.Fatalf("no option terminator: %v", args)
	}
}

func TestCapture(t *testing.T) {
	bin, err := findTcpdump()
	if err != nil {
		t.Skip("tcpdump not installed")
	}
	pctx, pcancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer pcancel()
	if out, _ := exec.CommandContext(pctx, bin, "-i", "lo", "-w", os.DevNull).CombinedOutput(); !strings.Contains(string(out), "listening") {
		t.Skipf("tcpdump not runnable here: %s", strings.TrimSpace(string(out)))
	}
	e := newFileEnv(t)
	xfer := "x" + randomID(8)
	rid := e.send(map[string]any{"op": "capture", "xfer": xfer, "iface": "lo", "seconds": 2, "maxBytes": 1 << 20})
	var data []byte
	for {
		m, b := e.next()
		if m.Rid != rid {
			t.Fatal("answer on another rid")
		}
		if b["error"] != nil {
			t.Fatalf("capture: %v", b["error"])
		}
		if s, ok := b["data"].(string); ok {
			d, _ := b64.DecodeString(s)
			data = append(data, d...)
		}
		e.send(map[string]any{"op": "ack", "xfer": xfer, "n": *m.N + 1})
		if m.End {
			break
		}
	}
	// pcap global header magic, either byte order.
	if len(data) < 24 || !(data[0] == 0xd4 && data[1] == 0xc3 || data[0] == 0xa1 && data[1] == 0xb2 || data[0] == 0x4d || data[0] == 0x0a) {
		t.Fatalf("not a capture file: % x", data[:min(8, len(data))])
	}
	// A bad interface is reported as an error frame.
	e.send(map[string]any{"op": "capture", "xfer": "x" + randomID(8), "iface": "nonexistent0"})
	if _, b := e.next(); b["error"] == nil {
		t.Fatal("unknown interface did not fail")
	}
}

func TestCaptureStop(t *testing.T) {
	bin, err := findTcpdump()
	if err != nil {
		t.Skip("tcpdump not installed")
	}
	pctx, pcancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer pcancel()
	if out, _ := exec.CommandContext(pctx, bin, "-i", "lo", "-w", os.DevNull).CombinedOutput(); !strings.Contains(string(out), "listening") {
		t.Skipf("tcpdump not runnable here: %s", strings.TrimSpace(string(out)))
	}
	e := newFileEnv(t)
	xfer := "x" + randomID(8)
	rid := e.send(map[string]any{"op": "capture", "xfer": xfer, "iface": "lo", "seconds": 120})
	time.Sleep(500 * time.Millisecond)
	e.send(map[string]any{"op": "stop", "xfer": xfer})
	var data []byte
	for {
		m, b := e.next()
		if m.Rid != rid || b["error"] != nil {
			t.Fatalf("stop did not end the capture cleanly: %v", b["error"])
		}
		if s, ok := b["data"].(string); ok {
			d, _ := b64.DecodeString(s)
			data = append(data, d...)
		}
		e.send(map[string]any{"op": "ack", "xfer": xfer, "n": *m.N + 1})
		if m.End {
			break
		}
	}
	if len(data) < 24 {
		t.Fatalf("stopped capture is empty (%d bytes)", len(data))
	}
}
