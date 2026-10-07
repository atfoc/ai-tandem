package remotes

import (
	"sort"

	"ai-whiteboard/internal/model"
)

// RunRecord is what this server keeps of a started run on another server. It is the file's
// shape. The run's journal, its detail and its texts stay on that server, and so does the
// secret: a record holds the last view, the run's place in this server's sidebar, its archive
// mark and the chat ids of its agents.
type RunRecord struct {
	ID       string        `json:"id"`
	Entry    string        `json:"entry"`               // the entry's id
	Group    string        `json:"group"`               // local place: a group id or model.Ungrouped
	Archived bool          `json:"archived,omitempty"`  // the remote server's mark, as last received
	Op       string        `json:"archiveOp,omitempty"` // the local archive action that archived it; "" for a mark taken from there
	Pending  string        `json:"pending,omitempty"`   // "archive" | "unarchive": not yet confirmed there
	Gone     bool          `json:"gone,omitempty"`
	View     model.RunView `json:"view"`             // the last view received, as it came
	Agents   []string      `json:"agents,omitempty"` // chat ids of the run's agents, as learned; sorted
}

// maxAgents is the number of agent chats one record keeps: a further one is dropped. The other
// server names them, so nothing else bounds them.
const maxAgents = 500

// runViewOf is the view of a run record as a page gets it, in events and in answers alike: the
// last view received, with the run's place and mark as this server keeps them. What belongs to
// a draft is cleared: a record is a started run.
func runViewOf(rec RunRecord) model.RunView {
	v := rec.View
	v.ID = rec.ID
	v.Group = rec.Group
	v.Server = rec.Entry
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
	v.Draft, v.TierDefaults = nil, nil
	v.Start, v.Was, v.Dirty = "", "", false
	return v
}

// apply takes a view that came from the record's server: in a run event, in an answer, or, with
// snapshot set, in the snapshot of a stream's start. The rules are those of a chat record
// (Record.apply): the run is there, so the record is not gone; the mark is the server's, and a
// pending change that equals it is confirmed by it; at a snapshot a pending change wins and
// stays, to be passed on. durable says that more than the view changed, so the file is written
// at once.
func (rec *RunRecord) apply(v model.RunView, snapshot bool) (durable bool) {
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

// hasAgent reports whether the chat id is one of the record's agents.
func (rec *RunRecord) hasAgent(chat string) bool {
	i := sort.SearchStrings(rec.Agents, chat)
	return i < len(rec.Agents) && rec.Agents[i] == chat
}

// addAgent adds the chat id of an agent, keeping the list sorted. It reports false, and adds
// nothing, for an id the record has and for a new one when it has maxAgents already. The list
// that was there is not changed: a copy of the record may still hold it.
func (rec *RunRecord) addAgent(chat string) (added bool) {
	i := sort.SearchStrings(rec.Agents, chat)
	if (i < len(rec.Agents) && rec.Agents[i] == chat) || len(rec.Agents) >= maxAgents {
		return false
	}
	next := make([]string, 0, len(rec.Agents)+1)
	next = append(next, rec.Agents[:i]...)
	next = append(next, chat)
	rec.Agents = append(next, rec.Agents[i:]...)
	return true
}

// cleanAgents is a list of agent chat ids as a record keeps it: the ids of the known form,
// each once, sorted, maxAgents of them at most. nil for none.
func cleanAgents(ids []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, id := range ids {
		if validID(id) && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	sort.Strings(out)
	if len(out) > maxAgents {
		out = out[:maxAgents]
	}
	return out
}

// run is the snapshot's view of the run id.
func (s *snapshot) run(id string) (model.RunView, bool) {
	for _, v := range s.Runs {
		if v.ID == id {
			return v, true
		}
	}
	return model.RunView{}, false
}
