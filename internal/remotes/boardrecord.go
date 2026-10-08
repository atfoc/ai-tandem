package remotes

import (
	"regexp"

	"ai-whiteboard/internal/model"
)

// BoardRecord is what this server keeps of a board that lives on another server. It is the
// file's shape. The board's scene stays on that server, and so does the secret: a record holds
// the last view, the board's place in this server's sidebar and its archive mark. This server
// made the id, and the board has the same one there.
type BoardRecord struct {
	ID       string      `json:"id"`
	Entry    string      `json:"entry"`               // the entry's id
	Group    string      `json:"group"`               // local place: a group id or model.Ungrouped
	Archived bool        `json:"archived,omitempty"`  // the remote server's mark, as last received
	Op       string      `json:"archiveOp,omitempty"` // the local archive action that archived it; "" for a mark taken from there
	Pending  string      `json:"pending,omitempty"`   // "archive" | "unarchive": not yet confirmed there
	Gone     bool        `json:"gone,omitempty"`
	Rev      int64       `json:"rev,omitempty"` // the last scene revision known of the board's server, as of the last flush
	View     model.Board `json:"view"`          // the board as its server sent it last. No scene.
}

// boardIDForm is the form of a board's id, that of model.NewID("b_"): it names the record's
// file and is put in the path of the calls for the board.
var boardIDForm = regexp.MustCompile(`^b_[a-z0-9]{8}$`)

// validBoardID reports whether id can be a board record's.
func validBoardID(id string) bool { return boardIDForm.MatchString(id) }

// boardViewOf is the view of a board record as a page gets it, in events and in answers alike:
// the board as its server sent it, with the board's place and mark as this server keeps them
// (a pending change wins over the mark). What only the board's server needs, the mark of its
// API client and the board it came from, is cleared.
func boardViewOf(rec BoardRecord) model.Board {
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
	v.Client, v.Origin = "", ""
	return v
}

// apply takes a board that came from the record's server: in a board event, in an answer, or,
// with snapshot set, in the snapshot of a stream's start. The rules are those of a run record
// (RunRecord.apply): the board is there, so the record is not gone; the mark is the server's,
// and a pending change that equals it is confirmed by it; at a snapshot a pending change wins
// and stays, to be passed on. durable says that more than the view changed, so the file is
// written at once.
func (rec *BoardRecord) apply(v model.Board, snapshot bool) (durable bool) {
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
