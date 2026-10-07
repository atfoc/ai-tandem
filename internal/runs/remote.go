package runs

// A draft run's server.
//
// A run can be started on another AI Whiteboard server (an entry of the server list). Until its
// start it is a draft run here like any other, which carries the entry it will start on
// (RunMeta.Server): its agent, tiers, folder and limits are chosen against that server's lists and
// that server's part of the defaults, and nothing of them is checked on this computer. What the
// view says of its folder is what that server answers (the draft check). No engine ever starts
// for it here: its start is made by the package that talks to the servers (internal/remotes),
// which then asks for the draft to be handed over (HandOver) and keeps a record of the run in its
// place, under the same id.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"slices"
	"strings"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// Remote is what the run service asks about the other servers; *remotes.Relay implements it.
//
// Entry, ByKey, RunInfo and Starting only look something up: they are called with a run's op lock
// or a chat's lock held, and must not call the run service or the chat manager. CheckDraft asks
// the server and may take as long as the relay lets it: the service calls it with no lock held.
// DropRun returns at once.
type Remote interface {
	Entry(id string) (chats.RemoteEntry, bool)
	ByKey(key string) (chats.RemoteEntry, bool)
	// Starting reports whether the start of the draft run id is being made on its server right
	// now: its start call, or the settling of one, is under way.
	Starting(id string) bool
	// CheckDraft is the draft check of the server entry (GET /api/runs/check there): what a draft
	// run of agent a in cwd would show on that machine. chats.ErrServerUnreachable when the entry
	// is not connected, ErrRunsUnsupported for a server without run routes.
	CheckDraft(entry string, a model.AgentKind, cwd string) (DraftFacts, error)
	RunInfo(run string) (chats.RunInfo, bool) // of a run record that is not gone
	DropRun(entry, run string)                // DELETE there when connected, in the background
}

// What the view's `blocked` says of a draft whose server cannot be asked.
const svcServerGone = "The run's server is no longer in the list: choose another."

func svcOffline(name string) string {
	return name + " is not connected: the folder cannot be checked and the run cannot start."
}

func svcNoRuns(name string) string { return name + " cannot run runs: update it." }

// svcNoAgentOn is why a draft on the server name is blocked while it has no agent and that
// server was not asked: the words the start is refused with.
func svcNoAgentOn(name string) string { return "The run has no agent: choose one of " + name + "." }

var (
	// errSvcSame ends a change of run.json that has nothing to change: nothing is written.
	errSvcSame = errors.New("nothing to change")
	// errSvcAskAgain: the run was not on the server its folder was asked of any more.
	errSvcAskAgain = errors.New("the run changed while its folder was checked: try again")
	errSvcNoFolder = errors.New("the folder is empty")
)

// svcSide is the server a draft's choices are made against: this computer (the zero value) or an
// entry of the server list, as it was when the side was taken.
type svcSide struct {
	remote bool
	entry  chats.RemoteEntry
}

// id is RunMeta.Server of a draft on the side.
func (o svcSide) id() string {
	if !o.remote {
		return ""
	}
	return o.entry.ID
}

// key names the side's part of the defaults; "" for an entry that has not said who it is.
func (o svcSide) key() string {
	if !o.remote {
		return model.LocalServer
	}
	return o.entry.Key
}

// defaultCwd is the folder a draft on the side gets when nothing names one.
func (o svcSide) defaultCwd(s *Service) string {
	if !o.remote {
		return s.DefaultCwd
	}
	return o.entry.DefaultCwd
}

// svcRemoteDraft says whether m is a draft that will start on another server.
func svcRemoteDraft(m model.RunMeta) bool { return m.Started.IsZero() && m.Server != "" }

// svcStarting says whether m is a draft whose start on another server is being made right now:
// from the moment that start is asked for until its answer is taken, what was sent must be what
// the draft has, and the draft must be there. It only looks up (Remote.Starting).
func (s *Service) svcStarting(m model.RunMeta) bool {
	return s.Remote != nil && svcRemoteDraft(m) && s.Remote.Starting(m.ID)
}

// svcSideOf is the side of the server named server: an entry id, or one of the two names of this
// computer ("" and "local"). ok is false for an entry the list does not have, and for every
// entry while the service knows no other servers.
func (s *Service) svcSideOf(server string) (on svcSide, ok bool) {
	if server == "" || server == model.LocalServer {
		return svcSide{}, true
	}
	if s.Remote == nil {
		return svcSide{}, false
	}
	e, ok := s.Remote.Entry(server)
	if !ok {
		return svcSide{}, false
	}
	return svcSide{remote: true, entry: e}, true
}

// svcStickySide is the side of the sticky server of group: the group's, then the ungrouped
// group's, each skipped when no entry has its key or the entry waits for the user; else this
// computer.
func (s *Service) svcStickySide(group string) svcSide {
	if s.Remote == nil {
		return svcSide{}
	}
	var d model.Defaults
	s.Store.Read(func(st *model.State) { d = defaults.Copy(st.Defaults) })
	var found chats.RemoteEntry
	key := defaults.Server(d, group, func(k string) bool {
		if k == model.LocalServer {
			return true
		}
		e, ok := s.Remote.ByKey(k)
		if ok && !e.Stopped {
			found = e
		}
		return ok && !e.Stopped
	})
	if key == model.LocalServer {
		return svcSide{}
	}
	return svcSide{remote: true, entry: found}
}

// svcCatalogOn is the model list of a on the side: this computer's (svcCatalog), or the one the
// entry reported, nil when it reported none: every model is then accepted.
func (s *Service) svcCatalogOn(on svcSide, a model.AgentKind) *model.Catalog {
	if !on.remote {
		return s.svcCatalog(a)
	}
	return on.entry.Catalogs[a]
}

// svcCheckAgentOn says whether a draft on the side can be given the agent a: a
// *usable.MissingError when it cannot. Of another server only its list is asked, and nothing
// while that is not known.
func (s *Service) svcCheckAgentOn(on svcSide, a model.AgentKind) error {
	if !on.remote {
		return s.Agents.Check(a)
	}
	if on.entry.HasLists && !slices.Contains(on.entry.Agents, a) {
		return &usable.MissingError{Agent: a}
	}
	return nil
}

// svcAgentOn is the agent a draft on the side begins with, rd being what the run started last in
// its place on that server used. Here: rd's kind, else Claude, and when the server cannot use it
// the first kind it can, else none. On another server: rd's kind when that server's list has it,
// else the first of defaults.AgentOrder in the list, and none while the list is empty or not
// known.
func (s *Service) svcAgentOn(on svcSide, rd *model.RunDefaults) model.AgentKind {
	if on.remote {
		if rd != nil && slices.Contains(on.entry.Agents, rd.Agent) {
			return rd.Agent
		}
		for _, a := range defaults.AgentOrder {
			if slices.Contains(on.entry.Agents, a) {
				return a
			}
		}
		return ""
	}
	a := model.Claude
	if rd != nil && svcKnownAgent(rd.Agent) {
		a = rd.Agent
	}
	if s.Agents != nil {
		if can := s.Agents.Refresh(); !slices.Contains(can, a) {
			a = ""
			if len(can) > 0 {
				a = can[0]
			}
		}
	}
	return a
}

// svcRunDefaultsOn is what the run started last in group (else in the ungrouped group) on the
// side used; nil when none was.
func (s *Service) svcRunDefaultsOn(on svcSide, group string) *model.RunDefaults {
	var rd *model.RunDefaults
	s.Store.Read(func(st *model.State) { rd = defaults.Run(st.Defaults, group, on.key()) })
	return rd
}

// svcChoose gives the draft m, which is in m.Group, what a new run in its place begins with on
// the side: the agent (svcAgentOn), the three limits and the set-up command of the run started
// last there, the folder a new chat there gets, and the tiers of that run when it was of the same
// agent kind and the side's catalogue still has their models (else svcBaseTiers). Of another
// server nothing is checked on this computer and nothing is asked. The rest of m is left as it
// is: its server, name, group, goal draft, wake and applyResult.
func (s *Service) svcChoose(on svcSide, m *model.RunMeta) {
	rd := s.svcRunDefaultsOn(on, m.Group)
	m.Agent = s.svcAgentOn(on, rd)
	lim := model.DefaultRunSettings()
	if rd != nil {
		// What was recorded is checked like what a person types: a value out of range keeps the default.
		if p := (SettingsPatch{MaxParallel: &rd.MaxParallel, MaxTurns: &rd.MaxTurns, MaxCost: &rd.MaxCost}); p.apply(&lim) != nil {
			lim = model.DefaultRunSettings()
		}
	}
	m.Settings.MaxParallel, m.Settings.MaxTurns, m.Settings.MaxCost = lim.MaxParallel, lim.MaxTurns, lim.MaxCost
	m.Cwd = s.svcFolderOf(on, m.Group, m.Agent)
	m.Tiers = model.RunTiers{}
	if m.Agent != "" {
		m.Tiers = s.svcNewTiers(on, m.Group, m.Agent, rd)
	}
	m.Settings.Setup = ""
	if rd != nil && rd.Setup != "" && rd.SetupCwd == m.Cwd {
		m.Settings.Setup = rd.Setup
	}
}

// svcFolderOf is the folder a new chat of agent a in group gets on the side.
func (s *Service) svcFolderOf(on svcSide, group string, a model.AgentKind) string {
	var cat *model.Catalog
	if on.remote {
		cat = on.entry.Catalogs[a]
	}
	var cwd string
	s.Store.Read(func(st *model.State) {
		cwd, _ = defaults.Resolve(st.Defaults, group, on.key(), a, on.defaultCwd(s), cat)
	})
	return cwd
}

// svcHasChats says whether people have chats on the run.
func (s *Service) svcHasChats(id string) bool {
	if s.Chats == nil {
		return false
	}
	people, _ := s.Chats.ChatsOfRun(id)
	return len(people) > 0
}

// ---- the facts ---------------------------------------------------------------------------------

// svcRemoteFacts is what the view says of the folder of meta, a draft that will start on another
// server. Nothing is looked at on this computer.
//
//   - No such entry, or no other servers at all: blocked.
//   - While the start may have arrived, the folder's facts stay as they were (last).
//   - The entry is not connected: blocked.
//   - Else that server says (answer, when the caller has asked already; the draft check with ask;
//     without either the facts stay as they were, and a draft with no agent is blocked).
//
// TierDefaults is what svcBaseTiers gives on that server while its lists are known. With ask it
// calls Remote.CheckDraft: no lock is held.
func (s *Service) svcRemoteFacts(meta model.RunMeta, last Facts, ask bool, answer *DraftFacts) Facts {
	on, ok := s.svcSideOf(meta.Server)
	if !ok || !on.remote {
		return Facts{Blocked: svcServerGone}
	}
	f := Facts{}
	if on.entry.HasLists {
		f.TierDefaults = s.svcBaseTiers(on, meta.Group, meta.Agent)
	}
	name := on.entry.Name
	kept := func() Facts {
		f.FolderMissing, f.Git, f.Dirty, f.Blocked = last.FolderMissing, last.Git, last.Dirty, last.Blocked
		return f
	}
	switch {
	case meta.RemoteStart == model.RemoteUnconfirmed:
		return kept()
	case !on.entry.Connected:
		f.Blocked = svcOffline(name)
		return f
	case answer != nil:
	case meta.Cwd == "":
		f.FolderMissing = true
		return f
	case !ask:
		kept()
		if f.Blocked == "" && !f.FolderMissing && meta.Agent == "" {
			f.Blocked = svcNoAgentOn(name)
		}
		return f
	default:
		a, err := s.Remote.CheckDraft(on.entry.ID, meta.Agent, meta.Cwd)
		switch {
		case err == nil:
			answer = &a
		case errors.Is(err, chats.ErrServerUnreachable):
			f.Blocked = svcOffline(name)
			return f
		case errors.Is(err, ErrRunsUnsupported):
			f.Blocked = svcNoRuns(name)
			return f
		default:
			f.Blocked = fmt.Sprintf("%s could not check the folder: %v", name, err)
			return f
		}
	}
	f.FolderMissing, f.Git, f.Dirty, f.Blocked = answer.FolderMissing, answer.Git, answer.Dirty, answer.Blocked
	return f
}

// svcSetFacts puts the facts f, found out for the run as meta had it, into the view when they
// differ from what it shows. Facts of a draft on another server are dropped when the run has
// another server, agent or folder by now: whoever changed it finds them out again.
func (s *Service) svcSetFacts(r *run, meta model.RunMeta, f Facts) {
	r.mu.Lock()
	now := r.meta
	moved := (meta.Server != "" || now.Server != "") &&
		(meta.Server != now.Server || meta.Agent != now.Agent || meta.Cwd != now.Cwd)
	if moved || r.facts == f {
		r.mu.Unlock()
		return
	}
	r.facts = f
	r.refreshView()
	r.mu.Unlock()
	r.changed()
}

// ---- a folder on another server ----------------------------------------------------------------

// svcAsked is what a server answered about a folder a patch names, asked before the run's op
// lock was taken. The zero value: nothing was asked.
type svcAsked struct {
	ok    bool
	entry string          // the entry that was asked
	path  string          // the folder as the patch names it
	agent model.AgentKind // the agent the facts are of
	facts DraftFacts
	err   error
}

// svcAskFolder asks the server the draft r will be on once the patch p is done what the folder p
// names is there. It asks nothing when p names no folder, when that server is this computer, and
// when the patch will be refused for another reason as things are now (svcPatch says which). No
// lock is held over the call.
func (s *Service) svcAskFolder(r *run, p PatchReq) svcAsked {
	if p.Cwd == nil || s.Remote == nil || strings.TrimSpace(*p.Cwd) == "" {
		return svcAsked{}
	}
	meta, _ := r.svcMetaRec()
	if !meta.Started.IsZero() || meta.Archived || meta.RemoteStart == model.RemoteUnconfirmed || s.svcStarting(meta) {
		return svcAsked{}
	}
	server := meta.Server
	if p.Server != nil {
		server = *p.Server
	}
	on, ok := s.svcSideOf(server)
	if !ok || !on.remote || !on.entry.Connected {
		return svcAsked{}
	}
	a := meta.Agent
	if on.id() != meta.Server {
		if on.entry.Stopped || s.svcHasChats(meta.ID) {
			return svcAsked{}
		}
		group := meta.Group
		if p.Group != nil {
			group = *p.Group
		}
		a = s.svcAgentOn(on, s.svcRunDefaultsOn(on, group))
	}
	if p.Agent != nil && *p.Agent != a {
		if !svcKnownAgent(*p.Agent) || s.svcCheckAgentOn(on, *p.Agent) != nil {
			return svcAsked{}
		}
		a = *p.Agent
	}
	facts, err := s.Remote.CheckDraft(on.entry.ID, a, *p.Cwd)
	return svcAsked{ok: true, entry: on.entry.ID, path: *p.Cwd, agent: a, facts: facts, err: err}
}

// svcUnreachable is chats.ErrServerUnreachable with the sentence that names the server, as a call
// for a started run on it says it.
type svcUnreachable struct{ name string }

func (e svcUnreachable) Error() string { return e.name + " is not connected." }
func (e svcUnreachable) Unwrap() error { return chats.ErrServerUnreachable }

// svcFolderOn is the folder path names on the entry of the side on, as that server answered
// (asked): chats.ErrServerUnreachable (wrapped, with the entry's name) while the entry is not
// connected, chats.ErrFolderMissing (wrapped, with the folder) when the folder is not there,
// errSvcAskAgain when another server was asked, or none.
func svcFolderOn(on svcSide, path string, asked svcAsked) (DraftFacts, error) {
	switch {
	case strings.TrimSpace(path) == "":
		return DraftFacts{}, errSvcNoFolder
	case !on.entry.Connected:
		return DraftFacts{}, svcUnreachable{on.entry.Name}
	case !asked.ok || asked.entry != on.entry.ID || asked.path != path:
		return DraftFacts{}, errSvcAskAgain
	case errors.Is(asked.err, chats.ErrServerUnreachable):
		return DraftFacts{}, svcUnreachable{on.entry.Name}
	case asked.err != nil:
		return DraftFacts{}, asked.err
	case asked.facts.FolderMissing:
		at := asked.facts.Cwd
		if at == "" {
			at = path
		}
		return DraftFacts{}, fmt.Errorf("%w: %s", chats.ErrFolderMissing, at)
	case asked.facts.Cwd == "":
		return DraftFacts{}, fmt.Errorf("%s did not say where %s is", on.entry.Name, path)
	}
	return asked.facts, nil
}

// ---- what the relay calls ----------------------------------------------------------------------

// RemoteDraft reports whether the run id is a draft that will start on another server, and
// returns its run.json.
func (s *Service) RemoteDraft(id string) (model.RunMeta, bool) {
	r, err := s.run(id)
	if err != nil {
		return model.RunMeta{}, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.gone || !svcRemoteDraft(r.meta) {
		return model.RunMeta{}, false
	}
	return r.meta, true
}

// RemoteReady is called once at the server's start, right after Remote is set: Load ran before
// the other servers were known, so every draft that will start on one of them says that its
// server is no longer in the list. What the view says of each one's folder is found out from
// nothing, as for a draft that was just put on its server: no server is asked, and an entry that
// has not connected yet is named as not connected. The `run` events of what changed follow.
func (s *Service) RemoteReady() {
	for _, r := range s.all() {
		meta, _ := r.svcMetaRec()
		if svcRemoteDraft(meta) {
			s.svcSetFacts(r, meta, s.svcRemoteFacts(meta, Facts{}, false, nil))
		}
	}
}

// DraftsOn lists the drafts that will start on the server entry, oldest first.
func (s *Service) DraftsOn(entry string) []model.RunMeta {
	var out []model.RunMeta
	if entry == "" {
		return out
	}
	for _, r := range s.all() {
		r.mu.Lock()
		if !r.gone && svcRemoteDraft(r.meta) && r.meta.Server == entry {
			out = append(out, r.meta)
		}
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

// SetRemoteStart records what is known of the start sent to the server of the run id, which must
// be one RemoteDraft reports (ErrNotFound otherwise): "" (nothing is there) or
// model.RemoteUnconfirmed (it got no answer and may have arrived). It writes run.json and sends
// the run's view (RunView.Start); a state the draft has already changes nothing.
func (s *Service) SetRemoteStart(id, state string) error {
	if state != "" && state != model.RemoteUnconfirmed {
		return fmt.Errorf("unknown state of a start %q", state)
	}
	r, err := s.run(id)
	if err != nil {
		return err
	}
	defer s.svcLock(id)()
	err = s.svcSetMeta(r, func(m *model.RunMeta) error {
		switch {
		case !svcRemoteDraft(*m):
			return ErrNotFound
		case m.RemoteStart == state:
			return errSvcSame
		}
		m.RemoteStart = state
		return nil
	})
	if err == errSvcSame {
		return nil
	}
	return err
}

// HandOver takes the run id, which must be one RemoteDraft reports on the server entry
// (ErrNotFound otherwise: also for a draft that was put on another server meanwhile), out of this
// service: it has started on that server as started says, and whoever calls keeps a record of it
// from here on, under the same id. meta is its run.json as it was.
//
// Under the id's creation lock and the run's op lock, the run's server, its folder there, its
// agent, what its tiers run on there, its limits and its set-up command become the defaults of
// its group for that server, as a start here makes them (nothing while the server's key is not
// known), and the draft is retired: its folder goes and it is in no list. No `run_removed` is
// sent, since the run is still there for the clients; when the call returns, every `run` event of
// the draft has been sent.
func (s *Service) HandOver(id, entry string, started model.RunView) (model.RunMeta, error) {
	meta, err := s.svcHandOver(id, entry, started)
	s.svcFlush() // with no lock held
	return meta, err
}

func (s *Service) svcHandOver(id, entry string, started model.RunView) (model.RunMeta, error) {
	defer s.starts.lock(id)()
	r, err := s.run(id)
	if err != nil {
		return model.RunMeta{}, err
	}
	defer s.svcLock(id)()
	r.mu.Lock()
	meta := r.meta
	ok := !r.gone && svcRemoteDraft(meta) && meta.Server == entry
	if ok {
		r.gone = true // nothing is written to the draft any more
	}
	r.mu.Unlock()
	if !ok {
		return model.RunMeta{}, ErrNotFound
	}
	// The entry may be gone from the list by now: its key is then not known, and nothing is
	// recorded.
	if on, ok := s.svcSideOf(meta.Server); ok && on.remote && on.key() != "" {
		key, set, tiers, cwd := on.key(), meta.Settings, started.Tiers, started.Cwd
		if cwd == "" {
			cwd = meta.Cwd
		}
		rd := model.RunDefaults{Agent: meta.Agent, MaxParallel: set.MaxParallel, MaxTurns: set.MaxTurns, MaxCost: set.MaxCost,
			Setup: set.Setup, SetupCwd: cwd, Tiers: &tiers}
		var defs json.RawMessage
		if err := s.Store.Update(func(st *model.State) error {
			defaults.RecordServer(&st.Defaults, meta.Group, key)
			defaults.RecordChange(&st.Defaults, meta.Group, key, meta.Agent, cwd, model.ModelChoice{}) // the folder; a run does not change the group's chat model
			defaults.RecordRun(&st.Defaults, meta.Group, key, rd)
			defs, _ = json.Marshal(st.Defaults) // a copy, taken under the store's lock
			return nil
		}); err != nil {
			log.Printf("runs: record defaults: %v", err)
		}
		if defs != nil {
			s.queue(id, map[string]any{"type": "defaults", "defaults": defs})
		}
	}
	err = os.RemoveAll(r.dir)
	s.remove(id)
	return meta, err
}

// Reissue gives the run id, which must be one RemoteDraft reports (ErrNotFound otherwise), a new
// id: its server has refused the one it had. The run's folder is renamed and run.json is written
// with the new id and nothing known of a start; everything else of the draft stays, its goal
// draft too. Two events are sent, in this order: `run` of the new id, whose view names the old
// one (RunView.Was), then `run_removed` of the old id. The answer is that view. It holds the old
// id's creation lock and the run's op lock.
func (s *Service) Reissue(id string) (model.RunView, error) {
	defer s.starts.lock(id)()
	r, err := s.run(id)
	if err != nil {
		return model.RunView{}, err
	}
	defer s.svcLock(id)()
	r.mu.Lock()
	meta, facts := r.meta, r.facts
	ok := !r.gone && svcRemoteDraft(meta)
	if ok {
		r.gone = true // the op lock is held: nothing else writes to it, and nothing will
	}
	r.mu.Unlock()
	if !ok {
		return model.RunView{}, ErrNotFound
	}
	failed := func(err error) (model.RunView, error) {
		r.mu.Lock()
		r.gone = false
		r.mu.Unlock()
		return model.RunView{}, err
	}
	next := meta
	next.RemoteStart = ""
	for {
		next.ID = model.NewID("r_")
		if _, err := s.run(next.ID); err == nil {
			continue
		}
		if _, err := os.Lstat(s.Store.P.RunDir(next.ID)); err == nil {
			continue
		}
		break
	}
	dir := s.Store.P.RunDir(next.ID)
	if err := os.Rename(r.dir, dir); err != nil {
		return failed(err)
	}
	if err := writeMeta(dir, next); err != nil {
		if back := os.Rename(dir, r.dir); back != nil {
			log.Printf("runs: reissue %s: %s could not be put back: %v", id, dir, back)
		}
		return failed(err)
	}
	nr := newRun(s, next)
	nr.facts = facts
	nr.refreshView() // the run is not shared yet
	s.mu.Lock()
	s.runs[next.ID] = nr
	delete(s.runs, id)
	delete(s.git, id)
	delete(s.ops, id)
	s.mu.Unlock()
	v := nr.viewNow()
	v.Was = id
	s.queue(next.ID, svcRunEvent{Type: "run", Run: v})
	s.queue(id, svcRemovedEvent{Type: "run_removed", ID: id})
	return v, nil
}

// ServerUp is called when the server entry has connected and its lists are known. Every draft
// that will start on it and has no agent, or one that server cannot use, gets the agent a new run
// in its place would, with that agent's tiers, and every one without a folder gets one; a draft
// whose start may have arrived keeps what was sent. Then the facts of every draft on the entry
// are asked of that server again, in the background (the call does not wait for the answers), and
// the `run` events of what changed follow.
func (s *Service) ServerUp(entry string) {
	on, ok := s.svcSideOf(entry)
	if !ok || !on.remote {
		return
	}
	var ask []*run
	for _, meta := range s.DraftsOn(entry) {
		r, err := s.run(meta.ID)
		if err != nil {
			continue
		}
		if on.entry.HasLists {
			if err := s.svcRechoose(r, on); err != nil {
				log.Printf("runs: %s: its agent on %s: %v", r.id, on.entry.Name, err)
			}
		}
		ask = append(ask, r)
	}
	if len(ask) == 0 {
		return
	}
	s.asks.Add(1)
	go func() {
		defer s.asks.Done()
		for _, r := range ask {
			s.svcRefreshFacts(r, true)
		}
	}()
}

// svcRechoose is ServerUp for one draft on the side on (see there).
func (s *Service) svcRechoose(r *run, on svcSide) error {
	defer s.svcLock(r.id)()
	err := s.svcSetMeta(r, func(m *model.RunMeta) error {
		if !svcRemoteDraft(*m) || m.Server != on.entry.ID || m.RemoteStart == model.RemoteUnconfirmed {
			return errSvcSame
		}
		was := *m
		if m.Agent == "" || !slices.Contains(on.entry.Agents, m.Agent) {
			rd := s.svcRunDefaultsOn(on, m.Group)
			if a := s.svcAgentOn(on, rd); a != m.Agent {
				m.Agent, m.Tiers = a, model.RunTiers{}
				if a != "" {
					m.Tiers = s.svcNewTiers(on, m.Group, a, rd)
				}
			}
		}
		if m.Cwd == "" {
			m.Cwd = s.svcFolderOf(on, m.Group, m.Agent)
		}
		if m.Agent == was.Agent && m.Tiers == was.Tiers && m.Cwd == was.Cwd {
			return errSvcSame
		}
		return nil
	})
	if err == errSvcSame {
		return nil
	}
	return err
}

// ResetServer puts the run id, when it is a draft that will start on another server, on this
// computer: with the agent, tiers, folder, limits and set-up command a new run in its place
// begins with here, and nothing known of a start. Its view is sent. It is for a server that left
// the list: nothing is sent to that server, and neither chats on the run nor an archive mark
// refuse it. ErrNotFound for an id that is no run's; a run that is on this computer already, or
// has started, is left as it is.
func (s *Service) ResetServer(id string) error {
	r, err := s.run(id)
	if err != nil {
		return err
	}
	defer s.svcLock(id)()
	err = s.svcSetMeta(r, func(m *model.RunMeta) error {
		if !svcRemoteDraft(*m) {
			return errSvcSame
		}
		m.Server, m.RemoteStart = "", ""
		s.svcChoose(svcSide{}, m)
		return nil
	})
	if err == errSvcSame {
		return nil
	}
	if err == nil {
		s.svcRefreshFacts(r, false) // of a folder on this computer
	}
	return err
}
