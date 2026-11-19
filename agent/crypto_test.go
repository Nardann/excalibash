package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

// Cross-language vectors: box/seal output is randomised, so the other side
// checks that it can open these (see testdata/vectors.json).
type vectors struct {
	Box []struct {
		Key       string `json:"aeadKey"`
		AAD       string `json:"aad"`
		Plaintext string `json:"plaintext"`
		Box       string `json:"box"`
	} `json:"box"`
	Seal []struct {
		Priv      string `json:"recipientPriv"`
		Pub       string `json:"recipientPub"`
		AAD       string `json:"aad"`
		Plaintext string `json:"plaintext"`
		Sealed    string `json:"sealed"`
	} `json:"seal"`
	Fingerprint []struct {
		Pub         string `json:"pub"`
		Fingerprint string `json:"fingerprint"`
	} `json:"fingerprint"`
}

func TestBoxRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	rand.Read(key)
	ct, err := box(key, []byte("hello"), "eb:test")
	if err != nil {
		t.Fatal(err)
	}
	if ct[0] != 0x01 || len(ct) != 1+12+5+16 {
		t.Fatalf("unexpected box layout: %x", ct)
	}
	pt, err := unbox(key, ct, "eb:test")
	if err != nil || string(pt) != "hello" {
		t.Fatalf("unbox: %q %v", pt, err)
	}
	if _, err := unbox(key, ct, "eb:other"); err == nil {
		t.Fatal("unbox accepted a different AAD")
	}
	ct[len(ct)-1] ^= 1
	if _, err := unbox(key, ct, "eb:test"); err == nil {
		t.Fatal("unbox accepted a tampered ciphertext")
	}
}

func TestSealRoundTrip(t *testing.T) {
	priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
	ct, err := seal(priv.PublicKey(), []byte("secret"), "eb:term:x")
	if err != nil {
		t.Fatal(err)
	}
	if ct[0] != 0x02 || len(ct) != 1+32+12+6+16 {
		t.Fatalf("unexpected seal layout: %x", ct)
	}
	pt, err := unseal(priv, ct, "eb:term:x")
	if err != nil || string(pt) != "secret" {
		t.Fatalf("unseal: %q %v", pt, err)
	}
	if _, err := unseal(priv, ct, "eb:term:y"); err == nil {
		t.Fatal("unseal accepted a different AAD")
	}
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if _, err := unseal(other, ct, "eb:term:x"); err == nil {
		t.Fatal("unseal worked with the wrong private key")
	}
}

func TestFingerprint(t *testing.T) {
	fp := fingerprint(make([]byte, 32))
	// SHA-256 of 32 zero bytes starts with 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925.
	if fp != "6668 7AAD F862 BD77 6C8F C18B 8E9F 8E20 0897 1485" {
		t.Fatalf("fingerprint = %q", fp)
	}
}

// TestVectors checks testdata/vectors.json; UPDATE_VECTORS=1 regenerates it.
func TestVectors(t *testing.T) {
	path := "testdata/vectors.json"
	if os.Getenv("UPDATE_VECTORS") != "" {
		writeVectors(t, path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Box {
		key, _ := b64.DecodeString(c.Key)
		ct, _ := b64.DecodeString(c.Box)
		pt, err := unbox(key, ct, c.AAD)
		if err != nil || string(pt) != c.Plaintext {
			t.Errorf("box vector %q: %q %v", c.AAD, pt, err)
		}
	}
	for _, c := range v.Seal {
		priv, err := parsePrivateKey(c.Priv)
		if err != nil {
			t.Fatal(err)
		}
		if b64.EncodeToString(priv.PublicKey().Bytes()) != c.Pub {
			t.Errorf("seal vector %q: public key mismatch", c.AAD)
		}
		ct, _ := b64.DecodeString(c.Sealed)
		pt, err := unseal(priv, ct, c.AAD)
		if err != nil || string(pt) != c.Plaintext {
			t.Errorf("seal vector %q: %q %v", c.AAD, pt, err)
		}
	}
	for _, c := range v.Fingerprint {
		pub, _ := b64.DecodeString(c.Pub)
		if got := fingerprint(pub); got != c.Fingerprint {
			t.Errorf("fingerprint %s = %q, want %q", c.Pub, got, c.Fingerprint)
		}
	}
}

func writeVectors(t *testing.T, path string) {
	t.Helper()
	var v vectors
	keys := [][]byte{bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x42}, 32)}
	boxes := []struct{ aad, pt string }{
		{"eb:name:abcdefghijklmnop", "Archi infra"},
		{"eb:term-out:t1:gen12345:1", "\x1b[32mhi\x1b[0m\r\n"},
		{"eb:term-in:t1:tabA:7:1795078000000", "ls -la\r"},
	}
	for i, b := range boxes {
		ct, err := box(keys[i%len(keys)], []byte(b.pt), b.aad)
		if err != nil {
			t.Fatal(err)
		}
		v.Box = append(v.Box, struct {
			Key       string `json:"aeadKey"`
			AAD       string `json:"aad"`
			Plaintext string `json:"plaintext"`
			Box       string `json:"box"`
		}{b64.EncodeToString(keys[i%len(keys)]), b.aad, b.pt, b64.EncodeToString(ct)})
	}
	for i, aad := range []string{"eb:term:t1", "eb:grant:abcdefghijklmnop:userid0123456789"} {
		priv, err := ecdh.X25519().NewPrivateKey(bytes.Repeat([]byte{byte(0x20 + i)}, 32))
		if err != nil {
			t.Fatal(err)
		}
		pt := fmt.Sprintf("32-byte-key-material-%010d", i) // ASCII keeps the JSON exact
		ct, err := seal(priv.PublicKey(), []byte(pt), aad)
		if err != nil {
			t.Fatal(err)
		}
		v.Seal = append(v.Seal, struct {
			Priv      string `json:"recipientPriv"`
			Pub       string `json:"recipientPub"`
			AAD       string `json:"aad"`
			Plaintext string `json:"plaintext"`
			Sealed    string `json:"sealed"`
		}{b64.EncodeToString(priv.Bytes()), b64.EncodeToString(priv.PublicKey().Bytes()), aad, pt, b64.EncodeToString(ct)})
		v.Fingerprint = append(v.Fingerprint, struct {
			Pub         string `json:"pub"`
			Fingerprint string `json:"fingerprint"`
		}{b64.EncodeToString(priv.PublicKey().Bytes()), fingerprint(priv.PublicKey().Bytes())})
	}
	out, _ := json.MarshalIndent(v, "", "  ")
	os.MkdirAll("testdata", 0o755)
	if err := os.WriteFile(path, append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
