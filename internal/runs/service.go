package runs

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/rungit"
	"ai-whiteboard/internal/usable"
)

// This file is the run service: what the HTTP routes, the app and the chat manager call.
//
// Locks, in the order they may be taken: an id's creation lock (Service.starts: a start call and
// a delete), then a run's op lock (svcLock), then the run's mu, and the service's mu and the event
// queue's lock as leaves. The op lock makes the calls that write run.json one at a time per run
// (create, patch, draft, start, the limit of a resume, archive, unarchive, delete); git, the store
// and the chat manager are called with at most those two locks held, never with a run's mu. Another
// server is asked (Remote.CheckDraft) with none of them held.

// Errors of the routes besides the sentinels of errors.go. The HTTP layer answers 409 for
// ErrGroupArchived and for a *LimitError (errors.Is(err, ErrLimit)); the others are 400.
var (
	ErrGroupArchived = errors.New("the group is archived")
	ErrNoGoal        = errors.New("the goal is empty")
	errSvcEmptyModel = errors.New("the model is empty")
	ErrNoModel       = errors.New("pick a model first")

	errSvcNoGroup = errors.New(`group is empty (use "` + model.Ungrouped + `" for ungrouped)`)
)

// LimitError is a resume refused because the limit that stalled the run was not raised: its text
// names the limit. errors.Is(err, ErrLimit) holds. 409.
type LimitError struct{ Text string }

func (e *LimitError) Error() string        { return e.Text }
func (e *LimitError) Is(target error) bool { return target == ErrLimit }

// The Service is what the chat manager knows of runs.
var _ chats.RunOwner = (*Service)(nil)

// svcHaltWait is how long an archive waits for a live run to stop, and a delete for its workers.
const svcHaltWait = 30 * time.Second

// svcGitWait is how long the service waits for the git reads of a view, a start or a resume.
const svcGitWait = 20 * time.Second

// Service owns the runs. The server makes one (New), gives it the chat manager (Chats) once that
// exists, loads the run folders, and calls Boot last; Shutdown comes first when the server stops.
type Service struct {
	Deps
	// Chats is the chat manager. It is set after New, before any run is loaded, and not changed.
	Chats ChatHost
	// Remote is the other servers (remote.go). It is set before the server list starts and not
	// changed; nil: this computer alone, and a draft that names another server is blocked.
	Remote Remote

	mu   sync.Mutex             // guards runs, git and ops; never held while a run's mu is taken or anything slow happens
	runs map[string]*run        // every run that has a run.json, by id
	git  map[string]svcGit      // where a started run's work is in git, for RunOf and ChatContext
	ops  map[string]*sync.Mutex // the op lock of each run

	// starts is the creation lock of each run id (apistart.go): a start call and a delete of one
	// id happen one after the other.
	starts idLocks

	// eng is what the engine keeps per service (engine.go): the service never looks inside.
	eng engines

	asks sync.WaitGroup // the draft checks ServerUp makes in the background; tests wait for them

	ev       svcEvents     // the event queue (events.go)
	engine   svcEngine     // how the service and the tools call the engine
	haltWait time.Duration // svcHaltWait; tests shorten it
	// stopGrace is engStopGrace: how long a send waits for its result after it was stopped
	// (engine.sent). Only tests shorten it.
	stopGrace time.Duration
}

// svcEngine is the engine as the service and the tools call it: exactly the functions of
// engine.go. They are fields so that the tests of the service can put a small model of the
// engine in their place; nothing else ever sets them.
type svcEngine struct {
	start           func(r *run)
	halt            func(r *run, h Halting) error
	resume          func(r *run) error
	stop            func(r *run, wait time.Duration) bool
	cancelActive    func(r *run, tid string, c model.AttemptCancel) string
	removeCheckouts func(r *run, ctx context.Context) error
	gitFacts        func(r *run, ctx context.Context) (gitFacts, error)
}

// svcGit is what a chat on a started run is told of where the run's work is.
type svcGit struct {
	git         bool   // the run uses git
	branch      string // the integration branch
	repo        string // the repository's top level
	integration string // the integration checkout
}

// New makes a Service with no runs. A nil Deps.Clock becomes the wall clock.
func New(d Deps) *Service {
	if d.Clock == nil {
		d.Clock = RealClock{}
	}
	s := &Service{Deps: d, runs: map[string]*run{}, git: map[string]svcGit{}, ops: map[string]*sync.Mutex{}, haltWait: svcHaltWait,
		stopGrace: engStopGrace}
	if d.HaltWait > 0 {
		s.haltWait = d.HaltWait
	}
	s.engine = svcEngine{start: (*run).startEngine, halt: (*run).halt, resume: (*run).resume, stop: (*run).stopEngine,
		cancelActive: (*run).cancelActive, removeCheckouts: (*run).removeCheckouts, gitFacts: (*run).gitFacts}
	s.eng.init(s)
	return s
}

// run finds a run by id. ErrNotFound when there is none.
func (s *Service) run(id string) (*run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.runs[id]
	if !ok {
		return nil, ErrNotFound
	}
	return r, nil
}

// all lists the runs, in no order. The list is the caller's.
func (s *Service) all() []*run {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*run, 0, len(s.runs))
	for _, r := range s.runs {
		out = append(out, r)
	}
	return out
}

// add puts a run (newRun) into the service; remove takes it out. Neither touches its folder.
func (s *Service) add(r *run) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.runs[r.id] = r
}

func (s *Service) remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.runs, id)
	delete(s.git, id)
	delete(s.ops, id)
}

// svcLock takes the run's op lock and returns its unlock.
func (s *Service) svcLock(id string) (unlock func()) {
	s.mu.Lock()
	m := s.ops[id]
	if m == nil {
		m = &sync.Mutex{}
		s.ops[id] = m
	}
	s.mu.Unlock()
	m.Lock()
	return m.Unlock
}

// ---- load and lists --------------------------------------------------------------------

// Load reads every run folder: run.json, and for a started run its checkpoint (and its journal,
// when that holds something the checkpoint does not). No agent starts. A folder without run.json
// is not a run: it is logged and left alone, as is a run whose record cannot be read.
func (s *Service) Load() error {
	ents, err := os.ReadDir(s.Store.P.Runs)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		dir := s.Store.P.RunDir(e.Name())
		meta, err := readMeta(dir)
		if err != nil {
			log.Printf("runs: %s is skipped: %v", dir, err)
			continue
		}
		if meta.ID != e.Name() {
			log.Printf("runs: %s is skipped: its run.json names the run %q", dir, meta.ID)
			continue
		}
		r := newRun(s, meta)
		if err := r.open(); err != nil {
			log.Printf("runs: %s is skipped: %v", dir, err)
			continue
		}
		if r.client != "" {
			s.svcMark(r.id, r.client)
		}
		s.add(r)
		s.svcNoteGit(r)
		_, f := s.svcFactsOf(r, false) // no other server is asked at load
		r.setFacts(f)
	}
	return nil
}

// Views is every run as the snapshot lists it, oldest first. No run's lock is taken.
func (s *Service) Views() []model.RunView {
	rs := s.all()
	out := make([]model.RunView, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.viewNow())
	}
	slices.SortFunc(out, func(a, b model.RunView) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// List is run.json of every run, oldest first: what the app's group cascades read.
func (s *Service) List() []model.RunMeta {
	rs := s.all()
	out := make([]model.RunMeta, 0, len(rs))
	for _, r := range rs {
		r.mu.Lock()
		out = append(out, r.meta)
		r.mu.Unlock()
	}
	slices.SortFunc(out, func(a, b model.RunMeta) int {
		if c := a.Created.Compare(b.Created); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out
}

// View is one run, with what the view says of its folder (git, folderMissing, blocked) found out
// again: of a draft that will start on another server, that server is asked (the draft check),
// with no lock held.
func (s *Service) View(id string) (model.RunView, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	s.svcRefreshFacts(r, true)
	return r.viewNow(), nil
}

// ---- facts ---------------------------------------------------------------------------------

// svcRec is the little of a started run's record that the facts depend on.
type svcRec struct {
	status model.RunStatus
	repo   string // State.Git.Repo
}

// svcMetaRec is the run's run.json and that little, in one hold of its lock.
func (r *run) svcMetaRec() (model.RunMeta, svcRec) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var st *State
	switch {
	case r.L != nil:
		st = &r.L.State
	case r.head != nil:
		st = r.head
	}
	rec := svcRec{}
	if st != nil && !r.meta.Started.IsZero() {
		rec.status = st.Status
		if st.Git != nil {
			rec.repo = st.Git.Repo
		}
	}
	return r.meta, rec
}

// svcFactsOf finds out the facts of a run as it is now, and returns the run.json they are of. No
// lock is held. With ask, the server of a draft that will start on another one is asked
// (svcRemoteFacts); without, what the view says of its folder stays as it is.
func (s *Service) svcFactsOf(r *run, ask bool) (model.RunMeta, Facts) {
	meta, rec := r.svcMetaRec()
	if svcRemoteDraft(meta) {
		r.mu.Lock()
		last := r.facts
		r.mu.Unlock()
		return meta, s.svcRemoteFacts(meta, last, ask, nil)
	}
	f, _ := s.svcFacts(meta, rec)
	return meta, f
}

// svcRefreshFacts finds the facts out again (svcFactsOf) and puts them into the view when they
// changed (svcSetFacts).
func (s *Service) svcRefreshFacts(r *run, ask bool) Facts {
	meta, f := s.svcFactsOf(r, ask)
	s.svcSetFacts(r, meta, f)
	return f
}

// svcAgentName is an agent kind as a sentence names it.
func svcAgentName(a model.AgentKind) string {
	switch a {
	case model.Claude:
		return "Claude"
	case model.Cursor:
		return "Cursor"
	}
	return string(a)
}

// svcNoCommit is why a run cannot start in a repository whose HEAD is unborn.
const svcNoCommit = "this repository has no commit yet: commit your files (or `git commit --allow-empty -m init` in an empty folder), then start the run"

// svcFacts finds out what the view says of a run's folder: whether it exists, whether it is in a
// git work tree, whether that has uncommitted changes (a draft only), and why the run cannot start
// (a draft) or resume (a halted run) as it is set up.
// A run that is live or finished has nothing to start: only its folder is looked at. The
// repository is returned when the folder is in one that can be used. It stats and runs git: no
// lock is held.
//
// Blocked is the first of these that applies:
//  1. the run has no agent (none was usable when it was made), or the agent's program is not found;
//  2. the repository has no commit yet;
//  3. git cannot open the folder for another reason;
//  4. the data folder's name is part of the run's folder or of the place its checkouts go (the
//     agents refuse every command that names it);
//  5. for a resume: the folder is no longer the repository the run started in.
//
// A draft that will start on another server has nothing looked at here: its facts are
// svcRemoteFacts, and this function asks that server nothing.
func (s *Service) svcFacts(meta model.RunMeta, rec svcRec) (Facts, *rungit.Repo) {
	if svcRemoteDraft(meta) {
		return s.svcRemoteFacts(meta, Facts{}, false, nil), nil
	}
	f := Facts{Git: meta.Git}
	if meta.Started.IsZero() && meta.Client == "" { // a run with a client mark reads no defaults
		f.TierDefaults = s.svcBaseTiers(svcSide{}, meta.Group, meta.Agent)
	}
	if st, err := os.Stat(meta.Cwd); err != nil || !st.IsDir() {
		f.FolderMissing = true
		return f, nil
	}
	started := !meta.Started.IsZero()
	if started && (rec.status.Live() || rec.status.Final()) {
		return f, nil
	}
	var reasons [6]string
	if meta.Agent == "" {
		reasons[1] = s.svcNoAgent()
	} else if bin := s.Bins[meta.Agent]; bin != "" {
		if _, err := exec.LookPath(bin); err != nil {
			reasons[1] = svcAgentName(meta.Agent) + "'s program was not found: install it, then start the run"
		}
	}
	var repo *rungit.Repo
	usesGit := false
	if !started || meta.Git {
		ctx, cancel := context.WithTimeout(context.Background(), svcGitWait)
		defer cancel()
		rp, err := s.openRepo(ctx, meta.Cwd)
		switch {
		case err == nil:
			repo, usesGit = rp, true
		case errors.Is(err, rungit.ErrNoCommits):
			usesGit = true
			reasons[2] = svcNoCommit
		case errors.Is(err, rungit.ErrNotRepo):
		default:
			usesGit = rungit.IsWorkTree(ctx, meta.Cwd, rungit.WithEnv(s.GitEnv...))
			reasons[3] = "git cannot use this folder: " + err.Error()
		}
		if started {
			usesGit = true
			if repo == nil && reasons[3] == "" || repo != nil && repo.Root() != rec.repo {
				reasons[2], repo = "", nil
				reasons[5] = meta.Cwd + " is no longer the git repository this run started in"
			}
		} else {
			f.Git = usesGit
			if repo != nil {
				f.Dirty, _ = repo.Dirty(ctx, meta.Cwd)
			}
		}
	}
	if base := filepath.Base(filepath.Clean(s.Store.P.Root)); base != "/" && base != "." {
		// The work folder holds the checkouts of a run with git and, with and without git, the
		// copies its agents read.
		for _, p := range []string{meta.Cwd, s.Store.P.RunWorkDir(meta.ID)} {
			real, err := filepath.EvalSymlinks(p)
			if strings.Contains(p, base) || err == nil && strings.Contains(real, base) {
				reasons[4] = fmt.Sprintf("the data folder's name (%s) is part of this run's folder or of the place its checkouts go (%s); agents could not work there", base, p)
				break
			}
		}
	}
	for _, why := range reasons {
		if why != "" {
			f.Blocked = why
			return f, nil
		}
	}
	return f, repo
}

// svcNoteGit keeps what a chat on the run is told of where its work is (RunOf and ChatContext
// read it without the run's lock). The start fixes it, so it is noted at the start and at load.
func (s *Service) svcNoteGit(r *run) {
	r.mu.Lock()
	var st *State
	switch {
	case r.L != nil:
		st = &r.L.State
	case r.head != nil:
		st = r.head
	}
	started := !r.meta.Started.IsZero() && st != nil
	g := svcGit{}
	if started && st.Git != nil {
		g = svcGit{git: true, branch: st.Git.IntegrationBranch, repo: st.Git.Repo, integration: st.Git.Integration}
	}
	r.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	if started {
		s.git[r.id] = g
	} else {
		delete(s.git, r.id)
	}
}

// ---- create and set up -----------------------------------------------------------------------

// svcGroup reports whether the group exists and whether it is archived.
func (s *Service) svcGroup(g string) (exists, archived bool) {
	if g == model.Ungrouped {
		return true, false
	}
	s.Store.Read(func(st *model.State) {
		for _, gr := range st.Groups {
			if gr.ID == g {
				exists, archived = true, gr.Archived
				return
			}
		}
	})
	return exists, archived
}

// svcCatalog is the last model list the agent reported, as the chat manager reads it: Claude
// falls back to the built-in list. A nil catalog accepts any model.
func (s *Service) svcCatalog(a model.AgentKind) *model.Catalog {
	var cat *model.Catalog
	s.Store.Read(func(st *model.State) {
		if c := st.Catalog(a); c != nil {
			cp := *c
			cat = &cp
		}
	})
	if cat == nil && a == model.Claude {
		cp := claude.Catalog
		cat = &cp
	}
	return cat
}

func svcKnownAgent(a model.AgentKind) bool {
	return a == model.Claude || a == model.Cursor || a == model.Pi
}

// svcModel looks a model up in a catalog; a nil catalog accepts any.
func svcModel(cat *model.Catalog, id string) (*model.CatalogModel, error) {
	if cat == nil {
		return nil, nil
	}
	for i := range cat.Models {
		if cat.Models[i].ID == id {
			return &cat.Models[i], nil
		}
	}
	return nil, fmt.Errorf("%w %q", ErrUnknownModel, id)
}

// Create makes a run that has not started: its folder and its run.json. The name is the one given
// (checked with CleanName) or "New run". The agent and the settings the composer shows come from
// the run started last in the group (else anywhere, else Claude and the defaults), and so do the
// tiers when that run was of the same agent kind (else svcDefaultTiers); the folder as for a new
// chat there. An agent the server cannot use is replaced by the first usable one, with that
// agent's own tiers; with none usable the run has no agent ("") and no tiers, and cannot start
// until one is picked. ErrGroup for a group that does not exist,
// ErrGroupArchived for an archived one.
//
// The run is on the sticky server of the group (svcStickySide). On another server than this one
// all of that is taken from that server's lists and its part of the defaults (svcChoose): nothing
// is checked on this computer, and that server is asked nothing.
func (s *Service) Create(group, name string) (model.RunView, error) {
	if group == "" {
		return model.RunView{}, errSvcNoGroup
	}
	switch exists, archived := s.svcGroup(group); {
	case !exists:
		return model.RunView{}, fmt.Errorf("%w %q", ErrGroup, group)
	case archived:
		return model.RunView{}, ErrGroupArchived
	}
	meta := model.RunMeta{ID: model.NewID("r_"), Name: DefaultName, Group: group, Created: s.Clock.Now(),
		Settings: model.DefaultRunSettings()}
	if name != "" {
		n, err := CleanName(name)
		if err != nil {
			return model.RunView{}, err
		}
		meta.Name, meta.UserNamed = n, true
	}
	on := s.svcStickySide(group)
	meta.Server = on.id()
	s.svcChoose(on, &meta)
	dir := s.Store.P.RunDir(meta.ID)
	if err := writeMeta(dir, meta); err != nil {
		return model.RunView{}, err
	}
	r := newRun(s, meta)
	r.facts, _ = s.svcFacts(meta, svcRec{})
	r.refreshView() // the run is not shared yet
	s.add(r)
	r.changed()
	return r.viewNow(), nil
}

// PatchReq is the body of PATCH /api/runs/{id}: only the fields that are set change, in the order
// they stand here.
type PatchReq struct {
	Name  *string `json:"name,omitempty"`
	Group *string `json:"group,omitempty"`
	// Server is the server the draft will start on: the id of an entry of the server list, or
	// "local" for this computer. It is the first of the composer's choices to be applied.
	Server   *string          `json:"server,omitempty"`
	Agent    *model.AgentKind `json:"agent,omitempty"`
	Tiers    *TiersPatch      `json:"tiers,omitempty"`
	Cwd      *string          `json:"cwd,omitempty"`
	Settings *SettingsPatch   `json:"settings,omitempty"`
}

// TiersPatch changes what the tiers run on; only the tiers that are set change. Orchestrator is
// the orchestrator's own choice: the model "" takes it away, and the orchestrator runs on the deep
// tier again.
type TiersPatch struct {
	Deep         *TierPatch `json:"deep,omitempty"`
	Standard     *TierPatch `json:"standard,omitempty"`
	Light        *TierPatch `json:"light,omitempty"`
	Orchestrator *TierPatch `json:"orchestrator,omitempty"`
}

type TierPatch struct {
	Model  *string `json:"model,omitempty"`
	Effort *string `json:"effort,omitempty"`
}

// SettingsPatch is the settings a person can change in the composer; only what is set changes.
type SettingsPatch struct {
	MaxParallel *int     `json:"maxParallel,omitempty"` // 1–16
	MaxTurns    *int     `json:"maxTurns,omitempty"`    // 1–500
	MaxCost     *float64 `json:"maxCost,omitempty"`     // 0 or more; 0 = no limit
	Setup       *string  `json:"setup,omitempty"`       // one line, at most 2,000 characters
	Wake        *string  `json:"wake,omitempty"`        // "declared" | "each" | "idle"
	ApplyResult *string  `json:"applyResult,omitempty"` // "auto" | "manual"
}

// apply checks the values and puts them into set. Nothing is changed when one is refused.
func (p SettingsPatch) apply(set *model.RunSettings) error {
	next := *set
	if p.MaxParallel != nil {
		if *p.MaxParallel < 1 || *p.MaxParallel > 16 {
			return errors.New("maxParallel must be between 1 and 16")
		}
		next.MaxParallel = *p.MaxParallel
	}
	if p.MaxTurns != nil {
		if *p.MaxTurns < 1 || *p.MaxTurns > 500 {
			return errors.New("maxTurns must be between 1 and 500")
		}
		next.MaxTurns = *p.MaxTurns
	}
	if p.MaxCost != nil {
		if !(*p.MaxCost >= 0) || *p.MaxCost > 1e9 {
			return errors.New("maxCost must be 0 (no limit) or more")
		}
		next.MaxCost = *p.MaxCost
	}
	if p.Setup != nil {
		setup := strings.TrimSpace(*p.Setup)
		switch {
		case strings.ContainsAny(setup, "\r\n"):
			return errors.New("the setup command must be one line")
		case utf8.RuneCountInString(setup) > 2000:
			return errors.New("the setup command is longer than 2,000 characters")
		}
		next.Setup = setup
	}
	if p.Wake != nil {
		if *p.Wake != "declared" && *p.Wake != "each" && *p.Wake != "idle" {
			return errors.New(`wake must be "declared", "each" or "idle"`)
		}
		next.Wake = *p.Wake
	}
	if p.ApplyResult != nil {
		if *p.ApplyResult != "auto" && *p.ApplyResult != "manual" {
			return errors.New(`applyResult must be "auto" or "manual"`)
		}
		next.ApplyResult = *p.ApplyResult
	}
	*set = next
	return nil
}

// svcExpandDir resolves ~ and a relative path and checks that the result is a folder, as a chat's
// folder is checked.
func svcExpandDir(p string) (string, error) {
	abs, err := svcAbsDir(p)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return "", fmt.Errorf("%s is not a directory", abs)
	}
	return abs, nil
}

// svcSetMeta changes run.json: change gets a copy of it to change, the file is written, and then
// the run in memory and its view follow. An error of change or of the write changes nothing. The
// caller holds the run's op lock.
func (s *Service) svcSetMeta(r *run, change func(m *model.RunMeta) error) error {
	r.mu.Lock()
	next, gone := r.meta, r.gone
	r.mu.Unlock()
	if gone {
		return ErrNotFound
	}
	if err := change(&next); err != nil {
		return err
	}
	if err := writeMeta(r.dir, next); err != nil {
		return err
	}
	r.mu.Lock()
	r.meta = next
	r.refreshView()
	r.mu.Unlock()
	r.changed()
	return nil
}

// Patch changes what the composer and the sidebar set. The name (CleanName; it becomes the
// user's) and the group can change in every status. The server, agent, tiers, folder and settings
// only while the run has not started (ErrStarted), is not archived (ErrArchived), no start of it
// on another server may have arrived (ErrStartUnconfirmed) and none is being made right now
// (ErrStarting). A new agent brings its own tiers,
// as a new run of that agent gets them; one the server cannot use is refused (a
// *usable.MissingError). A tier's new model keeps the effort only
// when it has it. Nothing is changed when any part is refused.
//
// A server must be one of the list (chats.ErrServerUnknown); another one than the draft has must
// not wait for the user (chats.ErrServerUnusable), and the draft must have no chats
// (ErrRunHasChats). The draft then gets the agent, tiers, folder, limits and set-up command a new
// run in its place begins with on that server (svcChoose); the same server changes nothing.
//
// On another server the agent is checked against that server's list and the tiers against its
// catalogue, and a folder is asked of that server (the draft check) before the run's op lock is
// taken: chats.ErrServerUnreachable while it is not connected, chats.ErrFolderMissing (wrapped)
// for a folder that is not there; else the folder is the one that server answered, and so are
// the facts.
func (s *Service) Patch(id string, p PatchReq) (model.RunView, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	for try := 0; ; try++ {
		v, err := s.svcPatch(r, p, s.svcAskFolder(r, p))
		if err == errSvcAskAgain && try < 2 { // the draft changed its server meanwhile
			continue
		}
		return v, err
	}
}

// svcPatch is Patch with what the draft's server answered about the folder p names (asked).
// errSvcAskAgain when that was another server than the draft is on now.
func (s *Service) svcPatch(r *run, p PatchReq, asked svcAsked) (model.RunView, error) {
	unlock := s.svcLock(r.id)
	// facts: what the view says of the folder may have changed; ask: of a draft on another
	// server, that server is asked; answer: it has answered already.
	facts, ask := false, false
	var answer *DraftFacts
	err := s.svcSetMeta(r, func(m *model.RunMeta) error {
		if p.Name != nil {
			n, err := CleanName(*p.Name)
			if err != nil {
				return err
			}
			m.Name, m.UserNamed = n, true
		}
		if p.Group != nil {
			if *p.Group == "" {
				return errSvcNoGroup
			}
			if exists, _ := s.svcGroup(*p.Group); !exists {
				return fmt.Errorf("%w %q", ErrGroup, *p.Group)
			}
			m.Group = *p.Group
			facts = m.Started.IsZero() // the tier defaults are the group's
		}
		if p.Server == nil && p.Agent == nil && p.Tiers == nil && p.Cwd == nil && p.Settings == nil {
			return nil
		}
		switch {
		case !m.Started.IsZero():
			return ErrStarted
		case m.Archived:
			return ErrArchived
		case m.RemoteStart == model.RemoteUnconfirmed:
			return ErrStartUnconfirmed
		case s.svcStarting(*m):
			return ErrStarting
		}
		on, known := s.svcSideOf(m.Server)
		if p.Server != nil {
			to, ok := s.svcSideOf(*p.Server)
			if !ok {
				return chats.ErrServerUnknown
			}
			if to.id() != m.Server {
				switch {
				case to.remote && to.entry.Stopped:
					return chats.ErrServerUnusable
				case s.svcHasChats(m.ID):
					return ErrRunHasChats
				}
				m.Server = to.id()
				s.svcChoose(to, m)
				facts, ask = true, true
			}
			on, known = to, true
		}
		if !known && (p.Agent != nil || p.Tiers != nil || p.Cwd != nil) {
			return chats.ErrServerUnknown // the draft's server left the list: only another server can be chosen
		}
		if p.Agent != nil {
			facts, ask = true, true
		}
		if p.Agent != nil && *p.Agent != m.Agent {
			if !svcKnownAgent(*p.Agent) {
				return fmt.Errorf("unknown agent %q", *p.Agent)
			}
			if err := s.svcCheckAgentOn(on, *p.Agent); err != nil {
				return err
			}
			m.Agent = *p.Agent
			m.Tiers = s.svcNewTiers(on, m.Group, m.Agent, s.svcRunDefaultsOn(on, m.Group))
		}
		if p.Tiers != nil {
			if err := p.Tiers.apply(s.svcCatalogOn(on, m.Agent), &m.Tiers); err != nil {
				return err
			}
		}
		if p.Cwd != nil && on.remote {
			f, err := svcFolderOn(on, *p.Cwd, asked)
			if err != nil {
				return err
			}
			m.Cwd, facts = f.Cwd, true
			if asked.agent == m.Agent {
				answer = &f
			} else {
				ask = true // the answer is of another agent
			}
		} else if p.Cwd != nil {
			abs, err := svcExpandDir(*p.Cwd)
			if err != nil {
				return err
			}
			if s.Store.P.Contains(abs) {
				return chats.ErrAppFolder
			}
			m.Cwd, facts = abs, true
		}
		if p.Settings != nil {
			if err := p.Settings.apply(&m.Settings); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		unlock()
		return model.RunView{}, err
	}
	meta, _ := r.svcMetaRec()
	if !svcRemoteDraft(meta) {
		if facts {
			s.svcRefreshFacts(r, false)
		}
		unlock()
		return r.viewNow(), nil
	}
	unlock() // the run's server is asked with no lock held
	switch {
	case answer != nil:
		s.svcSetFacts(r, meta, s.svcRemoteFacts(meta, Facts{}, false, answer))
	case facts:
		s.svcRefreshFacts(r, ask)
	}
	return r.viewNow(), nil
}

// Move puts the run into another group. ErrGroup when that does not exist.
func (s *Service) Move(id, group string) error {
	_, err := s.Patch(id, PatchReq{Group: &group})
	return err
}

// SetDraft keeps the goal that is being typed: an empty one clears it. For a run that has started
// it does nothing and is no error (a late save of the composer).
func (s *Service) SetDraft(id string, d model.Draft) error {
	r, err := s.run(id)
	if err != nil {
		return err
	}
	defer s.svcLock(id)()
	r.mu.Lock()
	started := !r.meta.Started.IsZero()
	r.mu.Unlock()
	if started {
		return nil
	}
	return s.svcSetMeta(r, func(m *model.RunMeta) error {
		if d.Text == "" && len(d.References) == 0 {
			m.Draft = nil
		} else {
			m.Draft = &d
		}
		return nil
	})
}

// ---- start, stop, resume ------------------------------------------------------------------------

// svcIntegrationBranch is the branch a run's finished work is merged into.
func svcIntegrationBranch(run string) string { return "aiwb/" + run + "/integration" }

// svcNoAgent is why a run with no agent is blocked: no agent can be used on this server, or one
// can by now and none is chosen.
func (s *Service) svcNoAgent() string {
	if err := s.Agents.Check(""); err != nil {
		return err.Error()
	}
	return usable.ErrNone.Error()
}

// svcBlockedErr is the 409 of a start or resume that the facts forbid: the folder is gone, or the
// view's blocked sentence.
func svcBlockedErr(meta model.RunMeta, f Facts) error {
	switch {
	case f.FolderMissing:
		return &BlockedError{Reason: "Folder not found: " + meta.Cwd + ". Pick another folder to continue."}
	case f.Blocked != "":
		return &BlockedError{Reason: f.Blocked}
	}
	return nil
}

// Start sends the goal: the run becomes a started one and the engine takes it. It answers when
// the start is recorded (run.json's `started` is the commit point), before any agent runs.
//
// The folder decides how the run works. Not in a git repository: without git, in the folder
// itself. In a repository with no commit: refused (a *BlockedError). Else the run starts from the
// repository's last commit, and entry 1 records that commit, the repository's top level, the
// folder below it, where the checkouts will be, the integration branch's name, the branch the
// folder is on, and whether the folder had uncommitted changes (which the run does not see).
//
// ErrNoGoal, ErrNoModel (400); ErrStarted, ErrArchived, *BlockedError (409). ErrRemoteStart for a
// draft that will start on another server: whoever talks to that server starts it.
func (s *Service) Start(id, goal string) (model.RunView, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	defer s.svcLock(id)()
	meta, _ := r.svcMetaRec()
	switch {
	case !meta.Started.IsZero():
		return model.RunView{}, ErrStarted
	case meta.Server != "":
		return model.RunView{}, ErrRemoteStart
	case meta.Archived:
		return model.RunView{}, ErrArchived
	case strings.TrimSpace(goal) == "":
		return model.RunView{}, ErrNoGoal
	}
	p, err := s.svcPrepare(meta)
	if p.checked {
		r.setFacts(p.facts)
	}
	if err != nil {
		return model.RunView{}, err
	}
	tiers, git := p.tiers, p.git
	name := meta.Name
	if !meta.UserNamed {
		if n := NameFromGoal(goal); n != "" {
			name = n
		}
	}

	// The record: what an earlier start left goes, then the goal, entry 1, a checkpoint, and
	// last run.json with `started`. A start that fails before that last write leaves a draft.
	r.mu.Lock()
	r.svcForgetRecord()
	r.mu.Unlock()
	if err := removeRecord(r.dir); err != nil {
		return model.RunView{}, err
	}
	if err := writeGoal(r.dir, goal); err != nil {
		return model.RunView{}, err
	}
	failed := func(err error) (model.RunView, error) {
		r.mu.Lock()
		r.svcForgetRecord()
		r.refreshView()
		r.mu.Unlock()
		return model.RunView{}, err
	}
	if _, err := r.commit(KRunStarted, func(tx *Tx) error {
		st := tx.State()
		st.Status, st.StartedAt, st.AsOf, st.GoalSize, st.Git = model.RunRunning, tx.Now(), tx.Now(), utf8.RuneCountInString(goal), git
		return nil
	}); err != nil {
		return failed(err)
	}
	if err := r.checkpoint(); err != nil {
		return failed(err)
	}
	now := s.Clock.Now()
	if err := s.svcSetMeta(r, func(m *model.RunMeta) error {
		m.Name, m.Started, m.Git, m.Draft, m.Tiers = name, now, git != nil, nil, tiers
		return nil
	}); err != nil {
		return failed(err)
	}
	s.svcNoteGit(r)

	// The group remembers what the run was started with, as it does for a chat. A run with a
	// client mark records no defaults.
	if meta.Client == "" {
		set := meta.Settings
		rd := model.RunDefaults{Agent: meta.Agent, MaxParallel: set.MaxParallel, MaxTurns: set.MaxTurns, MaxCost: set.MaxCost,
			Setup: set.Setup, SetupCwd: meta.Cwd, Tiers: &tiers}
		var defs json.RawMessage
		if err := s.Store.Update(func(st *model.State) error {
			defaults.RecordServer(&st.Defaults, meta.Group, model.LocalServer)
			defaults.RecordChange(&st.Defaults, meta.Group, model.LocalServer, meta.Agent, meta.Cwd, model.ModelChoice{}) // the folder; a run does not change the group's chat model
			defaults.RecordRun(&st.Defaults, meta.Group, model.LocalServer, rd)
			defs, _ = json.Marshal(st.Defaults) // a copy, taken under the store's lock
			return nil
		}); err != nil {
			log.Printf("runs: record defaults: %v", err)
		}
		if defs != nil {
			s.queue(id, map[string]any{"type": "defaults", "defaults": defs})
		}
	}

	s.engine.start(r)
	return r.viewNow(), nil
}

// svcForgetRecord drops what a start that did not get to write run.json left in memory, so that
// the run is a draft again and the next start can write entry 1. r.mu held; only for a run whose
// run.json has no `started`.
func (r *run) svcForgetRecord() {
	if !r.meta.Started.IsZero() {
		return
	}
	r.L, r.head, r.sum, r.jsize, r.cp = nil, nil, Summary{}, 0, checkpointMark{}
}

// Stop asks a running run to stop: the engine interrupts its agents, and the run is stopped when
// each has let go. It answers at once with the view (stopping). A run that is stopping already is
// answered the same and nothing changes. ErrNotStarted for a draft, ErrNotRunning otherwise.
func (s *Service) Stop(id string) (model.RunView, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	switch v := r.viewNow(); {
	case v.Status == model.RunDraft:
		return model.RunView{}, ErrNotStarted
	case v.Status == model.RunStopping:
		return v, nil
	case v.Status != model.RunRunning:
		return model.RunView{}, ErrNotRunning
	}
	err = s.engine.halt(r, Halting{Status: model.RunStopped, Reason: "stopped by the user", Stop: model.StopUser})
	if v := r.viewNow(); err != nil && !(errors.Is(err, ErrNotRunning) && v.Status == model.RunStopping) {
		return model.RunView{}, err
	}
	return r.viewNow(), nil
}

// ResumeReq is the body of POST /api/runs/{id}/resume: a higher limit, for a run that a limit
// stalled.
type ResumeReq struct {
	MaxTurns *int     `json:"maxTurns,omitempty"`
	MaxCost  *float64 `json:"maxCost,omitempty"`
}

// Resume continues a run that is stopped, stalled or in error. A run stalled by its turn or cost
// limit needs a higher value of that limit (a *LimitError without one; a 400 for a value that is
// not above what the run has used); the value is written to run.json before the run resumes.
// ErrNotStarted, ErrFinished, ErrStopping, ErrNotHalted, ErrArchived, *BlockedError (409).
func (s *Service) Resume(id string, req ResumeReq) (model.RunView, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	defer s.svcLock(id)()
	v := r.viewNow()
	switch {
	case v.Status == model.RunDraft:
		return model.RunView{}, ErrNotStarted
	case v.Status.Final():
		return model.RunView{}, ErrFinished
	case v.Status == model.RunStopping:
		return model.RunView{}, ErrStopping
	case v.Status == model.RunRunning:
		return model.RunView{}, ErrNotHalted
	case v.Archived:
		return model.RunView{}, ErrArchived
	}
	set := v.Settings
	if req.MaxTurns != nil {
		switch n := *req.MaxTurns; {
		case n <= v.Turns:
			return model.RunView{}, fmt.Errorf("the run has used %s: the limit must be higher", toolCount(v.Turns, "turn"))
		case n > 500:
			return model.RunView{}, errors.New("maxTurns must be between 1 and 500")
		}
		set.MaxTurns = *req.MaxTurns
	} else if v.Status == model.RunStalled && v.StalledBy == model.StalledTurns {
		return model.RunView{}, &LimitError{fmt.Sprintf("the run reached its limit of %s: raise it to resume", toolCount(set.MaxTurns, "orchestrator turn"))}
	}
	if req.MaxCost != nil {
		spent := 0.0
		if v.Cost != nil {
			spent = *v.Cost
		}
		switch c := *req.MaxCost; {
		case !(c >= 0) || c > 1e9:
			return model.RunView{}, errors.New("maxCost must be 0 (no limit) or more")
		case c != 0 && c <= spent:
			return model.RunView{}, fmt.Errorf("the run has spent $%.2f: the limit must be higher", spent)
		}
		set.MaxCost = *req.MaxCost
	} else if v.Status == model.RunStalled && v.StalledBy == model.StalledCost {
		return model.RunView{}, &LimitError{fmt.Sprintf("the run reached its cost limit of $%.2f: raise it to resume", set.MaxCost)}
	}
	if err := r.load(); err != nil {
		return model.RunView{}, err
	}
	meta, rec := r.svcMetaRec()
	f, _ := s.svcFacts(meta, rec)
	r.setFacts(f)
	if err := svcBlockedErr(meta, f); err != nil {
		return model.RunView{}, err
	}
	if set != v.Settings {
		if err := s.svcSetMeta(r, func(m *model.RunMeta) error { m.Settings = set; return nil }); err != nil {
			return model.RunView{}, err
		}
	}
	if err := s.engine.resume(r); err != nil {
		return model.RunView{}, err
	}
	return r.viewNow(), nil
}

// ---- archive and delete ---------------------------------------------------------------------------

// svcHalted makes sure the run is not live: a running one is asked to stop (a stop by the user),
// and the call waits for it. ErrStopping when it is still live after haltWait.
func (s *Service) svcHalted(r *run, why string) error {
	if r.viewNow().Status == model.RunRunning {
		if err := s.engine.halt(r, Halting{Status: model.RunStopped, Reason: why, Stop: model.StopUser}); err != nil && !errors.Is(err, ErrNotRunning) {
			return err
		}
	}
	deadline := time.Now().Add(s.haltWait)
	for r.viewNow().Status.Live() {
		if time.Now().After(deadline) {
			return ErrStopping
		}
		time.Sleep(10 * time.Millisecond)
	}
	return nil
}

// Archive archives the run with the archive action ar. A live run is stopped first and the call
// waits for it; when it has not stopped after 30 s the answer is ErrStopping and nothing is
// changed. The chats people have on the run are archived with the same action and their agents
// are ended. The run's own agents are not touched: no engine runs for an archived run.
func (s *Service) Archive(id string, ar model.Archive) error {
	r, err := s.run(id)
	if err != nil {
		return err
	}
	ar.Archived = true
	for {
		if err := s.svcHalted(r, "the run was archived"); err != nil {
			return err
		}
		unlock := s.svcLock(id)
		if r.viewNow().Status.Live() { // resumed in between: stop it again
			unlock()
			continue
		}
		already := false
		err := s.svcSetMeta(r, func(m *model.RunMeta) error {
			if already = m.Archived; !already {
				m.Archive = ar
			}
			return nil
		})
		unlock()
		if err != nil || already {
			return err
		}
		break
	}
	if s.Chats != nil {
		people, _ := s.Chats.ChatsOfRun(id)
		for _, c := range people {
			if c.Archived {
				continue
			}
			if err := s.Chats.SetArchive(c.ID, ar); err != nil {
				log.Printf("runs: archive chat %s of run %s: %v", c.ID, id, err)
			}
			s.Chats.Stop(c.ID)
		}
	}
	return nil
}

// Unarchive brings an archived run back, with the chats that were archived by the same action.
// The run is not resumed.
func (s *Service) Unarchive(id string) error {
	r, err := s.run(id)
	if err != nil {
		return err
	}
	was, err := s.svcUnarchive(r)
	if err != nil || !was.Archived {
		return err
	}
	if s.Chats != nil {
		people, _ := s.Chats.ChatsOfRun(id)
		for _, c := range people {
			if !c.Archived || c.Op != was.Op {
				continue
			}
			if err := s.Chats.SetArchive(c.ID, model.Archive{}); err != nil {
				log.Printf("runs: unarchive chat %s of run %s: %v", c.ID, id, err)
			}
		}
	}
	s.svcRefreshFacts(r, false)
	return nil
}

// UnarchiveAlone brings an archived run back and leaves the chats people have on it as they are:
// what unarchiving one of those chats does to its run.
func (s *Service) UnarchiveAlone(id string) error {
	r, err := s.run(id)
	if err != nil {
		return err
	}
	was, err := s.svcUnarchive(r)
	if err == nil && was.Archived {
		s.svcRefreshFacts(r, false)
	}
	return err
}

// svcUnarchive clears the run's archive mark in run.json and returns what it was.
func (s *Service) svcUnarchive(r *run) (was model.Archive, err error) {
	defer s.svcLock(r.id)()
	err = s.svcSetMeta(r, func(m *model.RunMeta) error {
		was, m.Archive = m.Archive, model.Archive{}
		return nil
	})
	return was, err
}

// Delete removes the run for good: its engine is stopped, the chats of its agents and the chats
// people have on it are deleted, its checkouts and its branches are removed from the repository,
// and its folder goes. What stays is an integration branch whose result was not applied to the
// person's folder, and whatever the run's agents changed in a folder without git. From
// its first step on nothing can be written to the run any more, so a worker that has not let go
// in time writes nothing either.
//
// It holds the id's creation lock from before it looks the run up: a delete waits for a start
// call of that id that is under way and then removes what it made, and a start call that comes
// after finds `run_removed` queued already.
//
// A draft whose start on another server may have arrived is deleted there too
// (Remote.DropRun), once it is gone here and no lock is held. One whose start is being made
// right now is not deleted (ErrStarting): the answer of that call decides what there is to
// delete.
func (s *Service) Delete(id string) error {
	var drop func()
	defer func() { // deferred first: it runs when the locks below are released
		if drop != nil {
			drop()
		}
	}()
	defer s.starts.lock(id)()
	r, err := s.run(id)
	if err != nil {
		return err
	}
	defer s.svcLock(id)()
	r.mu.Lock()
	gone, meta := r.gone, r.meta
	starting := !gone && s.svcStarting(meta)
	if !starting {
		r.gone = true
	}
	r.mu.Unlock()
	switch {
	case gone:
		return ErrNotFound
	case starting:
		return ErrStarting
	}
	if s.Remote != nil && svcRemoteDraft(meta) && meta.RemoteStart == model.RemoteUnconfirmed {
		drop = func() { s.Remote.DropRun(meta.Server, id) }
	}
	if !s.engine.stop(r, s.haltWait) {
		log.Printf("runs: delete %s: its workers have not let go; their agents are ended with their chats", id)
	}
	if s.Chats != nil {
		people, agents := s.Chats.ChatsOfRun(id)
		for _, c := range agents {
			if err := s.Chats.DeleteOwned(c.ID); err != nil {
				log.Printf("runs: delete agent chat %s of run %s: %v", c.ID, id, err)
			}
		}
		for _, c := range people {
			if err := s.Chats.Delete(c.ID); err != nil {
				log.Printf("runs: delete chat %s of run %s: %v", c.ID, id, err)
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	if err := s.engine.removeCheckouts(r, ctx); err != nil {
		log.Printf("runs: delete %s: remove its checkouts: %v", id, err)
	}
	cancel()
	err = os.RemoveAll(r.dir)
	s.remove(id)
	s.queue(id, svcRemovedEvent{Type: "run_removed", ID: id})
	return err
}

// ---- the result in the person's folder ------------------------------------------------------------

// Apply applies the run's result to the person's folder because a person asked: the same steps as
// at the run's end (rungit.Deliver), never forced. The run must have ended or be halted; what a
// halted run has merged so far is applied as a partial result, and the run fast-forwards from
// there when it is resumed and ends. branch is the folder's branch as the person saw it ("HEAD"
// for a detached one); it is needed only when the folder is not on the branch the run started
// on, and says that the result is to be merged into that branch. The answer is the outcome, also
// when it is blocked or pending; it is recorded as one run_delivery entry. A run without git has
// nothing to apply: none, no_git. ErrNotStarted for a draft, ErrLive, ErrArchived, ErrNotFound
// also for a run that was deleted while the call waited for it.
func (s *Service) Apply(id, branch string) (model.RunDelivery, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunDelivery{}, err
	}
	defer s.svcLock(id)()
	// A Delete that had the lock first has removed the run: nothing of it is applied any more.
	if r.isGone() {
		return model.RunDelivery{}, ErrNotFound
	}
	switch v := r.viewNow(); {
	case v.Status == model.RunDraft:
		return model.RunDelivery{}, ErrNotStarted
	case v.Status.Live():
		return model.RunDelivery{}, ErrLive
	case v.Archived:
		return model.RunDelivery{}, ErrArchived
	}
	return r.delivByHand(branch, false)
}

// Delivery says what Apply would do now, without doing it: pending when it is expected to work
// (other_branch: when the folder's branch is named), blocked with the reason when not, applied
// when the result is in the folder. Nothing changes in the folder and nothing is recorded.
// ErrNotStarted for a draft, ErrLive, ErrNotFound as Apply.
func (s *Service) Delivery(id string) (model.RunDelivery, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunDelivery{}, err
	}
	defer s.svcLock(id)()
	// A Delete that had the lock first has removed the run: nothing of it is applied any more.
	if r.isGone() {
		return model.RunDelivery{}, ErrNotFound
	}
	switch v := r.viewNow(); {
	case v.Status == model.RunDraft:
		return model.RunDelivery{}, ErrNotStarted
	case v.Status.Live():
		return model.RunDelivery{}, ErrLive
	}
	return r.delivByHand("", true)
}

// ---- the detail and what is read on demand -------------------------------------------------------

// svcLoaded makes sure a started run's record is in memory and returns the run. ErrNotFound,
// ErrNotStarted.
func (s *Service) svcLoaded(id string) (*run, error) {
	r, err := s.run(id)
	if err != nil {
		return nil, err
	}
	if err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

// Detail is the run's detail: every turn, task, agent and notes version, current to its version.
// ErrNotStarted for a draft.
func (s *Service) Detail(id string) (model.RunDetail, error) {
	r, err := s.svcLoaded(id)
	if err != nil {
		return model.RunDetail{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.L.Detail(r.id, r.live()), nil
}

// Goal is the goal the run was started with. ErrNotStarted for a draft.
func (s *Service) Goal(id string) (model.RunGoal, error) {
	r, err := s.run(id)
	if err != nil {
		return model.RunGoal{}, err
	}
	r.mu.Lock()
	started := !r.meta.Started.IsZero()
	r.mu.Unlock()
	if !started {
		return model.RunGoal{}, ErrNotStarted
	}
	text, err := readGoal(r.dir)
	return model.RunGoal{Text: text}, err
}

// svcTaskOf finds a task of a run; ErrNoTask when the run has none with that id (a draft has none).
func (s *Service) svcTaskOf(id, task string) (*run, Task, error) {
	r, err := s.svcLoaded(id)
	if errors.Is(err, ErrNotStarted) {
		return nil, Task{}, ErrNoTask
	}
	if err != nil {
		return nil, Task{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := toolTask(r.L, task)
	if !ok {
		return nil, Task{}, ErrNoTask
	}
	return r, cloneTask(t), nil
}

// Brief is one revision of a task's brief; rev 0 is the one in force. ErrNoTask, ErrNoVersion.
func (s *Service) Brief(id, task string, rev int) (model.TaskBrief, error) {
	r, t, err := s.svcTaskOf(id, task)
	if err != nil {
		return model.TaskBrief{}, err
	}
	if rev == 0 {
		rev = t.BriefRev
	}
	i := slices.IndexFunc(t.Briefs, func(b model.BriefRev) bool { return b.Rev == rev })
	if i < 0 {
		return model.TaskBrief{}, ErrNoVersion
	}
	text, err := readBrief(r.dir, task, rev)
	if errors.Is(err, ErrNoText) {
		err = ErrNoVersion
	}
	return model.TaskBrief{BriefRev: t.Briefs[i], Task: task, Text: text}, err
}

// svcAttemptOf finds attempt n (from 1) of a task. ErrNoTask, ErrNoAttempt.
func (s *Service) svcAttemptOf(id, task string, n int) (*run, Attempt, error) {
	r, t, err := s.svcTaskOf(id, task)
	if err != nil {
		return nil, Attempt{}, err
	}
	if n < 1 || n > len(t.Attempts) {
		return nil, Attempt{}, ErrNoAttempt
	}
	return r, t.Attempts[n-1], nil
}

// Report is the result of an attempt's agent: its outcome, its summary and its report. ErrNoText
// while the attempt has no result.
func (s *Service) Report(id, task string, n int) (model.AttemptReport, error) {
	r, a, err := s.svcAttemptOf(id, task, n)
	if err != nil {
		return model.AttemptReport{}, err
	}
	if a.Result == nil {
		return model.AttemptReport{}, ErrNoText
	}
	text, err := readReport(r.dir, task, n)
	if err != nil && !errors.Is(err, ErrNoText) { // a result without a report has no file
		return model.AttemptReport{}, err
	}
	return model.AttemptReport{Task: task, Attempt: n, Outcome: a.Result.Outcome, Summary: a.Result.Summary, Report: text}, nil
}

// Changes is what an attempt changed in the repository. ErrNoText for an attempt that committed
// nothing: a task that only reports, a run without git, or one that is not that far yet.
func (s *Service) Changes(id, task string, n int) (model.AttemptChanges, error) {
	r, _, err := s.svcAttemptOf(id, task, n)
	if err != nil {
		return model.AttemptChanges{}, err
	}
	return readChanges(r.dir, task, n)
}

// Notes is one version of the run's notes; v 0 is the latest. ErrNoVersion.
func (s *Service) Notes(id string, v int) (model.RunNotes, error) {
	r, err := s.svcLoaded(id)
	if errors.Is(err, ErrNotStarted) {
		return model.RunNotes{}, ErrNoVersion
	}
	if err != nil {
		return model.RunNotes{}, err
	}
	r.mu.Lock()
	notes := slices.Clone(r.L.Notes)
	r.mu.Unlock()
	if v == 0 && len(notes) > 0 {
		v = notes[len(notes)-1].V
	}
	i := slices.IndexFunc(notes, func(n model.NotesVersion) bool { return n.V == v })
	if i < 0 {
		return model.RunNotes{}, ErrNoVersion
	}
	text, err := readNotes(r.dir, v)
	if errors.Is(err, ErrNoText) {
		err = ErrNoVersion
	}
	return model.RunNotes{NotesVersion: notes[i], Text: text}, err
}

// ---- for the chat manager (chats.RunOwner) ----------------------------------------------------------

// RunOf returns the facts of a run that its chats depend on; ok is false when there is none. The
// chat manager calls it with a chat's lock held: it reads the run's published view and takes no
// run's lock. A run this service does not have may be one that runs on another server: the record
// of it is asked (Remote.RunInfo).
func (s *Service) RunOf(id string) (chats.RunInfo, bool) {
	r, err := s.run(id)
	if err != nil {
		if s.Remote != nil {
			return s.Remote.RunInfo(id)
		}
		return chats.RunInfo{}, false
	}
	v := r.viewNow()
	return chats.RunInfo{Group: v.Group, Archived: v.Archived, Cwd: v.Cwd, Agent: v.Agent, Model: v.Tiers.Deep.Model, Effort: v.Tiers.Deep.Effort,
		Server: v.Server, Draft: v.Started.IsZero()}, true
}
