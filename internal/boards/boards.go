// Package boards keeps the boards: one folder per board (boards/<id>/) holding board.json,
// drawing.excalidraw and scene.rev (the drawing's revision). The client owns the open scene and saves it back here; the server never
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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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
	// sendMu keeps the board events in the order of the changes. Create, update and Delete take
	// it before mu and hold it over the Broadcast, which runs with mu released: the bridge calls
	// List with its own lock held, so its lock must never be taken under mu. Nothing waits for
	// sendMu with mu held.
	sendMu sync.Mutex
	mu     sync.Mutex // guards boards and serializes file operations
	boards map[string]*model.Board
	revs   sync.Map // board id -> *atomic.Int64, the scene revision; read without mu (Rev)
}

func New(st *store.Store, bridge Emitter) *Service {
	return &Service{st: st, bridge: bridge, boards: map[string]*model.Board{}}
}

const EmptyScene = `{"type":"excalidraw","version":2,"source":"ai-whiteboard","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}`

var ErrArchived = errors.New("the board is archived")
var ErrNotFound = errors.New("no such board")

// StaleError is SaveAt's refusal of a write whose base is not the stored revision. Rev is the
// stored one.
type StaleError struct{ Rev int64 }

func (e StaleError) Error() string { return "the board was changed elsewhere" }

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

func (b *Service) revFile(id string) string {
	return filepath.Join(b.st.P.BoardDir(id), "scene.rev")
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
		b.loadRev(bd.ID)
	}
	return nil
}

// loadRev reads a board's scene.rev into memory. A board without the file (one from before the
// revisions, or one never written) has revision 0; an unreadable file is logged and counts as 0.
func (b *Service) loadRev(id string) {
	raw, err := os.ReadFile(b.revFile(id))
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	var n int64
	if err == nil {
		n, err = strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	}
	if err != nil || n < 0 {
		if err == nil {
			err = errors.New("negative")
		}
		log.Printf("boards: %s: scene.rev ignored: %v", id, err)
		return
	}
	b.rev(id).Store(n)
}

// rev returns the board's revision counter, made on first use.
func (b *Service) rev(id string) *atomic.Int64 {
	if v, ok := b.revs.Load(id); ok {
		return v.(*atomic.Int64)
	}
	v, _ := b.revs.LoadOrStore(id, new(atomic.Int64))
	return v.(*atomic.Int64)
}

// Rev returns the revision of a board's stored drawing: 0 for a board never written and for an
// unknown id. It takes no lock (the bridge calls it with its own lock held).
func (b *Service) Rev(id string) int64 {
	if v, ok := b.revs.Load(id); ok {
		return v.(*atomic.Int64).Load()
	}
	return 0
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

// Groups returns, for every registered board, the names of the groups it is in: from the top
// level down to the board's own group. An ungrouped board (and one whose group is gone) has an
// empty path. Keyed by board id.
func (b *Service) Groups() map[string][]string {
	byID := map[string]model.Group{}
	b.st.Read(func(s *model.State) {
		for _, g := range s.Groups {
			byID[g.ID] = g
		}
	})
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string][]string, len(b.boards))
	for id, bd := range b.boards {
		path := []string{}
		seen := map[string]bool{}
		for at := bd.Group; at != "" && !seen[at]; {
			g, ok := byID[at]
			if !ok {
				break
			}
			seen[at] = true
			path = append([]string{g.Name}, path...)
			at = g.Parent
		}
		out[id] = path
	}
	return out
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
	b.sendMu.Lock()
	defer b.sendMu.Unlock()
	bd, err := b.create(base, group, isNew)
	if err != nil {
		return model.Board{}, err
	}
	b.bridge.Broadcast(map[string]any{"type": "board", "board": bd})
	return bd, nil
}

func (b *Service) create(name, group string, isNew bool) (model.Board, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.checkGroup(group); err != nil {
		return model.Board{}, err
	}
	bd := &model.Board{ID: model.NewID("b_"), Name: name, Group: group, Created: time.Now(), New: isNew}
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
	return *bd, nil
}

// SceneAt returns a board's drawing and its revision. A known board with a missing file gives
// EmptyScene; an unknown id is ErrNotFound.
func (b *Service) SceneAt(id string) (raw []byte, rev int64, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.boards[id]; !ok {
		return nil, 0, ErrNotFound
	}
	rev = b.Rev(id)
	raw, err = os.ReadFile(b.st.P.BoardFile(id))
	if errors.Is(err, fs.ErrNotExist) {
		return []byte(EmptyScene), rev, nil
	}
	return raw, rev, err
}

// SaveAt writes a board's drawing if base is its stored revision, and returns the new one
// (base+1). Another base is a StaleError with the stored revision, and nothing is written.
// Archived boards are read-only.
//
// scene.rev is written before the drawing, so a crash between the two leaves a revision ahead
// of the drawing (a client reads again), never a drawing ahead of its revision. If the drawing
// can't be written the old revision is put back.
func (b *Service) SaveAt(id string, base int64, body []byte) (rev int64, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return 0, ErrNotFound
	}
	if bd.Archived {
		return 0, ErrArchived
	}
	if !json.Valid(body) {
		return 0, errors.New("the drawing is not valid JSON")
	}
	cur := b.rev(id)
	old := cur.Load()
	if base != old {
		return 0, StaleError{Rev: old}
	}
	if err := b.writeRev(id, old+1); err != nil {
		return 0, err
	}
	if err := store.WriteFileAtomic(b.st.P.BoardFile(id), body, 0o644); err != nil {
		if rerr := b.writeRev(id, old); rerr != nil {
			log.Printf("boards: %s: scene.rev not put back to %d: %v", id, old, rerr)
		}
		return 0, err
	}
	cur.Store(old + 1)
	return old + 1, nil
}

func (b *Service) writeRev(id string, n int64) error {
	return store.WriteFileAtomic(b.revFile(id), []byte(strconv.FormatInt(n, 10)), 0o644)
}

// update applies f to a registered board, saves board.json and broadcasts the board.
func (b *Service) update(id string, f func(bd *model.Board) error) (model.Board, error) {
	b.sendMu.Lock()
	defer b.sendMu.Unlock()
	next, err := b.apply(id, f)
	if err != nil {
		return model.Board{}, err
	}
	b.bridge.Broadcast(map[string]any{"type": "board", "board": next})
	return next, nil
}

func (b *Service) apply(id string, f func(bd *model.Board) error) (model.Board, error) {
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
	b.sendMu.Lock()
	defer b.sendMu.Unlock()
	if err := b.remove(id); err != nil {
		return err
	}
	b.bridge.Broadcast(map[string]any{"type": "board_removed", "id": id})
	return nil
}

func (b *Service) remove(id string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.boards[id]; !ok {
		return ErrNotFound
	}
	if err := os.RemoveAll(b.st.P.BoardDir(id)); err != nil {
		return err
	}
	delete(b.boards, id)
	b.revs.Delete(id)
	return nil
}

// Reveal shows the board's drawing in Finder.
func (b *Service) Reveal(id string) error {
	if _, ok := b.Get(id); !ok {
		return ErrNotFound
	}
	return exec.Command("open", "-R", b.st.P.BoardFile(id)).Run()
}
