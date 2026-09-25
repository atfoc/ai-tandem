// Package boards keeps the boards: one folder per board (boards/<id>/) holding board.json and
// drawing.excalidraw. The client owns the open scene and saves it back here; the server never
// edits a scene. (The prototype's pages.go, keyed by board id.)
package boards

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// Emitter sends an event to the clients (the editor bridge).
type Emitter interface{ Broadcast(ev any) }

type Service struct {
	st     *store.Store // for P and the group list
	bridge Emitter
	mu     sync.Mutex // guards boards and serializes file operations
	boards map[string]*model.Board
}

func New(st *store.Store, bridge Emitter) *Service {
	return &Service{st: st, bridge: bridge, boards: map[string]*model.Board{}}
}

const EmptyScene = `{"type":"excalidraw","version":2,"source":"ai-whiteboard","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}`

var ErrArchived = errors.New("the board is archived")
var ErrNotFound = errors.New("no such board")

// CleanName turns user input into a board name (a label; duplicates allowed).
func CleanName(s string) (string, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimSuffix(s, ".excalidraw")
	s = strings.ReplaceAll(s, " ", "-")
	if s == "" {
		return "", errors.New("board name is empty")
	}
	if strings.HasPrefix(s, ".") {
		return "", errors.New("board name can't start with a dot")
	}
	if strings.ContainsAny(s, `/\`) {
		return "", errors.New("board name can't contain / or \\")
	}
	if strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", errors.New("board name can't contain control characters")
	}
	if len(s) > 80 {
		return "", errors.New("board name is longer than 80 characters")
	}
	return s, nil
}

func (b *Service) boardJSON(id string) string {
	return filepath.Join(b.st.P.BoardDir(id), "board.json")
}

// save writes bd's board.json. Callers hold b.mu.
func (b *Service) save(bd *model.Board) error {
	return store.WriteJSONAtomic(b.boardJSON(bd.ID), bd, 0o644)
}

// Load reads every boards/<id>/board.json at boot. A folder without a readable board.json is
// logged and skipped (never deleted).
func (b *Service) Load() error {
	ents, err := os.ReadDir(b.st.P.Boards)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		path := b.boardJSON(e.Name())
		raw, err := os.ReadFile(path)
		if err != nil {
			log.Printf("boards: skipping %s: %v", e.Name(), err)
			continue
		}
		var bd model.Board
		if err := json.Unmarshal(raw, &bd); err != nil || bd.ID == "" {
			if err == nil {
				err = errors.New("no id")
			}
			log.Printf("boards: skipping %s: %v", e.Name(), err)
			continue
		}
		b.boards[bd.ID] = &bd
	}
	return nil
}

// List returns every registered board (the client sorts).
func (b *Service) List() []model.Board {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]model.Board, 0, len(b.boards))
	for _, bd := range b.boards {
		out = append(out, *bd)
	}
	return out
}

func (b *Service) Get(id string) (model.Board, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return model.Board{}, false
	}
	return *bd, true
}

// checkGroup reports an error unless group is Ungrouped or a known group.
func (b *Service) checkGroup(group string) error {
	if group == model.Ungrouped {
		return nil
	}
	found := false
	b.st.Read(func(s *model.State) {
		for _, g := range s.Groups {
			if g.ID == group {
				found = true
				return
			}
		}
	})
	if !found {
		return fmt.Errorf("no such group %q", group)
	}
	return nil
}

// Create makes a board with an empty drawing, saved the moment it is created.
func (b *Service) Create(name, group string, isNew bool) (model.Board, error) {
	if name == "" {
		name = "whiteboard"
	}
	base, err := CleanName(name)
	if err != nil {
		return model.Board{}, err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.checkGroup(group); err != nil {
		return model.Board{}, err
	}
	bd := &model.Board{ID: model.NewID("b_"), Name: base, Group: group, Created: time.Now(), New: isNew}
	if err := os.MkdirAll(b.st.P.BoardDir(bd.ID), 0o700); err != nil {
		return model.Board{}, err
	}
	if err := store.WriteFileAtomic(b.st.P.BoardFile(bd.ID), []byte(EmptyScene), 0o644); err != nil {
		return model.Board{}, err
	}
	// board.json last: a folder without it is not a board.
	if err := b.save(bd); err != nil {
		return model.Board{}, err
	}
	b.boards[bd.ID] = bd
	b.bridge.Broadcast(map[string]any{"type": "board", "board": *bd})
	return *bd, nil
}

// Scene returns a board's drawing. A known board with a missing file gives EmptyScene; an
// unknown id is ErrNotFound.
func (b *Service) Scene(id string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.boards[id]; !ok {
		return nil, ErrNotFound
	}
	raw, err := os.ReadFile(b.st.P.BoardFile(id))
	if errors.Is(err, fs.ErrNotExist) {
		return []byte(EmptyScene), nil
	}
	return raw, err
}

// Save writes a board's drawing. Archived boards are read-only.
func (b *Service) Save(id string, body []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return ErrNotFound
	}
	if bd.Archived {
		return ErrArchived
	}
	if !json.Valid(body) {
		return errors.New("the drawing is not valid JSON")
	}
	return store.WriteFileAtomic(b.st.P.BoardFile(id), body, 0o644)
}

// update applies f to a registered board, saves board.json and broadcasts the board.
func (b *Service) update(id string, f func(bd *model.Board) error) (model.Board, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return model.Board{}, ErrNotFound
	}
	next := *bd
	if err := f(&next); err != nil {
		return model.Board{}, err
	}
	if err := b.save(&next); err != nil {
		return model.Board{}, err
	}
	*bd = next
	b.bridge.Broadcast(map[string]any{"type": "board", "board": next})
	return next, nil
}

// Rename changes the board's label. The folder keeps its id name.
func (b *Service) Rename(id, name string) (model.Board, error) {
	n, err := CleanName(name)
	if err != nil {
		return model.Board{}, err
	}
	bd, err := b.update(id, func(bd *model.Board) error {
		if bd.Name == n {
			return errUnchanged
		}
		bd.Name = n
		return nil
	})
	if errors.Is(err, errUnchanged) {
		bd, _ = b.Get(id)
		return bd, nil
	}
	return bd, err
}

var errUnchanged = errors.New("unchanged")

func (b *Service) Move(id, group string) error {
	if err := b.checkGroup(group); err != nil {
		return err
	}
	_, err := b.update(id, func(bd *model.Board) error { bd.Group = group; return nil })
	return err
}

// Seen clears New (the user opened the board).
func (b *Service) Seen(id string) error {
	_, err := b.update(id, func(bd *model.Board) error { bd.New = false; return nil })
	return err
}

func (b *Service) SetArchive(id string, a model.Archive) error {
	_, err := b.update(id, func(bd *model.Board) error { bd.Archive = a; return nil })
	return err
}

// Delete removes the board's folder and record.
func (b *Service) Delete(id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.boards[id]; !ok {
		return ErrNotFound
	}
	if err := os.RemoveAll(b.st.P.BoardDir(id)); err != nil {
		return err
	}
	delete(b.boards, id)
	b.bridge.Broadcast(map[string]any{"type": "board_removed", "id": id})
	return nil
}

// Reveal shows the board's drawing in Finder.
func (b *Service) Reveal(id string) error {
	if _, ok := b.Get(id); !ok {
		return ErrNotFound
	}
	return exec.Command("open", "-R", b.st.P.BoardFile(id)).Run()
}
