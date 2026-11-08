// Package boards keeps the boards: one folder per board (boards/<id>/) holding board.json,
// drawing.excalidraw and scene.rev (the drawing's revision). The client owns the open scene and saves it back here; the server never
// edits a scene. (The prototype's pages.go, keyed by board id.) A tl board (model.KindTL) holds board.json
// and, once the board host saved it, snapshot.tl.json instead; it has no drawing and no scene.rev.
package boards

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
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

// boardSender is an Emitter that sends a board's events as the events of that board (the editor
// bridge): to every page and every API client.
type boardSender interface {
	SendBoard(board string, ev any)
}

type Service struct {
	st     *store.Store // for P and the group list
	bridge Emitter
	// sendMu keeps the board events in the order of the changes. Create, update and Delete take
	// it before mu and hold it over the send, which runs with mu released: the bridge calls
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

// ErrBadKind is Create's refusal of a kind that is neither model.KindClassic nor model.KindTL.
var ErrBadKind = errors.New("unknown board kind")

// ErrNotTL is the refusal of a snapshot read or write on a board that is not a tl board.
var ErrNotTL = errors.New("the board is not a new board")

// ErrTLBoard is the refusal of a drawing read or write (SceneAt, SaveAt) on a tl board.
var ErrTLBoard = errors.New("the board is a new board, it has no drawing")

// ErrBadSnapshot is SaveSnapshot's refusal of a body that is not valid JSON.
var ErrBadSnapshot = errors.New("the snapshot is not valid JSON")

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
// logged and skipped (never deleted). A board.json from before level 5 may hold the mark of the
// API client that made the board and the board it came from ("client", "origin"): they are not
// read, and the next write of the board.json leaves them out.
func (b *Service) Load() error {
	ents, err := os.ReadDir(b.st.P.Boards)
	if err != nil {
		return err
	}
	return b.load(ents)
}

func (b *Service) load(ents []os.DirEntry) error {
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

// send sends a board's event: through SendBoard when the bridge has it, else to every client.
// Callers hold sendMu.
func (b *Service) send(id string, ev any) {
	if s, ok := b.bridge.(boardSender); ok {
		s.SendBoard(id, ev)
		return
	}
	b.bridge.Broadcast(ev)
}

// List returns every registered board, oldest first: the order of the chats, and the same at
// every call, for the server's own page and for every API client.
func (b *Service) List() []model.Board {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]model.Board, 0, len(b.boards))
	for _, bd := range b.boards {
		out = append(out, *bd)
	}
	slices.SortFunc(out, func(x, y model.Board) int {
		if c := x.Created.Compare(y.Created); c != 0 {
			return c
		}
		return strings.Compare(x.ID, y.ID)
	})
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

// Create makes a board of the given kind, saved the moment it is created: a classic board
// (model.KindClassic) with an empty drawing, a tl board (model.KindTL) with no content at all (a
// missing snapshot is an empty room). Any other kind is ErrBadKind.
func (b *Service) Create(name, group string, isNew bool, kind string) (model.Board, error) {
	if kind != model.KindClassic && kind != model.KindTL {
		return model.Board{}, ErrBadKind
	}
	if name == "" {
		name = "whiteboard"
	}
	name, err := CleanName(name)
	if err != nil {
		return model.Board{}, err
	}
	b.sendMu.Lock()
	defer b.sendMu.Unlock()
	bd, err := b.create(name, group, isNew, kind)
	if err != nil {
		return model.Board{}, err
	}
	b.send(bd.ID, map[string]any{"type": "board", "board": bd})
	return bd, nil
}

// create is Create under mu.
func (b *Service) create(name, group string, isNew bool, kind string) (model.Board, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.checkGroup(group); err != nil {
		return model.Board{}, err
	}
	bd := &model.Board{ID: model.NewID("b_"), Name: name, Group: group, Created: time.Now(), New: isNew, Kind: kind}
	if err := os.MkdirAll(b.st.P.BoardDir(bd.ID), 0o700); err != nil {
		return model.Board{}, err
	}
	if kind == model.KindClassic {
		if err := store.WriteFileAtomic(b.st.P.BoardFile(bd.ID), []byte(EmptyScene), 0o644); err != nil {
			return model.Board{}, err
		}
	}
	// board.json last: a folder without it is not a board.
	if err := b.save(bd); err != nil {
		return model.Board{}, err
	}
	b.boards[bd.ID] = bd
	return *bd, nil
}

// IsTL reports whether id names a known tl board.
func (b *Service) IsTL(id string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	return ok && bd.Kind == model.KindTL
}

// SnapshotAt returns a tl board's stored snapshot. A tl board with none yet gives nil, false, nil.
// An unknown id is ErrNotFound, a classic board ErrNotTL.
func (b *Service) SnapshotAt(id string) (raw []byte, exists bool, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return nil, false, ErrNotFound
	}
	if bd.Kind != model.KindTL {
		return nil, false, ErrNotTL
	}
	raw, err = os.ReadFile(b.st.P.BoardSnapshot(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

// SaveSnapshot writes a tl board's snapshot atomically. Go checks only that body is valid JSON
// (ErrBadSnapshot); it never looks into it. An archived board is written too: a last save may
// arrive after an archive. An unknown id is ErrNotFound, a classic board ErrNotTL.
func (b *Service) SaveSnapshot(id string, body []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return ErrNotFound
	}
	if bd.Kind != model.KindTL {
		return ErrNotTL
	}
	if !json.Valid(body) {
		return ErrBadSnapshot
	}
	return store.WriteFileAtomic(b.st.P.BoardSnapshot(id), body, 0o644)
}

// SceneAt returns a board's drawing and its revision. A known board with a missing file gives
// EmptyScene; an unknown id is ErrNotFound, a tl board ErrTLBoard.
func (b *Service) SceneAt(id string) (raw []byte, rev int64, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	bd, ok := b.boards[id]
	if !ok {
		return nil, 0, ErrNotFound
	}
	if bd.Kind == model.KindTL {
		return nil, 0, ErrTLBoard
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
// Archived boards are read-only. A tl board is ErrTLBoard.
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
	if bd.Kind == model.KindTL {
		return 0, ErrTLBoard
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
	b.send(id, map[string]any{"type": "board", "board": next})
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
	b.send(id, map[string]any{"type": "board_removed", "id": id})
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
