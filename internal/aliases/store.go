package aliases

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"ai-whiteboard/internal/model"
)

// storeNow is replaced by tests.
var storeNow = time.Now

type aliasesFile struct {
	Aliases []Alias `json:"aliases"`
}

// FileStore is the Store of a data folder: aliases.json in memory, written whole after every
// change. One mutex guards it, held while the file is written.
type FileStore struct {
	path string
	logf func(format string, args ...any)

	mu   sync.Mutex
	list []Alias
}

var _ Store = (*FileStore)(nil)

// OpenStore reads <root>/aliases.json. A missing or empty file gives an empty list, and nothing
// is written. A file that cannot be read is set aside (renamed beside itself, never deleted),
// logged, and the list starts empty. A record whose id is not an account id is dropped and
// logged. logf nil = log.Printf.
func OpenStore(root string, logf func(format string, args ...any)) (*FileStore, error) {
	if root == "" {
		return nil, errors.New("accounts: no data folder")
	}
	if logf == nil {
		logf = log.Printf
	}
	s := &FileStore{path: File(root), logf: logf}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, fs.ErrNotExist) {
		return s, nil
	}
	if err == nil {
		if len(bytes.TrimSpace(b)) == 0 {
			return s, nil
		}
		var f aliasesFile
		if err = json.Unmarshal(b, &f); err == nil {
			for _, a := range f.Aliases {
				if _, ok := model.AliasID(model.AliasKind(a.ID)); !ok {
					logf("accounts: %s: dropped a record with the id %q, which is not an account id", s.path, a.ID)
					continue
				}
				s.list = append(s.list, a)
			}
			return s, nil
		}
	}
	s.setAside(pathCause(err))
	return s, nil
}

// setAside renames the unreadable file to aliases.json.unreadable-<UTC time> and logs one line.
// When the rename fails the next write replaces the file.
func (s *FileStore) setAside(why error) {
	name, err := s.rename()
	if err != nil {
		s.logf("accounts: %s cannot be read (%v); it could not be set aside (%v); starting with no accounts", s.path, why, pathCause(err))
		return
	}
	s.logf("accounts: %s cannot be read (%v); set aside as %s; starting with no accounts", s.path, why, name)
}

// rename moves the file to the first free set-aside name and returns that name (no folder).
func (s *FileStore) rename() (string, error) {
	base := FileName + ".unreadable-" + storeNow().UTC().Format("20060102T150405Z")
	for n := 1; ; n++ {
		name := base
		if n > 1 {
			name += "-" + strconv.Itoa(n)
		}
		to := filepath.Join(filepath.Dir(s.path), name)
		if _, err := os.Lstat(to); err == nil {
			continue
		} else if !errors.Is(err, fs.ErrNotExist) {
			return "", err
		}
		return name, os.Rename(s.path, to)
	}
}

// List returns copies of the records, in the order they were added.
func (s *FileStore) List() []Alias {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Alias, len(s.list))
	for i, a := range s.list {
		out[i] = a.deepCopy()
	}
	return out
}

// Get returns a copy of the record id.
func (s *FileStore) Get(id string) (Alias, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.index(id); i >= 0 {
		return s.list[i].deepCopy(), true
	}
	return Alias{}, false
}

// Put adds a at the end, or replaces in place the record with its ID, and writes the file. When
// the write fails nothing changes.
func (s *FileStore) Put(a Alias) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := slices.Clone(s.list)
	if i := s.index(a.ID); i >= 0 {
		next[i] = a.deepCopy()
	} else {
		next = append(next, a.deepCopy())
	}
	if err := s.write(next); err != nil {
		return err
	}
	s.list = next
	return nil
}

// Delete removes the record id and writes the file. No such record is no error, and nothing is
// written then. When the write fails nothing changes.
func (s *FileStore) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.index(id)
	if i < 0 {
		return nil
	}
	next := slices.Delete(slices.Clone(s.list), i, i+1)
	if err := s.write(next); err != nil {
		return err
	}
	s.list = next
	return nil
}

func (s *FileStore) index(id string) int {
	return slices.IndexFunc(s.list, func(a Alias) bool { return a.ID == id })
}

// write puts list in the file: a temp file in the same folder, mode 0600, synced, renamed over
// aliases.json. The folder is made 0700 if missing.
func (s *FileStore) write(list []Alias) error {
	f := aliasesFile{Aliases: make([]Alias, len(list))}
	for i, a := range list {
		a = a.deepCopy()
		if a.Mounts == nil {
			a.Mounts = []string{}
		}
		if a.Applied != nil && a.Applied.Mounts == nil {
			a.Applied.Mounts = []string{}
		}
		f.Aliases[i] = a
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("accounts: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "."+FileName+".*.tmp")
	if err != nil {
		return fmt.Errorf("accounts: %w", err)
	}
	done := false
	defer func() {
		if !done {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return fmt.Errorf("accounts: %w", err)
	}
	if _, err := tmp.Write(b); err != nil {
		return fmt.Errorf("accounts: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("accounts: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		done = true
		return fmt.Errorf("accounts: %w", err)
	}
	done = true
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		os.Remove(tmp.Name())
		return fmt.Errorf("accounts: %w", err)
	}
	return nil
}

// deepCopy is a deep copy of a: its slices and pointers are its own.
func (a Alias) deepCopy() Alias {
	a.Mounts = slices.Clone(a.Mounts)
	if a.Applied != nil {
		ap := *a.Applied
		ap.Mounts = slices.Clone(ap.Mounts)
		a.Applied = &ap
	}
	if a.LastLogin != nil {
		l := *a.LastLogin
		a.LastLogin = &l
	}
	return a
}

// pathCause is the error under a *fs.PathError, so a log line does not repeat the path.
func pathCause(err error) error {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}
