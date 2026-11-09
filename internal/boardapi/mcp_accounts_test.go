package boardapi

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// fakeAccounts are the Claude accounts of a test server: a usable.Extra for the Set and a
// chats.Accounts for the manager. why holds each account's reason not to be used (nil = usable);
// an account that is not in it is no account (removed).
type fakeAccounts struct {
	mu       sync.Mutex
	order    []model.AgentKind
	names    map[model.AgentKind]string
	why      map[model.AgentKind]error
	spawners map[model.AgentKind]*fakeSpawner
}

func (f *fakeAccounts) Kinds() []model.AgentKind {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]model.AgentKind(nil), f.order...)
}

func (f *fakeAccounts) Check(a model.AgentKind) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	why, ok := f.why[a]
	if !ok {
		return errors.New("This account was removed")
	}
	return why
}

func (f *fakeAccounts) Name(a model.AgentKind) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.names[a]
}

func (f *fakeAccounts) Spawner(a model.AgentKind) agent.Spawner {
	f.mu.Lock()
	defer f.mu.Unlock()
	if sp, ok := f.spawners[a]; ok {
		return sp
	}
	return nil
}

func (f *fakeAccounts) Namer(model.AgentKind) chats.Namer { return nil }

func (f *fakeAccounts) CheckFolder(model.AgentKind, string) error { return nil }
func (f *fakeAccounts) Prepare(model.AgentKind) error             { return nil }

var (
	work = model.AliasKind("a_k3j2m9x0")
	home = model.AliasKind("a_h0m3h0m3")
)

// withAccounts gives e's server Claude Code and two accounts: Work, usable, and Home, not logged
// in. It returns the accounts and Work's spawner.
func withAccounts(e *env) (*fakeAccounts, *fakeSpawner) {
	e.t.Helper()
	ws := &fakeSpawner{}
	acc := &fakeAccounts{
		order:    []model.AgentKind{work, home},
		names:    map[model.AgentKind]string{work: "Claude · Work", home: "Claude · Home"},
		why:      map[model.AgentKind]error{work: nil, home: errors.New("Not logged in")},
		spawners: map[model.AgentKind]*fakeSpawner{work: ws, home: {}},
	}
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"},
		func(bin string) (string, error) {
			if bin != "claude" {
				return "", errors.New("not found")
			}
			return "/bin/" + bin, nil
		})
	set.SetExtra(acc)
	e.relay.Chats.Agents = set
	e.relay.Chats.Accounts = acc
	return acc, ws
}

// agentDescs is tools/list's description of the agent parameter per tool that has it.
func (e *env) agentDescs(token string) map[string]string {
	e.t.Helper()
	out := map[string]string{}
	for _, tool := range e.listSchemas(token) {
		props, _ := tool["inputSchema"].(map[string]any)["properties"].(map[string]any)
		if p, ok := props["agent"].(map[string]any); ok {
			out[tool["name"].(string)], _ = p["description"].(string)
		}
	}
	return out
}

// tools/list names a usable account by its kind in the enum and with its name in the description;
// an account that cannot be used is not listed.
func TestSpawnToolsListAccounts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	withAccounts(e)
	_, plain := e.createPlain()

	wantEnum := []any{"claude", string(work)}
	wantDesc := `claude, or claude:a_k3j2m9x0 ("Claude · Work"); omit for this chat's agent`
	for name, enum := range e.agentEnums(plain) {
		if !reflect.DeepEqual(enum, wantEnum) {
			t.Errorf("%s: enum %v, want %v", name, enum, wantEnum)
		}
	}
	descs := e.agentDescs(plain)
	if len(descs) != 2 {
		t.Fatalf("agent parameters: %v", descs)
	}
	for name, d := range descs {
		if d != wantDesc {
			t.Errorf("%s: description %q, want %q", name, d, wantDesc)
		}
	}
}

// spawn_subagent that names an account starts a subagent of the account's kind with the account's
// spawner; one that names no agent from a chat on an account starts one on the account too.
func TestSpawnOnAccount(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	_, ws := withAccounts(e)

	id, tok := e.createPlain()
	text, isErr, _ := e.toolsCall(tok, "spawn_subagent", fmt.Sprintf(`{"prompt":"x","agent":%q}`, work))
	if isErr {
		t.Fatalf("spawn naming the account: %q", text)
	}
	if sa := e.sub(id, receiptSid(t, text)); sa.Kind != work {
		t.Fatalf("subagent kind %s, want %s", sa.Kind, work)
	}
	waitFor(t, "the account's process", func() bool { return ws.count() == 1 })
	if e.claude.count() != 0 {
		t.Fatalf("Claude Code's spawner started %d processes", e.claude.count())
	}

	id, tok = e.createChat(work)
	text, isErr, _ = e.toolsCall(tok, "spawn_subagent", `{"prompt":"x"}`)
	if isErr {
		t.Fatalf("spawn from a chat on the account: %q", text)
	}
	if sa := e.sub(id, receiptSid(t, text)); sa.Kind != work {
		t.Fatalf("inherited subagent kind %s, want %s", sa.Kind, work)
	}
	waitFor(t, "the inherited account's process", func() bool { return ws.count() == 2 })
}

// list_subagent_models for an account answers Claude's built-in list, named for the account.
func TestListModelsForAccount(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	withAccounts(e)
	_, plain := e.createPlain()
	lines := e.modelLines(plain, fmt.Sprintf(`{"agent":%q}`, work))
	if want := fmt.Sprintf(`claude:a_k3j2m9x0 ("Claude · Work"): %d models.`, len(claude.Catalog.Models)); lines[0] != want {
		t.Fatalf("header %q, want %q", lines[0], want)
	}
	if len(lines) != 3+len(claude.Catalog.Models) {
		t.Fatalf("%d lines: %q", len(lines), lines)
	}
	for i, m := range claude.Catalog.Models {
		if lines[3+i] != modelRow(m) {
			t.Fatalf("row %d %q, want %q", i, lines[3+i], modelRow(m))
		}
	}

	// From a chat on the account, an omitted agent is the account.
	_, tok := e.createChat(work)
	if got := e.modelLines(tok, `{}`); got[0] != lines[0] {
		t.Fatalf("own agent: header %q", got[0])
	}
}

// Naming an account that cannot be used, or one that was removed, is refused with the reason the
// person reads, and nothing starts; so is a spawn from a chat on an account that can no longer be
// used.
func TestAccountUnusableRefusal(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	acc, ws := withAccounts(e)
	gone := model.AliasKind("a_g0neg0ne")
	_, plain := e.createPlain()
	for kind, why := range map[model.AgentKind]string{home: "Not logged in", gone: "This account was removed"} {
		for _, call := range [][2]string{
			{"spawn_subagent", fmt.Sprintf(`{"prompt":"x","agent":%q}`, kind)},
			{"list_subagent_models", fmt.Sprintf(`{"agent":%q}`, kind)},
		} {
			text, isErr, status := e.toolsCall(plain, call[0], call[1])
			if status != 200 || !isErr || text != why {
				t.Errorf("%s naming %s: status %d, isErr %v, %q, want %q", call[0], kind, status, isErr, text, why)
			}
		}
	}

	_, tok := e.createChat(work)
	acc.mu.Lock()
	acc.why[work] = errors.New("Docker is not running")
	acc.mu.Unlock()
	e.relay.Chats.Agents.Refresh()
	for _, call := range [][2]string{{"spawn_subagent", `{"prompt":"x"}`}, {"list_subagent_models", `{}`}} {
		text, isErr, _ := e.toolsCall(tok, call[0], call[1])
		if !isErr || text != "Docker is not running" {
			t.Errorf("%s from a chat on the account: isErr %v, %q", call[0], isErr, text)
		}
	}
	if n := ws.count() + acc.spawners[home].count(); n != 0 || strings.Contains(fmt.Sprint(e.agentEnums(tok)), string(work)) {
		t.Fatalf("%d processes started; enums %v", n, e.agentEnums(tok))
	}
}
