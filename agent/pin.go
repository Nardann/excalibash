package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Public key pinning, for servers using a self-signed certificate. The pin has the format of
// curl --pinnedpubkey: "sha256//" + standard base64 of SHA-256(SubjectPublicKeyInfo DER).
// With a pin, chain and host name are not checked: only the key of the leaf certificate matters.

const pinPrefix = "sha256//"

// parsePin validates a pin and returns its canonical form ("" stays "": no pin).
func parsePin(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	rest, ok := strings.CutPrefix(s, pinPrefix)
	if !ok {
		return "", fmt.Errorf("pin invalide %q : format attendu sha256//<base64>", s)
	}
	sum, err := base64.StdEncoding.DecodeString(rest)
	if err != nil || len(sum) != sha256.Size {
		return "", fmt.Errorf("pin invalide %q : base64 d'une empreinte SHA-256 (32 octets) attendu", s)
	}
	return pinPrefix + base64.StdEncoding.EncodeToString(sum), nil
}

// spkiPin computes the pin of a DER-encoded SubjectPublicKeyInfo.
func spkiPin(spki []byte) string {
	sum := sha256.Sum256(spki)
	return pinPrefix + base64.StdEncoding.EncodeToString(sum[:])
}

// clientTLS returns the TLS configuration for a pin (checked by itself) or --insecure;
// nil means the default verification. A pin wins over --insecure.
func clientTLS(insecure bool, pin string) *tls.Config {
	if pin == "" {
		if insecure {
			return &tls.Config{InsecureSkipVerify: true}
		}
		return nil
	}
	return &tls.Config{
		InsecureSkipVerify: true, // replaced by the pin check below
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("le serveur n'a présenté aucun certificat")
			}
			got := spkiPin(cs.PeerCertificates[0].RawSubjectPublicKeyInfo)
			if subtle.ConstantTimeCompare([]byte(got), []byte(pin)) != 1 {
				return fmt.Errorf("certificat du serveur inattendu : empreinte attendue %s, reçue %s", pin, got)
			}
			return nil
		},
	}
}

// httpTransport returns a transport using clientTLS, or nil for http.DefaultTransport.
func httpTransport(insecure bool, pin string) http.RoundTripper {
	cfg := clientTLS(insecure, pin)
	if cfg == nil {
		return nil
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = cfg
	return tr
}
