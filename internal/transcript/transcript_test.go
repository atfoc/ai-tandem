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
	tr.AddUser("hi", "<ui-context/>", nil)
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
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "t1", Input: json.RawMessage(`{"command":"ls"}`)})
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q", status(tr))
	}
	tr.Apply(agent.Event{Kind: agent.EvThinking})
	if status(tr) != model.StatusApproval {
		t.Fatalf("thinking overrode approval: %q", status(tr))
	}
	ups := tr.Decided("", "r1", true)
	if len(ups) != 1 || ups[0].Item.Decided != "allow" || ups[0].Item.RequestID != "r1" || ups[0].Item.ToolID != "t1" {
		t.Fatalf("updates %+v", ups)
	}
	if s, tool := tr.Status(); s != model.StatusTool || tool != "Bash" {
		t.Fatalf("status %q %q", s, tool)
	}
	if tr.Decided("", "nope", false) != nil {
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
	tr.AddUser("a", "", nil)
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

	tr.AddUser("b", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd, Error: "rate limited"})
	its = items(tr)
	if n := its[len(its)-1]; n.Kind != "note" || n.Tone != "error" || n.Text != "rate limited" {
		t.Errorf("error note %+v", n)
	}
	if status(tr) != model.StatusReady {
		t.Errorf("status %q", status(tr))
	}
}

func TestAddEnd(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c", "items.jsonl")
	tr := New(path)
	tr.AddUser("a", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvText, Text: "x"})
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	ver := tr.Version()
	ups := tr.AddEnd("p1")
	want := model.Item{Kind: "end", Point: "p1"}
	if len(ups) != 1 || ups[0].Index != 2 || !reflect.DeepEqual(ups[0].Item, want) {
		t.Fatalf("updates %+v", ups)
	}
	if tr.Version() != ver+1 || status(tr) != model.StatusReady {
		t.Errorf("version %d → %d, status %q", ver, tr.Version(), status(tr))
	}

	// A mark is settled: Flush(false) writes it.
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `{"i":2,"item":{"kind":"end","point":"p1"}}`) {
		t.Fatalf("items.jsonl:\n%s", raw)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(got), items(tr)) || !reflect.DeepEqual(items(got)[2], want) {
		t.Fatalf("loaded %+v\nwant %+v", items(got), items(tr))
	}

	// A mark with no id, added mid-turn, leaves the status alone.
	tr.AddUser("b", "", nil)
	if ups := tr.AddEnd(""); len(ups) != 1 || ups[0].Index != 4 || !reflect.DeepEqual(ups[0].Item, model.Item{Kind: "end"}) {
		t.Fatalf("updates %+v", ups)
	}
	if status(tr) != model.StatusThinking {
		t.Errorf("AddEnd changed the status to %q", status(tr))
	}
	if b, _ := json.Marshal(items(tr)[4]); string(b) != `{"kind":"end"}` {
		t.Errorf("mark %s", b)
	}
}

func TestExitWhileBusy(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "", nil)
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
	tr2.AddUser("go", "", nil)
	tr2.Apply(agent.Event{Kind: agent.EvExit})
	its = items(tr2)
	if n := its[len(its)-1]; n.Text != "The agent stopped: process ended" {
		t.Errorf("note %+v", n)
	}
}

func TestExitWhileIdle(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	n := len(items(tr))
	if ups := tr.Apply(agent.Event{Kind: agent.EvExit}); len(ups) != 0 {
		t.Errorf("updates %+v", ups)
	}
	if len(items(tr)) != n || status(tr) != model.StatusReady {
		t.Errorf("idle exit shown: %+v %q", items(tr), status(tr))
	}

	// A request still open in an idle thread (a subagent's, raised before the turn ended, whose
	// status the turn's end overwrote) is closed by the exit, with no note.
	tr.AddUser("again", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, Sub: "s1", PermID: "r1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r2", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	if !tr.PermOpen("s1", "r1") || tr.PermOpen("", "r2") || status(tr) != model.StatusReady {
		t.Fatalf("after the turn end: %+v %q", items(tr), status(tr))
	}
	n = len(items(tr))
	ups := tr.Apply(agent.Event{Kind: agent.EvExit})
	if len(ups) != 1 || ups[0].Item.Kind != "perm" || ups[0].Item.Subagent != "s1" || ups[0].Item.Decided != "deny" {
		t.Errorf("updates %+v", ups)
	}
	if tr.PermOpen("s1", "r1") || len(items(tr)) != n || status(tr) != model.StatusReady {
		t.Errorf("after the idle exit: %+v %q", items(tr), status(tr))
	}
}

func TestVersion(t *testing.T) {
	tr := newT(t)
	v := tr.Version()
	tr.AddUser("x", "", nil)
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
	tr.AddUser("hi", "ctx", nil)
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
	if tr.PermOpen("", "r1") {
		t.Error("an answered request loaded as open")
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

func TestPermFromSubagent(t *testing.T) {
	tr := newT(t)
	if status(tr) != model.StatusReady {
		t.Fatalf("status %q", status(tr))
	}
	ups := tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "x1", Sub: "s1"})
	if len(ups) != 1 || ups[0].Item.Kind != "perm" || ups[0].Item.Subagent != "s1" {
		t.Fatalf("updates %+v", ups)
	}
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q", status(tr))
	}
	if ups := tr.Decided("s1", "r1", true); len(ups) != 1 || ups[0].Item.Decided != "allow" || ups[0].Item.Subagent != "s1" {
		t.Fatalf("updates %+v", ups)
	}
	if s, tool := tr.Status(); s != model.StatusReady || tool != "" {
		t.Fatalf("status %q %q, want ready", s, tool)
	}
}

func TestTwoPendingPerms(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", Sub: "s1"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r2", ToolName: "Edit", Sub: "s2"})
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q", status(tr))
	}
	tr.Decided("s2", "r2", false)
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q after one of two decided", status(tr))
	}
	tr.Decided("s1", "r1", true)
	if status(tr) != model.StatusReady {
		t.Fatalf("status %q after both decided, want ready", status(tr))
	}
}

// Two open requests with one id and different askers are two requests: each answer marks its own
// card, and the thread leaves approval only when neither is open.
func TestSamePermIDTwoAskers(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Edit", Sub: "s2"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Read"})
	if !tr.PermOpen("s1", "p1") || !tr.PermOpen("s2", "p1") || !tr.PermOpen("", "p1") || tr.PermOpen("s3", "p1") {
		t.Fatal("open requests")
	}
	ups := tr.Decided("s2", "p1", true)
	if len(ups) != 1 || ups[0].Index != 1 || ups[0].Item.Subagent != "s2" || ups[0].Item.Decided != "allow" {
		t.Fatalf("updates %+v", ups)
	}
	if its := items(tr); its[0].Decided != "" || its[2].Decided != "" {
		t.Fatalf("another asker's card changed: %+v", its)
	}
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q after one of three answered", status(tr))
	}
	if tr.PermOpen("s2", "p1") {
		t.Error("an answered request is still open")
	}
	v := tr.Version()
	if ups := tr.Decided("s2", "p1", false); ups != nil || items(tr)[1].Decided != "allow" || tr.Version() != v {
		t.Fatalf("a second answer changed the card: %+v", ups)
	}
	if ups := tr.Decided("", "p1", false); len(ups) != 1 || ups[0].Index != 2 || ups[0].Item.Decided != "deny" {
		t.Fatalf("updates %+v", ups)
	}
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q with s1's request open", status(tr))
	}
	tr.Decided("s1", "p1", true)
	if status(tr) != model.StatusReady {
		t.Fatalf("status %q after all answered, want ready", status(tr))
	}
}

// DenyPerms closes one asker's open requests and nobody else's, and leaves approval like an answer.
func TestDenyPerms(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p2", ToolName: "Edit", Sub: "s1"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s2"})
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	ups := tr.DenyPerms("s1")
	if len(ups) != 2 || ups[0].Index != 1 || ups[1].Index != 2 || ups[0].Item.Decided != "deny" || ups[1].Item.Decided != "deny" {
		t.Fatalf("updates %+v", ups)
	}
	if !tr.dirty[1] || !tr.dirty[2] || tr.dirty[3] {
		t.Fatalf("dirty %v", tr.dirty)
	}
	if tr.PermOpen("s1", "p1") || tr.PermOpen("s1", "p2") || !tr.PermOpen("s2", "p1") || items(tr)[3].Decided != "" {
		t.Fatalf("after closing s1's: %+v", items(tr))
	}
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q with s2's request open", status(tr))
	}
	if ups := tr.DenyPerms("s1"); ups != nil {
		t.Fatalf("closing again: %+v", ups)
	}
	tr.DenyPerms("s2")
	if status(tr) != model.StatusThinking {
		t.Fatalf("status %q after the last request closed, want the one before the approval", status(tr))
	}
}

// A turn end, however the turn ended, closes the agent's own open requests as denied. A
// subagent's stays open and answerable.
func TestTurnEndClosesOwnPerms(t *testing.T) {
	for name, end := range map[string]agent.Event{
		"clean":   {Kind: agent.EvTurnEnd},
		"error":   {Kind: agent.EvTurnEnd, Error: "rate limited"},
		"aborted": {Kind: agent.EvTurnEnd, Aborted: true},
	} {
		t.Run(name, func(t *testing.T) {
			tr := newT(t)
			tr.AddUser("go", "", nil)
			tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash"})
			tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
			ups := tr.Apply(end)
			var closed bool
			for _, u := range ups {
				closed = closed || (u.Index == 1 && u.Item.Decided == "deny")
			}
			its := items(tr)
			if !closed || its[1].Decided != "deny" || !tr.dirty[1] || tr.PermOpen("", "p1") {
				t.Fatalf("the agent's own request: updates %+v items %+v", ups, its)
			}
			if its[2].Decided != "" || !tr.PermOpen("s1", "p1") {
				t.Fatalf("the subagent's request %+v", its[2])
			}
			if status(tr) != model.StatusReady {
				t.Fatalf("status %q", status(tr))
			}
			if tr.Decided("", "p1", true) != nil || items(tr)[1].Decided != "deny" {
				t.Fatal("a late answer changed the closed card")
			}
			if ups := tr.Decided("s1", "p1", true); len(ups) != 1 || ups[0].Item.Decided != "allow" {
				t.Fatalf("answer to the subagent's request %+v", ups)
			}
			if status(tr) != model.StatusReady {
				t.Fatalf("status %q after the answer", status(tr))
			}
		})
	}
}

// The stuck trace: a turn leaves the agent's own request open, a subagent then asks into the idle
// thread, and the subagent's card is answered. The thread is ready.
func TestStaleOwnPermDoesNotHoldApproval(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash"})
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "r2", ToolName: "Bash", Sub: "s1"})
	if status(tr) != model.StatusApproval {
		t.Fatalf("status %q", status(tr))
	}
	tr.Decided("s1", "r2", true)
	if status(tr) != model.StatusReady {
		t.Fatalf("status %q after the subagent's card was answered, want ready", status(tr))
	}
}

// A thread saved with open requests is loaded with every one of them closed as denied, and the
// next flush writes that. Requests raised afterwards with the same ids are new requests.
func TestLoadClosesOpenPerms(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c", "items.jsonl")
	tr := New(path)
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p0", ToolName: "Read"})
	tr.Decided("", "p0", true)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Edit", Sub: "s2"})
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Write"})
	if err := tr.Flush(true); err != nil { // shutdown writes open cards as they are
		t.Fatal(err)
	}

	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	its := items(got)
	if len(its) != 5 || its[1].Decided != "allow" {
		t.Fatalf("loaded %+v", its)
	}
	for i := 2; i < 5; i++ {
		if its[i].Decided != "deny" || !got.dirty[i] {
			t.Fatalf("item %d %+v dirty %v", i, its[i], got.dirty)
		}
	}
	if got.PermOpen("s1", "p1") || got.PermOpen("s2", "p1") || got.PermOpen("", "p1") || got.PermOpen("", "p0") {
		t.Fatal("a request is open after the load")
	}
	if status(got) != model.StatusReady {
		t.Fatalf("status %q", status(got))
	}
	if got.Decided("s1", "p1", true) != nil || items(got)[2].Decided != "deny" {
		t.Fatal("an answer changed a card closed at load")
	}
	if err := got.Flush(false); err != nil {
		t.Fatal(err)
	}
	again, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(again), items(got)) || len(again.dirty) != 0 {
		t.Fatalf("reloaded %+v dirty %v", items(again), again.dirty)
	}

	got.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
	if status(got) != model.StatusApproval || !got.PermOpen("s1", "p1") {
		t.Fatalf("a new request with an old id: status %q", status(got))
	}
	if ups := got.Decided("s1", "p1", true); len(ups) != 1 || ups[0].Index != 5 || ups[0].Item.Decided != "allow" {
		t.Fatalf("updates %+v", ups)
	}
	if items(got)[2].Decided != "deny" || status(got) != model.StatusReady {
		t.Fatalf("after the answer: %+v status %q", items(got)[2], status(got))
	}
}

// An asker that raises an id it already has open (no process does) leaves the older card closed:
// only one card can be answered under an asker and id.
func TestPermSameAskerSameID(t *testing.T) {
	tr := newT(t)
	tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", Sub: "s1"})
	ups := tr.Apply(agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Edit", Sub: "s1"})
	if len(ups) != 2 || ups[0].Index != 0 || ups[0].Item.Decided != "deny" || ups[1].Index != 1 || ups[1].Item.Decided != "" {
		t.Fatalf("updates %+v", ups)
	}
	if ups := tr.Decided("s1", "p1", true); len(ups) != 1 || ups[0].Index != 1 {
		t.Fatalf("updates %+v", ups)
	}
	if status(tr) != model.StatusReady {
		t.Fatalf("status %q", status(tr))
	}
}

func TestLinkSubagent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c", "items.jsonl")
	tr := New(path)
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Agent", Input: json.RawMessage(`{"description":"d"}`)})
	if !tr.HasTool("t1") || tr.HasTool("nope") {
		t.Fatal("HasTool")
	}
	if tr.dirty[0] {
		t.Fatal("open tool item dirty before link")
	}
	ups := tr.LinkSubagent("t1", "s1")
	if len(ups) != 1 || ups[0].Index != 0 || ups[0].Item.Subagent != "s1" || ups[0].Item.Name != "Agent" {
		t.Fatalf("updates %+v", ups)
	}
	if !tr.dirty[0] {
		t.Error("linked item not dirty")
	}
	if ups := tr.LinkSubagent("nope", "s1"); ups != nil {
		t.Errorf("unknown tool id: %+v", ups)
	}
	if ups := tr.LinkSubagent("t1", "s1"); ups != nil {
		t.Errorf("same sid again: %+v", ups)
	}
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if its := items(got); len(its) != 1 || its[0].Subagent != "s1" || its[0].ToolID != "t1" {
		t.Fatalf("loaded %+v", its)
	}
}

func TestCloseOpenAndLastText(t *testing.T) {
	tr := newT(t)
	if tr.LastText() != "" {
		t.Errorf("empty LastText %q", tr.LastText())
	}
	if ups := tr.CloseOpen(); ups != nil {
		t.Errorf("CloseOpen with nothing open: %+v", ups)
	}
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t1", ToolName: "Bash"})
	if tr.LastText() != "" {
		t.Errorf("LastText with only a tool %q", tr.LastText())
	}
	tr.Apply(agent.Event{Kind: agent.EvTextDelta, Text: "the report"})
	ups := tr.CloseOpen()
	if len(ups) != 1 || !ups[0].Item.Done || ups[0].Item.Text != "the report" {
		t.Fatalf("updates %+v", ups)
	}
	if !tr.dirty[ups[0].Index] {
		t.Error("closed text not dirty")
	}
	if tr.CloseOpen() != nil {
		t.Error("second CloseOpen changed something")
	}
	tr.Apply(agent.Event{Kind: agent.EvToolStart, ToolID: "t2", ToolName: "Read"})
	if got := tr.LastText(); got != "the report" {
		t.Errorf("LastText %q", got)
	}
}

func TestNewIsEmpty(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "subagents", "s1")
	path := filepath.Join(dir, "items.jsonl")
	tr := New(path)
	if v, its := tr.Snapshot(); v != 0 || len(its) != 0 {
		t.Fatalf("got %d %+v", v, its)
	}
	if status(tr) != model.StatusReady {
		t.Errorf("status %q", status(tr))
	}
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	if err := tr.Flush(true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("empty flush touched the disk: %v", err)
	}
	tr.Apply(agent.Event{Kind: agent.EvText, Text: "hi"})
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if its := items(got); len(its) != 1 || its[0].Text != "hi" {
		t.Fatalf("loaded %+v", its)
	}
}

func TestUserReferences(t *testing.T) {
	path := filepath.Join(t.TempDir(), "c", "items.jsonl")
	tr, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	refs := []model.Reference{{Quote: "undo", Comment: "keep it", Item: 1, Start: 4, End: 8}}
	tr.AddUser("hi", "", refs)
	if err := tr.Flush(true); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if its := items(got); len(its) != 1 || !reflect.DeepEqual(its[0].References, refs) {
		t.Fatalf("loaded %+v", its)
	}
}

func TestAddSubResult(t *testing.T) {
	tr := newT(t)
	tr.AddUser("go", "", nil)
	tr.Apply(agent.Event{Kind: agent.EvTurnEnd})
	v := tr.Version()

	ups := tr.AddSubResult("s1")
	if len(ups) != 1 || ups[0].Index != 1 || !reflect.DeepEqual(ups[0].Item, model.Item{Kind: "subresult", Subagent: "s1"}) {
		t.Fatalf("updates %+v", ups)
	}
	if tr.Version() != v+1 || status(tr) != model.StatusReady || tr.Sent() != 1 {
		t.Fatalf("version %d status %q sent %d", tr.Version(), status(tr), tr.Sent())
	}
	// One row per subagent, ever.
	if ups := tr.AddSubResult("s1"); ups != nil || tr.Version() != v+1 {
		t.Fatalf("second row %+v", ups)
	}
	if ups := tr.AddSubResult("s2"); len(ups) != 1 || ups[0].Index != 2 {
		t.Fatalf("another subagent's row %+v", ups)
	}

	// Written at once, like a user item or a note, and known again after a load.
	if err := tr.Flush(false); err != nil {
		t.Fatal(err)
	}
	back, err := Load(tr.path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(back), items(tr)) {
		t.Fatalf("loaded %+v, want %+v", items(back), items(tr))
	}
	if ups := back.AddSubResult("s2"); ups != nil || len(items(back)) != 3 {
		t.Fatalf("row added again after a load %+v", ups)
	}
}

func TestWriteItems(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "c")
	path := filepath.Join(dir, "items.jsonl")
	res := "42 files"
	want := []model.Item{
		{Kind: "user", Text: "hi", Context: "ctx"},
		{Kind: "tool", ToolID: "t1", Name: "Agent", Input: json.RawMessage(`{"a":1}`), Result: &res, Subagent: "abc123"},
		{}, // a hole
		{Kind: "text", Text: "done", Done: true},
		{Kind: "end", Point: "p1"},
		{Kind: "user", Text: "more", References: []model.Reference{{Quote: "done", Comment: "why", Item: 3, Start: 0, End: 4}}},
		{Kind: "tool", ToolID: "t2", Name: "Read"}, // still running
		{}, // a trailing hole
	}
	// A file already there is replaced, not appended to.
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"i":9,"item":{"kind":"note","text":"old"}}`+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := WriteItems(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(items(got), want[:7]) {
		t.Fatalf("loaded %+v\nwant %+v", items(got), want[:7])
	}
	if got.tools["t1"] != 1 || got.tools["t2"] != 6 {
		t.Errorf("tools map %+v", got.tools)
	}

	// One line per item, in index order, none for a hole.
	raw, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n")
	var idx []int
	for _, l := range lines {
		var ln line
		if err := json.Unmarshal([]byte(l), &ln); err != nil {
			t.Fatalf("line %q: %v", l, err)
		}
		idx = append(idx, ln.I)
	}
	if !reflect.DeepEqual(idx, []int{0, 1, 3, 4, 5, 6}) {
		t.Fatalf("indexes %v:\n%s", idx, raw)
	}
	if fi, err := os.Stat(path); err != nil || fi.Mode().Perm() != 0600 {
		t.Errorf("mode %v %v", fi.Mode(), err)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Errorf("files left beside items.jsonl: %v", ents)
	}
}

func TestWriteItemsNothingToWrite(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "c")
	path := filepath.Join(dir, "items.jsonl")
	for _, its := range [][]model.Item{nil, {{}, {}}} {
		if err := WriteItems(path, its); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("WriteItems(%+v) touched the disk: %v", its, err)
		}
	}
	// An existing file is left alone.
	if err := WriteItems(path, []model.Item{{Kind: "note", Text: "kept"}}); err != nil {
		t.Fatal(err)
	}
	if err := WriteItems(path, nil); err != nil {
		t.Fatal(err)
	}
	if its := items(mustLoad(t, path)); len(its) != 1 || its[0].Text != "kept" {
		t.Fatalf("items %+v", its)
	}
}

func mustLoad(t *testing.T, path string) *Transcript {
	t.Helper()
	tr, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}
