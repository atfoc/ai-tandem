# MCP subagents plan — stale inventory

Status: read-only inventory against worktree HEAD `b15640a` (`mcp-subagents-plan`).
Original plan: `plans/mcp-subagents.md`. Related landed plan (context only): `plans/unified-mcp-endpoint.md`.
This file does not propose a new design. It classifies what in the original plan is still true.

Code facts below were verified in this tree. Product decisions are marked as such when the tree cannot confirm them.

**Architecture that the original plan did not have (now landed in `4231eb0`, ancestor of HEAD):**

- One MCP URL for every agent: `http://localhost:6006/mcp` (`internal/boardapi/endpoint.go:11`).
- Identity is `Authorization: Bearer <token>`, never a URL segment (`internal/agent/agent.go:25-28`, `internal/boardapi/mcp.go:176-188`).
- Command endpoint, `ParseCommand`, `internal/boardtools/command.go`, curl instructions: gone.
- Pi is a third agent (`internal/model/model.go:14-16`, `internal/defaults/defaults.go:12-14`).
- Cursor Task can be denied deterministically via an ACP `preToolUse` hook (`cursor-task-deny.md`). The original plan did not know this.

`plans/unified-mcp-endpoint.md` §2 already says the subagents plan assumed `/mcp/<token>` and the command endpoint and must rebase onto fixed URL + header identity. This inventory is that rebase map.

Legend:

- **KEEP** — still matches current code, or still a valid product decision independent of code.
- **UPDATE** — decision still wanted; integration point, file, mechanism, or wording is wrong.
- **INVALID** — assumption is false now.
- **UNKNOWN** — current tree does not settle it.

---

## 0. Highest-impact INVALID items

These force a rebase; they are not wording nits.

1. **Per-token MCP URL `/mcp/<token>`.** Stale: scope “the board MCP surface (`/mcp/<token>`, Claude)” and D3 “token in the URL (`mcp.go:144-150`)”. Current: only `POST /mcp` on the 6006 listener (`internal/server/server.go:179-185`), credential from the header (`internal/boardapi/mcp.go:176-188`). `BoardAccess.MCPURL` is the fixed URL; `Token` “never a URL segment” (`internal/agent/agent.go:25-28`).
2. **Command endpoint `/agent/<token>/<tool>` and all Cursor command-path machinery.** Stale: scope, acceptance, D1 routing, D2 Cursor instructions, D5 “board command path”, D8 entire section, Phase 2 “commands”, Phase 5 “Cursor command-path choice”, verification of `ParseCommand` / `ERROR: `. Current: no `/agent` route, no `command.go`, no `ParseCommand`, no `CursorInstructions` / `cursorTools` / `<board-api>` curl block. Cursor board calls are MCP, auto-approved in `onRequest` (`internal/cursor/cursor.go:817-821`).
3. **Scope “Claude via MCP, Cursor via command path”; Pi missing.** All three agents use the same MCP endpoint. Pi is a first-class `AgentKind` with its own adapter, native `subagent` tool (displayed as `Agent`, `internal/pi/translate.go:221-227`), and the same `BoardAccess` value.
4. **D5 “Cursor is instruction-only because ACP has no scoped Task deny”.** `cursor-task-deny.md` settled that a per-project `preToolUse` hook under `CURSOR_DATA_DIR` denies `Task` in ACP. `permissions.deny` in `cli-config.json` still cannot name `Task`; that part of D5 was right about *that* file, wrong as a conclusion.

---

## 1. Goal and scope

| # | Stale phrase / claim | Class | Current-code reason |
|---|---|---|---|
| S1 | “Scope: board chats only.” | **KEEP** | Product decision. Plain chats still have no MCP (`spawnOptions` sets `Board` only when `c.meta.Board != ""`, `internal/chats/manager.go:478-479`). Native subagents stay for plain chats. |
| S2 | Replace native spawning with server-side spawn through the app’s own adapters. | **KEEP** | Product decision. No app-spawned path exists yet; native spawn still goes through each adapter’s events into `routeSub` (`internal/chats/subagents.go:116-161`). |
| S3 | Claude: native `Task`/`Agent` disallowed (D5). | **KEEP** | Product decision. Not implemented: `--disallowedTools` is only `AppDirRules` (`internal/claude/claude.go:72`). |
| S4 | Cursor: instruction-steered, a goal not a guarantee, until a scoped native-tool deny (D5, Q2). | **UPDATE** | Instruction steering is still a possible v1. A scoped deny now exists (`cursor-task-deny.md`). Q2 is no longer “whether Cursor can scope a deny”. |
| S5 | UI: row, drawer, live thread, report, status, duration, context meter, indistinguishable from native. | **KEEP** | Product decision. Current UI is native-only (`isSubagentTool` is `Agent`/`Task`, `web/src/logic/subagents.ts:9-10`). |
| S6 | App-spawned subagents run asynchronously; results via `wait_subagents`. | **KEEP** | Product decision. Independent of transport. |
| S7 | In scope: “the board MCP surface (`/mcp/<token>`, Claude)” | **INVALID** | No path-token route. Fixed `POST /mcp` (`internal/server/server.go:185`). |
| S8 | In scope: “the command surface (`/agent/<token>/<tool>`, Cursor)” | **INVALID** | Route, handler, parser gone. |
| S9 | In scope: server-side subagent runner, per-caller identity, defaults/validation, steering, minimal web, lifecycle. | **KEEP** | Product / work still to do. Identity *mechanism* is UPDATE (header, not URL). |
| S10 | Out of scope: plain chats, UI overhaul, per-subagent stop buttons, MCP push/progress. | **KEEP** | MCP is still “JSON responses only” (`internal/boardapi/mcp.go:152-155`). `GET /mcp` is 405 (`internal/boardapi/boardapi_test.go:194-199`). |
| S11 | (omission) Pi as a third board-chat agent. | **INVALID** | Pi landed in `71d0418`. Board chats of every agent use the same MCP (`internal/chats/manager.go:478-479` hands one `BoardAccess` to Claude, Cursor and pi). Native Pi subagent tool is `subagent` (`internal/pi/translate.go:224-226`). |

---

## 2. Requirements and acceptance

| # | Claim | Class | Reason |
|---|---|---|---|
| R1 | `spawn_subagent`: prompt + optional description, agent, model, effort; no `background`. | **KEEP** | Product decision. |
| R2 | Spawn always returns immediately with a sid receipt; results only via `wait_subagents`. | **KEEP** | Product decision. MCP still has no push channel. |
| R3 | `wait_subagents` blocks up to a measured interval, returns status/report, repeatable; timeout 0 = poll. | **KEEP** | Product decision. The measured interval itself is UNKNOWN (Q1). |
| R4 | Parallel spawns do not serialize on the chat lock. | **KEEP** | Product decision. Precedent still holds: `Send` unlocks before `ag.Send` (`internal/chats/manager.go:631,639`); `ContextSplit` waits outside `c.mu` (`internal/chats/contextsplit.go:67-78`). |
| R5 | Rendering/lifecycle events identical to native. | **KEEP** | Product decision. |
| R6 | Stop/interrupt/archive/delete/shutdown terminate app-spawned processes; restart marks stopped; normal turn end leaves them running. | **KEEP** | Product decision. Today `stopSubs` only marks state (`internal/chats/subagents.go:189-197`); `loadSubs` already rewrites running → stopped (`:56-59`); pump calls `stopSubs` on abort/exit, not normal turn end (`internal/chats/manager.go:538-543`). |
| R7 | Omitted agent = chat kind; omitted model/effort = chat current; explicit values validated like `Configure` against the **requested** agent’s catalog (D4). | **KEEP** | Product decision. `Configure` still behaves as cited (`internal/chats/manager.go:648-728`, `findModel` nil-catalog accept at `747-758`). |
| R8 | Errors are tool text with `isError`, never HTTP errors. | **KEEP** | Product decision. Board tools already do this (`internal/boardapi/mcp.go:49-76,226-239`). Command `ERROR: ` prefix is INVALID (no command path). |
| R9 | Spawn works with the window closed (board tool calls still need it). | **KEEP** | Product decision. Board tools still return `NoClientText` (`internal/boardapi/mcp.go:26-28,66-68`). |
| R10 | Only the chat agent may spawn; subagent callers never receive spawn-family definitions; a spawn-family call from them is rejected with tool text and starts nothing. | **KEEP** | Product decision. Depth-1 still has to be implemented; `tools/list` is currently global (`mcpTools()` at `internal/boardapi/mcp.go:159-169,225`). |
| R11 | Acceptance: “a board-chat agent (Claude via MCP, Cursor via the command path)” | **UPDATE** | Replace with: Claude, Cursor **and Pi**, all via `http://localhost:6006/mcp`. |
| R12 | “the measured CLI limit only bounds how long one `wait_subagents` call may block (D1)” | **KEEP** | Product decision. Measurement still unwritten (Q1). Now three CLIs, not one. |
| R13 | No app-imposed concurrency limit (D2). | **KEEP** | Product decision. Still no spawn cap in `internal/` (verified by search; only unrelated buffer caps). |
| R14 | Cursor acceptance: observed real run choosing “the command path rather than native `Task` (Q2)” | **INVALID** | There is no command path. The observation, if kept, is “chooses board MCP spawn tools rather than native `Task`”. |

---

## 3. Design decisions

### D1. Tool surface and API contract — **UPDATE**

Core contract (three tools, async spawn, wait required, stop included, errors as tool text, do not route through `Relay.Call`) is **KEEP**. Transport and consumers are **UPDATE** / **INVALID**.

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D1.a | Add `spawn_subagent`, `wait_subagents`, `stop_subagent` to `boardtools.Tools`. | **KEEP** | Product. `Tools` is still the shared list (`internal/boardtools/tools.go:45-111`, seven board tools). |
| D1.b | “the shared list feeding Claude's MCP server, the Cursor instructions and the command parser; `…/tools.go`, `…/claude.go:74-81`, `…/prompts.go`, `…/command.go:9-35`” | **UPDATE** | Consumers now: MCP `tools/list` (`mcp.go:159-169,225`), Claude `--allowedTools` (`claude.go:75-80`), Cursor MCP discovery + `boardtools.IsTool` in `boardMCPCall` (`cursor.go:669-681`), Pi MCP via `AIWB_MCP_CONFIG` (`internal/pi/args.go:104-126`). `prompts.go` no longer lists tools (`Claude()` / `Pi()` say “with the `board` MCP tools”, `internal/prompts/prompts.go:19-31`). `command.go` is gone. `Tool.Summary` is only asserted in `boardtools_test.go:20-22` — dead for Cursor instructions. |
| D1.c | “MCP `tools/list` is computed per caller/token” | **UPDATE** | Still wanted for depth-1. Current `tools/list` ignores the token and returns every `boardtools.Tools` entry (`mcp.go:225`). Identity will be the header token, not a URL token. Unified-plan D8 also makes `initialize`/`tools/list` permissive even without a credential (`mcp_fixed_test.go` comment at `:43`). Filtering spawn-family on `tools/list` must not break that handshake. |
| D1.d | One spawn per call; no `background`; parallel = several HTTP POSTs. | **KEEP** | Product. HTTP server still one goroutine per POST. |
| D1.e | Async contract (receipt, wait required because MCP has no push, stop included). | **KEEP** | Product. Still no MCP push (`mcp.go:152-155`). |
| D1.f | Wait interval derived from measured CLI MCP timeout; adapters set override env if Phase 2 finds one. | **KEEP** | Product. Value UNKNOWN (Q1). Measure Claude, Cursor **and** Pi, not “the CLI”. |
| D1.g | “Routing: spawn/wait/stop must not go through `Relay.Call`/`Bridge.Call` (that would return `NoClientText` and add the 30 s board timeout; `internal/boardapi/mcp.go:20-63`).” | **KEEP** | Decision still right. Current `Relay.Call` always goes to `Bridge.Call` with `callTimeout = 30s` (`mcp.go:23-24,49-76`). Line refs drifted (timeout `:23-24`, `Call` `:49-76`). |
| D1.h | “The relay resolves the caller from the token first (D3)” | **UPDATE** | `Call` still does `Chats.ByToken(token)` (`mcp.go:51-54`) but `token` is the bearer header, and `ByToken` only matches `ChatMeta.Token` (`manager.go:1007-1021`). No per-caller registry. |
| D1.i | “MCP and the command endpoint share routing, caller resolution and error formatting (MCP text + `isError`; command text prefixed `ERROR: `).” | **INVALID** | One MCP handler for all agents (`ServeFixedMCP`). No command formatting. |

### D2. Execution model — **UPDATE**

Process model, no `pump` reuse, no concurrency cap, depth-1: **KEEP**. Per-caller token-in-URL and Cursor-command visibility: **UPDATE** / **INVALID**.

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D2.a | One independent process per spawn via `agent.Spawner`/`SpawnOptions` (`agent.go:18-41`), fresh session, chat cwd, resolved model/effort. | **KEEP** | Interface still `SpawnOptions` + `Spawner` (`agent.go:15-33`). Line drift. Pi is a third `Spawner`. |
| D2.b | “its own per-caller board token issued for that run, mapped to (chat, subagent sid)” | **UPDATE** | Identity still needed (else every process shares `ChatMeta.Token` and sees the same `tools/list`). Mechanism cannot be a URL segment. Same fixed URL + distinct bearer token is the shape that fits current `BoardAccess`. Pi native subagents already inherit the parent’s MCP config (unified plan §8.2; pi e2e subagent board-access still valid). Without a distinct header token, a Pi (or Claude) subagent would see spawn-family tools. |
| D2.c | Must **not** reuse `pump`: `pump` is bound to `c.ag`/`c.gen` and writes chat-level state (`manager.go:481-560`). | **KEEP** | Still true. `pump` is `manager.go:484-562`; `EvSession`/`EvUsage`/`EvCatalog`/turn counting still land on the parent. |
| D2.d | Reuse `subagents.go` flush/save/emit/link/end so the client sees identical `sub`/`sub_items`. | **KEEP** | Those helpers still exist (`subagents.go`: `saveSub` `:75`, `flushSub` `:93`, `link` `:164`, `endSub` `:177`, `stopSubs` `:189`). |
| D2.e | Background flag at creation so UI never treats the receipt as a report. | **KEEP** | Product. `Subagent.Background` and `subReport` still work that way (`web/src/logic/subagents.ts:59-62`). |
| D2.f | `Chat.mu` only for short transitions. Precedent: `Send` after unlock (`manager.go:625-636`), `ContextSplit` outside `c.mu` (`contextsplit.go:49-57,88-90`). | **KEEP** | Same pattern, new lines: `Send` unlock `:631`, `ag.Send` `:639`; `ContextSplit` unlock `:67-68`, wait `:70-78`. |
| D2.g | No concurrency cap anywhere in `internal/`; depth fixed at 1. | **KEEP** | Product + still no cap. |
| D2.h | Visibility layer: MCP `tools/list` per caller/token omits spawn family; “Cursor subagent instructions omit the commands”; Claude subagent `--allowedTools` excludes them. | **UPDATE** | MCP list-filter still the right lever (and the only one for Pi). Cursor has no command instructions to omit. Cursor first-message is `prompts.Claude()` (`manager.go:604-607`). Claude `--allowedTools` is still a real filter (`claude.go:75-80`) — exclusion still to implement. |
| D2.i | Hard rejection: MCP `isError` or command `ERROR: `; never HTTP. | **UPDATE** | MCP `isError` KEEP. Command `ERROR: ` INVALID. |

### D3. Caller identity, correlation and linking — **UPDATE**

Claiming design is **KEEP**. “Token in the URL” and “command handler” are **INVALID**. “No tool-use id” is still **UNKNOWN** pending a captured real `tools/call`.

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D3.a | “The MCP and command requests carry only token, tool name and arguments — no caller id and, on the code as read, no tool-use id (`mcp.go:144-150`).” | **UPDATE** | Command requests are gone. MCP `tools/call` still unmarshals only `name` + `arguments` (`mcp.go:227-232`). JSON-RPC `id` is on the envelope (`rpcReq.ID`, `mcp.go:157-161`) and is echoed, not used as a tool-use id. `_meta` is not parsed. Token is the bearer header, not the URL. |
| D3.b | Phase 2 confirms “no tool-use id” from a captured real request. | **UNKNOWN** | Still uncaptured on this tree. Do it against the fixed `/mcp` + header, for Claude, Cursor and Pi. |
| D3.c | Chat process keeps the chat’s persisted token; each spawn issues a fresh per-caller token mapped to (chat, sid). | **UPDATE** | Persisted chat token still exists (`ChatMeta.Token`, `model.go:204`; minted `manager.go:369`). Per-caller tokens do not exist. They cannot go in the URL. They can still be extra bearer credentials on the same URL (product/mechanism for the later planner — not designed here). |
| D3.d | Lookup yields chat, caller sid, chat-vs-subagent, kind/model/effort. | **KEEP** | Product. `ByToken` today returns only `ChatMeta` (`manager.go:1007-1021`). |
| D3.e | Revoke on sub end/stop and bulk on chat stop/delete/shutdown; unknown token → tool text. Restart: in-memory tokens die; `loadSubs` rewrites running → stopped. | **KEEP** | Product. `loadSubs` still does the rewrite (`subagents.go:32-34,56-59`). Unknown token already returns `"unknown board token"` (`mcp.go:51-54`). |
| D3.f | Subagent board calls still go to the parent chat’s board; subagent caller rejected before claiming. | **KEEP** | Product. |
| D3.g | Claim oldest pending unclaimed spawn-tool item in the **chat’s** thread, FIFO, canonical JSON args, under `c.mu`. | **KEEP** | Product. Native linking is different (adapter `EvSub` / tool id → `subByTool`, `subagents.go:116-131`); app-spawned claiming is new work. |
| D3.h | Race: retry; else unlinked + reconciliation on later transcript updates. Unlinked row via `isSubagentTool` + `subagentOf` (`web/src/logic/subagents.ts:9-36`); drawer needs linked sid (`web/src/Subagents.tsx:76-82`). | **KEEP** | Product. Line drift: `subagentOf` `:18-34`; drawer-open gate is `if (sa.id) toggleSub(...)` at `Subagents.tsx:82`. `isSubagentTool` still only `Agent`/`Task` (`:9-10`). |
| D3.i | “Cursor uses the identical strategy; its `toolCallId` never reaches the command handler.” | **INVALID** | No command handler. Cursor MCP calls hit `ServeFixedMCP` like everyone else; `toolCallId` still does not appear in MCP params. Claiming can be shared. |
| D3.j | Residual: byte-equal parallel spawns from the chat agent may swap UI pairing; mitigate with distinct descriptions. | **KEEP** | Product. Independent of transport. |

### D4. Defaults and validation — **KEEP**

(Line refs **UPDATE**; Pi catalog must be included.)

| # | Claim | Class | Reason |
|---|---|---|---|
| D4.a | Omitted agent = chat kind; caller/kind from token not claimed item. | **KEEP** | Product. |
| D4.b | Omitted model/effort = chat’s current (not `defaults.Resolve`). | **KEEP** | Product. `defaults.Resolve` is still new-chat only (`internal/defaults/defaults.go:16-51`). |
| D4.c | Additive persisted fields: subagent agent kind + effort. Caller identity never persisted. | **KEEP** | Product. `model.Subagent` still has no kind/effort (`model.go:345-366`). Web `Subagent` type matches (`web/src/types.ts:211-231`). |
| D4.d | Validate against the **requested** agent’s catalog; inherited mismatches fall back like new-chat; explicit unknown model / bad effort error like `Configure`; nil Cursor catalog accepts unvalidated. | **KEEP** | `Configure` still: unknown model error, effort not offered error, model change resolves stale effort, nil catalog accepts (`manager.go:682-728,747-758`). Pi has a catalog too (`internal/pi/catalog.go`). |
| D4.e | Invalid input → tool text, no process. | **KEEP** | Product. |

### D5. Steering away from native spawning — **UPDATE**

Claude disallow is **KEEP**. Cursor “instruction-only because no scoped deny” is **UPDATE** (deny now exists). Command-path least-resistance is **INVALID**. Pi native `subagent` is missing.

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D5.a | Claude: add `Task` and `Agent` to `--disallowedTools` (`claude.go:73`); paragraph on board spawn tools in `--append-system-prompt`. | **KEEP** | Product. Current `--disallowedTools` is only app-dir rules (`claude.go:72,109-116`). Prompt is still `prompts.Claude()` via `--append-system-prompt` (`claude.go:79`). |
| D5.b | “ACP has no per-session tool configuration and the app's permission writes are user-global (`config.go:27-91`), so a `Task` deny would affect all Cursor usage.” | **UPDATE** | `EnsureDenyRules` is still user-global `cli-config.json` (`config.go:27-98`) and still cannot name `Task` (`cursor-task-deny.md`: “those rules take parameters … not a tool name”). ACP still has no hook field on `session/new`. **But** ACP honours a per-project `preToolUse` hook at `$CURSOR_DATA_DIR/projects/<slug(cwd)>/.cursor/hooks.json`, app-owned if the process is started with `CURSOR_DATA_DIR`. Native Task never raises an ACP permission request (attempt 4), so the adapter cannot deny it in `onRequest`. |
| D5.c | “v1 steers by instruction only” | **UPDATE** | Still a possible choice. The original rationale (“cannot guarantee”) is weaker: a deny recipe exists. Whether v1 uses the hook is a product decision the later planner must re-ask; it is not forced by code. |
| D5.d | “The board command path is already auto-allowed, so it is the path of least resistance.” | **INVALID** | Command path gone. Board MCP calls are auto-approved (`cursor.go:817-821`). That *is* the least-resistance path now — MCP spawn tools, not curl. |
| D5.e | Subagent processes: MCP list omits spawn family; Claude `--allowedTools` excludes it; Cursor subagent instructions omit commands; command-handler rejection is the Cursor guarantee. | **UPDATE** | MCP list + Claude allowedTools KEEP. Cursor instruction omission and command-handler rejection INVALID. Pi has no `--allowedTools`; hiding spawn family from a Pi subagent is `tools/list` (and hard rejection) only. Pi also has a wild “spawn-subagent extension” that disables itself on `PI_SUBAGENT=1` (`internal/pi/args.go:12-16`) — relevant to native-Pi steering, not in the original plan. |
| D5.f | (omission) Pi native tool `subagent` (shown as `Agent`). | **INVALID** | Must be part of steering. No Pi `--disallowedTools` equivalent in `args.go` (built-ins are deliberately not excluded, `:33-36`). |

### D6. UI parity — **KEEP**

(Line refs **UPDATE**. `mcp__board__` prefix **KEEP**.)

| # | Claim | Class | Reason |
|---|---|---|---|
| D6.a | `isSubagentTool` must recognize `mcp__board__spawn_subagent` in addition to `Agent`/`Task` (`subagents.ts:9-10`). | **KEEP** | Still the only row entry point (`ChatView.tsx` imports it). Prefix is still how Claude/Pi/Cursor board tools are named: MCP `serverInfo.name` is `"board"` so Claude names `mcp__board__<tool>` (`mcp.go:152-155,224`); Cursor adapter prefixes (`cursor.go:694`); Pi already namespaced (`pi/translate.go:221-227`); web strips `mcp__board__` (`labels.ts:22`, `ChatView.tsx:17,179`). |
| D6.b | Mirror optional fields (agent kind, effort) in `web/src/types.ts`. SSE shapes unchanged. | **KEEP** | Product. `types.ts` `Subagent` is `:211-231` (plan said `:198-224`). |
| D6.c | `subModelLabel` uses the subagent’s own kind and effort. | **KEEP** | Function exists (`subagents.ts:85-104`, plan said `:82-101`) and already branches on `claude` / `cursor` / `pi`. It still takes the **parent chat’s** `agent` today (`Subagents.tsx` passes `chat.agent`). Cross-kind spawn needs the sub’s own kind, as the plan said. |
| D6.d | Plain labels for wait/stop cards. | **KEEP** | `labels.ts` `toolVerb`/`toolDone` switch on `short(name)` (`:57-96`); unknown names fall through to `short(name)`. |
| D6.e | Background flag → `subReport` uses summary/last text; existing chip; nothing else changes. | **KEEP** | Product. `subReport` `:59-62`. |

### D7. Lifecycle, failure and safety — **KEEP**

(Line refs **UPDATE**. Per-caller token mechanism **UPDATE**.)

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D7.a | `stopSubs` only marks state (`subagents.go:190-198`); `Stop` closes only `c.ag` (`manager.go:933-938`). | **KEEP** | Still true. `stopSubs` `:189-197`; `Stop` `:920-963` closes `c.ag` then `stopSubs`. No app-spawned processes to kill yet. |
| D7.b | Runner must terminate processes on stop/interrupt, aborted turn, parent `EvExit`, archive/board delete, chat delete, shutdown. Close async outside `c.mu` because Claude’s graceful close kills after 3 s. | **KEEP** | Product. Claude `Close` still waits 3 s then `Kill` (`claude.go:305-316`). Cursor too (`cursor.go:853-854`). Pi uses a 3 s process-group kill (`pi.go:44-52,428+`). |
| D7.c | Lock-ordering: bridge lock never under a chat lock (`manager.go:88-89`, `editorbridge/bridge.go:66-68`). | **KEEP** | Comment now `manager.go:89-90`; bridge snapshot-under-lock comment is `bridge.go:66-68` adjacent to `New` at `:69-75`. |
| D7.d | Normal turn end keeps app-spawned alive, matching native (`manager.go:531-538`). | **KEEP** | `pump` `:538-543`: `stopSubs` only on aborted `EvTurnEnd` or `EvExit`. |
| D7.e | `Decide` answers only `c.ag` (`manager.go:858-874`); extend to route by sid; Stop/stopSubs deny unanswered sub permissions. | **KEEP** | Still only `c.ag` (`Decide` `:869-894`). Native sub perms already rewrite `ev.Sub` to sid (`pump` `:501-503`) but `Decide` still talks to the parent process — correct for native, insufficient for a separate app-spawned process. |
| D7.f | Failure handling, depth-1 rejection, board access without spawn family, per-caller token routes board calls to parent board. | **KEEP** / token **UPDATE** | Same as D2/D3. |

### D8. Cursor parity — **INVALID**

The whole section is written around `POST /agent/<token>/<tool>`, `ParseCommand`, Cursor instructions listing commands, `ERROR: `, and `internal/boardapi/command.go`.

| # | Stale phrase | Class | Current |
|---|---|---|---|
| D8.a | “Because the new tools live in `boardtools.Tools`, they are automatically served at `POST /agent/<token>/<tool>` (`server.go:602`)” | **INVALID** | `server.go:602` is now unrelated (`GET /api/dirs` region). MCP tools are listed by `mcpTools()` on `POST /mcp`. |
| D8.b | Accepted by the command parser, auto-allowed, listed in Cursor instructions; subagent instructions omit spawn commands; command handler rejects subagent tokens. | **INVALID** | Parser/instructions/handler gone. Auto-allow of **board MCP** calls remains (`cursor.go:817-821`) and would cover spawn-family MCP tools unless the adapter is taught not to. |
| D8.c | “The command path must route spawn/wait/stop to the subagent service instead of `Bridge.Call`, keep the always-200 text/plain contract and `ERROR: ` prefix (`boardapi/command.go`)” | **INVALID** | Files/contracts gone. The MCP equivalent (do not send spawn-family through `Relay.Call`) is D1.g, KEEP. |
| D8.d | Command path asynchronous exactly like MCP. | **INVALID** | There is only MCP. |
| D8.e | Cursor model/effort semantics preserved; subagent processes use the Cursor spawner, fresh session, “board command instructions”. | **UPDATE** | Spawner + fresh session + model/effort KEEP. “Board command instructions” → shared `prompts.Claude()` first-message (`manager.go:604-607`) plus MCP tools. |

Cursor parity as a *goal* (board Cursor chats can spawn via the same tools as Claude) is a surviving product decision; it is no longer a second transport.

---

## 4. Components and responsibilities

| # | Component | Class | Reason |
|---|---|---|---|
| C1 | `boardtools`: one source for MCP listing, Claude allowed list, Cursor instructions, command parsing, spawn-family filtered per caller. | **UPDATE** | Still the one source for **tool definitions**. Cursor instructions and command parsing are gone. Add Pi (MCP discovery). `Summary` is vestigial. |
| C2 | `boardapi` relay: token/caller resolution, name-based routing (board → bridge, subagent → runner), endpoint contracts, text errors. | **UPDATE** | Relay still exists. Identity is header bearer. One endpoint (`ServeFixedMCP`). Name-based routing to a runner is new. No command contract. |
| C3 | `chats.Manager` + subagent runner: token registry, defaults, claim/reconcile, process/loop/transcript, persistence, stop, permission routing, depth-1, tool-surface filtering. | **KEEP** | Work still lives here. Token registry must key header credentials, not URL tokens. |
| C4 | Adapters: unchanged interfaces; steering in Claude args and both prompts; per-caller board **URLs** passed through spawn options. | **UPDATE** | Interfaces unchanged (`agent.Spawner`). “Both prompts” is now one `prompts.Claude()` / `Pi()` alias plus Cursor first-message. Per-caller **URLs** INVALID — `BoardAccess` is `{MCPURL: fixed, Token: credential}`. Steering must also cover Pi. |
| C5 | Web: `isSubagentTool` and types/labels only. | **KEEP** | Still the right surface. |
| C6 | Boundaries: `boardapi` knows nothing about processes, `chats` nothing about HTTP, web only interprets existing events plus additive fields. | **KEEP** | Product / architecture. |

---

## 5. Build phases

| Phase | Original | Class | Why |
|---|---|---|---|
| 1. Runner and manager integration | Per-sub process/loop/transcript/persistence, stop/kill, permission routing. Go unit tests. No deps. | **KEEP** | Independent of MCP URL vs header. Must spawn Claude **or Cursor or Pi** via `Spawners[kind]`. |
| 2. Contract | Tool defs, per-caller list/instruction filtering, relay routing, token issue/revoke, defaults, depth-1 rejection, claim/reconcile “for MCP and commands”. CLI timeout measurement + captured `tools/call` (D3). | **UPDATE** | Drop “commands”. Filter `tools/list` by header identity, not URL token. Include Pi (no `--allowedTools`; list-filter is the visibility layer). Timeout measurement for all three CLIs. Captured `tools/call` is against `POST http://localhost:6006/mcp` with `Authorization`. |
| 3. Steering | Claude disallowed native names + prompt paragraph; Cursor instruction wording. Sets up §6 command-path observation (Q2). | **UPDATE** | Claude part KEEP. Cursor instruction wording is now the shared MCP prompt (`prompts.Claude()`), not command instructions. Q2 observation is MCP spawn vs native `Task`. Revisit whether Phase 3 also writes the ACP `preToolUse` hook (`cursor-task-deny.md`). Add Pi native `subagent`. |
| 4. Web | Name recognition, optional fields, labels. Frozen tool name + additive fields. | **KEEP** | Frozen name `mcp__board__spawn_subagent` still matches current MCP naming. |
| 5. End-to-end | Fake-CLI boardapi flows, real-CLI e2e, regression, “Cursor command-path choice”. | **UPDATE** | Drop command-path choice. Add Pi. Cursor e2e is already MCP (`web/e2e/app.e2e.mjs` Cursor board steps use the unified endpoint). Native subagent e2e steps 18/19 still exist at new lines (see §7). |

---

## 6. Verification approach

| # | Item | Class | Current |
|---|---|---|---|
| V1 | Manager/runner unit tests with existing fakes (`manager_test.go`: fake agent/spawner, `syncEv`, SSE recorder, `subStart`/`subRun`). | **KEEP** | Harness still there. |
| V2 | boardapi harness; update hard-coded 7-tool expectations (`boardapi_test.go:169-184`, `boardtools_test.go:10-11`); assert subagent `tools/list` omits spawn family; spawn with no client; receipt; wait; no `background`; FIFO residual; subagent caller `isError`; reconciliation; validation; unknown token; no cap. | **UPDATE** | 7-tool asserts moved: `TestToolsList` `boardapi_test.go:162-179` (`len(tools) != 7` at `:166-167`); `boardtools_test.go:10-11` still. Harness already uses `POST /mcp` + bearer (`boardapi_test.go:61,67-72`). Drop any leftover command-path cases (there are none left to update). `isError` KEEP; `ERROR: ` INVALID. |
| V3 | Claude adapter: `args_test.go` for disallowed native names, MCP allowed list, spawn-family exclusion from subagent `--allowedTools`, timeout env; captured real `tools/call`; timeout measurement; fake-CLI spawn round-trip. | **KEEP** | `args_test.go` still pins `--allowedTools` to `len(boardtools.Tools)` (`:63-70`) and `--disallowedTools` to `AppDirRules` (`:105-106`). Adding `Task`/`Agent` will change that pin. |
| V4 | Cursor adapter: scripted ACP fake for a **command-issued** spawn (rewrite, auto-allow, no card); parser accepts new tools; command handler rejects subagent token with `ERROR: `; subagent instructions omit spawn commands; real run chooses command path (Q2). | **INVALID** | Parser/handler/instructions gone. Replacement checks: MCP board-call normalization already maps to `mcp__board__<tool>` (`cursor.go:687-695`, tests around `cursor_test.go:550-570`); auto-approve already covers `boardMCPCall` (`:817-821`); a spawn-family MCP call from a subagent token is rejected in the **relay**, not the Cursor adapter; real-run observation is MCP spawn vs native `Task`. Hook-based deny, if chosen, is a new test. |
| V5 | Web logic tests (`web/test/subagents.test.ts`): `isSubagentTool`, `subagentOf`, `subModelLabel`. | **KEEP** | |
| V6 | E2E (not in `npm test`): mirror steps 18/19 (`web/e2e/app.e2e.mjs:751,823`) plus async spawn/wait/parallel, window-closed spawn, Cursor command-path check; orphan processes after Stop. | **UPDATE** | Steps 18/19 are now `:861` (Claude subagents) and `:933` (Cursor subagents). Command-path check INVALID. Add Pi. |
| V7 | Persistence: reload `subagent.json`; restart marks stopped. | **KEEP** | `loadSubs` already marks running → stopped (`subagents.go:56-59`). |

---

## 7. Facts and references (appendix of the original plan)

Every cited location is classified. “Still true, wrong line” is **UPDATE**.

| Original ref | Class | Now |
|---|---|---|
| `internal/server/server.go:601-602` MCP route / `/agent` | **INVALID** | No `/agent`. MCP is `MCPHandler` `POST /mcp` at `server.go:179-185`. `:602` is not an agent route. |
| `internal/boardapi/mcp.go:20-25,34-63,100-156` error-as-text, 30 s, tools/call | **UPDATE** | `callTimeout` `:23-24`; `NoClientText` `:26-28`; `Relay.Call` `:49-76` (still text + `isErr`); package doc `:1-4,152-155` (fixed `/mcp`, header identity, `serverInfo.name` `"board"` → `mcp__board__<tool>`); `tools/call` `:226-239`. |
| `tools/call` receives only name + arguments, token in the URL (`mcp.go:144-150`) | **INVALID** (URL) / **UPDATE** (params) | Params still name+arguments (`:227-232`). Token is `Authorization` (`:176-188`). |
| `model.ChatMeta.Token` (`model.go:173`) | **UPDATE** | `model.go:204`: “board chats: the durable MCP credential, sent in the Authorization header”. |
| `Manager.ByToken` (`manager.go:995-1010`) | **UPDATE** | `manager.go:1007-1021`. Still linear scan of `ChatMeta.Token` only. |
| board URL in `spawnOptions` (`manager.go:467-476`) | **UPDATE** | `spawnOptions` `manager.go:470-481`: `BoardAccess{MCPURL: m.MCPURL, Token: c.meta.Token}`. `Manager.MCPURL` is the fixed endpoint (`manager.go:39`). |
| `agent.SpawnOptions`/`BoardAccess` (`agent.go:18-33`) | **UPDATE** | `agent.go:15-28`. `CommandURL` gone. Comment: MCPURL is `http://localhost:6006/mcp` for Claude, Cursor and pi; Token never a URL segment. |
| Shared tool list: `tools.go`, `command.go:9-35`, `claude.go:74-81`, `prompts.go` | **UPDATE** / `command.go` **INVALID** | See D1.b. |
| `manager.go:428-479` spawn/spawnOptions | **UPDATE** | `spawn` `:428-468`; `spawnOptions` `:470-481`. Also rejects `InstructionsSent` as legacy curl-era (`:437-439`, `ErrLegacy` `:67`). |
| `564-637` Send unlocks before `ag.Send` | **UPDATE** | Unlock `:631`, `ag.Send` `:639`. Cursor first-message injects `prompts.Claude()` (`:604-607`), not curl. |
| `481-560` pump | **UPDATE** | `:484-562`. |
| `844-855` Interrupt | **UPDATE** | `:855-867`. Still only `c.ag`. |
| `908-951` Stop | **UPDATE** | `:920-963`. |
| `858-874` Decide reaches only `c.ag` | **UPDATE** | `:869-894`. Still only `c.ag`. |
| `533-538` stopSubs on abort/exit, not normal turn end | **UPDATE** | `:538-543`. |
| lock-ordering `manager.go:88-89`, `editorbridge/bridge.go:66-68` | **UPDATE** | `manager.go:89-90`; bridge comment around `New` `:66-75`. |
| `contextsplit.go:49-57` | **UPDATE** | Unlock/wait `:67-78`. Also Pi keeps split (`keepsContextSplit` `:10-14`). |
| `internal/chats/subagents.go` (routeSub/owner/link/endSub/stopSubs/emit) | **KEEP** | Same helpers; `loadSubs` restart rewrite `:56-59`; `stopSubs` still mark-only `:189-197`. |
| `model.go:295-331` Subagent | **UPDATE** | `Item` `:306-331`; `Subagent` `:345-366`. No kind/effort fields. |
| `agent.go:76-118` events | **UPDATE** | `Event` `:79-102`; `Sub` comment still “Claude's Agent tool_use, Cursor's Task tool_call” — Pi’s `subagent` tool is missing from the comment. |
| Adapters `claude.go:214-232,267-302`; `cursor.go:640-660,750-785` | **UPDATE** | Claude `readLoop` `:205-236`, `handleControl` `:238-256`, `Decide` `:265-277`, `Close` `:305-316`. Cursor those lines are now MCP normalize (`:687-721`) and MCP auto-approve (`:817-821`), not command rewrite. |
| Steering `claude.go:73-81`, `whiteboard.md`, `cursor/config.go:27-91` | **UPDATE** | `claude.go:72-81` = app-dir disallow + MCP allowed list (no Task/Agent yet). `whiteboard.md` still the board prompt (`{{ACCESS}}` / `{{TOOLS}}`; `{{TOOLS}}` is filled with `""`). `config.go:27-98` still app-folder deny in user-global CLI config. |
| Web `subagents.ts:9-36,82-101`; `Subagents.tsx:74-82`; `types.ts:198-224`; `labels.ts:22-42`; e2e `:751,823` | **UPDATE** | `isSubagentTool` `:9-10`; `subagentOf` `:18-34`; `subModelLabel` `:85-104`; `SubagentRow` `:74-94` (open gate `:82`); `types.ts` Item `:188-206`, Subagent `:211-231`; `labels.ts` `genericTool` `:28-48` (`Task`/`Agent` `:40`), `short` `:22`; e2e step 18 `:861`, step 19 `:933`. |
| `defaults.go:18-51`; `manager.go:641-746`; `claude/catalog.go:8-15`; `cursor/catalog.go`/`probe.go` | **UPDATE** | `Resolve` `defaults.go:16-51`; `AgentOrder` includes Pi `:12-14`. `Configure` `manager.go:648-728`. `claude/catalog.go:7-15`. Cursor `catalog.go` (127 lines) and `probe.go` (70 lines) exist. Pi `internal/pi/catalog.go` is new. |
| No concurrency caps in `internal/`; depth-1 explicit at spawn check; restart rewrite (`subagents.go:54-58`); JSON fields additive-safe. | **KEEP** | `loadSubs` rewrite is `:56-59`. |

---

## 8. Open questions

| Q | Original | Class | Now |
|---|---|---|---|
| Q1 | Exact Claude CLI MCP tool-call timeout and override env unverified. Phase 2 measures a blocking call. Result only derives `wait_subagents` interval. | **UNKNOWN** | Still unmeasured. Scope the measurement to Claude **and** Cursor **and** Pi against `http://localhost:6006/mcp`. |
| Q2 | Whether Cursor can scope a native-Task deny to board sessions; v1 instruction-only; §6 must observe the command path or qualify “instead of native” to Claude. | **UPDATE** | **Settled that a deny exists:** ACP `preToolUse` hook, matcher `^Task$`, per-project file under `CURSOR_DATA_DIR` (`cursor-task-deny.md`). It does not remove `Task` from the model’s tool list; every call is refused. `cli-config.json` `permissions.deny` cannot do it. Whether the subagents feature *uses* the hook is a product decision (not forced). “Observe the command path” is INVALID. Remaining UNKNOWN: hook stability across Cursor upgrades (the research already flags this). |
| Q3 | Exact native Claude tool names (`Task` vs `Agent`) across bundled versions; disallow both; unknown rule harmless. | **UPDATE** | Still do both for Claude. Also: Cursor native name is `Task` (`cursor.go:688-691`, `isTaskTool`; e2e step 19 says “Use the Task tool”). Pi native name is `subagent`, displayed `Agent` (`pi/translate.go:224-226`). |
| Q4 | Delayed reconciliation window vs real CLIs; widen if needed. | **UNKNOWN** | Still unmeasured. Capture against header MCP, all three agents. |

Settled during original review and still **KEEP** (product, independent of the unified endpoint): async spawn contract; no concurrency caps; nesting depth fixed at 1; subagents keep board access without a spawn surface.

---

## 9. MCP tool naming (`mcp__board__spawn_subagent`)

**KEEP.** The web name `mcp__board__spawn_subagent` is still the right recognition string:

- MCP `serverInfo.name` is `"board"` (`mcp.go:224`); Claude therefore names tools `mcp__board__<tool>` (comment `mcp.go:152-155`).
- Cursor normalizes board MCP calls to `"mcp__board__" + tool` (`cursor.go:694`).
- Pi already emits `mcp__board__*` (`pi/translate.go:221-227`).
- Web strips that prefix for labels (`labels.ts:22`, `ChatView.tsx:17,179`).

The MCP **wire** name (what `tools/list` returns) is the bare `boardtools` name (`list_boards`, …). The **UI / `--allowedTools` / Cursor-normalized** name is `mcp__board__` + that. `isSubagentTool` must match the **item name the adapters emit**, i.e. `mcp__board__spawn_subagent`, not `spawn_subagent`. That distinction was already in the original plan and is still right.

---

## 10. Product decisions that should survive

Unless the later planner is explicitly told to change product, these stay. None of them require `/mcp/<token>` or the command endpoint.

1. Board chats only; plain chats keep native subagents.
2. Server-side spawn through the app’s own adapters, replacing native spawning on board chats.
3. Three tools: `spawn_subagent`, `wait_subagents`, `stop_subagent`. No `background` parameter.
4. Spawn is always async: immediate sid receipt; results only via `wait_subagents` (repeatable, timeout 0 = poll). Wait budget from measured CLI MCP timeout.
5. One subagent per spawn call; parallel = several calls.
6. Depth exactly 1: only the chat agent may spawn; subagents never receive spawn-family definitions; hallucinated calls are rejected as tool text and start nothing.
7. No app-imposed concurrency cap on sibling spawns.
8. UI parity with native subagents (row, drawer, status, duration, ctx meter, background chip). No per-sub stop UI, no sidebar entry, no SSE shape change.
9. Errors are MCP tool text with `isError`, never HTTP errors. (Command `ERROR: ` dies with the command path.)
10. Spawn-family must not go through `Relay.Call` / `Bridge.Call` (would hit `NoClientText` + 30 s board timeout).
11. Defaults: omitted agent = chat kind; omitted model/effort = chat current; validate explicit values like `Configure` against the **requested** kind’s catalog.
12. Additive persisted subagent fields: agent kind + effort. Caller identity is not persisted.
13. Claiming: oldest pending unclaimed matching spawn item in the chat thread; delayed reconciliation; accepted residual for byte-equal parallel args; ask for distinct descriptions.
14. Lifecycle: stop/interrupt/abort/exit/archive/delete/shutdown kill app-spawned processes; restart marks stopped; normal turn end leaves them running; close processes outside `c.mu`.
15. Permissions: subagents use the chat’s permission mode; requests are parent-transcript items with sid; `Decide` must reach the sub process.
16. Window-closed spawn works; board tool calls still need the window.
17. Claude board chats: deterministic disallow of native `Task` and `Agent`.
18. Subagents keep board access (read/draw) on the parent chat’s board.
19. Do not reuse `pump` for app-spawned runs; reuse `subagents.go` persist/emit/link/end.
20. Every app-spawned run is flagged background so the spawn receipt is never shown as a report.
21. Frozen UI tool name: `mcp__board__spawn_subagent`.

**Forced by the new architecture (not optional wording):**

- All agents (Claude, Cursor, **Pi**) use `http://localhost:6006/mcp` with header identity.
- Per-caller identity, if kept, is extra header credentials on that URL, not `/mcp/<token>`.
- Cursor parity is MCP, not a command endpoint.
- D5/Q2 must be re-opened against `cursor-task-deny.md` (hook deny is now a real option).

---

## 11. Counts

Counted items are the numbered rows in §§1–8 (S, R, D1–D8 subclaims, C, phases, V, §7 refs, Q). Mixed rows are counted once, as the class of the stale phrase. Top-level D/phase labels are not double-counted.

| Class | Count |
|---|---|
| KEEP | 63 |
| UPDATE | 46 |
| INVALID | 15 |
| UNKNOWN | 3 |
| **Total** | **127** |

UNKNOWN three (numbered): Q1 timeout value; D3.b captured real `tools/call` correlation; Q4 reconciliation window. Residual, not numbered: hook stability across Cursor upgrades (Q2 leftover).

If a later planner only walks **D1–D8 and phases**:

| Item | Class |
|---|---|
| D1 | UPDATE |
| D2 | UPDATE |
| D3 | UPDATE |
| D4 | KEEP |
| D5 | UPDATE |
| D6 | KEEP |
| D7 | KEEP |
| D8 | INVALID |
| Phase 1 | KEEP |
| Phase 2 | UPDATE |
| Phase 3 | UPDATE |
| Phase 4 | KEEP |
| Phase 5 | UPDATE |
| Q1 | UNKNOWN |
| Q2 | UPDATE (deny exists; whether to use it is product) |
| Q3 | UPDATE |
| Q4 | UNKNOWN |
