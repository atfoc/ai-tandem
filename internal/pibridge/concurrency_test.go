package pibridge

import (
	"testing"
	"time"
)

// TestConcurrentRunsRouteIndependently drives two runs through the one bridge listener with two
// clients: interleaved asks and activity must each reach their own run's handler, an abort must
// only reach the aborted run's connections, and deregistering one run must leave the other
// working. (The UDS tool frame was retired in Phase 5; board tools now go over HTTP MCP.)
func TestConcurrentRunsRouteIndependently(t *testing.T) {
	b, path := startBridge(t)
	h1 := &fakeHandler{allow: true}
	h2 := &fakeHandler{allow: false, reason: "nope"}
	tok1 := registerRun(t, b, "chat-1", h1)
	tok2 := registerRun(t, b, "chat-2", h2)
	if tok1 == tok2 {
		t.Fatal("the two runs share a token")
	}
	c1, c2 := dial(t, path), dial(t, path)

	// Interleave the asks of both clients before reading either answer.
	type askCall struct {
		c     *testClient
		run   string
		id    string
		name  string
		input map[string]any
	}
	asks := []askCall{
		{c1, tok1, "a1", "bash", map[string]any{"command": "ls"}},
		{c2, tok2, "a2", "write", map[string]any{"path": "x"}},
		{c2, tok2, "a3", "read", map[string]any{"path": "y"}},
		{c1, tok1, "a4", "edit", map[string]any{"path": "z"}},
	}
	for _, q := range asks {
		q.c.send(map[string]any{"kind": "ask", "run": q.run, "id": q.id, "name": q.name, "input": q.input})
	}
	for _, q := range asks {
		resp := q.c.recv()
		respondOK(t, resp, q.id)
		if want := q.run == tok1; resp["allow"] != want {
			t.Fatalf("ask %s allow = %v, want %v", q.id, resp["allow"], want)
		}
	}

	// Per connection dispatch is sequential, so each run's asks keep their order.
	got1, got2 := h1.snapshotAsks(), h2.snapshotAsks()
	if len(got1) != 2 || got1[0].id != "a1" || got1[0].name != "bash" || got1[0].input != `{"command":"ls"}` ||
		got1[1].id != "a4" || got1[1].name != "edit" {
		t.Fatalf("handler 1 asks = %+v", got1)
	}
	if len(got2) != 2 || got2[0].id != "a2" || got2[0].name != "write" || got2[0].input != `{"path":"x"}` ||
		got2[1].id != "a3" || got2[1].name != "read" {
		t.Fatalf("handler 2 asks = %+v", got2)
	}

	// Interleaved activity frames reach their own handlers, in per-run order, with the child
	// identity intact.
	sub := map[string]any{"parent": "tool-1", "depth": 1, "child": "child-1"}
	c1.send(map[string]any{"kind": "activity", "run": tok1, "id": "e1", "sub": sub,
		"event": map[string]any{"type": "text", "id": "m1", "text": "one"}})
	c2.send(map[string]any{"kind": "activity", "run": tok2, "id": "e2",
		"event": map[string]any{"type": "text", "id": "m2", "text": "two"}})
	c1.send(map[string]any{"kind": "activity", "run": tok1, "id": "e3",
		"event": map[string]any{"type": "thinking"}})
	respondOK(t, c1.recv(), "e1")
	respondOK(t, c2.recv(), "e2")
	respondOK(t, c1.recv(), "e3")

	acts1, acts2 := h1.snapshotActivities(), h2.snapshotActivities()
	if len(acts1) != 2 || acts1[0].act.Text != "one" || acts1[0].sub == nil || acts1[0].sub.Child != "child-1" ||
		acts1[1].act.Type != "thinking" {
		t.Fatalf("handler 1 activities = %+v", acts1)
	}
	if len(acts2) != 1 || acts2[0].act.Text != "two" || acts2[0].sub != nil {
		t.Fatalf("handler 2 activities = %+v", acts2)
	}

	// Abort reaches only the aborted run's connections.
	b.AbortRun(tok1)
	if resp := c1.recv(); resp["kind"] != "abort" || resp["run"] != tok1 {
		t.Fatalf("run 1 abort frame = %v", resp)
	}
	c2.expectSilent(200 * time.Millisecond)

	// Deregistering run 1 closes only its client; run 2 keeps working.
	b.DeregisterRun(tok1)
	c1.expectClosed()
	c2.send(map[string]any{"kind": "ask", "run": tok2, "id": "a5", "name": "find", "input": map[string]any{}})
	resp := c2.recv()
	respondOK(t, resp, "a5")
	if resp["allow"] != false || resp["reason"] != "nope" {
		t.Fatalf("run 2 after deregister response = %v", resp)
	}
	b.AbortRun(tok1) // the old token is a no-op
}

// snapshotAsks copies the handler's recorded asks.
func (h *fakeHandler) snapshotAsks() []fakeAsk {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]fakeAsk(nil), h.asks...)
}

// snapshotActivities copies the handler's recorded activities.
func (h *fakeHandler) snapshotActivities() []fakeActivity {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]fakeActivity(nil), h.activities...)
}

// expectSilent asserts no frame arrives within d without consuming one.
func (c *testClient) expectSilent(d time.Duration) {
	c.t.Helper()
	if err := c.conn.SetReadDeadline(time.Now().Add(d)); err != nil {
		c.t.Fatalf("deadline: %v", err)
	}
	if b, err := c.br.Peek(1); err == nil || len(b) > 0 {
		c.t.Fatal("unexpected frame on a run that was not aborted")
	}
	if err := c.conn.SetReadDeadline(time.Time{}); err != nil {
		c.t.Fatalf("clear deadline: %v", err)
	}
}
