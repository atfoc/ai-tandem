package chats

// A run's chats in the manager: where they are kept, who may change them, what clients are sent.

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// runMeta reads the chat.json of a chat of ownRun from where it must be.
func (e *env) runMeta(id string, agent bool) model.ChatMeta {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.st.P.RunChatDir(ownRun, agent, id), "chat.json"))
	if err != nil {
		e.t.Fatal(err)
	}
	var m model.ChatMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	return m
}

func (e *env) onRun(a model.AgentKind) model.ChatView {
	e.t.Helper()
	v, err := e.m.CreateOnRun(a, ownRun)
	if err != nil {
		e.t.Fatal(err)
	}
	return v
}

// ownTree lists every file and folder under dir, relative to it, with ids replaced by labels.
func ownTree(t *testing.T, dir string, names map[string]string) []string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == dir {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		for id, label := range names {
			rel = strings.ReplaceAll(rel, id, label)
		}
		if d.IsDir() {
			rel += "/"
		}
		out = append(out, rel)
		return nil
	})
	sort.Strings(out)
	return out
}

// ---- creating ---------------------------------------------------------------

func TestCreateOwned(t *testing.T) {
	e, fr := runEnv(t)
	var before model.Defaults
	e.st.Read(func(s *model.State) { before = s.Defaults })
	evs := e.listen()

	spec := OwnedSpec{ID: "agent-1", Run: ownRun, Role: model.RoleTask, Name: "T01-work", Agent: model.Claude, Model: "haiku", Effort: "low", Cwd: e.cwd}
	created, err := e.m.CreateOwned(spec)
	if err != nil || !created {
		t.Fatalf("CreateOwned: %v %v", created, err)
	}
	m := e.runMeta("agent-1", true)
	if m.ID != "agent-1" || m.Run != ownRun || m.Role != model.RoleTask || m.Name != "T01-work" || !m.UserNamed ||
		m.Agent != model.Claude || m.Model != "haiku" || m.Effort != "low" || m.Cwd != e.cwd || m.Group != "" || m.Board != "" ||
		m.Token == "" || m.SessionID == "" || m.Locked {
		t.Fatalf("chat.json: %+v", m)
	}
	// Twice finds the first, as it is: nothing of the second spec is taken.
	again := spec
	again.Model, again.Name = "opus", "another name"
	if created, err := e.m.CreateOwned(again); err != nil || created {
		t.Fatalf("CreateOwned twice: %v %v", created, err)
	}
	if got := e.runMeta("agent-1", true); got.Model != "haiku" || got.Token != m.Token || got.SessionID != m.SessionID {
		t.Fatalf("the second CreateOwned changed the chat: %+v", got)
	}
	// The same id with another run or role is an error.
	fr.set("r_two", RunInfo{Group: gTwo, Cwd: e.cwd})
	other := spec
	other.Run = "r_two"
	if _, err := e.m.CreateOwned(other); err == nil {
		t.Fatal("the same id was made again on another run")
	}
	other = spec
	other.Role = model.RoleMerge
	if _, err := e.m.CreateOwned(other); err == nil {
		t.Fatal("the same id was made again with another role")
	}

	// Hidden: not in the list, no event, but it can be read.
	for _, v := range e.m.Views() {
		if v.ID == "agent-1" {
			t.Fatal("a run agent's chat is in Views()")
		}
	}
	if v, err := e.m.View("agent-1"); err != nil || v.Role != model.RoleTask || v.Run != ownRun || v.Name != "T01-work" {
		t.Fatalf("View: %+v %v", v, err)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events for a new run agent's chat: %v", got)
	}
	if st, err := e.m.OwnedState("agent-1"); err != nil || st != (OwnedState{Exists: true}) {
		t.Fatalf("OwnedState of a new chat: %+v %v", st, err)
	}
	if st, err := e.m.OwnedState("nope"); err != nil || st.Exists {
		t.Fatalf("OwnedState of no chat: %+v %v", st, err)
	}

	// A first message: no namer, no sticky defaults, nothing under chats/.
	e.sendOwned("agent-1", "work")
	e.claude.last(t).emit(t, ownText("ok", "p1")...)
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 0 {
		t.Fatalf("the namer ran: %v", calls)
	}
	var after model.Defaults
	e.st.Read(func(s *model.State) { after = s.Defaults })
	if len(after.Groups) != len(before.Groups) || after.Last.Cwd != before.Last.Cwd || len(after.Last.ByAgent) != len(before.Last.ByAgent) {
		t.Fatalf("the sticky defaults changed: %+v -> %+v", before, after)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events for an unwatched run agent's chat: %v", got)
	}
	if got := e.chatDirs(); len(got) != 0 {
		t.Fatalf("chats/ is not empty: %v", got)
	}

	// Specs that are refused.
	missing := filepath.Join(e.cwd, "missing")
	for name, s := range map[string]OwnedSpec{
		"no id":         {Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Cwd: e.cwd},
		"a path as id":  {ID: "../x", Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Cwd: e.cwd},
		"a path as run": {ID: "a", Run: "../x", Role: model.RoleTask, Agent: model.Claude, Cwd: e.cwd},
		"no role":       {ID: "a", Run: ownRun, Agent: model.Claude, Cwd: e.cwd},
		"a bad role":    {ID: "a", Run: ownRun, Role: "boss", Agent: model.Claude, Cwd: e.cwd},
		"a bad agent":   {ID: "a", Run: ownRun, Role: model.RoleTask, Agent: "gpt", Cwd: e.cwd},
		"the app's own": {ID: "a", Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Cwd: e.st.P.RunDir(ownRun)},
		"no folder":     {ID: "a", Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Cwd: missing},
	} {
		if created, err := e.m.CreateOwned(s); err == nil || created {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := e.m.CreateOwned(OwnedSpec{ID: "a", Run: "r_none", Role: model.RoleTask, Agent: model.Claude, Cwd: e.cwd}); !errors.Is(err, ErrNoRun) {
		t.Errorf("a run that is not there: %v", err)
	}
	fr.set("r_old", RunInfo{Archived: true, Cwd: e.cwd})
	if _, err := e.m.CreateOwned(OwnedSpec{ID: "a", Run: "r_old", Role: model.RoleTask, Agent: model.Claude, Cwd: e.cwd}); !errors.Is(err, ErrRunArchived) {
		t.Errorf("an archived run: %v", err)
	}
	if _, err := os.Stat(e.st.P.RunChatDir(ownRun, true, "a")); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a refused CreateOwned left a folder: %v", err)
	}

	// A manager without runs has none to make a chat on.
	e2 := newEnv(t)
	if _, err := e2.m.CreateOwned(spec); !errors.Is(err, ErrNoRun) {
		t.Errorf("CreateOwned with no RunOwner: %v", err)
	}
	if _, err := e2.m.CreateOnRun(model.Claude, ownRun); !errors.Is(err, ErrNoRun) {
		t.Errorf("CreateOnRun with no RunOwner: %v", err)
	}
}

func TestCreateOnRun(t *testing.T) {
	e, fr := runEnv(t)
	other := t.TempDir()
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{
		gOne: {Cwd: other, ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "low"}, model.Pi: {Model: "pi-model", Effort: "low"}}},
	}})
	// A chat of another agent kind than the run's keeps the new-chat defaults of the run's group.
	if pv, err := e.m.CreateOnRun(model.Pi, ownRun); err != nil || pv.Model != "pi-model" || pv.Effort != "low" || pv.Cwd != e.cwd {
		t.Fatalf("a pi chat on a Claude run: %+v %v", pv, err)
	} else if err := e.m.Delete(pv.ID); err != nil {
		t.Fatal(err)
	}
	evs := e.listen()
	v := e.onRun(model.Claude)
	// Model and effort are those of the run's deep tier, not the new-chat defaults of the run's
	// group; the folder is the run's.
	if v.Run != ownRun || v.Role != "" || v.Group != "" || v.Board != "" || v.Model != "sonnet" || v.Effort != "high" || v.Cwd != e.cwd || v.Locked {
		t.Fatalf("view: %+v", v)
	}
	m := e.runMeta(v.ID, false)
	if m.Run != ownRun || m.Role != "" || m.Token == "" || m.SessionID == "" {
		t.Fatalf("chat.json: %+v", m)
	}
	if got := e.m.GroupOf(m); got != gOne {
		t.Fatalf("GroupOf a chat on a run = %q", got)
	}
	if !e.listed(v.ID) {
		t.Fatal("a person's chat on a run is not in Views()")
	}
	if got := chatViews(t, evs.drain(t, e.br), v.ID); len(got) != 1 || got[0].Run != ownRun {
		t.Fatalf("chat events for a new chat on a run: %+v", got)
	}
	people, agents := e.m.ChatsOfRun(ownRun)
	if len(people) != 1 || people[0].ID != v.ID || len(agents) != 0 {
		t.Fatalf("ChatsOfRun: %+v %+v", people, agents)
	}
	if err := e.m.Move(v.ID, gTwo); err == nil || !strings.Contains(err.Error(), "moves with its run") {
		t.Fatalf("Move of a chat on a run: %v", err)
	}

	// The first message: the run's context block ahead of the text, on every message; the namer
	// runs as for any chat; the sticky defaults stay as they were.
	var before model.Defaults
	e.st.Read(func(s *model.State) { before = s.Defaults })
	e.send(v.ID, "how far is it?", "<ui-context/>")
	ag := e.claude.last(t)
	ctx := fr.ChatContext(ownRun)
	if got := texts(ag.sent()[0]); len(got) != 2 || got[0] != ctx || got[1] != "how far is it?" {
		t.Fatalf("first message: %q", got)
	}
	if it := e.items(v.ID)[0]; it.Context != ctx || it.Text != "how far is it?" {
		t.Fatalf("user item: %+v", it)
	}
	ag.emit(t, ownText("half way", "p1")...)
	e.m.naming.Wait()
	if calls := e.namer.callList(); len(calls) != 1 {
		t.Fatalf("namer calls: %v", calls)
	}
	var after model.Defaults
	e.st.Read(func(s *model.State) { after = s.Defaults })
	if after.Last.Cwd != before.Last.Cwd || after.Groups[gOne].Cwd != other || len(after.Last.ByAgent) != len(before.Last.ByAgent) {
		t.Fatalf("the sticky defaults changed: %+v -> %+v", before, after)
	}
	e.send(v.ID, "and now?", "")
	if got := texts(ag.sent()[1]); len(got) != 2 || got[0] != ctx {
		t.Fatalf("second message: %q", got)
	}
	ag.emit(t, ownText("done", "p2")...)
	// A delivery the app starts carries the block too.
	_, child := e.ownChild(v.ID, "child work")
	child.emit(t, ownText("child report", "")...)
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 3 })
	if got := texts(ag.sent()[2]); len(got) != 2 || got[0] != ctx || !strings.Contains(got[1], "<subagent-results>") {
		t.Fatalf("delivery: %q", got)
	}
	ag.emit(t, ownText("thanks", "p3")...)

	// A run that is gone or archived takes no message and no new chat; the chat can still be read.
	fr.set(ownRun, RunInfo{Group: gOne, Cwd: e.cwd, Archived: true})
	if err := e.m.Send(v.ID, "more", "", nil); !errors.Is(err, ErrRunArchived) {
		t.Fatalf("Send on an archived run: %v", err)
	}
	if _, err := e.m.CreateOnRun(model.Claude, ownRun); !errors.Is(err, ErrRunArchived) {
		t.Fatalf("CreateOnRun on an archived run: %v", err)
	}
	if _, err := e.m.Fork(v.ID, ForkReq{Branch: model.MainBranch, At: 3}); !errors.Is(err, ErrRunArchived) {
		t.Fatalf("Fork on an archived run: %v", err)
	}
	fr.drop(ownRun)
	if err := e.m.Send(v.ID, "more", "", nil); !errors.Is(err, ErrNoRun) {
		t.Fatalf("Send on a run that is gone: %v", err)
	}
	if _, err := e.m.CreateOnRun(model.Claude, ownRun); !errors.Is(err, ErrNoRun) {
		t.Fatalf("CreateOnRun on a run that is gone: %v", err)
	}
	if got := e.m.GroupOf(m); got != model.Ungrouped {
		t.Fatalf("GroupOf a chat whose run is gone = %q", got)
	}
	if n := len(e.items(v.ID)); n == 0 {
		t.Fatal("the chat cannot be read")
	}
	if _, err := e.m.CreateOnRun("gpt", ownRun); err == nil {
		t.Fatal("an unknown agent was accepted")
	}
}

// ---- storage -----------------------------------------------------------------

// Everything of a run's chats is under the run's folder: the chat people talk to with its
// subagents, branches and forks, and the run's agents with theirs. Nothing is in chats/. A new
// manager on the same folder finds them all.
func TestRunChatStorageAndRestart(t *testing.T) {
	e, fr := runEnv(t)
	names := map[string]string{}

	chat := e.onRun(model.Claude)
	names[chat.ID] = "<run-chat>"
	root := e.st.P.RunChatDir(ownRun, false, chat.ID)
	e.send(chat.ID, "ask 1", "")
	main := e.claude.last(t)
	if main.opts.Dir != root {
		t.Fatalf("SpawnOptions.Dir = %q, want %q", main.opts.Dir, root)
	}
	sa, child := e.ownChild(chat.ID, "child work")
	names[sa.ID] = "<sid>"
	if want := filepath.Join(root, "subagents", sa.ID); child.opts.Dir != want || child.opts.ChatID != chat.ID+"/subagents/"+sa.ID {
		t.Fatalf("subagent options: Dir %q ChatID %q, want Dir %q", child.opts.Dir, child.opts.ChatID, want)
	}
	main.emit(t, ownText("spawned", "p1")...)
	child.emit(t, ownText("child report", "")...)
	waitFor(t, "the delivery", func() bool { return len(main.sent()) == 2 })
	main.emit(t, ownText("thanks", "p2")...)
	// items now: user, text, end, subresult, text, end

	// A branch of it (a new branch at the first turn's end), and a fork to a new chat.
	if err := e.m.SendTo(chat.ID, Target{Branch: model.MainBranch, At: 3, New: true}, "aside", "", nil); err != nil {
		t.Fatalf("SendTo: %v", err)
	}
	b := e.view(chat.ID).Branch
	names[b] = "<branch>"
	fc := e.claude.forkCalls()
	if len(fc) != 1 || fc[0].src.Dir != root || fc[0].opts.Dir != filepath.Join(root, "branches", b) {
		t.Fatalf("branch start: %+v", fc)
	}
	// The branch is on the run too: its messages start with the run's block.
	bAg := e.claude.lastFork(t)
	if got := texts(bAg.sent()[0]); len(got) != 2 || got[0] != fr.ChatContext(ownRun) || got[1] != "aside" {
		t.Fatalf("the branch's message: %q", got)
	}
	bAg.emit(t, ownText("aside reply", "b1")...)
	fork, err := e.m.Fork(chat.ID, ForkReq{Branch: model.MainBranch, At: 3})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	names[fork.ID] = "<fork>"
	if fork.Run != ownRun || fork.Role != "" || fork.Group != "" {
		t.Fatalf("the fork is not on the run: %+v", fork)
	}
	if fc := e.claude.forkCalls(); len(fc) != 2 || fc[1].src.Dir != root || fc[1].opts.Dir != e.st.P.RunChatDir(ownRun, false, fork.ID) {
		t.Fatalf("fork start: %+v", fc[len(fc)-1])
	}

	// One of the run's agents, with a subagent.
	task := e.agentChat("task-agent", model.RoleTask, model.Claude)
	e.sendOwned(task, "do it")
	tAg := e.claude.last(t)
	if want := e.st.P.RunChatDir(ownRun, true, task); tAg.opts.Dir != want {
		t.Fatalf("the agent's Dir = %q, want %q", tAg.opts.Dir, want)
	}
	sa2, child2 := e.ownChild(task, "task child")
	names[sa2.ID] = "<sid2>"
	if want := filepath.Join(e.st.P.RunChatDir(ownRun, true, task), "subagents", sa2.ID); child2.opts.Dir != want {
		t.Fatalf("the agent's subagent Dir = %q, want %q", child2.opts.Dir, want)
	}
	tAg.emit(t, ownText("spawned", "t1")...)
	child2.emit(t, ownText("task child report", "")...)
	waitFor(t, "the delivery", func() bool { return len(tAg.sent()) == 2 })
	tAg.emit(t, ownText("done <result>x</result>", "t2")...)
	if s, err := e.m.WaitOwned(context.Background(), task); err != nil || s.Outcome != EndClean || s.Turns != 2 {
		t.Fatalf("the task agent: %+v %v", s, err)
	}
	orch := e.agentChat("orch-agent", model.RoleOrchestrator, model.Claude)
	e.sendOwned(orch, "plan")
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvText, Text: "half way"})

	empty := func(when string) {
		t.Helper()
		if got := e.chatDirs(); len(got) != 0 {
			t.Fatalf("%s: chats/ is not empty: %v", when, got)
		}
	}
	empty("after use")
	tree := ownTree(t, e.st.P.RunDir(ownRun), names)
	for _, want := range []string{
		"agents/orch-agent/chat.json", "agents/task-agent/chat.json", "agents/task-agent/items.jsonl",
		"agents/task-agent/subagents/<sid2>/subagent.json", "agents/task-agent/subagents/<sid2>/items.jsonl",
		"chats/<run-chat>/chat.json", "chats/<run-chat>/items.jsonl", "chats/<run-chat>/tree.json",
		"chats/<run-chat>/subagents/<sid>/subagent.json", "chats/<run-chat>/branches/<branch>/chat.json",
		"chats/<run-chat>/branches/<branch>/items.jsonl", "chats/<fork>/chat.json", "chats/<fork>/items.jsonl",
	} {
		found := false
		for _, got := range tree {
			found = found || got == want
		}
		if !found {
			t.Fatalf("%s is missing under the run:\n  %s", want, strings.Join(tree, "\n  "))
		}
	}

	// A restart: everything is found again, under the same ids.
	e.m.Shutdown()
	e.reboot(fr)
	var listed []string
	for _, v := range e.m.Views() {
		listed = append(listed, names[v.ID])
	}
	sort.Strings(listed)
	if strings.Join(listed, ",") != "<fork>,<run-chat>" {
		t.Fatalf("Views after the restart: %v (no run agent may be listed)", listed)
	}
	people, agents := e.m.ChatsOfRun(ownRun)
	if len(people) != 2 || len(agents) != 2 || agents[0].ID != task || agents[1].ID != orch || agents[0].Token == "" {
		t.Fatalf("ChatsOfRun after the restart: %d people, agents %+v", len(people), agents)
	}
	if v := e.view(chat.ID); v.Branches != 2 || v.Branch != b || v.Run != ownRun {
		t.Fatalf("the run chat after the restart: %+v", v)
	}
	// What the engine can read without starting anything.
	st, err := e.m.OwnedState(task)
	if err != nil || st != (OwnedState{Exists: true, Locked: true, Text: "done <result>x</result>"}) {
		t.Fatalf("the task agent after the restart: %+v %v", st, err)
	}
	st, err = e.m.OwnedState(orch)
	if err != nil || st != (OwnedState{Exists: true, Locked: true, WasActive: true, Text: "half way"}) {
		t.Fatalf("the orchestrator, cut off in its turn, after the restart: %+v %v", st, err)
	}
	if e.loadedOwned(task) || e.loadedOwned(orch) {
		t.Fatal("OwnedState loaded a thread into the manager")
	}
	if a, err := e.m.Activity(task); err != nil || a.Tools != 0 || a.Last.Kind != "" || e.loadedOwned(task) {
		t.Fatalf("Activity after the restart: %+v %v", a, err)
	}
	if _, err := e.m.WaitOwned(context.Background(), task); !errors.Is(err, ErrNothingSent) {
		t.Fatalf("WaitOwned after the restart: %v", err)
	}
	if !e.m.Idle(task) || e.m.TurnRunning(orch) {
		t.Fatal("a chat without a process is not idle after the restart")
	}
	if _, items, subs, err := e.m.Items(task); err != nil || len(items) != 6 || len(subs) != 1 {
		t.Fatalf("the task agent's thread after the restart: %d items, %d subagents, %v", len(items), len(subs), err)
	}
	if n := len(e.items(fork.ID)); n != 3 {
		t.Fatalf("the fork's thread: %d items", n)
	}

	// A message after the restart resumes the session, and must find its history.
	sid := e.runMeta(task, true).SessionID
	e.sendOwned(task, "more")
	rAg := e.claude.last(t)
	if o := rAg.opts; !o.Resume || !o.NeedHistory || o.SessionID != sid || o.Dir != e.st.P.RunChatDir(ownRun, true, task) {
		t.Fatalf("resume options: %+v", o)
	}
	rAg.emit(t, ownText("more done", "t3")...)
	if s, err := e.m.WaitOwned(context.Background(), task); err != nil || s.Text != "more done" || s.From != 6 {
		t.Fatalf("after the resume: %+v %v", s, err)
	}

	// A fresh send forgets the session: the process ends, and the next one starts a new session.
	if err := e.m.SendOwned(task, "from the start", OwnedSend{Fresh: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the old process's close", rAg.isClosed)
	fAg := e.claude.last(t)
	if o := fAg.opts; fAg == rAg || o.Resume || o.NeedHistory || o.SessionID == sid || o.SessionID == "" {
		t.Fatalf("options of a fresh send: %+v (old session %s)", o, sid)
	}
	if m := e.runMeta(task, true); m.SessionID != fAg.opts.SessionID || !m.Locked {
		t.Fatalf("chat.json after a fresh send: %+v", m)
	}
	fAg.emit(t, ownText("again", "t4")...)
	// And the message after it resumes the new session.
	e.m.StopOwned(task, 0)
	e.sendOwned(task, "go on")
	if o := e.claude.last(t).opts; !o.Resume || !o.NeedHistory || o.SessionID != fAg.opts.SessionID {
		t.Fatalf("options after a fresh send: %+v", o)
	}
	empty("after the restart")

	// Deleting: the folders go, and the agents/ and chats/ folders with their last chat.
	for _, id := range []string{chat.ID, fork.ID} {
		if err := e.m.Delete(id); err != nil {
			t.Fatalf("Delete: %v", err)
		}
	}
	evs := e.listen()
	if err := e.m.DeleteOwned(task); err != nil {
		t.Fatalf("DeleteOwned: %v", err)
	}
	if left := ownTree(t, e.st.P.RunDir(ownRun), names); strings.Join(left, ",") != "agents/,agents/orch-agent/,agents/orch-agent/chat.json,agents/orch-agent/items.jsonl" {
		t.Fatalf("left under the run: %v", left)
	}
	if err := e.m.DeleteOwned(orch); err != nil {
		t.Fatalf("DeleteOwned: %v", err)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("events of DeleteOwned: %v", got)
	}
	if err := e.m.DeleteOwned(orch); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteOwned twice: %v", err)
	}
	empty("after the deletes")
	if left := ownTree(t, e.st.P.RunDir(ownRun), names); len(left) != 0 {
		t.Fatalf("left under the run: %v", left)
	}
	e.m.rootsMu.Lock()
	n := len(e.m.roots)
	e.m.rootsMu.Unlock()
	if n != 0 {
		t.Fatalf("%d roots left", n)
	}
	if st, _ := e.m.OwnedState(task); st.Exists {
		t.Fatal("a deleted chat exists")
	}
}

// loadedOwned reports whether the thread of the chat object id is in memory.
func (e *env) loadedOwned(id string) bool {
	c, err := e.m.get(id)
	if err != nil {
		e.t.Fatal(err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tr != nil
}

// A folder under a run whose chat.json does not agree with where it is, is skipped at boot.
func TestLoadSkipsMisplacedRunChats(t *testing.T) {
	e, fr := runEnv(t)
	good := e.agentChat("good", model.RoleTask, model.Claude)
	write := func(dir string, m model.ChatMeta) {
		t.Helper()
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(m)
		if err := os.WriteFile(filepath.Join(dir, "chat.json"), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	p := e.st.P
	write(p.RunChatDir(ownRun, true, "other-name"), model.ChatMeta{ID: "x", Run: ownRun, Role: model.RoleTask, Agent: model.Claude})
	write(p.RunChatDir(ownRun, true, "other-run"), model.ChatMeta{ID: "other-run", Run: "r_two", Role: model.RoleTask, Agent: model.Claude})
	write(p.RunChatDir(ownRun, true, "no-role"), model.ChatMeta{ID: "no-role", Run: ownRun, Agent: model.Claude})
	write(p.RunChatDir(ownRun, false, "has-role"), model.ChatMeta{ID: "has-role", Run: ownRun, Role: model.RoleMerge, Agent: model.Claude})
	if err := os.MkdirAll(p.RunChatDir(ownRun, false, "empty"), 0o700); err != nil {
		t.Fatal(err)
	}
	e.reboot(fr)
	people, agents := e.m.ChatsOfRun(ownRun)
	if len(people) != 0 || len(agents) != 1 || agents[0].ID != good {
		t.Fatalf("loaded: people %+v agents %+v", people, agents)
	}
}

// ---- the guard ----------------------------------------------------------------

// Every call a person can make to change a chat answers ErrRunAgent for a run agent's chat, and
// changes nothing; the calls that read one work; the engine's own calls work.
func TestPersonCannotChangeARunAgentsChat(t *testing.T) {
	e, _ := runEnv(t)
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "the brief")
	ag := e.claude.last(t)
	ag.emit(t, ownText("first answer", "p1")...)
	e.sendOwned(id, "go on")
	ag.emit(t, agent.Event{Kind: agent.EvText, Text: "working"})
	before := e.runMeta(id, true)
	items := len(e.items(id))

	_, forkErr := e.m.Fork(id, ForkReq{Branch: model.MainBranch, At: 3})
	_, labelErr := e.m.SetLabel(id, model.MainBranch, 1, "a label")
	for name, err := range map[string]error{
		"Send":       e.m.Send(id, "from a person", "", nil),
		"SendTo":     e.m.SendTo(id, Target{Branch: model.MainBranch, At: 3, New: true}, "aside", "", nil),
		"SetDraft":   e.m.SetDraft(id, model.Draft{Text: "a draft"}),
		"Configure":  e.m.Configure(id, ConfigReq{Model: "opus"}),
		"Rename":     e.m.Rename(id, "mine", true),
		"Move":       e.m.Move(id, gTwo),
		"Fork":       forkErr,
		"SetLabel":   labelErr,
		"Interrupt":  e.m.Interrupt(id),
		"SetArchive": e.m.SetArchive(id, model.Archive{Archived: true}),
		"Delete":     e.m.Delete(id),
	} {
		if !errors.Is(err, ErrRunAgent) {
			t.Errorf("%s on a run agent's chat: %v", name, err)
		}
	}
	e.m.Stop(id) // the twelfth: it has no answer, and must do nothing
	if ag.isClosed() || ag.interrupted() != 0 || !e.m.TurnRunning(id) {
		t.Fatalf("a person's call reached the agent: closed %v, %d interrupts, turn running %v", ag.isClosed(), ag.interrupted(), e.m.TurnRunning(id))
	}
	after := e.runMeta(id, true)
	if after.Name != before.Name || after.Model != before.Model || after.Group != "" || after.Archived || after.Draft != nil {
		t.Fatalf("chat.json changed: %+v", after)
	}
	if n := len(e.items(id)); n != items {
		t.Fatalf("the thread changed: %d items, were %d", n, items)
	}
	if tv := e.tree(id); len(tv.Labels) != 0 || len(tv.Branches) != 1 {
		t.Fatalf("the tree changed: %+v", tv)
	}
	if got := e.chatDirs(); len(got) != 0 {
		t.Fatalf("chats/ is not empty: %v", got)
	}

	// Reads work.
	if v, err := e.m.View(id); err != nil || v.Role != model.RoleTask || !e.m.Busy(id) {
		t.Fatalf("View: %+v %v", v, err)
	}
	if served, _, its, _, err := e.m.ItemsOf(id, ""); err != nil || served != model.MainBranch || len(its) != items {
		t.Fatalf("ItemsOf: %s %d %v", served, len(its), err)
	}
	if _, _, err := e.m.SubItemsOf(id, "", "nope"); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("SubItemsOf: %v", err)
	}
	if err := e.m.Open(id); err != nil {
		t.Fatalf("Open: %v", err)
	}
	if s, err := e.m.ContextSplit(id, false); err != nil || s.Total == 0 {
		t.Fatalf("ContextSplit of a running agent: %+v %v", s, err)
	}
	if err := e.m.Decide(id, "", "nope", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("Decide: %v", err)
	}
	if c, ok := e.m.ResolveToken(before.Token); !ok || c.Meta.Run != ownRun || c.Meta.Role != model.RoleTask || c.Subagent || c.Chat != id {
		t.Fatalf("ResolveToken: %+v %v", c, ok)
	}

	// The engine's own path works.
	ag.emit(t, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	if s, err := e.m.WaitOwned(context.Background(), id); err != nil || s.Outcome != EndClean || s.Text != "working" {
		t.Fatalf("WaitOwned: %+v %v", s, err)
	}
	e.m.StopOwned(id, time.Second)
	waitFor(t, "the process's close", ag.isClosed)
	if err := e.m.DeleteOwned(id); err != nil {
		t.Fatalf("DeleteOwned: %v", err)
	}
	// The …Owned calls are for run agents' chats only.
	v := e.onRun(model.Claude)
	if err := e.m.DeleteOwned(v.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteOwned of a person's chat: %v", err)
	}
	e.m.StopOwned(v.ID, 0)
	if !e.listed(v.ID) {
		t.Fatal("the person's chat is gone")
	}
}

// Reading a run agent's chat changes nothing about it: no "folder not found" for a checkout that
// was removed by design, and no process started to answer a context split.
func TestReadsDoNotChangeARunAgentsChat(t *testing.T) {
	e, fr := runEnv(t)
	cwd := filepath.Join(t.TempDir(), "checkout")
	if err := os.Mkdir(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.CreateOwned(OwnedSpec{ID: "agent-1", Run: ownRun, Role: model.RoleTask, Agent: model.Claude, Model: "sonnet", Cwd: cwd}); err != nil {
		t.Fatal(err)
	}
	id := "agent-1"
	if _, err := e.m.ContextSplit(id, false); !errors.Is(err, ErrNotStarted) {
		t.Fatalf("ContextSplit before the first message: %v", err)
	}
	e.sendOwned(id, "the brief")
	ag := e.claude.last(t)
	ag.emit(t, ownText("done", "p1")...)
	kept := e.split(id, false) // from the running process; kept in chat.json
	e.m.StopOwned(id, 0)
	if err := os.Remove(cwd); err != nil { // the engine removed the checkout
		t.Fatal(err)
	}
	e.reboot(fr)
	if err := e.m.Open(id); err != nil {
		t.Fatal(err)
	}
	if v := e.view(id); v.FolderMissing || v.Error != "" || v.Status != model.StatusReady {
		t.Fatalf("view of a finished agent whose checkout is gone: %+v", v)
	}
	spawns := e.claude.count()
	if got, err := e.m.ContextSplit(id, true); err != nil || got.Total != kept.Total {
		t.Fatalf("ContextSplit without a process: %+v %v, kept %+v", got, err, kept)
	}
	live, reads := e.claude.splitCalls()
	if live != 0 || reads != 0 || e.claude.count() != spawns {
		t.Fatalf("a process was started to read the split: %d live, %d reads", live, reads)
	}
	// A person's chat in the same state does show the missing folder.
	v := e.onRun(model.Claude)
	if err := e.m.Configure(v.ID, ConfigReq{Cwd: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	pcwd := e.view(v.ID).Cwd
	e.send(v.ID, "hello", "")
	e.claude.last(t).emit(t, ownText("hi", "p1")...)
	e.m.Stop(v.ID)
	os.Remove(pcwd)
	if err := e.m.Open(v.ID); err != nil || !e.view(v.ID).FolderMissing {
		t.Fatalf("a person's chat with its folder gone: %+v %v", e.view(v.ID), err)
	}
}

// ---- permission requests -------------------------------------------------------

// A permission request on a run agent's chat is answered "no" at once and recorded as decided, so
// the chat never waits for an answer; of its own agent and of an app-spawned subagent alike.
func TestRunAgentPermissionIsDeniedAtOnce(t *testing.T) {
	e, id, ag, w := ownStart(t)
	sa, child := e.ownChild(id, "child work")
	ask(t, ag, "", "r1")
	if got := e.status(id); got == model.StatusApproval {
		t.Fatal("the chat waits for an approval")
	}
	if c := e.card(id, "", "r1"); c.Decided != "deny" {
		t.Fatalf("the card: %+v", c)
	}
	if got := agentDecides(ag); len(got) != 1 || got[0] != (decision{"r1", false}) {
		t.Fatalf("what the agent was told: %+v", got)
	}
	// The card is on disk as decided.
	if raw := e.itemsFileAt(e.st.P.RunChatDir(ownRun, true, id)); !strings.Contains(raw, `"decided":"deny"`) {
		t.Fatalf("items.jsonl: %s", raw)
	}
	child.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "c1", ToolName: "Write"})
	if got := e.status(id); got == model.StatusApproval {
		t.Fatal("the chat waits for a subagent's approval")
	}
	if c := e.card(id, sa.ID, "c1"); c.Decided != "deny" {
		t.Fatalf("the subagent's card: %+v", c)
	}
	if got := agentDecides(child); len(got) != 1 || got[0] != (decision{"c1", false}) {
		t.Fatalf("what the subagent was told: %+v", got)
	}
	if err := e.m.Decide(id, "", "r1", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("Decide on a card the app answered: %v", err)
	}
	// The run goes on to settle: nothing waits.
	ownNotYet(t, w, "the turn runs")
	ag.emit(t, ownText("could not write", "p1")...)
	child.emit(t, ownText("child report", "")...)
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	ag.emit(t, ownText("done", "p2")...)
	if s := ownGot(t, w); s.Outcome != EndClean || s.Text != "done" {
		t.Fatalf("%+v", s)
	}
	// A person's chat on the run still asks.
	v := e.onRun(model.Claude)
	e.send(v.ID, "hello", "")
	pAg := e.claude.last(t)
	ask(t, pAg, "", "p1")
	if got := e.status(v.ID); got != model.StatusApproval {
		t.Fatalf("a person's chat on a run does not ask: %s", got)
	}
}

func (e *env) itemsFileAt(dir string) string {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(dir, "items.jsonl"))
	if err != nil {
		e.t.Fatal(err)
	}
	return string(raw)
}

// ---- tokens --------------------------------------------------------------------

// What the MCP endpoint decides tool access by: a caller resolved from a token says which run its
// chat is on, the role of that chat, and whether the caller is a subagent.
func TestRunCallersByToken(t *testing.T) {
	e, id, ag, _ := ownStart(t)
	c, ok := e.m.ResolveToken(ag.opts.MCP.Token)
	if !ok || c.Subagent || c.Chat != id || c.Meta.ID != id || c.Meta.Run != ownRun || c.Meta.Role != model.RoleTask {
		t.Fatalf("a run agent's token: %+v %v", c, ok)
	}
	// A subagent's token resolves to its parent's chat, marked as a subagent.
	sa, child := e.ownChild(id, "child work")
	c, ok = e.m.ResolveToken(child.opts.MCP.Token)
	if !ok || !c.Subagent || c.SID != sa.ID || c.Chat != id || c.Meta.Run != ownRun || c.Meta.Role != model.RoleTask {
		t.Fatalf("a run agent's subagent's token: %+v %v", c, ok)
	}
	// StopOwned revokes it; the chat's own token stays for the chat's life.
	e.m.StopOwned(id, 0)
	if _, ok := e.m.ResolveToken(child.opts.MCP.Token); ok {
		t.Fatal("a stopped subagent's token still resolves")
	}
	if _, ok := e.m.ResolveToken(ag.opts.MCP.Token); !ok {
		t.Fatal("the chat's token is gone after StopOwned")
	}

	// A person's chat on the run, and a branch of it: the run, and no role.
	v := e.onRun(model.Claude)
	e.send(v.ID, "hello", "")
	pAg := e.claude.last(t)
	pAg.emit(t, ownText("hi", "p1")...)
	c, ok = e.m.ResolveToken(pAg.opts.MCP.Token)
	if !ok || c.Subagent || c.Chat != v.ID || c.Meta.Run != ownRun || c.Meta.Role != "" {
		t.Fatalf("a run chat's token: %+v %v", c, ok)
	}
	if err := e.m.SendTo(v.ID, Target{Branch: model.MainBranch, At: 3, New: true}, "aside", "", nil); err != nil {
		t.Fatal(err)
	}
	c, ok = e.m.ResolveToken(e.claude.lastFork(t).opts.MCP.Token)
	if !ok || c.Chat != v.ID || c.Meta.Run != ownRun || c.Meta.Role != "" || c.Meta.ID == v.ID {
		t.Fatalf("the token of a branch of a run chat: %+v %v", c, ok)
	}
	if err := e.m.DeleteOwned(id); err != nil {
		t.Fatal(err)
	}
	if _, ok := e.m.ResolveToken(ag.opts.MCP.Token); ok {
		t.Fatal("a deleted chat's token still resolves")
	}
}

// ---- events --------------------------------------------------------------------

// The events of a run agent's chat reach clients only after Watch, and ClearWatches stops them.
func TestRunAgentEventsOnlyWhileWatched(t *testing.T) {
	e, id, ag, _ := ownStart(t)
	evs := e.listen()
	types := func() map[string]int {
		t.Helper()
		got := map[string]int{}
		for _, ev := range evs.drain(t, e.br) {
			got[ev["type"].(string)]++
		}
		return got
	}
	sa, child := e.ownChild(id, "child work")
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "child text"})
	ag.emit(t, ownText("first", "p1")...)
	if got := types(); len(got) != 0 {
		t.Fatalf("events of an unwatched run agent's chat: %v", got)
	}

	e.m.Watch(id)
	e.m.Watch("nope")
	child.emit(t, agent.Event{Kind: agent.EvText, Text: "more"}, agent.Event{Kind: agent.EvTurnEnd})
	waitFor(t, "the delivery", func() bool { return len(ag.sent()) == 2 })
	ag.emit(t, ownText("second", "p2")...)
	got := types()
	if got["chat"] == 0 || got["chat_items"] == 0 || got["sub"] == 0 || got["sub_items"] == 0 {
		t.Fatalf("events of a watched run agent's chat: %v", got)
	}
	_ = sa

	e.m.ClearWatches()
	e.sendOwned(id, "again")
	ag.emit(t, ownText("third", "p3")...)
	if got := types(); len(got) != 0 {
		t.Fatalf("events after ClearWatches: %v", got)
	}

	// A person's chat on the run is never filtered, and Watch does nothing for it.
	v := e.onRun(model.Claude)
	types()
	e.m.Watch(v.ID)
	e.m.ClearWatches()
	e.send(v.ID, "hello", "")
	e.claude.last(t).emit(t, ownText("hi", "p1")...)
	if got := types(); got["chat"] == 0 || got["chat_items"] == 0 {
		t.Fatalf("events of a person's chat on a run: %v", got)
	}

	// A watch ends with the chat.
	e.m.Watch(id)
	if err := e.m.DeleteOwned(id); err != nil {
		t.Fatal(err)
	}
	e.m.watchMu.Lock()
	n := len(e.m.watched)
	e.m.watchMu.Unlock()
	if n != 0 {
		t.Fatalf("%d watches left after the delete", n)
	}
}

// ---- options -------------------------------------------------------------------

// A subagent of a chat on a run takes the run's group for its defaults, not the user's "last".
func TestRunChatSubagentDefaultsComeFromTheRunsGroup(t *testing.T) {
	e, _ := runEnv(t)
	e.setDefaults(model.Defaults{
		Groups: map[string]model.GroupDefaults{gOne: {ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "gpt-5.4-mini"}}}},
		Last:   model.GroupDefaults{ByAgent: map[model.AgentKind]model.ModelChoice{model.Cursor: {Model: "composer-2", Effort: "low"}}},
	})
	id := e.agentChat("agent-1", model.RoleTask, model.Claude)
	e.sendOwned(id, "the brief")
	sa := e.spawn(id, SpawnSubRequest{Prompt: "other kind", Kind: model.Cursor})
	if sa.Kind != model.Cursor || sa.Model != "gpt-5.4-mini" || sa.Effort != "" {
		t.Fatalf("a cross-kind subagent of a run agent: %+v", sa)
	}
	// A same-kind subagent inherits the chat's model, which is the run's.
	same := e.spawn(id, SpawnSubRequest{Prompt: "same kind"})
	if same.Kind != model.Claude || same.Model != "sonnet" {
		t.Fatalf("a same-kind subagent of a run agent: %+v", same)
	}
}

// The first tools/list of a run agent's new process finds a running turn: the turn is marked in
// the hold of the chat's lock that starts the process.
func TestSendOwnedMarksTheTurnBeforeTheProcessCanAsk(t *testing.T) {
	e, _ := runEnv(t)
	id := e.agentChat("agent-1", model.RoleOrchestrator, model.Claude)
	saw := make(chan bool, 1)
	e.m.Spawners[model.Claude] = askingSpawner{inner: e.claude, ask: func() { saw <- e.m.TurnRunning(id) }}
	e.sendOwned(id, "turn 1")
	select {
	case running := <-saw:
		if !running {
			t.Fatal("the starting process did not find a running turn")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the lookup did not return")
	}
}

// askingSpawner starts a lookup, as a starting process does (its tools/list), before Spawn returns.
type askingSpawner struct {
	inner agent.Spawner
	ask   func()
}

func (s askingSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	go s.ask() // waits for the chat's lock, which the Send that started the process holds
	time.Sleep(20 * time.Millisecond)
	return s.inner.Spawn(o)
}
