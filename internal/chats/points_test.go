package chats

import (
	"testing"

	"ai-whiteboard/internal/model"
)

// Item builders for the point tests.
func pUser() model.Item            { return model.Item{Kind: "user", Text: "u"} }
func pText() model.Item            { return model.Item{Kind: "text", Text: "t", Done: true} }
func pOpen() model.Item            { return model.Item{Kind: "text", Text: "t"} }
func pNote() model.Item            { return model.Item{Kind: "note", Tone: "muted", Text: "Stopped."} }
func pPerm() model.Item            { return model.Item{Kind: "perm", RequestID: "r", Decided: "allow"} }
func pHole() model.Item            { return model.Item{} }
func pEnd(point string) model.Item { return model.Item{Kind: "end", Point: point} }
func pSub() model.Item             { return model.Item{Kind: "subresult", Subagent: "s1"} }
func pTool() model.Item {
	res := "ok"
	return model.Item{Kind: "tool", ToolID: "t1", Name: "Read", Result: &res}
}

// twoTurns is two finished turns, the second with a tool call between two replies.
func twoTurns() []model.Item {
	return []model.Item{
		pUser(),    // 0
		pText(),    // 1
		pEnd("p1"), // 2
		pUser(),    // 3
		pText(),    // 4
		pTool(),    // 5
		pText(),    // 6
		pEnd("p2"), // 7
	}
}

// cutTurn is a turn cut without a mark (the app was closed) between two finished ones.
func cutTurn() []model.Item {
	return []model.Item{
		pUser(),    // 0
		pText(),    // 1
		pEnd("p1"), // 2
		pUser(),    // 3: the cut turn
		{Kind: "note", Tone: "error", Text: "Stopped: the app was closed while the agent was working."}, // 4
		pUser(),    // 5
		pText(),    // 6
		pEnd("p3"), // 7
	}
}

// deliveryTurn is a turn the app started to hand the agent a subagent's result (a subresult row,
// no user item) between two turns of the human's.
func deliveryTurn() []model.Item {
	return []model.Item{
		pUser(),    // 0
		pText(),    // 1
		pEnd("u1"), // 2
		pSub(),     // 3: the delivery turn
		pText(),    // 4
		pEnd("u2"), // 5
		pUser(),    // 6
		pText(),    // 7
		pEnd("u3"), // 8
	}
}

func TestTurnEnd(t *testing.T) {
	for _, tc := range []struct {
		name  string
		items []model.Item
		i     int
		want  int
	}{
		{"first turn's reply", twoTurns(), 1, 3},
		{"a reply before a tool call", twoTurns(), 4, 0},
		{"the last reply of a turn with a tool call", twoTurns(), 6, 8},
		{"a user item", twoTurns(), 0, 0},
		{"a tool item", twoTurns(), 5, 0},
		{"an end mark", twoTurns(), 2, 0},
		{"below the list", twoTurns(), -1, 0},
		{"past the list", twoTurns(), 8, 0},
		{"notes between the reply and its mark", []model.Item{pUser(), pText(), pNote(), pNote(), pEnd("p")}, 1, 5},
		{"a hole between the reply and its mark", []model.Item{pUser(), pText(), pHole(), pEnd("p")}, 1, 4},
		{"a hole and a note", []model.Item{pUser(), pText(), pHole(), pNote(), pEnd("")}, 1, 5},
		{"a mark with no id still ends the turn", []model.Item{pUser(), pText(), pEnd("")}, 1, 3},
		{"a perm between the reply and the mark", []model.Item{pUser(), pText(), pPerm(), pEnd("p")}, 1, 0},
		{"a user item between the reply and the mark", []model.Item{pUser(), pText(), pUser(), pText(), pEnd("p")}, 1, 0},
		{"another reply after it", []model.Item{pUser(), pText(), pText(), pEnd("p")}, 1, 0},
		{"no mark after the reply", []model.Item{pUser(), pText()}, 1, 0},
		{"only notes after the reply", []model.Item{pUser(), pText(), pNote()}, 1, 0},
		{"a reply still open", []model.Item{pUser(), pOpen(), pEnd("p")}, 1, 0},
	} {
		if got := turnEnd(tc.items, tc.i); got != tc.want {
			t.Errorf("%s: turnEnd(%d) = %d, want %d", tc.name, tc.i, got, tc.want)
		}
	}
}

func TestCutBefore(t *testing.T) {
	for _, tc := range []struct {
		name   string
		items  []model.Item
		u      int
		want   int
		wantOK bool
	}{
		{"the first message", twoTurns(), 0, 0, true},
		{"the second message", twoTurns(), 3, 3, true},
		{"a reply", twoTurns(), 1, 0, false},
		{"an end mark", twoTurns(), 2, 0, false},
		{"below the list", twoTurns(), -1, 0, false},
		{"past the list", twoTurns(), 8, 0, false},
		{"the cut turn's message", cutTurn(), 3, 3, true},
		{"the message after a cut turn", cutTurn(), 5, 3, true},
		{"a perm between the mark and the message", []model.Item{pUser(), pText(), pEnd("p"), pPerm(), pUser()}, 4, 3, true},
		{"a note and a hole between the mark and the message", []model.Item{pUser(), pText(), pEnd("p"), pNote(), pHole(), pUser()}, 5, 3, true},
		{"a mark with no id", []model.Item{pUser(), pText(), pEnd(""), pUser()}, 3, 3, true},
		{"a reply with no mark before the message", []model.Item{pUser(), pText(), pNote(), pUser()}, 3, 0, false},
		{"a tool call with no mark before the message", []model.Item{pUser(), pEnd("p"), pUser(), pTool(), pNote(), pUser()}, 5, 0, false},
		{"only notes, holes and messages before it", []model.Item{pNote(), pHole(), pUser(), pPerm(), pUser()}, 4, 0, true},
	} {
		got, ok := cutBefore(tc.items, tc.u)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("%s: cutBefore(%d) = (%d, %v), want (%d, %v)", tc.name, tc.u, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestSessionEnd(t *testing.T) {
	for _, tc := range []struct {
		name  string
		items []model.Item
		count int
		want  bool
	}{
		{"the end of the list", twoTurns(), 8, true},
		{"past the list", twoTurns(), 9, true},
		{"before the last mark", twoTurns(), 7, false},
		{"after the first turn", twoTurns(), 3, false},
		{"the start", twoTurns(), 0, false},
		{"an empty list", nil, 0, true},
		{"a negative count counts from the start", twoTurns(), -3, false},
		{"only notes, perms and holes past it", []model.Item{pUser(), pText(), pEnd("p"), pNote(), pPerm(), pHole()}, 3, true},
		{"a message past it", []model.Item{pUser(), pText(), pEnd("p"), pNote(), pUser()}, 3, false},
		{"a reply past it", []model.Item{pUser(), pEnd("p"), pOpen()}, 2, false},
		{"a tool call past it", []model.Item{pUser(), pEnd("p"), pTool()}, 2, false},
		{"a mark past it", []model.Item{pUser(), pEnd("p"), pNote(), pEnd("")}, 2, false},
	} {
		if got := sessionEnd(tc.items, tc.count); got != tc.want {
			t.Errorf("%s: sessionEnd(%d) = %v, want %v", tc.name, tc.count, got, tc.want)
		}
	}
}

func TestNextMark(t *testing.T) {
	for _, tc := range []struct {
		name   string
		items  []model.Item
		count  int
		want   string // the mark's point
		wantOK bool
	}{
		{"from the start", twoTurns(), 0, "p1", true},
		{"at a mark", twoTurns(), 2, "p1", true},
		{"right after a mark", twoTurns(), 3, "p2", true},
		{"at the last mark", twoTurns(), 7, "p2", true},
		{"at the end of the list", twoTurns(), 8, "", false},
		{"past the list", twoTurns(), 20, "", false},
		{"a negative count counts from the start", twoTurns(), -1, "p1", true},
		{"a mark with no id", []model.Item{pUser(), pEnd(""), pUser(), pEnd("p2")}, 0, "", true},
		{"no mark at all", []model.Item{pUser(), pText()}, 0, "", false},
		{"an empty list", nil, 0, "", false},
	} {
		got, ok := nextMark(tc.items, tc.count)
		if ok != tc.wantOK || got.Point != tc.want || (ok && got.Kind != "end") || (!ok && got.Kind != "") {
			t.Errorf("%s: nextMark(%d) = (%+v, %v), want point %q, %v", tc.name, tc.count, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestPointOK(t *testing.T) {
	// The cut turn's next mark has no id.
	cutNoID := cutTurn()
	cutNoID[7] = pEnd("")
	// A second turn that is still running, or was cut, after a finished one.
	running := []model.Item{pUser(), pText(), pEnd("p1"), pUser(), pText()}
	// One finished turn, then only what is not said in the session.
	idle := []model.Item{pUser(), pText(), pEnd("p1"), pNote(), pPerm(), pHole()}

	for _, tc := range []struct {
		name  string
		agent model.AgentKind
		items []model.Item
		count int
		want  bool
	}{
		// Rule 1: the count is in the list.
		{"a negative count", model.Claude, twoTurns(), -1, false},
		{"past the list", model.Claude, twoTurns(), 9, false},
		{"past an empty list", model.Claude, nil, 1, false},

		// Rule 2: the start needs the id on the first mark.
		{"the start", model.Claude, twoTurns(), 0, true},
		{"the start, cursor", model.Cursor, twoTurns(), 0, true},
		{"the start, pi", model.Pi, twoTurns(), 0, true},
		{"the start of an empty list", model.Claude, nil, 0, false},
		{"the start with no mark", model.Claude, []model.Item{pUser(), pText()}, 0, false},
		{"the start when the first mark has no id", model.Claude, []model.Item{pUser(), pEnd(""), pUser(), pEnd("p2")}, 0, false},
		{"the start when only the first mark has an id", model.Claude, []model.Item{pUser(), pEnd("p1"), pUser(), pEnd("")}, 0, true},

		// Rule 3: any other point needs a mark with an id right before it.
		{"after the first turn", model.Claude, twoTurns(), 3, true},
		{"after the last turn", model.Claude, twoTurns(), 8, true},
		{"after the first turn, cursor", model.Cursor, twoTurns(), 3, true},
		{"after a message", model.Claude, twoTurns(), 1, false},
		{"after a reply", model.Claude, twoTurns(), 5, false},
		{"at a mark, not after it", model.Claude, twoTurns(), 2, false},
		{"after a mark with no id", model.Claude, []model.Item{pUser(), pText(), pEnd("")}, 3, false},
		{"after a note that follows the mark", model.Claude, idle, 4, false},
		{"after a hole", model.Claude, idle, 6, false},
		{"before a cut turn", model.Claude, cutTurn(), 3, true},
		{"before a cut turn, cursor", model.Cursor, cutTurn(), 3, true},
		{"before a running turn", model.Claude, running, 3, true},

		// pi: the mark after the point must close the turn that starts there.
		{"pi, the next mark closes the next turn", model.Pi, twoTurns(), 3, true},
		{"pi, the end of the session", model.Pi, twoTurns(), 8, true},
		{"pi, nothing said past the point", model.Pi, idle, 3, true},
		{"pi, the next turn has no mark", model.Pi, running, 3, false},
		{"pi, the next mark belongs to a later turn", model.Pi, cutTurn(), 3, false},
		{"pi, after the turn that follows a cut one", model.Pi, cutTurn(), 8, true},
		{"pi, the next mark has no id", model.Pi, []model.Item{pUser(), pEnd("p1"), pUser(), pText(), pEnd("")}, 2, false},
		{"pi, the next mark belongs to a later turn and has no id", model.Pi, cutNoID, 3, false},
		{"pi, after a mark with no id", model.Pi, []model.Item{pUser(), pText(), pEnd("")}, 3, false},
		{"pi, after a reply", model.Pi, twoTurns(), 5, false},
		{"pi, past the list", model.Pi, twoTurns(), 9, false},

		// pi: a turn the app started (a delivery of subagent results) has no user item; its mark
		// carries the id of the message the app sent.
		{"pi, a delivery turn is next", model.Pi, deliveryTurn(), 3, true},
		{"pi, after a delivery turn", model.Pi, deliveryTurn(), 6, true},
		{"a delivery turn is next", model.Claude, deliveryTurn(), 3, true},
		{"a delivery turn is next, cursor", model.Cursor, deliveryTurn(), 3, true},
		{"after a delivery turn", model.Claude, deliveryTurn(), 6, true},
		{"after a delivery turn, cursor", model.Cursor, deliveryTurn(), 6, true},
		{"pi, a retried delivery turn, with no row, is next", model.Pi, []model.Item{pUser(), pEnd("p1"), pText(), pEnd("p2")}, 2, true},
		{"pi, a delivery turn with a tool call is next", model.Pi, []model.Item{pUser(), pEnd("p1"), pSub(), pTool(), pText(), pEnd("p2")}, 2, true},
		{"pi, a message that carries a result is next", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pSub(), pUser(), pText(), pEnd("p2")}, 3, true},
		{"pi, a delivery turn's mark repeats the id before the point", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pSub(), pText(), pEnd("p1")}, 3, false},
		{"pi, a retried delivery turn's mark repeats the id before the point", model.Pi, []model.Item{pUser(), pEnd("p1"), pText(), pEnd("p1")}, 2, false},
		{"pi, a delivery turn's mark has no id", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pSub(), pText(), pEnd("")}, 3, false},
		{"pi, a delivery turn with no mark is next", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pSub(), pText()}, 3, false},
		{"pi, a delivery turn cut without a mark, then a message", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pSub(), pText(), pNote(), pUser(), pText(), pEnd("p3")}, 3, false},
		{"pi, a tool call cut without a mark, then a message", model.Pi, []model.Item{pUser(), pText(), pEnd("p1"), pTool(), pNote(), pUser(), pText(), pEnd("p3")}, 3, false},
		{"pi, a turn cut without a mark, then a message and a delivery turn", model.Pi, append(cutTurn(), pSub(), pText(), pEnd("p4")), 3, false},
		{"pi, a delivery turn after the turn that follows a cut one", model.Pi, append(cutTurn(), pSub(), pText(), pEnd("p4")), 8, true},
	} {
		if got := pointOK(tc.agent, tc.items, tc.count); got != tc.want {
			t.Errorf("%s: pointOK(%s, %d) = %v, want %v", tc.name, tc.agent, tc.count, got, tc.want)
		}
	}
}

// pi forks the end of a turn with the id on the next turn's mark: before a delivery turn that is
// the id of the message the app sent.
func TestForkSourceBeforeDeliveryTurn(t *testing.T) {
	meta := model.ChatMeta{ID: "c", SessionID: "s", Agent: model.Pi}
	if src := forkSourceOf(meta, deliveryTurn(), 3); src.Point != "u1" || src.Next != "u2" || src.End {
		t.Errorf("fork source at 3: %+v, want point u1, next u2, not the end", src)
	}
	if src := forkSourceOf(meta, deliveryTurn(), 6); src.Point != "u2" || src.Next != "u3" || src.End {
		t.Errorf("fork source at 6: %+v, want point u2, next u3, not the end", src)
	}
}
