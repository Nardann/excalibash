package main

// Envelope formats shared with the browser (see docs/SECURITY.md):
//   box  = 0x01 ‖ iv(12) ‖ AES-256-GCM(key, iv, pt, aad)
//   seal = 0x02 ‖ ephPub(32) ‖ iv(12) ‖ AES-256-GCM(k, iv, pt, aad)
//          k = HKDF-SHA256(X25519(eph, pub), salt = ephPub ‖ pub, info = "excalibash/seal/v1")
// Every binary value travels as unpadded base64url.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	boxVersion  = 0x01
	sealVersion = 0x02
	ivLen       = 12
	keyLen      = 32
	sealInfo    = "excalibash/seal/v1"
)

var errCrypto = errors.New("decryption failed")

var b64 = base64.RawURLEncoding

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != keyLen {
		return nil, errors.New("key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// box encrypts pt under a symmetric key, bound to aad.
func box(key, pt []byte, aad string) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 1+ivLen, 1+ivLen+len(pt)+gcm.Overhead())
	out[0] = boxVersion
	if _, err := rand.Read(out[1 : 1+ivLen]); err != nil {
		return nil, err
	}
	return gcm.Seal(out, out[1:1+ivLen], pt, []byte(aad)), nil
}

func unbox(key, data []byte, aad string) ([]byte, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(data) < 1+ivLen+gcm.Overhead() || data[0] != boxVersion {
		return nil, errCrypto
	}
	pt, err := gcm.Open(nil, data[1:1+ivLen], data[1+ivLen:], []byte(aad))
	if err != nil {
		return nil, errCrypto
	}
	return pt, nil
}

func sealKey(shared, ephPub, pub []byte) ([]byte, error) {
	salt := append(append([]byte{}, ephPub...), pub...)
	return hkdf.Key(sha256.New, shared, salt, sealInfo, keyLen)
}

// seal encrypts pt for the holder of the X25519 private key matching pub.
func seal(pub *ecdh.PublicKey, pt []byte, aad string) ([]byte, error) {
	eph, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	shared, err := eph.ECDH(pub)
	if err != nil {
		return nil, err
	}
	ephPub := eph.PublicKey().Bytes()
	k, err := sealKey(shared, ephPub, pub.Bytes())
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(k)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 1+32+ivLen, 1+32+ivLen+len(pt)+gcm.Overhead())
	out[0] = sealVersion
	copy(out[1:33], ephPub)
	if _, err := rand.Read(out[33 : 33+ivLen]); err != nil {
		return nil, err
	}
	return gcm.Seal(out, out[33:33+ivLen], pt, []byte(aad)), nil
}

func unseal(priv *ecdh.PrivateKey, data []byte, aad string) ([]byte, error) {
	if len(data) < 1+32+ivLen+16 || data[0] != sealVersion {
		return nil, errCrypto
	}
	ephPub, err := ecdh.X25519().NewPublicKey(data[1:33])
	if err != nil {
		return nil, errCrypto
	}
	shared, err := priv.ECDH(ephPub)
	if err != nil {
		return nil, errCrypto
	}
	k, err := sealKey(shared, data[1:33], priv.PublicKey().Bytes())
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(k)
	if err != nil {
		return nil, err
	}
	pt, err := gcm.Open(nil, data[33:33+ivLen], data[33+ivLen:], []byte(aad))
	if err != nil {
		return nil, errCrypto
	}
	return pt, nil
}

// parsePrivateKey reads an unpadded base64url X25519 private key (32 raw bytes).
func parsePrivateKey(s string) (*ecdh.PrivateKey, error) {
	raw, err := b64.DecodeString(strings.TrimRight(strings.TrimSpace(s), "="))
	if err != nil || len(raw) != 32 {
		return nil, errors.New("expected 32 bytes of base64url")
	}
	return ecdh.X25519().NewPrivateKey(raw)
}

// fingerprint formats SHA-256(pub)[:20] as uppercase hex in groups of 4.
func fingerprint(pub []byte) string {
	sum := sha256.Sum256(pub)
	h := strings.ToUpper(hex.EncodeToString(sum[:20]))
	groups := make([]string, 0, len(h)/4)
	for i := 0; i < len(h); i += 4 {
		groups = append(groups, h[i:i+4])
	}
	return strings.Join(groups, " ")
}

// randomID returns n random bytes as base64url (8 chars for n = 6).
func randomID(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b64.EncodeToString(b)
}
