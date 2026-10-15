//go:build ignore

// make.go writes the committed certificates the connection tests use. Run it from this folder:
//
//	go run make.go
//
// It writes, as PEM pairs (NAME.crt, NAME.key):
//
//	a, b       two self-signed certificates for localhost and 127.0.0.1, valid for 100 years
//	expired    a self-signed certificate for localhost and 127.0.0.1 that expired in 2020
//	leaf       a certificate for 127.0.0.1 and localhost signed by ca (ca.crt is the root to trust)
//	othername  a certificate signed by ca for other.example only
//
// The keys protect nothing: they are for tests.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"time"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func write(name string, der []byte, key *ecdsa.PrivateKey) {
	must(os.WriteFile(name+".crt", pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644))
	if key != nil {
		kb, err := x509.MarshalECPrivateKey(key)
		must(err)
		must(os.WriteFile(name+".key", pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600))
	}
}

var serial int64 = 100

func template(cn string, names []string, notBefore, notAfter time.Time, ca bool) *x509.Certificate {
	serial++
	t := &x509.Certificate{
		SerialNumber:          big.NewInt(serial),
		Subject:               pkix.Name{CommonName: cn},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  ca,
	}
	if ca {
		t.KeyUsage = x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature
		t.ExtKeyUsage = nil
	}
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			t.IPAddresses = append(t.IPAddresses, ip)
		} else {
			t.DNSNames = append(t.DNSNames, n)
		}
	}
	return t
}

func main() {
	now := time.Now()
	long := now.AddDate(100, 0, 0)
	local := []string{"localhost", "127.0.0.1"}
	selfSigned := func(name string, nb, na time.Time) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		must(err)
		t := template(name, local, nb, na, false)
		der, err := x509.CreateCertificate(rand.Reader, t, t, &key.PublicKey, key)
		must(err)
		write(name, der, key)
	}
	selfSigned("a", now.AddDate(-1, 0, 0), long)
	selfSigned("b", now.AddDate(-1, 0, 0), long)
	selfSigned("expired", time.Date(2019, 1, 1, 0, 0, 0, 0, time.UTC), time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC))

	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(err)
	caT := template("AI Whiteboard test CA", nil, now.AddDate(-1, 0, 0), long, true)
	caDER, err := x509.CreateCertificate(rand.Reader, caT, caT, &caKey.PublicKey, caKey)
	must(err)
	write("ca", caDER, nil)
	ca, err := x509.ParseCertificate(caDER)
	must(err)
	signed := func(name string, names []string) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		must(err)
		t := template(name, names, now.AddDate(-1, 0, 0), long, false)
		der, err := x509.CreateCertificate(rand.Reader, t, ca, &key.PublicKey, caKey)
		must(err)
		write(name, der, key)
	}
	signed("leaf", local)
	signed("othername", []string{"other.example"})
}
