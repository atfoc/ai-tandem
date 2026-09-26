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
)

type Transcript struct {
	path     string // items.jsonl
	items    []model.Item
	version  int            // bumped on every change
	open     int            // index of the open text item, -1 if none
	tools    map[string]int // tool id → item index
	perms    map[string]int // request id → item index
	dirty    map[int]bool   // settled items not yet written
	status   model.Status
	tool     string       // tool name behind StatusTool
	permPrev model.Status // the status before the pending approval
}

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
		path:   path,
		open:   -1,
		tools:  map[string]int{},
		perms:  map[string]int{},
		dirty:  map[int]bool{},
		status: model.StatusReady,
	}
}

// Load reads items.jsonl at path. A missing file is an empty transcript. Lines are applied in
// order; a later line for the same index replaces the earlier one. A line that does not parse
// (a write cut short by a crash) is skipped.
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
			if it.RequestID != "" {
				t.perms[it.RequestID] = i
			}
		}
	}
	return t, nil
}

// Snapshot returns the version and a copy of the items.
func (t *Transcript) Snapshot() (version int, items []model.Item) {
	return t.version, append([]model.Item(nil), t.items...)
}

func (t *Transcript) Version() int { return t.version }

// Status returns the chat's status and, when it is StatusTool, the tool's name.
func (t *Transcript) Status() (model.Status, string) {
	if t.status == model.StatusTool {
		return t.status, t.tool
	}
	return t.status, ""
}

func (t *Transcript) SetStatus(s model.Status) { t.status = s }

// AddUser adds the user's message; the chat starts thinking.
func (t *Transcript) AddUser(text, context string) []Update {
	ups := t.closeOpen()
	t.status = model.StatusThinking
	u := t.push(model.Item{Kind: "user", Text: text, Context: context})
	t.dirty[u.Index] = true
	return append(ups, u)
}

// AddNote adds a note ("muted" or "error").
func (t *Transcript) AddNote(tone, text string) []Update {
	u := t.push(model.Item{Kind: "note", Tone: tone, Text: text})
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
		u := t.push(model.Item{Kind: "perm", RequestID: ev.PermID, ToolName: ev.ToolName, ToolID: ev.ToolID,
			Input: ev.Input, Subagent: ev.Sub})
		t.perms[ev.PermID] = u.Index
		return []Update{u}

	case agent.EvTurnEnd:
		ups := t.closeOpen()
		if ev.Aborted {
			ups = append(ups, t.AddNote("muted", "Stopped.")...)
		} else if ev.Error != "" {
			ups = append(ups, t.AddNote("error", ev.Error)...)
		}
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
			for i, it := range t.items {
				if it.Kind == "perm" && it.Decided == "" {
					it.Decided = "deny"
					t.dirty[i] = true
					ups = append(ups, t.set(i, it))
				}
			}
		}
		return ups
	}
	return nil
}

// Decided records the user's answer to a permission request.
func (t *Transcript) Decided(requestID string, allow bool) []Update {
	i, ok := t.perms[requestID]
	if !ok {
		return nil
	}
	it := t.items[i]
	it.Decided = "deny"
	if allow {
		it.Decided = "allow"
	}
	t.dirty[i] = true
	ups := []Update{t.set(i, it)}
	if t.status == model.StatusApproval && !t.pendingPerm() {
		t.status = t.permPrev
		if t.status == "" || t.status == model.StatusApproval {
			t.status = model.StatusTool
		}
	}
	return ups
}

// pendingPerm reports whether a permission request is still unanswered.
func (t *Transcript) pendingPerm() bool {
	for _, i := range t.perms {
		if t.items[i].Decided == "" {
			return true
		}
	}
	return false
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
// denial, decided permission, note.
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
