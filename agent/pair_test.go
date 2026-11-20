package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

// fakePairing approves the first registered key, sealing auth to sealFor(pub).
func fakePairing(t *testing.T, auth []byte, sealFor func(agentPub []byte) []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(pairingHandler(t, auth, sealFor))
}

func pairingHandler(t *testing.T, auth []byte, sealFor func(agentPub []byte) []byte) http.Handler {
	var registered string
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/pair/7KQ4FD") {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodPost {
			var body struct{ Pub string }
			json.NewDecoder(r.Body).Decode(&body)
			registered = body.Pub
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if r.URL.Query().Get("pub") != registered {
			http.NotFound(w, r)
			return
		}
		pub, _ := b64.DecodeString(registered)
		sealed, err := seal(mustPub(t, sealFor(pub)), auth, "eb:pair:7KQ4FD")
		if err != nil {
			t.Fatal(err)
		}
		json.NewEncoder(w).Encode(map[string]string{"token": "eba_test", "sealedAuth": b64.EncodeToString(sealed)})
	})
}

func mustPub(t *testing.T, raw []byte) *ecdh.PublicKey {
	k, err := ecdh.X25519().NewPublicKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestPairing(t *testing.T) {
	auth := make([]byte, 32)
	rand.Read(auth)
	srv := fakePairing(t, auth, func(p []byte) []byte { return p })
	defer srv.Close()

	c, err := pair(srv.URL, "7kq-4fd", "vm1", false, "")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := b64.DecodeString(c.Auth)
	if string(got) != string(auth) || c.Token != "eba_test" || c.Server != srv.URL {
		t.Fatalf("unexpected config %+v", c)
	}
	path := filepath.Join(t.TempDir(), "x", "agent.json")
	if err := saveConfig(path, c); err != nil {
		t.Fatal(err)
	}
	back, err := loadConfig(path)
	if err != nil || back.Auth != c.Auth {
		t.Fatalf("config round trip failed: %v", err)
	}
}

func TestPairingRejectsOtherKey(t *testing.T) {
	// A server that seals the auth key for its own key instead of the agent's.
	evil, _ := ecdh.X25519().GenerateKey(rand.Reader)
	auth := make([]byte, 32)
	rand.Read(auth)
	srv := fakePairing(t, auth, func([]byte) []byte { return evil.PublicKey().Bytes() })
	defer srv.Close()
	if _, err := pair(srv.URL, "7KQ4FD", "vm1", false, ""); err == nil {
		t.Fatal("pairing accepted an auth key not sealed to this agent")
	}
}
