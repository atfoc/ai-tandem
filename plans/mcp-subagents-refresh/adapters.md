# Adapter surfaces (facts for mcp-subagents plan refresh)

Read-only survey of HEAD `b15640a` in worktree `mcp-subagents-plan`. No design. Verified facts cite `path:line`. Anything not pinned in this tree is marked **assumption**.

Scope: surfaces that matter for (a) spawning a process, (b) giving it board MCP access, (c) steering away from native subagent tools, (d) filtering which MCP tools it sees.

Shared board endpoint today: `http://localhost:6006/mcp` (`internal/boardapi/endpoint.go:9-11`). Credential is the chat’s durable token in `Authorization: Bearer …`, never a URL segment (`internal/agent/agent.go:25-27`).

---

## Shared spawn path

### `SpawnOptions` / `BoardAccess`

```15:27:internal/agent/agent.go
type SpawnOptions struct {
	ChatID    string
	SessionID string // Claude: the id to create or resume; Cursor: the id to load ("" = new session)
	Resume    bool
	Cwd       string
	Model     string // Claude alias or Cursor base id
	Effort    string
	Board     *BoardAccess // nil for plain chats
}

type BoardAccess struct {
	MCPURL string // the fixed board MCP endpoint, http://localhost:6006/mcp (Claude, Cursor and pi)
	Token  string // the chat's durable board token; the MCP credential, never a URL segment
}
```

`ChatID` is unused by Claude and Cursor spawners. Pi uses it for `AppRoot/chats/<ChatID>/pi` and bridge `RegisterRun` (`internal/pi/pi.go:154-155`, `internal/pi/args.go:171-176`).

`Model` comment names Claude alias / Cursor base id; Pi actually stores a provider-qualified id (`provider/id`, `internal/pi/catalog.go:129-135`).

### How `chats.Manager` fills spawn options

```470:479:internal/chats/manager.go
func (m *Manager) spawnOptions(c *Chat) agent.SpawnOptions {
	opts := agent.SpawnOptions{ChatID: c.meta.ID, SessionID: c.meta.SessionID, Resume: c.meta.Locked,
		Cwd: c.meta.Cwd, Model: c.meta.Model, Effort: c.meta.Effort}
	if c.meta.Agent == model.Cursor && !c.meta.Locked {
		opts.SessionID = ""
	}
	if c.meta.Board != "" {
		opts.Board = &agent.BoardAccess{MCPURL: m.MCPURL, Token: c.meta.Token}
	}
	return opts
}
```

Facts:

- Spawn happens on first `Send`, not on `Create` (`internal/chats/manager.go:342`, `425-443`).
- Board chats mint `meta.Token = randHex(16)` at create (`internal/chats/manager.go:364-368`). Plain chats have no token and `Board == nil`.
- One token per chat, handed to every later spawn/resume of that chat. There is no second token type for a child process in this manager.
- Cursor new chats force `SessionID = ""` until locked; Cursor then emits `EvSession` from `session/new` (`internal/cursor/cursor.go:214`). Claude and Pi get an app-assigned UUID at create (`internal/chats/manager.go:369-371`).
- `Resume` is `c.meta.Locked` (true after first send).
- Tests pin the same `BoardAccess` for Claude, Cursor, and Pi: fixed URL + chat token, token not in the URL (`internal/chats/manager_test.go:841-914`).

A process started through `Spawner.Spawn(spawnOptions)` therefore always gets **the parent chat’s** board credential or none. Distinct child credentials are not an adapter feature today; they would require a different `BoardAccess` on a different `Spawn` call.

---

## 1. Claude (`internal/claude/`)

### Spawn

Binary default `"claude"`. One process per chat, `claude -p` stream-json on stdin/stdout (`internal/claude/claude.go:1-3`, `135-159`).

`Args` (`internal/claude/claude.go:39-64`), every chat:

- `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
- `--permission-mode auto --permission-prompt-tool stdio --forward-subagent-text`
- `--session-id <id>` (new) or `--resume <id>` (resume)
- `--model` when set; `--effort` when set **and** model is not `"haiku"`
- `--disallowedTools` = `AppDirRules` only (app data folder Read/Edit/Write + Bash glob). **Not** Task/Agent.

Board chats extra (`o.Board != nil`):

- `--append-system-prompt` = `s.Prompt` (`prompts.Claude()`)
- `--mcp-config` = JSON string (not a file)
- `--allowedTools` = comma-joined `mcp__board__` + every `boardtools.Tools` name

Env: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`internal/claude/claude.go:161`). Cwd = `o.Cwd`. `ChatID` unused.

Tests (`internal/claude/args_test.go`):

- Plain chat must **not** have `--append-system-prompt`, `--mcp-config`, `--allowedTools` (`args_test.go:32-36`).
- Board MCP config pinned (`args_test.go:53-57`):

```json
{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer tok"}}}}
```

- Isolation flags **absent** on every chat: `--strict-mcp-config`, `--setting-sources`, `--disable-slash-commands`, `--system-prompt`, `--tools` (`args_test.go:108-112`).
- Comment on that config (`claude.go:67-69`): “the installed Claude Code (2.1.284) accepts; only the URL is advertised, never a path token.” Sample init in tests is version `2.1.281` (`translate_test.go:16`).

`--allowedTools` is only the `mcp__board__*` list. This tree does **not** document whether Claude treats that flag as auto-approve vs a hard tool allow-list. Isolation via `--tools` is explicitly not used.

### Board MCP / child credential

Parent process gets one `--mcp-config` on argv. Native Claude subagents are Claude-internal (`task_type: local_agent`, `translate.go:107-121`); the adapter does not spawn them and has no second `--mcp-config`. **Fact:** there is no Claude adapter API to give a child a different MCP header/token than the parent. **Assumption (not tested here):** a native Claude subagent of this process sees the same MCP servers as the parent.

### Steering native subagents

`--disallowedTools` is only app-dir rules (`claude.go:72`, `args_test.go:103-107`). Task/Agent are **not** disallowed. Native spawn is live: `--forward-subagent-text`, initialize `agentProgressSummaries` / `forwardSubagentText` (`claude.go:44`, `169-171`), `task_*` translation (`translate.go:107-146`).

Native tool names in this tree:

- Adapter comments call Claude’s parent tool “Agent tool_use” (`internal/agent/agent.go:154`).
- Stream events use `task_started` / `task_id` / `tool_use_id` / `subagent_type`; no fixture asserts the `tool_use.name` string (`translate_test.go:119`).
- Original plan Q3 (Task vs Agent across CLI versions) is **still unverified** in this codebase.

UI: `isSubagentTool` matches item name `"Agent"` or `"Task"` (`web/src/logic/subagents.ts:9-10`).

### Filtering MCP tools the model sees

Board chats: one MCP server key `"board"`, `--allowedTools` listing every current board tool (`list_boards`, `read_board`, `get_view`, `apply`, `delete_elements`, `create_board`, `show_board` — `internal/boardtools/tools.go:45-109`). No per-tool subset. No `--strict-mcp-config`, so user Claude MCP from settings is not isolated by this adapter.

Permissions: `can_use_tool` over stdio; app-dir inputs denied with no card; others become `EvPermRequest` (`claude.go:176-205`).

---

## 2. Cursor (`internal/cursor/`)

### Spawn

Binary default `"agent"`. Command is **`agent acp`** in `o.Cwd` (`internal/cursor/cursor.go:90-94`, `internal/cursor/acp.go:48-66`). Environment is the server’s, **unchanged** (`acp.go:47-48`: “with the server’s environment unchanged”). The app does **not** set `CURSOR_DATA_DIR` or `CURSOR_CONFIG_DIR` on the process.

Handshake (`cursor.go:137-178`): `initialize` → `authenticate` (`cursor_login`) → `session/new` or `session/load` → `cursor/list_available_models` → `applyChoice`. Handshake continues in the background; `Send` waits on `ready`.

`session/new` / `session/load` params are only `cwd`, `mcpServers`, and on load `sessionId` (`cursor.go:155-167`). Tests pin that (`cursor_test.go:261`, `585-603`).

### Board MCP

```148:163:internal/cursor/cursor.go
func mcpServers(o agent.SpawnOptions) []any {
	if o.Board == nil || o.Board.MCPURL == "" {
		return []any{}
	}
	return []any{map[string]any{
		"type": "http",
		"name": "board",
		"url":  o.Board.MCPURL,
		"headers": []any{
			map[string]any{"name": "Authorization", "value": "Bearer " + o.Board.Token},
		},
	}}
}
```

Pinned payload (`cursor_test.go:595`):

```json
{"cwd":"…","mcpServers":[{"type":"http","name":"board","url":"http://localhost:6006/mcp","headers":[{"name":"Authorization","value":"Bearer <token>"}]}]}
```

Comment: headers array must exist even when empty (ACP schema; experiment A.1). ACP trace logger redacts these headers (`acp.go:219-226`).

There is **no** Cursor flag or ACP field in this adapter that lists/allows/denies individual MCP tools. The model sees whatever the `board` server’s `tools/list` returns, plus whatever else Cursor loads from the user’s project/user MCP config. **Assumption:** native Task children share the ACP session’s `mcpServers`; not re-tested in this tree.

No adapter API for a child ACP session with a different token: native Task is Cursor-internal (`subagent_spawned`, `cursor/task`). The app replies empty-success to `cursor/task` (`cursor.go:769-773`).

### Permission model (user-global vs per-session)

**User-global, boot-time** (`cmd/ai-whiteboard/main.go:185`, `internal/cursor/config.go:27-91`): `EnsureDenyRules` writes `Read(<app root>/**)` and `Write(<app root>/**)` into `~/.cursor/cli-config.json` (or `$CURSOR_CONFIG_DIR/cli-config.json`). It keeps other keys; it does nothing if the file is missing. `permissions.deny` entries are parameterised paths (`Read(…)`, `Write(…)`), not tool names.

**Per-session (ACP):** `session/request_permission`. Board MCP calls matching provider `"board"` + `boardtools.IsTool` are auto-approved (`allow_once` preferred so nothing is written to user config; fall back to `allow_always`) (`cursor.go:798-807`). App-dir inputs rejected. Everything else becomes `EvPermRequest`.

Live-trace comment: Cursor agent mode often sends **no** permission request for board MCP at all; the auto-approve branch is defensive (`cursor_test.go:616-618`).

**Native Task never asks the ACP client for permission.** That is a settled research result (below), not something `Decide` can stop.

`applyChoice` (`params.go:45-79`) always sets model, thinking=true, largest context, effort/thought_level. Runs on every spawn because Cursor restores shared last-used params.

### Auto-approval / spawn extras

No `--force` / `--trust`. No tool allow/deny flags. Initialize `_meta.subagents: true` turns **event streaming** on, and does not remove Task (`cursor.go:76-81`; confirmed in research).

Display mapping: Task → tool name `"Agent"` (`cursor.go:689-691`). Detection: `rawInput._toolName == "task"` or title prefix `"Task: "` (`cursor.go:462-470`).

### Cursor Task-deny research (`cursor-task-deny.md`) — Q2

Original-plan Q2 (`plans/mcp-subagents.md:404-406`): *whether Cursor can scope a native-Task deny to board sessions; v1 ships instruction-only.*

**Settled answer in the research file:** a Cursor `preToolUse` hook that matches `Task` and returns deny **does** refuse the call inside Cursor. No subagent process is created. Deny beats `--force` and any permission mode. The model still **sees** Task and may try it; every call is refused.

#### What was tried (table condensed from the research)

| # | What | Result |
| --- | --- | --- |
| 1 | `agent -p` baseline “delegate via Task” | Task spawned a subagent |
| 2–3 | `agent -p` + `hooks.json` at **git root** | Hook fired; Task blocked; fallback message made the model run `agent -p` via Shell |
| 4 | ACP via this app’s `internal/cursor` client, no hook | Task spawned (`EvSub`); **no permission request** |
| 5 | ACP + hook in repo root / cwd / non-repo `/tmp` | Hook never ran; subagent spawned |
| 6 | ACP + hook at `~/.cursor/projects/<slug(cwd)>/.cursor/hooks.json` | Hook fired; Task denied; no EvSub |
| 7 | Same + fallback message | Model ran `agent -p` via Bash |
| 8 | ACP + `CURSOR_DATA_DIR=/tmp/ctd-data` + hook under it | Hook fired; Task denied; login/session/model normal |
| 9 | `--plugin-dir` plugin hooks | Works in `-p`; **ACP never loads plugin hooks** |
| 10 | `--exclude-tools task_tool_call` / header | Ignored; Task still present |
| 12b | `~/.cursor/hooks.json` (user file) | **Fires in ACP**, but not chat-scoped |
| 14–15 | hook crash/timeout without `failClosed` | **Task ran** (fail-open) |
| 16 | matcher `^task$` | Did not fire (case-sensitive) |
| 20 | `subagentStart` hook | **Never fired in ACP** |
| 21 | Claude-format `<data dir>/projects/<slug>/.claude/settings.json` | Fires in ACP |
| 23 | ACP ask mode | No Task, but also no edits/commands |
| 24–24d | `composer-2.5`, `gpt-5.2`, `gemini-3.7-flash`, `claude-haiku-4-5` | Tool name is `Task`; all denied |
| 27 | Recipe through `acpcheck` | No `sub` event; model quoted the deny `user_message` |

Negative results the planner should not rediscover:

- Attempt 4: native Task never asks the ACP client, so `Decide` cannot stop it.
- Attempt 5: ACP does not read repo/`cwd` hooks (those work only in `-p`).
- Attempt 9: `--plugin-dir` is not wired into ACP.
- `permissions.deny` in `cli-config.json` takes `Shell(…)`, `Read(…)`, `Write(…)`, **not a tool name**.
- `--exclude-tools` / feature gates / team admin settings cannot remove Task.
- ACP `initialize` / `session/new` / `session/load` have **no hook field**. `clientCapabilities._meta.subagents` only toggles event streaming.

#### What works (quotes)

Hook config:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      { "command": "node /absolute/path/deny-task.js", "matcher": "^Task$" }
    ]
  }
}
```

Deny payload: `{ "permission": "deny", "user_message": "…", "agent_message": "…" }`. Anything else must print `{}`.

Where ACP actually reads the file (research):

> `agent acp` — what ai-whiteboard uses — `${CURSOR_DATA_DIR:-~/.cursor}/projects/<slug(cwd)>/.cursor/hooks.json`, slug = cwd with every run of non-alphanumerics replaced by `-`.

> For ACP the hook is per project folder and outside the repo.

> `CURSOR_DATA_DIR` works and is the cleanest app-owned option. … `CURSOR_CONFIG_DIR` does **not** move these paths.

> **Steering to the "other way" is a message, not a mechanism.** The deny only blocks the call. Put the alternative in `user_message` / `agent_message`.

> **What it does not do:** it does not remove `Task` from the model's tool list.

Follow-up recipe (research “Recommendation for ai-whiteboard”): per spawn, before `session/new`/`session/load`: set `CURSOR_DATA_DIR` to an app-owned dir **outside the app root**; write `<data dir>/projects/<slug(cwd)>/.cursor/hooks.json` with matcher `^Task$`, `failClosed: true`, and the redirect text in `user_message` only (`agent_message` is not delivered for denied Task — run 24). A static `echo '…json…'` is enough. File is read once when session resources are built.

`failClosed: true` is required: without it a crash or timeout lets Task run (runs 14, 15).

Redirecting `HOME` to isolate user hooks **breaks login** (run 12). User-global `~/.cursor/hooks.json` also fires in ACP and is not chat-scoped; merged decisions are `deny > ask > allow` (run 17), so a user allow cannot undo an app deny.

`CURSOR_DATA_DIR` moves `projects/…` only. Login, `cli-config.json`, `acp-sessions/<id>/store.db` stay in the config dir. `mcp-approvals.json` is **not** carried over (code reading, not run). Slug is the `cwd` string as sent, not realpath (run 26).

#### Is a scoped native-Task deny for board sessions now possible?

**Yes, as a deterministic Cursor-side refuse of `Task`, scoped to ACP sessions whose `cwd` slug has a hook file under an app-owned `CURSOR_DATA_DIR`.** That is enough to overturn the original-plan assumption that any Cursor deny would be user-global `cli-config.json`.

Caveats that are facts, not design:

- Scope is **per cwd slug**, not per chat id and not per `Board != nil`. Any later Cursor ACP session with the same `cwd` string (plain or board) reads the same hook file if it still exists.
- The current adapter does **not** set `CURSOR_DATA_DIR` or write hooks (`acp.go:48-66`).
- Hooks are a young Cursor feature; research ran on CLI `2026.10.01-e373342`.
- ACP protocol still cannot carry the hook; a no-files solution needs a Cursor feature (`--plugin-dir` in ACP, or honouring `--exclude-tools`).

Q2 answer for the planner: **instruction-only is no longer the only Cursor option.** A folder-scoped ACP `preToolUse` deny is demonstrated. It is not a per-board-session ACP field.

---

## 3. Pi (`internal/pi/` + `internal/pibridge/`)

### Spawn

Binary default `"pi"`, resolved to an absolute path and given to children as `AIWB_PI_BIN` (`internal/pi/pi.go:54-64`, `internal/pi/args.go:173`). Mode: `pi --mode rpc`.

`args` (`internal/pi/args.go:47-63`):

```
--mode rpc --no-extensions [-e <extension>] --session-dir <AppRoot/chats/<ChatID>/pi>
[--session-id] [--model] [--thinking]
[--append-system-prompt <append-prompt.md>]   # board chats with Prompt set
[--append-system-prompt "Never run bash commands without timeout"]  # DeepSeek Flash only
--no-approve
```

Built-in tools are **not** excluded (no `--no-builtin-tools`) (`args.go:35-37`, `args_test.go:76-80`). `--no-extensions` drops user extensions; `-e` loads only the app extension.

Board prompt is written to `sessionDir/append-prompt.md` (mode 0600), not passed as a literal (`pi.go:158-163`).

Env (`args.go:168-186`): cleaned of inherited `AIWB_*` and pi markers (`PI_SUBAGENT`, `PI_SESSION_ID`, … — `args.go:14-22`). Then:

| var | when |
| --- | --- |
| `AIWB_CHAT_ID`, `AIWB_CHAT_DIR`, `AIWB_PI_BIN` | always |
| `AIWB_BRIDGE_SOCKET`, `AIWB_BRIDGE_RUN` | bridge registered |
| `AIWB_MCP_CONFIG` | board chat with MCPURL |
| `AIWB_MODEL`, `AIWB_THINKING` | if set |
| `AIWB_APPEND_PROMPT` | board prompt file |

`AIWB_MCP_CONFIG` pinned (`args_test.go:194-200`):

```json
{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer board-secret-token"}}}}
```

Token appears only in that env var, never argv (`args_test.go:201-205`). Plain chats get no `AIWB_MCP_CONFIG`.

Bridge: `RegisterRun(chatID, proc)` mints a 32-hex **non-secret** run handle (`internal/pibridge/bridge.go:47-51`, `179-214`). Frozen contract: `internal/agent/bridge.go:5-32`.

Handshake: `get_state` → `get_available_models` → optional `set_model` / `set_thinking_level` (`pi.go:199-247`). Model id is split on first `/` into provider + modelId (`pi.go:221-225`).

### Board MCP (extension)

`internal/pibridge/extension/index.ts`:

1. Registers `--mcp-config` flag first (flag wins over `AIWB_MCP_CONFIG`; `mcp-wiring.ts:56-63`).
2. App adapter never passes the flag; production config is env (`args.go:182-183`).
3. On `session_start`, `startMCP` connects each HTTP server, `tools/list`, `pi.registerTool` as `mcp__<key>__<tool>` (`mcp.ts:39-41`, `mcp-wiring.ts:322-354`). MCP tools use `executionMode: "sequential"` (`mcp-wiring.ts:238`, `index.ts:164`).
4. App-sourced board tools (`source === "env"` and key `"board"`) are auto-allowed in the permission gate (`mcp-wiring.ts:71-88`, `permissions.ts:8-11`). Flag-sourced `"board"` is not auto-allowed.
5. Failures are per-server, non-fatal, `notice` over the bridge (`index.ts:88-99`).

HTTP-only in v1: stdio/`command` and legacy SSE rejected (`mcp.ts:176-196`).

### Native subagent support

App-owned `subagent` tool, registered only when the bridge is present (`index.ts:171-247`). It spawns **another** `pi --mode rpc -e <same extension>` (`subagent.ts:268-281`). Children inherit the parent env, including `AIWB_MCP_CONFIG` and bridge vars; they add `AIWB_SUB_PARENT` / `AIWB_SUB_DEPTH` / `AIWB_SUB_CHILD` (`subagent.ts:99-113`). Tests: board-chat child inherits config; plain-chat child gets none (`subagent.test.ts:738-766`).

**Distinct child credential:** `childEnv` copies all string env and does not rewrite `AIWB_MCP_CONFIG`. A native Pi subagent therefore gets the **same** board token as the parent. Distinct credentials are not implemented on this path.

Display: pi tool name `subagent` is shown as `"Agent"` (`internal/pi/translate.go:221-228`).

Pi also has an upstream spawn-subagent extension that **disables itself** when `PI_SUBAGENT=1`; the adapter strips that marker so app runs are not poisoned (`args.go:9-12`).

### Tool allow/deny

`--no-approve` plus extension `tool_call` hook (`index.ts:255-268`, `perm.go:8-16`):

- Auto-allow: app-sourced `mcp__board__*` and `subagent`.
- App-dir inputs: deny, no card (`AppDirDenied`).
- Every other tool: one bridge `ask`; adapter currently **always allows** (`perm.go:14-16`). `Decide` is unused (`perm.go:18-22`: “Nothing raises permission cards for pi anymore”).
- Ask failure/timeout: fail-safe block (`permissions.ts:29-32`, `115-122`).

No `--allowedTools` / `--disallowedTools` equivalent. Filtering which MCP tools exist is: whatever `tools/list` returns for servers in `AIWB_MCP_CONFIG` (or the flag). No subsetting in the extension.

### Sequential vs parallel subagents

- MCP tools: `executionMode: "sequential"` — a sequential tool in a batch serializes the whole batch (`index.ts:228-230`).
- `subagent` tool: **no** `executionMode`; comment: sibling calls from one assistant message run concurrently (`index.ts:228-247`). Description: “Call it several times in one message to run subagents in parallel” (`mcp-wiring.ts:169-176`).
- Nested children: `AIWB_SUB_DEPTH`; activity frames carry parent tool id (`subagent.ts:255-266`). Depth-1 is **not** enforced in the extension.

If a future spawn tool is an MCP tool on Pi, it inherits sequential execution. The existing `subagent` tool does not.

---

## 4. Prompts (`internal/prompts/`)

One body: `whiteboard.md`, rendered by `Claude()` / `Pi()` (`prompts.go:19-30`). Access phrase: `with the \`board\` MCP tools`. `{{TOOLS}}` is empty. Tools are **not** listed. Tests forbid a leftover “How to call the board tools” section (`prompts_test.go:16-29`).

Delivery:

| Agent | Board chat | Plain chat |
| --- | --- | --- |
| Claude | `--append-system-prompt` literal (`claude.go:61`) | none |
| Pi | `--append-system-prompt` file (`pi.go:158-163`, `args.go:58-60`); children reuse `AIWB_APPEND_PROMPT` (`subagent.ts:280`) | none |
| Cursor | **no** system-prompt slot. First board `Send` prepends `prompts.Claude()` once; `McpInstructionsSent` persisted (`manager.go:603-608`) | none |

Cursor leftover command path: tests fail if the first Cursor send contains `<board-api>` or `curl` (`manager_test.go:858-862`). There is no `CursorInstructions` function. `InstructionsSent` is the curl-era disable marker: those chats cannot spawn or call MCP (`manager.go:437-438`, `boardapi/mcp.go:59-61`, `model/model.go:207`).

Every board message (all agents) gets `<ui-context>` (`manager.go:609-615`, `prompts.go:32-35`).

No prompt text today tells the model to avoid native Task/Agent/subagent.

---

## 5. Catalogs and `Configure` validation

### Catalogs

| Agent | Source | Stored |
| --- | --- | --- |
| Claude | Static `claude.Catalog` (`internal/claude/catalog.go:8-16`): `sonnet`, `opus`, `haiku`. Efforts `low/medium/high/xhigh/max` except haiku (none). Default `sonnet`/`high`. | Not from a process |
| Cursor | Live `cursor/list_available_models` after handshake (`cursor.go:170-177`). Also boot probe `Spawner.Catalog`. IDs are Cursor’s bare values. Efforts from `thought_level`. | `s.SetCatalog` on `EvCatalog` |
| Pi | Live `get_available_models` (`internal/pi/catalog.go:41-70`). IDs `provider/id`. Reasoning models: `off/minimal/low/medium/high` plus `xhigh`/`max` when mapped. Default effort `medium` if present. Boot `Spawner.Catalog` with `--no-session --no-extensions`. | same |

> Note (2026-10-03): the Claude row is outdated — the list is now fetched from the CLI (built-in four-row list only as fallback); see `plans/claude-model-picker-plan.md`.

`Manager.catalog` (`manager.go:312-325`): Claude always static; Cursor/Pi from store (nil until first catalog event / boot refresh).

> Note (2026-10-03): no longer true — `Manager.catalog` now reads the stored Claude list, else the built-in one (D9); see `plans/claude-model-picker-plan.md`.

`defaults.AgentOrder` = Claude, Cursor, Pi (`internal/defaults/defaults.go:12-13`). `defaults.Resolve` falls back to catalog default and strips unsupported effort (`defaults.go:17-47`).

### `Configure` (`manager.go:647-728`) — reuse this for spawn-tool validation

`ConfigReq{Model, Effort, Cwd}` empty = unchanged.

Rules:

- Archived → `ErrArchived`.
- `InstructionsSent` (curl-era) → `ErrLegacy`.
- After first message (`Locked`): only a folder fix when the folder is missing; model/effort changes → `ErrLocked`.
- Cwd expanded (`~`, relative); must be a directory; must not be inside the app data folder (`ErrAppFolder`).
- Model: `findModel(cat, id)`. **Nil catalog (Cursor before first list) accepts any model** (`manager.go:747-755`). Unknown id → `unknown model %q`.
- Changing model: if current effort is not on the new model, effort becomes the model’s `DefaultEffort` or `""`.
- Setting effort: rejected if the (possibly new) model does not list it.
- Does not spawn a process.

Pi/Cursor catalogs can change under the user (boot refresh + `EvCatalog`). Claude cannot.

> Note (2026-10-03): no longer true — the Claude list is now fetched from the CLI and stored, and refreshed on server start and on each top-level chat process start; see `plans/claude-model-picker-plan.md`.

---

## 6. Agent-specific facts that make “one spawn tool, one Spawn()” uneven

These are differences in **today’s adapters**, not proposals.

1. **MCP injection is three different channels.** Claude: argv `--mcp-config`. Cursor: ACP `session/new|load` `mcpServers` (headers as **array** of `{name,value}`). Pi: env `AIWB_MCP_CONFIG` (headers as **object**). Same JSON idea, not the same wire.

2. **Native subagent tools already exist on all three, with different names and kill switches.** Claude: Agent/Task (name not pinned), `--disallowedTools` available, currently unused for that. Cursor: `Task` (`_toolName` `"task"`), no ACP tool deny; hook-file deny demonstrated outside this adapter. Pi: app `subagent` tool is the **intended** spawn path already (child `pi` processes), plus possible upstream tools if someone dropped `--no-extensions`.

3. **Pi children of the native `subagent` tool do not go through `chats.Manager.spawn`.** They inherit env. Claude/Cursor native children are vendor-internal. Only a new `Spawner.Spawn` call gets a fresh `SpawnOptions`.

4. **No adapter gives a child a different board token** unless the app itself `Spawn`s with a different `BoardAccess`. Pi native children copy `AIWB_MCP_CONFIG`. Claude/Cursor have no child-config hook.

5. **MCP tool filtering surfaces differ.** Claude: `--allowedTools` list + optional `--mcp-config` contents; `--strict-mcp-config` unused. Cursor: no per-tool filter in ACP; whole server or nothing. Pi: whatever `tools/list` returns; MCP tools sequential; no allow-list flag.

6. **Prompt slot.** Cursor cannot `--append-system-prompt`; first user message is the only app-owned instruction channel, and it is already used for the whiteboard body.

7. **Session identity.** Claude/Pi: app UUID in `--session-id`. Cursor: empty until `session/new`; resume needs Cursor’s id. A spawned Cursor process with `Resume: false` always creates a new ACP session.

8. **Model/effort vocabularies are not interchangeable.** Claude aliases vs Cursor bare ids vs Pi `provider/id`. `Configure`/`findModel` is the existing validator; nil Cursor catalog is a hole. Spawn-tool “model” cannot be one enum.

> Note (2026-10-03): no longer true for Claude and Cursor — the stored Claude list now shares ids with Cursor's; a cross-agent spawn without a model still takes the requested kind's new-chat defaults, now by rule (D22) and no longer because the lists are disjoint; see `plans/claude-model-picker-plan.md`.

9. **`ChatID` required for Pi** (session dir + bridge). Claude/Cursor ignore it.

10. **Permissions.** Claude: stdio cards except app-dir. Cursor: ACP cards except auto-approved board MCP; Task never cards. Pi: no cards; `--no-approve` + auto-allow board MCP and `subagent`.

11. **Cursor process env is not parameterized.** Adding `CURSOR_DATA_DIR` for Task-deny means changing `Start` (`acp.go:48-66`), which today passes no extra env.

12. **Pi MCP sequential vs subagent concurrent.** An MCP spawn tool on Pi would serialize with other MCP tools in the same assistant batch; the current `subagent` tool would not.

13. **Handshake timing.** Cursor and Pi `Send` wait for handshake; Claude `Send` writes immediately. Cursor catalog arrives after spawn.

14. **Subagent UI names.** Web treats `"Agent"` and `"Task"` as spawn tools (`web/src/logic/subagents.ts:9-10`). Pi’s `subagent` is rewritten to `Agent`. A new MCP name (`mcp__board__…`) would not match `isSubagentTool` unless the UI list grows.

---

## Q2 (original plan) — evidence-backed answer

Original: Cursor v1 is instruction-only until a scoped native-Task deny exists.

**Now:** a scoped deny is demonstrated for `agent acp` via a per-cwd-slug `preToolUse` hook under `CURSOR_DATA_DIR`, matcher `^Task$`, `failClosed: true`. It refuses Task inside Cursor; the app never gets a permission card. It does not remove Task from the tool list. It is not user-global `cli-config.json` (that cannot name Task). It is not an ACP session field. Scope is the chat **folder slug**, not the board flag. This worktree’s Cursor adapter does not implement it yet.

---

## File index

| Area | Paths |
| --- | --- |
| Shared spawn | `internal/agent/agent.go`, `internal/chats/manager.go` (`spawn`, `spawnOptions`, `Send`, `Configure`) |
| Claude | `internal/claude/claude.go`, `args_test.go`, `catalog.go`, `translate.go` |
| Cursor | `internal/cursor/cursor.go`, `acp.go`, `config.go`, `params.go`, `catalog.go`, `cursor_test.go` |
| Cursor Task deny | `cursor-task-deny.md` (research; not wired) |
| Pi | `internal/pi/pi.go`, `args.go`, `args_test.go`, `perm.go`, `catalog.go`, `subagent.go` |
| Pi extension | `internal/pibridge/extension/{index,mcp,mcp-wiring,subagent,permissions}.ts`, `internal/agent/bridge.go` |
| Prompts | `internal/prompts/prompts.go`, `whiteboard.md` |
| Board tools / MCP | `internal/boardtools/tools.go`, `internal/boardapi/mcp.go`, `endpoint.go` |
| Catalogs / defaults | `internal/defaults/defaults.go`, `internal/claude/catalog.go`, `internal/cursor/catalog.go`, `internal/pi/catalog.go` |
