package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Pairing with a short code typed on the machine (no copy-paste needed). The agent makes its
// own key pair here; the owner checks the fingerprint shown below against the one in the browser,
// then the browser seals the machine auth key to this public key. The private key never leaves.

const pairTimeout = 10 * time.Minute

// savedConfig is what a paired agent keeps on disk (0600).
type savedConfig struct {
	Server string `json:"server"`
	Token  string `json:"token"`
	Auth   string `json:"auth"` // machine auth key, base64url
	Pub    string `json:"pub"`  // public key, for the fingerprint in logs
	Name   string `json:"name,omitempty"`
}

func defaultConfigPath() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "excalibash", "agent.json")
}

func loadConfig(path string) (savedConfig, error) {
	var c savedConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, err
	}
	if c.Server == "" || c.Token == "" || c.Auth == "" {
		return c, errors.New("configuration incomplète")
	}
	return c, nil
}

func saveConfig(path string, c savedConfig) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

var codeChars = regexp.MustCompile(`[^A-Z0-9]`)

// normalizeCode accepts "7kq-4fd", "7KQ4FD"…
func normalizeCode(code string) string {
	return codeChars.ReplaceAllString(strings.ToUpper(code), "")
}

// httpBase turns the server URL into the http(s) base used for the pairing API.
func httpBase(server string) (string, error) {
	if !strings.Contains(server, "://") {
		server = "https://" + server
	}
	u, err := url.Parse(server)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("adresse de serveur invalide : %q", server)
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	}
	return u.Scheme + "://" + u.Host, nil
}

func pair(server, rawCode, name string, insecure bool) (savedConfig, error) {
	code := normalizeCode(rawCode)
	if len(code) < 6 {
		return savedConfig{}, errors.New("code d'appairage invalide")
	}
	base, err := httpBase(server)
	if err != nil {
		return savedConfig{}, err
	}
	client := &http.Client{Timeout: 20 * time.Second}
	if insecure {
		client.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return savedConfig{}, err
	}
	pub := b64.EncodeToString(priv.PublicKey().Bytes())
	endpoint := base + "/api/pair/" + code

	body, _ := json.Marshal(map[string]string{"pub": pub, "name": name})
	resp, err := client.Post(endpoint, "application/json", bytes.NewReader(body))
	if err != nil {
		return savedConfig{}, fmt.Errorf("serveur injoignable : %w", err)
	}
	resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusAccepted, http.StatusOK:
	case http.StatusNotFound, http.StatusGone:
		return savedConfig{}, errors.New("code inconnu, expiré ou déjà utilisé : génère-en un nouveau dans Excalibash")
	default:
		return savedConfig{}, fmt.Errorf("le serveur a refusé l'appairage (%d)", resp.StatusCode)
	}

	fmt.Fprintf(os.Stderr, "\n  Empreinte de cette machine :\n\n      %s\n\n", fingerprint(priv.PublicKey().Bytes()))
	fmt.Fprintln(os.Stderr, "  Vérifie qu'Excalibash affiche exactement la même, puis clique sur « C'est la même ».")
	fmt.Fprintln(os.Stderr, "  En attente de validation…")

	deadline := time.Now().Add(pairTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(2 * time.Second)
		resp, err := client.Get(endpoint + "?pub=" + url.QueryEscape(pub))
		if err != nil {
			continue
		}
		var res struct {
			Token      string `json:"token"`
			SealedAuth string `json:"sealedAuth"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusAccepted:
			continue
		case http.StatusOK:
		case http.StatusNotFound, http.StatusGone:
			return savedConfig{}, errors.New("appairage refusé ou expiré dans Excalibash")
		default:
			continue
		}
		if decodeErr != nil || res.Token == "" {
			return savedConfig{}, errors.New("réponse d'appairage invalide")
		}
		sealed, err := b64.DecodeString(res.SealedAuth)
		if err != nil {
			return savedConfig{}, errCrypto
		}
		auth, err := unseal(priv, sealed, "eb:pair:"+code)
		if err != nil || len(auth) != keyLen {
			return savedConfig{}, errors.New("clé de la machine non authentique : appairage annulé")
		}
		return savedConfig{Server: base, Token: res.Token, Auth: b64.EncodeToString(auth), Pub: pub, Name: name}, nil
	}
	return savedConfig{}, errors.New("délai dépassé : personne n'a validé l'appairage")
}

func pubFromB64(s string) []byte {
	b, err := b64.DecodeString(s)
	if err != nil {
		return nil
	}
	if _, err := ecdh.X25519().NewPublicKey(b); err != nil {
		return nil
	}
	return b
}
