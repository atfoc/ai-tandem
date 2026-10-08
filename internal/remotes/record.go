// Package remotes is what this server keeps and does for the chats that run on other AI
// Whiteboard servers (the entries of the server list, package servers).
//
// A chat that has started on another server has a record here: one file with the last view
// that server sent, the chat's place in this server's sidebar, its drafts and its archive mark.
// The thread stays on that server, and so does the secret. The relay hangs on the hooks of
// servers.Manager: it takes a remote server's events, rewrites the list events from the record
// and gives them to this server's pages through the bridge, and hands the content events on,
// as the bytes that came, to the pages that follow the chat.
//
// Locks. A record has its own lock (record.mu), held over a change with its file write and its
// events, so the events of one chat leave in the order of its changes. The relay's lock
// (Relay.mu) guards the list of records and is never held over I/O or over a call of the
// bridge. The order is record.mu, then Relay.mu. Views, States, Has and Counts take Relay.mu
// alone: the bridge builds a page's snapshot from them with its own lock held.
//
// A run that has started on another server has a run record, kept and locked in the same way
// (runrecord.go, runrelay.go); RunViews, HasRun and AgentChat take Relay.mu alone too.
package remotes

import (
	"regexp"
	"sort"

	"ai-whiteboard/internal/model"
)

// Record is what this server keeps of a started chat on another server. It is the file's shape.
// A draft that is stored is replaced, never changed: a view that was handed out may still
// point to it.
type Record struct {
	ID        string                  `json:"id"`
	Entry     string                  `json:"entry"`               // the entry's id
	Group     string                  `json:"group,omitempty"`     // local place: a group id or model.Ungrouped; "" on a run
	Run       string                  `json:"run,omitempty"`       // local place of a chat on a run (phase 9)
	Archived  bool                    `json:"archived,omitempty"`  // the remote server's mark, as last received
	Op        string                  `json:"archiveOp,omitempty"` // the local archive action that archived it; "" for a mark taken from there
	Pending   string                  `json:"pending,omitempty"`   // "archive" | "unarchive": not yet confirmed there
	Gone      bool                    `json:"gone,omitempty"`
	View      model.ChatView          `json:"view"`                // the last view received, as it came
	States    []model.BranchState     `json:"states"`              // the last state of every branch, as received
	Drafts    map[string]*model.Draft `json:"drafts,omitempty"`    // by branch id ("main" included)
	DraftRevs map[string]int64        `json:"draftRevs,omitempty"` // never removed
}

// mainBranch is the id of a chat's first branch.
const mainBranch = "main"

// maxStates is the number of branch states one record keeps: the state of a further branch is
// dropped. The other server names the branches, so nothing else bounds them.
const maxStates = 200

// The values of Record.Pending.
const (
	pendingArchive   = "archive"
	pendingUnarchive = "unarchive"
)

// idForm is the form of a record's id: it names the record's file and is put in the path of the
// calls for the chat. The ids of the chats this server starts are UUIDs; a fork's id is made by
// the other server.
var idForm = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// validID reports whether id can be a record's.
func validID(id string) bool { return idForm.MatchString(id) }

// branchOf is the id of the branch a view is of.
func branchOf(v model.ChatView) string {
	if v.Branch == "" {
		return mainBranch
	}
	return v.Branch
}

// viewOf is the view of a record as this server keeps it: the last view received, with the
// chat's place, mark and drafts as this server keeps them. The board is the one the chat's
// server names; what a page gets is pageView of it.
func viewOf(rec Record) model.ChatView {
	v := rec.View
	v.ID = rec.ID
	v.Group, v.Run = rec.Group, rec.Run
	v.Role = "" // a record is never a run agent's chat
	v.Server = rec.Entry
	v.Start = "" // a record is a started chat
	v.Gone = rec.Gone
	switch rec.Pending {
	case pendingArchive:
		v.Archived = true
	case pendingUnarchive:
		v.Archived = false
	default:
		v.Archived = rec.Archived
	}
	v.Op = rec.Op // never the remote server's
	b := branchOf(v)
	v.Draft, v.DraftRev = rec.Drafts[b], rec.DraftRevs[b]
	v.HasDraft = len(rec.Drafts) > 0
	return v
}

// stateOf is a branch state of a record as a page gets it: with that branch's draft and counter.
func stateOf(rec Record, st model.BranchState) model.BranchState {
	st.Chat = rec.ID
	if st.Branch == "" {
		st.Branch = mainBranch
	}
	st.Draft, st.DraftRev = rec.Drafts[st.Branch], rec.DraftRevs[st.Branch]
	return st
}

// statesOf is every branch state of a record as a page gets it. Never nil.
func statesOf(rec Record) []model.BranchState {
	out := make([]model.BranchState, 0, len(rec.States))
	for _, st := range rec.States {
		out = append(out, stateOf(rec, st))
	}
	return out
}

// apply takes a view that came from the record's server: in a chat event, in an answer, or,
// with snapshot set, in the snapshot of a stream's start. The chat is there, so the record is
// not gone. The mark is the server's: a pending change that equals it is confirmed by it. At a
// snapshot a pending change wins and stays, to be passed on. durable says that more than the
// view changed, so the file is written at once.
func (rec *Record) apply(v model.ChatView, snapshot bool) (durable bool) {
	archived, op, pending, gone := rec.Archived, rec.Op, rec.Pending, rec.Gone
	rec.View = v
	rec.Gone = false
	switch {
	case rec.Pending == "":
		rec.Archived = v.Archived
	case !snapshot:
		rec.Archived = v.Archived
		if v.Archived == (rec.Pending == pendingArchive) {
			rec.Pending = ""
		}
	}
	if rec.Pending == "" && !rec.Archived {
		rec.Op = "" // the action that archived it is over
	}
	return archived != rec.Archived || op != rec.Op || pending != rec.Pending || gone != rec.Gone
}

// setState puts st in the place of its branch's state, or adds it. It reports false, and keeps
// nothing, for the state of a new branch when the record has maxStates already.
func (rec *Record) setState(st model.BranchState) (kept bool) {
	if st.Branch == "" {
		st.Branch = mainBranch
	}
	for i := range rec.States {
		if rec.States[i].Branch == st.Branch {
			rec.States[i] = st
			return true
		}
	}
	if len(rec.States) >= maxStates {
		return false
	}
	rec.States = append(rec.States, st)
	return true
}

// snapshot is what the relay reads of a remote server's API snapshot: its chats, their branch
// states and its runs. The lists are read by package servers.
type snapshot struct {
	Chats  []model.ChatView    `json:"chats"`
	States []model.BranchState `json:"states"`
	Runs   []model.RunView     `json:"runs"`
}

// chat is the snapshot's view of the chat id.
func (s *snapshot) chat(id string) (model.ChatView, bool) {
	for _, v := range s.Chats {
		if v.ID == id {
			return v, true
		}
	}
	return model.ChatView{}, false
}

// states are the snapshot's states of the chat id, in its order, the first maxStates of them;
// for a chat it gives none, the state of main as the view tells it.
func (s *snapshot) states(id string, v model.ChatView) []model.BranchState {
	var out []model.BranchState
	for _, st := range s.States {
		if st.Chat == id && len(out) < maxStates {
			out = append(out, st)
		}
	}
	if len(out) == 0 {
		out = []model.BranchState{model.StateOf(id, mainBranch, v)}
	}
	return out
}

// byID sorts records by their id: the order of every list the relay hands out.
func byID(recs []*record) {
	sort.Slice(recs, func(i, j int) bool { return recs[i].id < recs[j].id })
}
