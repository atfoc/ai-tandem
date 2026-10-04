package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

func (e *env) spawn(id string, req SpawnSubRequest) model.Subagent {
	e.t.Helper()
	sa, err := e.m.SpawnSubagent(id, req)
	if err != nil {
		e.t.Fatal(err)
	}
	return sa
}

func waitChild(t *testing.T, sp *fakeSpawner, n int) *fakeAgent {
	t.Helper()
	waitFor(t, "child process", func() bool { return sp.count() >= n })
	a := sp.last(t)
	waitFor(t, "child send", func() bool { return len(a.sent()) > 0 })
	return a
}

func agentClosed(a *fakeAgent) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.closed
}

func agentDecides(a *fakeAgent) []decision {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]decision(nil), a.decides...)
}

// agentStrays is the answers a refused: for requests it had not raised, or had answered.
func agentStrays(a *fakeAgent) []decision {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]decision(nil), a.strays...)
}

type gatedSpawner struct {
	inner agent.Spawner
	enter chan struct{}
	gate  chan struct{}
}

func (s *gatedSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.enter <- struct{}{}
	<-s.gate
	return s.inner.Spawn(o)
}

func TestSpawnSubagentCrossKindOptions(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")

	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "cursor work", Kind: model.Cursor, Model: "composer-2", Effort: "low"})
	if sa.Kind != model.Cursor || sa.Effort != "low" || sa.Model != "composer-2" || !sa.Background || sa.Prompt != "cursor work" {
		t.Fatalf("cursor sub %+v", sa)
	}
	child := waitChild(t, e.cursor, 1)
	if child.opts.Resume || child.opts.Cwd != v.Cwd || child.opts.Model != "composer-2" || child.opts.Effort != "low" {
		t.Fatalf("cursor spawn options %+v", child.opts)
	}
	if child.opts.SessionID != "" {
		t.Fatalf("cursor child session id %q", child.opts.SessionID)
	}
	if e.claude.count() != 0 {
		t.Fatal("cursor spawn used the parent spawner")
	}

	pi := e.spawn(v.ID, SpawnSubRequest{Prompt: "pi work", Kind: model.Pi})
	if pi.Kind != model.Pi || !pi.Background {
		t.Fatalf("pi sub %+v", pi)
	}
	pich := waitChild(t, e.pi, 1)
	if pich.opts.Resume || pich.opts.Cwd != v.Cwd || pich.opts.SessionID == "" {
		t.Fatalf("pi spawn options %+v", pich.opts)
	}

	cl := e.spawn(v.ID, SpawnSubRequest{Prompt: "claude work"})
	if cl.Kind != model.Claude || cl.Model != "sonnet" || cl.Effort != "high" {
		t.Fatalf("omitted kind %+v", cl)
	}
	cch := waitChild(t, e.claude, 1)
	if cch.opts.Model != "sonnet" || cch.opts.Effort != "high" || cch.opts.Resume {
		t.Fatalf("claude spawn options %+v", cch.opts)
	}
	if e.cursor.count() != 1 {
		t.Fatalf("omitted kind used cursor: %d", e.cursor.count())
	}
}

func TestSpawnSubagentPersistsKindEffort(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	evs.drain(t, e.br)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go", Description: "files", Effort: "low"})
	if !sa.Background || sa.Kind != model.Claude || sa.Effort != "low" || sa.Description != "files" || sa.Started != testNow {
		t.Fatalf("receipt %+v", sa)
	}
	got := evs.drain(t, e.br)
	sm := ofType(got, "sub")
	if len(sm) != 1 {
		t.Fatalf("sub events %v", sm)
	}
	emitted := subOf(t, sm[0])
	if emitted.Kind != model.Claude || emitted.Effort != "low" || !emitted.Background || emitted.Description != "files" {
		t.Fatalf("emitted %+v", emitted)
	}
	if f := e.subFile(v.ID, sa.ID); f.Kind != model.Claude || f.Effort != "low" || !f.Background {
		t.Fatalf("subagent.json %+v", f)
	}

	waitChild(t, e.claude, 1)
	e.m.Shutdown()
	e.boot()
	subs := e.subs(v.ID)
	if len(subs) != 1 || subs[0].Kind != model.Claude || subs[0].Effort != "low" || subs[0].ID != sa.ID {
		t.Fatalf("after reload %+v", subs)
	}
	if f := e.subFile(v.ID, sa.ID); f.Kind != model.Claude || f.Effort != "low" {
		t.Fatalf("subagent.json after reload %+v", f)
	}
}

func TestSpawnSubagentParallel(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	enter := make(chan struct{}, 2)
	gate := make(chan struct{})
	e.m.Spawners[model.Claude] = &gatedSpawner{inner: e.claude, enter: enter, gate: gate}

	var wg sync.WaitGroup
	var sa1, sa2 model.Subagent
	var err1, err2 error
	wg.Add(2)
	go func() { defer wg.Done(); sa1, err1 = e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "one"}) }()
	go func() { defer wg.Done(); sa2, err2 = e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "two"}) }()
	for i := 0; i < 2; i++ {
		select {
		case <-enter:
		case <-time.After(5 * time.Second):
			t.Fatal("SpawnSubagent calls serialized on Chat.mu")
		}
	}
	close(gate)
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("spawn errors %v %v", err1, err2)
	}
	if sa1.ID == sa2.ID {
		t.Fatal("same sid")
	}
	waitFor(t, "two children", func() bool { return e.claude.count() == 2 })
	if e.claude.count() != 2 {
		t.Fatalf("%d processes, concurrency cap?", e.claude.count())
	}
}

func TestSpawnSubagentKillOnStop(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 1)
	evs.drain(t, e.br)

	e.m.Stop(v.ID)
	waitFor(t, "child closed after Stop", func() bool { return agentClosed(child) })
	if e.subs(v.ID)[0].Status != model.SubStopped {
		t.Fatalf("after Stop %+v", e.subs(v.ID)[0])
	}
	sm := ofType(evs.drain(t, e.br), "sub")
	if len(sm) == 0 || subOf(t, sm[len(sm)-1]).Status != model.SubStopped {
		t.Fatalf("stop emit %v", sm)
	}
	e.m.handoffs.Wait()
	if e.claude.count() != 1 || len(resultRows(e.items(v.ID))) != 0 || e.subFile(v.ID, sa.ID).Delivery != model.SubNotOwed {
		t.Fatalf("Stop left a result to deliver: %d processes, rows %v", e.claude.count(), resultRows(e.items(v.ID)))
	}

	sa2 := e.spawn(v.ID, SpawnSubRequest{Prompt: "again"})
	child2 := waitChild(t, e.claude, 2)
	if err := e.m.StopSubagent(v.ID, sa2.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "child closed after StopSubagent", func() bool { return agentClosed(child2) })
	if s := e.subFile(v.ID, sa2.ID); s.Status != model.SubStopped {
		t.Fatalf("after StopSubagent %+v", s)
	}
	if err := e.m.StopSubagent(v.ID, sa2.ID); err == nil {
		t.Fatal("already-final StopSubagent succeeded")
	}
	if err := e.m.StopSubagent(v.ID, "nope"); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("unknown sid: %v", err)
	}
	if sa.ID == sa2.ID {
		t.Fatal("reused sid")
	}
}

func TestSpawnSubagentDecideRoutesToChild(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "parent", "")
	e.m.naming.Wait()
	parent := e.claude.last(t)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "child"})
	child := waitChild(t, e.claude, 2)

	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	items := e.items(v.ID)
	last := items[len(items)-1]
	if last.Kind != "perm" || last.RequestID != "r1" || last.Subagent != sa.ID {
		t.Fatalf("perm item %+v", last)
	}
	if _, subItems, _ := e.m.SubItems(v.ID, sa.ID); len(subItems) != 0 {
		t.Fatalf("perm in the sub thread %+v", subItems)
	}
	if err := e.m.Decide(v.ID, sa.ID, "r1", true); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(child); len(d) != 1 || d[0].id != "r1" || !d[0].allow {
		t.Fatalf("child decides %+v", d)
	}
	if d := agentDecides(parent); len(d) != 0 {
		t.Fatalf("parent decides %+v", d)
	}

	// With the parent idle, a result that comes while a child's request is open waits for the
	// answer. The answer does not wait for the agent to take the message.
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r2", ToolName: "Bash", ToolID: "s2"})
	sb := e.spawn(v.ID, SpawnSubRequest{Prompt: "other"})
	e.finish(waitChild(t, e.claude, 3), "other report")
	if st := e.view(v.ID).Status; st != model.StatusApproval || len(parent.sent()) != 1 {
		t.Fatalf("status %q, %d sends with a request open", st, len(parent.sent()))
	}
	if f := e.subFile(v.ID, sb.ID); f.Delivery != model.SubOwed {
		t.Fatalf("subagent.json %+v", f)
	}
	release := parent.blockSends()
	defer release()
	returns(t, "Decide", func() error { return e.m.Decide(v.ID, sa.ID, "r2", false) })
	if d := agentDecides(child); len(d) != 2 || d[1].id != "r2" || d[1].allow {
		t.Fatalf("child decides %+v", d)
	}
	if st := e.view(v.ID).Status; st != model.StatusThinking || len(parent.sent()) != 1 {
		t.Fatalf("status %q, %d sends while the hand-off waits", st, len(parent.sent()))
	}
	if f := e.subFile(v.ID, sb.ID); f.Delivery != model.SubSent {
		t.Fatalf("subagent.json %+v", f)
	}
	release()
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
		t.Fatalf("%d sends, the last delivers %v", len(parent.sent()), deliveredSids(parent.sent()[len(parent.sent())-1]))
	}
	if d := agentDecides(parent); len(d) != 0 {
		t.Fatalf("parent decides %+v", d)
	}
}

func TestSpawnSubagentStopDeniesPerms(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 1)
	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "r1", ToolName: "Bash", ToolID: "s1"})
	e.m.Stop(v.ID)
	waitFor(t, "denied perm", func() bool { return len(agentDecides(child)) > 0 })
	if d := agentDecides(child); len(d) != 1 || d[0].id != "r1" || d[0].allow {
		t.Fatalf("child decides %+v", d)
	}
}

func TestSpawnSubagentParentLifecycle(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "parent", "")
	e.m.naming.Wait()
	parent := e.claude.last(t)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)

	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.subs(v.ID); len(s) != 1 || s[0].Status != model.SubRunning {
		t.Fatalf("normal turn end stopped it: %+v", e.subs(v.ID))
	}
	if agentClosed(child) {
		t.Fatal("normal turn end closed the child")
	}

	e.send(v.ID, "stop that", "")
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})
	waitFor(t, "stopped on abort", func() bool { return e.subs(v.ID)[0].Status == model.SubStopped })
	waitFor(t, "closed on abort", func() bool { return agentClosed(child) })
	if e.subFile(v.ID, sa.ID).Status != model.SubStopped {
		t.Fatalf("subagent.json %+v", e.subFile(v.ID, sa.ID))
	}
	quiet := func(when string) {
		t.Helper()
		e.m.handoffs.Wait()
		if n, rows := len(parent.sent()), resultRows(e.items(v.ID)); n != 2 || len(rows) != 0 {
			t.Fatalf("after %s: %d sends, result rows %v", when, n, rows)
		}
	}
	quiet("the aborted turn")

	sa2 := e.spawn(v.ID, SpawnSubRequest{Prompt: "again"})
	child2 := waitChild(t, e.claude, 3)
	parent.exit(t)
	waitFor(t, "stopped on exit", func() bool {
		for _, s := range e.subs(v.ID) {
			if s.ID == sa2.ID && s.Status == model.SubStopped {
				return true
			}
		}
		return false
	})
	waitFor(t, "closed on exit", func() bool { return agentClosed(child2) })
	quiet("the exit")
	if e.claude.count() != 3 {
		t.Fatalf("%d processes: one was started after the exit", e.claude.count())
	}
}

func TestSpawnPiChatIDDistinct(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Pi, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.pi, 1)
	want := v.ID + "/subagents/" + sa.ID
	if child.opts.ChatID != want {
		t.Fatalf("ChatID %q, want %q", child.opts.ChatID, want)
	}
	if child.opts.ChatID == v.ID {
		t.Fatal("child reused the parent ChatID")
	}
}

func TestSpawnSubagentValidation(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")

	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{}); err == nil || !strings.Contains(err.Error(), "prompt") {
		t.Fatalf("empty prompt: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(v.ID), "subagents")); !os.IsNotExist(err) {
		t.Fatal("empty prompt created a sub folder")
	}

	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Model: "nope"}); err == nil || !strings.Contains(err.Error(), "unknown model") {
		t.Fatalf("unknown model: %v", err)
	}
	if _, err := os.Stat(filepath.Join(e.st.P.ChatDir(v.ID), "subagents")); !os.IsNotExist(err) {
		t.Fatal("unknown model created a sub folder")
	}

	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Effort: "nope"}); err == nil || !strings.Contains(err.Error(), "no effort") {
		t.Fatalf("unknown effort: %v", err)
	}

	cur, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor})
	if err != nil {
		t.Fatal(err)
	}
	if cur.Kind != model.Cursor || cur.Model != "composer-2" || cur.Effort != "high" {
		t.Fatalf("inherited unfit %+v", cur)
	}
	waitChild(t, e.cursor, 1)

	if err := e.st.Update(func(s *model.State) error {
		s.Cursor = nil
		s.Catalogs = nil
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	nilCat, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x", Kind: model.Cursor, Model: "nonsense"})
	if err != nil {
		t.Fatal(err)
	}
	if nilCat.Model != "nonsense" {
		t.Fatalf("nil catalog %+v", nilCat)
	}
	waitChild(t, e.cursor, 2)

	cl := e.spawn(v.ID, SpawnSubRequest{Prompt: "omitted kind"})
	if cl.Kind != model.Claude {
		t.Fatalf("omitted kind %+v", cl)
	}
	waitChild(t, e.claude, 1)
	if e.claude.count() != 1 {
		t.Fatalf("claude count %d", e.claude.count())
	}

	if _, err := e.m.SpawnSubagent("nope", SpawnSubRequest{Prompt: "x"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown chat: %v", err)
	}

	if err := e.m.SetArchive(v.ID, model.Archive{Archived: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x"}); !errors.Is(err, ErrArchived) {
		t.Fatalf("archived: %v", err)
	}
}

func TestSpawnSubagentMissingSpawnerAndFolder(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	delete(e.m.Spawners, model.Claude)
	sa, err := e.m.SpawnSubagent(v.ID, SpawnSubRequest{Prompt: "x"})
	if err == nil || !strings.Contains(err.Error(), "no spawner") {
		t.Fatalf("missing spawner: %v", err)
	}
	if sa.Status != model.SubFailed || sa.Error == "" {
		t.Fatalf("failed sub %+v", sa)
	}
	if e.claude.count() != 0 {
		t.Fatal("orphan process after missing spawner")
	}

	e.m.Spawners[model.Claude] = e.claude
	v2 := e.create(model.Claude, gOne, "")
	dir := t.TempDir()
	if err := e.m.Configure(v2.ID, ConfigReq{Cwd: dir}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	before := e.claude.count()
	sa2, err := e.m.SpawnSubagent(v2.ID, SpawnSubRequest{Prompt: "x"})
	if err == nil || !errors.Is(err, ErrFolderMissing) {
		t.Fatalf("missing folder: %v", err)
	}
	if sa2.Status != model.SubFailed || sa2.Error == "" {
		t.Fatalf("folder-missing sub %+v", sa2)
	}
	if e.claude.count() != before {
		t.Fatal("orphan process after missing folder")
	}
}

func TestSpawnSubagentInterrupt(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "parent", "")
	e.m.naming.Wait()
	parent := e.claude.last(t)
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	if err := e.m.Interrupt(v.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "child closed on interrupt", func() bool { return agentClosed(child) })
	if e.subs(v.ID)[0].Status != model.SubStopped || e.subs(v.ID)[0].ID != sa.ID {
		t.Fatalf("after interrupt %+v", e.subs(v.ID))
	}
	if agentClosed(parent) {
		t.Fatal("interrupt closed the parent process")
	}
	if parent.interrupted() != 1 {
		t.Fatalf("the parent was signalled %d times", parent.interrupted())
	}
	e.m.handoffs.Wait()
	items := e.items(v.ID)
	if len(parent.sent()) != 1 || len(resultRows(items)) != 0 {
		t.Fatalf("after interrupt: %d sends, result rows %v", len(parent.sent()), resultRows(items))
	}
	// The parent's turn is running: the note comes from its aborted end, not from Interrupt.
	if n := notes(items, "muted"); len(n) != 0 {
		t.Fatalf("notes %q", n)
	}
}

func TestSpawnSubagentIgnoresNestedEvSub(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go", Description: "files"})
	child := waitChild(t, e.claude, 1)

	child.emit(t, agent.Event{Kind: agent.EvToolStart, ToolID: "nested-tool", ToolName: "Agent"})
	child.emit(t, agent.Event{Kind: agent.EvSub, Sub: "nested-tool", SubInfo: &agent.SubInfo{
		Status: model.SubCompleted, Model: "other-model", Description: "nested task",
	}})

	got := e.subs(v.ID)
	var app, nested *model.Subagent
	for i := range got {
		switch {
		case got[i].ID == sa.ID:
			app = &got[i]
		case got[i].Tool == "nested-tool":
			nested = &got[i]
		}
	}
	if app == nil {
		t.Fatal("app-spawned sub missing")
	}
	if app.Status != model.SubRunning || app.Model != sa.Model || app.Description != sa.Description ||
		app.Kind != sa.Kind || app.Background != sa.Background {
		t.Fatalf("app-spawned patched %+v want running %+v", app, sa)
	}
	if agentClosed(child) {
		t.Fatal("nested EvSub closed the child")
	}
	if nested == nil {
		t.Fatal("nested sub missing")
	}
	if nested.Status != model.SubCompleted || nested.Parent != sa.ID || nested.Description != "nested task" {
		t.Fatalf("nested %+v", nested)
	}
}

func TestSpawnSubagentExtraToken(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	parentTok := e.meta(v.ID).Token
	if parentTok == "" {
		t.Fatal("plain chat has no persisted token")
	}
	caller, ok := e.m.ResolveToken(parentTok)
	if !ok || caller.Subagent || caller.SID != "" || caller.Meta.ID != v.ID {
		t.Fatalf("parent caller %+v ok=%v", caller, ok)
	}

	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 1)
	if child.opts.MCP == nil || child.opts.MCP.MCPURL != "http://localhost:6006/mcp" {
		t.Fatalf("child MCP %+v", child.opts.MCP)
	}
	extra := child.opts.MCP.Token
	if extra == "" || extra == parentTok {
		t.Fatalf("extra token %q parent %q", extra, parentTok)
	}
	if child.opts.BoardID != "" || !child.opts.Subagent {
		t.Fatalf("plain child BoardID %q Subagent %v", child.opts.BoardID, child.opts.Subagent)
	}
	meta, ok := e.m.ByToken(extra)
	if !ok || meta.ID != v.ID || meta.Board != "" {
		t.Fatalf("ByToken extra %+v ok=%v", meta, ok)
	}
	caller, ok = e.m.ResolveToken(extra)
	if !ok || !caller.Subagent || caller.SID != sa.ID || caller.Meta.ID != v.ID || caller.Kind != model.Claude {
		t.Fatalf("extra caller %+v ok=%v", caller, ok)
	}

	if err := e.m.StopSubagent(v.ID, sa.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.m.ResolveToken(extra); ok {
		t.Fatal("extra token still resolved after StopSubagent")
	}
	if _, ok := e.m.ByToken(extra); ok {
		t.Fatal("ByToken extra after revoke")
	}
}

func TestSpawnSubagentExtraTokenRevokeOnStopAndComplete(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")

	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "done"})
	child := waitChild(t, e.claude, 1)
	extra := child.opts.MCP.Token
	child.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "extra revoked on completion", func() bool {
		_, ok := e.m.ResolveToken(extra)
		return !ok
	})
	if _, ok := e.m.ByToken(extra); ok {
		t.Fatal("completed extra token still resolved")
	}
	if sa.ID == "" {
		t.Fatal("missing sid")
	}

	sa2 := e.spawn(v.ID, SpawnSubRequest{Prompt: "again"})
	child2 := waitChild(t, e.claude, 2)
	extra2 := child2.opts.MCP.Token
	e.m.Stop(v.ID)
	waitFor(t, "extra revoked on chat Stop", func() bool {
		_, ok := e.m.ResolveToken(extra2)
		return !ok
	})
	if _, ok := e.m.ByToken(extra2); ok {
		t.Fatal("stopped extra token still resolved")
	}
	if sa2.ID == extra2 {
		t.Fatal("sid equals token")
	}
}

func TestSpawnSubagentBoardParentByToken(t *testing.T) {
	e := newEnv(t)
	bd, err := e.bds.Create("board", gOne, false)
	if err != nil {
		t.Fatal(err)
	}
	v := e.create(model.Claude, "", bd.ID)
	parentTok := e.meta(v.ID).Token
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "draw"})
	child := waitChild(t, e.claude, 1)
	extra := child.opts.MCP.Token
	if extra == "" || extra == parentTok {
		t.Fatalf("extra %q parent %q", extra, parentTok)
	}
	if child.opts.BoardID != bd.ID || !child.opts.Subagent {
		t.Fatalf("board child BoardID %q Subagent %v", child.opts.BoardID, child.opts.Subagent)
	}
	meta, ok := e.m.ByToken(extra)
	if !ok || meta.ID != v.ID || meta.Board != bd.ID {
		t.Fatalf("ByToken extra %+v ok=%v, want parent board %q", meta, ok, bd.ID)
	}
	caller, ok := e.m.ResolveToken(extra)
	if !ok || !caller.Subagent || caller.SID != sa.ID || caller.Meta.Board != bd.ID {
		t.Fatalf("extra caller %+v ok=%v", caller, ok)
	}
}

func (e *env) startSpawnParent() (string, *fakeAgent) {
	e.t.Helper()
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "delegate", "")
	e.m.naming.Wait()
	return v.ID, e.claude.last(e.t)
}

func emitSpawnItem(t *testing.T, parent *fakeAgent, toolID, name, input string) {
	t.Helper()
	parent.emit(t, agent.Event{
		Kind: agent.EvToolStart, ToolID: toolID, ToolName: name, Input: json.RawMessage(input),
	})
}

func itemSubagent(items []model.Item, toolID string) string {
	for _, it := range items {
		if it.ToolID == toolID {
			return it.Subagent
		}
	}
	return ""
}

func TestSpawnClaimMatchingItem(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"go"}`)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	if sa.Tool != "t1" {
		t.Fatalf("Tool %q, want t1", sa.Tool)
	}
	if itemSubagent(e.items(id), "t1") != sa.ID {
		t.Fatalf("item not linked: %+v", e.items(id))
	}
	if e.subFile(id, sa.ID).Tool != "t1" {
		t.Fatalf("persisted Tool %q", e.subFile(id, sa.ID).Tool)
	}
	waitChild(t, e.claude, 2)
}

func TestSpawnClaimUnprefixedName(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	emitSpawnItem(t, parent, "t1", "spawn_subagent", `{"prompt":"go"}`)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	if sa.Tool != "t1" || itemSubagent(e.items(id), "t1") != sa.ID {
		t.Fatalf("unprefixed claim Tool=%q item=%q", sa.Tool, itemSubagent(e.items(id), "t1"))
	}
	waitChild(t, e.claude, 2)
}

func TestSpawnClaimOmitsEmptyOptionals(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"x","description":""}`)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "x"})
	if sa.Tool != "t1" {
		t.Fatalf("empty description should match omitted, Tool %q", sa.Tool)
	}
	waitChild(t, e.claude, 2)
}

func TestSpawnClaimFIFO(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	args := `{"prompt":"same"}`
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", args)
	emitSpawnItem(t, parent, "t2", "mcp__board__spawn_subagent", args)
	sa1 := e.spawn(id, SpawnSubRequest{Prompt: "same"})
	sa2 := e.spawn(id, SpawnSubRequest{Prompt: "same"})
	if sa1.Tool != "t1" || sa2.Tool != "t2" {
		t.Fatalf("FIFO tools %q %q, want t1 then t2", sa1.Tool, sa2.Tool)
	}
	if itemSubagent(e.items(id), "t1") != sa1.ID || itemSubagent(e.items(id), "t2") != sa2.ID {
		t.Fatalf("FIFO links t1=%q t2=%q", itemSubagent(e.items(id), "t1"), itemSubagent(e.items(id), "t2"))
	}
	waitChild(t, e.claude, 3)
}

func TestSpawnClaimFIFOParallel(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	args := `{"prompt":"same"}`
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", args)
	emitSpawnItem(t, parent, "t2", "mcp__board__spawn_subagent", args)
	var wg sync.WaitGroup
	var sa1, sa2 model.Subagent
	var err1, err2 error
	wg.Add(2)
	go func() { defer wg.Done(); sa1, err1 = e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "same"}) }()
	go func() { defer wg.Done(); sa2, err2 = e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "same"}) }()
	wg.Wait()
	if err1 != nil || err2 != nil {
		t.Fatalf("spawn errors %v %v", err1, err2)
	}
	if sa1.ID == sa2.ID {
		t.Fatal("same sid")
	}
	claimed := map[string]string{sa1.Tool: sa1.ID, sa2.Tool: sa2.ID}
	if claimed["t1"] == "" || claimed["t2"] == "" {
		t.Fatalf("parallel claim tools %q %q", sa1.Tool, sa2.Tool)
	}
	if itemSubagent(e.items(id), "t1") != claimed["t1"] || itemSubagent(e.items(id), "t2") != claimed["t2"] {
		t.Fatalf("parallel links %+v items t1=%q t2=%q", claimed, itemSubagent(e.items(id), "t1"), itemSubagent(e.items(id), "t2"))
	}
	waitChild(t, e.claude, 3)
}

func TestSpawnClaimDelayedReconciliation(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	if sa.Tool != "" {
		t.Fatalf("claimed too early Tool=%q", sa.Tool)
	}
	if sa.ID == "" {
		t.Fatal("unlinked spawn returned no sid")
	}
	emitSpawnItem(t, parent, "t1", "mcp__board__spawn_subagent", `{"prompt":"go"}`)
	waitFor(t, "delayed link", func() bool { return itemSubagent(e.items(id), "t1") == sa.ID })
	if e.subFile(id, sa.ID).Tool != "t1" {
		t.Fatalf("persisted Tool %q", e.subFile(id, sa.ID).Tool)
	}
	waitChild(t, e.claude, 2)
}

func TestSpawnUnlinkedReturnsSid(t *testing.T) {
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	if sa.ID == "" || sa.Tool != "" {
		t.Fatalf("unlinked receipt %+v", sa)
	}
	waitChild(t, e.claude, 1)
}
