package remote

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"

	"ai-whiteboard/internal/store"
)

// ReadSecret's errors: no file, and a file that is unreadable, empty or not in set-up's form.
var (
	ErrNoSecret  = errors.New("no secret")
	ErrBadSecret = errors.New("bad secret")
)

// secretForm is set-up's form, after the trailing white space is trimmed.
var secretForm = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ReadSecret returns the secret of root. Its error wraps ErrNoSecret or ErrBadSecret.
func ReadSecret(root string) (string, error) {
	path := FilesIn(root).Secret
	s, why, err := readSecret(path)
	if err != nil {
		return "", fmt.Errorf("%w: the secret %s %s", err, path, why)
	}
	return s, nil
}

// readSecret reads the secret file; why ends the sentence "the secret <path> …".
func readSecret(path string) (s, why string, err error) {
	b, err := os.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", "is missing", ErrNoSecret
	case err != nil:
		return "", fmt.Sprintf("cannot be read: %v", cause(err)), ErrBadSecret
	}
	s = strings.TrimRight(string(b), " \t\r\n")
	switch {
	case s == "":
		return "", "is empty", ErrBadSecret
	case !secretForm.MatchString(s):
		return "", "is not 64 lowercase hex digits", ErrBadSecret
	}
	return s, "", nil
}

// writeSecret makes a secret (32 random bytes as hex) and writes it with mode 0600.
func writeSecret(path string) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	s := hex.EncodeToString(b)
	return s, store.WriteFileAtomic(path, []byte(s+"\n"), 0o600)
}

// NewSecret replaces the secret and returns the new one. Without a valid configuration it
// returns ErrNotSetUp and writes nothing.
func NewSecret(root string) (string, error) {
	if _, found, err := LoadConfig(root); !found || err != nil {
		return "", ErrNotSetUp
	}
	return writeSecret(FilesIn(root).Secret)
}
