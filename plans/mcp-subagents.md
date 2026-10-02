# MCP Subagents — Implementation Plan

Status: draft, revised after review. Scope: board chats only. No implementation code; this document
fixes decisions and integration points so implementation can proceed without re-deriving them.

## 1. Goal and scope

Board-chat agents get board MCP tools that spawn subagents **server-side through the app's own
adapters**, replacing native spawning. On Claude this replacement is deterministic: native
`Task`/`Agent` are disallowed (D5). On Cursor it is instruction-steered and therefore a goal, not a
guarantee, until Cursor offers a scoped native-tool deny (D5, Q2). A spawned subagent must be
indistinguishable in the existing UI from a native one: a row in the parent thread, a drawer with
its live thread and report, status, duration and context meter. App-spawned subagents run
asynchronously and in parallel; results are collected with `wait_subagents`.

In scope: the board MCP surface (`/mcp/<token>`, Claude), the command surface
(`/agent/<token>/<tool>`, Cursor), a server-side subagent runner, per-caller caller identity,
defaults/validation, steering away from native spawning, minimal web changes, lifecycle
integration. Out of scope: plain chats (no MCP there; native subagents stay), a UI overhaul,
per-subagent stop buttons, MCP push/progress.

## 2. Requirements and acceptance criteria

Functional: (a) `spawn_subagent` takes a prompt plus optional description, agent, model, effort —
no `background` parameter; (b) spawn always returns immediately with a receipt naming the sid and
never blocks for the subagent's completion, and results are retrieved exclusively with
`wait_subagents`, which blocks up to a measured interval, returns per-subagent status and report,
and can be called repeatedly (on timeout it returns current status); (c) parallel spawns do not
serialize on the chat lock; (d) rendering/lifecycle events identical to native subagents;
(e) chat stop/interrupt/archive/delete and shutdown terminate app-spawned processes, restart marks
them stopped, a normal turn end leaves app-spawned subagents running; (f) omitted agent = the
chat's kind, omitted model/effort = the chat's current values, explicit values validated like
`Configure` against the **requested** agent's catalog (D4); (g) errors are tool text with `isError`,
never HTTP errors; (h) spawn works with the window closed (board tool calls still need it); (i) only
the chat agent may spawn — subagent callers never receive the spawn-family tool definitions and any
spawn-family call from them is rejected with tool text (`isError` / `ERROR: `), starting nothing.

Acceptance: a board-chat agent (Claude via MCP, Cursor via the command path) can spawn subagents,
each spawn returning a receipt naming its sid while the run continues asynchronously, and can
retrieve results with `wait_subagents` — the report on completion, current status on timeout, and
repeated waits as needed; this applies in every case, and the measured CLI limit only bounds how
long one `wait_subagents` call may block (D1). It can spawn several subagents in one turn in
parallel with no app-imposed concurrency limit (D2); the UI shows rows/drawer/status/timers/token
meter exactly as for native subagents; Stop leaves no orphan processes; existing board/tool/UI tests
still pass. Cursor acceptance adds one observed real run in which a board chat asked to delegate
chooses the command path rather than native `Task` (Q2); until that is observed, "instead of
native" is guaranteed for Claude only and best-effort for Cursor.

## 3. Design decisions

### D1. Tool surface and API contract

Add three tools to `boardtools.Tools` (the shared list feeding Claude's MCP server, the Cursor
instructions and the command parser; `internal/boardtools/tools.go`, `internal/claude/claude.go:74-81`,
`internal/prompts/prompts.go`, `internal/boardtools/command.go:9-35`): **spawn_subagent**,
**wait_subagents**, **stop_subagent**. The spawn family is exposed only to the chat agent's caller
identity; `wait_subagents` and `stop_subagent` serve the chat agent's own subagents. MCP
`tools/list` is computed per caller/token, so subagent callers never see these definitions (D2).

`spawn_subagent` spawns one subagent per call — a required prompt, optional display description,
and the user's three knobs (agent, model, effort); there is no `background` parameter because every
app-spawned subagent is asynchronous. One subagent per call keeps tool-item correlation one-to-one
(D3); parallel work is several calls, which the HTTP server already handles concurrently (one
goroutine per POST).

Async contract:

- `spawn_subagent` starts the run and returns immediately with a receipt naming the sid (and the
  subagent's current status). It never blocks for completion, and the run is flagged as a
  background run in its state, so the UI never treats the receipt as a report (D2, D6).
- **`wait_subagents` is required** because MCP has no push channel: it takes one or more sids and
  an optional timeout, blocks until they finish or the timeout elapses, and returns per-subagent
  status and report; on timeout it returns current status, so it can be called repeatedly
  (timeout 0 = status poll). The binding limit is the CLI's own MCP tool-call timeout — the server
  can only block as long as the CLI keeps the call alive — so the wait interval (the server's
  blocking budget for one call) is derived from the measured limit with margin. Waits are short and
  repeatable: an agent retrieves a result by waiting as many times as it needs.
- If Phase 2 finds an override environment for the CLI timeout, the adapters set it for board-chat
  processes so the wait interval fits inside the CLI limit; the interval is derived from the
  measurement, not guessed.
- **`stop_subagent` is included** (unchanged from the earlier design): it lets an agent cancel a
  runaway job; without an agent-visible cancel, background spawning would be a trap.

Routing: spawn/wait/stop must not go through `Relay.Call`/`Bridge.Call` (that would return
`NoClientText` and add the 30 s board timeout; `internal/boardapi/mcp.go:20-63`). The relay resolves
the caller from the token first (D3); board tools keep the existing bridge path unchanged,
subagent tools go to the new server-side path. MCP and the command endpoint share routing, caller
resolution and error formatting (MCP text + `isError`; command text prefixed `ERROR: `).

### D2. Execution model

One independent agent process per spawned subagent, through the existing
`agent.Spawner`/`SpawnOptions` (`internal/agent/agent.go:18-41`) with a fresh session (not a
resume), the chat's cwd, resolved model/effort, and **its own per-caller board token** issued for
that run, mapped to (chat, subagent sid) and marking the caller as a subagent; board tool calls
from the subagent still resolve to the parent chat's board (D3). Each sub gets its own event loop,
transcript (same format/machinery as
chat and sub threads) and lifecycle. It must **not** reuse `pump`: `pump` is bound to `c.ag`/`c.gen`
and writes chat-level state (`EvSession`, `EvUsage`, `EvCatalog`, turn counting) into the parent
(`internal/chats/manager.go:481-560`). The runner applies events to the sub transcript, maps
session/usage/catalog to per-sub state or ignores them, and reuses the existing
persistence/emission helpers (`subagents.go`: flush/save/emit/link/end), so the client sees
identical `sub`/`sub_items` events.

Every app-spawned subagent is a background run: the runner sets the subagent's background flag at
creation, so the UI renders summary/last text and the existing background chip instead of mistaking
the spawn receipt for a report (D6).

`Chat.mu` is held only for short state transitions (create/patch/persist/link), never while waiting
on a process or tool call — precedent: `Send` calls `ag.Send` after unlocking (`manager.go:625-636`),
`ContextSplit` waits outside `c.mu` (`contextsplit.go:49-57,88-90`). Parallel tool calls are
separate handler goroutines. Since no process cap exists anywhere in `internal/`, enforcement is
explicit at the caller check (D7): the app imposes **no concurrency limit** — fan-out among
siblings from the chat agent is deliberately unlimited — and **nesting depth is fixed at 1**, so
only the chat agent may spawn subagents and a subagent process can never spawn another. The rule
has two independent layers: (a) **tool-surface visibility** — the spawn family is not defined for
subagent callers (MCP `tools/list` computed per caller/token omits it; Cursor subagent
instructions omit the commands; Claude subagent `--allowedTools` excludes them), and (b) **hard
rejection** — if a spawn-family call nevertheless arrives from a subagent caller (hallucinated
name, stale instructions, crafted request), the server returns tool text with `isError` (MCP) or
`ERROR: ` text (command) and starts nothing; never an HTTP error. The per-caller token is the
identity that distinguishes chat from subagent callers (D3).

### D3. Caller identity, correlation and linking

The MCP and command requests carry only token, tool name and arguments — no caller id and, on the
code as read, no tool-use id (`internal/boardapi/mcp.go:144-150`). Caller identity is made
deterministic with per-caller tokens; Phase 2 confirms the "no tool-use id" assumption from a
captured real request before the correlation design closes (if the JSON-RPC id or `_meta` turns out
to carry a stable tool-use mapping, it can disambiguate the residual below; the design works either
way).

Tokens:

- The chat process keeps the chat's persisted token. At each subagent spawn the manager issues a
  fresh per-caller token for that run, held in memory and mapped to (chat, caller sid); it serves
  board access and caller identification. A lookup yields chat, caller sid (empty for the chat
  agent), whether the caller is the chat agent or a subagent, and
  the caller's kind/model/effort, so D4's defaults come from the token, never from the claimed
  item; the same identity filters the caller's tool list and rejects spawn-family calls from
  subagents (D2).
- The token is revoked when that subagent ends or is stopped and, in bulk, on chat
  stop/delete/shutdown. A call on a revoked or unknown token gets tool text errors. Restart needs
  nothing new: per-caller tokens live only in memory so none survives, and `loadSubs` already
  rewrites running subagents to stopped.
- Board tool calls from a subagent use that subagent's token and still go to the parent chat's
  board; a subagent caller is rejected before any claiming (D2), so a subagent can read and draw
  but never spawn.

Linking:

- On a spawn call, claim the **oldest pending, unclaimed tool item in the chat's own thread** —
  only the chat's thread ever issues spawn calls, so that is where claiming happens — whose name is
  the spawn tool and whose arguments canonically equal the request (JSON normalized), under `c.mu`
  so parallel calls claim distinct items. The claim yields the tool item id; parent and defaults
  never come from it, so mis-binding to another caller's thread is impossible by construction.
- The model's `tool_use` event and the POST race, so the item may not exist yet. The handler
  retries briefly; if still missing, it spawns unlinked and records a pending link, then a
  reconciliation pass on later transcript updates of the chat's thread re-attempts FIFO matching
  by canonical arguments. If a match never appears (item removed by Stop, chat deleted), the
  subagent still runs and its receipt is returned to the call; the caller's tool item renders as an
  unlinked row built from the item itself (`isSubagentTool` + `subagentOf`,
  `web/src/logic/subagents.ts:9-36`) with no subagent state, and it cannot open the drawer (opening
  requires the linked sid, `web/src/Subagents.tsx:76-82`). Log it; cancel the subagent if the chat
  was deleted.
- The link sets `Subagent.Tool` to the matched item's toolId in the same locked step. No client
  fallback is added: the server guarantees the link, and a second open path would risk drift.
  Cursor uses the identical strategy; its `toolCallId` never reaches the command handler.

Residual (accepted, not harmless): only the chat's thread ever spawns, so claims cannot cross
threads, but two parallel spawn calls from the **chat agent with byte-equal arguments** remain
indistinguishable to the claim; claims stay FIFO among equal candidates. With asynchronous spawns,
each receipt carries its own sid and each tool result still belongs to its originating call; for
byte-equal siblings the model-side results are interchangeable because the requests were identical,
so the only residual is that the UI pairing of row/drawer to sid may swap, and a row/drawer can show
the other run's thread and report. The spawn tool description asks callers to give parallel spawns
distinct descriptions, which makes the arguments distinct and matching deterministic; §6 verifies
both the residual and that mitigation.

### D4. Defaults and validation

Omitted agent = the chat's kind (the chat is the only legal spawner, D2; the user's "same agent
type unless requested otherwise"); caller and kind come from the token (D3), not from the claimed
item. Omitted model/effort = the chat's current model/effort: the composer metaphor is the user's
most recent choice for this work, while
`defaults.Resolve` is for creating chats, not spawning inside one. This needs one additive
persisted field, the subagent's agent kind (plus effort, needed by the UI, D6); caller identity
itself is never persisted (token registry, D3).

Validation always uses the **requested** agent's catalog, not the caller's, so a cross-agent spawn
is checked against the kind it actually runs. Values inherited from the chat that do not fit the
requested kind (a different kind does not share model ids) and chat values that fail their own
catalog
validation (possible after a Cursor catalog refresh) both fall back using new-chat resolution rules
for the requested kind (model default, default effort). Explicit values are validated like
`Configure`: unknown model is an error; an effort the model does not offer is an error; a model
change resolves a stale effort the same way (`internal/chats/manager.go:641-746`). Invalid input
returns text with no process started. A nil Cursor catalog accepts values unvalidated, exactly like
`Configure`; a wrong model then shows up as a subagent handshake failure in its status/error. All
errors stay tool text (D1).

### D5. Steering away from native spawning

Claude board chats: add the native subagent tool names (`Task` and `Agent`, to cover CLI versions)
to the existing app-owned `--disallowedTools` list (`internal/claude/claude.go:73`), and add a
short paragraph about the board spawn tools to the appended whiteboard prompt (app-owned,
`--append-system-prompt`); that paragraph says spawning is asynchronous and that results come from
`wait_subagents` when the agent needs them. A deterministic disallow fits the user's explicit
intent better than an instruction alone. Trade-off: board chats lose Claude's native Agent/Task,
including custom agents; plain chats are unaffected and remain the escape hatch.

Cursor board chats: ACP has no per-session tool configuration and the app's permission writes are
user-global (`internal/cursor/config.go:27-91`), so a `Task` deny would affect all Cursor usage.
Decision: v1 steers by instruction only — the app-owned `CursorInstructions` tells the agent to use
the board spawn command, not native Task, and that spawn returns a receipt while results come from
the wait command. Unlike Claude's disallow, this cannot guarantee behavior: a Cursor agent may
still choose native Task, so "instead of native" is best-effort for Cursor until it is observed
and a deny rule exists. §6 adds a real-run step checking that a Cursor board chat
asked to delegate chooses the command path; if it does not, the goal is qualified to Claude (Q2).
Revisit a deny rule if Cursor gains scoped permissions (Q2). The board command path is already
auto-allowed, so it is the path of least resistance.

Steering above concerns native tools only. Independently of it, subagent processes are given a
tool surface without the spawn family: MCP `tools/list` omits it for their tokens and Claude
subagent `--allowedTools` excludes it; that part is mechanical, not prompt-based, so it does not
rely on the subagent obeying instructions. Cursor's layer is weaker: subagent instructions simply
do not list the spawn commands, which is instruction-only visibility, so Cursor's actual guarantee
is the command-handler rejection (D2), not the omission. That rejection path covers any
spawn-family call that arrives from a subagent caller on either adapter (D1/D2/D3).

### D6. UI parity

Required client changes are small. (1) `isSubagentTool` must recognize the spawn tool's item name
(`mcp__board__spawn_subagent`) in addition to `Agent`/`Task` (`web/src/logic/subagents.ts:9-10`);
it is the only entry point to row rendering, so without it the feature is invisible. (2) The
optional new subagent fields (agent kind, effort) are mirrored in `web/src/types.ts`; field
additions are safe and SSE shapes do not change. (3) `subModelLabel` uses the subagent's own agent
kind and effort, so cross-kind spawns show the right catalog/effort instead of the parent's catalog
or a raw id; when the web has no catalog for that kind (e.g. Cursor never probed), the label falls
back to the raw model id, as it already does for unknown ids. Add plain labels for wait/stop tool
cards. Every app-spawned subagent carries the background flag (D2), so `subReport` uses
summary/last text and never the spawn receipt, and the existing background chip shows; no new
client logic is needed for this. Nothing else changes: store keys/`subKey`, `conn.ts`, drawer,
`subagentOf`/`subReport`/`showReport`/`subList`, background chip, timers, ctx meter, permission
labelling, no sidebar entry, no per-sub stop UI. The row opens only from `Item.subagent`, so D3's
link is the functional prerequisite.

### D7. Lifecycle, failure and safety integration

Today `stopSubs` only marks state (`internal/chats/subagents.go:190-198`) and `Stop` closes only
`c.ag` (`manager.go:933-938`). The runner must terminate processes when the chat lifecycle ends:
stop/interrupt, aborted turn, parent `EvExit`, archive/board delete, chat delete, shutdown. State
is finalized and emitted immediately under `c.mu`, while the process close happens asynchronously
outside the lock — Claude's graceful close kills after 3 s, and holding the lock across that would
stall the pump and API reads (the repo's lock-ordering rule: the bridge lock is never taken under a
chat lock, `manager.go:88-89`, `internal/editorbridge/bridge.go:66-68`). A normal turn end keeps
app-spawned subagents alive, matching the existing native rule (`manager.go:531-538`).

Permissions: subagents run with the chat's permission mode; their requests become permission items
in the parent transcript carrying the sid (existing "Asked by subagent" UI) and must be answerable.
`Manager.Decide` currently answers only `c.ag` (`manager.go:858-874`); extend it to route by sid to
the sub process, and extend Stop/stopSubs to deny unanswered sub permissions. With no client
attached, a request simply waits. Restart needs no new work: `loadSubs` rewrites running to stopped
and shutdown kills process groups.

Failure handling: spawn errors (no spawner, missing folder, handshake failure) fail the subagent
with `Error` set and return the text; an exit without final status is marked stopped/failed with
the reason; wait timeouts return current status; unknown/final sids return text. Nesting is not
supported: depth is fixed at 1 (D2), so a subagent caller is rejected and has no spawn-family
tools. Subagents
still get board access — they can read and draw — but not the spawn family, so using it is
impossible by construction and the rejection is defense in depth. Each sub gets its own per-caller
token, which identifies it as a subagent and routes its board calls to the parent chat's board
(D3/D4).

### D8. Cursor parity

Because the new tools live in `boardtools.Tools`, they are automatically served at
`POST /agent/<token>/<tool>` (`internal/server/server.go:602`), accepted by the command parser,
auto-allowed without a permission card, and listed in the Cursor instructions for the chat agent;
subagent instructions omit the spawn commands and the command handler rejects spawn-family calls
from a subagent token (D2). The command path must route spawn/wait/stop to the subagent service
instead of `Bridge.Call`, keep the always-200
text/plain contract and `ERROR: ` prefix (`internal/boardapi/command.go`), and share the
correlation/reconciliation logic and per-caller token resolution (D3). The command path is
asynchronous exactly like MCP (D1): the spawn command returns a receipt naming the sid without
waiting for completion, and results come from the wait command. Cursor model/effort
semantics are preserved (base id plus validated effort, stored in the new subagent fields so the
drawer can show effort); subagent processes use the Cursor spawner with a fresh session and the
board command instructions.

## 4. Components and responsibilities

- `boardtools`: tool definitions — one source for MCP listing, Claude allowed list, Cursor
  instructions and command parsing, with spawn-family visibility filtered per caller identity.
- `boardapi` relay: token/caller resolution, name-based routing (board → bridge, subagent →
  runner), endpoint contracts and text error formatting.
- `chats.Manager` + subagent runner: per-caller token registry and ownership, defaults/validation,
  item claim and reconciliation, one process/loop/transcript per sub, persistence,
  stop/interrupt, permission routing, depth-1 enforcement (rejection of subagent callers) and
  per-caller tool-surface filtering.
- Adapters: unchanged interfaces; steering changes in Claude args and both prompts; per-caller
  board URLs passed through spawn options.
- Web: `isSubagentTool` and types/labels additions only.
- Boundaries: `boardapi` knows nothing about processes, `chats` nothing about HTTP, the web tier
  only interprets existing events plus additive fields.

## 5. Build phases and dependencies

1. **Runner and manager integration** — per-sub process/event loop/transcript/persistence,
   stop/kill hookup, permission routing. Verified by Go unit tests. No dependencies.
2. **Contract** — tool definitions and per-caller tool-list/instruction filtering, relay routing,
   per-caller token issue/revoke and caller resolution, spawn defaults/validation, the depth-1
   rejection path for subagent callers, claim and delayed reconciliation for MCP and commands.
   Depends on Phase 1. The CLI MCP timeout measurement and the captured real `tools/call` (D3) are
   part of this phase; the measurement derives the `wait_subagents` interval (D1) and confirms that
   waits can be repeated inside the CLI limit. It no longer selects a design default.
3. **Steering** — Claude disallowed native names + prompt paragraph; Cursor instruction wording.
   Covers native tools only; hiding the spawn family from subagent processes is Phase 2. Independent
   of 1–2; required for Claude's "instead of native" acceptance, and it sets up the §6 observation
   that must confirm Cursor actually chooses the command path (Q2).
4. **Web** — name recognition, optional fields, labels. Depends on the frozen tool name (this plan)
   and additive fields from Phase 2; can run alongside Phase 3.
5. **End-to-end** — fake-CLI boardapi flows, then real-CLI e2e and regression (native subagent e2e,
   board tools, plain chats, Cursor command-path choice). Depends on all.

## 6. Verification approach

- **Manager/runner unit tests** with existing fakes (`manager_test.go`: fake agent/spawner, `syncEv`
  barrier, SSE recorder, `subStart`/`subRun`): a new fake sub spawner returns scripted agents per
  call; assert sub creation, transcript items, persistence, emissions, kill-on-stop without
  real CLIs; assert per-caller token issue/revoke and that a subagent's board calls resolve to the
  parent chat's board; assert a subagent caller's spawn-family call is rejected and starts nothing.
- **boardapi harness** (real Manager+Bridge+Relay over `httptest`, currently without Spawners): wire
  a fake spawner; update the hard-coded 7-tool expectations (`boardapi_test.go:169-184`,
  `boardtools_test.go:10-11`) and assert a subagent caller's `tools/list` omits the spawn family;
  test spawn with no client, that spawn returns immediately with a receipt naming the sid without
  waiting for completion, `wait_subagents` returning the report on completion and current status on
  timeout, repeated waits, that the spawn schema has no `background` parameter, two byte-equal
  parallel spawns from the chat agent claimed FIFO with each receipt returned to its own call plus
  the documented pairing residual and the distinct-description mitigation, a subagent caller
  rejected before claiming (a direct `tools/call` on the spawn family with a subagent token returns
  `isError` text and starts nothing), delayed reconciliation, validation failures as `isError`,
  unknown/revoked token, unknown tool, and that the chat agent can spawn many siblings with no
  app-imposed concurrency limit (or assert that no cap is configured where a high-count test is
  impractical).
- **Claude adapter**: `args_test.go` for disallowed native names, MCP allowed list and the
  spawn-family exclusion from a subagent's `--allowedTools`, timeout env; a
  captured real `tools/call` recording whether the JSON-RPC id or `_meta` carries a stable tool-use
  mapping, plus the Phase 2 tool-call timeout measurement across candidate limits (to derive the
  `wait_subagents` interval); fake-CLI proc test for a spawn round-trip.
- **Cursor adapter**: scripted ACP fake steps for a command-issued spawn (rewrite, auto-allow, no
  card); parser accepts the new tools; the command handler rejects a spawn-family call from a
  subagent token with `ERROR: ` text, and subagent instructions do not list the spawn commands; a
  real run checks a delegation prompt actually chooses the command path (Q2).
- **Web logic tests** (`web/test/subagents.test.ts`): `isSubagentTool`, `subagentOf`
  linked/unlinked, `subModelLabel` cross-agent and no-catalog fallback; labels test if wording
  changes.
- **E2E** (not in `npm test`): mirror steps 18/19 (`web/e2e/app.e2e.mjs:751,823`) plus
  async spawn/wait/parallel, window-closed spawn and the Cursor command-path check; check for orphan
  processes after Stop; existing e2e as regression.
- **Persistence**: reload an app-spawned subagent from `subagent.json`; restart marks it stopped.

## 7. Facts and references (appendix)

- MCP route/tools/call and error-as-text: `internal/server/server.go:601-602`,
  `internal/boardapi/mcp.go:20-25,34-63,100-156`; `tools/call` receives only name + arguments,
  with the token in the URL (`mcp.go:144-150`); 30 s bridge timeout (`mcp.go:20-21`).
- Caller tokens and spawn options: `model.ChatMeta.Token` (`internal/model/model.go:173`),
  `Manager.ByToken` (`manager.go:995-1010`), board URL in `spawnOptions` (`manager.go:467-476`),
  `agent.SpawnOptions`/`BoardAccess` (`internal/agent/agent.go:18-33`).
- Shared tool list: `internal/boardtools/tools.go`, `command.go:9-35`,
  `internal/claude/claude.go:74-81`, `internal/prompts/prompts.go`.
- Spawn/locks/lifecycle: `manager.go:428-479` (spawn/spawnOptions), `564-637` (Send unlocks before
  `ag.Send`), `481-560` (pump), `844-855` (Interrupt), `908-951` (Stop), `858-874` (Decide reaches
  only `c.ag`), `533-538` (stopSubs on abort/exit, not normal turn end); lock-ordering rule
  (`manager.go:88-89`, `internal/editorbridge/bridge.go:66-68`); `contextsplit.go:49-57`.
- Subagent machinery: `internal/chats/subagents.go` (routeSub/owner/link/endSub/stopSubs/emit),
  `internal/model/model.go:295-331`, `internal/agent/agent.go:76-118`.
- Adapters: `claude.go:214-232,267-302`; `cursor.go:640-660,750-785`; steering surfaces
  `claude.go:73-81`, `internal/prompts/whiteboard.md`, `internal/cursor/config.go:27-91`.
- Web: `web/src/logic/subagents.ts:9-36,82-101` (row entry, unlinked state, `subModelLabel`),
  `web/src/Subagents.tsx:74-82` (row render and drawer-open gate),
  `web/src/types.ts:198-224`, `web/src/logic/labels.ts:22-42`, e2e `app.e2e.mjs:751,823`.
- Defaults/catalogs: `internal/defaults/defaults.go:18-51`, `manager.go:641-746`,
  `internal/claude/catalog.go:8-15`, `internal/cursor/catalog.go`/`probe.go`.
- No concurrency caps or rate limits exist in `internal/`; the depth-1 rule and caller filtering
  are therefore explicit at the spawn check (D2). Restart rewrites running subagents to stopped
  (`subagents.go:54-58`); adding JSON fields is additive-safe.

## 8. Assumptions and open questions

The asynchronous spawn contract, caller identity and concurrency policy were settled during
review and are folded into D1–D3; they are no longer open. In particular the app imposes no
concurrency caps — parallel sibling spawns are deliberately unlimited — and nesting depth is
fixed at 1 (only the chat agent spawns), not tunable. Subagents keep board access while having no
spawn surface, which resolves the earlier recursive-board-access question.

- **Q1:** the exact Claude CLI MCP tool-call timeout and override env are unverified. Phase 2
  measures a blocking call and captures a real `tools/call`; the result now only derives the
  `wait_subagents` interval — the server's blocking budget for one wait — and confirms that waits
  can be repeated inside the CLI limit. It no longer selects a design branch: spawn is asynchronous
  in every case (D1).
- **Q2:** whether Cursor can scope a native-Task deny to board sessions; v1 ships instruction-only,
  and §6 must observe the command path actually being chosen or the "instead of native" goal is
  qualified to Claude.
- **Q3:** exact native Claude tool names (`Task` vs `Agent`) across bundled versions; disallow both,
  verify an unknown rule is harmless.
- **Q4:** the delayed reconciliation window must be confirmed against real CLIs; widen if
  needed.
