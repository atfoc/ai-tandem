# Native subagent machinery at HEAD

Facts only, against worktree `/Users/pedjat/Documents/projects/ai-whiteboard-worktrees/mcp-subagents-plan` at `b15640a`. Line numbers are current files. Not a plan.

Verified facts use `path:line`. Anything not pinned that way is in **Assumptions** or **Unresolved**.

---

## 1. How a native subagent is created, linked, run, reported, and shown

### Parent process, not a second `Chat.ag`

A chat has one agent process: `Chat.ag` (`internal/chats/manager.go:54`). `Manager.spawn` starts it on first `Send` (`manager.go:181–223`) via `Deps.Spawners[c.meta.Agent]` (`manager.go:195–210`). Subagents are **not** started by `Manager.spawn`. They appear as events on that same process’s `Events()` channel, tagged with `Event.Sub` = the parent Agent/Task tool-call id (`internal/agent/agent.go:124–128`).

Who actually starts the child:

| Agent | Parent tool the model sees | What the adapter emits as the tool card name | Who starts the child |
|---|---|---|---|
| Claude | Agent | `"Agent"` (Claude’s `tool_use` name, passed through) | Claude Code, after `--forward-subagent-text` + initialize `{agentProgressSummaries, forwardSubagentText}` (`internal/claude/claude.go:60`, `176–182`) |
| Cursor | Task | `"Agent"` — `normalizeTool` remaps Task → `"Agent"` (`internal/cursor/cursor.go:688–691`) | Cursor ACP `subagent_spawned` after `clientCapabilities._meta.subagents` (`cursor.go:166–169`, `501–541`) |
| Pi | `subagent` | `"Agent"` — `normalize` rewrites `"subagent"` → `"Agent"` (`internal/pi/translate.go:221–228`) | App extension `runSubagent` spawns `pi --mode rpc` (`internal/pibridge/extension/subagent.ts:448–618`, registered in `index.ts:223–248`) |

The UI treats **both** `"Agent"` and `"Task"` as subagent tools (`web/src/logic/subagents.ts:9–11`). At HEAD the three adapters all emit `"Agent"` on the parent card.

### Create + link (server)

`pump` sends any event with `Sub != ""` except `EvPermRequest` to `routeSub` (`manager.go:496–502`).

`routeSub` (`internal/chats/subagents.go:117–164`):

1. Look up `c.subByTool[ev.Sub]`.
2. If missing, `owner` finds the thread that already holds that tool call (`subagents.go:102–114`): chat transcript first, else any **already-loaded** sub transcript (`s.tr != nil`). Events whose tool id no loaded thread holds are **dropped** (`subagents.go:123–125`; `TestSubagentUnknownTool` `manager_test.go:1613–1628`).
3. First event: mint `sid = randHex(6)` (12 hex chars), `Status=running`, `Started=nowMs`, empty `items.jsonl` via `transcript.New`, index in `c.subs` / `c.subByTool` (`subagents.go:126–129`).
4. `link` writes `Item.Subagent = sid` on the parent tool item (`subagents.go:166–176` → `transcript.LinkSubagent` `internal/transcript/transcript.go:314–324`) and emits `chat_items` (parent `""`) or `sub_items` (nested, `parent` = outer sid).
5. Then apply the event (see §2). New subs are written immediately (`saveSub` `subagents.go:157`).

`owner` cannot see a nested parent whose `tr` is still nil. Nested create in tests works because the outer sub’s first event already set `s.tr` (`TestNestedSubagent` `manager_test.go:1632–1677`).

### Run

Child activity is events with `Sub` set: text, tools, thinking, `EvSub` patches. `routeSub` applies them to the **sub** transcript, not the chat transcript (`subagents.go:144–152`). Parent chat items/status/view are unchanged (`TestSubagentThread` `manager_test.go:1518–1545`).

`EvThinking` with `Sub` set applies to the sub transcript (`transcript.Apply` `transcript.go:154–157` returns nil updates) so the client is sent nothing (`TestSubagentThinkingSendsNothing` `manager_test.go:1599–1611`).

### Report / end

A final `EvSub` (`SubInfo.Status` not running, and `sa` still running) calls `endSub` (`subagents.go:134–137`, `178–185`):

- `CloseOpen` on the sub thread
- `Last = tr.LastText()`
- flush thread + `subagent.json`
- emit `sub_items` + `sub`

`patchSub` (`subagents.go:198–233`): first final status wins; later `"completed"` cannot overwrite `"stopped"`; non-status fields still apply (late usage, summary). Late **thread** lines of an ended sub are dropped (`subagents.go:139–140`). Late `EvSub` patches with no new final status still apply (`TestSubagentEnd` `manager_test.go:1549–1608`).

UI report text (`web/src/logic/subagents.ts:56–65`): `sa.summary`, else foreground completed tool `result`, else last thread text / `sa.last`. Drawer “Report” block only if that text is not identical to last text (`showReport` `subagents.ts:67–70`; rendered `web/src/Subagents.tsx:167–172`).

### UI: row, drawer, status, duration, meter, background chip

**Row.** `ItemView` routes `kind:"tool"` through `isSubagentTool` → `SubagentRow`, else `ToolCard` (`web/src/ChatView.tsx:163`).

`SubagentRow` (`web/src/Subagents.tsx:69–88`):

- `subagentOf(item, subs, isBusy(chat.status))` (`logic/subagents.ts:18–34`)
- Linked: server `Subagent` plus input fallbacks for description/prompt/type
- Unlinked: built from the tool call; no result and not denied counts as `running` only while the chat is busy, else `stopped`
- Click opens the drawer **only if `sa.id` is set** (`Subagents.tsx:75`) — unlinked rows have nothing to open
- Running rows prefetch the sub thread (`useSubThread` `Subagents.tsx:20–24`, `74`)

**Status mark** (`Subagents.tsx:37–39`): running = pulsing dot; completed = `✓`; failed = `!`; stopped = `■`. CSS class `st-${status}`.

**Name** (`Subagents.tsx:41–48`): `description || "Subagent"`; type badge unless default general-purpose (`subBadge` `logic/subagents.ts:7, 37`); **background chip** `<span className="sub-bg">background</span>` when `sa.background`.

**Live line** (`subLine` `logic/subagents.ts:73–79`): running → `subActivity` (running tool verb, else Claude `progress`, else Writing…/Thinking…); completed → `Done · firstLine(report)`; failed → error; stopped → `"Stopped"`.

**Stats** (`SubStats` `Subagents.tsx:54–66`): model · effort (`subModelLabel`), tool count (`subToolCount`), duration (`subDurationMs` / `fmtDuration`), context meter.

**Duration.** `started` known → `(ended || now) - started`; live tick every 1s while running (`useNow` `Subagents.tsx:27–35`, `subDurationMs` `logic/subagents.ts:124–126`). Null if `started` missing.

**Context meter.** `SubMeter` (`Subagents.tsx:50–53`): hidden when `tokens` is 0; else `CtxRing` from `Composer.tsx` with `tokens` / `window`. Cursor fills these by polling the child sqlite store every 1s (`internal/cursor/ctxusage.go:213–275`). Claude/pi send them as `EvSub` patches.

**Drawer.** `SubagentDrawer` mounted at app root (`web/src/App.tsx:74`). Gate (`Subagents.tsx:106–111`): hidden unless `sel.chat === subDrawer.chat` **and** (plain chat **or** board chat with `panel` true). Esc closes the drawer only, capture-phase, and does not stop the chat (`Subagents.tsx:125–137`). Nested nav `‹ n/N ›` over `subList` (all subs of the chat, nested included, by `started` then `id`). Prompt clamped at 8 lines / 600 chars. Thread via `ItemView` with `sub=` so inner Agent/Task rows nest and inner tools are `live` only while this sub is running (`ChatView.tsx:26–27, 163, 174–175`).

**Tool-card labels** (fallback if a subagent call is not routed as a row): `genericTool` cases `"Task"` and `"Agent"` → `"Subagent working|finished: <description>"` (`web/src/logic/labels.ts:41`). Pi’s raw name `"subagent"` is not in that switch; adapters rewrite it to `"Agent"` first.

---

## 2. Event loop / pump — reuse vs not

**There is no per-sub event loop.** One `pump` goroutine per parent `Chat.ag` (`manager.go:209`, `487–567`).

`pump` writes into **chat-level** state unless the event is a non-perm sub event:

| Event | Chat-level effect |
|---|---|
| `EvSession` | `c.meta.SessionID` (`511–512`) |
| `EvCatalog` | store catalog + `catalog` broadcast (`513–520`) |
| `EvUsage` | `c.meta.Usage` (`521–536`) |
| `EvTurnEnd` | `Usage.Turns++`, `TurnActive=false` (`537–539`) |
| `EvExit` | `c.ag = nil` (`540–541`) |
| all of the above plus others | `c.tr.Apply(ev)` (`543`) then maybe `stopSubs`, `TurnActive` for unrequested turns, flush, `chat_items` / `chat` |

Sub events (`ev.Sub != ""` && kind ≠ `EvPermRequest`) **do not** hit `c.tr.Apply`, do not change chat view/status/usage, and `continue` after `routeSub` (`496–502`). `transcript.Apply` has **no** `EvSub` case (`transcript.go:151–270`); `EvSub` is manager-only.

`EvPermRequest` with `Sub` set is remapped `ev.Sub = c.subByTool[ev.Sub]` (tool id → sid, or `""`) then applied to the **parent** transcript (`504–506`, `543`). The perm item stores that sid in `Item.Subagent` (`transcript.go:238–239`).

`stopSubs` from pump (`545–548`): on **aborted** `EvTurnEnd` or any `EvExit`. Comment: background Claude subs outlive a **normal** turn end; they die with the process on interrupt/exit. Encoded in `TestSubagentsStoppedOnAbortedTurn` / `TestSubagentsStoppedOnExit` (`manager_test.go:1738–1777`).

Unrequested parent busy (Claude when a background sub finishes) sets `TurnActive` (`549–553`; `TestUnrequestedTurnSetsTurnActive` `manager_test.go:1861–1876`).

Generation guard: events of a replaced process (`gen != c.gen`) are dropped (`491–495`). `Stop` / `Delete` bump `gen` (`manager.go:906`, `947`).

**What a later planner can reuse**

- `routeSub` / `link` / `patchSub` / `endSub` / `stopSubs` / `loadSubs` / `subagent.json` + per-sid `items.jsonl`
- SSE `sub` / `sub_items` and the web store/drawer
- `Event.Sub` + `SubInfo` as the adapter→manager contract (`agent.go:124–162`)

**What must not be assumed reusable as a child runner**

- `pump` itself: it is the **parent process** loop. It does not spawn, Send, Interrupt, or Decide a child `agent.Agent`. Children today are either inside the parent CLI (Claude/Cursor) or, for pi, child processes whose activity is **funneled into the parent’s `Events()`** (`pi.proc.Activity` → `emitEvents` `internal/pi/subagent.go:29–50`, `89–92`).
- `Chat.ag` / `Manager.spawn` / `spawnOptions`: one session per chat (`manager.go:181–223`, `471–484`). No second SpawnOptions for a sub.

---

## 3. Locking

`Chat.mu` is the chat lock. `Manager.lock` takes `c.mu` after releasing `m.mu` (`manager.go:185–197`).

**Outbox vs editor bridge.** Events are collected under `c.mu` and broadcast **after** unlock (`manager.go:82–89`, comment `82–84`). Reason: `editorbridge` snapshot runs under the bridge lock (`internal/editorbridge/bridge.go:304–321`) and `App.Snapshot` calls `Chats.Views()`, which locks every chat (`internal/app/app.go:49–73`; `manager.go:256–270`). Rule: **never take the editor-bridge lock under a chat lock.** `pump` unlocks, then `m.send(out)` → `Bridge.Broadcast` (`editorbridge/bridge.go:190–200` takes `b.mu`).

**Holds `c.mu` around spawn / send / stop / decide**

| Call | Lock | Agent I/O under the lock? |
|---|---|---|
| `spawn` | held (`manager.go:181`) | **Yes** — `sp.Spawn(opts)` (`197`) |
| `Send` | held through spawn + transcript write; **released before** `ag.Send` (`628–637`) | Send: no |
| `Interrupt` | released before `ag.Interrupt` (`857–864`) | no |
| `Decide` | held through `c.ag.Decide` (`867–892`) | **Yes** |
| `Stop` | held through `Interrupt` + `Close` + `stopSubs` (`877–921`) | **Yes** (Close). Cursor `stopChild` waits for the usage poller (`cursor/ctxusage.go:241–250`) |
| `Shutdown` | held per chat; `Close` is `go c.ag.Close()` (`1071–1073`) because “Cursor’s Close waits for the process, forever when its children hold its output” | Close not waited |
| `SubItems` / `Items` / `loadSubs` / `routeSub` | held | disk I/O only |

`pump` holds `c.mu` for the whole event (including `saveSub` / `Flush`) and does not call `Send`/`Interrupt`/`Decide`.

Pi `Permission` documents “No mutex is held here” (`internal/pi/perm.go:14`) — that is the **adapter** answering the bridge, not `Chat.mu`.

---

## 4. Lifecycle

### Interrupt (user Stop button → `POST /api/chats/{id}/interrupt`)

`Manager.Interrupt` (`manager.go:854–864`): unlock, then `c.ag.Interrupt()`. Does **not** call `stopSubs`. Subs flip to stopped when the adapter later emits aborted `EvTurnEnd` or `EvExit` (`pump` `545–548`).

Adapter Interrupt:

- Claude: stdin `control_request` subtype `interrupt` (`claude.go:300–303`)
- Cursor: ACP `session/cancel` (`cursor.go:321–331`)
- Pi: RPC `abort` **and** `Bridge.AbortRun` so the extension kills child process trees (`pi.go:399–412`; `pibridge/bridge.go:225–233`; extension `openControl(..., killChildren)` `index.ts:272`)

### Stop (archive, delete, board delete)

`Manager.Stop` (`manager.go:877–921`): deny open parent perms via `c.ag.Decide(..., false)`; bump `gen`; `Interrupt` + `Close`; **`stopSubs` (state-only)**; if was busy, parent note `"Stopped."`; `TurnActive=false`; status ready.

Archive goes through `App.archiveChat` → `Stop` then `SetArchive` (`internal/app/app.go:310–313`). `SetArchive` itself does not stop (`manager.go:923–934`).

Delete: `Stop`, mark `deleted`, extra `Close` if a racing Send respawned, `RemoveAll` chat dir (subagents included) (`manager.go:936–957`; `TestDeleteRemovesSubagents` `manager_test.go:1879–1891`).

### Abort / process kill vs state-only `stopSubs`

`stopSubs` (`subagents.go:187–195`) only sets running → `stopped` + `Ended` and `endSub`. It does not kill OS processes. Killing is the parent adapter’s `Interrupt`/`Close` (and pi `AbortRun`).

`Close`:

- Claude: close stdin, kill after 3s (`claude.go:306–317`)
- Cursor: stop child **pollers**, `conn.Close` (`cursor.go:854–858`). Poller stop is not a process kill of Cursor’s subagent sessions
- Pi: `DeregisterRun`, close stdin, SIGTERM then SIGKILL the **process group** so children sharing the group die (`pi.go:424–448`). Pi **child** trees are also killed by PID (never negative pgid) in `killProcessTree` (`subagent.ts:248–273`) because the child shares the parent pi group (`subagent.ts:1–5`)

### Normal turn end

Non-aborted `EvTurnEnd` does **not** `stopSubs` (`manager.go:545–548`; `TestSubagentsStoppedOnAbortedTurn` `1738–1750`).

### Restart / `loadSubs`

`Load` does not read `items.jsonl` or subagents (`manager.go:218–249`). First `trOf` loads the chat transcript then `loadSubs` (`manager.go:156`).

`loadSubs` (`subagents.go:31–61`): every `subagents/<sid>/subagent.json`; skip if unreadable or `ID != folder` or `Tool == ""`; **if `Status == running`, rewrite to `stopped` + `Ended=now` and save.** Process is already gone. `TestLoadStopsRunningSubagents` `manager_test.go:1781–1799`.

`Shutdown` (`manager.go:1056–1076`): flush parent + every sub with `all=true` (open items written); **running subs stay running on disk**; next `loadSubs` marks them stopped (`1059–1060`; `TestShutdownWritesSubagents` `1803–1819`).

### Late events after stop

Ended sub: non-`EvSub` events dropped; `EvSub` still patches non-status fields (`subagents.go:139–140`, `198–233`).

---

## 5. Permissions — `Manager.Decide` and parent-transcript cards

`Manager.Decide` (`manager.go:867–892`) always calls **`c.ag.Decide`** — the **parent** process only. There is no `Decide` on a sub `agent.Agent` (none exists).

If `c.ag == nil` → `"the agent is not running"`. Then `tr.Decided` on the **chat** transcript (perm items live there).

How a sub’s ask becomes a parent perm item:

1. Adapter emits `EvPermRequest` with `Sub` = parent tool-call id
2. `pump` remaps to sid (`manager.go:504–506`)
3. `Apply` pushes `kind:"perm"` with `Subagent: ev.Sub` (`transcript.go:232–239`)
4. Chat status → `approval`; sub thread unchanged (`TestSubagentPermission` `manager_test.go:1678–1693`)

UI: `PermCard` shows `Asked by subagent · {description}` when `item.subagent` is set (`ChatView.tsx:209–222`). Allow/Don’t → `POST /api/chats/{id}/permission` (`server.go:585–593`).

### Per adapter

**Claude.** `can_use_tool` control request; `Sub: p.taskTool[agent_id]` (`claude.go:238–256`). App-dir inputs denied with no card (`247–250`). `Decide` writes allow/deny on the **same stdin** (`265–278`) — reaches the parent Claude process, which owns sub tasks.

**Cursor.** Permission request; if `req.SessionID` is a known child, `Sub = c.tool` (`cursor.go:831–836`). Board MCP auto-allowed (`818–821`). `Decide` replies on the parent ACP connection (`839–851`). Child sessions are not separate `Agent`s.

**Pi.** Extension auto-allows `subagent` and app-sourced `mcp__board__*` (`permissions.ts:16–18, 72–75`; `index.ts:250–267`). Every other tool sends a bridge `ask`; child runs attach `frame.sub` from `AIWB_SUB_*` (`permissions.ts:104–106`). Adapter `Permission` **always allows** except app-dir (`pi/perm.go:10–20`) — **no permission cards**. `Decide` always errors `unknown permission request` (`perm.go:22–26`).

`TestSubagentPermissionWhileIdle` (`manager_test.go:1697–1714`): perm after `EvTurnEnd` still goes to parent `Decide`, then `Send` is allowed.

---

## 6. Persistence — `subagent.json`

Path: `chats/<chat>/subagents/<sid>/subagent.json` plus `items.jsonl` (`subagents.go:1–2, 27–29`; `model.Subagent` `internal/model/model.go:343–369`).

Fields on `model.Subagent` (`model.go:347–369`):

| JSON | Meaning |
|---|---|
| `id` | App sid = folder name (`randHex(6)`) |
| `tool` | Parent Agent/Task tool-call id |
| `parent` | Outer sid, or omitted = chat thread |
| `agentId` | Claude `task_id`, Cursor `subagentSessionId`, pi child session id |
| `type` | Reported type (`general-purpose`, `Explore`, custom, …) |
| `description`, `prompt` | Parent’s label and instruction |
| `model` | Reported model string (Cursor may embed effort, e.g. `gpt-5.4-mini-medium`) |
| `background` | bool, omitempty |
| `status` | `running` \| `completed` \| `failed` \| `stopped` |
| `error`, `summary`, `progress`, `last` | |
| `tokens`, `window`, `toolUses` | |
| `started`, `ended` | unix ms, set by the app |

**Not stored:** parent agent kind (`claude`/`cursor`/`pi` lives on `chat.json`); a separate effort field (Cursor effort is inside `model`; Claude reports none; pi has `thinking` only on the child spawn, not on this struct).

**Additive extras:** `json.Unmarshal` ignores unknown fields. `saveSub` writes the typed struct via `store.WriteJSONAtomic` (`subagents.go:75–90`; `internal/store/store.go:17–35` `json.MarshalIndent`). Unknown extras are **not** round-tripped.

`saveSub` is a no-op when `meta == saved` (`subagents.go:77–79`). Usage-only patches therefore wait for a real write point (end, shutdown, first create, tool result flush). `TestShutdownWritesSubagents` shows tokens not on disk until shutdown (`manager_test.go:1808–1814`).

Pi also creates `chats/<chat>/subagents/<childId>/pi` as the **child pi session dir** (`subagent.ts:174–176`), where `childId` is `"s"+12 hex` — **not** the app sid. Two different folder names can exist under `subagents/` for one pi child.

Load skip rule: `ID != folder name` or empty `Tool` (`subagents.go:50–53`).

---

## 7. Web entry points (exact names)

| Symbol | Current behavior |
|---|---|
| `isSubagentTool` | `kind==="tool"` && (`name==="Agent"` \|\| `name==="Task"`) (`logic/subagents.ts:9–11`). Not `"subagent"`, not perm items. |
| `subagentOf` | Linked state + input fallbacks; unlinked inferred (`18–34`) |
| `subReport` / `showReport` | `60–70` |
| `subModelLabel` | Cursor: id prefix + effort suffix; Claude: alias contained in full id; Pi: exact or catalog id `endsWith("/"+id)` (`87–107`) |
| Tool-card labels | `"Task"` and `"Agent"` only (`logic/labels.ts:41`) |
| Drawer-open gate | `sa.id` required (`Subagents.tsx:75`); drawer shown iff selected chat matches **and** (`!board \|\| panel`) (`106–111`) |

SSE (`web/src/conn.ts:40–42`): `sub` → `upsertSub`; `sub_items` → `applyItems(subKey(chat,sid), …)`. Chat `GET /api/chats/{id}/items` returns `{version, items, subagents}` (`server.go:478–490`). Sub thread `GET /api/chats/{id}/subagents/{sid}/items` (`491–501`; `api.ts:70`).

Store: `subs[chatId][sid]`, threads at `items[chatId]` and `items[chatId+"/"+sid]` (`store.ts:29–31`; `subKey` `logic/subagents.ts:14`). Snapshot clears both (`store.ts:109–110`).

---

## 8. Pi-specific behaviour

### Commit `669487f` “fix seq subagent execution”

Diff (HEAD still has the result):

- `internal/pibridge/extension/index.ts:228–230` — **no** `executionMode: "sequential"` on the `subagent` tool. Comment: a sequential tool in a batch would serialize the whole batch, leaving sibling subs stuck at “Thinking…”.
- `mcp-wiring.ts:141` — description line: `"Call it several times in one message to run subagents in parallel."`

Board MCP tools **are** registered `executionMode: "sequential"` (`mcp-wiring.ts:237`, `index.ts:165`). That does not apply to `subagent`.

### Concurrency, nesting, caps

- Sibling `subagent` calls in one assistant message: concurrent (no `executionMode`). No numeric cap found in extension or adapter.
- Nesting: allowed. Child env `AIWB_SUB_DEPTH = parentDepth+1` (`subagent.ts:178–184`). No max-depth guard found. Nested activity can arrive before the inner Agent card; adapter queues up to `maxQueuedActivity = 1024` until `EvToolStart` announces that parent tool id (`pi/subagent.go:11–12, 25–28, 52–64`; `pi.go:216–217, 223–226`).
- Child spawn: `pi --mode rpc --no-extensions -e <app extension> --session-dir <chat>/subagents/<childId>/pi --session-id <childId> --no-approve` (`subagent.ts:186–199`). Inherits `AIWB_MCP_CONFIG` so board children keep board MCP (`index.ts:193–196`; `agent/bridge.go:18–20`).
- Background: tool result returns immediately `{status:"running", background:true}` (`subagent.ts:678–683`); `done` still streams on the bridge.
- Abort: SIGTERM tree by positive PIDs, then SIGKILL after `killWaitMs` (default 3000) (`subagent.ts:248–273, 390–397`). Bridge `abort` runs every registered killer (`index.ts:69–77, 272`).
- `PI_SUBAGENT` and other pi markers are stripped from the **parent** app-run env so an installed spawn-subagent extension does not disable itself (`pi/args.go:12–24, 78–89`).

`internal/pibridge` is the UDS bridge (ask / activity / hello / notice / abort), not a second pump. `dispatch` does not hold the registry lock while calling the handler (`bridge.go:347–349`). `AbortRun` writes `{kind:"abort", run}` to live conns (`225–233`).

---

## 9. `agent.Spawner` / `SpawnOptions` — no app-spawned MCP subagent runner

`SpawnOptions` (`internal/agent/agent.go:15–23`): `ChatID`, `SessionID`, `Resume`, `Cwd`, `Model`, `Effort`, `Board *BoardAccess`. No subagent id, parent tool, depth, or prompt.

`Spawner.Spawn` (`agent.go:30–32`): starts **one** process, returns at once. Wired in `cmd/ai-whiteboard/main.go:159–162` as Claude / Cursor / Pi only.

`Manager.spawnOptions` (`manager.go:471–484`) fills those fields from **chat** meta. Board chats get `BoardAccess{MCPURL, Token}`. That is the parent session.

Board MCP tools at HEAD (`internal/boardtools/tools.go`): `list_boards`, `read_board`, `get_view`, `apply`, `delete_elements`, `create_board`, `show_board`. None spawn a subagent.

**There is no app-spawned MCP subagent runner.** No MCP tool tells `chats.Manager` / `agent.Spawner` to start a child session. Pi children are spawned **inside the parent pi process** by the app extension, not by the Go manager.

---

## 10. Tests / e2e that encode this behaviour

### `internal/chats/manager_test.go`

Fakes: `fakeAgent` implements `Events`/`Send`/`Interrupt`/`Decide`/`Close` only (`36–74`). `fakeSpawner.Spawn` makes one `fakeAgent` per parent chat (`115–127`). Tests drive subs by emitting `Event{Sub: toolId, ...}` on that parent fake — they do **not** spawn a second agent.

| Test | Fact |
|---|---|
| `TestSubagentCreatedOnFirstEvent` 1481 | first `EvSub` creates folder, json, link, `sub` SSE |
| `TestSubagentThread` 1518 | sub events → `sub_items` only; parent unchanged |
| `TestSubagentEnd` 1549 | close open text, `Last`/`Summary`/`Ended`; late text dropped; late tokens kept; late stop ignored |
| `TestSubagentThinkingSendsNothing` 1599 | |
| `TestSubagentUnknownTool` 1613 | unknown tool id dropped; no folder |
| `TestNestedSubagent` 1632 | inner `parent=outer`, link on outer `sub_items` |
| `TestSubagentPermission` 1678 | perm on parent, sid on item, empty sub thread |
| `TestSubagentPermissionWhileIdle` 1697 | Decide after turn end; Send allowed |
| `TestStopMarksSubagentsStopped` 1717 | `Stop` → stopped + json |
| `TestSubagentsStoppedOnAbortedTurn` 1738 | normal turn end leaves running; aborted stops |
| `TestSubagentsStoppedOnExit` 1763 | `EvExit` stops even after ready |
| `TestLoadStopsRunningSubagents` 1781 | shutdown leaves running; boot rewrites stopped |
| `TestShutdownWritesSubagents` 1803 | flush tokens + open text; status still running |
| `TestItemsAndSubItems` 1823 | sort by Started; SubItems; persist across boot |
| `TestDeleteRemovesSubagents` 1879 | chat dir gone |

### `web/test/subagents.test.ts`

Pins `isSubagentTool` to Agent and Task only (`16–21`); `subagentOf` linked/unlinked; badge; activity; line; report/showReport (foreground result vs background last text); `subModelLabel` for cursor/claude/pi; tool count; duration; `subList` nested order.

`web/test/labels.test.ts:65–66`: Task → “Subagent working|finished: …”.

### `web/e2e/app.e2e.mjs`

- Step 18 (`861–931`): Claude, **Agent** tool twice in parallel; rows + pulsing dots then `✓`; drawer prompt + `1/2`/`2/2`; Esc closes drawer not the chat; reload; opening a row `GET .../subagents/{sid}/items`; folder has `subagent.json` + `items.jsonl`.
- Step 19 (`933–988`): Cursor, **Task** tool two parallel `sleep 20`; running meters with a digit; composer Stop → both `■` / `"Stopped"` + parent `"Stopped."` note; still stopped after reload; json `status==="stopped"`.

No web e2e for pi subs. Pi gated e2e: `internal/pi/e2e_test.go` `TestE2ESubagent` (`529–660`, `AIWB_PI_E2E_SUBAGENT=1`): foreground complete + no leftover processes; abort kills child tree; board-chat child calls `mcp__board__list_boards`. Adapter must emit an `"Agent"` tool card (`563–575`).

### Extension unit tests

`internal/pibridge/extension/test/subagent.test.ts` — fake pi child, activity frames, spawn failure, nested depth+1. `permissions.test.ts` — `subagent` auto-allowed; raw board names not auto-allowed. `internal/pibridge/concurrency_test.go` — interleaved ask/activity per run; `AbortRun`.

---

## Assumptions

- Claude’s live tool name is `"Agent"` because tests, e2e, and comments use that; this file did not dump a live Claude `tool_use` payload at HEAD.
- Cursor’s model-facing tool remains Task; only the **app card name** is rewritten to `"Agent"` (`cursor.go:688–691`). e2e still tells the model “Use the Task tool”.
- `isSubagentTool` keeping `"Task"` is a client safety net for any payload that still uses that name; current adapters emit `"Agent"`.
- Process-group kill on pi `Close` is assumed to cover children that share the group; the extension still kills by PID because children **do** share the group (`subagent.ts:1–5`).

---

## Unresolved questions

1. After a restart, can a **new** nested subagent be created if the outer sub’s `tr` is still nil (`owner` only searches loaded threads, `subagents.go:107–113`)? Happy-path nested create in-process is tested; resume/restart nested create is not.
2. If MCP subagents become separate `agent.Agent` processes, nothing at HEAD pumps their `Events()` except by merging into the parent channel the way pi `Activity` does. There is no second `pump`.
3. Cursor child sessions: `Close`/`Interrupt` cancel the **parent** ACP session and stop **pollers**; whether Cursor itself tears down child sessions is inside Cursor, not asserted in unit tests (e2e Stop does end up with `status=stopped` on disk).
4. Pi `thinking` / model overrides exist on the extension tool schema (`index.ts:209–214`) but are not fields of `model.Subagent`. Whether the UI should show child thinking is unspecified by current types.
5. `loadSubs` skip (`ID != folder` or empty `Tool`) vs extra unknown JSON keys: extras are ignored on read and dropped on next write. No test pins forward-compat extras.
6. Board-chat drawer hidden when `panel` is false (`Subagents.tsx:109`): whether MCP-spawned board subs should keep that gate is a product question, not encoded beyond that line.
7. No in-repo cap on parallel pi children or nest depth. Behaviour under large fan-out is untested except the 1024 activity queue.
