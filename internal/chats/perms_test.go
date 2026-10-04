package chats

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// perms returns the thread's permission cards, in order.
func perms(items []model.Item) []model.Item {
	var out []model.Item
	for _, it := range items {
		if it.Kind == "perm" {
			out = append(out, it)
		}
	}
	return out
}

// ask raises a permission request on a: its own, or with tool set a native subagent's.
func ask(t *testing.T, a *fakeAgent, tool, id string) {
	t.Helper()
	a.emit(t, agent.Event{Kind: agent.EvPermRequest, Sub: tool, PermID: id, ToolName: "Bash"})
}

// card returns asker's card for request id: the last one, since closed cards may repeat the pair.
func (e *env) card(chat, asker, id string) model.Item {
	e.t.Helper()
	ps := perms(e.items(chat))
	for i := len(ps) - 1; i >= 0; i-- {
		if ps[i].Subagent == asker && ps[i].RequestID == id {
			return ps[i]
		}
	}
	e.t.Fatalf("no card of %q for request %s in %+v", asker, id, ps)
	return model.Item{}
}

func (e *env) status(id string) model.Status {
	e.t.Helper()
	return e.view(id).Status
}

// itemsFile is the chat's items.jsonl as written. (diskItems reads it as a load does, which closes
// the open cards.)
func (e *env) itemsFile(id string) string {
	e.t.Helper()
	raw, err := os.ReadFile(e.m.itemsPath(id))
	if err != nil {
		e.t.Fatal(err)
	}
	return string(raw)
}

// twoAskers is an idle parent with two running children that have each raised request p1, the id
// Cursor gives the first request of every process.
func (e *env) twoAskers() (id string, parent *fakeAgent, a, b model.Subagent, ca, cb *fakeAgent) {
	e.t.Helper()
	id, parent = e.idleParent()
	a = e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca = waitChild(e.t, e.claude, 2)
	b = e.spawn(id, SpawnSubRequest{Prompt: "b"})
	cb = waitChild(e.t, e.claude, 3)
	ask(e.t, ca, "", "p1")
	ask(e.t, cb, "", "p1")
	if st := e.status(id); st != model.StatusApproval {
		e.t.Fatalf("status %q with two requests open", st)
	}
	return id, parent, a, b, ca, cb
}

// ---- invariant P: no stale permission request stays open --------------------

// However the agent's turn ends, its own open request is closed as denied, in the thread only. A
// late answer is refused and reaches no process.
func TestTurnEndClosesOwnPermission(t *testing.T) {
	for name, end := range map[string]agent.Event{
		"clean":   {Kind: agent.EvTurnEnd},
		"error":   {Kind: agent.EvTurnEnd, Error: "rate limited"},
		"aborted": {Kind: agent.EvTurnEnd, Aborted: true},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			evs := listen(t, e.br)
			id, parent := e.startSpawnParent()
			ask(t, parent, "", "r1")
			if st := e.status(id); st != model.StatusApproval {
				t.Fatalf("status %q", st)
			}
			evs.drain(t, e.br)
			parent.emit(t, end)
			if c := e.card(id, "", "r1"); c.Decided != "deny" {
				t.Fatalf("card after the turn ended %+v", c)
			}
			if st := e.status(id); st != model.StatusReady {
				t.Fatalf("status %q", st)
			}
			var told bool
			for _, ev := range ofType(evs.drain(t, e.br), "chat_items") {
				for _, u := range updatesOf(t, ev) {
					told = told || (u.Item.Kind == "perm" && u.Item.Decided == "deny")
				}
			}
			if !told {
				t.Fatal("clients were not sent the closed card")
			}
			if raw := e.itemsFile(id); !strings.Contains(raw, `"decided":"deny"`) {
				t.Fatalf("the closed card was not written:\n%s", raw)
			}

			if err := e.m.Decide(id, "", "r1", true); !errors.Is(err, ErrNoRequest) {
				t.Fatalf("late answer: %v", err)
			}
			if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
				t.Fatalf("the agent was sent an answer: %+v %+v", d, s)
			}
			if c := e.card(id, "", "r1"); c.Decided != "deny" {
				t.Fatalf("card after the late answer %+v", c)
			}
			if err := e.m.Send(id, "next", "", nil); err != nil {
				t.Fatalf("Send after the turn ended: %v", err)
			}
		})
	}
}

// The stuck trace: a turn leaves the agent's own request open, a child then asks into the idle
// parent, and the child's card is answered. The chat is ready and takes a human message; a result
// that became owed while the chat waited for the answer is delivered when it leaves approval, or,
// after a turn that ended with an error, once the human has sent.
func TestStaleOwnRequestDoesNotHoldIdleChat(t *testing.T) {
	for name, end := range map[string]agent.Event{
		"clean": {Kind: agent.EvTurnEnd},
		"error": {Kind: agent.EvTurnEnd, Error: "boom"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			id, parent := e.startSpawnParent()
			ask(t, parent, "", "p1")
			parent.emit(t, end)

			sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
			child := waitChild(t, e.claude, 2)
			sb := e.spawn(id, SpawnSubRequest{Prompt: "other"})
			other := waitChild(t, e.claude, 3)
			ask(t, child, "", "p1")
			if st := e.status(id); st != model.StatusApproval {
				t.Fatalf("status %q with the child's request open", st)
			}
			e.finish(other, "report")
			if len(parent.sent()) != 1 || e.sub(id, sb.ID).Delivery != model.SubOwed {
				t.Fatalf("a result was sent while a request was open: %d sends", len(parent.sent()))
			}
			if err := e.m.Decide(id, sa.ID, "p1", true); err != nil {
				t.Fatal(err)
			}
			e.m.handoffs.Wait()
			if d := agentDecides(child); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
				t.Fatalf("child decides %+v", d)
			}
			if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
				t.Fatalf("the parent was sent an answer: %+v %+v", d, s)
			}
			if e.card(id, "", "p1").Decided != "deny" || e.card(id, sa.ID, "p1").Decided != "allow" {
				t.Fatalf("cards %+v", perms(e.items(id)))
			}
			if end.Error != "" {
				// The errored turn holds the chat: the result waits for the human's message.
				if st := e.status(id); st != model.StatusReady || len(parent.sent()) != 1 {
					t.Fatalf("status after the answer %q, %d sends", st, len(parent.sent()))
				}
				e.afterHold(id, parent, sb.ID)
				return
			}
			if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
				t.Fatalf("the owed result was not delivered: %d sends", len(parent.sent()))
			}
			if st := e.status(id); st != model.StatusThinking {
				t.Fatalf("status %q, want the delivery's turn", st)
			}
			parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
			if st := e.status(id); st != model.StatusReady {
				t.Fatalf("status after the delivery's turn %q", st)
			}
			if err := e.m.Send(id, "next", "", nil); err != nil {
				t.Fatalf("Send: %v", err)
			}
		})
	}
}

// The same with a card that was open when the app was closed: it is closed when the thread loads.
// A result owed across the restart is not sent until a human message has started a process.
func TestLoadClosesOpenPermissions(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	ask(t, parent, "", "p1")
	old := e.spawn(id, SpawnSubRequest{Prompt: "old"})
	e.finish(waitChild(t, e.claude, 2), "old report")
	e.m.Shutdown()
	if raw := e.itemsFile(id); !strings.Contains(raw, `"requestId":"p1"`) || strings.Contains(raw, `"decided"`) {
		t.Fatalf("items.jsonl at shutdown, want the card open:\n%s", raw)
	}

	e.boot()
	if c := e.card(id, "", "p1"); c.Decided != "deny" {
		t.Fatalf("card after the restart %+v", c)
	}
	if raw := e.itemsFile(id); !strings.Contains(raw, `"decided":"deny"`) {
		t.Fatalf("the closed card was not written:\n%s", raw)
	}
	if err := e.m.Decide(id, "", "p1", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("answer to a card from before the restart: %v", err)
	}
	e.m.handoffs.Wait()
	if e.claude.count() != 0 || e.sub(id, old.ID).Delivery != model.SubOwed || len(resultRows(e.items(id))) != 0 {
		t.Fatalf("a result was sent with no process: %d processes, %+v", e.claude.count(), e.sub(id, old.ID))
	}

	// The human's message starts the process and carries it.
	e.send(id, "again", "")
	parent = e.claude.last(t)
	if len(parent.sent()) != 1 || !reflect.DeepEqual(deliveredSids(parent.sent()[0]), []string{old.ID}) {
		t.Fatalf("the result owed across the restart: %d sends", len(parent.sent()))
	}
	parent.emit(t, agent.Event{Kind: agent.EvText, Text: "ok"}, agent.Event{Kind: agent.EvTurnEnd})
	e.m.handoffs.Wait()

	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	sb := e.spawn(id, SpawnSubRequest{Prompt: "other"})
	other := waitChild(t, e.claude, 3)
	ask(t, child, "", "p1")
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q with the child's request open", st)
	}
	e.finish(other, "report")
	if len(parent.sent()) != 1 {
		t.Fatal("a result was sent while a request was open")
	}
	if err := e.m.Decide(id, sa.ID, "p1", false); err != nil {
		t.Fatal(err)
	}
	e.m.handoffs.Wait()
	if d := agentDecides(child); !reflect.DeepEqual(d, []decision{{"p1", false}}) {
		t.Fatalf("child decides %+v", d)
	}
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{sb.ID}) {
		t.Fatalf("the owed result was not delivered: %d sends", len(parent.sent()))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the delivery's turn %q", st)
	}
	if err := e.m.Send(id, "next", "", nil); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

// A child that ends on its own with its request open: the request is closed as denied, in the
// thread only, before the delivery's preconditions are checked, so the parent gets the result.
func TestChildEndClosesItsPermission(t *testing.T) {
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	ask(t, child, "", "p1")
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	e.finish(child, "done anyway")

	if c := e.card(id, sa.ID, "p1"); c.Decided != "deny" {
		t.Fatalf("card after the child ended %+v", c)
	}
	if d, s := agentDecides(child), agentStrays(child); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the ended child was sent an answer: %+v %+v", d, s)
	}
	sent := parent.sent()
	if len(sent) != 2 || !strings.Contains(lastSend(t, parent), sidTag(sa.ID)) {
		t.Fatalf("the result was not delivered: %d sends", len(sent))
	}
	// The delivery started because the chat left approval; it carries the finished record.
	for _, want := range []string{"<status>completed</status>", "<report>done anyway</report>"} {
		if block := lastSend(t, parent); !strings.Contains(block, want) {
			t.Fatalf("block lacks %q:\n%s", want, block)
		}
	}
	if s := e.sub(id, sa.ID); s.Delivery != model.SubSent {
		t.Fatalf("subagent %+v", s)
	}
	if st := e.status(id); st != model.StatusThinking {
		t.Fatalf("status %q, want the delivery's turn", st)
	}
	if err := e.m.Decide(id, sa.ID, "p1", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("late answer: %v", err)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the parent was sent the child's answer: %+v %+v", d, s)
	}
}

// A native subagent's request is held by the chat's process; it is closed with the subagent too.
func TestNativeSubagentEndClosesItsPermission(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	ask(t, a, "t1", "r1")
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	evs.drain(t, e.br)
	a.emit(t, agent.Event{Kind: agent.EvSub, Sub: "t1", SubInfo: &agent.SubInfo{Status: model.SubCompleted}})
	if c := e.card(id, sid, "r1"); c.Decided != "deny" {
		t.Fatalf("card after the subagent ended %+v", c)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status %q", st)
	}
	var ready bool
	for _, ev := range ofType(evs.drain(t, e.br), "chat") {
		ready = ready || ev["chat"].(map[string]any)["status"] == "ready"
	}
	if !ready {
		t.Fatal("clients were not told the chat left approval")
	}
	if err := e.m.Decide(id, sid, "r1", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("late answer: %v", err)
	}
	if d, s := agentDecides(a), agentStrays(a); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the agent was sent an answer: %+v %+v", d, s)
	}
}

// An aborted turn stops the subagents, so their open requests are closed with the agent's own.
// Clients get the turn's end and then the subagents' cards, as updates of rising versions (a
// client drops an update whose version it already has).
func TestAbortedTurnClosesSubagentPermissions(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	id, a := e.subStart()
	subRun(t, a, "t1")
	sid := e.onlySub(id)
	ask(t, a, "", "r0")
	ask(t, a, "t1", "r1")
	evs.drain(t, e.br)
	a.emit(t, agent.Event{Kind: agent.EvTurnEnd, Aborted: true})

	if e.card(id, "", "r0").Decided != "deny" || e.card(id, sid, "r1").Decided != "deny" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if s := e.sub(id, sid); s.Status != model.SubStopped {
		t.Fatalf("subagent %+v", s)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status %q", st)
	}
	version := -1.0
	var note bool
	closed := map[string]bool{}
	for _, ev := range ofType(evs.drain(t, e.br), "chat_items") {
		if v := ev["version"].(float64); v <= version {
			t.Fatalf("update of version %v after %v: a client would drop it", v, version)
		} else {
			version = v
		}
		for _, u := range updatesOf(t, ev) {
			note = note || (u.Item.Kind == "note" && u.Item.Text == "Stopped.")
			if u.Item.Kind == "perm" && u.Item.Decided == "deny" {
				closed[u.Item.RequestID] = true
			}
		}
	}
	if !note || !closed["r0"] || !closed["r1"] {
		t.Fatalf("clients got note %v closed cards %v", note, closed)
	}
	for _, c := range [][2]string{{"", "r0"}, {sid, "r1"}} {
		if err := e.m.Decide(id, c[0], c[1], true); !errors.Is(err, ErrNoRequest) {
			t.Fatalf("late answer to %v: %v", c, err)
		}
	}
	if d, s := agentDecides(a), agentStrays(a); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the agent was sent an answer: %+v %+v", d, s)
	}
}

// A parent turn that ends while a child's card is open leaves that card open and answerable.
func TestTurnEndKeepsChildPermissionOpen(t *testing.T) {
	for name, end := range map[string]agent.Event{
		"clean": {Kind: agent.EvTurnEnd},
		"error": {Kind: agent.EvTurnEnd, Error: "rate limited"},
	} {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			id, parent := e.startSpawnParent()
			sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
			child := waitChild(t, e.claude, 2)
			ask(t, child, "", "p1")
			ask(t, parent, "", "p2")
			parent.emit(t, end)
			if c := e.card(id, sa.ID, "p1"); c.Decided != "" {
				t.Fatalf("the child's card was closed by the parent's turn end %+v", c)
			}
			if c := e.card(id, "", "p2"); c.Decided != "deny" {
				t.Fatalf("the parent's own card %+v", c)
			}
			if err := e.m.Decide(id, sa.ID, "p1", true); err != nil {
				t.Fatal(err)
			}
			if d := agentDecides(child); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
				t.Fatalf("child decides %+v", d)
			}
			if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
				t.Fatalf("the parent was sent an answer: %+v %+v", d, s)
			}
			if c := e.card(id, sa.ID, "p1"); c.Decided != "allow" {
				t.Fatalf("the child's card after its answer %+v", c)
			}
			if st := e.status(id); st != model.StatusReady {
				t.Fatalf("status %q", st)
			}
		})
	}
}

// ---- invariant I: a request is who asked together with its id ---------------

// Two children use the same request id one after the other.
func TestSameRequestIDInTurn(t *testing.T) {
	e := newEnv(t)
	id, parent := e.idleParent()
	a := e.spawn(id, SpawnSubRequest{Prompt: "a"})
	ca := waitChild(t, e.claude, 2)
	b := e.spawn(id, SpawnSubRequest{Prompt: "b"})
	cb := waitChild(t, e.claude, 3)

	ask(t, ca, "", "p1")
	if err := e.m.Decide(id, a.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the first answer %q", st)
	}
	ask(t, cb, "", "p1")
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q with the second request open", st)
	}
	owed := e.spawn(id, SpawnSubRequest{Prompt: "c"})
	e.finish(waitChild(t, e.claude, 4), "report c")
	if len(parent.sent()) != 1 {
		t.Fatal("a result was sent while a request was open")
	}
	if err := e.m.Decide(id, b.ID, "p1", false); err != nil {
		t.Fatal(err)
	}
	e.m.handoffs.Wait()
	if d := agentDecides(cb); !reflect.DeepEqual(d, []decision{{"p1", false}}) {
		t.Fatalf("second child decides %+v", d)
	}
	if d, s := agentDecides(ca), agentStrays(ca); !reflect.DeepEqual(d, []decision{{"p1", true}}) || len(s) != 0 {
		t.Fatalf("first child got more than its own answer: %+v %+v", d, s)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the parent was sent an answer: %+v %+v", d, s)
	}
	if e.card(id, a.ID, "p1").Decided != "allow" || e.card(id, b.ID, "p1").Decided != "deny" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	// The chat left approval: the result that became owed meanwhile is delivered.
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{owed.ID}) {
		t.Fatalf("the owed result was not delivered: %d sends", len(parent.sent()))
	}
	parent.emit(t, agent.Event{Kind: agent.EvTurnEnd})
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the delivery's turn %q", st)
	}
	if err := e.m.Send(id, "next", "", nil); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

// Two children have the same request id open at once: an answer reaches its own child and card.
func TestSameRequestIDBothOpenAnswered(t *testing.T) {
	e := newEnv(t)
	id, parent, a, b, ca, cb := e.twoAskers()
	owed := e.spawn(id, SpawnSubRequest{Prompt: "c"})
	e.finish(waitChild(t, e.claude, 4), "report c")

	if err := e.m.Decide(id, b.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(cb); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
		t.Fatalf("answered child decides %+v", d)
	}
	if d, s := agentDecides(ca), agentStrays(ca); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the other child was sent an answer: %+v %+v", d, s)
	}
	if e.card(id, a.ID, "p1").Decided != "" || e.card(id, b.ID, "p1").Decided != "allow" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q with one request still open", st)
	}
	if err := e.m.Send(id, "next", "", nil); !errors.Is(err, ErrBusy) {
		t.Fatalf("Send with a request open: %v", err)
	}
	e.m.handoffs.Wait()
	if len(parent.sent()) != 1 {
		t.Fatal("a result was sent while a request was open")
	}

	// An answer to the card already answered is refused and reaches nobody.
	if err := e.m.Decide(id, b.ID, "p1", false); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("second answer: %v", err)
	}
	if d, s := agentDecides(cb), agentStrays(cb); len(d) != 1 || len(s) != 0 {
		t.Fatalf("answered child after the second answer: %+v %+v", d, s)
	}
	if e.card(id, a.ID, "p1").Decided != "" || e.card(id, b.ID, "p1").Decided != "allow" {
		t.Fatalf("cards after the second answer %+v", perms(e.items(id)))
	}

	if err := e.m.Decide(id, a.ID, "p1", false); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(ca); !reflect.DeepEqual(d, []decision{{"p1", false}}) {
		t.Fatalf("other child decides %+v", d)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the parent was sent an answer: %+v %+v", d, s)
	}
	// The chat left approval: the result that became owed meanwhile is delivered.
	e.m.handoffs.Wait()
	if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), []string{owed.ID}) {
		t.Fatalf("the owed result was not delivered: %d sends", len(parent.sent()))
	}
	if st := e.status(id); st != model.StatusThinking {
		t.Fatalf("status after both answers %q, want the delivery's turn", st)
	}
}

// Two children have the same request id open and one of them goes away, on its own or stopped:
// only its card closes; the other stays open, its answer reaches its child, and only then does
// the chat leave approval. The results owed by then are delivered at that moment.
func TestSameRequestIDOneAskerGone(t *testing.T) {
	cases := map[string]struct {
		gone func(e *env, id string, a model.Subagent, ca *fakeAgent)
		told []decision // what the child that went away was told on its process
		owes bool       // it left a result the parent is owed
	}{
		"ends on its own": {func(e *env, id string, a model.Subagent, ca *fakeAgent) { e.finish(ca, "report") }, nil, true},
		"stop_subagent": {func(e *env, id string, a model.Subagent, ca *fakeAgent) {
			if err := e.m.StopSubagent(id, a.ID); err != nil {
				e.t.Fatal(err)
			}
		}, []decision{{"p1", false}}, false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			e := newEnv(t)
			id, parent, a, b, ca, cb := e.twoAskers()
			owed := e.spawn(id, SpawnSubRequest{Prompt: "c"})
			e.finish(waitChild(t, e.claude, 4), "report c")
			e.clock.Store(testNow + 10)
			tc.gone(e, id, a, ca)
			e.m.handoffs.Wait()

			if s := e.sub(id, a.ID); s.Status == model.SubRunning {
				t.Fatalf("subagent %+v", s)
			}
			if e.card(id, a.ID, "p1").Decided != "deny" || e.card(id, b.ID, "p1").Decided != "" {
				t.Fatalf("cards %+v", perms(e.items(id)))
			}
			if d, s := agentDecides(ca), agentStrays(ca); !reflect.DeepEqual(d, tc.told) || len(s) != 0 {
				t.Fatalf("child that went away: decides %+v strays %+v", d, s)
			}
			if d, s := agentDecides(cb), agentStrays(cb); len(d) != 0 || len(s) != 0 {
				t.Fatalf("the other child was sent an answer: %+v %+v", d, s)
			}
			if st := e.status(id); st != model.StatusApproval {
				t.Fatalf("status %q with the other request open", st)
			}
			if len(parent.sent()) != 1 {
				t.Fatal("a turn started while a request was open")
			}

			if err := e.m.Decide(id, b.ID, "p1", true); err != nil {
				t.Fatal(err)
			}
			if d := agentDecides(cb); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
				t.Fatalf("other child decides %+v", d)
			}
			if d, s := agentDecides(ca), agentStrays(ca); !reflect.DeepEqual(d, tc.told) || len(s) != 0 {
				t.Fatalf("child that went away after the answer: decides %+v strays %+v", d, s)
			}
			if e.card(id, a.ID, "p1").Decided != "deny" || e.card(id, b.ID, "p1").Decided != "allow" {
				t.Fatalf("cards after the answer %+v", perms(e.items(id)))
			}
			if d, s := agentDecides(parent), agentStrays(parent); len(d) != 0 || len(s) != 0 {
				t.Fatalf("the parent was sent an answer: %+v %+v", d, s)
			}
			e.m.handoffs.Wait()
			want := []string{owed.ID}
			if tc.owes {
				want = append(want, a.ID)
			}
			if len(parent.sent()) != 2 || !reflect.DeepEqual(deliveredSids(parent.sent()[1]), want) {
				t.Fatalf("%d sends, want one delivery of %v", len(parent.sent()), want)
			}
			if st := e.status(id); st != model.StatusThinking {
				t.Fatalf("status after the answer %q, want the delivery's turn", st)
			}
		})
	}
}

// The parent's own request has the id of a child's open request: each answer reaches its own
// process. An answer that names no asker is for the parent's own request.
func TestSameRequestIDParentAndChild(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	ask(t, child, "", "p1")
	ask(t, parent, "", "p1")

	if err := e.m.Decide(id, "", "p1", true); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(parent); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
		t.Fatalf("parent decides %+v", d)
	}
	if d, s := agentDecides(child), agentStrays(child); len(d) != 0 || len(s) != 0 {
		t.Fatalf("the child was sent the parent's answer: %+v %+v", d, s)
	}
	if e.card(id, "", "p1").Decided != "allow" || e.card(id, sa.ID, "p1").Decided != "" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q with the child's request open", st)
	}

	if err := e.m.Decide(id, sa.ID, "p1", false); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(child); !reflect.DeepEqual(d, []decision{{"p1", false}}) {
		t.Fatalf("child decides %+v", d)
	}
	if d, s := agentDecides(parent), agentStrays(parent); len(d) != 1 || len(s) != 0 {
		t.Fatalf("the parent was sent the child's answer: %+v %+v", d, s)
	}
	if e.card(id, "", "p1").Decided != "allow" || e.card(id, sa.ID, "p1").Decided != "deny" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if st := e.status(id); st == model.StatusApproval {
		t.Fatalf("status %q with nothing open", st)
	}
}

// An answer that does not name the asker of a subagent's card (a page from before the change) is
// refused; so is one that names an asker with no such request.
func TestAnswerMustNameTheAsker(t *testing.T) {
	e := newEnv(t)
	id, parent := e.idleParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	ask(t, child, "", "p1")

	for _, asker := range []string{"", "nope"} {
		if err := e.m.Decide(id, asker, "p1", true); !errors.Is(err, ErrNoRequest) {
			t.Fatalf("answer naming %q: %v", asker, err)
		}
	}
	if err := e.m.Decide(id, sa.ID, "p2", true); !errors.Is(err, ErrNoRequest) {
		t.Fatalf("answer to an id never raised: %v", err)
	}
	for _, a := range []*fakeAgent{parent, child} {
		if d, s := agentDecides(a), agentStrays(a); len(d) != 0 || len(s) != 0 {
			t.Fatalf("a refused answer reached a process: %+v %+v", d, s)
		}
	}
	if c := e.card(id, sa.ID, "p1"); c.Decided != "" {
		t.Fatalf("card after the refused answers %+v", c)
	}
	if st := e.status(id); st != model.StatusApproval {
		t.Fatalf("status %q", st)
	}
	if err := e.m.Decide(id, sa.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the answer %q", st)
	}
}

// Stop tells each process no for its own request and closes every card, whatever the ids.
func TestStopDeniesEachAskersPermission(t *testing.T) {
	e := newEnv(t)
	id, parent := e.startSpawnParent()
	sa := e.spawn(id, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 2)
	ask(t, child, "", "p1")
	ask(t, parent, "", "p1")

	e.m.Stop(id)
	waitFor(t, "child closed", func() bool { return agentClosed(child) })
	for name, a := range map[string]*fakeAgent{"parent": parent, "child": child} {
		if d, s := agentDecides(a), agentStrays(a); !reflect.DeepEqual(d, []decision{{"p1", false}}) || len(s) != 0 {
			t.Fatalf("%s: decides %+v strays %+v", name, d, s)
		}
	}
	if e.card(id, "", "p1").Decided != "deny" || e.card(id, sa.ID, "p1").Decided != "deny" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status %q", st)
	}
}

// A thread saved with two open cards of one id (a thread from before requests were closed when
// they went stale): both are closed at load, and new requests with that id are raised, answered
// and closed like any others.
func TestLoadClosesSameIDPermissions(t *testing.T) {
	e := newEnv(t)
	id, _, a, b, _, _ := e.twoAskers()
	var open []byte
	for i, it := range e.items(id) {
		if it.Kind == "perm" {
			line, _ := json.Marshal(map[string]any{"i": i, "item": it})
			open = append(append(open, line...), '\n')
		}
	}
	e.m.Shutdown()
	// Shutdown stops the children and closes their cards; put the cards back as they were.
	f, err := os.OpenFile(e.m.itemsPath(id), os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(open); err != nil {
		t.Fatal(err)
	}
	f.Close()
	closedAtShutdown := strings.Count(e.itemsFile(id), `"decided":"deny"`)
	e.boot()

	if e.card(id, a.ID, "p1").Decided != "deny" || e.card(id, b.ID, "p1").Decided != "deny" {
		t.Fatalf("cards after the restart %+v", perms(e.items(id)))
	}
	if st := e.status(id); st != model.StatusReady {
		t.Fatalf("status after the restart %q", st)
	}
	if raw := e.itemsFile(id); strings.Count(raw, `"decided":"deny"`) != closedAtShutdown+2 {
		t.Fatalf("the cards closed at load were not written:\n%s", raw)
	}
	for _, asker := range []string{a.ID, b.ID, ""} {
		if err := e.m.Decide(id, asker, "p1", true); !errors.Is(err, ErrNoRequest) {
			t.Fatalf("answer to a card from before the restart (%q): %v", asker, err)
		}
	}

	e.send(id, "again", "")
	parent := e.claude.last(t)
	sa := e.spawn(id, SpawnSubRequest{Prompt: "c"})
	child := waitChild(t, e.claude, 2)
	ask(t, parent, "", "p1")
	ask(t, child, "", "p1")
	if err := e.m.Decide(id, sa.ID, "p1", true); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Decide(id, "", "p1", false); err != nil {
		t.Fatal(err)
	}
	if d := agentDecides(child); !reflect.DeepEqual(d, []decision{{"p1", true}}) {
		t.Fatalf("child decides %+v", d)
	}
	if d := agentDecides(parent); !reflect.DeepEqual(d, []decision{{"p1", false}}) {
		t.Fatalf("parent decides %+v", d)
	}
	if e.card(id, sa.ID, "p1").Decided != "allow" || e.card(id, "", "p1").Decided != "deny" {
		t.Fatalf("cards %+v", perms(e.items(id)))
	}
	if e.card(id, a.ID, "p1").Decided != "deny" || e.card(id, b.ID, "p1").Decided != "deny" {
		t.Fatalf("old cards %+v", perms(e.items(id)))
	}
	if n := len(perms(e.items(id))); n != 4 {
		t.Fatalf("%d cards, want the two old and the two new", n)
	}
}
