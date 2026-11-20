package main

import (
	"context"
	"crypto/rand"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// serverPin is the pin of an httptest TLS server's self-signed certificate.
func serverPin(srv *httptest.Server) string {
	return spkiPin(srv.Certificate().RawSubjectPublicKeyInfo)
}

const otherPin = "sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

func TestParsePin(t *testing.T) {
	good := "sha256//" + strings.Repeat("A", 43) + "="
	if p, err := parsePin("  " + good + "\n"); err != nil || p != good {
		t.Fatalf("parsePin(%q) = %q, %v", good, p, err)
	}
	if p, err := parsePin(""); err != nil || p != "" {
		t.Fatalf("empty pin: %q, %v", p, err)
	}
	for _, bad := range []string{
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",       // no prefix
		"sha1//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // other hash
		"sha256//AAAA", // too short
		"sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",  // unpadded
		"sha256//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_-", // base64url
		"sha256//" + strings.Repeat("A", 44) + "AAAA",          // 35 bytes
	} {
		if _, err := parsePin(bad); err == nil {
			t.Errorf("parsePin(%q) accepted", bad)
		}
	}
}

func TestPinnedWebsocket(t *testing.T) {
	srv, conns := newFakeServer(true)
	defer srv.Close()
	endpoint, _ := agentEndpoint(srv.URL)
	h := newHarness(t)

	try := func(insecure bool, pin string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		mgr := newManager(h.priv)
		defer mgr.closeAll()
		errc := make(chan error, 1)
		go func() {
			errc <- connectOnce(ctx, config{endpoint: endpoint, token: "secret", name: "test", insecure: insecure, pin: pin}, mgr)
		}()
		select {
		case c := <-conns:
			if m := recv(t, c); m.T != "hello" {
				t.Fatalf("expected hello, got %+v", m)
			}
			cancel()
			<-errc
			return nil
		case err := <-errc:
			return err
		}
	}

	if err := try(false, serverPin(srv)); err != nil {
		t.Fatalf("right pin refused: %v", err)
	}
	err := try(false, otherPin)
	if err == nil || !strings.Contains(err.Error(), otherPin) || !strings.Contains(err.Error(), serverPin(srv)) {
		t.Fatalf("wrong pin: expected a mismatch with both pins, got %v", err)
	}
	if err := try(true, otherPin); err == nil {
		t.Fatal("--insecure bypassed a wrong pin")
	}
	if err := try(false, ""); err == nil || !strings.Contains(err.Error(), "certificate") {
		t.Fatalf("self-signed certificate accepted without pin or --insecure: %v", err)
	}
	if err := try(true, ""); err != nil {
		t.Fatalf("--insecure refused: %v", err)
	}
}

func TestPinnedPairing(t *testing.T) {
	auth := make([]byte, 32)
	rand.Read(auth)
	srv := httptest.NewTLSServer(pairingHandler(t, auth, func(p []byte) []byte { return p }))
	defer srv.Close()
	pin := serverPin(srv)

	if _, err := pair(srv.URL, "7KQ4FD", "vm1", false, ""); err == nil {
		t.Fatal("pairing with a self-signed certificate accepted without pin")
	}
	_, err := pair(srv.URL, "7KQ4FD", "vm1", false, otherPin)
	if err == nil || !strings.Contains(err.Error(), "attendue "+otherPin) {
		t.Fatalf("pairing with a wrong pin: %v", err)
	}

	c, err := pair(srv.URL, "7KQ4FD", "vm1", false, pin)
	if err != nil {
		t.Fatal(err)
	}
	if c.Pin != pin {
		t.Fatalf("pin not kept in the configuration: %+v", c)
	}
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := saveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	back, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := savedPin("", back); err != nil || got != pin {
		t.Fatalf("saved pin not reused: %q, %v", got, err)
	}
	if got, _ := savedPin(otherPin, back); got != otherPin {
		t.Fatalf("explicit --pin did not override the saved one: %q", got)
	}
}

func TestConfigWithoutPin(t *testing.T) {
	// A configuration written before pinning existed.
	path := filepath.Join(t.TempDir(), "agent.json")
	os.WriteFile(path, []byte(`{"server":"https://x","token":"eba_t","auth":"YQ","pub":""}`), 0o600)
	c, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := savedPin("", c); err != nil || got != "" {
		t.Fatalf("old configuration: pin %q, %v", got, err)
	}
	c.Pin = "sha256//nope"
	if _, err := savedPin("", c); err == nil {
		t.Fatal("malformed saved pin accepted")
	}
}
