package main

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// openTunnel installs a tunnel the way the owner's browser issues it.
func openTunnel(t *testing.T, w *webHub, auth []byte, id string, spec map[string]any) *tunnel {
	t.Helper()
	key := make([]byte, 32)
	rand.Read(key)
	spec["k"] = b64.EncodeToString(key)
	pt, _ := json.Marshal(spec)
	boxed, err := box(auth, pt, "eb:web:"+id)
	if err != nil {
		t.Fatal(err)
	}
	w.open(message{T: "web.open", ID: id, Key: b64.EncodeToString(boxed)})
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.tunnels[id]
}

func TestWebTunnelHostHeader(t *testing.T) {
	var mu sync.Mutex
	var host, sni string
	site := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		host = r.Host
		mu.Unlock()
	}))
	site.TLS = &tls.Config{GetConfigForClient: func(hi *tls.ClientHelloInfo) (*tls.Config, error) {
		mu.Lock()
		sni = hi.ServerName
		mu.Unlock()
		return nil, nil
	}}
	site.StartTLS()
	defer site.Close()

	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	tn := openTunnel(t, w, auth, "w1", map[string]any{"url": site.URL, "insecure": true, "hostHeader": "intranet.local:8443"})
	if tn == nil {
		t.Fatal("tunnel with a valid hostHeader refused")
	}
	if res := w.forward(tn, httpReq{M: "GET", P: "/", H: map[string][]string{"Host": {"evil.example"}}}); res.S != 200 {
		t.Fatalf("status %d", res.S)
	}
	mu.Lock()
	defer mu.Unlock()
	if host != "intranet.local:8443" || sni != "intranet.local" {
		t.Fatalf("Host %q, SNI %q", host, sni)
	}

	for _, bad := range []string{"a b", "intranet.local:99999", "x:1:2", "évian.local", "h/x", "h\r\nX-Evil: 1"} {
		if openTunnel(t, w, auth, "w-"+bad, map[string]any{"url": site.URL, "hostHeader": bad}) != nil {
			t.Errorf("hostHeader %q accepted", bad)
		}
	}
}

func TestWebTunnelLegacyTLS(t *testing.T) {
	cfg := (&tunnel{}).tlsConfig()
	if cfg.MinVersion != 0 || cfg.CipherSuites != nil {
		t.Fatal("default tunnels must keep Go's TLS defaults")
	}
	cfg = (&tunnel{legacyTLS: true}).tlsConfig()
	if cfg.MinVersion != tls.VersionTLS10 {
		t.Fatalf("MinVersion %x", cfg.MinVersion)
	}
	if !slices.Contains(cfg.CipherSuites, tls.TLS_RSA_WITH_AES_128_CBC_SHA) || !slices.Contains(cfg.CipherSuites, tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256) {
		t.Fatalf("legacy suites missing: %v", cfg.CipherSuites)
	}

	// A TLS 1.0-only site is reachable with legacyTls only.
	site := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	site.TLS = &tls.Config{MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS10, CipherSuites: []uint16{tls.TLS_RSA_WITH_AES_128_CBC_SHA}}
	site.StartTLS()
	defer site.Close()
	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	modern := openTunnel(t, w, auth, "m", map[string]any{"url": site.URL, "insecure": true})
	if res := w.forward(modern, httpReq{M: "GET", P: "/"}); res.S != 502 {
		t.Fatalf("TLS 1.0 accepted without legacyTls (%d)", res.S)
	}
	legacy := openTunnel(t, w, auth, "l", map[string]any{"url": site.URL, "insecure": true, "legacyTls": true})
	if res := w.forward(legacy, httpReq{M: "GET", P: "/"}); res.S != 200 {
		b, _ := b64.DecodeString(res.B)
		t.Fatalf("legacyTls: %d %s", res.S, b)
	}
}

// frame builds a valid encrypted "http" frame the way the service worker does.
func frame(t *testing.T, tn *tunnel, id, rid string, req httpReq) message {
	t.Helper()
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	pt, _ := json.Marshal(req)
	boxed, err := box(tn.key, pt, "eb:http-req:"+id+":"+rid+":"+ts)
	if err != nil {
		t.Fatal(err)
	}
	return message{T: "http", ID: id, Rid: rid, Ts: json.RawMessage(ts), D: b64.EncodeToString(boxed)}
}

func TestWebRequestReplayConcurrent(t *testing.T) {
	var hits atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer site.Close()
	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	tn := openTunnel(t, w, auth, "w1", map[string]any{"url": site.URL})
	msg := frame(t, tn, "w1", "rid1", httpReq{M: "POST", P: "/reboot"})

	out := &outbox{ch: make(chan []byte, 64), done: make(chan struct{})}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); w.request(msg, out) }()
	}
	wg.Wait()
	if n := hits.Load(); n != 1 {
		t.Fatalf("%d forwards for one frame, want 1", n)
	}
	if len(out.ch) != 1 {
		t.Fatalf("%d responses, want 1", len(out.ch))
	}
	// A later replay is dropped too.
	w.request(msg, out)
	if hits.Load() != 1 {
		t.Fatal("sequential replay forwarded")
	}
}

func TestWebRequestForgedDoesNotBurnNonce(t *testing.T) {
	var hits atomic.Int32
	site := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }))
	defer site.Close()
	auth := make([]byte, 32)
	rand.Read(auth)
	w := newWebHub(auth)
	tn := openTunnel(t, w, auth, "w1", map[string]any{"url": site.URL})
	out := &outbox{ch: make(chan []byte, 8), done: make(chan struct{})}
	good := frame(t, tn, "w1", "rid1", httpReq{M: "GET", P: "/"})
	forged := good
	forged.D = b64.EncodeToString([]byte("garbage garbage garbage garbage garbage garbage"))
	w.request(forged, out)
	w.request(good, out)
	if hits.Load() != 1 {
		t.Fatalf("%d forwards, want 1", hits.Load())
	}
}

func TestUnderTarget(t *testing.T) {
	for _, c := range []struct{ prefix, p, want string }{
		{"/app", "/x", "/app/x"},
		{"/app/", "/x/", "/app/x/"},
		{"/app", "/../admin", "/app/admin"},
		{"/app", "/a/../../../etc", "/app/etc"},
		{"", "/", "/"},
		{"/app", "/", "/app/"},
		{"/app", "/redirect/http://x", "/app/redirect/http://x"},
		{"/app", "/a//b/./c", "/app/a//b/./c"},
		{"/app", "/a/b/..", "/app/a/"},
	} {
		if got := underTarget(c.prefix, c.p); got != c.want {
			t.Errorf("underTarget(%q, %q) = %q, want %q", c.prefix, c.p, got, c.want)
		}
	}
}
