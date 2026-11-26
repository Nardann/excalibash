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

const testConfirm = "ABCD234W" // valid check letter, see TestConfirmCode

// Check letter of 7KQ4FDX, the same vector as in web/src/crypto.ts tests.
const confirmVector = "5"

func init() { newConfirmCode = func() string { return testConfirm } }

// fakePairing approves the first registered key, sealing auth to sealFor(pub) with a tag made
// from the confirmation code `confirm` (what the owner typed).
func fakePairing(t *testing.T, auth []byte, sealFor func(agentPub []byte) []byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(pairingHandler(t, auth, sealFor, testConfirm))
}

func pairingHandler(t *testing.T, auth []byte, sealFor func(agentPub []byte) []byte, confirm string) http.Handler {
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
		payload := append(append([]byte{}, auth...), pairTag(confirm, auth, pub)...)
		sealed, err := seal(mustPub(t, sealFor(pub)), payload, "eb:pair:7KQ4FD")
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

func TestPairingRejectsServerChosenAuth(t *testing.T) {
	// A server that seals an auth key of its own to the agent's real key: it knows the key and the
	// code, but not the confirmation code shown on the machine.
	auth := make([]byte, 32)
	rand.Read(auth)
	srv := httptest.NewServer(pairingHandler(t, auth, func(p []byte) []byte { return p }, "ZZZZ9999"))
	defer srv.Close()
	if _, err := pair(srv.URL, "7KQ4FD", "vm1", false, ""); err == nil {
		t.Fatal("pairing accepted an auth key without the confirmation code")
	}
}

func TestPairingRejectsBareAuth(t *testing.T) {
	// The former format, auth alone, has no tag at all.
	auth := make([]byte, 32)
	rand.Read(auth)
	var registered string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var body struct{ Pub string }
			json.NewDecoder(r.Body).Decode(&body)
			registered = body.Pub
			w.WriteHeader(http.StatusAccepted)
			return
		}
		pub, _ := b64.DecodeString(registered)
		sealed, _ := seal(mustPub(t, pub), auth, "eb:pair:7KQ4FD")
		json.NewEncoder(w).Encode(map[string]string{"token": "eba_test", "sealedAuth": b64.EncodeToString(sealed)})
	}))
	defer srv.Close()
	if _, err := pair(srv.URL, "7KQ4FD", "vm1", false, ""); err == nil {
		t.Fatal("pairing accepted an auth key without a tag")
	}
}

func TestConfirmCode(t *testing.T) {
	for i := 0; i < 200; i++ {
		c := randomConfirmCode()
		if len(c) != confirmLen || strings.Trim(c, confirmAlphabet) != "" || confirmCheck(c[:7]) != c[7] {
			t.Fatalf("bad confirmation code %q", c)
		}
	}
	if got := string(confirmCheck("ABCD234")); got != testConfirm[7:] {
		t.Fatalf("check letter of ABCD234 = %s, testConfirm has %s", got, testConfirm[7:])
	}
	if string(confirmCheck("7KQ4FDX")) != confirmVector {
		t.Fatalf("check letter of 7KQ4FDX = %c", confirmCheck("7KQ4FDX"))
	}
}
