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

// A chat's subagent settings on the wire: "subDepth" and "subCap" of PATCH /api/chats/{id} and of
// an API client's creation call, and "subOff", "subDepth" and "subCap" of the chat that answers.

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
	if got := defaults.Sub(d, model.Ungrouped, model.LocalServer); got != (model.SubLimits{Depth: 2, Cap: 1}) {
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

// An API client's creation call: "subDepth" and "subCap" are the chat's when named, 1 and 100
// when not, whatever this server remembers, and a value outside the range is refused before
// anything is made. A field the call does not know is read past: that is what lets a server from
// before the settings take a creation call that names them.
func TestCreationCallSubSettings(t *testing.T) {
	sp := &apiSpawner{}
	set, _ := agentsOf("claude", "cursor")
	e, l := remoteEnv(t, withAgents(sp), func(s *Server) { s.App.Agents, s.App.Chats.Agents = set, set })
	x, _ := l.api(apiX)
	cwd := t.TempDir()
	// What a chat made on this server would start with, in every group there is or will be.
	if err := e.st.Update(func(s *model.State) error {
		defaults.RecordSub(&s.Defaults, model.Ungrouped, model.LocalServer, model.SubLimits{Depth: 3, Cap: 7})
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	for what, bad := range map[string][]any{
		"a depth above the most":  {"subDepth", 4},
		"a depth below 0":         {"subDepth", -1},
		"a cap of 0":              {"subCap", 0},
		"a cap above the most":    {"subCap", 101},
		"a good depth, a bad cap": {"subDepth", 2, "subCap", 500},
		"a depth that is text":    {"subDepth", "2"},
		"a cap that is a part":    {"subCap", 2.5},
	} {
		got := start(t, x, 400, startBody(chat1, cwd, bad...))
		if got.Code != "bad_request" || got.Started || got.Sent || got.Chat != nil {
			t.Fatalf("a creation call with %s: %+v", what, got)
		}
	}
	if len(e.remoteGroups()) != 0 || sp.count() != 0 || len(e.a.Chats.Views()) != 0 {
		t.Fatalf("the refused calls left groups %v, %d programs, %d chats", e.remoteGroups(), sp.count(), len(e.a.Chats.Views()))
	}

	for id, c := range map[string]struct {
		more []any
		want model.SubLimits
	}{
		chat1: {nil, model.SubLimits{Depth: 1, Cap: 100}},
		chat2: {[]any{"subDepth", 0, "subCap", 7}, model.SubLimits{Depth: 0, Cap: 7}},
		chat3: {[]any{"subDepth", 2, "aSettingOfALaterServer", 5}, model.SubLimits{Depth: 2, Cap: 100}},
	} {
		got := start(t, x, 200, startBody(id, cwd, c.more...))
		if !got.Started || !got.Sent || got.Chat == nil || got.Chat.SubLimits() != c.want || got.Chat.SubOff != (c.want.Depth == 0) {
			t.Fatalf("the creation call of %s: %+v", id, got)
		}
		if v, err := e.a.Chats.View(id); err != nil || v.SubLimits() != c.want {
			t.Fatalf("the chat %s: %+v, %v", id, v.SubLimits(), err)
		}
	}
	// Started: the settings are fixed for the client too.
	if status, out := x.Do("PATCH", "/api/chats/"+chat1, `{"subDepth":2}`); status != 409 {
		t.Fatalf("an API client's change of a started chat: %d %s", status, out)
	}
	// The clients' chats fed no default: the group they are in has what it was seeded with.
	rg := e.remoteGroups()
	if len(rg) != 1 {
		t.Fatalf("groups named Remote: %v", rg)
	}
	var d model.Defaults
	e.st.Read(func(s *model.State) { d = defaults.Copy(s.Defaults) })
	for _, g := range []string{rg[0], model.Ungrouped} {
		if got := d.Groups[g].On(model.LocalServer).Subagents; got == nil || *got != (model.SubLimits{Depth: 3, Cap: 7}) || d.Groups[g].Server != "" {
			t.Fatalf("the defaults of %s after the clients' chats: %+v", g, d.Groups[g])
		}
	}
}

// TestSubSettingsReachTheOtherServer: between two real stacks. A chat that will start on B is
// given its settings on A, where it still is; its first message makes the chat on B with them;
// A then shows the chat with what B says it has, and remembers the choice for B, under B's key.
// A second chat, which names nothing, starts on B with what A remembers for B. B itself takes
// no default from either: an API client's chats feed none.
func TestSubSettingsReachTheOtherServer(t *testing.T) {
	t.Parallel()
	pr := newPair(t, remotes.Limits{})
	a, b := pr.a, pr.b
	p := a.page("P")
	group := decode[obj](t, string(do(t, p, "POST", "/api/groups", obj{"name": "Work", "parent": ""})))["id"].(string)
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

	first := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats", obj{"agent": "claude", "group": group, "server": pr.entry})))
	if first.Server != pr.entry || first.Locked || first.SubLimits() != model.DefaultSubLimits() {
		t.Fatalf("the new chat: %+v", first)
	}
	// Until its first message the chat is here: the change is made here, and B knows nothing of it.
	ans := decode[struct{ Chat model.ChatView }](t, string(do(t, p, "PATCH", "/api/chats/"+first.ID, obj{"subDepth": 0, "subCap": 7})))
	if ans.Chat.SubLimits() != chosen || !ans.Chat.SubOff || ans.Chat.Server != pr.entry {
		t.Fatalf("the chat after the change: %+v", ans.Chat)
	}
	if _, err := b.a.Chats.View(first.ID); err == nil {
		t.Fatal("B has the chat before its first message")
	}

	for i, id := range []string{first.ID, ""} {
		if id == "" { // the second chat: it names nothing, and starts with what A remembers for B
			next := decode[model.ChatView](t, string(do(t, p, "POST", "/api/chats", obj{"agent": "claude", "group": group, "server": pr.entry})))
			if next.SubLimits() != chosen {
				t.Fatalf("the next new chat on B: %+v", next.SubLimits())
			}
			id = next.ID
		}
		do(t, p, "POST", "/api/chats/"+id+"/messages", obj{"text": "hello"})
		there, err := b.a.Chats.View(id)
		if err != nil || !there.Locked || there.SubLimits() != chosen || !there.SubOff {
			t.Fatalf("chat %d on B: %+v, %v", i, there, err)
		}
		if mark, err := b.a.Chats.ClientOf(id); err != nil || mark != testLocalID {
			t.Fatalf("chat %d on B has the mark %q, %v", i, mark, err)
		}
		// On A the chat is a record now, which shows what B says.
		if _, err := a.a.Chats.View(id); !errors.Is(err, chats.ErrNotFound) {
			t.Fatalf("chat %d is still a chat object of A: %v", i, err)
		}
		pr.wait("A shows the started chat with B's settings", func() bool {
			status, out := p.Do("GET", "/api/chats/"+id, "")
			v := decode[model.ChatView](t, string(out))
			return status == 200 && v.Locked && v.Server == pr.entry && v.SubOff && v.SubLimits() == chosen
		})
		// A record's settings are fixed.
		if status, out := p.Do("PATCH", "/api/chats/"+id, `{"subDepth":2}`); status != 409 || !strings.Contains(string(out), chats.ErrSubFixed.Error()) {
			t.Fatalf("a change of the started chat %d: %d %s", i, status, out)
		}
	}

	// A remembers the choice for B alone, under B's key; B remembers nothing.
	got := sticky(a)
	if len(got) != 1 {
		t.Fatalf("A's sticky settings: %+v", got)
	}
	for where, l := range got {
		if !strings.HasPrefix(where, group+" on ") || strings.HasSuffix(where, " on "+model.LocalServer) || l != chosen {
			t.Fatalf("A's sticky settings: %+v", got)
		}
	}
	if got := sticky(b); len(got) != 0 {
		t.Fatalf("B's sticky settings after A's chats: %+v", got)
	}
}
