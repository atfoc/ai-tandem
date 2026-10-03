# MCP Subagents — Implementation Plan

Status: draft, rebased onto HEAD `b15640a` after the unified MCP endpoint landed, then rebased
again so the **spawn family is on all chats**. Board tools remain board-chat-only. Native spawning
is replaced on every app chat (Claude, Cursor, and Pi). Plain chats are no longer an escape hatch
for Claude Task/Agent. **UI identity:** the parent-thread subagent card must show which agent
(Claude / Cursor / Pi) is running, because spawn can choose a different kind than the parent. No
implementation code; this document fixes decisions and integration points so implementation can
proceed without re-deriving identity or steering, and without touching `/mcp/<token>` or the
command endpoint (both are gone).

Evidence base (facts, not decisions): `plans/mcp-subagents-refresh/mcp-all-chats.md`
(authoritative for the all-chats delta), `plans/mcp-subagents-refresh/subagent-card-ui.md`
(authoritative for the card-identity delta), `plans/mcp-subagents-refresh/mcp-architecture.md`,
`plans/mcp-subagents-refresh/subagent-machinery.md`, `plans/mcp-subagents-refresh/adapters.md`,
`plans/mcp-subagents-refresh/stale-inventory.md`. Cursor Task-deny recipe:
`cursor-task-deny.md`. Landed MCP work is not re-planned; see `plans/unified-mcp-endpoint.md` only
as the reason the first rebase existed.

## 1. Goal and scope

Chat agents get MCP tools that spawn subagents **server-side through the app's own adapters**,
replacing native spawning **on every app chat**. A spawned subagent reuses the existing native
row, drawer, status, duration and context meter. Because spawn can choose a different agent than
the parent, the card in the parent thread must also show **which agent is running** (Claude vs
Cursor vs Pi), using the app’s existing agent visual language — not a new one. App-spawned
subagents run asynchronously and in parallel; results are collected with `wait_subagents`.

The spawn family (`spawn_subagent`, `wait_subagents`, `stop_subagent`) is available on **all
chats**. Board tools stay on chats that belong to a board. `tools/list` and call authorization
depend on **which chat** we are serving and on whether the caller is the chat agent or a
subagent.

Replacement of native spawning is deterministic on all three agents in v1, on board and plain
chats alike:

- Claude: native `Task` / `Agent` are disallowed on **all app chats**.
- Cursor: a folder-scoped ACP `preToolUse` deny of `Task` is enabled on **every app-spawned
  Cursor process** (board and plain, parent and app-spawned child) via an isolated
  `CURSOR_DATA_DIR` (D5). That isolation is **not** an escape hatch for plain chats. Do **not**
  write the deny into the user’s default `~/.cursor`.
- Pi: the extension’s native `subagent` tool is not registered on app chats that get the MCP
  spawn family (i.e. **all** of them); the MCP spawn family replaces it.

In scope: the fixed MCP surface (`POST http://localhost:6006/mcp` with `Authorization: Bearer`),
tokens and MCP config on every chat, a server-side subagent runner, per-caller header identity,
per-chat and per-caller `tools/list` / `tools/call` authorization, defaults/validation, steering
away from native spawning on Claude, Cursor, and Pi on every app chat, minimal web changes,
lifecycle integration.

Out of scope: a UI overhaul or new agent icon set / colours, per-subagent stop buttons, sidebar
entries for subs, MCP push/progress, re-planning the unified MCP endpoint, any `/mcp/<token>` or
`/agent/<token>/<tool>` surface, attach/detach of a chat onto or off a board (association is
create-time only).

## 2. Requirements and acceptance criteria

Functional:

- (a) `spawn_subagent` takes a prompt plus optional description, agent, model, effort — no
  `background` parameter.
- (b) Spawn always returns immediately with a receipt naming the sid and never blocks for the
  subagent's completion. Results are retrieved exclusively with `wait_subagents`, which blocks up
  to a measured interval, returns per-subagent status and report, and can be called repeatedly (on
  timeout it returns current status; timeout 0 = poll). `stop_subagent` cancels a runaway job.
- (c) Parallel spawns do not serialize on the chat lock. The app imposes no concurrency cap on
  sibling spawns from the chat agent.
- (d) Rendering and lifecycle events reuse the native subagent row, drawer, status, timers and
  meter. Linked cards additionally show the running agent (o).
- (e) Chat stop/interrupt/archive/delete and shutdown terminate app-spawned processes; restart
  marks them stopped; a normal turn end leaves app-spawned subagents running.
- (f) Omitted agent = the chat's kind; omitted model/effort = the chat's current values; explicit
  values are validated like `Configure` against the **requested** agent's catalog.
- (g) Errors are MCP tool text with `isError`, never HTTP errors for tool failures.
- (h) Spawn works with the window closed, and on a plain chat with **no browser client**. Board
  tool calls still need an open window and a board.
- (i) Depth exactly 1: only the chat agent may spawn. Subagent callers never receive the
  spawn-family tool definitions, and any spawn-family call from them is rejected as tool text
  (`isError`), starting nothing.
- (j) Spawn/wait/stop must not go through `Relay.Call` / `Bridge.Call` (that path is the 30 s
  board-tool bridge). Plain-chat MCP traffic is spawn-family only and must not depend on a
  browser client.
- (k) Tool names stay in the `mcp__board__*` family so existing label machinery applies. The UI
  recognition string for the spawn row is `mcp__board__spawn_subagent`. `serverInfo.name` stays
  `"board"`.
- (l) Identity, if per-caller, is extra Bearer tokens on the **fixed** URL — never path tokens.
- (m) Every chat has a durable Bearer token and MCP connectivity (URL + token). Board-tool extras
  (whiteboard prompt, `<ui-context>`, Claude board-tool allow-list, Cursor board-tool
  auto-approval and first-message board instructions, Pi board-tool allow / board wording) stay
  board-chat-only.
- (n) Chat↔board association is create-time only. A chat’s tool surface is stable for its life.
  Do not design attach/detach.
- (o) Each **linked** subagent card in the parent thread shows which agent is running it (Claude,
  Cursor, or Pi). Kind is persisted and emitted with the subagent. The card reuses the app’s
  existing agent glyph and colour language. Unlinked spawn rows (claim failed) stay cards and do
  **not** invent a kind.

Tool-surface matrix (no extra tools beyond board tools and the spawn family):

| Caller | Chat | `tools/list` and authorized calls |
| --- | --- | --- |
| Chat agent | Board chat | Board tools + spawn family |
| Chat agent | Plain chat | Spawn family only |
| Subagent (depth 1) | Board parent | Board tools only |
| Subagent (depth 1) | Plain parent | Neither |
| Missing / unknown / revoked token | — | Empty list; `tools/call` is `isError` text, never HTTP 401 |

Acceptance: a chat agent (Claude, Cursor, or Pi) talking to `POST http://localhost:6006/mcp` with
its Bearer token can spawn subagents; each spawn returns a receipt naming its sid while the run
continues asynchronously; results come from `wait_subagents` (report on completion, current
status on timeout, repeated waits as needed). The measured CLI MCP tool-call timeout only bounds
how long one `wait_subagents` call may block (D1). It can spawn several subagents in one turn in
parallel with no app-imposed concurrency limit (D2). The UI shows rows/drawer/status/timers/token
meter as for native subagents, and each **linked** card shows which agent (Claude / Cursor / Pi)
is running that sub. Stop leaves no orphan processes. Existing board-tool and
UI tests still pass except those that froze “no MCP / no token on plain chats” — those are
**updated, not preserved** (named in §6 from `mcp-all-chats.md` §7).

Per agent, “instead of native” is guaranteed in v1 by the steering in D5, not by a later
observation of the agent choosing well:

- Claude (board or plain): native Task/Agent never run.
- Cursor (board or plain, parent and app-spawned child): native Task is refused by the ACP hook;
  the model is steered to the MCP spawn family.
- Pi (board or plain): the native `subagent` tool is not offered; the MCP spawn family is.

Acceptance must include, for each agent: a **plain** chat spawning via MCP with **no board tools**
in `tools/list`, and a **board** chat still seeing board tools and the spawn family together.

## 3. Design decisions

### D1. Tool surface and API contract

Add three tools to the shared board MCP surface (`boardtools.Tools`, which already feeds MCP
`tools/list`, Claude `--allowedTools`, Cursor board-MCP detection, and Pi MCP discovery):
**spawn_subagent**, **wait_subagents**, **stop_subagent**. They are MCP names on the server named
`"board"`, not board-engine operations. The spawn family is exposed only to the chat agent's
caller identity; `wait_subagents` and `stop_subagent` serve the chat agent's own subagents.

`tools/list` is **currently global** — it ignores the Bearer token and always returns the seven
board tools (`internal/boardapi/mcp.go:227–228`, via `mcpTools` at `:165–176`). Per-chat and
per-caller visibility therefore **requires a change**: both `tools/list` and `tools/call`
authorization must depend on which chat we are serving and on whether the caller is the chat
agent or a subagent. That change is in scope here.

Handshake stance (required; do not leave this ambiguous):

Keep the landed permissive handshake: `initialize` / `tools/list` still succeed without a valid
token (HTTP 200). The list they return for **missing, unknown, or revoked** tokens is **empty** —
neither spawn family nor board tools. Advertising board tools would present them as if they work
(calls fail as unknown token / `isError` text). Advertising spawn family without a live chat-agent
token is forbidden. Chat-type + caller identity then add tools only for a **resolved live**
token, matching the matrix in §2:

- resolved chat-agent token on a board chat → board tools + spawn family
- resolved chat-agent token on a plain chat → spawn family only
- resolved subagent extra token on a board parent → board tools only
- resolved subagent extra token on a plain parent → empty

`tools/call` on missing/unknown/revoked tokens still returns tool text `isError` (never HTTP
401). Unauthorized names for a resolved caller (board tools on a plain chat agent, spawn family
on a subagent, anything on a plain-parent subagent) are the same shape: tool text `isError`,
nothing started. Board-tool calls that **are** authorized still go through `Relay.Call` / the
browser bridge and still fail without a board / without a client. Spawn-family calls never go
through the bridge.

`spawn_subagent` spawns one subagent per call — a required prompt, optional display description,
and the user's three knobs (agent, model, effort); there is no `background` parameter because every
app-spawned subagent is asynchronous. One subagent per call keeps tool-item correlation
one-to-one (D3). Parallel work is several calls, which the HTTP server already handles concurrently
(one goroutine per POST).

Async contract:

- `spawn_subagent` starts the run and returns immediately with a receipt naming the sid (and the
  subagent's current status). It never blocks for completion. The run is flagged as a background
  run in its state, so the UI never treats the receipt as a report (D2, D6).
- **`wait_subagents` is required** because MCP has no push channel: it takes one or more sids and
  an optional timeout, blocks until they finish or the timeout elapses, and returns per-subagent
  status and report; on timeout it returns current status, so it can be called repeatedly
  (timeout 0 = status poll). The binding limit is each CLI's own MCP tool-call timeout — the
  server can only block as long as the CLI keeps the call alive — so the wait interval (the
  server's blocking budget for one call) is derived from the measured limit with margin. Waits are
  short and repeatable. Phase 2 measures Claude, Cursor, and Pi against the fixed `/mcp` URL; the
  measurement only sizes the interval, it does not fork the design. If that phase finds an override
  environment for a CLI timeout, the adapters set it for **app-chat** processes so the wait
  interval fits inside the CLI limit.
- **`stop_subagent` is included**: it lets an agent cancel a runaway job; without an agent-visible
  cancel, background spawning would be a trap.

Routing: spawn/wait/stop must not go through `Relay.Call` / `Bridge.Call`. That path always waits
on the browser (30 s, or immediate `NoClientText` when the window is closed). The MCP handler
resolves the caller from the Bearer token first (D3); authorized board tools keep the existing
bridge path unchanged; spawn-family tools go to the new server-side path. All three agents share
this one MCP handler. Tool failures stay HTTP 200 JSON-RPC results with text and `isError`; HTTP
errors remain transport/protocol only (400/405/403).

There is no command endpoint, no `ParseCommand`, no `ERROR: ` prefix, and no Cursor instruction
list of curl commands.

### D2. Execution model

One independent agent process per spawned subagent, through the existing `agent.Spawner` /
`SpawnOptions` with a fresh session (not a resume), the chat's cwd, resolved model/effort, and
**its own per-caller token** issued for that run. The token is placed in that process's MCP
config/header on the **fixed** URL (`http://localhost:6006/mcp`):

- Claude child: its own `--mcp-config` with `Authorization: Bearer <sub token>`.
- Cursor child: its own ACP `mcpServers` headers array with the same Bearer value.
- Pi child: its own `AIWB_MCP_CONFIG`. Do **not** rely on native Pi children inheriting the parent
  env — those native children are what this feature replaces.

Every **parent** chat process also gets MCP config (URL + the chat’s durable token). Today
`spawnOptions` sets that only when `Board != ""` (`internal/chats/manager.go:477–479`). That gate
is split: MCP connectivity (URL + token) is no longer board-membership; board-tool extras stay
board-only (D5, D8).

The extra token is mapped in memory to (chat, subagent sid) and marks the caller as a subagent;
board tool calls from a **board-parent** subagent still resolve to the parent chat's board (D3).
Each sub gets its own event loop, transcript (same format/machinery as chat and sub threads) and
lifecycle.

It must **not** reuse `pump`. `pump` is bound to `c.ag` / `c.gen` and writes chat-level state
(`EvSession`, `EvUsage`, `EvCatalog`, turn counting) into the parent. The runner applies events to
the sub transcript, maps session/usage/catalog to per-sub state or ignores them, and reuses the
existing persistence/emission helpers in `subagents.go` (flush/save/emit/link/end), so the client
sees identical `sub` / `sub_items` events.

Every app-spawned subagent is a background run: the runner sets the subagent's background flag at
creation, so the UI renders summary/last text and the existing background chip instead of
mistaking the spawn receipt for a report (D6).

`Chat.mu` is held only for short state transitions (create/patch/persist/link), never while waiting
on a process or tool call — precedent: `Send` unlocks before `ag.Send`; `ContextSplit` waits
outside `c.mu`. Parallel tool calls are separate handler goroutines. The app imposes **no
concurrency limit** on sibling spawns from the chat agent. Nesting depth is fixed at 1: only the
chat agent may spawn, and a subagent process can never spawn another.

Depth-1 has two independent layers:

- **Tool-surface visibility** — spawn family is not defined for subagent callers (`tools/list`
  computed from the Bearer token omits it; Claude subagent `--allowedTools` excludes it; Pi app
  chats do not register native `subagent`, D5). Cursor has no per-tool MCP allow list; its
  visibility layer is the same `tools/list` filter.
- **Hard rejection** — if a spawn-family call nevertheless arrives from a subagent caller
  (hallucinated name, stale list, crafted request), the server returns tool text with `isError`
  and starts nothing; never an HTTP error.

Claude `--allowedTools` today dumps every `boardtools.Tools` name whenever MCP config is present
and only on board chats. After this change it must not dump board tools onto a **plain** Claude
chat agent. Intended split (high-level, no new spawn-options field required to ship):

- Claude **chat agent, board**: allow-list includes board tools and the spawn family.
- Claude **chat agent, plain**: allow-list includes the spawn family and **excludes** board tools.
- Claude **sub process**: excludes the spawn family; excludes board tools as well when the parent
  is plain.

If the parent-vs-child allow-list split lags, `tools/list` filtering plus hard rejection remain
the real depth-1 guarantee. The plain-vs-board split on the chat agent must not lag: a plain
Claude chat agent must be able to call the spawn family and must not be handed board-tool names.

Pi parallel-spawn caveat (required adapter change, not an app concurrency cap): Pi currently
registers every MCP tool as sequential, which would serialize sibling spawn calls in one assistant
message. The native `subagent` tool is deliberately *not* sequential for that reason. On app
chats, spawn-family MCP tools must be registered without sequential execution so sibling spawns
can run in parallel, matching native Pi and the other two agents. Board-engine MCP tools may stay
sequential.

Pi bridge caveat (required): `pibridge.RegisterRun` keyed by chat id retires the previous run for
that id. An app-spawned Pi sub must not reuse the parent chat's bridge run or session directory.
Each such sub gets its own bridge run identity and its own session directory under the parent
chat, so the parent Pi process keeps its bridge.

### D3. Caller identity, correlation and linking

MCP `tools/call` unmarshals only `name` + `arguments`. The JSON-RPC `id` is echoed on the
envelope and is not used as a tool-use id; `_meta` is not parsed. Caller identity is therefore
**not** taken from the claimed transcript item. It comes from the Bearer token.

Tokens:

- Today a token is minted only when `Board != ""` (`internal/chats/manager.go:364–370`). **Every
  chat** must get a durable Bearer token so it can call `POST http://localhost:6006/mcp`.
  `ByToken` already does not check `Board` (`internal/chats/manager.go:1008–1021`). Create always
  mints. Chats already on disk with an empty token receive one before their process is started,
  persisted like today’s board-chat tokens. The chat process keeps that persisted token
  (`ChatMeta.Token`, header credential, never a URL segment).
- At each subagent spawn the manager issues a fresh per-caller token for that run, held in
  memory, mapped to (chat, caller sid). Lookup yields chat, caller sid (empty for the chat
  agent), whether the caller is the chat agent or a subagent, and the caller's kind/model/effort,
  so D4's defaults come from the token, never from the claimed item. The same identity filters
  `tools/list` and authorizes `tools/call` (D1, D2).
- Extra tokens live on the same fixed URL. `/mcp/<token>` and `/agent/<token>/<tool>` must not
  reappear.
- The token is revoked when that subagent ends or is stopped and, in bulk, on chat
  stop/delete/shutdown. A `tools/call` on a revoked or unknown token gets tool text errors; a
  `tools/list` for those credentials is **empty** (D1), not a board-tool list. Restart needs
  nothing new: per-caller tokens live only in memory so none survives, and `loadSubs` already
  rewrites running subagents to stopped.
- Board tool calls from a board-parent subagent use that subagent's token and still go to the
  parent chat's board; a subagent caller is rejected before any claiming (D2), so a board
  subagent can read and draw but never spawn. Today's `ByToken` only matches `ChatMeta.Token`;
  the resolver must also recognize extra tokens and return the parent chat for board-engine
  calls.

Linking:

- On a spawn call, claim the **oldest pending, unclaimed tool item in the chat's own thread**
  whose name is the spawn tool and whose arguments canonically equal the request, FIFO under the
  chat lock so parallel calls claim distinct items. The claim yields the tool item id; parent and
  defaults never come from it.
- The model's `tool_use` event and the POST can race, so the item may not exist yet. The handler
  retries briefly; if still missing, it spawns unlinked and records a pending link, then a
  reconciliation pass on later transcript updates of the chat's thread re-attempts FIFO matching
  by canonical arguments. If a match never appears (item removed by Stop, chat deleted), the
  subagent still runs and its receipt is returned to the call; the caller's tool item renders as an
  unlinked row built from the item itself (`isSubagentTool` + `subagentOf`) with no subagent
  state — and therefore no agent kind to show (D6) — and it cannot open the drawer (opening
  requires the linked sid). Log it; cancel the
  subagent if the chat was deleted.
- The link sets the subagent's tool id to the matched item in the same locked step. No client
  fallback is added: the server guarantees the link.

Whether a captured real `tools/call` later shows a stable tool-use mapping in the JSON-RPC id or
`_meta` is a Phase 2 measurement, not a design fork. If it does, it may disambiguate the residual
below; claiming still works without it.

Residual (accepted, not harmless): only the chat's thread ever spawns, so claims cannot cross
threads, but two parallel spawn calls from the **chat agent with byte-equal arguments** remain
indistinguishable to the claim; claims stay FIFO among equal candidates. Each receipt carries its
own sid and each tool result still belongs to its originating call; for byte-equal siblings the
model-side results are interchangeable because the requests were identical, so the only residual
is that the UI pairing of row/drawer to sid may swap. The spawn tool description asks callers to
give parallel spawns distinct descriptions, which makes the arguments distinct and matching
deterministic.

### D4. Defaults and validation

Omitted agent = the chat's kind (the chat is the only legal spawner, D2). Caller and kind come
from the token (D3), not from the claimed item. Omitted model/effort = the chat's current
model/effort: the composer metaphor is the user's most recent choice for this work, while
`defaults.Resolve` is for creating chats, not spawning inside one. This needs two additive
persisted fields on the subagent: **agent kind** and effort. Kind is required for the card’s
visual identity, for `subModelLabel` (which must stop using the parent chat’s kind/catalog), and
for these defaults (D6). Today `model.Subagent` has no kind; unknown JSON extras are dropped on
rewrite (`subagent-card-ui.md` §5), so kind must be a real persisted and emitted field, not an
ad-hoc extra. Caller identity itself is never persisted.

Validation always uses the **requested** agent's catalog, not the caller's, so a cross-agent spawn
is checked against the kind it actually runs. Claude, Cursor, and Pi each have a catalog; model
vocabularies are not interchangeable (Claude aliases, Cursor bare ids, Pi `provider/id`). Values
inherited from the chat that do not fit the requested kind, and chat values that fail their own
catalog, both fall back using new-chat resolution rules for the requested kind. Explicit values
are validated like `Configure`: unknown model is an error; an effort the model does not offer is
an error; a model change resolves a stale effort the same way. Invalid input returns tool text
with no process started. A nil Cursor catalog accepts values unvalidated, exactly like
`Configure`; a wrong model then shows up as a subagent handshake failure in its status/error.

> Note (2026-10-03): "model vocabularies are not interchangeable" stopped being true — the stored Claude list shares ids with Cursor's; the fallback described here for cross-agent spawns now holds by rule (D22), no longer because the lists are disjoint; see `plans/claude-model-picker-plan.md`.

### D5. Steering away from native spawning

Steering is deterministic on **all app chats** for all three agents. Plain chats are not an
escape hatch.

**Claude, all app chats.** Add the native subagent tool names (`Task` and `Agent`, to cover CLI
versions) to the existing app-owned `--disallowedTools` list on every app chat, not only board
chats. A short paragraph about the MCP spawn tools (asynchronous; results come from
`wait_subagents` when the agent needs them) is steering, not a board extra — it belongs on every
Claude app chat. The **whiteboard body** and `<ui-context>` stay board-only. Trade-off: app chats
lose Claude's native Agent/Task, including custom agents.

**Cursor, all app-spawned processes.** A folder-scoped ACP `preToolUse` deny of `Task` is
demonstrated (`cursor-task-deny.md`): matcher `^Task$`, `failClosed: true`, hook file under
`$CURSOR_DATA_DIR/projects/<slug(cwd)>/.cursor/hooks.json`. It is not user-global
`cli-config.json` (that file cannot name Task), not an ACP session field, and not implemented in
the adapter today. Scope of the hook file is the cwd slug: any ACP session that shares that
data-dir and cwd string would read the same hook.

v1 stance: **enable the hook for every app-spawned Cursor process** (board and plain, parent and
app-spawned child) by starting those processes with an app-owned `CURSOR_DATA_DIR` outside the
app root and writing the hook for that cwd slug before the ACP session starts. Depth-1 still
needs Task denied on children too — native Task remains on the model’s list even when MCP
spawn-family is hidden. Do **not** write the hook under the user’s default `~/.cursor`; that
would deny Task for the user’s own Cursor usage in the same folder. The previous v1 isolation
that left plain app chats on the default data-dir so they **kept** Task is **revoked**.

The deny refuses the call inside Cursor; it does not remove Task from the model's tool list, and
native Task never asks the ACP client, so `Decide` cannot stop it. Put the alternative in the
hook's `user_message` (MCP spawn family, async receipt, wait for results). `failClosed: true` is
required; without it a crash or timeout lets Task run. Do not redirect `HOME` (breaks login).
`CURSOR_CONFIG_DIR` does not move the hook path.

The shared whiteboard prompt (Cursor's first board message is already `prompts.Claude()`) also
tells **board** Cursor chats to use the MCP spawn tools, not native Task. That first-message
board body stays board-only. Instruction is backup; the hook is the guarantee on every app
Cursor process.

**Pi, all app chats.** The extension already has a native `subagent` tool that spawns child `pi`
processes and funnels events into the parent. That is native spawning to replace, analogous to
Claude Task/Agent and Cursor Task. On app chats the extension does not register `subagent`; the
MCP spawn family replaces it. Do not reuse `pump` for the replacements, and do not reuse the
native child's env-inheritance path to carry credentials — app-spawned Pi subs get their own
`AIWB_MCP_CONFIG` (D2). Keep `--no-extensions` and the stripping of inherited `PI_SUBAGENT` so an
upstream spawn-subagent extension cannot sneak back.

Independently of native-tool steering, subagent processes are given a tool surface without the
spawn family: MCP `tools/list` omits it for their tokens, and Claude subagent `--allowedTools`
excludes it. Cursor and Pi have no `--allowedTools`; their guarantee is the list filter plus the
hard rejection (D2).

### D6. UI parity

Required client changes stay small: identity is **additive on existing card chrome**, not a UI
overhaul. They apply to board and plain chats; the spawn-family item name is the same everywhere.
Still out of scope here: per-sub stop buttons, sidebar entries for subs, a new icon set, or new
colour tokens.

Facts at HEAD (`subagent-card-ui.md`): the card has no agent kind, no `AgentGlyph`, no `agent-*`
colour; `subModelLabel` is keyed on the **parent** chat’s kind and catalog; `model.Subagent` has
no kind (`agentId` is a session/task id, `type` is subagent_type); unlinked rows have no model,
no background, no kind.

1. `isSubagentTool` must recognize the spawn tool's item name (`mcp__board__spawn_subagent`) in
   addition to `Agent` / `Task`. It is the only entry point to row rendering. Adapters already
   emit board tools as `mcp__board__<name>` (Claude via MCP server name `"board"`, Cursor via
   normalize, Pi already namespaced). Cursor’s display mapping of this server’s tools to
   `mcp__board__*` must apply whenever the server is attached (every app chat), not only when the
   chat has a board — otherwise a plain Cursor spawn row would not match `isSubagentTool`.
2. Persist and emit the subagent’s **agent kind** (Claude / Cursor / Pi) together with effort
   (D4). Mirror both in the web types; field additions are safe and SSE shapes do not change.
   Kind on the subagent is what the card and `subModelLabel` read — not the parent chat.
3. The **card in the parent thread** shows which agent is running that sub. Reuse the app’s
   existing agent visual language — `AgentGlyph` and the `agent-*` / `--claude` / `--cursor` /
   `--pi` slots already used in sidebar and header (`subagent-card-ui.md` §3) — not a new mark or
   palette. At a glance the card identifies Claude vs Cursor vs Pi: glyph plus colour at
   minimum, **and** the existing agent display name so the glyph is not the only cue (a thread
   card has no other surface that names the child agent). Put that identity in the **shared
   row/drawer chrome** (`SubMark` / `SubName` / `SubStats` or equivalent), not only in the row
   JSX. The drawer reuses those pieces today (`subagent-card-ui.md` §4); a row-only change would
   leave the drawer header lagging.
4. Cross-kind spawn: model · effort on the card uses the **subagent’s** kind and catalog.
   `subModelLabel` must stop using the parent chat’s kind/catalog. When the web has no catalog
   for that kind, the label falls back to the raw model id (already the no-match fallback). Add
   plain labels for wait/stop tool cards.
5. Unlinked spawn rows (claim failed, D3) remain cards via `isSubagentTool` + `subagentOf`.
   Without a linked sid there is no subagent state and no kind — do not invent one from the
   parent or from the tool item. The user sees today’s unlinked behaviour: description and status
   from the item, no drawer, no model · effort, no agent identity chrome (`subagent-card-ui.md`
   §2). If kind is absent for any other reason (a leftover native row), same rule: no fake kind.

Every app-spawned subagent carries the background flag (D2), so `subReport` uses summary/last text
and never the spawn receipt, and the existing background chip shows; no new client logic is needed
for this. Nothing else changes: store keys / `subKey`, `conn.ts`, `subagentOf` /
`subReport` / `showReport` / `subList`, background chip, timers, ctx meter, permission labelling,
no sidebar entry, no per-sub stop UI. The board-chat drawer gate (`panel` true) stays as it is
for native subs. The row opens only from the linked sid, so D3's link is the functional
prerequisite. The drawer already shares the row’s mark/name/stats; identity lives there so both
surfaces stay in step.

### D7. Lifecycle, failure and safety integration

Today `stopSubs` only marks state and `Stop` closes only `c.ag`. The runner must terminate
app-spawned processes when the chat lifecycle ends: stop/interrupt, aborted turn, parent `EvExit`,
archive/board delete, chat delete, shutdown. State is finalized and emitted immediately under
`c.mu`, while the process close happens asynchronously outside the lock — Claude's graceful close
kills after 3 s, and holding the lock across that would stall the pump and API reads (never take
the editor-bridge lock under a chat lock). A normal turn end keeps app-spawned subagents alive,
matching the existing native rule.

Permissions: subagents run with the chat's permission mode; their requests become permission items
in the parent transcript carrying the sid (existing “Asked by subagent” UI) and must be
answerable. `Manager.Decide` currently answers only `c.ag`; extend it to route by sid to the sub
process, and extend Stop / `stopSubs` to deny unanswered sub permissions. With no client attached,
a request simply waits.

Pi does not raise permission cards today (the adapter always allows except app-dir). App-spawned
Pi subs keep that adapter behavior; this feature does not invent Pi permission cards. Claude and
Cursor app-spawned subs raise cards through their adapters as native children do, except that
`Decide` must reach the child process rather than only the parent.

Restart needs no new work: `loadSubs` rewrites running to stopped and shutdown kills process
groups. In-memory extra tokens die with the process.

Failure handling: spawn errors (no spawner, missing folder, handshake failure) fail the subagent
with `Error` set and return the text; an exit without final status is marked stopped/failed with
the reason; wait timeouts return current status; unknown/final sids return text. Nesting is not
supported: a subagent caller is rejected and has no spawn-family tools. Board-parent subagents
still get board access — they can read and draw — but not the spawn family. Plain-parent
subagents get neither.

Legacy curl-era Cursor chats (`InstructionsSent`) already cannot spawn or call MCP; they stay
refused. Extra tokens are not issued for them.

### D8. Three-agent MCP parity (replaces the old Cursor command-path decision)

There is one MCP endpoint and one spawn-family contract for Claude, Cursor, and Pi, on board and
plain chats. Cursor parity is no longer a second transport. Board tools remain board-chat-only;
MCP connectivity is not.

What stays shared: tool definitions, Bearer identity on the fixed URL, name-based routing,
claiming, defaults/validation, UI events, lifecycle, the tool-surface matrix (D1).

What stays adapter-specific (today's three injection channels, unchanged in kind):

- Claude: argv `--mcp-config` (headers as an object) plus `--allowedTools` / `--disallowedTools`.
  `--mcp-config` and a spawn-family allow-list on **every** app chat; board-tool names on the
  allow-list and the whiteboard `--append-system-prompt` only on board chats (D2, D5).
- Cursor: ACP `session/new` and `session/load` `mcpServers` (headers as a name/value array) on
  **every** app chat. Board-tool auto-approval stays board-chat-only. Spawn-family MCP calls are
  auto-approved on every app-spawned Cursor process so the replacement path does not raise a
  card (native Task never asked). Starting any app-spawned Cursor process (parent or child, board
  or plain) also sets isolated `CURSOR_DATA_DIR` and writes the Task hook (D5). The adapter today
  passes the server environment unchanged; that is the integration point.
- Pi: env `AIWB_MCP_CONFIG` (same JSON object shape as Claude; token only in that env value, never
  argv or URL) on **every** app chat, plus not registering native `subagent` on those chats,
  non-sequential spawn-family MCP tools, and a distinct bridge run / session directory per
  app-spawned sub (D2, D5). Pi board-tool auto-allow and “child inherits the board tools” wording
  stay board-only.

Cursor model/effort semantics are preserved (base id plus validated effort, stored in the new
subagent fields so the drawer can show effort). A spawned Cursor process uses a fresh ACP session
(`Resume: false`). A spawned Pi process needs `ChatID` for its session directory and bridge, but
must not clobber the parent run (D2).

## 4. Modules and components

- **`boardtools`**: tool definitions — one source for MCP listing, Claude `--allowedTools`, Cursor
  board-MCP detection, and Pi MCP discovery. Spawn-family visibility is not “everyone who sees
  `Tools`”; listing is filtered per chat type and caller identity at the MCP handler.
  Spawn-family entries are not board-engine operations.

- **`boardapi` relay**: Bearer-token extraction on `POST /mcp`, caller resolution (chat token or
  extra token), name-based routing (authorized board tools → existing bridge path, spawn-family →
  chats runner), per-chat and per-caller `tools/list` (empty when the token does not resolve),
  endpoint contracts, text error formatting. **Knows nothing about processes.** Does not grow
  path-token routes. Does not send spawn-family through `Relay.Call`. Plain-chat spawn-family
  traffic must succeed with no browser client.

- **`chats.Manager` + subagent runner**: token minting for every chat, extra-token registry and
  ownership, defaults/validation, item claim and reconciliation, one process/loop/transcript per
  sub, persistence, stop/interrupt, permission routing by sid, depth-1 enforcement, issue/revoke
  of per-caller tokens. Reuses `subagents.go` persist/emit/link/end; does **not** reuse `pump`.
  **Knows nothing about HTTP.** Splits MCP connectivity (every chat) from board-tool extras
  (board chats only) at spawn-options time.

- **Adapters**: `Spawner` / `SpawnOptions` stay the interface. MCP URL + token are no longer
  omitted for plain chats. A sub spawn is a new `Spawn` with a distinct token on the same MCP
  URL. Steering: Claude disallowed native names on all app chats and spawn-family paragraph;
  Cursor isolated data-dir + Task hook on all app-spawned Cursor processes; Pi skip native
  `subagent` on all app chats, non-sequential spawn-family MCP tools, distinct bridge run.
  Per-caller **tokens**, not per-caller URLs. Board extras (whiteboard prompt, `<ui-context>`,
  Claude board-tool allow-list, Cursor board-tool auto-approve and first-message board body, Pi
  board-tool allow / board wording) stay gated on belonging to a board.

- **Web**: `isSubagentTool`, types/labels, `subModelLabel` keyed by the **sub’s** kind, and
  additive agent identity on the existing card chrome (reuse `AgentGlyph` and `agent-*` colour
  language in shared row/drawer chrome). **Only interprets existing events plus additive
  fields.** Not a UI overhaul.

Boundaries: `boardapi` knows nothing about processes, `chats` nothing about HTTP, the web tier
only interprets existing events plus additive fields.

## 5. Operations and flows

**Spawn.** Trigger: chat-agent `tools/call` of `spawn_subagent` on `POST /mcp` with the chat
Bearer token (board or plain). Outcome: caller resolved as chat agent; arguments validated (D4);
a sid and extra token are issued; the oldest matching unclaimed spawn item in the chat thread is
claimed (or a pending link is recorded); a process is started through the requested kind's
spawner with a fresh session, chat cwd, resolved model/effort, and the extra token in that
process's MCP header; the sub is flagged background; a receipt naming the sid returns
immediately. The window may be closed. A plain chat has no board and needs no browser client. A
subagent token, unknown token, archived/legacy chat, or invalid input returns `isError` text and
starts nothing.

**Wait.** Trigger: chat-agent `tools/call` of `wait_subagents`. Outcome: blocks up to the measured
interval; returns per-subagent status and report, or current status on timeout; repeatable;
timeout 0 polls. Does not go through the board bridge. Subagent callers are rejected.

**Stop (tool).** Trigger: chat-agent `tools/call` of `stop_subagent`. Outcome: that run is
terminated, extra token revoked, status stopped, receipt returned. Subagent callers are rejected.

**Parallel calls.** Several spawn POSTs from the chat agent overlap. Each is its own handler
goroutine. The chat lock is taken only for short claim/create/persist steps, so siblings do not
serialize on it. No app-imposed cap. Pi spawn-family tools are non-sequential so one assistant
batch can issue several spawns (D2).

**Lifecycle.** Stop / interrupt / aborted turn / parent exit / archive / board delete / chat
delete / shutdown: app-spawned processes are terminated, unanswered sub permissions denied, extra
tokens revoked in bulk, state emitted stopped. Restart: in-memory extra tokens are gone;
`loadSubs` marks leftover running rows stopped. Normal turn end: app-spawned subs keep running.

**Failure.** Missing spawner, missing folder, handshake failure: sub marked failed, tool text
returned, no orphan process. Process exit without a final status: stopped/failed with the reason.
Unknown, revoked, or final sids on wait/stop: tool text. Chat deleted during an unlinked spawn:
sub cancelled.

**Permissions.** A Claude or Cursor sub's ask becomes a parent-transcript permission item with the
sid; `Decide` routes to that process. Pi subs follow the Pi adapter (no cards). Authorized board
MCP from a board-parent sub is auto-allowed the same way as from the chat, and still hits the
parent board.

**Token issue / revoke.** Chat token: minted for every chat at create (and for already-persisted
tokenless chats before they speak MCP). Extra token: issue at spawn, in memory only, unique among
live chat tokens and extra tokens. Placed only in that process's MCP header. Revoke on that sub's
end/stop, and in bulk on chat stop/delete/shutdown. Revoked or unknown credentials: `tools/call`
tool text, never HTTP 401; `tools/list` empty.

**Depth-1.** Subagent tokens never see spawn-family on `tools/list`. Any spawn-family `tools/call`
from them is `isError` and starts nothing, before claiming. Claude child `--allowedTools` omits
the family. Pi app-chat processes (parent and app-spawned children) do not register native
`subagent`.

**Handshake `tools/list`.** Missing/unknown/revoked token → empty. Live chat-agent token → spawn
family, plus board tools only if that chat belongs to a board. Live subagent token → board tools
only if the parent belongs to a board, otherwise empty.

## 6. How to build it

### Prerequisites

- Unified MCP is landed: `POST http://localhost:6006/mcp`, Bearer identity, no command endpoint.
  Do not reopen that work.
- Native subagent UI and `subagents.go` helpers already exist; this feature feeds them.

### Phases

1. **Runner and manager integration.** Per-sub process, event loop, transcript, persistence
   (including agent kind and effort on the subagent), stop/kill hookup, permission routing by
   sid, Pi distinct bridge run / session directory. Verified by Go unit tests with existing
   fakes. No MCP dependency. Must be able to spawn Claude, Cursor, or Pi via `Spawners[kind]`.

2. **Contract.** Tool definitions; per-chat and per-caller `tools/list` / `tools/call` from the
   Bearer token (empty list for missing/unknown/revoked; matrix in §2 for live tokens); relay
   name-based routing (spawn-family not through `Relay.Call`); token minting for every chat;
   extra-token issue/revoke and caller resolution (including sub board calls resolving to the
   parent board); spawn defaults/validation; depth-1 rejection; claim and delayed reconciliation.
   MCP connectivity on every chat process, split from board-tool extras. Depends on Phase 1.

   Phase inputs, not design forks: (i) measure Claude, Cursor, and Pi MCP tool-call timeouts
   against the fixed URL (old Q1) — the result only sizes the `wait_subagents` interval, with
   adapter override env if one exists; (ii) capture a real `tools/call` from each CLI and record
   whether the JSON-RPC id or `_meta` carries a stable tool-use mapping — claiming stays FIFO on
   canonical arguments either way.

3. **Steering.** Claude: disallowed native names on **all** app chats + spawn-family paragraph
   (whiteboard body still board-only). Cursor: isolated `CURSOR_DATA_DIR` + `preToolUse` Task
   hook on **all** app-spawned Cursor processes (board and plain, parent and child), plus the
   shared prompt paragraph on board chats only. Pi: do not register native `subagent` on app
   chats; register spawn-family MCP tools without sequential execution. Covers native tools only;
   hiding the spawn family from subagent processes is Phase 2. Independent of 1–2 in prompt/hook
   work; required for “instead of native” acceptance.

4. **Web.** Name recognition (`mcp__board__spawn_subagent`), additive kind/effort fields,
   wait/stop labels, `subModelLabel` using the sub's own kind, agent identity on shared
   row/drawer chrome (existing glyph + colour + display name; not a new visual system). Depends
   on the frozen tool name and additive fields from Phase 2; can run alongside Phase 3.

5. **End-to-end.** Fake-CLI boardapi flows, then real-CLI e2e and regression (board tools still
   board-only, Claude/Cursor/Pi **plain** MCP spawn with no board tools in `tools/list`,
   Claude/Cursor/Pi **board** spawn seeing both, window-closed / no-client spawn, Cursor Task
   refused on board **and** plain app chats, Pi native `subagent` absent on board **and** plain
   app chats). Depends on all. Native-subagent e2e that assumed Task/Agent/`subagent` on app
   chats is updated to the MCP spawn family, not preserved as an escape hatch.

### Verification approach

- **Manager/runner unit tests** with existing fakes (`fakeAgent` / `fakeSpawner`, SSE recorder): a
  new fake sub spawner returns scripted agents per call; assert sub creation, transcript items,
  persistence, emissions, kill-on-stop without real CLIs; assert agent kind and effort are
  persisted and emitted on the sub; assert extra-token issue/revoke and that a subagent's board
  calls resolve to the parent chat's board; assert a subagent caller's spawn-family call is
  rejected and starts nothing; assert Pi spawn does not retire the parent
  bridge run; assert every chat (plain included) has a persisted token.

- **boardapi harness** (real Manager + Bridge + Relay over `httptest`, `POST /mcp` + Bearer):
  update the hard-coded 7-tool and “garbage Bearer still lists board tools” expectations; assert
  the matrix in §2; missing/unknown/revoked token `tools/list` is **empty** and does not
  advertise spawn family or board tools; spawn with no client succeeds (plain and board);
  spawn returns immediately with a sid receipt; `wait_subagents` returns the report on
  completion and current status on timeout, including repeated waits and timeout 0; spawn schema
  has no `background` parameter; two byte-equal parallel spawns from the chat agent claimed FIFO
  with each receipt returned to its own call, plus the documented pairing residual and the
  distinct-description mitigation; a direct `tools/call` on the spawn family with a subagent
  token returns `isError` text and starts nothing; delayed reconciliation; validation failures as
  `isError`; unknown/revoked token; unknown tool; spawn-family does not hit the 30 s bridge /
  `NoClientText`; no app-imposed concurrency cap.

- **Claude adapter:** disallowed native names on all app chats; MCP config present on plain and
  board; allow-list includes spawn family and excludes board tools on a plain chat agent;
  board chat agent includes both; sub process excludes spawn family (and board tools if the
  parent is plain); timeout env if found; captured real `tools/call`; timeout measurement;
  fake-CLI spawn round-trip.

- **Cursor adapter:** MCP `mcpServers` present on plain and board; normalize still maps
  spawn-family names to `mcp__board__*` whenever the app server is attached; board-tool
  auto-approve still board-only; spawn-family auto-approved on every app-spawned Cursor process;
  isolated `CURSOR_DATA_DIR` is set for all app-spawned Cursor processes (not only board);
  hook file exists for the cwd slug with `^Task$` and `failClosed`; a scripted ACP run with the
  hook produces no native sub event on board **and** plain; a spawn-family MCP call from a
  subagent token is rejected in the relay, not the Cursor adapter.

- **Pi adapter / extension:** app chats do not register `subagent`; spawn-family MCP tools are
  not sequential; `AIWB_MCP_CONFIG` is set on plain and board; app-spawned child receives its own
  config (not the parent's token); distinct bridge run; board wording / board-tool allow stay
  board-only; captured real `tools/call`; timeout measurement.

- **Web logic tests:** `isSubagentTool` (Agent, Task, and `mcp__board__spawn_subagent`),
  `subagentOf` linked/unlinked (unlinked still has no kind), kind present on the linked card
  path, `subModelLabel` using the **sub’s** kind with a **cross-agent parent** and no-catalog
  fallback; labels for wait/stop. No new visual snapshots of the card.

- **E2E** (not in `npm test`): plain-chat async spawn/wait/parallel for each agent with no board
  tools in `tools/list`; board-chat async spawn/wait/parallel for each agent seeing both
  surfaces; window-closed / no-client spawn; Cursor board **and** plain asked to delegate do not
  create a native Task sub; Pi board **and** plain have no native `subagent` tool card; linked
  card shows the sub’s agent; no orphan processes after Stop. No new visual snapshots.

- **Persistence:** reload an app-spawned subagent from `subagent.json` (agent kind and effort
  survive; unknown extras would not); restart marks it stopped; extra tokens do not survive;
  plain chats persist a token.

Tests that today freeze “no MCP / no token on plain chats” are **updated, not preserved**. Named
from `plans/mcp-subagents-refresh/mcp-all-chats.md` §7:

- `internal/chats/manager_test.go:489–490` — plain `chat.json` has empty Token
- `internal/claude/args_test.go:31–36` — plain Claude argv has no `--mcp-config` /
  `--append-system-prompt` / `--allowedTools` (whiteboard `--append-system-prompt` stays absent
  on plain; `--mcp-config` and a spawn-family allow-list do not)
- `internal/cursor/cursor_test.go:261`, `:453`, `:901` — non-board `mcpServers` is `[]`
- `internal/pi/args_test.go:190–193` — plain env has no `AIWB_MCP_CONFIG`
- `internal/pi/pi_test.go:250–259` — `TestSpawnPlainChatNoMCPConfig`
- `internal/pibridge/extension_boot_test.go:896–921` — plain app-run Pi: only `subagent`, no
  `mcp__*`, wording must not promise board tools (native `subagent` goes away; spawn-family
  `mcp__*` appear; board wording stays off)
- `internal/boardapi/mcp_fixed_test.go:43–61` — `tools/list` is permissive **and returns the full
  global list** even with a garbage Bearer (handshake stays permissive; the list becomes
  **empty**)
- `internal/boardapi/boardapi_test.go:162–178` — `tools/list` length 7 = `boardtools.Tools`
  (listing is no longer that global slice)

Related comments/docs that state Token ≡ board chat or MCP config ≡ `Board != nil` also change
(`internal/agent/agent.go` BoardAccess nil-for-plain, `internal/agent/bridge.go` “board chats
only”, `internal/chats/manager.go` MCPURL / `ByToken` comments, README). Plain Send still drops
board `<ui-context>` (`internal/chats/manager_test.go:823–827`) — that freeze stays; it is a
board extra.

## 7. References

Verified facts at HEAD `b15640a`. Line numbers are current files, taken from the refresh research
and spot-checked. Assumptions and unresolved items are in §8, not below.

**MCP endpoint and identity**

- Fixed URL `http://localhost:6006/mcp`: `internal/boardapi/endpoint.go:9–11`.
- Only MCP route is `POST /mcp` on the 6006 listener: `internal/server/server.go:179–186`.
- Bearer identity: `internal/boardapi/mcp.go:178–186, 188–195`; `internal/agent/agent.go:25–28`.
- `tools/list` is global (ignores token): `internal/boardapi/mcp.go:165–176, 227–228`.
- `tools/call` params are `name` + `arguments` only; JSON-RPC `id` is envelope-only:
  `internal/boardapi/mcp.go:157–161, 229–235`.
- `Relay.Call` always goes to `Bridge.Call` with 30 s timeout / immediate `NoClientText`:
  `internal/boardapi/mcp.go:23–28, 51–80`.
- Tool failures are HTTP 200 + `isError`, not HTTP 401: `internal/boardapi/mcp.go:51–55, 229–240`.
- `initialize` / `tools/list` succeed without a token: `internal/boardapi/mcp.go:211–228`.
- No `/mcp/{token}`, no `/agent/{token}/{tool}`, no `command.go`:
  `plans/mcp-subagents-refresh/mcp-architecture.md` §1.

**Tokens, spawn options, board vs plain** (all-chats delta: `mcp-all-chats.md`)

- Chat token minted at create **only when `board != ""`**, persisted, not rotated:
  `internal/chats/manager.go:364–370`; `internal/model/model.go:204`.
- `ByToken` matches only `ChatMeta.Token`, does **not** check `Board`, returns no sid:
  `internal/chats/manager.go:1007–1021`.
- `spawnOptions` hands URL + token only when `c.meta.Board != ""`:
  `internal/chats/manager.go:470–479`; tests `internal/chats/manager_test.go:840–914`.
- `BoardAccess` comment: token never a URL segment; pointer nil for plain chats:
  `internal/agent/agent.go:22–28`.
- Association is create-time only; no setter for `meta.Board`:
  `internal/chats/manager.go:343–370`; `plans/mcp-subagents-refresh/mcp-all-chats.md` §1.
- Plain create currently has empty Token: `internal/chats/manager_test.go:489–490`.

**Native subagent machinery (reuse vs not)**

- `pump` writes chat-level session/usage/catalog/turn state: `internal/chats/manager.go:484–562`.
- `routeSub` / `link` / `endSub` / `stopSubs` / `loadSubs`: `internal/chats/subagents.go`.
- `stopSubs` is state-only: `internal/chats/subagents.go:190–197`.
- `loadSubs` rewrites running → stopped: `internal/chats/subagents.go:56–59`.
- `Decide` answers only `c.ag`: `internal/chats/manager.go:870–893`.
- Normal turn end does not `stopSubs`; abort/exit do: `internal/chats/manager.go:538–541`.
- `Send` unlocks before `ag.Send`: unlock `internal/chats/manager.go:631`, send `:644`.
- Lock-ordering (no editor-bridge lock under a chat lock): `internal/chats/manager.go:89–91`.
- No app-spawned MCP sub runner today: `plans/mcp-subagents-refresh/subagent-machinery.md` §9.

**Adapters**

- Claude `--disallowedTools` is only app-dir rules; Task/Agent not disallowed:
  `internal/claude/claude.go:72`; `--allowedTools` is every `boardtools.Tools` name, only when
  `o.Board != nil`: `internal/claude/claude.go:73–81`; `--mcp-config` header object:
  `internal/claude/claude.go:84–108`. Plain Claude has none of those three:
  `internal/claude/args_test.go:31–36`.
- Cursor `mcpServers` headers array: `internal/cursor/cursor.go:262–277`; process env unchanged
  (no `CURSOR_DATA_DIR`): `internal/cursor/acp.go:47–66`; board MCP auto-approve:
  `internal/cursor/cursor.go:807–821`; Task → card name `"Agent"`:
  `internal/cursor/cursor.go:688–691`. Non-board `mcpServers` is `[]`:
  `internal/cursor/cursor_test.go:261`, `:453`, `:901`.
- Cursor Task deny recipe (not wired): `cursor-task-deny.md`; summary in
  `plans/mcp-subagents-refresh/adapters.md` §2 Q2.
- Pi `AIWB_MCP_CONFIG` same JSON as Claude: `internal/pi/args.go:92–127, 147–148`. Plain env has
  none: `internal/pi/args_test.go:190–193`; `internal/pi/pi_test.go:250–259`.
- Pi native `subagent` registered when the bridge is present; no sequential mode:
  `internal/pibridge/extension/index.ts:193–248`. MCP tools are sequential:
  `internal/pibridge/extension/index.ts:164–165`. Plain app-run Pi is exactly `subagent`, no
  `mcp__*`: `internal/pibridge/extension_boot_test.go:896–921`.
- Native Pi children inherit `AIWB_MCP_CONFIG`:
  `internal/pibridge/extension/subagent.ts:161–179`.
- `RegisterRun` of the same chat id retires the previous run:
  `internal/pibridge/bridge.go:188–211`.
- Prompts do not list tools and do not steer off native spawn: `internal/prompts/prompts.go:19–30`.
- Cursor first board message is `prompts.Claude()`, not curl:
  `internal/chats/manager.go:604–608`.
- `Configure` validation (unknown model error, effort not offered, nil catalog accepts):
  `internal/chats/manager.go:647–728, 747–755`.
- Board extras vs MCP connectivity, and the §7 freeze list:
  `plans/mcp-subagents-refresh/mcp-all-chats.md` §§3–7.

**Web** (card identity facts: `plans/mcp-subagents-refresh/subagent-card-ui.md`)

- `isSubagentTool` is Agent/Task only: `web/src/logic/subagents.ts:9–11`.
- Unlinked row has no model, no background, no agent kind; drawer needs `sa.id`:
  `web/src/logic/subagents.ts:18–34`; `web/src/Subagents.tsx:82`.
- `subModelLabel` branches on the **parent** chat agent today; both row and drawer pass
  `chat.agent` / `catalogs[chat.agent]`: `web/src/logic/subagents.ts:80–107`;
  `web/src/Subagents.tsx:78, 90, 118, 164`.
- `model.Subagent` has no agent kind and no effort; `agentId` is a session/task id, `type` is
  subagent_type not Claude/Cursor/Pi; unknown JSON extras are dropped on `saveSub` rewrite:
  `internal/model/model.go:347–369`; `web/src/types.ts:211–231`; `subagent-card-ui.md` §§2, 5.
- Card chrome has no `AgentGlyph`, no `agent-*` class, no `--claude` / `--cursor` / `--pi`:
  `web/src/Subagents.tsx:74–92`; `web/src/styles.css:260–285`.
- Existing agent visual language (`AgentGlyph`, `agent-*`, `--claude` / `--cursor` / `--pi`):
  `web/src/agents.ts`; `web/src/icons.tsx:10–35`; sidebar/header as in `subagent-card-ui.md` §3.
- Drawer reuses `SubMark` / `SubName` / `SubStats`; a row-JSX-only change would miss the drawer
  header: `web/src/Subagents.tsx:106–173`; `subagent-card-ui.md` §4.
- Native e2e: Claude step 18 `web/e2e/app.e2e.mjs:861`; Cursor step 19 `:933`. Neither asserts
  glyph or agent name on the card.

**MCP tool naming**

- `serverInfo.name` is `"board"` → Claude `mcp__board__<tool>`:
  `internal/boardapi/mcp.go:153–155, 225`.
- Cursor prefixes board MCP to `mcp__board__`: `internal/cursor/cursor.go:665–695`.

## 8. Assumptions and remaining open questions

Settled and not open: async spawn contract; no concurrency caps; depth exactly 1; extra tokens on
the fixed URL; `tools/list` must become per-chat and per-caller; handshake without a live token
lists **nothing**; spawn family on all chats; board tools still board-only; Cursor v1 uses the
isolated-data-dir Task hook on **all** app-spawned Cursor processes (parents and children); Pi
native `subagent` is replaced on all app chats; do not reuse `pump`; do not revive path tokens or
the command endpoint; no attach/detach.

**Assumptions** (explicit)

- Each agent process has its own MCP client connection, so a per-token `tools/list` computed at
  request time is the list that process sees. (Whether a client caches `tools/list` for the life
  of a connection is unverified; it would not matter if the process is born with the right token.)
- Adapters treat the MCP token as an opaque header value and will accept a different token per
  spawned process on the same URL. Not tested with two tokens for one chat.
- Claude `--disallowedTools` of an unknown name (`Task` vs `Agent` across CLI versions) is
  harmless; v1 disallows both.
- Cursor hook stability across CLI upgrades is sufficient for v1; the research ran on
  `2026.10.01-e373342`. If a later Cursor build stops honouring `CURSOR_DATA_DIR` project hooks,
  app Cursor chats fall back to instruction-only until the recipe is updated — that is a
  follow-up, not a v1 fork.
- Isolated `CURSOR_DATA_DIR` does not break login or model listing (research run 8), including
  when applied to plain app chats. `mcp-approvals.json` is not carried over; board-tool
  auto-approve in the adapter covers board tools on board chats; spawn-family auto-approve covers
  spawn on every app Cursor process.
- Pi permission cards stay absent for app-spawned Pi subs, matching today's Pi adapter.
- Token minting stays `randHex` without a uniqueness check against persisted chat tokens; extra
  tokens must still not collide with a live chat token in the in-memory registry (practical
  collision risk is treated as negligible, same as today's chat tokens).
- Claude `--allowedTools` as exclusive vs additive is still unverified in this tree. v1 still
  sets the intended list (spawn family on every Claude chat agent; board-tool names only on
  board chat agents; spawn family omitted on Claude sub processes). List filter + hard reject
  remain the depth-1 guarantee if the parent-vs-child split lags.
- Already-persisted plain chats with an empty token are given one before they speak MCP; new
  creates always mint. Exact load-vs-first-spawn timing is left to implementation.
- Native Claude/Cursor/Pi subs at HEAD are the same kind as the parent chat, so today’s
  `subModelLabel` keyed on the parent is not wrong for native rows (assumption in
  `subagent-card-ui.md`). MCP spawn can differ; the card therefore cannot use the parent as a
  stand-in for kind.

**Still actually open** (Phase 2 measurements, not product forks)

- **Q1.** Exact Claude / Cursor / Pi MCP tool-call timeouts and any override env. The result only
  sizes the `wait_subagents` interval.
- **Q3 (narrow).** Confirm that disallowing both `Task` and `Agent` on Claude is harmless on the
  bundled CLI, and confirm the live Claude `tool_use` name.
- **Q4.** Delayed-reconciliation window against real CLIs; widen if the tool-use vs POST race is
  longer than the brief retry.
- Whether a captured `tools/call` carries a stable tool-use mapping in JSON-RPC `id` or `_meta`.
  Claiming does not depend on it.

Not open: old Q2 (Cursor scoped deny). Answered; v1 uses it on all app-spawned Cursor processes
(board and plain, parent and child) (D5). Handshake-without-token listing is empty, not
board-tools-only (D1).
