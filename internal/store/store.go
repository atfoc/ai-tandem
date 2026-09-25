package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"ai-whiteboard/internal/model"
)

// WriteJSONAtomic marshals v (indented) to path.tmp and renames it over path.
func WriteJSONAtomic(path string, v any, perm os.FileMode) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	b = append(b, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// WriteFileAtomic writes b to "."+base+".tmp" in the same folder and renames it over path.
// (The prototype's Pages.Put, moved here.)
func WriteFileAtomic(path string, b []byte, perm os.FileMode) error {
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, b, perm); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Store holds state.json in memory and writes it back after every change.
type Store struct {
	P  Paths
	mu sync.Mutex
	s  model.State
}

// Open creates the folders if needed and loads state.json (or starts empty with Version 1).
// An unreadable state.json is an error and is never overwritten.
func Open(p Paths) (*Store, error) {
	if err := os.MkdirAll(p.Root, 0o700); err != nil {
		return nil, err
	}
	for _, d := range []string{p.Boards, p.Chats} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			return nil, err
		}
	}
	st := &Store{P: p}
	b, err := os.ReadFile(p.State)
	if errors.Is(err, fs.ErrNotExist) {
		st.s = model.State{Version: 1, Defaults: model.Defaults{Groups: map[string]model.GroupDefaults{}}}
		return st, WriteJSONAtomic(p.State, st.s, 0o600)
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &st.s); err != nil {
		return nil, fmt.Errorf("read %s: %w", p.State, err)
	}
	if st.s.Defaults.Groups == nil {
		st.s.Defaults.Groups = map[string]model.GroupDefaults{}
	}
	return st, nil
}

// Read runs f with the state locked. f must not keep references past the call.
func (st *Store) Read(f func(s *model.State)) {
	st.mu.Lock()
	defer st.mu.Unlock()
	f(&st.s)
}

// Update runs f with the state locked; if f returns nil the state is written to disk.
func (st *Store) Update(f func(s *model.State) error) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if err := f(&st.s); err != nil {
		return err
	}
	return WriteJSONAtomic(st.P.State, st.s, 0o600)
}

type serverFile struct {
	PID     int       `json:"pid"`
	Port    int       `json:"port"`
	Started time.Time `json:"started"`
}

// WriteServerFile records this process and its port. Written after listen succeeds.
func WriteServerFile(p Paths, port int) error {
	return WriteJSONAtomic(p.Server, serverFile{PID: os.Getpid(), Port: port, Started: time.Now()}, 0o600)
}

// ReadServerFile returns the pid and port of server.json; ok is false when it is missing or unreadable.
func ReadServerFile(p Paths) (pid, port int, ok bool) {
	b, err := os.ReadFile(p.Server)
	if err != nil {
		return 0, 0, false
	}
	var sf serverFile
	if err := json.Unmarshal(b, &sf); err != nil || sf.PID == 0 || sf.Port == 0 {
		return 0, 0, false
	}
	return sf.PID, sf.Port, true
}

// RemoveServerFile deletes server.json. Called on shutdown.
func RemoveServerFile(p Paths) {
	os.Remove(p.Server)
}
