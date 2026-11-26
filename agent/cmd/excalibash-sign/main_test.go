package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestKeygenAndSign(t *testing.T) {
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "k")
	var out, errb bytes.Buffer
	if err := run([]string{"keygen", "--out", keyFile}, &out, &errb); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(keyFile)
	if st.Mode().Perm() != 0o600 {
		t.Errorf("private key mode %v", st.Mode().Perm())
	}
	if err := run([]string{"keygen", "--out", keyFile}, &out, &errb); err == nil {
		t.Error("keygen overwrote an existing key")
	}
	pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(out.String()))
	if err != nil || len(pub) != ed25519.PublicKeySize {
		t.Fatalf("public key output: %q", out.String())
	}

	dist := filepath.Join(dir, "dist")
	os.MkdirAll(dist, 0o755)
	os.WriteFile(filepath.Join(dist, "excalibash-agent-linux-amd64"), []byte("binary 2.0.0 bytes"), 0o755)
	if err := run([]string{"sign", "--key", keyFile, "--dist", dist, "--version", "3.0.0"}, &out, &errb); err == nil {
		t.Error("signed a binary that lacks the version")
	}
	if err := run([]string{"sign", "--key", keyFile, "--dist", dist, "--version", "2.0.0"}, &out, &errb); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dist, "agent-manifest.json"))
	sigB, _ := os.ReadFile(filepath.Join(dist, "agent-manifest.json.sig"))
	sig, _ := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigB)))
	if !ed25519.Verify(ed25519.PublicKey(pub), raw, sig) {
		t.Error("signature does not verify")
	}
	var m manifest
	if json.Unmarshal(raw, &m) != nil || m.Version != "2.0.0" || m.Files["linux-amd64"].Size != 18 || len(m.Files["linux-amd64"].SHA256) != 64 {
		t.Errorf("manifest: %s", raw)
	}
}
