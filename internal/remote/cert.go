package remote

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"strings"
	"time"
)

// GenerateCert makes a self-signed certificate for names and its ECDSA P-256 key (PKCS #8).
// IPv4 names go into IPAddresses, the others into DNSNames. Exported, with the dates, for the
// stand-in TLS servers of tests (an expired pair too).
func GenerateCert(names []string, notBefore, notAfter time.Time) (certPEM, keyPEM []byte, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return nil, nil, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: "AI Whiteboard"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, n := range names {
		if ip := net.ParseIP(n).To4(); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, n)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM, nil
}

// Fingerprint is the SHA-256 of a certificate's DER in openssl's form: 32 upper-case hex pairs
// with ":" between them.
func Fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	pairs := make([]string, len(sum))
	for i, b := range sum {
		pairs[i] = strings.ToUpper(hex.EncodeToString([]byte{b}))
	}
	return strings.Join(pairs, ":")
}

// FingerprintOfPEM is the fingerprint of the first certificate in certPEM.
func FingerprintOfPEM(certPEM []byte) (string, error) {
	c, err := firstCert(certPEM)
	if err != nil {
		return "", err
	}
	return Fingerprint(c.Raw), nil
}

// ParseFingerprint reads a SHA-256 fingerprint, with or without ":", in any case.
func ParseFingerprint(s string) ([32]byte, error) {
	var out [32]byte
	b, err := hex.DecodeString(strings.ReplaceAll(strings.TrimSpace(s), ":", ""))
	if err != nil || len(b) != len(out) {
		return out, errors.New("not a SHA-256 fingerprint: 64 hex digits, with or without \":\"")
	}
	copy(out[:], b)
	return out, nil
}

// firstCert parses the first CERTIFICATE block of b.
func firstCert(b []byte) (*x509.Certificate, error) {
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return nil, errors.New("no certificate PEM data")
		}
		if blk.Type == "CERTIFICATE" {
			return x509.ParseCertificate(blk.Bytes)
		}
	}
}
