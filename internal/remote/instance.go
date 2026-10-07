package remote

import (
	"crypto/rand"
	"fmt"
	"os"
	"regexp"
	"strings"

	"ai-whiteboard/internal/store"
)

var idForm = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// ValidID reports whether s is a lowercase version 4 UUID.
func ValidID(s string) bool { return idForm.MatchString(s) }

// EnsureInstanceID returns the instance id of root. It makes one when the file is missing or
// malformed, and keeps it from then on.
func EnsureInstanceID(root string) (string, error) {
	path := FilesIn(root).InstanceID
	if b, err := os.ReadFile(path); err == nil {
		if id := strings.TrimRight(string(b), " \t\r\n"); ValidID(id) {
			return id, nil
		}
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	id := fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
	return id, store.WriteFileAtomic(path, []byte(id+"\n"), 0o600)
}
