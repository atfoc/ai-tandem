package remote

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"time"

	"ai-whiteboard/internal/store"
)

// SetupOptions are what `remote setup` was asked for.
type SetupOptions struct {
	Port    int      // 0: keep, or DefaultPort at the first set-up
	Names   []string // added to the list
	NewCert bool
}

// Made says what a set-up wrote.
type Made struct{ Secret, Pair, Config bool }

// Setup makes what is missing and replaces nothing but, with NewCert, key and certificate. An
// unreadable or invalid configuration counts as none and is written anew. The configuration is
// written last, so an interrupted first set-up leaves a server that starts as before. NewCert
// without a valid configuration returns ErrNotSetUp and writes nothing.
func Setup(root string, o SetupOptions) (Made, error) {
	var made Made
	f := FilesIn(root)
	if o.Port < 0 || o.Port > 65535 {
		return made, fmt.Errorf("port %d is not between 1 and 65535", o.Port)
	}
	var add []string
	for _, n := range o.Names {
		nn, ok := NormalName(n)
		if !ok {
			return made, fmt.Errorf("bad name %q", n)
		}
		add = append(add, nn)
	}
	old, found, err := LoadConfig(root)
	had := found && err == nil
	if o.NewCert && !had {
		return made, ErrNotSetUp
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return made, err
	}

	c := Config{Port: old.Port, Names: slices.Clone(old.Names)}
	if !had {
		c = Config{Port: DefaultPort, Names: LocalNames()}
	}
	if o.Port != 0 {
		c.Port = o.Port
	}
	for _, n := range add {
		c.Names = addName(c.Names, n)
	}
	if err := c.Validate(); err != nil {
		return made, err
	}

	if !exists(f.Secret) {
		if _, err := writeSecret(f.Secret); err != nil {
			return made, err
		}
		made.Secret = true
	}
	if o.NewCert || !exists(f.Key) && !exists(f.Cert) {
		now := time.Now()
		certPEM, keyPEM, err := GenerateCert(c.Names, now.Add(-time.Hour), now.AddDate(10, 0, 0))
		if err != nil {
			return made, err
		}
		if err := store.WriteFileAtomic(f.Key, keyPEM, 0o600); err != nil {
			return made, err
		}
		if err := store.WriteFileAtomic(f.Cert, certPEM, 0o644); err != nil {
			return made, err
		}
		made.Pair = true
	}
	if !had || c.Port != old.Port || !slices.Equal(c.Names, old.Names) {
		if err := store.WriteJSONAtomic(f.Config, c, 0o600); err != nil {
			return made, err
		}
		made.Config = true
	}
	return made, nil
}

// Off removes the configuration only: a set-up after it gives the same secret and fingerprint.
// was says whether there was one.
func Off(root string) (was bool, err error) {
	err = os.Remove(FilesIn(root).Config)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// exists reports whether there is anything at path, readable or not.
func exists(path string) bool {
	_, err := os.Lstat(path)
	return !errors.Is(err, fs.ErrNotExist)
}
