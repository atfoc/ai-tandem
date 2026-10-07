// Package remote holds what remote access keeps in the data folder (the configuration, the secret,
// the key and certificate, the instance id), the set-up that makes them and the start's check.
// It never binds a port: the listener is in internal/server.
package remote

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPort is the remote port of a first set-up.
const DefaultPort = 4748

// The headers of an API client. internal/server has SecretHeader too; a test holds the two equal.
const (
	SecretHeader = "X-AIWB-Secret"
	ClientHeader = "X-AIWB-Client"
)

// ErrNotSetUp is returned by what needs a valid configuration and finds none.
var ErrNotSetUp = errors.New("remote access is not set up")

// Files are the paths of remote access in the data folder.
type Files struct{ Config, Secret, Key, Cert, InstanceID string }

// FilesIn returns the paths under root, the -home folder.
func FilesIn(root string) Files {
	return Files{
		Config:     filepath.Join(root, "remote.json"),
		Secret:     filepath.Join(root, "remote-secret"),
		Key:        filepath.Join(root, "remote-key.pem"),
		Cert:       filepath.Join(root, "remote-cert.pem"),
		InstanceID: filepath.Join(root, "instance-id"),
	}
}

// Config is remote.json. Its existence turns remote access on.
type Config struct {
	Port  int      `json:"port"`
	Names []string `json:"names"`
}

// LoadConfig reads remote.json. No file: found is false and err nil. An unreadable or invalid
// file: found is true and err says why. Valid names come back lower-cased.
func LoadConfig(root string) (c Config, found bool, err error) {
	path := FilesIn(root).Config
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Config{}, false, nil
	}
	if err != nil {
		return Config{}, true, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, true, fmt.Errorf("read %s: %w", path, err)
	}
	for i, n := range c.Names {
		if nn, ok := NormalName(n); ok {
			c.Names[i] = nn
		}
	}
	return c, true, c.Validate()
}

// Validate reports what is wrong with c: the port, an empty list, a name.
func (c Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("port %d is not between 1 and 65535", c.Port)
	}
	if len(c.Names) == 0 {
		return errors.New("no names")
	}
	for _, n := range c.Names {
		if _, ok := NormalName(n); !ok {
			return fmt.Errorf("bad name %q", n)
		}
	}
	return nil
}

// NormalName lower-cases s and reports whether it is a name: an IPv4 literal or a DNS name
// ([a-z0-9.-], at most 253 characters), with no port, scheme or ":".
func NormalName(s string) (string, bool) {
	s = strings.ToLower(s)
	if s == "" || len(s) > 253 || strings.Contains(s, "..") {
		return "", false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '.' || c == '-') {
			return "", false
		}
	}
	if first, last := s[0], s[len(s)-1]; first == '.' || first == '-' || last == '.' || last == '-' {
		return "", false
	}
	return s, true
}

// LocalNames are the names a first set-up starts with: os.Hostname, then every non-loopback IPv4
// of net.InterfaceAddrs. What is not a name is left out.
func LocalNames() []string {
	var names []string
	if h, err := os.Hostname(); err == nil {
		names = addName(names, h)
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLoopback() {
			continue
		}
		if ip4 := ipn.IP.To4(); ip4 != nil {
			names = addName(names, ip4.String())
		}
	}
	return names
}

// addName appends s, normalized, when it is a name and not yet in names.
func addName(names []string, s string) []string {
	n, ok := NormalName(s)
	if !ok {
		return names
	}
	for _, have := range names {
		if have == n {
			return names
		}
	}
	return append(names, n)
}

// cause is err without the path an *fs.PathError carries: the message's line names the path itself.
func cause(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
