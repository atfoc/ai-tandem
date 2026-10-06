// Package transcript turns agent events into a chat's items (the Go port of the prototype's
// web/src/chat.ts reducer) and keeps them in items.jsonl.
//
// A Transcript is not safe for concurrent use; the chat manager serializes calls to it.
package transcript

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

type Transcript struct {
	path     string // items.jsonl
	items    []model.Item
	version  int             // bumped on every change
	open     int             // index of the open text item, -1 if none
	tools    map[string]int  // tool id → item index
	perms    map[permKey]int // the open permission requests → item index
	results  map[string]int  // sid → index of its subresult item
	dirty    map[int]bool    // settled items not yet written
	status   model.Status
	tool     string       // tool name behind StatusTool
	permPrev model.Status // the status before the pending approval
}

// permKey identifies a permission request: who asked (a subagent's sid, "" for the chat's own
// agent) together with the id the asker's process gave it. The id alone repeats within a thread:
// Cursor numbers its requests per process, and every app-spawned subagent is a process of its own.
type permKey struct{ asker, id string }

// Update is one changed item, sent to clients.
type Update struct {
	Index int        `json:"index"`
	Item  model.Item `json:"item"`
}

// line is one line of items.jsonl.
type line struct {
	I    int        `json:"i"`
	Item model.Item `json:"item"`
}

// New returns an empty transcript kept at path. Nothing is written until Flush has something to
// write.
func New(path string) *Transcript {
	return &Transcript{
		path:    path,
		open:    -1,
		tools:   map[string]int{},
		perms:   map[permKey]int{},
		results: map[string]int{},
		dirty:   map[int]bool{},
		status:  model.StatusReady,
	}
}

// Load reads items.jsonl at path. A missing file is an empty transcript. Lines are applied in
// order; a later line for the same index replaces the earlier one. A line that does not parse
// (a write cut short by a crash) is skipped. A permission request the file has open is closed as
// denied, to be written by the next Flush: a thread is loaded before any process of its chat
// exists, so nothing could answer it.
func Load(path string) (*Transcript, error) {
	t := New(path)
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return t, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	r := bufio.NewReader(f)
	for {
		b, err := r.ReadBytes('\n')
		if b = bytes.TrimSpace(b); len(b) > 0 {
			var l line
			if json.Unmarshal(b, &l) == nil && l.I >= 0 {
				for len(t.items) <= l.I {
					t.items = append(t.items, model.Item{})
				}
				t.items[l.I] = l.Item
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	for i, it := range t.items {
		switch it.Kind {
		case "tool":
			if it.ToolID != "" {
				t.tools[it.ToolID] = i
			}
		case "perm":
			if it.Decided == "" {
				it.Decided = "deny"
				t.items[i] = it
				t.dirty[i] = true
			}
		case "subresult":
			t.results[it.Subagent] = i
		}
	}
	return t, nil
}

// WriteItems writes a clean items.jsonl from a final item list: one line per item under its own
// index (its position in items); empty items (holes) are skipped. A file already at path is
// replaced. A list with nothing to write writes no file and leaves an existing one alone.
func WriteItems(path string, items []model.Item) error {
	var buf bytes.Buffer
	for i, it := range items {
		if it.Kind == "" {
			continue
		}
		b, err := json.Marshal(line{I: i, Item: it})
		if err != nil {
			return err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if buf.Len() == 0 {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return store.WriteFileAtomic(path, buf.Bytes(), 0600)
}

// Snapshot returns the version and a copy of the items.
func (t *Transcript) Snapshot() (version int, items []model.Item) {
	return t.version, append([]model.Item(nil), t.items...)
}

func (t *Transcript) Version() int { return t.version }

// Sent is the number of user messages in the thread.
func (t *Transcript) Sent() int {
	n := 0
	for _, it := range t.items {
		if it.Kind == "user" {
			n++
		}
	}
	return n
}

// Status returns the chat's status and, when it is StatusTool, the tool's name.
func (t *Transcript) Status() (model.Status, string) {
	if t.status == model.StatusTool {
		return t.status, t.tool
	}
	return t.status, ""
}

func (t *Transcript) SetStatus(s model.Status) { t.status = s }

// AddUser adds the user's message, with the quotes it carries; the chat starts thinking.
func (t *Transcript) AddUser(text, context string, refs []model.Reference) []Update {
	ups := t.closeOpen()
	t.status = model.StatusThinking
	u := t.push(model.Item{Kind: "user", Text: text, Context: context, References: refs})
	t.dirty[u.Index] = true
	return append(ups, u)
}

// AddNote adds a note ("muted" or "error").
func (t *Transcript) AddNote(tone, text string) []Update {
	u := t.push(model.Item{Kind: "note", Tone: tone, Text: text})
	t.dirty[u.Index] = true
	return []Update{u}
}

// AddSubResult adds the row of subagent sid's result, carried to the agent by the app. A subagent
// has one row, ever: a second call for the same sid adds nothing. The status is left alone.
func (t *Transcript) AddSubResult(sid string) []Update {
	if _, ok := t.results[sid]; ok {
		return nil
	}
	u := t.push(model.Item{Kind: "subresult", Subagent: sid})
	t.results[sid] = u.Index
	t.dirty[u.Index] = true
	return []Update{u}
}

// HasSubResult reports whether the thread has the row of subagent sid's result.
func (t *Transcript) HasSubResult(sid string) bool {
	_, ok := t.results[sid]
	return ok
}

// AddEnd adds the end mark of a turn, carrying the provider's fork-point id (may be ""). The mark
// is a settled item: Flush writes it.
func (t *Transcript) AddEnd(point string) []Update {
	u := t.push(model.Item{Kind: "end", Point: point})
	t.dirty[u.Index] = true
	return []Update{u}
}

// Apply folds one agent event into the items and the status. Usage events are not kept here.
func (t *Transcript) Apply(ev agent.Event) []Update {
	switch ev.Kind {
	case agent.EvThinking:
		if t.status != model.StatusApproval {
			t.status = model.StatusThinking
		}
		return nil

	case agent.EvTextStart:
		ups := t.closeOpen()
		t.status = model.StatusWriting
		u := t.push(model.Item{Kind: "text"})
		t.open = u.Index
		return append(ups, u)

	case agent.EvTextDelta:
		var ups []Update
		if t.open < 0 {
			ups = t.Apply(agent.Event{Kind: agent.EvTextStart, MsgID: ev.MsgID})
		}
		it := t.items[t.open]
		it.Text += ev.Text
		t.status = model.StatusWriting
		return append(ups, t.set(t.open, it))

	case agent.EvText:
		ups := t.closeOpen()
		u := t.push(model.Item{Kind: "text", Text: ev.Text, Done: true})
		t.dirty[u.Index] = true
		return append(ups, u)

	case agent.EvToolStart:
		ups := t.closeOpen()
		t.status = model.StatusTool
		t.tool = ev.ToolName
		u := t.push(model.Item{Kind: "tool", ToolID: ev.ToolID, Name: ev.ToolName, Input: ev.Input})
		t.tools[ev.ToolID] = u.Index
		return append(ups, u)

	case agent.EvToolInputDelta:
		i, ok := t.tools[ev.ToolID]
		if !ok {
			return nil
		}
		it := t.items[i]
		it.Partial += ev.Text
		return []Update{t.set(i, it)}

	case agent.EvToolInput:
		i, ok := t.tools[ev.ToolID]
		if !ok {
			return t.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: ev.ToolID, ToolName: ev.ToolName, Input: ev.Input})
		}
		it := t.items[i]
		it.Input = ev.Input
		it.Name = ev.ToolName
		return []Update{t.set(i, it)}

	case agent.EvToolResult:
		t.status = model.StatusThinking
		i, ok := t.tools[ev.ToolID]
		if !ok {
			return nil
		}
		it := t.items[i]
		res := ev.Result
		it.Result = &res
		it.IsError = ev.IsError
		t.dirty[i] = true
		return []Update{t.set(i, it)}

	case agent.EvToolDenied:
		i, ok := t.tools[ev.ToolID]
		if !ok {
			return nil
		}
		it := t.items[i]
		it.Denied = true
		t.dirty[i] = true
		return []Update{t.set(i, it)}

	case agent.EvPermRequest:
		if t.status != model.StatusApproval {
			t.permPrev = t.status
		}
		t.status = model.StatusApproval
		k := permKey{ev.Sub, ev.PermID}
		var ups []Update
		if i, ok := t.perms[k]; ok {
			ups = append(ups, t.deny(i)) // only the new request can be answered under this asker and id
		}
		u := t.push(model.Item{Kind: "perm", RequestID: ev.PermID, ToolName: ev.ToolName, ToolID: ev.ToolID,
			Input: ev.Input, Subagent: ev.Sub})
		t.perms[k] = u.Index
		return append(ups, u)

	case agent.EvTurnEnd:
		ups := t.closeOpen()
		if ev.Aborted {
			ups = append(ups, t.AddNote("muted", "Stopped.")...)
		} else if ev.Error != "" {
			ups = append(ups, t.AddNote("error", ev.Error)...)
		}
		// The turn that raised the agent's own requests is over, however it ended. A subagent's
		// request stays open: the subagent may still be running.
		ups = append(ups, t.denyPerms(func(k permKey) bool { return k.asker == "" })...)
		t.status = model.StatusReady
		t.tool = ""
		return ups

	case agent.EvExit:
		ups := t.closeOpen()
		if t.busy() {
			msg := ev.ExitErr
			if msg == "" {
				msg = "process ended"
			}
			ups = append(ups, t.AddNote("error", "The agent stopped: "+msg)...)
			t.status = model.StatusStopped
			t.tool = ""
		}
		// Busy or not: the process held its own requests and its subagents', and every subagent
		// ends with it. An idle chat can have one open too: a turn's end closes only the agent's own.
		return append(ups, t.denyPerms(func(permKey) bool { return true })...)
	}
	return nil
}

// PermOpen reports whether asker's permission request requestID is open: raised, and neither
// answered nor closed. asker is the subagent that asked, "" for the chat's own agent.
func (t *Transcript) PermOpen(asker, requestID string) bool {
	_, ok := t.perms[permKey{asker, requestID}]
	return ok
}

// Decided records the user's answer to asker's open permission request requestID, on that
// request's card and no other. A request that is not open changes nothing.
func (t *Transcript) Decided(asker, requestID string, allow bool) []Update {
	k := permKey{asker, requestID}
	i, ok := t.perms[k]
	if !ok {
		return nil
	}
	delete(t.perms, k)
	it := t.items[i]
	it.Decided = "deny"
	if allow {
		it.Decided = "allow"
	}
	t.dirty[i] = true
	ups := []Update{t.set(i, it)}
	t.leaveApproval()
	return ups
}

// DenyPerms closes as denied every permission request asker still has open (a subagent that
// reached a final status). The requests of other askers stay open, whatever their ids.
func (t *Transcript) DenyPerms(asker string) []Update {
	ups := t.denyPerms(func(k permKey) bool { return k.asker == asker })
	t.leaveApproval()
	return ups
}

// leaveApproval puts the status back to what it was before the approval, once no request of any
// asker is open.
func (t *Transcript) leaveApproval() {
	if t.status != model.StatusApproval || len(t.perms) > 0 {
		return
	}
	t.status = t.permPrev
	if t.status == "" || t.status == model.StatusApproval {
		t.status = model.StatusTool
	}
}

// denyPerms closes as denied the open requests match accepts, in thread order. The status is the
// caller's.
func (t *Transcript) denyPerms(match func(permKey) bool) []Update {
	var idx []int
	for k, i := range t.perms {
		if match(k) {
			idx = append(idx, i)
			delete(t.perms, k)
		}
	}
	sort.Ints(idx)
	var ups []Update
	for _, i := range idx {
		ups = append(ups, t.deny(i))
	}
	return ups
}

// deny marks the permission item at i denied.
func (t *Transcript) deny(i int) Update {
	it := t.items[i]
	it.Decided = "deny"
	t.dirty[i] = true
	return t.set(i, it)
}

// HasTool reports whether the thread has a tool item with this id.
func (t *Transcript) HasTool(id string) bool {
	_, ok := t.tools[id]
	return ok
}

// LinkSubagent sets the subagent started by tool call toolID on its item and marks it dirty.
func (t *Transcript) LinkSubagent(toolID, sid string) []Update {
	i, ok := t.tools[toolID]
	if !ok || t.items[i].Subagent == sid {
		return nil
	}
	it := t.items[i]
	it.Subagent = sid
	t.dirty[i] = true
	return []Update{t.set(i, it)}
}

// CloseOpen marks the open text item done (a subagent's thread, when it ends).
func (t *Transcript) CloseOpen() []Update { return t.closeOpen() }

// LastText is the text of the last text item; "" when there is none.
func (t *Transcript) LastText() string {
	for i := len(t.items) - 1; i >= 0; i-- {
		if t.items[i].Kind == "text" {
			return t.items[i].Text
		}
	}
	return ""
}

// Len is the number of items in the thread.
func (t *Transcript) Len() int { return len(t.items) }

// LastTextSince is the text of the last text item at index from or later; "" when there is none.
// It is LastText for the part of the thread a message and what followed it take.
func (t *Transcript) LastTextSince(from int) string {
	for i := len(t.items) - 1; i >= from && i >= 0; i-- {
		if t.items[i].Kind == "text" {
			return t.items[i].Text
		}
	}
	return ""
}

// LastTool counts the thread's tool items and returns the last of them; its Kind is "" when
// there is none.
func (t *Transcript) LastTool() (n int, last model.Item) {
	for i := range t.items {
		if t.items[i].Kind == "tool" {
			n++
			last = t.items[i]
		}
	}
	return n, last
}

// Flush appends a line for every settled item not yet written and, when all is set (shutdown),
// for every item still open.
func (t *Transcript) Flush(all bool) error {
	idx := make([]int, 0, len(t.dirty))
	for i := range t.dirty {
		idx = append(idx, i)
	}
	if all {
		for i, it := range t.items {
			if !t.dirty[i] && !settled(it) {
				idx = append(idx, i)
			}
		}
	}
	if len(idx) == 0 {
		return nil
	}
	sort.Ints(idx)
	var buf bytes.Buffer
	for _, i := range idx {
		b, err := json.Marshal(line{I: i, Item: t.items[i]})
		if err != nil {
			return err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := os.MkdirAll(filepath.Dir(t.path), 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(t.path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0600)
	if err != nil {
		return err
	}
	if _, err := f.Write(buf.Bytes()); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	t.dirty = map[int]bool{}
	return nil
}

// settled reports whether an item is final: user item, finished text, tool with a result or
// denial, decided permission, note, subagent result row, end mark.
func settled(it model.Item) bool {
	switch it.Kind {
	case "text":
		return it.Done
	case "tool":
		return it.Result != nil || it.Denied
	case "perm":
		return it.Decided != ""
	}
	return true
}

func (t *Transcript) busy() bool {
	switch t.status {
	case model.StatusThinking, model.StatusWriting, model.StatusTool, model.StatusApproval:
		return true
	}
	return false
}

func (t *Transcript) set(i int, it model.Item) Update {
	t.items[i] = it
	t.version++
	return Update{Index: i, Item: it}
}

func (t *Transcript) push(it model.Item) Update {
	t.items = append(t.items, it)
	t.version++
	return Update{Index: len(t.items) - 1, Item: it}
}

// closeOpen marks the open text item done.
func (t *Transcript) closeOpen() []Update {
	if t.open < 0 {
		return nil
	}
	i := t.open
	t.open = -1
	it := t.items[i]
	it.Done = true
	t.dirty[i] = true
	return []Update{t.set(i, it)}
}
