package chats

import (
	"errors"

	"ai-whiteboard/internal/model"
)

// The point rules: where in a branch's items a new branch or a fork may start. A point is an item
// count: the items before it are kept. The web client has the same rules in
// web/src/logic/forkpoints.ts. items is one branch's final item list; an item of kind "" is a hole
// (an index no line of items.jsonl gave).

var ErrBadPoint = errors.New("a branch or a fork can't start at that point")

// turnEnd is the point right after the end mark of the turn whose last reply is the text item at
// i: nothing but notes and holes may lie between the two. 0 = the item is not its turn's last
// reply.
func turnEnd(items []model.Item, i int) int {
	if i < 0 || i >= len(items) || items[i].Kind != "text" || !items[i].Done {
		return 0
	}
	for j := i + 1; j < len(items); j++ {
		switch items[j].Kind {
		case "note", "":
			continue
		case "end":
			return j + 1
		}
		return 0
	}
	return 0
}

// cutBefore is the point that drops the user item at u and all after it: right after the last end
// mark before it, or 0 when nothing was said before it. ok is false when a reply or a tool call
// lies between that mark and u (a turn that ended without a mark), and when u is no user item.
func cutBefore(items []model.Item, u int) (count int, ok bool) {
	if u < 0 || u >= len(items) || items[u].Kind != "user" {
		return 0, false
	}
	for m := u - 1; m >= 0; m-- {
		switch items[m].Kind {
		case "end":
			return m + 1, true
		case "text", "tool":
			return 0, false
		}
	}
	return 0, true
}

// sessionEnd reports whether nothing was said in the session past count: no user, text, tool or
// end item at an index >= count.
func sessionEnd(items []model.Item, count int) bool {
	for i := max(count, 0); i < len(items); i++ {
		switch items[i].Kind {
		case "user", "text", "tool", "end":
			return false
		}
	}
	return true
}

// nextMark is the first end mark at an index >= count.
func nextMark(items []model.Item, count int) (model.Item, bool) {
	if m := markFrom(items, count); m >= 0 {
		return items[m], true
	}
	return model.Item{}, false
}

// markFrom is the index of the first end mark at an index >= count; -1 = none.
func markFrom(items []model.Item, count int) int {
	for i := max(count, 0); i < len(items); i++ {
		if items[i].Kind == "end" {
			return i
		}
	}
	return -1
}

// pointOK reports whether a new branch or a fork may start at count by the id rules alone; busy,
// archived and legacy are the caller's to check. The start of the chat needs the id on the first
// end mark, every other point the id on the mark right before it.
func pointOK(a model.AgentKind, items []model.Item, count int) bool {
	if count < 0 || count > len(items) {
		return false
	}
	if count == 0 {
		first, ok := nextMark(items, 0)
		return ok && first.Point != ""
	}
	if it := items[count-1]; it.Kind != "end" || it.Point == "" {
		return false
	}
	if a != model.Pi || sessionEnd(items, count) {
		return true
	}
	// pi forks the end of a turn with the id on the next turn's mark, so that mark must close the
	// turn that starts at count. After a turn cut without a mark the next mark is a later turn's,
	// and a fork with its id would take in the cut turn. So exactly one turn lies between count
	// and the mark: one message of the human's with no reply or tool call ahead of it (the rows of
	// the subagent results it carries are), or none, which is a turn the app started to deliver
	// subagent results. The app starts one only on a live process, so never after a cut turn, and
	// its message is a user message to pi like any other: the mark carries its id. A mark that
	// repeats the id before count is no new turn.
	m := markFrom(items, count)
	if m < 0 || items[m].Point == "" {
		return false
	}
	users, early := 0, false // early: a reply or a tool call ahead of the first message
	for _, it := range items[count:m] {
		switch it.Kind {
		case "user":
			users++
		case "text", "tool":
			early = early || users == 0
		}
	}
	if users == 0 {
		return items[m].Point != items[count-1].Point
	}
	return users == 1 && !early
}
