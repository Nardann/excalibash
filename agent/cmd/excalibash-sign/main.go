// Command excalibash-sign generates the release signing key of the Excalibash agent and signs
// a release: it hashes the binaries of a dist directory, writes agent-manifest.json and its
// detached Ed25519 signature agent-manifest.json.sig next to them.
//
//	excalibash-sign keygen [--out release.key]
//	excalibash-sign sign --key release.key --dist agent/dist --version 1.2.0
//
// Keep the private key offline (docs/RELEASE.md): it is the only thing that lets an agent
// accept an update. The public key printed by keygen is what the agents are built with
// (make UPDATE_PUBKEY=...).
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type entry struct {
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type manifest struct {
	Version string           `json:"version"`
	Date    string           `json:"date"`
	Files   map[string]entry `json:"files"`
}

var platforms = []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"}

const maxBinary = 64 << 20

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "excalibash-sign:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: excalibash-sign keygen [--out FILE] | sign --key FILE --dist DIR --version X")
	}
	switch args[0] {
	case "keygen":
		fs := flag.NewFlagSet("keygen", flag.ContinueOnError)
		fs.SetOutput(stderr)
		out := fs.String("out", "excalibash-release.key", "where to write the private key (mode 0600, never overwritten)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return keygen(*out, stdout, stderr)
	case "sign":
		fs := flag.NewFlagSet("sign", flag.ContinueOnError)
		fs.SetOutput(stderr)
		key := fs.String("key", "", "private key file written by keygen")
		dist := fs.String("dist", "agent/dist", "directory holding excalibash-agent-<os>-<arch>")
		ver := fs.String("version", "", "version the binaries were built with (make VERSION=...)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		return sign(*key, *dist, *ver, time.Now(), stdout)
	}
	return fmt.Errorf("unknown command %q", args[0])
}

// keygen writes a fresh private key (base64 of the 32-byte seed) and prints the public key.
func keygen(path string, stdout, stderr io.Writer) error {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = f.WriteString(base64.StdEncoding.EncodeToString(priv.Seed()) + "\n")
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(stderr, "clé privée écrite dans %s (0600) : à garder hors ligne, jamais dans le dépôt, la CI ou le serveur\n", path)
	fmt.Fprintln(stdout, base64.StdEncoding.EncodeToString(pub))
	return nil
}

func readKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("clé privée illisible (base64 de 32 octets attendu)")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// sign builds and signs the manifest of every platform binary found in dist.
func sign(keyPath, dist, version string, now time.Time, stdout io.Writer) error {
	if keyPath == "" || version == "" {
		return errors.New("sign needs --key and --version")
	}
	priv, err := readKey(keyPath)
	if err != nil {
		return err
	}
	m := manifest{Version: version, Date: now.UTC().Format(time.RFC3339), Files: map[string]entry{}}
	for _, p := range platforms {
		path := filepath.Join(dist, "excalibash-agent-"+p)
		b, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if len(b) == 0 || len(b) > maxBinary {
			return fmt.Errorf("%s : taille invalide (%d octets)", path, len(b))
		}
		// A binary built with another VERSION would make the agent loop on "outdated": refuse.
		if !bytes.Contains(b, []byte(version)) {
			return fmt.Errorf("%s ne contient pas la version %q : reconstruis-le avec VERSION=%s", path, version, version)
		}
		sum := sha256.Sum256(b)
		m.Files[p] = entry{SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
	}
	if len(m.Files) == 0 {
		return fmt.Errorf("aucun binaire excalibash-agent-<os>-<arch> dans %s", dist)
	}
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, raw)) + "\n"
	if err := os.WriteFile(filepath.Join(dist, "agent-manifest.json"), raw, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dist, "agent-manifest.json.sig"), []byte(sig), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(stdout, "version %s signée : %d binaire(s) dans %s\n", version, len(m.Files), dist)
	return nil
}
