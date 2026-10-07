package runs

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
)

// This file is the run service for an API client: a caller on the remote listener, another
// person's local server. Its start call (StartCall) makes and starts a run in one step, its draft
// check (CheckDraft) says what a draft would show on this machine, and a run it made carries its
// client id as the run's client mark (model.RunMeta.Client).
//
// A start call shows nothing before its commit point: until run.json is written with `started`
// the run is in no list, has sent no `run` event and has asked for no group, so a refused call
// leaves nothing. None of this reads or records defaults.

// ---- the client mark ---------------------------------------------------------------------------

// svcMark tells whoever routes the events the client mark of a run (Deps.Mark). No run's lock is
// held.
func (s *Service) svcMark(run, client string) {
	if s.Mark != nil {
		s.Mark(run, client)
	}
}

// ViewsOf is Views() of the runs with this client mark, oldest first; never nil; "" gives none.
// It takes no run's lock: the API snapshot calls it with the bridge's lock held.
func (s *Service) ViewsOf(client string) []model.RunView {
	out := []model.RunView{}
	if client == "" {
		return out
	}
	for _, r := range s.all() {
		if r.client == client {
			out = append(out, r.viewNow())
		}
	}
	slices.SortFunc(out, func(a, b model.RunView) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// ClientOf is the run's client mark; ErrNotFound.
func (s *Service) ClientOf(id string) (string, error) {
	r, err := s.run(id)
	if err != nil {
		return "", err
	}
	return r.client, nil
}

// ---- the creation lock -------------------------------------------------------------------------

// idLocks is a lock per id that leaves no entry behind: the ids come from whoever holds the
// secret. The op lock (svcLock) cannot be the creation lock, because remove deletes its entry
// while a caller may wait on it.
type idLocks struct {
	mu sync.Mutex
	m  map[string]*idLock
}

type idLock struct {
	sync.Mutex
	n int // holders and waiters
}

// lock takes the lock of id and returns its unlock.
func (l *idLocks) lock(id string) (unlock func()) {
	l.mu.Lock()
	if l.m == nil {
		l.m = map[string]*idLock{}
	}
	k := l.m[id]
	if k == nil {
		k = &idLock{}
		l.m[id] = k
	}
	k.n++
	l.mu.Unlock()
	k.Lock()
	return func() {
		k.Unlock()
		l.mu.Lock()
		if k.n--; k.n == 0 {
			delete(l.m, id)
		}
		l.mu.Unlock()
	}
}

// AwaitStart returns when no start call or delete of this id is under way: it takes the id's
// creation lock and releases it. An id of another form than ValidID returns at once.
func (s *Service) AwaitStart(id string) {
	if !ValidID(id) {
		return
	}
	s.starts.lock(id)()
}

// ---- the checks of a start ---------------------------------------------------------------------

// svcPrepared is what a start found out before it writes anything.
type svcPrepared struct {
	tiers   model.RunTiers // checked and normalised (svcCheckTiers)
	facts   Facts
	checked bool         // facts were found out
	git     *Git         // nil: the run works without git
	repo    *rungit.Repo // the repository of git; nil without git
}

// svcPrepare is the checks of a start for a run.json that has no `started`: the agent, the tiers,
// the facts of the folder, where the work is in git. It writes nothing.
// ErrNoModel, ErrUnknownModel, *BlockedError.
func (s *Service) svcPrepare(meta model.RunMeta) (svcPrepared, error) {
	var p svcPrepared
	if meta.Agent == "" {
		// No agent, so no tiers: the answer is why the run is blocked, not ErrNoModel.
		p.facts, _ = s.svcFacts(meta, svcRec{})
		p.checked = true
		if err := svcBlockedErr(meta, p.facts); err != nil {
			return p, err
		}
		return p, &BlockedError{Reason: s.svcNoAgent()}
	}
	// The tiers are fixed here: a model that is gone refuses the start, an effort that is gone is
	// replaced by the model's default.
	tiers, err := svcCheckTiers(s.svcCatalog(meta.Agent), meta.Tiers)
	if err != nil {
		return p, err
	}
	p.tiers = tiers
	f, repo := s.svcFacts(meta, svcRec{})
	p.facts, p.checked = f, true
	if err := svcBlockedErr(meta, f); err != nil {
		return p, err
	}
	if repo == nil {
		return p, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), svcGitWait)
	defer cancel()
	base, err := repo.Resolve(ctx, "HEAD")
	if err != nil {
		return p, &BlockedError{Reason: "git cannot use this folder: " + err.Error()}
	}
	work := s.Store.P.RunWorkDir(meta.ID)
	git := &Git{RunGit: model.RunGit{BaseRef: base, IntegrationBranch: svcIntegrationBranch(meta.ID)}, Repo: repo.Root(),
		Integration: filepath.Join(work, "int"), Orchestrator: filepath.Join(work, "orch")}
	// The repository's top level has its symlinks resolved, so the folder must have too.
	if abs, err := filepath.Abs(meta.Cwd); err == nil {
		if real, err := filepath.EvalSymlinks(abs); err == nil {
			if sub, err := filepath.Rel(repo.Root(), real); err == nil && sub != "." && !strings.HasPrefix(sub, "..") {
				git.Sub = sub
			}
		}
	}
	git.DirtyAtStart = f.Dirty
	// The branch the folder is on ("" when its HEAD is detached): the result is applied by
	// itself only while the folder is still on it.
	if git.Branch, err = repo.Branch(ctx, repo.Root()); err != nil {
		return p, &BlockedError{Reason: "git cannot use this folder: " + err.Error()}
	}
	p.git, p.repo = git, repo
	return p, nil
}

// svcAbsDir is a folder as this machine resolves it: ~ expanded and made absolute. It does not
// look whether the folder exists.
func svcAbsDir(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, _ := os.UserHomeDir()
		p = filepath.Join(home, strings.TrimPrefix(p, "~"))
	}
	return filepath.Abs(p)
}

// ---- the start call ----------------------------------------------------------------------------

// StartReq is the start call of an API client.
type StartReq struct {
	ID        string // required: r_ and 8 characters of 0-9a-z
	Client    string // required: the caller's client id, the run's mark
	Name      string
	UserNamed bool
	Agent     model.AgentKind // required
	Tiers     model.RunTiers  // every tier needs a model
	Cwd       string          // required
	Settings  SettingsPatch   // applied on top of model.DefaultRunSettings()
	Goal      string          // required, not blank
	// Place gives the group the run is made in. It is asked once, only when the run is made, after
	// every check. nil = the ungrouped group.
	Place func() (group string, err error)
}

// StartResult is what a start call found or did.
type StartResult struct {
	Started bool          // a run with this id and the caller's mark is there, and it is started
	Made    bool          // this call made and started it
	Run     model.RunView // set when Started
}

// ValidID reports whether id has the form of a run id: ^r_[0-9a-z]{8}$.
func ValidID(id string) bool {
	if len(id) != 10 || id[:2] != "r_" {
		return false
	}
	for _, c := range []byte(id[2:]) {
		if (c < '0' || c > '9') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

// svcStartFiles is what a start writes into a run's folder before run.json, and what a server
// that ended under one of those writes (or under the write of run.json) may have left of it.
var svcStartFiles = func() map[string]bool {
	m := map[string]bool{fileMeta + ".tmp": true}
	for _, name := range []string{fileJournal, fileState, fileTasks, fileTurns, fileAgents, fileGoal} {
		m[name], m["."+name+".tmp"] = true, true
	}
	return m
}()

// svcIDUsed reports whether an earlier run with this id left something a new run would be built
// on: a branch under aiwb/<id>/ in the repository (a deleted run keeps its integration branch
// while its result is on no branch of the person's, and a checkout is put on a branch that
// exists), or the run's work folder. repo is nil for a folder without git.
func (s *Service) svcIDUsed(id string, repo *rungit.Repo) (bool, error) {
	if _, err := os.Lstat(s.Store.P.RunWorkDir(id)); err == nil {
		return true, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return false, err
	}
	if repo == nil {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), svcGitWait)
	defer cancel()
	left, err := repo.Branches(ctx, "aiwb/"+id+"/")
	if err != nil {
		return false, &BlockedError{Reason: "git cannot use this folder: " + err.Error()}
	}
	return len(left) > 0, nil
}

// svcTakeLeftover removes the folder of an id that is no run when it is what a start call left
// under which the server ended: a folder with no run.json that holds nothing but files a start
// writes before run.json. It reports whether the folder is gone; a folder with anything else in it
// is not touched.
func svcTakeLeftover(dir string) bool {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range ents {
		if !e.Type().IsRegular() || !svcStartFiles[e.Name()] {
			return false
		}
	}
	for _, e := range ents {
		if err := os.Remove(filepath.Join(dir, e.Name())); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return false
		}
	}
	return os.Remove(dir) == nil
}

// StartCall is the start call of an API client: it makes the run with the id the caller gives and
// starts it, or finds that the caller's run with this id is started already and does nothing. It
// answers when the start is recorded, before any agent runs.
//
// An answered call is definite. Started true: the run is there, with the caller's mark, and it is
// started (in whatever status, archived included); a repeat's values are ignored. An error:
// nothing of this call is there. Everything is checked before anything is written, the group is
// asked for (Place) after every check, and the run is in no list and has sent no `run` event
// before run.json is written with `started`, the last write.
//
// Calls with one id happen one after the other, and so do a start call and a delete of that id.
// After a delete the id makes a run again only when the deleted run left no branch in the
// folder's repository and no work folder; else the call is refused (ErrIDTaken), because the new
// run's checkout would be made on what the old one left.
//
// The group Place gave may be deleted or archived while the run is in no list yet: the call then
// asks Place once more and moves the run there.
// The call reads no defaults and records none: a setting left out takes the built-in value.
//
// ErrBadID, ErrStartValue, ErrNoGoal, ErrNoModel, ErrUnknownModel, the name's and a setting's
// error, an unknown agent kind, chats.ErrAppFolder (400); ErrIDTaken, a *usable.MissingError,
// chats.ErrFolderMissing, *BlockedError (409); Place's error and a failed write (500).
func (s *Service) StartCall(req StartReq) (StartResult, error) {
	id := req.ID
	switch {
	case !ValidID(id):
		return StartResult{}, ErrBadID
	case req.Client == "" || req.Agent == "" || strings.TrimSpace(req.Cwd) == "":
		return StartResult{}, ErrStartValue
	}
	defer s.starts.lock(id)()

	dir := s.Store.P.RunDir(id)
	if r, err := s.run(id); err == nil {
		if meta, _ := r.svcMetaRec(); r.client != req.Client || meta.Started.IsZero() {
			return StartResult{}, ErrIDTaken
		}
		return StartResult{Started: true, Run: r.viewNow()}, nil
	}
	// No run, and yet a folder: one Load skipped (it has a run.json), something else's, or what a
	// start call left when the server ended under it. Only the last is removed.
	if _, err := os.Lstat(dir); err == nil {
		if _, err := os.Lstat(filepath.Join(dir, fileMeta)); !errors.Is(err, fs.ErrNotExist) {
			return StartResult{}, ErrIDTaken
		}
		if !svcTakeLeftover(dir) {
			return StartResult{}, ErrIDTaken
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return StartResult{}, err
	}

	// The values. Nothing is written yet.
	if strings.TrimSpace(req.Goal) == "" {
		return StartResult{}, ErrNoGoal
	}
	meta := model.RunMeta{ID: id, Name: DefaultName, Created: s.Clock.Now(), Agent: req.Agent, Tiers: req.Tiers,
		Settings: model.DefaultRunSettings(), Client: req.Client}
	if req.UserNamed {
		n, err := CleanName(req.Name)
		if err != nil {
			return StartResult{}, err
		}
		meta.Name, meta.UserNamed = n, true
	} else if n := NameFromGoal(req.Goal); n != "" {
		meta.Name = n
	} else if n, err := CleanName(req.Name); err == nil {
		meta.Name = n
	}
	if !svcKnownAgent(req.Agent) {
		return StartResult{}, fmt.Errorf("unknown agent %q", req.Agent)
	}
	if err := s.Agents.Check(req.Agent); err != nil {
		return StartResult{}, err
	}
	abs, err := svcExpandDir(req.Cwd)
	if err != nil {
		if p, err := svcAbsDir(req.Cwd); err == nil {
			abs = p
		}
		return StartResult{}, fmt.Errorf("%w: %s", chats.ErrFolderMissing, abs)
	}
	if s.Store.P.Contains(abs) {
		return StartResult{}, chats.ErrAppFolder
	}
	meta.Cwd = abs
	if err := req.Settings.apply(&meta.Settings); err != nil {
		return StartResult{}, err
	}
	p, err := s.svcPrepare(meta)
	if err != nil {
		return StartResult{}, err
	}
	if used, err := s.svcIDUsed(id, p.repo); err != nil {
		return StartResult{}, err
	} else if used {
		return StartResult{}, ErrIDTaken
	}

	// The group comes after every check, so a refused call makes none.
	meta.Group = model.Ungrouped
	if req.Place != nil {
		g, err := req.Place()
		if err != nil {
			return StartResult{}, err
		}
		if g != "" {
			meta.Group = g
		}
	}

	// The record, as Start writes it: the goal, entry 1, a checkpoint. The run is not in the
	// service yet, so nobody lists it and its `run` event is not sent.
	r := newRun(s, meta)
	failed := func(err error) (StartResult, error) {
		r.mu.Lock()
		r.gone = true
		r.mu.Unlock()
		os.RemoveAll(dir)
		return StartResult{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return failed(err)
	}
	if err := writeGoal(dir, req.Goal); err != nil {
		return failed(err)
	}
	if _, err := r.commit(KRunStarted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize, st.Git = model.RunRunning, tx.Now(), tx.Now(), utf8.RuneCountInString(req.Goal), p.git
		return nil
	}); err != nil {
		return failed(err)
	}
	if err := r.checkpoint(); err != nil {
		return failed(err)
	}
	// The commit point: run.json with `started`. After it nothing can fail.
	meta.Started, meta.Git, meta.Tiers = s.Clock.Now(), p.git != nil, p.tiers
	if err := writeMeta(dir, meta); err != nil {
		return failed(err)
	}
	r.mu.Lock()
	r.meta, r.facts = meta, p.facts
	r.refreshView()
	r.mu.Unlock()

	defer s.svcLock(id)()
	// A `run_removed` of an earlier run with this id may still be in the queue, and whoever routes
	// the events drops the id's mark after it: it is sent before the mark is set. (Delete holds the
	// creation lock, so that event is in the queue by now.)
	s.svcFlush()
	s.svcMark(id, req.Client)
	s.add(r)
	s.svcNoteGit(r)
	// Until here the run was in no list, so whoever deleted or archived its group in between did
	// not see it. The op lock is held: the steps of a move, not Move.
	if exists, archived := s.svcGroup(meta.Group); (!exists || archived) && req.Place != nil {
		if err := s.svcPlaceAgain(r, req.Place); err != nil {
			log.Printf("runs: start call %s: its group %s is gone or archived, and it could not be moved: %v", id, meta.Group, err)
		}
	}
	r.changed()
	s.engine.start(r)
	return StartResult{Started: true, Made: true, Run: r.viewNow()}, nil
}

// svcPlaceAgain asks place for a group once more and moves the run there. The caller holds the
// run's op lock; no event is sent. An error when the run stays where it was.
func (s *Service) svcPlaceAgain(r *run, place func() (string, error)) error {
	g, err := place()
	if err != nil {
		return err
	}
	if g == "" {
		g = model.Ungrouped
	}
	if exists, archived := s.svcGroup(g); !exists || archived {
		return fmt.Errorf("the group %s it was given next is gone or archived too", g)
	}
	r.mu.Lock()
	next := r.meta
	r.mu.Unlock()
	next.Group = g
	if err := writeMeta(r.dir, next); err != nil {
		return err
	}
	r.mu.Lock()
	r.meta = next
	r.refreshView()
	r.mu.Unlock()
	return nil
}

// ---- the draft check ---------------------------------------------------------------------------

// DraftFacts is what a draft run of an agent in a folder would show on this machine.
type DraftFacts struct {
	Cwd           string `json:"cwd"` // the folder as this machine resolves it: absolute, ~ expanded
	FolderMissing bool   `json:"folderMissing"`
	Git           bool   `json:"git"`     // the folder is inside a git work tree
	Dirty         bool   `json:"dirty"`   // a git folder with uncommitted changes or untracked files
	Blocked       string `json:"blocked"` // why a run could not start there; "" = nothing blocks it
}

// svcCheckID and svcCheckClient stand for the run and its mark in the draft check: no run is made.
// The mark keeps svcFacts from reading defaults.
const (
	svcCheckID     = "r_00000000"
	svcCheckClient = "check"
)

// CheckDraft is the draft check. It writes nothing, reads no defaults and sends nothing.
// ErrStartValue for a blank folder or an agent that is none of "", claude, cursor, pi.
//
// An empty agent gives the sentence of a draft that has no agent. A folder that is missing (or is
// no folder) gives FolderMissing and nothing else. The models are not checked: the start call
// checks them.
func (s *Service) CheckDraft(a model.AgentKind, cwd string) (DraftFacts, error) {
	if strings.TrimSpace(cwd) == "" || a != "" && !svcKnownAgent(a) {
		return DraftFacts{}, ErrStartValue
	}
	dir, err := svcAbsDir(cwd)
	if err != nil {
		return DraftFacts{}, err
	}
	f, _ := s.svcFacts(model.RunMeta{ID: svcCheckID, Agent: a, Cwd: dir, Client: svcCheckClient}, svcRec{})
	if f.FolderMissing {
		return DraftFacts{Cwd: dir, FolderMissing: true}, nil
	}
	return DraftFacts{Cwd: dir, Git: f.Git, Dirty: f.Dirty, Blocked: f.Blocked}, nil
}
