package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// Subagents that start subagents: a chat whose depth is above 1 (nested.go).

// nested is a Claude chat at the given depth whose agent rests after its first turn.
func (e *env) nested(depth int) (id string, parent *fakeAgent) {
	e.t.Helper()
	id, parent = e.idleParent()
	e.limits(id, depth, model.MaxSubCap)
	return id, parent
}

// child spawns a Claude subagent for the caller from ("" = the chat's agent) and returns its
// record and its process, which has its prompt.
func (e *env) child(id, from, prompt string) (model.Subagent, *fakeAgent) {
	e.t.Helper()
	n := e.claude.count()
	sa := e.spawn(id, SpawnSubRequest{Prompt: prompt, From: from})
	return sa, waitChild(e.t, e.claude, n+1)
}

// closed waits for the processes to be closed: a stop closes them in the background.
func closed(t *testing.T, what string, ags ...*fakeAgent) {
	t.Helper()
	waitFor(t, what+" to be closed", func() bool {
		for _, a := range ags {
			if !agentClosed(a) {
				return false
			}
		}
		return true
	})
}

// revoked reports whether the token of a subagent's process resolves no more.
func (e *env) revoked(a *fakeAgent) bool {
	_, ok := e.m.ResolveToken(a.opts.MCP.Token)
	return !ok
}

// A subagent of a chat at depth 2 starts a subagent: the new one is recorded with it as Parent
// and linked from the spawn call in its thread, not the chat's, and is at the deepest level.
func TestNestedSpawnRecordsParentAndLinks(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	evs := listen(t, e.br)
	a, pa := e.child(id, "", "level one")
	if a.Parent != "" || pa.opts.NoSpawn || !pa.opts.Subagent {
		t.Fatalf("a subagent that may spawn: %+v, started with %+v", a, pa.opts)
	}
	if c := e.callerOf(pa.opts.MCP.Token); !c.MaySpawn() || c.Level != 1 || c.Depth != 2 || c.SID != a.ID {
		t.Fatalf("its caller %+v", c)
	}
	evs.drain(t, e.br)

	// Its spawn call is in its own thread when the spawn comes.
	emitSpawnItem(t, pa, "tool-b", "mcp__board__spawn_subagent", `{"prompt":"level two"}`)
	b, pb := e.child(id, a.ID, "level two")
	if b.Parent != a.ID || b.Tool != "tool-b" {
		t.Fatalf("the nested subagent %+v", b)
	}
	if got := itemSubagent(e.subItems(id, a.ID), "tool-b"); got != b.ID {
		t.Fatalf("the spawn item in its parent's thread names %q, want %s", got, b.ID)
	}
	if got := itemSubagent(e.items(id), "tool-b"); got != "" {
		t.Fatalf("the chat's thread has the nested spawn item: %q", got)
	}
	got := evs.drain(t, e.br)
	linked := false
	for _, ev := range ofType(got, "sub_items") {
		if ev["sub"] != a.ID {
			continue
		}
		for _, u := range updatesOf(t, ev) {
			linked = linked || (u.Item.ToolID == "tool-b" && u.Item.Subagent == b.ID)
		}
	}
	if !linked {
		t.Fatalf("no sub_items of %s links the spawn item to %s: %v", a.ID, b.ID, got)
	}
	announced := false
	for _, ev := range ofType(got, "sub") {
		if sa := subOf(t, ev); sa.ID == b.ID && sa.Parent == a.ID {
			announced = true
		}
	}
	if !announced {
		t.Fatalf("no sub event of %s with its parent: %v", b.ID, got)
	}
	if f := e.subFile(id, b.ID); f.Parent != a.ID || f.Tool != "tool-b" {
		t.Fatalf("subagent.json of the nested one %+v", f)
	}

	// It is at the chat's deepest level: no spawn family, and a spawn is refused.
	if !pb.opts.NoSpawn {
		t.Fatalf("a subagent at the deepest level started with %+v", pb.opts)
	}
	if c := e.callerOf(pb.opts.MCP.Token); c.MaySpawn() || c.Level != 2 || c.Depth != 2 {
		t.Fatalf("its caller %+v", c)
	}
	records := len(e.subs(id))
	_, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "level three", From: b.ID})
	var de *SubDepthError
	if !errors.As(err, &de) || de.Level != 2 || de.Depth != 2 ||
		err.Error() != "spawn_subagent is not available to a subagent at level 2: this chat's subagent depth is 2" {
		t.Fatalf("a spawn below the deepest level: %v", err)
	}
	if len(e.subs(id)) != records {
		t.Fatal("the refused spawn left a record")
	}

	// A spawn call that reaches the thread after the spawn is linked when it comes.
	c := e.spawn(id, SpawnSubRequest{Prompt: "late item", From: a.ID})
	if c.Tool != "" {
		t.Fatalf("linked to an item that is not there: %+v", c)
	}
	emitSpawnItem(t, pa, "tool-c", "spawn_subagent", `{"prompt":"late item"}`)
	if got := itemSubagent(e.subItems(id, a.ID), "tool-c"); got != c.ID || e.sub(id, c.ID).Tool != "tool-c" {
		t.Fatalf("the late spawn item names %q, the record %+v", got, e.sub(id, c.ID))
	}
	if _, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "x", From: "no-such"}); err == nil {
		t.Fatal("a spawn by a subagent the chat does not have went through")
	}
}

// Depth 3: three levels, and none below.
func TestNestedSpawnThreeLevels(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	a, pa := e.child(id, "", "one")
	b, pb := e.child(id, a.ID, "two")
	c, pc := e.child(id, b.ID, "three")
	if b.Parent != a.ID || c.Parent != b.ID {
		t.Fatalf("parents: %q %q", b.Parent, c.Parent)
	}
	for i, p := range []*fakeAgent{pa, pb, pc} {
		got := e.callerOf(p.opts.MCP.Token)
		if got.Level != i+1 || got.MaySpawn() != (i < 2) || p.opts.NoSpawn != (i == 2) {
			t.Fatalf("level %d: caller %+v, started with NoSpawn %v", i+1, got, p.opts.NoSpawn)
		}
	}
	var de *SubDepthError
	if _, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "four", From: c.ID}); !errors.As(err, &de) || de.Level != 3 || de.Depth != 3 {
		t.Fatalf("a fourth level: %v", err)
	}
	if e.view(id).SubsRunning != 3 {
		t.Fatalf("%d running", e.view(id).SubsRunning)
	}
}

// What a subagent's spawn omits is taken from that subagent, not from the chat.
func TestNestedSpawnInheritsFromItsParent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2) // a Claude chat: sonnet, high
	a := e.spawn(id, SpawnSubRequest{Prompt: "one", Model: "opus", Effort: "low"})
	b := e.spawn(id, SpawnSubRequest{Prompt: "two", From: a.ID})
	if b.Kind != model.Claude || b.Model != "opus" || b.Effort != "low" {
		t.Fatalf("a subagent of an opus/low subagent: %s %q %q", b.Kind, b.Model, b.Effort)
	}
	if k, mo, ef, err := e.m.SpawnDefaultsFor(id, a.ID, ""); err != nil || k != model.Claude || mo != "opus" || ef != "low" {
		t.Fatalf("SpawnDefaultsFor the subagent: %s %q %q %v", k, mo, ef, err)
	}
	if k, mo, ef, err := e.m.SpawnDefaults(id, ""); err != nil || k != model.Claude || mo != "sonnet" || ef != "high" {
		t.Fatalf("SpawnDefaults of the chat: %s %q %q %v", k, mo, ef, err)
	}
	// A named model with no effort: the subagent's effort where the model offers it.
	if n := e.spawn(id, SpawnSubRequest{Prompt: "named", Model: "sonnet", From: a.ID}); n.Model != "sonnet" || n.Effort != "low" {
		t.Fatalf("a named model: %q %q", n.Model, n.Effort)
	}
	// Another agent than the chat's: its subagent is of that agent, with its model and effort.
	cu := e.spawn(id, SpawnSubRequest{Prompt: "cursor", Kind: model.Cursor, Model: "composer-2", Effort: "low"})
	under := e.spawn(id, SpawnSubRequest{Prompt: "under cursor", From: cu.ID})
	if under.Kind != model.Cursor || under.Model != "composer-2" || under.Effort != "low" {
		t.Fatalf("a subagent of a Cursor subagent: %s %q %q", under.Kind, under.Model, under.Effort)
	}
	if _, _, _, err := e.m.SpawnDefaultsFor(id, "no-such", ""); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("SpawnDefaultsFor an unknown subagent: %v", err)
	}
}

// A caller stops only the subagents it started itself, the chat's agent too.
func TestStopOnlyOwnSubagents(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	a, _ := e.child(id, "", "a")
	b, pb := e.child(id, a.ID, "b")
	a2, _ := e.child(id, "", "a2")
	b2, _ := e.child(id, a2.ID, "b2")
	for _, c := range []struct{ what, by, sid string }{
		{"a sibling", a.ID, a2.ID},
		{"a sibling's subagent", a.ID, b2.ID},
		{"its own parent", b.ID, a.ID},
		{"itself", a.ID, a.ID},
		{"the chat's agent a subagent's subagent", "", b.ID},
	} {
		if err := e.m.StopSubagentBy(id, c.by, c.sid); !errors.Is(err, ErrNotStarter) {
			t.Fatalf("stopping %s: %v", c.what, err)
		}
	}
	if err := e.m.StopSubagentBy(id, a.ID, "no-such"); !errors.Is(err, ErrNoSubagent) {
		t.Fatalf("stopping an unknown sid: %v", err)
	}
	if n := e.view(id).SubsRunning; n != 4 {
		t.Fatalf("%d running after the refused stops", n)
	}
	if err := e.m.StopSubagentBy(id, a.ID, b.ID); err != nil {
		t.Fatal(err)
	}
	if s := e.sub(id, b.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
		t.Fatalf("the stopped subagent %+v", s)
	}
	closed(t, "the stopped subagent's process", pb)
	if e.sub(id, a.ID).Status != model.SubRunning || e.view(id).SubsRunning != 3 {
		t.Fatalf("after the stop: its parent %+v, %d running", e.sub(id, a.ID), e.view(id).SubsRunning)
	}
	if err := e.m.StopSubagentBy(id, a.ID, b.ID); err == nil || err.Error() != "subagent "+b.ID+" is stopped" {
		t.Fatalf("stopping it again: %v", err)
	}
}

// The waiting subagent: a turn of it that ends cleanly while subagents it started run leaves it
// running and waiting, with its process and its place under the cap. It gets their results as
// messages that start further turns, and finishes when a turn ends with nothing below it; its
// own result then goes to the chat's agent.
func TestWaitingSubagent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	e.limits(id, 2, 3)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "part one")
	c, pc := e.child(id, a.ID, "part two")
	evs := listen(t, e.br)

	e.finish(pa, "I have spawned two")
	s := e.sub(id, a.ID)
	if s.Status != model.SubRunning || !s.Waiting || s.Ended != 0 || s.Delivery != model.SubNotOwed {
		t.Fatalf("after its turn ended with two running: %+v", s)
	}
	if f := e.subFile(id, a.ID); !f.Waiting || f.Status != model.SubRunning {
		t.Fatalf("subagent.json of the waiting one %+v", f)
	}
	if agentClosed(pa) || e.revoked(pa) || len(pa.sent()) != 1 || len(parent.sent()) != 1 {
		t.Fatalf("a waiting subagent: closed %v, token revoked %v, %d messages to it, %d to the chat's agent",
			agentClosed(pa), e.revoked(pa), len(pa.sent()), len(parent.sent()))
	}
	waiting := false
	for _, ev := range ofType(evs.drain(t, e.br), "sub") {
		if sa := subOf(t, ev); sa.ID == a.ID && sa.Waiting {
			waiting = true
		}
	}
	if !waiting {
		t.Fatal("no sub event says it waits")
	}
	// It counts against the cap, which is 3: itself and its two.
	var ce *SubCapError
	if _, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "more"}); !errors.As(err, &ce) || ce.Running != 3 {
		t.Fatalf("a spawn with a waiting subagent and its two running: %v", err)
	}

	// The first result: a message to it, which starts a turn; nothing for the chat's agent.
	e.finish(pb, "report of b")
	if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) {
		t.Fatalf("the waiting subagent got %q", texts(pa.sent()[len(pa.sent())-1]))
	}
	msg := lastSend(t, pa)
	for _, want := range []string{"<subagent-results>\nThis message was written by the app, not by the user.", "<report>report of b</report>",
		"<status>completed</status>", "\nSubagents you spawned still running: 1.\n</subagent-results>"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the message to the subagent lacks %q:\n%s", want, msg)
		}
	}
	if len(pa.sent()[1]) != 1 {
		t.Fatalf("the message has %d blocks, want the results alone", len(pa.sent()[1]))
	}
	if s := e.sub(id, a.ID); s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("in the turn its results started: %+v", s)
	}
	if f := e.subFile(id, b.ID); f.Delivery != model.SubSent || f.Status != model.SubCompleted {
		t.Fatalf("the delivered one %+v", f)
	}
	if rows := resultRows(e.subItems(id, a.ID)); !reflect.DeepEqual(rows, []string{b.ID}) {
		t.Fatalf("result rows in the subagent's thread %v", rows)
	}
	if rows := resultRows(e.items(id)); len(rows) != 0 || len(parent.sent()) != 1 || e.view(id).SubsOwed != 0 {
		t.Fatalf("the chat got something of a nested result: rows %v, %d sends, %d owed", rows, len(parent.sent()), e.view(id).SubsOwed)
	}
	closed(t, "the finished subagent's process", pb)

	// That turn ends with one still running: it waits again.
	e.finish(pa, "one is in")
	if s := e.sub(id, a.ID); !s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("after its second turn: %+v", s)
	}
	e.finish(pc, "report of c")
	if len(pa.sent()) != 3 || !reflect.DeepEqual(deliveredSids(pa.sent()[2]), []string{c.ID}) ||
		!strings.Contains(lastSend(t, pa), "Subagents you spawned still running: 0.") {
		t.Fatalf("the second result: %q", texts(pa.sent()[len(pa.sent())-1]))
	}

	// A turn that ends with nothing below it finishes it, and its result goes up.
	e.finish(pa, "the whole report")
	s = e.sub(id, a.ID)
	if s.Status != model.SubCompleted || s.Waiting || s.Last != "the whole report" || s.Delivery != model.SubSent {
		t.Fatalf("finished: %+v", s)
	}
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
	}
	up := lastSend(t, parent)
	if !strings.Contains(up, "<report>the whole report</report>") || !strings.Contains(up, "\nSubagents of this chat still running: 0.\n") ||
		strings.Contains(up, b.ID) || strings.Contains(up, c.ID) {
		t.Fatalf("the message to the chat's agent:\n%s", up)
	}
	if rows := resultRows(e.items(id)); !reflect.DeepEqual(rows, []string{a.ID}) {
		t.Fatalf("result rows in the chat's thread %v", rows)
	}
	closed(t, "its process", pa)
	if !e.revoked(pa) || e.view(id).SubsRunning != 0 {
		t.Fatalf("after it finished: token revoked %v, %d running", e.revoked(pa), e.view(id).SubsRunning)
	}
	if kinds := kindsOf(e.subItems(id, a.ID)); kinds != "text subresult text subresult text" {
		t.Fatalf("its thread: %s", kinds)
	}
}

// Results that became owed while the subagent's turn ran go to it when that turn ends, as one
// message in completion order; it is not shown as waiting in between.
func TestResultsOwedAtTheEndOfATurn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	c, pc := e.child(id, a.ID, "two")
	e.finish(pb, "b")
	e.clock.Add(5)
	e.finish(pc, "c")
	if len(pa.sent()) != 1 || e.sub(id, b.ID).Delivery != model.SubOwed || e.sub(id, c.ID).Delivery != model.SubOwed {
		t.Fatalf("results came while its turn ran: %d messages, %q %q", len(pa.sent()), e.sub(id, b.ID).Delivery, e.sub(id, c.ID).Delivery)
	}
	if e.view(id).SubsOwed != 0 {
		t.Fatalf("the chat's view counts %d owed: these are owed to a subagent", e.view(id).SubsOwed)
	}
	evs := listen(t, e.br)
	e.finish(pa, "spawned both")
	if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID, c.ID}) {
		t.Fatalf("at the end of its turn it got %v", deliveredSids(pa.sent()[len(pa.sent())-1]))
	}
	for _, ev := range ofType(evs.drain(t, e.br), "sub") {
		if sa := subOf(t, ev); sa.ID == a.ID && sa.Waiting {
			t.Fatal("it was shown as waiting with its results at hand")
		}
	}
	if s := e.sub(id, a.ID); s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("in the carrying turn: %+v", s)
	}
	e.finish(pa, "done")
	if e.sub(id, a.ID).Status != model.SubCompleted || len(parent.sent()) != 2 {
		t.Fatalf("after the carrying turn: %+v, %d messages to the chat's agent", e.sub(id, a.ID), len(parent.sent()))
	}
}

// A result that cannot be delivered to a waiting subagent fails that subagent, once: nothing is
// tried again and the chat is not held. Whoever started it is told of the failure.
func TestUndeliverableResultFailsTheSubagent(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	e.finish(pa, "waiting for one")
	pa.failSends(errors.New("broken pipe"))
	e.finish(pb, "report of b")

	s := e.sub(id, a.ID)
	if s.Status != model.SubFailed || s.Waiting || !strings.Contains(s.Error, "could not be sent to it: broken pipe") {
		t.Fatalf("the subagent whose results were refused: %+v", s)
	}
	if got := notes(e.subItems(id, a.ID), "error"); len(got) != 1 || !strings.Contains(got[0], "broken pipe") {
		t.Fatalf("notes in its thread %q", got)
	}
	if pa.refused() != 1 {
		t.Fatalf("%d attempts, want one", pa.refused())
	}
	if d := e.sub(id, b.ID).Delivery; d != model.SubGivenUp {
		t.Fatalf("the result that did not reach it: %q", d)
	}
	closed(t, "the failed subagent's process", pa)
	// Its parent, the chat's agent, is told, in a turn of its own: the chat is not held.
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
	}
	if up := lastSend(t, parent); !strings.Contains(up, "<status>failed</status>") || !strings.Contains(up, "broken pipe") {
		t.Fatalf("the message to the chat's agent:\n%s", up)
	}
	if e.view(id).SubsOwed != 0 || e.view(id).SubsRunning != 0 {
		t.Fatalf("%d owed, %d running", e.view(id).SubsOwed, e.view(id).SubsRunning)
	}
}

// How a turn that carries results to a subagent settles them, by how it ends.
func TestCarryingTurnOfASubagent(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name     string
		kind     model.AgentKind
		evs      []agent.Event
		status   model.SubStatus
		delivery model.SubDelivery
	}{
		{"a clean end with no reply, Claude", model.Claude, []agent.Event{{Kind: agent.EvTurnEnd}}, model.SubCompleted, model.SubSent},
		{"a clean end with no reply, Cursor", model.Cursor, []agent.Event{{Kind: agent.EvTurnEnd}}, model.SubCompleted, model.SubSent},
		{"a clean end with no reply, pi", model.Pi, []agent.Event{{Kind: agent.EvThinking}, {Kind: agent.EvTurnEnd}}, model.SubFailed, model.SubGivenUp},
		{"a reply, pi", model.Pi, []agent.Event{{Kind: agent.EvText, Text: "got it"}, {Kind: agent.EvTurnEnd}}, model.SubCompleted, model.SubSent},
		{"an error before any reply", model.Claude, []agent.Event{{Kind: agent.EvTurnEnd, Error: "overloaded"}}, model.SubCompleted, model.SubGivenUp},
		{"an error after a reply", model.Claude, []agent.Event{{Kind: agent.EvText, Text: "got it"}, {Kind: agent.EvTurnEnd, Error: "overloaded"}}, model.SubCompleted, model.SubSent},
		{"an abort", model.Claude, []agent.Event{{Kind: agent.EvTurnEnd, Aborted: true}}, model.SubStopped, model.SubGivenUp},
		{"the process's exit", model.Claude, []agent.Event{{Kind: agent.EvExit, ExitErr: "killed"}}, model.SubFailed, model.SubGivenUp},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			id, parent := e.nested(2)
			sp := e.spawnerOf(c.kind)
			n := sp.count()
			a := e.spawn(id, SpawnSubRequest{Prompt: "delegate", Kind: c.kind})
			pa := waitChild(t, sp, n+1)
			b := e.spawn(id, SpawnSubRequest{Prompt: "one", From: a.ID})
			pb := waitChild(t, sp, n+2)
			e.finish(pa, "waiting")
			e.finish(pb, "report of b")
			if len(pa.sent()) != 2 {
				t.Fatalf("%d messages to the waiting subagent", len(pa.sent()))
			}
			pa.emit(t, c.evs...)
			e.m.handoffs.Wait()
			s := e.sub(id, a.ID)
			if s.Status != c.status || s.Waiting {
				t.Fatalf("the subagent: %+v, want %s", s, c.status)
			}
			if d := e.sub(id, b.ID).Delivery; d != c.delivery {
				t.Fatalf("the result it was handed: %q, want %q", d, c.delivery)
			}
			// However it ended, it ended by itself: the chat's agent is told.
			if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
				t.Fatalf("the chat's agent got %d messages", len(parent.sent()))
			}
			if c.status == model.SubFailed && c.kind == model.Pi && !strings.Contains(s.Error, "ended with no reply") {
				t.Fatalf("its error %q", s.Error)
			}
		})
	}
}

// Stopping a subagent stops every subagent below it, and nobody is owed anything for them.
func TestStopSubagentStopsThoseBelow(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(3)
	a, pa := e.child(id, "", "a")
	b, pb := e.child(id, a.ID, "b")
	c, pc := e.child(id, b.ID, "c")
	d, pd := e.child(id, a.ID, "d")
	other, po := e.child(id, "", "another of the chat's")
	done, pdone := e.child(id, a.ID, "finished before the stop")
	e.finish(pdone, "early") // owed to a, whose turn runs

	if err := e.m.StopSubagent(id, a.ID); err != nil {
		t.Fatal(err)
	}
	for _, sa := range []model.Subagent{a, b, c, d} {
		if s := e.sub(id, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed || s.Waiting {
			t.Fatalf("after the stop: %+v", s)
		}
	}
	closed(t, "the processes of the stopped ones", pa, pb, pc, pd)
	for _, p := range []*fakeAgent{pa, pb, pc, pd} {
		if !e.revoked(p) {
			t.Fatal("a stopped subagent's token still resolves")
		}
	}
	if s := e.sub(id, done.ID); s.Status != model.SubCompleted || s.Delivery != model.SubGivenUp {
		t.Fatalf("the result that was owed to the stopped one: %+v", s)
	}
	if s := e.sub(id, other.ID); s.Status != model.SubRunning || agentClosed(po) {
		t.Fatalf("a subagent that is not below it: %+v", s)
	}
	if len(parent.sent()) != 1 || e.view(id).SubsOwed != 0 || e.view(id).SubsRunning != 1 {
		t.Fatalf("after a stop the chat's agent asked for: %d messages, %d owed, %d running", len(parent.sent()), e.view(id).SubsOwed, e.view(id).SubsRunning)
	}
}

// A subagent that ends in another way than finishing takes those below it with it, and whoever
// started it is told of it alone.
func TestEndedSubagentTakesThoseBelow(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		name    string
		waiting bool // its turn has ended, and it waits, when it ends
		evs     []agent.Event
		status  model.SubStatus
	}{
		{"its process exits with an error", false, []agent.Event{{Kind: agent.EvExit, ExitErr: "crashed"}}, model.SubFailed},
		{"its process exits while it waits", true, []agent.Event{{Kind: agent.EvExit}}, model.SubStopped},
		{"its turn is aborted", false, []agent.Event{{Kind: agent.EvTurnEnd, Aborted: true}}, model.SubStopped},
		{"its turn ends with an error", false, []agent.Event{{Kind: agent.EvTurnEnd, Error: "overloaded"}}, model.SubCompleted},
	} {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			e := newEnv(t)
			id, parent := e.nested(3)
			a, pa := e.child(id, "", "a")
			b, pb := e.child(id, a.ID, "b")
			deep, pdeep := e.child(id, b.ID, "c")
			if c.waiting {
				e.finish(pa, "waiting")
			}
			pa.emit(t, c.evs...)
			e.m.handoffs.Wait()
			if s := e.sub(id, a.ID); s.Status != c.status || s.Waiting || s.Delivery != model.SubSent {
				t.Fatalf("the one that ended: %+v", s)
			}
			for _, sa := range []model.Subagent{b, deep} {
				if s := e.sub(id, sa.ID); s.Status != model.SubStopped || s.Delivery != model.SubNotOwed {
					t.Fatalf("below it: %+v", s)
				}
			}
			closed(t, "the processes below it", pb, pdeep)
			if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
				t.Fatalf("the chat's agent got %d messages, the last about %v", len(parent.sent()), deliveredSids(parent.sent()[len(parent.sent())-1]))
			}
			if e.view(id).SubsRunning != 0 {
				t.Fatalf("%d running", e.view(id).SubsRunning)
			}
		})
	}
}

// Stopping the chat's agent stops every subagent, at every level, as it always did; a result
// that was owed to one of them is given up.
func TestInterruptStopsEveryLevel(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(3)
	a, pa := e.child(id, "", "a")
	b, pb := e.child(id, a.ID, "b")
	c, pc := e.child(id, b.ID, "c")
	done, pdone := e.child(id, b.ID, "finishes")
	e.finish(pa, "waiting") // a waits
	e.finish(pdone, "early")
	if err := e.m.Interrupt(id); err != nil {
		t.Fatal(err)
	}
	for _, sa := range []model.Subagent{a, b, c} {
		if s := e.sub(id, sa.ID); s.Status != model.SubStopped || s.Waiting || s.Delivery != model.SubNotOwed {
			t.Fatalf("after Interrupt: %+v", s)
		}
	}
	closed(t, "every subagent's process", pa, pb, pc)
	if s := e.sub(id, done.ID); s.Delivery != model.SubGivenUp {
		t.Fatalf("the result owed to a stopped subagent: %+v", s)
	}
	if v := e.view(id); v.SubsRunning != 0 || v.SubsOwed != 0 {
		t.Fatalf("%d running, %d owed", v.SubsRunning, v.SubsOwed)
	}
}

// The count that ends a result block is of its reader's own subagents: the chat's agent is not
// told of those a subagent of its started.
func TestStillRunningCountsTheReadersOwn(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	_, pa := e.child(id, "", "finishes")
	x, _ := e.child(id, "", "runs on")
	e.child(id, x.ID, "under it")
	e.child(id, x.ID, "under it too")
	e.finish(pa, "report")
	if up := lastSend(t, parent); !strings.Contains(up, "\nSubagents of this chat still running: 1.\n") {
		t.Fatalf("the chat's agent, with one of its own and two of that one's running, read:\n%s", up)
	}
	if e.view(id).SubsRunning != 3 {
		t.Fatalf("the view counts %d running, want every level's", e.view(id).SubsRunning)
	}
	if got := resultsBlock(nil, 2, false, true); !strings.Contains(got, "\nSubagents you spawned still running: 2.\n") || strings.Contains(got, "this chat") {
		t.Fatalf("a subagent's block:\n%s", got)
	}
}

// A permission request of a nested subagent lands in the chat's thread with its sid, and the
// answer goes to its process.
func TestNestedPermissionRequest(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	a, _ := e.child(id, "", "a")
	b, pb := e.child(id, a.ID, "b")
	pb.emit(t, agent.Event{Kind: agent.EvPermRequest, PermID: "p1", ToolName: "Bash", ToolID: "t1", Input: json.RawMessage(`{"command":"ls"}`)})
	items := e.items(id)
	last := items[len(items)-1]
	if last.Kind != "perm" || last.Subagent != b.ID || e.status(id) != model.StatusApproval {
		t.Fatalf("the request: %+v, status %s", last, e.status(id))
	}
	if n := len(e.subItems(id, a.ID)) + len(e.subItems(id, b.ID)); n != 0 {
		t.Fatalf("%d items in the subagents' threads", n)
	}
	if err := e.m.Decide(id, b.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if got := agentDecides(pb); len(got) != 1 || !got[0].allow || got[0].id != "p1" {
		t.Fatalf("the nested subagent's process got %+v", got)
	}
}

// A subagent with several turns: its context numbers follow its last turn, and its cost is what
// its process came to, each turn counted once. One stopped while it waits lost no turn.
func TestSeveralTurnsCostAndContext(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	v := e.onRun(model.Claude) // cost is kept for a chat on a run
	e.limits(v.ID, 2, model.MaxSubCap)
	e.send(v.ID, "go", "")
	e.m.naming.Wait()
	e.claude.last(t).emit(t, agent.Event{Kind: agent.EvTurnEnd})
	id := v.ID
	a, pa := e.child(id, "", "delegate")
	_, pb := e.child(id, a.ID, "one")
	tok := func(in, out int64) model.TokenCount { return model.TokenCount{In: in, Out: out} }

	pa.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 1000, CtxWindow: 200000},
		agent.Event{Kind: agent.EvTurnEnd, HasCost: true, CostUSD: 0.10, HasTokens: true, CumTokens: tok(100, 10)})
	if s := e.sub(id, a.ID); !s.Waiting || s.Tokens != 1000 || s.Window != 200000 {
		t.Fatalf("after its first turn: %+v", s)
	}
	if got := e.cost(id); got.USD != 0.10 || got.Tokens != tok(100, 10) {
		t.Fatalf("cost after its first turn: %+v", got)
	}
	pb.emit(t, agent.Event{Kind: agent.EvText, Text: "b"}, agent.Event{Kind: agent.EvTurnEnd, HasCost: true, CostUSD: 0.02, HasTokens: true, CumTokens: tok(20, 2)})
	e.m.handoffs.Wait()
	// Its second turn: the process reports its total again, which has grown.
	pa.emit(t, agent.Event{Kind: agent.EvUsage, CtxIn: 2500}, agent.Event{Kind: agent.EvText, Text: "all in"},
		agent.Event{Kind: agent.EvTurnEnd, HasCost: true, CostUSD: 0.25, HasTokens: true, CumTokens: tok(260, 30)})
	e.m.handoffs.Wait()
	s := e.sub(id, a.ID)
	if s.Status != model.SubCompleted || s.Tokens != 2500 || s.Window != 200000 || s.Last != "all in" {
		t.Fatalf("after its second turn: %+v", s)
	}
	got := e.cost(id)
	if d := got.USD - 0.27; d > 1e-9 || d < -1e-9 || got.Tokens != tok(280, 32) || got.Partial {
		t.Fatalf("cost of the chat: %+v, want 0.27 (0.25 and 0.02) and the tokens once", got)
	}

	// Stopped between turns, nothing is lost; stopped in a turn, that turn is.
	w, pw := e.child(id, "", "waits")
	e.child(id, w.ID, "under it")
	pw.emit(t, agent.Event{Kind: agent.EvTurnEnd, HasCost: true, CostUSD: 0.05})
	if !e.sub(id, w.ID).Waiting {
		t.Fatal("it does not wait")
	}
	if err := e.m.StopSubagent(id, w.ID); err != nil {
		t.Fatal(err)
	}
	// The one under it was in its turn: that turn's cost is lost, the waiting one's is not.
	if lost := e.runMeta(id, false).Cost.Lost; lost != 1 {
		t.Fatalf("%d lost turns after stopping a waiting subagent with one running under it, want that one's", lost)
	}
}

// After a restart no subagent runs: one found running on disk is stopped, a waiting one and one
// a subagent started too, and a result that was owed to a subagent is given up.
func TestRestartStopsNestedAndWaiting(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	a, pa := e.child(id, "", "a")
	b, _ := e.child(id, a.ID, "b")
	done, pdone := e.child(id, a.ID, "finishes")
	e.finish(pdone, "early") // owed to a, whose turn runs
	c, _ := e.child(id, a.ID, "c")
	_ = pa
	// What a crash leaves: the records as they are, a waiting one among them.
	e.m.Shutdown()
	for _, sa := range []model.Subagent{a, b, c} {
		path := filepath.Join(e.subDir(id, sa.ID), "subagent.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var rec map[string]any
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatal(err)
		}
		rec["status"] = "running"
		delete(rec, "ended")
		if sa.ID == a.ID {
			rec["waiting"] = true
		}
		raw, _ = json.Marshal(rec)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rec := e.subFile(id, done.ID)
	rec.Delivery = model.SubOwed
	e.storeSub(id, rec)

	e.boot()
	for _, sa := range []model.Subagent{a, b, c} {
		if s := e.sub(id, sa.ID); s.Status != model.SubStopped || s.Waiting || s.Delivery != model.SubNotOwed {
			t.Fatalf("after the restart: %+v", s)
		}
		if f := e.subFile(id, sa.ID); f.Status != model.SubStopped || f.Waiting {
			t.Fatalf("subagent.json after the restart: %+v", f)
		}
	}
	if s := e.sub(id, done.ID); s.Delivery != model.SubGivenUp {
		t.Fatalf("the result that was owed to a subagent: %+v", s)
	}
	if v := e.view(id); v.SubsRunning != 0 || v.SubsOwed != 0 {
		t.Fatalf("%d running, %d owed after the restart", v.SubsRunning, v.SubsOwed)
	}
	e.deliverNow(id)
	if e.claude.count() != 0 {
		t.Fatal("a process was started for a nested result")
	}
}

// A copy of a chat with nested subagents: those that ran are not carried over, the agent is told
// of its own alone, and a result a subagent had received is not owed to the copy's agent.
func TestCopyWithNestedSubagents(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent, a, pa, _ := e.runningLinked() // the chat rests; a is linked from its thread and runs
	e.limits(id, 2, model.MaxSubCap)
	k, pk := e.child(id, a.ID, "finishes")
	b, _ := e.child(id, a.ID, "runs on")
	e.finish(pk, "early")
	e.finish(pa, "one is in") // a takes k's result at once, in a turn
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "thanks"}, agent.Event{Kind: agent.EvTurnEnd})
	if s := e.sub(id, a.ID); !s.Waiting || e.sub(id, k.ID).Delivery != model.SubSent {
		t.Fatalf("the source: %+v, the delivered one %q", s, e.sub(id, k.ID).Delivery)
	}
	_ = parent

	f := e.fork(id, len(e.items(id)))
	for _, sid := range []string{a.ID, b.ID} {
		if s := e.subOn(f.ID, sid); s.Status != model.SubStopped || !s.NotCarried || s.Waiting || s.Delivery != model.SubNotOwed {
			t.Fatalf("in the copy, one that ran in the source: %+v", s)
		}
	}
	if s := e.subOn(f.ID, k.ID); s.Status != model.SubCompleted || s.NotCarried || s.Delivery != model.SubSent || s.Parent != a.ID {
		t.Fatalf("in the copy, the nested one that had finished: %+v", s)
	}
	if v := e.view(f.ID); v.SubsOwed != 0 || v.SubsRunning != 0 {
		t.Fatalf("the copy: %d owed, %d running", v.SubsOwed, v.SubsRunning)
	}
	// The source goes on as it was.
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || !s.Waiting {
		t.Fatalf("the source's waiting subagent after the copy: %+v", s)
	}
	// The copy's agent is told of its own subagent, not of the one that one started.
	e.send(f.ID, "go on", "")
	msg := e.claude.lastFork(t).sent()
	noticeAhead(t, msg[len(msg)-1], "go on", a.ID)
}

// A subagent that waits for one whose spawn then fails has nothing left to wait for: it
// finishes, and does not hold its place under the cap for ever.
func TestWaitEndsWhenTheSpawnItWaitedForFails(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, parent := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	gate := &gatedSpawner{inner: e.claude, enter: make(chan struct{}, 1), gate: make(chan struct{})}
	e.m.Spawners[model.Claude] = failingSpawner{gate}
	done := make(chan error, 1)
	go func() {
		_, err := e.m.SpawnSubagent(id, SpawnSubRequest{Prompt: "never starts", From: a.ID})
		done <- err
	}()
	<-gate.enter // the new subagent is recorded, and its process is being started
	e.finish(pa, "spawned one")
	if s := e.sub(id, a.ID); !s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("with a spawn of its own under way: %+v", s)
	}
	close(gate.gate)
	if err := <-done; err == nil {
		t.Fatal("the spawn did not fail")
	}
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Waiting || s.Last != "spawned one" {
		t.Fatalf("after the spawn it waited for failed: %+v", s)
	}
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) || e.view(id).SubsRunning != 0 {
		t.Fatalf("the chat's agent got %d messages, %d running", len(parent.sent()), e.view(id).SubsRunning)
	}
}

// failingSpawner starts nothing: its Spawn fails once the inner one would have started.
type failingSpawner struct{ inner *gatedSpawner }

func (s failingSpawner) Spawn(o agent.SpawnOptions) (agent.Agent, error) {
	s.inner.enter <- struct{}{}
	<-s.inner.gate
	return nil, errors.New("no such program")
}

// A waiting subagent whose process begins a turn by itself (Claude does, when a command it left
// in the background ends) is working again: a result that comes meanwhile waits for that turn's
// end, and is not put into the middle of it.
func TestWaitingSubagentStartsATurnItself(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	e.finish(pa, "waiting")
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "my background command is done"})
	if s := e.sub(id, a.ID); s.Waiting || s.Status != model.SubRunning {
		t.Fatalf("in a turn of its own: %+v", s)
	}
	e.finish(pb, "report of b")
	if len(pa.sent()) != 1 || e.sub(id, b.ID).Delivery != model.SubOwed {
		t.Fatalf("a result came in its turn: %d messages, delivery %q", len(pa.sent()), e.sub(id, b.ID).Delivery)
	}
	pa.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) {
		t.Fatalf("after that turn it got %d messages", len(pa.sent()))
	}
}

// selfBegunEnd is the clean end of a turn a subagent's process began by itself, as Claude
// reports the turn a finished background command starts.
var selfBegunEnd = agent.Event{Kind: agent.EvTurnEnd, SelfBegun: true}

// unread brings a subagent of a chat at depth 2 to where results were handed to it during a turn
// its process had begun by itself, and that turn has ended: it waited for the one it started,
// whose result went to it as its second message, and then came the output and the end of a turn
// of its own. It returns the chat, the two records and the processes of the chat's agent and of
// the subagent. quiet is the manager's subQuietWait for the test.
func unread(t *testing.T, quiet time.Duration) (e *env, id string, a, b model.Subagent, parent, pa *fakeAgent) {
	t.Helper()
	e = newEnv(t)
	e.m.subQuietWait = quiet
	id, parent = e.nested(2)
	a, pa = e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	e.finish(pa, "I wait for one")
	e.finish(pb, "report of b")
	if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) {
		t.Fatalf("the waiting subagent got %d messages", len(pa.sent()))
	}
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "my background command is done"}, selfBegunEnd)
	return e, id, a, b, parent, pa
}

// Results handed to a subagent while its process was in a turn it had begun by itself are not
// that turn's: its end does not finish the subagent, which would then report without them. The
// turn the message starts is the one that finishes it.
func TestResultsHandedInATurnOfItsOwn(t *testing.T) {
	t.Parallel()
	e, id, a, b, parent, pa := unread(t, time.Hour)
	s := e.sub(id, a.ID)
	if s.Status != model.SubRunning || s.Waiting || s.Ended != 0 || s.Delivery != model.SubNotOwed {
		t.Fatalf("after the turn of its own: %+v", s)
	}
	if agentClosed(pa) || len(parent.sent()) != 1 || e.sub(id, b.ID).Delivery != model.SubSent {
		t.Fatalf("closed %v, %d messages to the chat's agent, the result's delivery %q",
			agentClosed(pa), len(parent.sent()), e.sub(id, b.ID).Delivery)
	}
	// The turn of the message: the process says it is thinking, the model answers, the turn ends.
	pa.emit(t, agent.Event{Kind: agent.EvThinking}, agent.Event{Kind: agent.EvText, Text: "with what b found"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "with what b found" {
		t.Fatalf("after the turn of the results: %+v", s)
	}
	if len(pa.sent()) != 2 || len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("%d messages to the subagent, %d to the chat's agent", len(pa.sent()), len(parent.sent()))
	}
	closed(t, "its process", pa)
}

// A process that read the results in the turn of its own starts no further turn. When it has
// given no sign of one for the manager's wait, the results count as read and the subagent
// finishes, with what that turn said as its report.
func TestResultsReadInATurnOfItsOwn(t *testing.T) {
	t.Parallel()
	e, id, a, b, parent, pa := unread(t, 50*time.Millisecond)
	waitFor(t, "the subagent to finish after the silence", func() bool { return e.sub(id, a.ID).Status != model.SubRunning })
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "my background command is done" || s.Error != "" {
		t.Fatalf("after the silence: %+v", s)
	}
	if d := e.sub(id, b.ID).Delivery; d != model.SubSent {
		t.Fatalf("the result's delivery %q", d)
	}
	waitFor(t, "its result to go to the chat's agent", func() bool { return len(parent.sent()) == 2 })
	if !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{a.ID}) {
		t.Fatalf("the chat's agent got %q", texts(parent.sent()[1]))
	}
	closed(t, "its process", pa)
}

// A sign of a turn breaks the silence: a process that says it is thinking has begun the turn of
// the message, however long the model then takes, and the subagent is finished by that turn.
func TestThinkingBreaksTheSilence(t *testing.T) {
	t.Parallel()
	const quiet = 100 * time.Millisecond
	e, id, a, _, parent, pa := unread(t, quiet)
	pa.emit(t, agent.Event{Kind: agent.EvThinking})
	time.Sleep(4 * quiet)
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || agentClosed(pa) || len(parent.sent()) != 1 {
		t.Fatalf("while the model thinks: %+v, closed %v, %d messages to the chat's agent", s, agentClosed(pa), len(parent.sent()))
	}
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "with what b found"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "with what b found" {
		t.Fatalf("after the turn of the results: %+v", s)
	}
}

// The silence ends the turn, not the subagent: one that still has a subagent running waits for
// it, and gets its result as any waiting subagent does.
func TestSilenceLeavesAWaitingSubagentWaiting(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.m.subQuietWait = 50 * time.Millisecond
	id, _ := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	c, pc := e.child(id, a.ID, "two")
	e.finish(pa, "I wait for two")
	e.finish(pb, "report of b")
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "my background command is done"}, selfBegunEnd)
	waitFor(t, "the subagent to wait again after the silence", func() bool { return e.sub(id, a.ID).Waiting })
	if s := e.sub(id, a.ID); s.Status != model.SubRunning || agentClosed(pa) {
		t.Fatalf("with one still running: %+v, closed %v", s, agentClosed(pa))
	}
	e.finish(pc, "report of c")
	if len(pa.sent()) != 3 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) || !reflect.DeepEqual(deliveredSids(pa.sent()[2]), []string{c.ID}) {
		t.Fatalf("the subagent got %d messages", len(pa.sent()))
	}
	e.finish(pa, "both are in")
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "both are in" {
		t.Fatalf("at the end: %+v", s)
	}
}

// A turn of its own that ends while nothing was handed to it is a turn like any other: with one
// still running the subagent waits again, and the results that came meanwhile go to it at once.
func TestTurnOfItsOwnWithNothingHanded(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	id, _ := e.nested(2)
	a, pa := e.child(id, "", "delegate")
	b, pb := e.child(id, a.ID, "one")
	e.finish(pa, "I wait for one")
	pa.emit(t, agent.Event{Kind: agent.EvText, Text: "my background command is done"})
	e.finish(pb, "report of b")
	if len(pa.sent()) != 1 {
		t.Fatalf("a result came in its turn: %d messages", len(pa.sent()))
	}
	pa.emit(t, selfBegunEnd)
	e.m.handoffs.Wait()
	if len(pa.sent()) != 2 || !reflect.DeepEqual(deliveredSids(pa.sent()[1]), []string{b.ID}) || e.sub(id, a.ID).Status != model.SubRunning {
		t.Fatalf("after that turn: %d messages, %+v", len(pa.sent()), e.sub(id, a.ID))
	}
	e.finish(pa, "with what b found")
	if s := e.sub(id, a.ID); s.Status != model.SubCompleted || s.Last != "with what b found" {
		t.Fatalf("at the end: %+v", s)
	}
}
