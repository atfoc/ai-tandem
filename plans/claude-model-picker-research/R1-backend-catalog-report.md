# R1 — Backend catalog lifecycle (Go) — verification report

Author: research subagent (pi, DeepSeek V4.1 Flash). Scope: verify every research-document claim about the backend catalog flow in `plans/claude-model-picker.md`, plus the surrounding mechanics a planner needs. All line numbers were read from the working tree at HEAD `658f7bb` (branch `main`). No files were modified.

Legend: **CONFIRMED** = verified against code; **WRONG** = contradicted; **PARTLY** = directionally right but imprecise/off; **(not verified)** = outside code or CLI-behaviour claim not executed.

---

## 0. Claim-by-claim verdicts for the research document (in-scope claims)

| # | Claim in `plans/claude-model-picker.md` | Verdict |
|---|---|---|
| 1 | `internal/claude/catalog.go:8` has three entries `sonnet`/`opus`/`haiku` | CONFIRMED (`catalog.go:8-12`) |
| 2 | Labels "Sonnet 5", "Opus 5.5", "Haiku 4.5" | CONFIRMED (`catalog.go:10-12`) |
| 3 | "It came from the UI prototype's `MODELS2`" | **(not verified)** — no `MODELS2` anywhere in the repo (only the doc itself); the prototype is not in this repository |
| 4 | "has had exactly one commit (`6e9b17e`)" | CONFIRMED — `git log --follow --all` on the file shows only `6e9b17e6150f4711ccbb1ab2ddfcba8cab9b1430` (Fri Sep 25 2026) |
| 5 | "Every client gets it from `internal/app/app.go:50`" | PARTLY — line 50 is `cl := claude.Catalog`, but `Snapshot` then overrides it with a stored catalog if one exists for Claude (`app.go:64-68`). Correct as the built-in default, wrong as the unconditional source |
| 6 | "`internal/chats/manager.go:330` (`cat := claude.Catalog`)" | CONFIRMED (`manager.go:328-331`, inside `catalog()`) |
| 7 | Cursor and pi update at startup (`main.go:182-183`) | CONFIRMED |
| 8 | They update again during each chat (`cursor.go:246`, `pi.go:293`) | CONFIRMED |
| 9 | No `refreshClaudeCatalog` exists | CONFIRMED (only two refreshers, `main.go:347/361`) |
| 10 | "nothing calls `SetCatalog(model.Claude, …)`" | CONFIRMED — all non-test callers: `main.go:353` (Cursor), `main.go:367` (pi), `manager.go:526` (`c.meta.Agent`, and no Claude process emits `EvCatalog`) |
| 11 | "`model.go:69` documents stored catalogs as '(Cursor, pi)' only" | CONFIRMED — exact comment at `model.go:69` |
| 12 | "`adapters.md:406` says … Claude cannot [change]" | CONFIRMED — exact text at `plans/mcp-subagents-refresh/adapters.md:406` |
| 13 | `findModel` (`manager.go:770-780`) exact-matches and is called from `Configure` (`PATCH /api/chats/{id}`) | PARTLY — all confirmed, but `findModel` is also called by the MCP subagent path (`spawn.go:272,284,295,314`), which the doc omits |
| 14 | So `fable` / `claude-opus-5-5` fails with `unknown model` | CONFIRMED for `Configure` (`manager.go:707-711`, error text at `manager.go:779`, HTTP 400 via `server.go:571-573`) |
| 15 | `defaults.Resolve` (`defaults.go:36-47`) quietly switches an unknown saved model back to `sonnet` | CONFIRMED behaviourally (`defaults.go:35-40`, `cat.Default.Model == "sonnet"`); lines 36-47 are the fallback block, the function starts at line 18; test at `defaults_test.go:155-162` |
| 16 | "The app already sends this exact request on every Claude chat (`claude.go:203`)" | PARTLY — `claude.go:203-204` sends the `initialize` control request, but with two extra fields (`agentProgressSummaries`, `forwardSubagentText`) that the doc's one-line example omits |
| 17 | "`readLoop` then discards the answer at line 240 (`p.reply(sc.Bytes())`)" | PARTLY — `case "control_response":` is line 240, `p.reply` is line 241; `reply` (`ctxsplit.go:36-45`) routes the line to a registered waiter. Since nothing registers a waiter for the `init_…` request, the response is in fact dropped. Mechanism described slightly wrong, outcome right. The existing waiter helper is `proc.request` (`ctxsplit.go:49-69`): it registers a waiter in `p.replies` and returns the `response` payload |
| 18 | `claude.go:73` (`o.Model != "haiku"`) | CONFIRMED (`claude.go:73`) |
| 19 | `translate.go:224` and `web/src/logic/subagents.ts:106` match on `"-"+id` | CONFIRMED (`translate.go:224`; `subagents.ts:105-107`, the `id.includes("-" + m.id)` line is 106) |
| 20 | `internal/chats/namer.go:25` hardcodes `--model haiku` | CONFIRMED |
| 21 | Test fixtures at `app_test.go:603-613`, `defaults_test.go:11-22`, `subagents.test.ts:126-134`, `models.test.ts:68-74`, `app.e2e.mjs:69-70,474` hardcode the old list | PARTLY — ranges are off by ±2 and `defaults_test.go`'s `claudeCat()` (`:12-21`) is an independent hand-written fixture, not derived from `claude.Catalog`; the others verified (`app_test.go:604-611`, `subagents.test.ts:126-134`, `models.test.ts:70-74`, `app.e2e.mjs:69/474`) |
| 22 | "Commit `eaa7cdd` … only changed client-side filtering in `web/src/logic/models.ts`" | PARTLY — `git show --stat eaa7cdd` shows `web/src/logic/models.ts` **and** `web/test/models.test.ts` |
| 23 | "The web client … has no ID regex or allowlist, and catalogs are not kept in localStorage" | CONFIRMED — search/filter only (`web/src/logic/models.ts:32-55`); localStorage keys in the client are `aiwb.widths`/`aiwb.sel`/`aiwb.archived`/`aiwb.theme`/draft copies, never catalogs |
| 24 | "The installed app has the list built in … `bin/AI Whiteboard.app/Contents/MacOS/ai-whiteboard` carries the old labels" | CONFIRMED — the binary exists and `strings` finds "Sonnet 5", "Opus 5.5", "Haiku 4.5"; built by `scripts/build-app.sh:23-24` |
| 25 | "The current label is already wrong. The CLI now resolves `sonnet` to Sonnet 5.5 … Fable is missing entirely" | "Fable is missing" CONFIRMED (`catalog.go:10-12`); the CLI-resolution half is **(not verified)** — requires running the installed `claude` CLI |
| 26 | The `initialize` response shape (`response.response.models`, per-entry `value`/`displayName`/`description`/`supportedEffortLevels`, no context window) | **(not verified)** — no fixture in the repo and the CLI was not run. No code in the repo parses it |
| 27 | `internal/claude` never asks the CLI for models | CONFIRMED — `grep Catalog internal/claude/*.go` finds only `catalog.go` and `translate.go:223` |

---

## 1. `internal/claude/catalog.go` — contents and git history

File is 15 lines (`internal/claude/catalog.go`):

- `catalog.go:5` — package-level `var efforts = []string{"low", "medium", "high", "xhigh", "max"}` (shared slice, not copied per entry).
- `catalog.go:7` — doc comment `// Catalog is Claude's static model list, served to every client.`
- `catalog.go:8` — `var Catalog = model.Catalog{…}` (package-level mutable variable; nothing in non-test code assigns to it — verified by grep).
- Entries (`catalog.go:10-12`):

| ID | Label | Note | Efforts | ContextWindow | DefaultEffort |
|---|---|---|---|---|---|
| `sonnet` | "Sonnet 5" | "Balanced · 1M context" | `efforts` (low, medium, high, xhigh, max) | 1_000_000 | unset |
| `opus` | "Opus 5.5" | "Most capable · 1M context" | `efforts` | 1_000_000 | unset |
| `haiku` | "Haiku 4.5" | "Fastest · 200k context" | none | 200_000 | unset |

- `catalog.go:14` — `Default: model.ModelChoice{Model: "sonnet", Effort: "high"}`.
- No `Provider`, no `EffortLabels`, no `DefaultEffort` on any entry.
- Git history: exactly one commit, `6e9b17e` (see verdict table #4). No rename/move history.
- The `MODELS2` provenance is **not verifiable in this repository** (only occurrence of the string is the research doc itself).

---

## 2. The catalog data model — `internal/model/model.go`

Verified facts:

- `State` (`model.go:65-73`): `Catalogs map[AgentKind]*Catalog` with JSON key `"catalogs"` (`model.go:69`); legacy `Cursor *Catalog` with JSON key `"cursorCatalog"` (`model.go:72`, comment at 70-71).
- The comment near line 69 says exactly: `// last model list each agent reported (Cursor, pi)` — **CONFIRMED**; it excludes Claude.
- Reader: `func (s *State) Catalog(a AgentKind) *Catalog` (`model.go:78-89`). Nil-receiver safe (`:79-81`); returns the generic map entry if present; falls back to the legacy `State.Cursor` field **only for `model.Cursor`** (`:85-87`); returns nil otherwise.
- Writer: `func (s *State) SetCatalog(a AgentKind, c *Catalog)` (`model.go:93-98`). Initializes the generic map if nil and assigns `s.Catalogs[a] = c`; the legacy `cursorCatalog` field is deliberately left alone (`:91-92` comment). No validation, no copy — the pointer/slice is stored as given.
- `Catalog` (`model.go:115-118`): `Models []CatalogModel` + `Default ModelChoice`.
- `CatalogModel` (`model.go:120-129`): `ID`, `Label`, `Note` (omitempty), `Provider` ("pi only", omitempty), `Efforts` (omitempty; empty = no effort picker), `ContextWindow` (omitempty), `DefaultEffort` (omitempty), `EffortLabels` (omitempty, value→display name). JSON tags are lower camelCase.
- `ModelChoice` (`model.go:100-103`): `Model` + `Effort` (omitempty).

Persistence (this answers "memory only? disk?"):

- `Store` keeps `state.json` in memory and writes it after every change (`store.go:56-60`).
- `store.Open` reads `Root/state.json` (`store.go:63-90`); `Store.Update` runs the function under lock and on success does `WriteJSONAtomic(st.P.State, …)` (`store.go:99-107`).
- Path: `Root/state.json`, `Root` defaults to `~/.ai-whiteboard` (`store/paths.go:11-21`, `cmd/ai-whiteboard/main.go:95` `home` flag default `~/.ai-whiteboard`).
- Therefore a catalog set via `SetCatalog` is persisted on disk under `"catalogs"` (plus legacy `"cursorCatalog"` for old files) and reloaded at next boot.
- Test evidence for the semantics: `model_test.go:46-126` (legacy fallback, generic map wins, JSON round-trip).

---

## 3. Startup refresh for Cursor and pi (`cmd/ai-whiteboard/main.go`, `cursor/probe.go`, `pi/catalog.go`)

### Wiring

- Spawners are constructed at `main.go:148-151` (`cursor.Spawner{Bin: -cursor}`, `claude.Spawner{Bin: -claude}`, `pi.Spawner{Bin: -pi}`).
- `main.go:182-183`:
  ```go
  go refreshCursorCatalog(cursorSpawner, st, br)
  go refreshPiCatalog(piSpawner, st, br)
  ```
  Both are plain goroutines started just before `a = &app.App{…}` (`:184`) and immediately before `http.Serve` (`:218`); the HTTP listener is already bound at `:125`, and each probe can take up to 20 s, so a client that connects meanwhile gets the previous snapshot. They do not block startup.
- There is no ticker/repeat — one refresh per server start, no retry.

### Fetch — Cursor (`internal/cursor/probe.go:12-70`)

- Comment `:12-15`: short-lived `agent acp` in `os.TempDir()` only to read the model list; sends no prompt and never calls `session/set_config_option`.
- `:17` `dir := os.TempDir()`; `:18` `Start(s.bin(), []string{"acp"}, dir)`.
- `Start` (`cursor/acp.go:53-73`) runs the binary with `cmd.Dir = dir` (`:55`), **environment inherited unchanged** when no `extraEnv` (`:56-58`), stderr into a 4 KiB tail buffer (`:67-68`), own process group (`agent.StartGroup`, `:69`).
- Goroutine sequence `:29-56`: `initialize` (with the parameterized-model-picker capability, `cursor.go:164-179`) → `authenticate` (`cursor_login`) → `session/new{cwd: dir, mcpServers: []}` → `cursor/list_available_models`; `ParseModelList` (`cursor/catalog.go:81-126`) maps `value`→ID, `name`→Label (trailing effort word stripped), `thought_level` options→`Efforts`/`EffortLabels`/`DefaultEffort`, `context` option→`ContextWindow`; `setDefault(cat, reported)` (`catalog.go:59-68`) sets Default from session/new's model (falling back to the first entry).
- Timeout: one `time.NewTimer(timeout)` (`:58`), select at `:60-69`. Callers pass 20 s (`main.go:348`).
- Failure: any RPC error, an empty list, or the 20 s timeout returns `(nil, error)`; `defer conn.Close()` (`:22`) closes stdin, waits 3 s, then kills the process (`c.cmd.Process.Kill()`, `acp.go:181-192`, kill at `:189`; the process is in its own group, but `Close` kills only the process, not the group).
- Success: `s.remember(r.cat)` (`:65`) — a spawner-local cache used only for resumed sessions' catalog default (`cursor.go:32,49-60,236-246`); also returns the catalog.

### Fetch — pi (`internal/pi/catalog.go:142-205`)

- `:146-163`: `lookPath()` (absolute pi path, error names the binary, `pi/pi.go:70-79`); `exec.Command(bin, "--mode","rpc","--no-session","--no-extensions")` (`:151`); `cmd.Dir = os.TempDir()` (`:152`); `cmd.Env = s.cleanEnv()` which strips `AIWB_*` and pi-marker variables (`:153`, `pi/args.go:80-90`); stderr into a 64 KiB `cappedBuffer` (`:154-155`, capacity `pi/pi.go:38`); own process group (`agent.StartGroup`, `:161`).
- RPC: `get_state` (`:173-176`, success checked) then `get_available_models` (`:179-182`), each with the full `timeout` (i.e. worst case ~2×timeout, not one 20 s budget); errors carry pi's stderr tail (`fail`, `:164-169`).
- Shutdown: close stdin, wait `killGrace()` (3 s default, `pi/pi.go:47-52`) then `Process.Kill()` (`:184-196`, kill at `:194`).
- Mapping: `catalogFrom(stateData, modelsData)` (`catalog.go:34-71`): `id`→ID (provider-qualified `provider/id` via `qualifiedID`), `name`→Label, `provider`→Provider, `contextWindow`→ContextWindow, reasoning models get `Efforts` from `thinkingLevelMap` and `DefaultEffort` (`medium` if offered), Default from `get_state`'s current model if still offered else first entry. Nil when no model/unauthenticated.
- No spawner-local cache (unlike Cursor).

### Store + broadcast

`refreshCursorCatalog` (`main.go:345-357`) and `refreshPiCatalog` (`main.go:359-371`) are identical in shape:

1. `cat, err := sp.Catalog(20 * time.Second)`; on error `log.Printf(…)` and `return` — **the stored catalog stays, nothing is broadcast, nothing fails startup** (explicit comments at `:345-346`, `:359-360`).
2. `st.Update(func(s *model.State) error { s.SetCatalog(model.Cursor|Pi, cat); return nil })` — persisted to `state.json`; a save error is logged and the broadcast still happens.
3. `br.Broadcast(map[string]any{"type": "catalog", "agent": string(model.Cursor|Pi), "catalog": cat})`.

Exact wire shape: `{"type":"catalog","agent":"cursor"|"pi","catalog":{"models":[{"id":…,"label":…,"note":…,"provider":…,"efforts":[…],"contextWindow":…,"defaultEffort":…,"effortLabels":{…}}],"default":{"model":…,"effort":…}}}`. Broadcast is `editorbridge.Bridge.Broadcast` (`bridge.go:189-200`): it goes to the **currently active client only** and drops the message when there is none (`:197-199`). The broadcast therefore reaches only a client that is active when the refresh completes (timing not measured); a client that activates later gets the catalog from the snapshot. `Bridge` sends `snapshot` with `App.Snapshot()` on activation (`bridge.go:37,69-75,304-322`) or through `GET /api/state` (`server.go:259-261`); `App.Snapshot` reads stored catalogs (`app.go:61-69`). The store update (`main.go:353`/`367`) precedes the broadcast (`:356`/`:370`), so the two paths together cover both orders. The web client replaces its whole `catalogs` map from the snapshot (`web/src/store.ts:96-107`) and applies live `catalog` events at `web/src/conn.ts:44`.

Failure end state: after a failed Cursor/pi refresh, clients get the previous `state.json` catalog, or `nil` if none was ever stored — the picker then shows "Loading models…" (`web/src/Composer.tsx:305-306`) and `findModel` accepts any model (`manager.go:770-773`).

---

## 4. In-chat refresh (`EvCatalog`) and all its consumers

Producers:

- Cursor: `internal/cursor/cursor.go:192-262` (`doHandshake`). Order: initialize → authenticate → session/new|load → `cursor/list_available_models` (`:226-229`) → `ParseModelList`; on resume the Default is kept from `s.lastCatalog()` when still offered, else session-reported (`:235-244`); `s.remember(cat)` (`:245`); `p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})` (`:246`). Emitted on **every** spawn (new or resume). Failure before the emit sets `readyErr`; `Send` then fails (`handshake`, `:181-187`).
- pi: `internal/pi/pi.go:236-294` (`doHandshake`). get_state → get_available_models → `catalogFrom` → set_model/set_thinking_level (if requested) → `p.emit(agent.Event{Kind: agent.EvCatalog, Catalog: cat})` (`:293`). Emitted on every spawn. Failure → `readyErr`.
- Claude: **none** — `grep EvCatalog internal/claude/` returns nothing.

Consumers:

- `internal/chats/manager.go:523-530` (`pump`, agent-agnostic): on `EvCatalog` with non-nil `Catalog`, copies it, `m.Store.Update` → `s.SetCatalog(c.meta.Agent, &cat)` (`:526`; store errors logged, `:527`), and appends `{"type":"catalog","agent":string(c.meta.Agent),"catalog":cat}` to the outbox (`:529`); the outbox is broadcast in `send` (`manager.go:108-112`). Because it uses `c.meta.Agent`, **this path would already persist/broadcast a Claude catalog if the Claude adapter ever emitted `EvCatalog`** — no manager change needed.
- `internal/chats/spawn.go:462-463` — `handleSubEv` (`spawn.go:405`, called from `runSub` at `:400`), the event loop of an **app-spawned** (MCP `spawn_subagent`) process: `case agent.EvCatalog: return` — ignored. `routeSub` is a different function (`internal/chats/subagents.go:126`) for native Agent/Task children: it only sees events with `ev.Sub != ""` (`manager.go:511-512`, `spawn.go:424-425`) and has no `EvCatalog` case — anything that is not `EvSub` goes to `tr.Apply(ev)` (`subagents.go:149-156`).
- Tests only: `cursor_test.go`, `pi_test.go`, `manager_test.go:610-641` (`TestPiCatalogEventPersistsAndBroadcasts` proves store+broadcast shape).
- The event type comment at `internal/agent/agent.go:63` says "Cursor reported its models" — already inaccurate since pi emits it too; the `Catalog` field is `agent.go:83`.

---

## 5. Every consumer of `claude.Catalog`

Exhaustive non-test grep (`claude.Catalog`, `Catalog`, `s.Catalog(`):

1. `internal/app/app.go:50` — `cl := claude.Catalog`, placed as the initial `Catalogs[model.Claude]` (`:52-56`), Cursor/pi start `nil`. Then inside `a.St.Read` (`:61-69`) a **stored** catalog overrides the initial value for every kind, including Claude (`:64-68`). So this spot already implements "prefer saved, fall back to built-in"; today it always falls back because nothing ever stores a Claude catalog.
2. `internal/chats/manager.go:328-340` — `Manager.catalog(a)`: `if a == model.Claude { cat := claude.Catalog; return &cat }` (`:329-332`); Cursor/pi read the store and return nil when unknown (`:333-340`). Callers:
   - `manager.go:378` — `Create` → `defaults.Resolve(…, m.catalog(a))`;
   - `manager.go:705` — `Configure` → validation;
   - `spawn.go:260` — `resolveSubSpawn` → subagent validation for the **requested** kind.
3. `internal/claude/translate.go:214-229` — `windowFor(id)`: exact lookup in `p.windows` (filled from `result.modelUsage`, `translate.go:72-84`), else iterates `Catalog.Models` and returns the first `ContextWindow` whose id is a substring of the full model id (`strings.Contains(id, "-"+c.ID)`, `:223-224`). This is the **third `claude.Catalog` consumer and the research doc does not list it** as a catalog consumer.

How the same spots handle Cursor/pi: (1) stored catalog when present, else nil (snapshot); (2) stored when present, else nil — nil means "accept any model" in `findModel`; (3) no analogue: Cursor's catalog windows come from the `context` option in `cursor/list_available_models` (`cursor/catalog.go:117-119`), applied to a session by `applyChoice` (`cursor/params.go:76-82`); pi's come from `get_state`/`set_model` through `applyModelWindow` (`pi/pi.go:311-319`, called at `:308` and `:278`) — neither package reads a static catalog at runtime.

---

## 6. Model validation paths

### `findModel` — `internal/chats/manager.go:769-780`

- Comment `:769`: "looks id up in cat. A nil catalog (Cursor's list not known yet) accepts any model."
- `:771-773` nil catalog → `(nil, nil)` = accept.
- `:774-778` **exact string equality only** (`cat.Models[i].ID == id`); no aliasing, no full-ID/short-name matching, no case folding.
- `:779` otherwise `fmt.Errorf("unknown model %q", id)`.

### `Manager.Configure` — `manager.go:671-750`, reached from `PATCH /api/chats/{id}`

- Handler: `server.go:544-576`; decodes `{Model, Effort, Cwd}` (`server.go:546-549`); calls `a.Chats.Configure` at `:571`; errors become `{"error": …}` with 400 for validation (`server.go:90-93,101-126`).
- `Configure` uses `cat := m.catalog(c.meta.Agent)` (`:705`) — for Claude this is always the static built-in.
- Model: `findModel(cat, req.Model)` (`:707`); error returned (`:708-710`); then effort fit-fixing to `cm.DefaultEffort` or `""` (`:713-720`).
- Effort-only: `findModel(cat, next.Model)` (`:723`); an unknown current model errors here (`:724-727`); the effort must be listed on that model else `%s has no effort %q` (`:728-731`).
- Locked/archived/legacy/cwd rules at `:678-704`. Test: `manager_test.go:699-710` (`Configure{Model:"nope"}` fails).
- **Unknown Claude model today: HTTP 400 `unknown model "fable"`; nothing is stored; no process starts.**

### `defaults.Resolve` — `internal/defaults/defaults.go:18-50`

- Picks cwd and model from group defaults → last defaults → `cat.Default` (`:26-33`).
- If `cat != nil`: `defaults.findModel(cat, mc.Model)` (`defaults.go:104-111`, a pointer-only lookup called only when `cat != nil`; distinct from `chats.findModel` at `manager.go:770`, which returns an error and accepts a nil catalog); on miss it silently replaces `mc` with `cat.Default` and re-looks-up (`:35-40`); then unsupported effort is silently replaced with the model's `DefaultEffort` or `""` (`:41-47`).
- Because `m.catalog(Claude).Default` is `{sonnet, high}`, an unknown saved Claude model silently becomes `sonnet`/`high`. No log, no error. Test: `defaults_test.go:155-162`.
- Callers: `manager.go:378` (`Create` — no client-supplied model; only stored defaults) and `spawn.go:306` (subagent unfit-inheritance path).

### MCP `spawn_subagent` for the Claude agent

- Tool schema: `internal/boardtools/tools.go:117-134` — `model` is a free string, `agent` is enum `claude|cursor|pi`.
- Parse: `boardapi/mcp.go:311-316` → `parseSpawnArgs` (`:345-373`): validates non-empty prompt and the agent enum only; `Model`/`Effort` pass through unvalidated.
- `Manager.SpawnSubagent` (`spawn.go:37-...`) → `resolveSubSpawn` (`spawn.go:252-324`):
  - `:253-256` kind defaults to the chat's agent;
  - `:260` `cat := m.catalog(kind)` — for `kind == "claude"` the **static** catalog;
  - explicit `model` → `findModel(cat, modelID)` (`:272-275`); unknown → error, nothing starts;
  - explicit `effort` → validated against the (possibly new) model (`:284-291`);
  - inherited model/effort that don't fit (e.g. a Cursor chat spawning a Claude child with the parent's `composer-2`) → `unfit`, then `defaults.Resolve` for the requested kind (`:293-312`), i.e. silently rebased (the group's saved Claude choice, then the last-used one, then `cat.Default` — `defaults.go:27-33`); an explicit effort that still doesn't fit errors (`:313-319`).
  - Tests: `spawn_test.go:337-382` (`Model:"nope"` → "unknown model", no sub folder; nil Cursor catalog accepts `"nonsense"`).
- **Unknown Claude model today: explicit → MCP tool returns `unknown model "nope"`, no process starts; inherited-from-other-agent → silently rebased by `defaults.Resolve` (group's saved Claude choice, then last-used, then `cat.Default` — `defaults.go:27-33`; today `sonnet` only when neither is set); explicit effort on claude → `has no effort …`.**

No other model-validation path exists: `Send`/`Rename`/`MoveChat` don't touch models (grep of `meta.Model =` shows only `manager.go:712`). There is no re-validation at spawn either: `spawnOptions` passes `c.meta.Model` verbatim (`manager.go:491-492`), so a chat saved with a model that later leaves the catalog still starts with `--model <old>`.

---

## 7. `plans/mcp-subagents-refresh/adapters.md:406` and dependencies on it

The exact sentence (line 406, in the `Configure` section): *"Pi/Cursor catalogs can change under the user (boot refresh + `EvCatalog`). Claude cannot."*

Context: line 383 of the same file correctly describes Claude's source as the static `claude.Catalog` ("Not from a process"); the nearby line refs in that document are stale relative to HEAD (e.g. it cites `manager.go:312-325`, current code is `328-340`).

Code that depends on "Claude cannot change":

- `Manager.catalog` hardcoding the built-in for Claude (`manager.go:328-332`) — this is the load-bearing assumption: it makes `Configure` reject every model the built-in list lacks, and makes `defaults.Resolve` for Claude always use the static Default.
- `App.Snapshot`'s built-in default for Claude (`app.go:50-53`) — harmless because of the stored-catalog override at `:64-68`, but the assumption is encoded there too.
- `translate.windowFor`'s static alias table (`translate.go:214-229`) — assumes the known short IDs (`sonnet`/`opus`/`haiku`) and their context windows.
- `claude.Args`' `o.Model != "haiku"` effort suppression (`claude.go:73`).
- `chats/namer.go:25` (`--model haiku`, with the Claude namer used for both Claude and Cursor chats, `main.go:154-157`).
- Web: `subModelLabel`'s Claude alias branch (`subagents.ts:105-107`) and `Composer`'s `modelOf`/`contextWindow` fallback (`Composer.tsx:36,551`) read whatever catalog the server sent, so they are only coupled to the *shape*, not the static list; `web/src/types.ts:38` states the assumption in a comment ("model.Pi and future dynamic agents").
- Docs/tests: `plans/mcp-subagents-refresh/adapters.md:383,406`, `subagent-card-ui.md:79`, `plans/mcp-subagents.md:349-356`; fixtures listed in §0 #21.
- Counter-evidence that the assumption is *not* baked into the machinery: `Manager.pump` handles `EvCatalog` for any `AgentKind` (`manager.go:523-530`), `SetCatalog`/`Catalog` are generic (`model.go:69-98`), and the web client indexes `catalogs[agent]` generically (`conn.ts:44`, `Composer.tsx:289`, `Sidebar.tsx:513`, `Subagents.tsx:67`).

---

## 8. Other places that assume the Claude catalog is static

Search results for `model.Claude`, `claude.Catalog`, `SetCatalog`, `EvCatalog`, `"catalog"` (non-test unless noted):

- `internal/claude/catalog.go:5,8` — the list itself.
- `internal/claude/translate.go:223` — context-window alias lookup in the static list.
- `internal/claude/claude.go:73` — effort skipped only for the literal id `"haiku"`.
- `internal/chats/namer.go:25` — literal `--model haiku`.
- `internal/chats/manager.go:328-332` — Claude always static; `:523-530` — generic EvCatalog consumption.
- `internal/app/app.go:50-53` — built-in default; `:64-68` — stored override.
- `internal/model/model.go:69` — "(Cursor, pi)" comment; `:78-89`/`:93-98` — legacy Cursor slot handling.
- `internal/agent/agent.go:63` — `EvCatalog // Cursor reported its models (Catalog)` (comment already stale: pi emits it too).
- `internal/defaults/defaults.go:35-47` — silent fallback to `cat.Default`.
- `internal/cursor/*`, `internal/pi/*` — dynamic catalogs, not Claude.
- Web: `web/src/conn.ts:44`, `web/src/store.ts:96-107`, `web/src/types.ts:38-41,59-72`, `web/src/Composer.tsx:36,40-46,289,551`, `web/src/Sidebar.tsx:513`, `web/src/Subagents.tsx:67`, `web/src/logic/subagents.ts:82-108`, `web/src/logic/models.ts:32-55`.
- Tests/fixtures: `internal/app/app_test.go:604-611`; `internal/chats/manager_test.go:610-641` (generic catalog event), `:699-710` (unknown model), `:713-...` (a *Cursor* fixture that uses Claude-looking IDs such as `claude-opus-5-5` — easy to misread); `internal/chats/spawn_test.go:337-382`; `internal/defaults/defaults_test.go:12-21,155-168`; `internal/claude/proc_test.go:161-168,306-325` (fake CLI never answers `initialize`); `web/test/subagents.test.ts:126-134`; `web/test/models.test.ts:70-74`; `web/e2e/app.e2e.mjs:69,474`.
- `plans/` docs listed in §7.

---

## Things a planner must know that the research document does not say

(All verified unless marked otherwise.)

1. **`App.Snapshot` already prefers a stored catalog for Claude** (`app.go:64-68`; the built-in at `:50-53` is only a fallback). Of the two sites the doc names, only `Manager.catalog` (`manager.go:328-332`) actually needs changing — the doc implies both.
2. **There is a third consumer of `claude.Catalog`:** `claude/proc.windowFor` (`translate.go:214-229`). It is inside the `claude` package, reads the package var directly, and cannot see `model.State`/the store. If the static var is removed or its windows change, subagent window reporting and the web `contextWindow` fallback (`Composer.tsx:551`) lose their only source unless the fetched catalog carries windows. Its only callers are native Task/Agent subagent translation (`translate.go:129,176`), and `Args` disallows the `Task` and `Agent` tools (`claude.go:76`), so it runs only for a native subagent the CLI reports.
3. **The manager's `EvCatalog` handler is already agent-agnostic** (`manager.go:526` stores under `c.meta.Agent`; `:529` broadcasts `"agent": string(c.meta.Agent)`). A Claude adapter that emits `EvCatalog` gets persistence + broadcast for free, whereas the app-spawned subagent loop drops it (`handleSubEv`, `spawn.go:405`, case at `:462-463`); `routeSub` (`subagents.go:126`) has no `EvCatalog` case.
4. **`claude.Catalog` is a package-level var read concurrently** by `App.Snapshot`, `Manager.catalog`, and every Claude process's read loop (`translate.windowFor`). Assigning to or mutating it from a refresh goroutine would be a data race; the `Store`/`SetCatalog` path is the safe one already used by Cursor/pi.
5. **`SetCatalog` persists to `~/.ai-whiteboard/state.json` on every call** (`store.go:99-107`), survives restarts, and `SetCatalog` never touches the legacy `cursorCatalog` field (`model.go:91-98`). `State.Catalog` returns the legacy field only for `model.Cursor` (`model.go:85-87`), so a stored Claude catalog is unambiguous.
6. **The boot broadcast reaches only a client that is active when the refresh completes** (timing not measured; `Bridge.Broadcast` sends only to the active client and drops the message when there is none, `bridge.go:189-200`). A client that activates later gets the catalog from the snapshot (`bridge.go:304-322`, `server.go:259-261`), which reads the store. The refresh goroutines start at `main.go:182-183`, after the HTTP listener is bound at `:125` and just before `http.Serve` at `:218`, and each probe can take up to 20 s. The store update (`main.go:353`/`367`) precedes the broadcast (`:356`/`:370`), so the two paths together cover both orders — the save (not the broadcast) is what makes the picker update on a later load.
7. **`CatalogModel.DefaultEffort` is optional and unset in the built-in list.** The effort machinery (`Resolve` at `defaults.go:41-47`, `Configure` at `manager.go:713-720`, spawn at `spawn.go:276-281`) falls back to `""` when a fit is needed and `DefaultEffort` is missing. `claude.Catalog.Default.Effort = "high"` is what makes new chats start at `high` (`catalog.go:14`); a fetched catalog whose `Default` lacks a valid effort changes new-chat defaults.
8. **`Resolve` trusts `cat.Default` unconditionally** (`defaults.go:31-32,38`): if a fetched catalog's `Default.Model` isn't in its own `Models`, `Resolve` returns it anyway (the second `findModel` at `:39` may fail and then effort is not corrected) — a mapping bug in the fetch would leak into new chats silently.
9. **`findModel`'s nil-catalog rule is the safety valve** (`manager.go:770-773`): if `Manager.catalog` were changed to return nil when no Claude catalog is stored, `Configure` would accept any Claude model until the first fetch. The doc's "stored else built-in" fallback avoids that.
10. **The subagent path re-validates inherited models too** (`spawn.go:293-312`) and silently rebases them on `defaults.Resolve`; a Claude child spawned from a Cursor/pi chat inherits a model that is not in the Claude catalog and is silently replaced. Explicit values error.
11. **Client-visible error contract:** unknown model from `PATCH` is HTTP 400 `{"error":"unknown model \"…\""}` (`server.go:90-93,571-573`); the tool path returns the error string as the MCP tool result (`mcp.go:317-319`). The web client's picker only shows catalog entries (`Composer.tsx:309-312`) and its search is label/id/note substring matching (`models.ts:32-55`), so a stale catalog means the model is unselectable, not that the request is rejected client-side.
12. **`--effort` suppression is by literal short id** (`claude.go:73`); fetched catalogs may return full IDs (the doc's own table shows both `haiku` and dated IDs), and `Args` passes `o.Model` verbatim to `--model` (`claude.go:69-75`).
13. **Tests that a dynamic Claude catalog will touch:** `app_test.go:604-611` asserts a fresh snapshot's Claude default is `sonnet` with empty Provider; `manager_test.go:610-641` is the ready-made pattern for store+broadcast assertions; `claude/proc_test.go`'s fake CLI never replies to `initialize` (only `skipInit` at `:161-168` consumes it), so a `readLoop` parse change needs new fixtures — `internal/claude/testdata/` already exists (`context_usage.json`, `usage.jsonl`); `proc_test.go:321` pins the exact `initialize` request body, so changing that request breaks the test.
14. **`defaults_test.go`'s `claudeCat()` does not import `internal/claude`** (`defaults_test.go:12-21`), so changing the production list will not break it; the doc lists it as a fixture to update, which is misleading.

---

## Open questions the author could not resolve

1. **The real `initialize` control-response shape.** No fixture or parser exists in the repo; the CLI was not run in this job. (Covered by the separate R3 experiment.)
2. **Whether the app's `initialize` extras (`agentProgressSummaries`, `forwardSubagentText`, `claude.go:203-204`) or its long argv change the response contents/order versus the doc's minimal probe command.** (Covered by R3.)
3. **Whether the installed CLI answers `initialize` within a short bound and exits cleanly when stdin closes.** (Covered by R3.)
4. **Whether the initialize list contains context windows for any model** (doc says no) and whether `result.modelUsage` always arrives for every model (`translate.go:72-84`), which is what `windowFor`/the web fallback would need after the static list is weakened.
5. **How to treat the CLI's `default` entry and alias/full-ID duplicates.** The doc's own table has `opus` and `default` resolving to the same underlying model; mapping every `value` to an ID would put near-duplicate rows in the picker and make `Default.Model = "default"` a special case for `--model`/`--effort` (`claude.go:73`). No code settles this.
6. **Whether an `EvCatalog` emitted by a Claude process would arrive through `pump` for the parent chat.** For the chat's own process it would: `pump` handles `EvCatalog` for any agent (`manager.go:520-530`). From an app-spawned subagent process (`runSub`) it is dropped in `handleSubEv` (`spawn.go:405`, case at `:462-463`); native Task/Agent child events (`ev.Sub != ""`) go to `routeSub` (`subagents.go:126`), which has no `EvCatalog` case — anything that is not `EvSub` goes to `tr.Apply(ev)` (`:149-156`). Untestable today because nothing emits it.
7. **The exact version of the shipped binary** (the `bin/` app may be older than HEAD; strings confirm the labels but build hashes/timestamps were not compared).
