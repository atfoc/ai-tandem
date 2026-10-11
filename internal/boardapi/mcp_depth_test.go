package boardapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/store"
)

// limits gives chats the subagent settings a chat is started with: they are written to each
// chat.json, and a new manager, which the relay then uses, reads them.
func (e *env) limits(depth, limit int, ids ...string) {
	e.t.Helper()
	m := e.relay.Chats
	for _, id := range ids {
		path := filepath.Join(m.Store.P.ChatDir(id), "chat.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			e.t.Fatal(err)
		}
		var meta model.ChatMeta
		if err := json.Unmarshal(raw, &meta); err != nil {
			e.t.Fatal(err)
		}
		meta.Subagents = &model.SubLimits{Depth: depth, Cap: limit}
		if err := store.WriteJSONAtomic(path, meta, 0o600); err != nil {
			e.t.Fatal(err)
		}
	}
	nm := chats.New(chats.Deps{Store: m.Store, Bridge: e.relay.Bridge, Boards: e.relay.Boards, DefaultCwd: m.DefaultCwd, MCPURL: m.MCPURL, Spawners: m.Spawners})
	if err := nm.Load(); err != nil {
		e.t.Fatal(err)
	}
	e.relay.Chats = nm
}

// A chat whose subagents are off is listed no spawn tool, with a board or without, and a call of
// one is refused with the reason and starts nothing.
func TestDepthOffListsAndRunsNoSpawnFamily(t *testing.T) {
	e := newEnv(t)
	plain, plainTok := e.createPlain()
	e.limits(0, 100, e.chat, plain)

	if got := e.listNames(e.token); !joinEq(got, namesOf(boardtools.Tools)) {
		t.Fatalf("a board chat with subagents off is listed %v", got)
	}
	if got := e.listNames(plainTok); len(got) != 0 {
		t.Fatalf("a plain chat with subagents off is listed %v", got)
	}
	for _, tok := range []string{e.token, plainTok} {
		for _, name := range namesOf(boardtools.SpawnFamily) {
			text, isErr, status := e.toolsCall(tok, name, probeArgs(name))
			if status != 200 || !isErr || text != name+" is not available: subagents are off in this chat" {
				t.Fatalf("%s with subagents off: %q isErr=%v status=%d", name, text, isErr, status)
			}
		}
	}
	if n := e.claude.count(); n != 0 {
		t.Fatalf("%d processes started", n)
	}
}

// A spawn over the chat's cap is answered as an error that names the cap, and starts nothing.
func TestSpawnOverTheCapIsRefused(t *testing.T) {
	e := newEnv(t)
	e.limits(1, 1, e.chat)
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"one"}`); isErr {
		t.Fatalf("the first spawn: %q", text)
	}
	text, isErr, status := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"two"}`)
	if status != 200 || !isErr || !strings.Contains(text, "cap on running subagents is 1") || !strings.Contains(text, "not queued") {
		t.Fatalf("a spawn over the cap: %q isErr=%v status=%d", text, isErr, status)
	}
	if n := e.claude.count(); n != 1 {
		t.Fatalf("%d processes started, want the first subagent's alone", n)
	}
}

// subs are the chat's subagents, as its thread lists them.
func (e *env) subs(id string) []model.Subagent {
	e.t.Helper()
	_, _, subs, err := e.relay.Chats.Items(id)
	if err != nil {
		e.t.Fatal(err)
	}
	return subs
}

// descriptionsOf are the texts an agent reads of the tools it is listed: each tool's
// description and those of its parameters, joined.
func descriptionsOf(tools []map[string]any) string {
	var b strings.Builder
	for _, tl := range tools {
		b.WriteString(tl["description"].(string) + "\n")
		schema, _ := tl["inputSchema"].(map[string]any)
		props, _ := schema["properties"].(map[string]any)
		for _, p := range props {
			if d, ok := p.(map[string]any)["description"].(string); ok {
				b.WriteString(d + "\n")
			}
		}
	}
	return b.String()
}

// At depth 2 a subagent of the chat's agent is listed the spawn family, in words that are true
// of it, and its calls are its own: what it spawns has it as parent, it stops only its own, and
// list_subagent_models tells it what its own spawns use. The subagent it starts has no family.
func TestDepthTwoSubagentHasTheSpawnFamily(t *testing.T) {
	e := newEnv(t)
	e.limits(2, 100, e.chat)
	m := e.relay.Chats
	if text, isErr, _ := e.toolsCall(e.token, "spawn_subagent", `{"prompt":"level one","model":"opus","effort":"low"}`); isErr {
		t.Fatalf("the chat's spawn: %q", text)
	}
	waitFor(t, "the first subagent's process", func() bool { return e.claude.count() == 1 })
	one := e.claude.last(t).opts
	oneSID := e.subs(e.chat)[0].ID

	if got := e.listNames(one.MCP.Token); !joinEq(got, append(namesOf(boardtools.Tools), namesOf(boardtools.SpawnFamily)...)) {
		t.Fatalf("a subagent at level 1 of 2 is listed %v", got)
	}
	var family []map[string]any
	for _, tl := range e.listSchemas(one.MCP.Token) {
		if boardtools.IsSpawnFamily(tl["name"].(string)) {
			family = append(family, tl)
		}
	}
	read := descriptionsOf(family)
	if strings.Contains(read, "this chat") || !strings.Contains(read, "omit for your own agent") || !strings.Contains(read, "You are a subagent yourself") {
		t.Fatalf("the spawn family as a subagent reads it:\n%s", read)
	}
	if own := descriptionsOf(e.listSchemas(e.token)); !strings.Contains(own, "omit for this chat's agent") || strings.Contains(own, "You are a subagent yourself") {
		t.Fatalf("the spawn family as the chat's agent reads it changed:\n%s", own)
	}

	// What its spawns use where they name nothing is its own model and effort, not the chat's.
	text, isErr, _ := e.toolsCall(one.MCP.Token, "list_subagent_models", `{}`)
	if isErr || !strings.Contains(text, "Model omitted -> opus, effort low.") ||
		!strings.Contains(text, "Effort omitted with a model named -> your effort (low) if the model offers it") || strings.Contains(text, "this chat") {
		t.Fatalf("list_subagent_models for the subagent:\n%s", text)
	}
	if text, isErr, _ := e.toolsCall(one.MCP.Token, "spawn_subagent", `{"prompt":"level two"}`); isErr {
		t.Fatalf("the subagent's spawn: %q", text)
	}
	waitFor(t, "the second subagent's process", func() bool { return e.claude.count() == 2 })
	two := e.claude.last(t).opts
	var twoSA model.Subagent
	for _, sa := range e.subs(e.chat) {
		if sa.ID != oneSID {
			twoSA = sa
		}
	}
	if twoSA.Parent != oneSID || twoSA.Model != "opus" || twoSA.Effort != "low" || two.Model != "opus" {
		t.Fatalf("the subagent a subagent started: %+v, its process %+v", twoSA, two)
	}

	// The deepest level: board tools alone, and every call of the family refused with the reason.
	if got := e.listNames(two.MCP.Token); !joinEq(got, namesOf(boardtools.Tools)) {
		t.Fatalf("a subagent at level 2 of 2 is listed %v", got)
	}
	for _, name := range namesOf(boardtools.SpawnFamily) {
		text, isErr, _ := e.toolsCall(two.MCP.Token, name, probeArgs(name))
		if !isErr || text != name+" is not available to a subagent at level 2: this chat's subagent depth is 2" {
			t.Fatalf("%s at the deepest level: %q", name, text)
		}
	}

	// Stopping: only one's own.
	notYours := "that subagent was not started by you: stop_subagent stops only the subagents you started yourself"
	if text, isErr, _ := e.toolsCall(e.token, "stop_subagent", `{"sid":"`+twoSA.ID+`"}`); !isErr || text != notYours {
		t.Fatalf("the chat's agent stops a subagent's subagent: %q", text)
	}
	if text, isErr, _ := e.toolsCall(one.MCP.Token, "stop_subagent", `{"sid":"`+oneSID+`"}`); !isErr || text != notYours {
		t.Fatalf("a subagent stops itself: %q", text)
	}
	if text, isErr, _ := e.toolsCall(one.MCP.Token, "stop_subagent", `{"sid":"`+twoSA.ID+`"}`); isErr {
		t.Fatalf("a subagent stops its own: %q", text)
	}
	if _, _, subs, _ := m.Items(e.chat); len(subs) != 2 {
		t.Fatalf("subagents %+v", subs)
	}
}

// The whole chain with scripted agents that call the endpoint with their own tokens, for each
// kind of agent: the chat's agent spawns a subagent, that one spawns a subagent and ends its
// turn, gets the result as a message that starts a second turn of the same process, and reports
// to the chat's agent, which gets that as a message in its turn.
func TestNestedChainPerKind(t *testing.T) {
	for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} {
		t.Run(string(kind), func(t *testing.T) {
			e := newEnv(t)
			f := agenttest.New(kind)
			f.MCP = http.HandlerFunc(e.relay.ServeFixedMCP)
			e.relay.Chats.Spawners[kind] = f
			v, err := e.relay.Chats.Create(kind, model.Ungrouped, "")
			if err != nil {
				t.Fatal(err)
			}
			e.limits(2, 100, v.ID)
			m := e.relay.Chats
			t.Cleanup(func() { m.Stop(v.ID) })

			var mu sync.Mutex
			seen := map[string]string{} // what the script noted, by name
			note := func(k, v string) { mu.Lock(); seen[k] = v; mu.Unlock() }
			f.Script(func(tn *agenttest.Turn) {
				results := strings.Contains(tn.Text, "<subagent-results>")
				switch {
				case tn.Text == "top":
					tn.Call("spawn_subagent", map[string]any{"prompt": "middle"})
				case tn.Text == "middle":
					note("middle tools", strings.Join(tn.Tools(), ","))
					if text, isErr := tn.Call("spawn_subagent", map[string]any{"prompt": "leaf"}); isErr {
						note("middle spawn", text)
					}
					tn.Say("a leaf is at work")
				case tn.Text == "leaf":
					note("leaf tools", strings.Join(tn.Tools(), ","))
					text, _ := tn.Call("spawn_subagent", map[string]any{"prompt": "too deep"})
					note("leaf spawn", text)
					tn.Say("leaf report")
				case results && tn.Opts.Subagent:
					note("middle turn", fmt.Sprint(tn.N))
					note("middle got", tn.Text)
					tn.Say("middle report")
				case results:
					note("top turn", fmt.Sprint(tn.N))
					note("top got", tn.Text)
					tn.Say("all done")
				}
			})
			if err := m.Send(v.ID, "top", "", nil); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "the chat's agent to answer the result", func() bool {
				_, items, _, err := m.Items(v.ID)
				return err == nil && len(items) > 0 && items[len(items)-1].Kind == "end" && items[len(items)-2].Text == "all done"
			})
			mu.Lock()
			defer mu.Unlock()
			if seen["middle spawn"] != "" {
				t.Fatalf("the subagent's spawn was refused: %q", seen["middle spawn"])
			}
			if got := seen["middle tools"]; got != strings.Join(namesOf(boardtools.SpawnFamily), ",") {
				t.Fatalf("the middle subagent was listed %q", got)
			}
			if got := seen["leaf tools"]; got != "" {
				t.Fatalf("the leaf was listed %q", got)
			}
			if got := seen["leaf spawn"]; got != "spawn_subagent is not available to a subagent at level 2: this chat's subagent depth is 2" {
				t.Fatalf("the leaf's spawn: %q", got)
			}
			if seen["middle turn"] != "2" || !strings.Contains(seen["middle got"], "<report>leaf report</report>") ||
				!strings.Contains(seen["middle got"], "Subagents you spawned still running: 0.") {
				t.Fatalf("the middle subagent's second message (turn %s):\n%s", seen["middle turn"], seen["middle got"])
			}
			if seen["top turn"] != "2" || !strings.Contains(seen["top got"], "<report>middle report</report>") ||
				strings.Contains(seen["top got"], "leaf report") || !strings.Contains(seen["top got"], "Subagents of this chat still running: 0.") {
				t.Fatalf("the chat's agent's second message (turn %s):\n%s", seen["top turn"], seen["top got"])
			}

			_, items, subs, err := m.Items(v.ID)
			if err != nil || len(subs) != 2 {
				t.Fatalf("subagents %+v, %v", subs, err)
			}
			var middle, leaf model.Subagent
			for _, sa := range subs {
				if sa.Parent == "" {
					middle = sa
				} else {
					leaf = sa
				}
			}
			if middle.Status != model.SubCompleted || middle.Last != "middle report" || middle.Waiting || middle.Kind != kind ||
				leaf.Parent != middle.ID || leaf.Status != model.SubCompleted || leaf.Last != "leaf report" || leaf.Kind != kind {
				t.Fatalf("middle %+v\nleaf %+v", middle, leaf)
			}
			// Each row is linked from the spawn call in the thread of the one that made it.
			linkedIn := func(items []model.Item, sid string) bool {
				for _, it := range items {
					if it.Kind == "tool" && it.Name == "mcp__board__spawn_subagent" && it.Subagent == sid {
						return true
					}
				}
				return false
			}
			_, midItems, err := m.SubItems(v.ID, middle.ID)
			if err != nil {
				t.Fatal(err)
			}
			if !linkedIn(items, middle.ID) || linkedIn(items, leaf.ID) || !linkedIn(midItems, leaf.ID) {
				t.Fatalf("links: the chat's thread to middle %v, to leaf %v; middle's thread to leaf %v",
					linkedIn(items, middle.ID), linkedIn(items, leaf.ID), linkedIn(midItems, leaf.ID))
			}
			rows := 0
			for _, it := range midItems {
				if it.Kind == "subresult" && it.Subagent == leaf.ID {
					rows++
				}
			}
			if rows != 1 || len(f.Spawns()) != 3 {
				t.Fatalf("%d result rows of the leaf in middle's thread, %d processes started", rows, len(f.Spawns()))
			}
		})
	}
}

// A chat a person opens on a run follows its own settings: at depth 2 its subagent is listed
// the spawn family and nothing of the run, and may call it; a run's own agents keep one level.
func TestChatOnARunFollowsItsDepth(t *testing.T) {
	rc := newRunCallers(t)
	e := rc.e
	e.limits(2, 100, rc.ids["chat on the run"])
	e.relay.Runs = rc.runs
	m := e.relay.Chats
	sa, err := m.SpawnSubagent(rc.ids["chat on the run"], chats.SpawnSubRequest{Prompt: "help"})
	if err != nil {
		t.Fatal(err)
	}
	tok := e.claude.last(t).opts.MCP.Token
	if got := e.listNames(tok); !joinEq(got, spawnNm) {
		t.Fatalf("a subagent of a chat on a run at depth 2 is listed %v", got)
	}
	if text, isErr, _ := e.toolsCall(tok, "spawn_subagent", `{"prompt":"deeper"}`); isErr {
		t.Fatalf("its spawn: %q", text)
	}
	for _, name := range []string{"get_run", "add_task", "read_board"} {
		if text, isErr, _ := e.toolsCall(tok, name, `{}`); !isErr || text != name+" is not available to subagents" {
			t.Fatalf("%s from a subagent of a chat on a run: %q", name, text)
		}
	}
	under := e.claude.last(t).opts
	if got := e.listNames(under.MCP.Token); len(got) != 0 {
		t.Fatalf("a subagent at the deepest level of a chat on a run is listed %v", got)
	}
	if text, isErr, _ := e.toolsCall(under.MCP.Token, "spawn_subagent", `{"prompt":"x"}`); !isErr ||
		text != "spawn_subagent is not available to a subagent at level 2: this chat's subagent depth is 2" {
		t.Fatalf("a spawn at the deepest level: %q", text)
	}
	if got := e.sub(rc.ids["chat on the run"], sa.ID); got.Parent != "" {
		t.Fatalf("the first subagent %+v", got)
	}

	// A task agent's subagent has no family, whatever depth a chat.json gives its chat.
	e.limits(3, 100, rc.ids["task agent"])
	e.relay.Runs = rc.runs
	m = e.relay.Chats
	if _, err := m.SpawnSubagent(rc.ids["task agent"], chats.SpawnSubRequest{Prompt: "help"}); err != nil {
		t.Fatal(err)
	}
	tok = e.claude.last(t).opts.MCP.Token
	if got := e.listNames(tok); len(got) != 0 {
		t.Fatalf("a task agent's subagent is listed %v", got)
	}
	if text, isErr, _ := e.toolsCall(tok, "spawn_subagent", `{"prompt":"x"}`); !isErr || text != "spawn_subagent is not available to subagents" {
		t.Fatalf("a spawn by a task agent's subagent: %q", text)
	}
}
