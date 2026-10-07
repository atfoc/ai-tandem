package servers

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"math/big"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/servers/standin"
)

const testLimit = 2 * time.Second

// hostPort splits a stand-in's "https://127.0.0.1:<port>".
func hostPort(t *testing.T, url string) (host, port string) {
	t.Helper()
	_, host, port, err := ParseAddress(url)
	if err != nil {
		t.Fatalf("ParseAddress(%q): %v", url, err)
	}
	return host, port
}

// problemOf dials and returns the *Problem, or nil when the connection was made.
func problemOf(t *testing.T, d DialFunc, url string, tr Trust, limit time.Duration) *Problem {
	t.Helper()
	host, port := hostPort(t, url)
	conn, err := dialTLS(context.Background(), d, host, port, tr, limit, limit)
	if err == nil {
		_ = conn.Close()
		return nil
	}
	var p *Problem
	if !errors.As(err, &p) {
		t.Fatalf("dialTLS's error is %T (%v), not a *Problem", err, err)
	}
	return p
}

// failDial is a DialFunc that fails with err and counts its calls.
func failDial(err error, calls *int) DialFunc {
	return func(context.Context, string, string) (net.Conn, error) {
		if calls != nil {
			*calls++
		}
		return nil, err
	}
}

// blockDial is a DialFunc that waits for its context's end.
func blockDial(ctx context.Context, _, _ string) (net.Conn, error) {
	<-ctx.Done()
	return nil, &net.OpError{Op: "dial", Net: "tcp4", Err: ctx.Err()}
}

// tlsListener serves handshakes with cfg on loopback and answers nothing. It returns the address.
func tlsListener(t *testing.T, cfg *tls.Config) string {
	t.Helper()
	ln, err := tls.Listen("tcp4", "127.0.0.1:0", cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				_ = c.SetDeadline(time.Now().Add(testLimit))
				_ = c.(*tls.Conn).Handshake()
			}()
		}
	}()
	return "https://" + ln.Addr().String()
}

// issuedPair is a leaf for 127.0.0.1 signed by a CA made here: a certificate that is neither
// self-signed nor trusted.
func issuedPair(t *testing.T) tls.Certificate {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "test leaf"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
		KeyUsage:    x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, leaf, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// TestDialClassifies is the error table of dialTLS, each row from a real dial or handshake on
// loopback but the two that need another network: those come through an injected DialFunc.
func TestDialClassifies(t *testing.T) {
	good := standin.Start(t, standin.Options{})
	other := standin.Start(t, standin.Options{})
	named := standin.Start(t, standin.Options{Names: []string{"elsewhere.example"}})
	expired := standin.Start(t, standin.Options{NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour)})
	issued := tlsListener(t, &tls.Config{Certificates: []tls.Certificate{issuedPair(t)}})
	oldTLS := tlsListener(t, &tls.Config{
		Certificates: []tls.Certificate{issuedPair(t)}, MinVersion: tls.VersionTLS10, MaxVersion: tls.VersionTLS11,
	})

	cases := []struct {
		name  string
		dial  DialFunc
		url   string
		trust Trust
		limit time.Duration
		want  Outcome
	}{
		{"name not found", failDial(&net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}}, nil),
			good.URL(), Trust{}, testLimit, OutcomeNameNotFound},
		{"a DNS error that is not 'not found'", failDial(&net.DNSError{Err: "server misbehaving", Name: "x"}, nil),
			good.URL(), Trust{}, testLimit, OutcomeNoRoute},
		{"refused", nil, standin.Refused(t), Trust{}, testLimit, OutcomeRefused},
		{"no route", failDial(&net.OpError{Op: "dial", Net: "tcp4", Err: syscall.EHOSTUNREACH}, nil),
			good.URL(), Trust{}, testLimit, OutcomeNoRoute},
		{"the dial limit", blockDial, good.URL(), Trust{}, 200 * time.Millisecond, OutcomeNoRoute},
		{"the handshake limit", nil, standin.Silent(t), Trust{}, 200 * time.Millisecond, OutcomeTLSTimeout},
		{"plain HTTP", nil, standin.PlainHTTP(t), Trust{}, testLimit, OutcomeNotHTTPS},
		{"another certificate than the pinned", nil, good.URL(), Trust{SelfSigned: true, Pin: other.Fingerprint()}, testLimit, OutcomeCertChanged},
		{"a pin that is no fingerprint", nil, good.URL(), Trust{SelfSigned: true, Pin: "AB:CD"}, testLimit, OutcomeCertChanged},
		{"another name", nil, named.URL(), Trust{Roots: named.Pool()}, testLimit, OutcomeCertName},
		{"expired", nil, expired.URL(), Trust{Roots: expired.Pool()}, testLimit, OutcomeCertExpired},
		{"self-signed, the system's roots", nil, good.URL(), Trust{}, testLimit, OutcomeSelfSigned},
		{"self-signed, other roots", nil, good.URL(), Trust{Roots: other.Pool()}, testLimit, OutcomeSelfSigned},
		{"issued by an unknown CA", nil, issued, Trust{Roots: x509.NewCertPool()}, testLimit, OutcomeCertUntrusted},
		{"no common TLS version", nil, oldTLS, Trust{Roots: x509.NewCertPool()}, testLimit, OutcomeTLSError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := problemOf(t, c.dial, c.url, c.trust, c.limit)
			if p == nil {
				t.Fatalf("connected; want %s", c.want)
			}
			if p.Outcome != c.want {
				t.Fatalf("outcome %s (%s); want %s", p.Outcome, p.Detail, c.want)
			}
			if c.want == OutcomeCertChanged {
				if p.Fingerprint != good.Fingerprint() || p.Pinned != c.trust.Pin {
					t.Errorf("fingerprints %q, %q; want %q, %q", p.Fingerprint, p.Pinned, good.Fingerprint(), c.trust.Pin)
				}
			} else if p.Detail == "" || p.Fingerprint != "" || p.Pinned != "" {
				t.Errorf("problem %+v; want Go's text in Detail and no fingerprint", *p)
			}
			if !strings.Contains(p.Error(), c.want.Message()) {
				t.Errorf("Error() = %q; want the outcome's message in it", p.Error())
			}
		})
	}
	if n := len(good.Requests()) + len(named.Requests()) + len(expired.Requests()); n != 0 {
		t.Errorf("%d requests reached the stand-ins; want none", n)
	}
}

// TestDialOrder checks the order of the table where one error fits two rows.
func TestDialOrder(t *testing.T) {
	timeout := &net.OpError{Op: "read", Err: syscall.ETIMEDOUT}
	cases := []struct {
		err  error
		want Outcome
	}{
		{fmt.Errorf("x: %w", context.DeadlineExceeded), OutcomeTLSTimeout},
		{timeout, OutcomeTLSTimeout},
		{tls.RecordHeaderError{Msg: "first record does not look like a TLS handshake"}, OutcomeNotHTTPS},
		{fmt.Errorf("x: %w", &pinError{presented: "A", pinned: "B"}), OutcomeCertChanged},
		{&tls.CertificateVerificationError{Err: x509.HostnameError{Certificate: &x509.Certificate{}, Host: "h"}}, OutcomeCertName},
		{&tls.CertificateVerificationError{Err: x509.CertificateInvalidError{Reason: x509.Expired}}, OutcomeCertExpired},
		{&tls.CertificateVerificationError{Err: x509.CertificateInvalidError{Reason: x509.NotAuthorizedToSign}}, OutcomeCertUntrusted},
		{&tls.CertificateVerificationError{Err: x509.UnknownAuthorityError{}}, OutcomeCertUntrusted}, // no leaf to look at
		{x509.UnknownAuthorityError{}, OutcomeCertUntrusted},
		{errors.New("remote error: tls: handshake failure"), OutcomeTLSError},
		{context.Canceled, OutcomeTLSError},
	}
	for _, c := range cases {
		if p := tlsProblem(c.err); p.Outcome != c.want {
			t.Errorf("tlsProblem(%T %v) = %s; want %s", c.err, c.err, p.Outcome, c.want)
		}
	}
	// A refused connection under a DNS error's wrapper is still told by the first row that fits.
	both := &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", IsNotFound: true, UnwrapErr: syscall.ECONNREFUSED}}
	if p := dialProblem(both); p.Outcome != OutcomeNameNotFound {
		t.Errorf("dialProblem = %s; want %s", p.Outcome, OutcomeNameNotFound)
	}
}

// TestDialNoPinDialsNothing: the box on without a pin is refused before any dial.
func TestDialNoPinDialsNothing(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	calls := 0
	p := problemOf(t, failDial(errors.New("dialed"), &calls), s.URL(), Trust{SelfSigned: true}, testLimit)
	if p == nil || p.Outcome != OutcomeFingerprint {
		t.Fatalf("problem %+v; want %s", p, OutcomeFingerprint)
	}
	if calls != 0 || s.Handshakes() != 0 {
		t.Errorf("%d dials, %d handshakes; want none", calls, s.Handshakes())
	}
}

// TestDialTrust: what connects. Under a pin names and dates are not checked; without the box
// they are, against Roots.
func TestDialTrust(t *testing.T) {
	good := standin.Start(t, standin.Options{})
	odd := standin.Start(t, standin.Options{
		Names: []string{"elsewhere.example"}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour),
	})
	lower := strings.ToLower(strings.ReplaceAll(good.Fingerprint(), ":", ""))
	for name, c := range map[string]struct {
		url   string
		trust Trust
	}{
		"pinned":                       {good.URL(), Trust{SelfSigned: true, Pin: good.Fingerprint()}},
		"pinned, the pin in lower hex": {good.URL(), Trust{SelfSigned: true, Pin: lower}},
		"pinned, expired, other name":  {odd.URL(), Trust{SelfSigned: true, Pin: odd.Fingerprint()}},
		"its own root":                 {good.URL(), Trust{Roots: good.Pool()}},
	} {
		if p := problemOf(t, nil, c.url, c.trust, testLimit); p != nil {
			t.Errorf("%s: %v; want a connection", name, p)
		}
	}
	// Roots play no part with the box on: the pin alone decides.
	if p := problemOf(t, nil, good.URL(), Trust{SelfSigned: true, Pin: odd.Fingerprint(), Roots: good.Pool()}, testLimit); p == nil || p.Outcome != OutcomeCertChanged {
		t.Errorf("another pin with the certificate as a root: %+v; want %s", p, OutcomeCertChanged)
	}

	host, port := hostPort(t, good.URL())
	conn, err := dialTLS(context.Background(), nil, host, port, Trust{SelfSigned: true, Pin: good.Fingerprint()}, testLimit, testLimit)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if cs := conn.ConnectionState(); cs.NegotiatedProtocol != "h2" || cs.Version < tls.VersionTLS12 {
		t.Errorf("protocol %q, version %x; want h2 and TLS 1.2 or later", cs.NegotiatedProtocol, cs.Version)
	}
}

// TestRealCertificateBoxOff: the certificate a real server presents, as set-up makes it, without
// the box. The verifier of macOS names it "not standards compliant" and no unknown authority;
// the answer is self_signed all the same, at the dial and in a test. Its name and its dates keep
// their own answers where the verifier names them.
func TestRealCertificateBoxOff(t *testing.T) {
	listener := func(names []string, notBefore, notAfter time.Time) string {
		certPEM, keyPEM, err := remote.GenerateCert(names, notBefore, notAfter)
		if err != nil {
			t.Fatal(err)
		}
		pair, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			t.Fatal(err)
		}
		return tlsListener(t, &tls.Config{Certificates: []tls.Certificate{pair}})
	}
	now := time.Now()
	real := listener([]string{"127.0.0.1"}, now.Add(-time.Hour), now.AddDate(10, 0, 0))
	p := problemOf(t, nil, real, Trust{}, testLimit)
	if p == nil || p.Outcome != OutcomeSelfSigned || p.Detail == "" {
		t.Fatalf("problem %+v; want %s with Go's text", p, OutcomeSelfSigned)
	}
	t.Logf("the verifier here says: %s", p.Detail)
	r := TestConnection(context.Background(), Target{Address: real, Secret: "s3cret"}, Identity{}, Options{Timing: Timing{TestStep: testLimit}})
	if r.OK || r.Outcome != OutcomeSelfSigned || r.Step != 3 || r.Message != "Self-signed certificate: tick the box" {
		t.Errorf("result %+v; want self_signed at step 3", r)
	}

	// With the system's roots the reason is the verifier's own: where it names the name or the
	// dates, that is the answer; where it does not, the certificate is self-signed.
	for name, c := range map[string]struct {
		url  string
		want Outcome
	}{
		"another name": {listener([]string{"elsewhere.example"}, now.Add(-time.Hour), now.AddDate(10, 0, 0)), OutcomeCertName},
		"expired":      {listener([]string{"127.0.0.1"}, now.AddDate(-10, 0, 0), now.Add(-time.Hour)), OutcomeCertExpired},
	} {
		p := problemOf(t, nil, c.url, Trust{}, testLimit)
		if p == nil || (p.Outcome != c.want && p.Outcome != OutcomeSelfSigned) {
			t.Errorf("%s: %+v; want %s or %s", name, p, c.want, OutcomeSelfSigned)
			continue
		}
		t.Logf("%s: %s (%s)", name, p.Outcome, p.Detail)
	}
}

// TestPinCheckedAtEveryHandshake: a certificate swapped on the same port is refused by the next
// connection of the same transport.
func TestPinCheckedAtEveryHandshake(t *testing.T) {
	s := standin.Start(t, standin.Options{})
	pin := s.Fingerprint()
	tr := newTransport(nil, Trust{SelfSigned: true, Pin: pin}, DefaultTiming)
	defer tr.CloseIdleConnections()
	addr := strings.TrimPrefix(s.URL(), "https://")
	for i := 0; i < 2; i++ {
		conn, err := tr.DialTLSContext(context.Background(), "tcp", addr)
		if err != nil {
			t.Fatalf("connection %d: %v", i, err)
		}
		_ = conn.Close()
	}
	s.SwapCert([]string{"127.0.0.1"}, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	_, err := tr.DialTLSContext(context.Background(), "tcp", addr)
	var p *Problem
	if !errors.As(err, &p) || p.Outcome != OutcomeCertChanged || p.Fingerprint != s.Fingerprint() || p.Pinned != pin {
		t.Fatalf("after the swap: %v; want %s with both fingerprints", err, OutcomeCertChanged)
	}
	if len(s.Requests()) != 0 {
		t.Errorf("requests %v; want none", s.Requests())
	}
}

// TestReadCertificate: the fingerprint is read without a request, whatever the certificate.
func TestReadCertificate(t *testing.T) {
	s := standin.Start(t, standin.Options{
		Names: []string{"elsewhere.example"}, NotBefore: time.Now().Add(-2 * time.Hour), NotAfter: time.Now().Add(-time.Hour),
	})
	host, port := hostPort(t, s.URL())
	fp, err := readCertificate(context.Background(), nil, host, port, testLimit, testLimit)
	if err != nil || fp != s.Fingerprint() {
		t.Fatalf("readCertificate = %q, %v; want %q", fp, err, s.Fingerprint())
	}
	if s.Handshakes() != 1 || len(s.Requests()) != 0 {
		t.Errorf("%d handshakes, requests %v; want 1 and none", s.Handshakes(), s.Requests())
	}
	host, port = hostPort(t, standin.Refused(t))
	_, err = readCertificate(context.Background(), nil, host, port, testLimit, testLimit)
	var p *Problem
	if !errors.As(err, &p) || p.Outcome != OutcomeRefused {
		t.Errorf("a refused port: %v; want %s", err, OutcomeRefused)
	}
}
