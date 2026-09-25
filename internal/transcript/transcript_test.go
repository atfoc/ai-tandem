package transcript

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func newT(t *testing.T) *Transcript {
	t.Helper()
	tr, err := Load(filepath.Join(t.TempDir(), "chat", "items.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func status(tr *Transcript) model.Status { s, _ := tr.Status(); return s }

func items(tr *Transcript) []model.Item { _, it := tr.Snapshot(); return it }

func TestClaudeShapedSequence(t *testing.T) {
	tr := newT(t)
	tr.AddUser("hi", "<ui-context/>")
	var seen []model.Status
	step := func(ev agent.Event) {
		tr.Apply(ev)
		if s := status(tr); len(seen) == 0 || seen[len(seen)-1] != s {
			seen = append(seen, s)
		}
	}
	step(agent.Event{Kind: agent.EvThinking})
	step(agent.Event{Kind: agent.EvTextStart, MsgID: "m1"})
	for _, d := range []string{"Hel", "lo ", "there"} {
		step(agent.Event{Kind: agent.EvTextDelta, Text: d})
	}
	step(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Read"})
	if s, tool := tr.Status(); s != model.StatusTool || tool != "Read" {
		t.Fatalf("status %q %q", s, tool)
	}
	step(agent.Event{Kind: agent.EvToolInputDelta, ToolID: "t1", Text: `{"pa`})
	step(agent.Event{Kind: agent.EvToolInputDelta, ToolID: "t1", Text: `th":"x"}`})
	step(agent.Event{Kind: agent.EvToolInput, ToolID: "t1", ToolName: "Read", Input: json.RawMessage(`{"path":"x"}`)})
	step(agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "contents"})
	step(agent.Event{Kind: agent.EvTurnEnd})

	want := []model.Status{model.StatusThinking, model.StatusWriting, model.StatusTool, model.StatusThinking, model.StatusReady}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("statuses %v, want %v", seen, want)
	}
	its := items(tr)
	if len(its) != 3 {
		t.Fatalf("items %+v", its)
	}
	if its[0].Kind != "user" || its[0].Text != "hi" || its[0].Context != "<ui-context/>" {
		t.Errorf("user %+v", its[0])
	}
	if its[1].Kind != "text" || its[1].Text != "Hello there" || !its[1].Done {
		t.Errorf("text %+v", its[1])
	}
	tool := its[2]
	if tool.Kind != "tool" || tool.ToolID != "t1" || tool.Name != "Read" || string(tool.Input) != `{"path":"x"}` ||
		tool.Partial != `{"path":"x"}` || tool.Result == nil || *tool.Result != "contents" || tool.IsError {
		t.Errorf("tool %+v", tool)
	}
	if _, tool := tr.Status(); tool != "" {
		t.Errorf("status tool %q after turn end", tool)
	}
}

func TestUnstreamedText(t *testing.T) {
	tr := newT(t)
	ups := tr.Apply(agent.Event{Kind: agent.EvText, MsgID: "m", Text: "whole"})
	if len(ups) != 1 || ups[0].Index != 0 {
		t.Fatalf("updates %+v", ups)
	}
	its := items(tr)
	if len(its) != 1 || its[0].Kind != "text" || its[0].Text != "whole" || !its[0].Done {
		t.Fatalf("items %+v", its)
	}
	if !tr.dirty[0] {
		t.Error("EvText item not dirty")
	}
}

func TestDeltaWithoutStart(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "a"})
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "b"})
	its := items(tr)
	if len(its) != 1 || its[0].Text != "ab" || its[0].Done {
		t.Fatalf("items %+v", its)
	}
}

func TestToolInputWithoutStart(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvToolInput, ToolID: "t", ToolName: "mcp__board__draw", Input: json.RawMessage(`{}`)})
	its := items(tr)
	if len(its) != 1 || its[0].Kind != "tool" || its[0].Name != "mcp__board__draw" {
		t.Fatalf("items %+v", its)
	}
	if s, tool := tr.Status(); s != model.StatusTool || tool != "mcp__board__draw" {
		t.Fatalf("status %q %q", s, tool)
	}
}

func TestPermission(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "")
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1", Input: json.RawMessage(`{"command":"ls"}`)})
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q", status(tr))
	}
	tr.Apply(agent.Event{Kind: agent.EvThinking})
	if status(tr) != model.StatusApproval {
		t.Fatalf("thinking overrode approval: %q", status(tr))
	}
	ups := tr.Decided("r1", true)
	if len(ups) != 1 || ups[0].Item.Decided != "allow" || ups[0].Item.RequestID != "r1" || ups[0].Item.ToolID != "t1" {
		t.Fatalf("updates %+v", ups)
	}
	if s, tool := tr.Status(); s != model.StatusTool || tool != "Bash" {
		t.Fatalf("status %q %q", s, tool)
	}
	if tr.Decided("nope", false) != nil {
		t.Error("unknown request id changed something")
	}
}

func TestDeniedTool(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvToolDenied, ToolID: "t1"})
	if its := items(tr); !its[0].Denied || !tr.dirty[0] {
		t.Fatalf("items %+v", its)
	}
}

func TestTurnEndNotes(t *testing.T) {
	tr := newT(t)
	tr.AddUser("a", "")
	tr.Apply(agent.Event{Kind: agent.EvTextStart})
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "x"})
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	its := items(tr)
	if !its[1].Done {
		t.Error("open text not closed")
	}
	if n := its[2]; n.Kind != "note" || n.Tone != "muted" || n.Text != "Stopped." {
		t.Errorf("aborted note %+v", n)
	}
	if status(tr) != model.StatusReady {
		t.Errorf("status %q", status(tr))
	}

	tr.AddUser("b", "")
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited"})
	its = items(tr)
	if n := its[len(its)-1]; n.Kind != "note" || n.Tone != "error" || n.Text != "rate limited" {
		t.Errorf("error note %+v", n)
	}
	if status(tr) != model.StatusReady {
		t.Errorf("status %q", status(tr))
	}
}

func TestExitWhileBusy(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "")
	tr.Apply(agent.Event{Kind: agent.EvTextStart})
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "x"})
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1"})
	tr.Apply(agent.Event{Kind: agent.EvExit, ExitErr: "signal: killed"})
	if status(tr) != model.StatusStopped {
		t.Fatalf("status %q", status(tr))
	}
	its := items(tr)
	var note *model.Item
	for i := range its {
		if its[i].Kind == "note" {
			note = &its[i]
		}
		if its[i].Kind == "perm" && its[i].Decided != "deny" {
			t.Errorf("perm not denied: %+v", its[i])
		}
	}
	if note == nil || note.Tone != "error" || note.Text != "The agent stopped: signal: killed" {
		t.Errorf("note %+v", note)
	}

	tr2 := newT(t)
	tr2.AddUser("go", "")
	tr2.Apply(agent.Event{Kind: agent.EvExit})
	its = items(tr2)
	if n := its[len(its)-1]; n.Text != "The agent stopped: process ended" {
		t.Errorf("note %+v", n)
	}
}

func TestExitWhileIdle(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "")
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	n := len(items(tr))
	if ups := tr.Apply(agent.Event{Kind: agent.EvExit}); len(ups) != 0 {
		t.Errorf("updates %+v", ups)
	}
	if len(items(tr)) != n || status(tr) != model.StatusReady {
		t.Errorf("idle exit shown: %+v %q", items(tr), status(tr))
	}
}

func TestVersion(t *testing.T) {
	tr := newT(t)
	v := tr.Version()
	tr.AddUser("x", "")
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "a"})
	if tr.Version() <= v {
		t.Error("version not bumped")
	}
	if ver, _ := tr.Snapshot(); ver != tr.Version() {
		t.Error("snapshot version differs")
	}
}

func TestFlushLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c", "items.jsonl")
	tr, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	tr.AddUser("hi", "ctx")
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Read", Input: json.RawMessage(`{"a":1}`)})
	tr.Apply(agent.Event{Kind: agent.EvToolResult, ToolID: "t1", Result: "r", IsError: true})
	tr.Apply(agent.Event{Kind: agent.EvTextStart})
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "streaming"})
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}

	// The open text is not written by Flush(false).
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if its := items(got); len(its) != 2 {
		t.Fatalf("after Flush(false): %+v", its)
	}
	if s := status(got); s != model.StatusReady {
		t.Errorf("loaded status %q", s)
	}

	// Flush(true) writes it.
	if err := tr.Flush(true); err != nil {
		t.Fatal(err)
	}
	got, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(got), items(tr)) {
		t.Fatalf("loaded %+v\nwant %+v", items(got), items(tr))
	}
	if its := items(got); its[2].Text != "streaming" || its[2].Done {
		t.Errorf("open text %+v", its[2])
	}

	// Closing the text writes a later line for index 2, which wins on load.
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: " done"})
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if n := strings.Count(string(raw), `"i":2,`); n != 2 {
		t.Errorf("want 2 lines for index 2, got %d:\n%s", n, raw)
	}
	got, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(got), items(tr)) {
		t.Fatalf("loaded %+v\nwant %+v", items(got), items(tr))
	}
	if its := items(got); its[2].Text != "streaming done" || !its[2].Done {
		t.Errorf("text %+v", its[2])
	}

	// A second flush with nothing dirty writes nothing.
	before, _ := os.ReadFile(path)
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	if len(before) != len(after) {
		t.Error("empty flush wrote lines")
	}

	// Loaded tool and perm maps are rebuilt.
	if _, ok := got.tools["t1"]; !ok {
		t.Error("tools map not rebuilt")
	}
}

func TestLoadLaterLineWins(t *testing.T) {
	path := filepath.Join(t.TempDir(), "items.jsonl")
	data := `{"i":0,"item":{"kind":"user","text":"hi"}}
{"i":1,"item":{"kind":"perm","requestId":"r1","toolName":"Bash"}}
{"i":1,"item":{"kind":"perm","requestId":"r1","toolName":"Bash","decided":"allow"}}
{"i":0,"item":{"kind":"user","text":"hello"}}
`
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	tr, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	its := items(tr)
	if len(its) != 2 || its[0].Text != "hello" || its[1].Decided != "allow" {
		t.Fatalf("items %+v", its)
	}
	if tr.perms["r1"] != 1 {
		t.Error("perms map not rebuilt")
	}
}

func TestLoadMissing(t *testing.T) {
	tr, err := Load(filepath.Join(t.TempDir(), "none.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if v, its := tr.Snapshot(); v != 0 || len(its) != 0 {
		t.Fatalf("got %d %+v", v, its)
	}
}
