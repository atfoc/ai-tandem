package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
)

// A chat's subagent settings on the wire: "subDepth" and "subCap" of PATCH /api/chats/{id}, from
// a page and from an API client, and "subOff", "subDepth" and "subCap" of the chat that answers.

// subWire is what the JSON of a chat names of the settings; a field it lacks is nil.
type subWire struct {
	SubOff   *bool `json:"subOff"`
	SubDepth *int  `json:"subDepth"`
	SubCap   *int  `json:"subCap"`
}

// subPatched is the answer of PATCH /api/chats/{id}: the chat, and what its JSON names.
func subPatched(t *testing.T, out string) (model.ChatView, subWire) {
	t.Helper()
	ans := decode[struct {
		OK   bool            `json:"ok"`
		Chat json.RawMessage `json:"chat"`
	}](t, out)
	if !ans.OK || len(ans.Chat) == 0 {
		t.Fatalf("the answer of the change: %s", out)
	}
	return decode[model.ChatView](t, string(ans.Chat)), decode[subWire](t, string(ans.Chat))
}

func TestChatPatchSubSettings(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	created := e.expect(200, "POST", "/api/chats", `{"agent":"claude","group":"__ungrouped__"}`)
	c := decode[model.ChatView](t, created)
	// A new chat names depth 1 and cap 100, and no "subOff".
	if w := decode[subWire](t, created); w.SubOff != nil || w.SubDepth == nil || *w.SubDepth != 1 || w.SubCap == nil || *w.SubCap != 100 {
		t.Fatalf("a new chat on the wire: %s", created)
	}
	path := "/api/chats/" + c.ID

	// 0 is off, and is told from an absent depth: the answer says "subOff" and names no depth.
	v, w := subPatched(t, e.expect(200, "PATCH", path, `{"subDepth":0}`))
	if !v.SubOff || v.SubLimits() != (model.SubLimits{Depth: 0, Cap: 100}) || w.SubOff == nil || !*w.SubOff || w.SubDepth != nil || w.SubCap == nil || *w.SubCap != 100 {
		t.Fatalf("after subDepth 0: %+v", v)
	}
	// Absent is unchanged: the cap alone leaves the chat off.
	if v, _ = subPatched(t, e.expect(200, "PATCH", path, `{"subCap":25}`)); v.SubLimits() != (model.SubLimits{Depth: 0, Cap: 25}) {
		t.Fatalf("after subCap 25: %+v", v.SubLimits())
	}
	if v, w = subPatched(t, e.expect(200, "PATCH", path, `{"subDepth":3,"subCap":1}`)); v.SubLimits() != (model.SubLimits{Depth: 3, Cap: 1}) || w.SubOff != nil || *w.SubDepth != 3 || *w.SubCap != 1 {
		t.Fatalf("after both: %+v", v.SubLimits())
	}
	// null is absent, and so is a body that names neither.
	for _, body := range []string{`{"subDepth":null,"subCap":null}`, `{}`, `{"name":"Mine"}`} {
		if v, _ = subPatched(t, e.expect(200, "PATCH", path, body)); v.SubLimits() != (model.SubLimits{Depth: 3, Cap: 1}) {
			t.Fatalf("after %s: %+v", body, v.SubLimits())
		}
	}
	// With the other settings, and with the branch named.
	v, _ = subPatched(t, e.expect(200, "PATCH", path+"?branch=main", `{"subDepth":2,"model":"opus"}`))
	if v.SubLimits() != (model.SubLimits{Depth: 2, Cap: 1}) || v.Model != "opus" || v.Name != "Mine" {
		t.Fatalf("after a depth and a model: %+v", v)
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", path, "")); got.SubLimits() != (model.SubLimits{Depth: 2, Cap: 1}) {
		t.Fatalf("the chat as it is read: %+v", got.SubLimits())
	}
	// The choice is the sticky one of the chat's group, in the snapshot's defaults too.
	var d model.Defaults
	e.st.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	if got := defaults.Sub(d, model.Ungrouped); got != (model.SubLimits{Depth: 2, Cap: 1}) {
		t.Fatalf("the sticky settings: %+v", got)
	}
	if raw, _ := json.Marshal(e.a.Snapshot()); !strings.Contains(string(raw), `"subagents":{"depth":2,"cap":1}`) {
		t.Fatalf("the snapshot's defaults lack the settings: %s", raw)
	}
	if next := e.chat(`{"agent":"cursor","group":"__ungrouped__"}`); next.SubLimits() != (model.SubLimits{Depth: 2, Cap: 1}) {
		t.Fatalf("the next new chat: %+v", next.SubLimits())
	}

	// A value outside the range is refused with a sentence that names the range, one that is no
	// whole number as any body that cannot be read; nothing changes, not the model either.
	for body, part := range map[string]string{
		`{"subDepth":4}`:                  "subagent depth 4 is out of range: 0 (off) to 3",
		`{"subDepth":-1}`:                 "subagent depth -1 is out of range",
		`{"subCap":0}`:                    "subagent cap 0 is out of range: 1 to 100",
		`{"subCap":101}`:                  "subagent cap 101 is out of range",
		`{"subDepth":1,"subCap":1000}`:    "subagent cap 1000 is out of range",
		`{"subDepth":9,"model":"sonnet"}`: "subagent depth 9 is out of range",
		`{"subDepth":"2"}`:                "",
		`{"subCap":2.5}`:                  "",
		`{"subDepth":true}`:               "",
	} {
		out := e.expect(400, "PATCH", path, body)
		if msg := decode[map[string]any](t, out)["error"]; msg == "" || msg == nil || !strings.Contains(msg.(string), part) {
			t.Fatalf("PATCH %s: %s, want an error with %q", body, out, part)
		}
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", path, "")); got != v {
		t.Fatalf("the refused changes left %+v, want %+v", got, v)
	}

	// Once the first message is sent: 409, with a sentence that says why, whatever else is named.
	// (A branch and a fork are refused by the same check: see the chat manager's tests.)
	e.expect(200, "POST", path+"/messages", `{"text":"hi"}`)
	for _, to := range []string{path, path + "?branch=main"} {
		for _, body := range []string{`{"subDepth":1}`, `{"subCap":5}`, `{"subDepth":2,"subCap":1}`, `{"subDepth":0,"model":"sonnet"}`, `{"subDepth":44}`} {
			out := e.expect(409, "PATCH", to, body)
			if msg, _ := decode[map[string]any](t, out)["error"].(string); !strings.Contains(msg, "subagent depth and cap can be changed only in a chat that has not started and is neither a fork nor a branch") {
				t.Fatalf("PATCH %s %s: %s", to, body, out)
			}
		}
	}
	if got := decode[model.ChatView](t, e.expect(200, "GET", path, "")); got.SubLimits() != (model.SubLimits{Depth: 2, Cap: 1}) || got.Model != "opus" {
		t.Fatalf("the chat after the refused changes: %+v", got)
	}
}

// An API client's new chat starts with the subagent settings this server remembers for its
// place, as a page's does, whatever the call names: "subDepth" and "subCap" are no fields of a
// new chat and are read past. The client changes them with PATCH until the first message, a
// value outside the range is refused, and its choice is what the next chat there starts with,
// whoever makes it.
func TestSubSettingsOfAnAPIClientsChat(t *testing.T) {
	t.Parallel()
	sp := &apiSpawner{}
	e, l := remoteEnv(t, withAgents(sp))
	x, _ := l.api(apiX)
	y, _ := l.api(apiY)
	// What a chat made on this server starts with, in no group.
	if err := e.st.Update(func(s *model.State) error {
		defaults.RecordSub(&s.Defaults, model.Ungrouped, model.SubLimits{Depth: 3, Cap: 7})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if v := unstartedBy(t, x, chat1, "subDepth", 0, "subCap", 50, "aSettingOfALaterServer", 5); v.SubLimits() != (model.SubLimits{Depth: 3, Cap: 7}) || v.SubOff {
		t.Fatalf("the new chat: %+v", v.SubLimits())
	}
	path := "/api/chats/" + chat1
	for what, bad := range map[string]string{
		"a depth above the most":  `{"subDepth":4}`,
		"a depth below 0":         `{"subDepth":-1}`,
		"a cap of 0":              `{"subCap":0}`,
		"a cap above the most":    `{"subCap":101}`,
		"a good depth, a bad cap": `{"subDepth":2,"subCap":500}`,
		"a depth that is text":    `{"subDepth":"2"}`,
		"a cap that is a part":    `{"subCap":2.5}`,
	} {
		status, out := x.Do("PATCH", path, bad)
		if got := decode[refusal](t, string(out)); status != 400 || got.Error == "" {
			t.Fatalf("a change with %s: %d %s", what, status, out)
		}
	}
	if v, err := e.a.Chats.View(chat1); err != nil || v.SubLimits() != (model.SubLimits{Depth: 3, Cap: 7}) || sp.count() != 0 {
		t.Fatalf("the chat after the refused changes: %+v, %v; %d programs", v.SubLimits(), err, sp.count())
	}

	if v, wire := subPatched(t, string(do(t, x, "PATCH", path, `{"subDepth":0,"subCap":9}`))); v.SubLimits() != (model.SubLimits{Depth: 0, Cap: 9}) || !v.SubOff ||
		wire.SubOff == nil || !*wire.SubOff || wire.SubCap == nil || *wire.SubCap != 9 {
		t.Fatalf("the client's change: %+v, on the wire %+v", v.SubLimits(), wire)
	}
	// The client's choice is this server's for the place: the next chat there starts with it,
	// another client's and the owner's page's alike.
	var d model.Defaults
	e.st.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	if got := defaults.Sub(d, model.Ungrouped); got != (model.SubLimits{Depth: 0, Cap: 9}) {
		t.Fatalf("the settings this server remembers: %+v", got)
	}
	if next := unstartedBy(t, y, chat2); next.SubLimits() != (model.SubLimits{Depth: 0, Cap: 9}) {
		t.Fatalf("the next chat of another client: %+v", next.SubLimits())
	}
	if next := e.chat(`{"agent":"cursor","group":"` + model.Ungrouped + `"}`); next.SubLimits() != (model.SubLimits{Depth: 0, Cap: 9}) {
		t.Fatalf("the next chat of the owner's page: %+v", next.SubLimits())
	}
	// Started: the settings are fixed for the client too.
	do(t, x, "POST", path+"/messages", obj{"text": "the first message"})
	if status, out := x.Do("PATCH", path, `{"subDepth":2}`); status != 409 {
		t.Fatalf("an API client's change of a started chat: %d %s", status, out)
	}
}

// TestSubSettingsReachTheOtherServer: between two real stacks. A chat of B's section is made on
// B at once; its settings are changed from A's page, on B, where the chat is, and B remembers
// the choice for the chat's group, as it does for its own page. A second chat in that group,
// which names nothing, starts with what B remembers. A remembers nothing for B.
func TestSubSettingsReachTheOtherServer(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a, b := pr.a, pr.b
	p := a.page("P")
	group := decode[obj](t, string(do(t, p, "POST", pr.on("/groups"), obj{"name": "Work", "parent": ""})))["id"].(string)
	chosen := model.SubLimits{Depth: 0, Cap: 7}
	sticky := func(e *env) (out map[string]model.SubLimits) {
		out = map[string]model.SubLimits{}
		e.st.Read(func(s *model.State) {
			for g, gd := range s.Defaults.Groups {
				for key, sd := range gd.Servers {
					if sd.Subagents != nil {
						out[g+" on "+key] = *sd.Subagents
					}
				}
			}
		})
		return out
	}

	first := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": group})))
	if first.Locked || first.SubLimits() != model.DefaultSubLimits() {
		t.Fatalf("the new chat: %+v", first)
	}
	// The chat is on B from the start, and is no chat of A: the change is made on B.
	if there, err := b.a.Chats.View(first.ID); err != nil || there.Locked || there.SubLimits() != model.DefaultSubLimits() {
		t.Fatalf("the chat on B before its first message: %+v, %v", there, err)
	}
	if _, err := a.a.Chats.View(first.ID); !errors.Is(err, chats.ErrNotFound) {
		t.Fatalf("the new chat is a chat of A: %v", err)
	}
	ans := decode[struct{ Chat model.ChatView }](t, string(do(t, p, "PATCH", pr.on("/chats/"+first.ID), obj{"subDepth": 0, "subCap": 7})))
	if ans.Chat.SubLimits() != chosen || !ans.Chat.SubOff || ans.Chat.Locked {
		t.Fatalf("the chat after the change: %+v", ans.Chat)
	}
	if there, err := b.a.Chats.View(first.ID); err != nil || there.SubLimits() != chosen || !there.SubOff {
		t.Fatalf("the chat on B after the change: %+v, %v", there, err)
	}
	// A value outside the range is B's to refuse: its answer, as it came.
	if status, out := p.Do("PATCH", pr.on("/chats/"+first.ID), `{"subDepth":99}`); status != 400 {
		t.Fatalf("a depth outside the range: %d %s", status, out)
	}

	for i, id := range []string{first.ID, ""} {
		if id == "" { // the second chat: it names nothing, and starts with what B remembers for the group
			next := decode[model.ChatView](t, string(do(t, p, "POST", pr.on("/chats"), obj{"agent": "claude", "group": group})))
			if next.SubLimits() != chosen {
				t.Fatalf("the next new chat on B: %+v", next.SubLimits())
			}
			id = next.ID
			if there, err := b.a.Chats.View(id); err != nil || there.Locked || there.SubLimits() != chosen {
				t.Fatalf("the next new chat, on B: %+v, %v", there, err)
			}
		}
		do(t, p, "POST", pr.on("/chats/"+id+"/messages"), obj{"text": "hello"})
		there, err := b.a.Chats.View(id)
		if err != nil || !there.Locked || there.SubLimits() != chosen || !there.SubOff {
			t.Fatalf("chat %d on B: %+v, %v", i, there, err)
		}
		// On A the chat is no chat of its own, and B's section shows what B says.
		if _, err := a.a.Chats.View(id); !errors.Is(err, chats.ErrNotFound) {
			t.Fatalf("chat %d is a chat of A: %v", i, err)
		}
		pr.wait("A shows the started chat with B's settings", func() bool {
			status, out := p.Do("GET", pr.on("/chats/"+id), "")
			v := decode[model.ChatView](t, string(out))
			return status == 200 && v.Locked && v.SubOff && v.SubLimits() == chosen
		})
		// The settings of a chat that has started are fixed: B says so.
		if status, out := p.Do("PATCH", pr.on("/chats/"+id), `{"subDepth":2}`); status != 409 || !strings.Contains(string(out), chats.ErrSubFixed.Error()) {
			t.Fatalf("a change of the started chat %d: %d %s", i, status, out)
		}
	}

	// B remembers the choice for the group, as its own; A remembers nothing for B.
	if got := sticky(b); len(got) != 1 || got[group+" on "+model.LocalServer] != chosen {
		t.Fatalf("B's sticky settings after the chats of A's page: %+v", got)
	}
	if got := sticky(a); len(got) != 0 {
		t.Fatalf("A's sticky settings: %+v", got)
	}
}
