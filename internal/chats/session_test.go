package chats

import (
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// A subagent the app starts has its session on its record, in memory and on disk, and it is the
// one its process was started with (design D4, goal 4.7).
func TestSubagentSessionRecordedAtStart(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()

	sa, pa := e.child(id, "", "claude work")
	if pa.opts.SessionID == "" || sa.Session != pa.opts.SessionID || pa.opts.Resume {
		t.Fatalf("claude: record %q, spawn %+v", sa.Session, pa.opts)
	}
	if got := e.sub(id, sa.ID).Session; got != pa.opts.SessionID {
		t.Fatalf("claude: the record in the chat has session %q", got)
	}
	if got := e.subFile(id, sa.ID).Session; got != pa.opts.SessionID {
		t.Fatalf("claude: subagent.json has session %q", got)
	}

	pi := e.spawn(id, SpawnSubRequest{Prompt: "pi work", Kind: model.Pi})
	pp := waitChild(t, e.pi, 1)
	if pp.opts.SessionID == "" || pi.Session != pp.opts.SessionID || e.subFile(id, pi.ID).Session != pp.opts.SessionID {
		t.Fatalf("pi: record %q, spawn %+v", pi.Session, pp.opts)
	}
}

// Cursor makes its session itself: the record has it once the process reports it.
func TestCursorSubagentSessionFromEvSession(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "cursor work", Kind: model.Cursor, Model: "composer-2", Effort: "low"})
	pc := waitChild(t, e.cursor, 1)
	if sa.Session != "" || e.sub(id, sa.ID).Session != "" {
		t.Fatalf("before the process reports it: %+v", e.sub(id, sa.ID))
	}
	pc.emit(t, agent.Event{Kind: agent.EvSession, SessionID: "cur-1"})
	if got := e.sub(id, sa.ID); got.Session != "cur-1" || got.AgentID != "cur-1" {
		t.Fatalf("after EvSession: %+v", got)
	}
	if got := e.subFile(id, sa.ID).Session; got != "cur-1" {
		t.Fatalf("subagent.json has session %q", got)
	}
}

// A record written before sessions were kept has none, and says so when a resume is asked
// (scenario 10).
func TestOldRecordCannotBeResumed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.idleParent()
	sa, _ := e.child(id, "", "old work")
	e.m.Shutdown()
	rec := e.subFile(id, sa.ID)
	rec.Session, rec.Status, rec.Cause = "", model.SubStopped, model.CausePerson
	e.storeSub(id, rec)
	e.boot()

	_, err := e.m.ResumeSubagent(id, sa.ID)
	want := "subagent " + sa.ID + " cannot be resumed: its session was not recorded (it was started before the app kept subagent sessions)"
	if err == nil || err.Error() != want {
		t.Fatalf("resume of an old record: %v, want %q", err, want)
	}
	if e.claude.count() != 0 {
		t.Fatal("a process was started")
	}
}
