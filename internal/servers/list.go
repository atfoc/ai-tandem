// Package servers holds the list of remote servers this server connects to.
package servers

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remote"
	"ai-whiteboard/internal/store"
)

// The local entry is never in the file: it is the first of every list, under LocalID and
// LocalName. FileName is the list's file in the data folder.
const (
	LocalID   = model.LocalServer
	LocalName = "This computer"
	FileName  = "servers.json"
)

const (
	fileVersion = 1 // of servers.json; a file of a later one is not read

	maxName   = 80  // characters
	maxSecret = 256 // printable ASCII characters
)

var (
	ErrLocalEntry = errors.New("this computer is not an entry of the server list")
	ErrNotFound   = errors.New("no such server")
	ErrBadName    = errors.New("the name must have 1 to 80 characters")
	ErrBadAddress = errors.New("not a valid https address: https://host:port")
	ErrBadSecret  = errors.New("the secret must have 1 to 256 characters and no spaces")
	ErrBadPin     = errors.New("not a SHA-256 fingerprint")
)

// DuplicateError refuses a second entry with the address of the entry called Name.
type DuplicateError struct{ Name string }

func (e *DuplicateError) Error() string { return "already added as " + e.Name }

// Entry is one remote server. Secret is as typed and in clear: it goes to the file and to that
// server only.
type Entry struct {
	ID         string `json:"id"`      // "s_" and 12 hex digits; made by Add, never changed
	Name       string `json:"name"`    // 1 to 80 characters
	Address    string `json:"address"` // "https://host:port", lower case
	Secret     string `json:"secret"`
	SelfSigned bool   `json:"selfSigned"`
	Pin        string `json:"pin"`        // "" or remote.Fingerprint's form; "" when SelfSigned is false
	InstanceID string `json:"instanceId"` // "" until the first hello that passes
}

type listFile struct {
	Version int     `json:"version"`
	Servers []Entry `json:"servers"`
}

var entryID = regexp.MustCompile(`^s_[0-9a-f]{12}$`)

// now is replaced by tests.
var now = time.Now

// List holds servers.json in memory and writes it back after every change.
type List struct {
	path string

	mu      sync.Mutex
	entries []Entry
	notice  string
	stuck   error // the file could not be set aside: every write returns this
}

// OpenList reads <root>/servers.json. A missing or empty file gives a list without entries, and
// nothing is written. A file that cannot be read is set aside (renamed beside itself, never
// deleted) and the list starts without entries; Notice says so. It never dials.
func OpenList(root string) (*List, error) {
	if root == "" {
		return nil, errors.New("server list: no data folder")
	}
	l := &List{path: filepath.Join(root, FileName)}
	b, err := os.ReadFile(l.path)
	if errors.Is(err, fs.ErrNotExist) {
		return l, nil
	}
	if err == nil {
		if len(bytes.TrimSpace(b)) == 0 {
			return l, nil
		}
		if l.entries, err = parseList(b); err == nil {
			return l, nil
		}
	}
	l.entries = nil
	l.setAside(cause(err))
	return l, nil
}

// parseList reads the file's bytes. Unknown fields are ignored; a version after this build's and
// any invalid entry are errors: an entry has to pass the checks a new one passes.
func parseList(b []byte) ([]Entry, error) {
	var raw struct {
		Version int             `json:"version"`
		Servers json.RawMessage `json:"servers"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, err
	}
	if raw.Version > fileVersion {
		return nil, fmt.Errorf("version %d is after this build's %d", raw.Version, fileVersion)
	}
	if len(raw.Servers) == 0 || string(raw.Servers) == "null" {
		return nil, nil
	}
	var entries []Entry
	if err := json.Unmarshal(raw.Servers, &entries); err != nil {
		return nil, fmt.Errorf("servers: %w", err)
	}
	seen := map[string]bool{}
	for i := range entries {
		e := &entries[i]
		if !entryID.MatchString(e.ID) {
			return nil, fmt.Errorf("entry %d: bad id %q", i+1, e.ID)
		}
		if seen[e.ID] {
			return nil, fmt.Errorf("entry %d: duplicate id %q", i+1, e.ID)
		}
		seen[e.ID] = true
		switch address := e.Address; checkFields(e) {
		case nil:
		case ErrBadName:
			return nil, fmt.Errorf("entry %d: bad name", i+1)
		case ErrBadSecret:
			return nil, fmt.Errorf("entry %d: bad secret", i+1) // the secret itself is not written out
		case ErrBadPin:
			return nil, fmt.Errorf("entry %d: bad pin", i+1)
		default:
			return nil, fmt.Errorf("entry %d: bad address %q", i+1, address)
		}
	}
	return entries, nil
}

// setAside renames the unreadable file to servers.json.unreadable-<UTC time>, logs one line and
// keeps it as the notice. When the rename fails the list works in memory and no write goes through.
func (l *List) setAside(why error) {
	name, err := l.rename()
	if err != nil {
		l.stuck = fmt.Errorf("server list: %s cannot be read and could not be set aside: %w", l.path, cause(err))
		l.notice = fmt.Sprintf("server list: %s cannot be read (%v); it could not be set aside (%v); starting with this computer only", l.path, why, cause(err))
	} else {
		l.notice = fmt.Sprintf("server list: %s cannot be read (%v); set aside as %s; starting with this computer only", l.path, why, name)
	}
	log.Print(l.notice)
}

// rename moves the file to the first free set-aside name and returns that name (no folder).
func (l *List) rename() (string, error) {
	base := FileName + ".unreadable-" + now().UTC().Format("20060102T150405Z")
	for n := 1; ; n++ {
		name := base
		if n > 1 {
			name += "-" + strconv.Itoa(n)
		}
		to := filepath.Join(filepath.Dir(l.path), name)
		if _, err := os.Lstat(to); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		return name, os.Rename(l.path, to)
	}
}

// Notice is "" or the sentence about the file that was set aside at OpenList.
func (l *List) Notice() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.notice
}

// Entries returns copies of the remote entries in file order. The local entry is not among them.
func (l *List) Entries() []Entry {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]Entry{}, l.entries...)
}

// Get returns the entry with id.
func (l *List) Get(id string) (Entry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if i := l.index(id); i >= 0 {
		return l.entries[i], true
	}
	return Entry{}, false
}

// Add checks e, gives it a new id (e.ID is ignored), appends it and writes the file.
func (l *List) Add(e Entry) (Entry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e.ID = ""
	if err := l.check(&e); err != nil {
		return Entry{}, err
	}
	id, err := l.newID()
	if err != nil {
		return Entry{}, err
	}
	e.ID = id
	if err := l.write(append(append([]Entry{}, l.entries...), e)); err != nil {
		return Entry{}, err
	}
	return e, nil
}

// Update runs f on a copy of the entry, checks the result and writes the file. The id stays
// whatever f does. When f or a check fails, nothing changes.
func (l *List) Update(id string, f func(*Entry) error) (Entry, error) {
	if id == LocalID {
		return Entry{}, ErrLocalEntry
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	i := l.index(id)
	if i < 0 {
		return Entry{}, ErrNotFound
	}
	e := l.entries[i]
	if err := f(&e); err != nil {
		return Entry{}, err
	}
	e.ID = id
	if err := l.check(&e); err != nil {
		return Entry{}, err
	}
	next := append([]Entry{}, l.entries...)
	next[i] = e
	if err := l.write(next); err != nil {
		return Entry{}, err
	}
	return e, nil
}

// Remove takes the entry out and writes the file.
func (l *List) Remove(id string) error {
	if id == LocalID {
		return ErrLocalEntry
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	i := l.index(id)
	if i < 0 {
		return ErrNotFound
	}
	next := append([]Entry{}, l.entries[:i]...)
	return l.write(append(next, l.entries[i+1:]...))
}

func (l *List) index(id string) int {
	for i := range l.entries {
		if l.entries[i].ID == id {
			return i
		}
	}
	return -1
}

// check normalizes e's fields and refuses a bad one, and an address another entry has.
func (l *List) check(e *Entry) error {
	if err := checkFields(e); err != nil {
		return err
	}
	for _, o := range l.entries {
		if o.ID != e.ID && o.Address == e.Address {
			return &DuplicateError{Name: o.Name}
		}
	}
	return nil
}

// checkFields normalizes e's name, address, secret and pin and refuses a bad one. An entry of
// the file passes it as one of a route does.
func checkFields(e *Entry) error {
	e.Name = strings.TrimSpace(e.Name)
	if n := utf8.RuneCountInString(e.Name); n < 1 || n > maxName || !utf8.ValidString(e.Name) {
		return ErrBadName
	}
	address, _, _, err := ParseAddress(e.Address)
	if err != nil {
		return err
	}
	e.Address = address
	e.Secret = strings.TrimSpace(e.Secret)
	if len(e.Secret) < 1 || len(e.Secret) > maxSecret {
		return ErrBadSecret
	}
	for i := 0; i < len(e.Secret); i++ {
		if c := e.Secret[i]; c <= ' ' || c > '~' {
			return ErrBadSecret
		}
	}
	e.Pin, err = normalPin(e.SelfSigned, e.Pin)
	return err
}

// normalPin is "" without the box or without a pin, else pin in remote.Fingerprint's form.
func normalPin(selfSigned bool, pin string) (string, error) {
	if !selfSigned || strings.TrimSpace(pin) == "" {
		return "", nil
	}
	sum, err := remote.ParseFingerprint(pin)
	if err != nil {
		return "", ErrBadPin
	}
	pairs := make([]string, len(sum))
	for i, b := range sum {
		pairs[i] = strings.ToUpper(hex.EncodeToString([]byte{b}))
	}
	return strings.Join(pairs, ":"), nil
}

func (l *List) newID() (string, error) {
	for {
		b := make([]byte, 6)
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		if id := "s_" + hex.EncodeToString(b); l.index(id) < 0 {
			return id, nil
		}
	}
}

// write saves entries (mode 0600, atomically) and only then makes them the list.
func (l *List) write(entries []Entry) error {
	if l.stuck != nil {
		return l.stuck
	}
	if entries == nil {
		entries = []Entry{}
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return err
	}
	if err := store.WriteJSONAtomic(l.path, listFile{Version: 1, Servers: entries}, 0o600); err != nil {
		return err
	}
	l.entries = entries
	return nil
}

// cause is err without the path an *fs.PathError carries: the notice names the path itself.
func cause(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
