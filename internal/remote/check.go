package remote

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sort"
	"strings"
	"time"
)

// ProblemKind is a row of the start's check that ends the start.
type ProblemKind int

const (
	BadConfig ProblemKind = iota + 1
	SecretMissing
	SecretBad
	PairMissing
	PairBad
	PortEqual
)

// Problem is one thing the check found that ends the start.
type Problem struct {
	Kind ProblemKind
	Line string // one line of the message, with the path or the port
}

// Report is what the start's check found.
type Report struct {
	Configured  bool // remote.json exists
	Config      Config
	Fatal       []Problem        // BadConfig alone, or secret, pair, port in this order
	Notes       []string         // certificate expired; its names differ from the list
	Fingerprint string           // of the certificate on disk, "" when it cannot be parsed
	Secret      string           // for the listener; never printed
	Pair        *tls.Certificate // loaded once; the listener serves this
}

// Check is the start's check: the files of root and the configured port against the server's own
// port and the MCP port. Without remote.json it opens no other file. It never writes and never binds.
func Check(root string, serverPort, mcpPort int) Report {
	f := FilesIn(root)
	c, found, err := LoadConfig(root)
	if !found {
		return Report{}
	}
	r := Report{Configured: true, Config: c}
	if err != nil {
		r.fatal(BadConfig, "the configuration %s is unreadable or not valid: %v", f.Config, cause(err))
		return r
	}

	secret, why, err := readSecret(f.Secret)
	switch {
	case errors.Is(err, ErrNoSecret):
		r.fatal(SecretMissing, "the secret %s %s", f.Secret, why)
	case err != nil:
		r.fatal(SecretBad, "the secret %s %s", f.Secret, why)
	default:
		r.Secret = secret
	}

	r.checkPair(f)

	switch c.Port {
	case serverPort:
		r.fatal(PortEqual, "the remote port %d is the server's own port", c.Port)
	case mcpPort:
		r.fatal(PortEqual, "the remote port %d is the MCP port", c.Port)
	}
	return r
}

func (r *Report) fatal(kind ProblemKind, format string, a ...any) {
	r.Fatal = append(r.Fatal, Problem{Kind: kind, Line: "Remote access: " + fmt.Sprintf(format, a...)})
}

// checkPair loads key and certificate as the listener will serve them, and reads the notes and
// the fingerprint off the certificate.
func (r *Report) checkPair(f Files) {
	certPEM, certErr := os.ReadFile(f.Cert)
	keyPEM, keyErr := os.ReadFile(f.Key)
	if certErr == nil {
		if leaf, err := firstCert(certPEM); err == nil {
			r.Fingerprint = Fingerprint(leaf.Raw)
			r.notes(f, leaf)
		}
	}
	certGone, keyGone := errors.Is(certErr, fs.ErrNotExist), errors.Is(keyErr, fs.ErrNotExist)
	switch {
	case certGone && keyGone:
		r.fatal(PairMissing, "the certificate %s and the key %s are missing", f.Cert, f.Key)
	case certGone:
		r.fatal(PairBad, "the certificate %s is missing", f.Cert)
	case keyGone:
		r.fatal(PairBad, "the key %s is missing", f.Key)
	case certErr != nil:
		r.fatal(PairBad, "the certificate %s cannot be read: %v", f.Cert, cause(certErr))
	case keyErr != nil:
		r.fatal(PairBad, "the key %s cannot be read: %v", f.Key, cause(keyErr))
	default:
		pair, err := tls.X509KeyPair(certPEM, keyPEM)
		if err == nil {
			r.Pair = &pair
			return
		}
		certOK := hasBlock(certPEM, func(t string) bool { return t == "CERTIFICATE" })
		keyOK := hasBlock(keyPEM, func(t string) bool { return strings.HasSuffix(t, "PRIVATE KEY") })
		switch {
		case !certOK && keyOK:
			r.fatal(PairBad, "the certificate %s is not right: %v", f.Cert, err)
		case certOK && !keyOK:
			r.fatal(PairBad, "the key %s is not right: %v", f.Key, err)
		default:
			r.fatal(PairBad, "the certificate %s and the key %s are not right: %v", f.Cert, f.Key, err)
		}
	}
}

// hasBlock reports whether b has a PEM block of a wanted type.
func hasBlock(b []byte, want func(typ string) bool) bool {
	for {
		var blk *pem.Block
		blk, b = pem.Decode(b)
		if blk == nil {
			return false
		}
		if want(blk.Type) {
			return true
		}
	}
}

// notes adds what the start goes on with: an expired certificate, names other than the list's.
func (r *Report) notes(f Files, leaf *x509.Certificate) {
	if time.Now().After(leaf.NotAfter) {
		r.Notes = append(r.Notes, fmt.Sprintf("the certificate %s expired on %s", f.Cert, leaf.NotAfter.Format("2006-01-02")))
	}
	var in []string
	for _, n := range leaf.DNSNames {
		in = append(in, strings.ToLower(n))
	}
	for _, ip := range leaf.IPAddresses {
		in = append(in, ip.String())
	}
	list := append([]string(nil), r.Config.Names...)
	sort.Strings(in)
	sort.Strings(list)
	if strings.Join(in, "\n") != strings.Join(list, "\n") {
		r.Notes = append(r.Notes, fmt.Sprintf("the certificate's names (%s) differ from the list (%s)",
			strings.Join(in, ", "), strings.Join(list, ", ")))
	}
}

// OK reports whether the start may go on: not configured, or nothing fatal.
func (r Report) OK() bool { return len(r.Fatal) == 0 }

// Message is what a start that ends says, "" when OK. At most six lines: one per problem, "The
// start creates nothing.", the first problem's repair and the way to start without remote access.
// exe is the binary's full path; home is the -home folder, "" for the default one.
func (r Report) Message(exe, home string) string {
	if r.OK() {
		return ""
	}
	var lines []string
	for _, p := range r.Fatal {
		lines = append(lines, p.Line)
	}
	var repair string
	switch r.Fatal[0].Kind {
	case SecretBad:
		repair = command(exe, home, "secret -new")
	case PairBad:
		repair = command(exe, home, "remote setup -new-cert") + " (or put your own certificate and key right)"
	case PortEqual:
		repair = command(exe, home, "remote setup -port N")
	default:
		repair = command(exe, home, "remote setup")
	}
	return strings.Join(append(lines, messageTail(exe, home, repair)...), "\n")
}

// BindMessage is the message of the row the check cannot see: the remote port cannot be bound.
func BindMessage(exe, home string, port int, err error) string {
	lines := []string{fmt.Sprintf("Remote access: the remote port %d cannot be bound: %v", port, err)}
	repair := fmt.Sprintf("free port %d, or %s", port, command(exe, home, "remote setup -port N"))
	return strings.Join(append(lines, messageTail(exe, home, repair)...), "\n")
}

func messageTail(exe, home, repair string) []string {
	return []string{
		"The start creates nothing.",
		"To repair: " + repair,
		"To start without remote access: " + command(exe, home, "remote off"),
	}
}

// command is a command line for the message: the binary's path, the words, and the data folder
// when it is not the default one.
func command(exe, home, words string) string {
	s := fmt.Sprintf("%q %s", exe, words)
	if home != "" {
		s += fmt.Sprintf(" -home %q", home)
	}
	return s
}
