package remote

import (
	"crypto/ecdsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestGenerateCert(t *testing.T) {
	from := time.Now().Add(-time.Hour).Truncate(time.Second)
	to := from.AddDate(10, 0, 0)
	certPEM, keyPEM, err := GenerateCert([]string{"mac.local", "192.168.1.20", "wb.example"}, from, to)
	if err != nil {
		t.Fatal(err)
	}
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if k, ok := pair.PrivateKey.(*ecdsa.PrivateKey); !ok || k.Curve.Params().Name != "P-256" {
		t.Errorf("key is %T", pair.PrivateKey)
	}
	if !strings.HasPrefix(string(keyPEM), "-----BEGIN PRIVATE KEY-----") {
		t.Errorf("key is not PKCS #8: %.30s", keyPEM)
	}
	c, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	var ips []string
	for _, ip := range c.IPAddresses {
		ips = append(ips, ip.String())
	}
	if !reflect.DeepEqual(c.DNSNames, []string{"mac.local", "wb.example"}) || !reflect.DeepEqual(ips, []string{"192.168.1.20"}) {
		t.Errorf("names %v %v", c.DNSNames, ips)
	}
	if c.Subject.CommonName != "AI Whiteboard" || c.IsCA || !c.NotBefore.Equal(from) || !c.NotAfter.Equal(to) ||
		c.KeyUsage != x509.KeyUsageDigitalSignature || !reflect.DeepEqual(c.ExtKeyUsage, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}) ||
		c.SerialNumber.Sign() < 0 || c.SerialNumber.BitLen() > 127 {
		t.Errorf("certificate: CN %q CA %v %v to %v usage %v %v serial %v",
			c.Subject.CommonName, c.IsCA, c.NotBefore, c.NotAfter, c.KeyUsage, c.ExtKeyUsage, c.SerialNumber)
	}
	pool := x509.NewCertPool()
	pool.AddCert(c)
	for _, name := range []string{"mac.local", "192.168.1.20"} {
		if _, err := c.Verify(x509.VerifyOptions{DNSName: name, Roots: pool}); err != nil {
			t.Errorf("verify for %s: %v", name, err)
		}
	}
	other, _, _ := GenerateCert([]string{"mac.local"}, from, to)
	if fp1, _ := FingerprintOfPEM(certPEM); len(fp1) != 95 || fp1 != Fingerprint(c.Raw) {
		t.Errorf("fingerprint %q", fp1)
	} else if fp2, _ := FingerprintOfPEM(other); fp1 == fp2 {
		t.Error("two certificates, one fingerprint")
	}
	if _, err := FingerprintOfPEM(keyPEM); err == nil {
		t.Error("FingerprintOfPEM took a key")
	}
}

func TestFingerprintIsOpenssls(t *testing.T) {
	openssl, err := exec.LookPath("openssl")
	if err != nil {
		t.Skip("no openssl on PATH")
	}
	now := time.Now()
	certPEM, _, err := GenerateCert([]string{"mac.local", "192.168.1.20"}, now.Add(-time.Hour), now.AddDate(10, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "cert.pem")
	if err := os.WriteFile(path, certPEM, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(openssl, "x509", "-noout", "-fingerprint", "-sha256", "-in", path).Output()
	if err != nil {
		t.Fatalf("openssl: %v", err)
	}
	// "SHA256 Fingerprint=AB:…" from LibreSSL, "sha256 Fingerprint=AB:…" from OpenSSL 3: the label is not compared.
	_, theirs, ok := strings.Cut(strings.TrimSpace(string(out)), "=")
	if !ok {
		t.Fatalf("openssl printed %q", out)
	}
	ours, err := FingerprintOfPEM(certPEM)
	if err != nil {
		t.Fatal(err)
	}
	if ours != theirs {
		t.Errorf("ours   %s\nopenssl %s", ours, theirs)
	}
}

func TestParseFingerprint(t *testing.T) {
	now := time.Now()
	certPEM, _, err := GenerateCert([]string{"a"}, now, now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	fp, _ := FingerprintOfPEM(certPEM)
	want, err := ParseFingerprint(fp)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ToUpper(hex.EncodeToString(want[:])) != strings.ReplaceAll(fp, ":", "") {
		t.Errorf("parsed %x from %s", want, fp)
	}
	for _, s := range []string{strings.ToLower(fp), strings.ReplaceAll(fp, ":", ""), strings.ToLower(strings.ReplaceAll(fp, ":", "")), " " + fp + "\n"} {
		if got, err := ParseFingerprint(s); err != nil || got != want {
			t.Errorf("ParseFingerprint(%q) = %x, %v", s, got, err)
		}
	}
	for _, s := range []string{"", "AB:CD", fp[:len(fp)-3], fp + ":00", strings.Replace(fp, fp[:2], "ZZ", 1)} {
		if _, err := ParseFingerprint(s); err == nil {
			t.Errorf("ParseFingerprint(%q) gave no error", s)
		}
	}
}
