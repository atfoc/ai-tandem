package servers

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"syscall"
	"time"

	"ai-whiteboard/internal/remote"
)

// Trust is how a server's certificate is accepted. SelfSigned is the "self-signed certificate"
// box: the certificate must be the one with the fingerprint Pin, and its names and dates are not
// checked. Without the box it is verified against Roots and the address's name.
type Trust struct {
	SelfSigned bool
	Pin        string
	Roots      *x509.CertPool // nil = the system's; set by tests
}

// DialFunc makes the TCP connection. nil means net.Dialer; tests set it.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Problem is why no connection was made: the outcome, Go's text in Detail and, for the outcomes
// fingerprint and cert_changed, the presented certificate's fingerprint and the pinned one.
// dialTLS and readCertificate return it as a *Problem.
type Problem struct {
	Outcome             Outcome
	Detail              string
	Fingerprint, Pinned string
}

func (p *Problem) Error() string {
	s := string(p.Outcome)
	if m := p.Outcome.Message(); m != "" {
		s = m
	}
	if p.Detail != "" {
		s += ": " + p.Detail
	}
	return s
}

// pinError is VerifyConnection's refusal of a certificate other than the pinned one.
type pinError struct{ presented, pinned string }

func (e *pinError) Error() string {
	return "certificate " + e.presented + " is not the pinned " + e.pinned
}

// dialTLS connects to host:port and returns after a handshake that accepted the certificate
// under t. It is the only place TLS is decided: nothing is written to a server before it
// returns without error. Every error is a *Problem.
//
// Box on: the SHA-256 of the presented leaf must be the pin. VerifyConnection runs at every
// handshake, resumed ones too. With an empty pin nothing is dialed. Box off: Go's verification
// against t.Roots.
func dialTLS(ctx context.Context, d DialFunc, host, port string, t Trust, dialLimit, tlsLimit time.Duration) (*tls.Conn, error) {
	cfg := &tls.Config{
		ServerName: host,
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"},
	}
	if t.SelfSigned {
		if t.Pin == "" {
			return nil, &Problem{Outcome: OutcomeFingerprint}
		}
		pin, pinErr := remote.ParseFingerprint(t.Pin) // a pin that is no fingerprint fits no certificate
		pinned := t.Pin
		if pinErr == nil {
			pinned = fingerprintOf(pin)
		}
		cfg.InsecureSkipVerify = true // names and dates are not checked under a pin
		cfg.VerifyConnection = func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("the server presented no certificate")
			}
			der := cs.PeerCertificates[0].Raw
			if pinErr != nil || sha256.Sum256(der) != pin {
				return &pinError{presented: remote.Fingerprint(der), pinned: pinned}
			}
			return nil
		}
	} else {
		cfg.RootCAs = t.Roots
	}
	return handshake(ctx, d, host, port, cfg, dialLimit, tlsLimit)
}

// readCertificate is the handshake that reads the certificate and sends no request: it accepts
// any certificate, takes the leaf's fingerprint and closes. Every error is a *Problem.
func readCertificate(ctx context.Context, d DialFunc, host, port string, dialLimit, tlsLimit time.Duration) (fingerprint string, err error) {
	conn, err := handshake(ctx, d, host, port, &tls.Config{
		ServerName:         host,
		MinVersion:         tls.VersionTLS12,
		NextProtos:         []string{"h2", "http/1.1"},
		InsecureSkipVerify: true, // nothing is sent on this connection
	}, dialLimit, tlsLimit)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return "", &Problem{Outcome: OutcomeTLSError, Detail: "the server presented no certificate"}
	}
	return remote.Fingerprint(certs[0].Raw), nil
}

// handshake dials tcp4 within dialLimit and handshakes with cfg within tlsLimit.
func handshake(ctx context.Context, d DialFunc, host, port string, cfg *tls.Config, dialLimit, tlsLimit time.Duration) (*tls.Conn, error) {
	if d == nil {
		d = (&net.Dialer{}).DialContext
	}
	dctx, cancel := context.WithTimeout(ctx, dialLimit)
	raw, err := d(dctx, "tcp4", net.JoinHostPort(host, port))
	cancel()
	if err != nil {
		return nil, dialProblem(err)
	}
	conn := tls.Client(raw, cfg)
	hctx, cancel := context.WithTimeout(ctx, tlsLimit)
	err = conn.HandshakeContext(hctx)
	cancel()
	if err != nil {
		_ = raw.Close()
		return nil, tlsProblem(err)
	}
	return conn, nil
}

// dialProblem names a failed dial: the first three rows of the error table.
func dialProblem(err error) *Problem {
	p := &Problem{Outcome: OutcomeNoRoute, Detail: clean(err.Error())}
	var dns *net.DNSError
	switch {
	case errors.As(err, &dns) && dns.IsNotFound:
		p.Outcome = OutcomeNameNotFound
	case errors.Is(err, syscall.ECONNREFUSED):
		p.Outcome = OutcomeRefused
	}
	return p
}

// tlsProblem names a failed handshake: the rest of the error table, in its order.
func tlsProblem(err error) *Problem {
	p := &Problem{Outcome: OutcomeTLSError, Detail: clean(err.Error())}
	var (
		netErr   net.Error
		record   tls.RecordHeaderError
		pin      *pinError
		name     x509.HostnameError
		invalid  x509.CertificateInvalidError
		unknown  x509.UnknownAuthorityError
		verify   *tls.CertificateVerificationError
		x509Sys  x509.SystemRootsError
		x509Cons x509.ConstraintViolationError
	)
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &netErr) && netErr.Timeout():
		p.Outcome = OutcomeTLSTimeout
	case errors.As(err, &record):
		p.Outcome = OutcomeNotHTTPS
	case errors.As(err, &pin):
		p.Outcome, p.Detail = OutcomeCertChanged, ""
		p.Fingerprint, p.Pinned = pin.presented, pin.pinned
	case errors.As(err, &name):
		p.Outcome = OutcomeCertName
	case errors.As(err, &invalid) && invalid.Reason == x509.Expired:
		p.Outcome = OutcomeCertExpired
	// Whatever reason the verifier names: the one of macOS says "not standards compliant" of a
	// server's own certificate, not "unknown authority". The leaf itself decides.
	case errors.As(err, &verify) &&
		len(verify.UnverifiedCertificates) > 0 && selfSigned(verify.UnverifiedCertificates[0]):
		p.Outcome = OutcomeSelfSigned
	case errors.As(err, &verify), errors.As(err, &unknown), errors.As(err, &invalid),
		errors.As(err, &x509Sys), errors.As(err, &x509Cons):
		p.Outcome = OutcomeCertUntrusted
	}
	return p
}

// selfSigned reports whether c is signed with its own key. CheckSignatureFrom does not fit: it
// refuses a certificate that is not a CA, and a server's own certificate is none.
func selfSigned(c *x509.Certificate) bool {
	return bytes.Equal(c.RawIssuer, c.RawSubject) &&
		c.CheckSignature(c.SignatureAlgorithm, c.RawTBSCertificate, c.Signature) == nil
}

// fingerprintOf writes a SHA-256 sum in remote.Fingerprint's form.
func fingerprintOf(sum [32]byte) string {
	const hexDigits = "0123456789ABCDEF"
	out := make([]byte, 0, 3*len(sum))
	for i, b := range sum {
		if i > 0 {
			out = append(out, ':')
		}
		out = append(out, hexDigits[b>>4], hexDigits[b&0x0f])
	}
	return string(out)
}

// newTransport is the http.Transport of this package: every connection of it is made by dialTLS
// under t, with HTTP/2 when the server offers it. It reads no proxy from the environment.
func newTransport(d DialFunc, t Trust, tm Timing) *http.Transport {
	return &http.Transport{
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, &Problem{Outcome: OutcomeNoRoute, Detail: clean(err.Error())}
			}
			conn, err := dialTLS(ctx, d, host, port, t, tm.Dial, tm.Handshake)
			if err != nil {
				return nil, err // not conn: a nil *tls.Conn in a net.Conn is not nil
			}
			return conn, nil
		},
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: tm.Headers,
		MaxIdleConns:          2,
		IdleConnTimeout:       30 * time.Second,
	}
}
