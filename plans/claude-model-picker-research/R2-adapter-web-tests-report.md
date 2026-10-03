# R2 — Claude adapter, short-name assumptions, web client, tests — verification report

Author: research subagent (pi, DeepSeek V4.1 Flash). Repository HEAD: `658f7bb`. Installed CLI verified live: `claude --version` → **2.1.284 (Claude Code)**.

**Method.** Every claim below was checked by reading the files at the cited lines. Claims about the CLI's behavior were re-verified by running the exact `initialize`-only command from the research document in `/tmp` (no prompt sent; response captured and parsed). Line numbers are current. Statements that are inference rather than confirmed code/CLI behavior are marked **Assumption**.

---

## 1. `internal/claude/claude.go`

### Spawning a chat process (exact flags, cwd, env)

- `Spawner.Args` is `claude.go:61-89`. A chat process is:

  ```
  -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-mode auto --permission-prompt-tool stdio
  --forward-subagent-text
  --resume <sessionId> | --session-id <sessionId>     (claude.go:65-69)
  --model <model>                                     (claude.go:70-72)
  --effort <effort>                                   (claude.go:73-75)
  --disallowedTools <appDirRules>,Task,Agent          (claude.go:76)
  --mcp-config <json> [--allowedTools <names>]        (claude.go:77-82)
  --append-system-prompt <spawnSteering [+ prompt]>   (claude.go:83-87)
  ```
- Binary: `Spawner.Bin` (the `-claude` flag, default `"claude"` — `claude.go:26`, `cmd/ai-whiteboard/main.go:98,149`; fallback at `claude.go:171-173`).
- `start` is `claude.go:166-206`: `exec.Command(bin, append(s.Args(o), extra...)...)` (`185`), `cmd.Dir = o.Cwd` (`186`) — the chat's folder, and `cmd.Env = os.Environ() + CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`187`). The folder must exist (`167-169`); stderr is capped at 64 KB (`32`, `188`); the process runs in its own group (`agent.StartGroup`, `194`).
- **`--model` and effort reach the CLI only through `agent.SpawnOptions.Model/Effort`** (`agent/agent.go:15-25`), which the manager fills from `ChatMeta.Model/Effort` (`chats/manager.go:489-497`, called at `manager.go:460`). `SpawnOptions.Model` is documented as "Claude alias or Cursor base id" (`agent/agent.go:20`) — the type itself encodes the short-name assumption. There is no `Efforts`/capability field.
- Effort gate: `if o.Effort != "" && o.Model != "haiku"` (`claude.go:73`). It is an exact string comparison. A chat whose model is `claude-haiku-4-5-20251001` (or any other full haiku ID) **would** pass `--effort` even though the account's list says haiku supports none. `Args` has no access to any catalog (`Spawner` has only `Bin/AppRoot/Home/Prompt`, `claude.go:25-30`), so "check whether the catalog entry has effort levels" inside `Args` needs either a new `SpawnOptions` field or reliance on the manager already clearing the effort (see §6).

### The `initialize` control request

- Written once per process, before `readLoop` starts, at `claude.go:203-205`:
  - `p.write({"type":"control_request","request_id":"init_"+randHex(4),"request":{"subtype":"initialize","agentProgressSummaries":true,"forwardSubagentText":true}})` — `claude.go:203-204`
  - `go p.readLoop(stdout)` — `claude.go:205`
- The request id is **not** registered in `p.replies` and is not kept anywhere on `proc`: it is built inline as `"init_" + randHex(4)` (`claude.go:203`). `p.replies` is populated only by `proc.request` (`ctxsplit.go:49-53`), and `request` has exactly one caller, `ContextSplit`'s `get_context_usage` (`ctxsplit.go:76`). `Interrupt` writes an `int_…` request (`claude.go:323-326`) and registers no waiter either, so its control response is dropped by `reply` exactly like the initialize one — the comment at `claude.go:241` says so (“answers to our interrupts are dropped”).
- The response payload depends on the chat's `--model` (R3 §4/§8; see §6 and “Things” #17): for a value in the standard list it is identical to the standalone probe minus `pid`; a value outside the list is not rejected but appended as a synthesized 13th entry. The app passes `--model` whenever the chat has one (`claude.go:70-72`).
- `readLoop` is `claude.go:228-259`. It already unmarshals every line into `m` (`232-235`), then:
  - `case "control_response": p.reply(sc.Bytes())` at `claude.go:240-242` (`p.reply` call on **241**, not 240; the same line drops the interrupt responses).
- `reply` is `ctxsplit.go:36-46`: it unmarshals the line into a `controlReply` and forwards it **only** if `p.replies.LoadAndDelete(m.Response.RequestID)` finds a waiting channel (`43-44`). Otherwise it returns silently. The drop is explicitly documented by the test at `ctxsplit_test.go:186` ("no one waits: dropped").
- **Therefore the response body *is* available in `readLoop`** — as the raw line `sc.Bytes()` and already-parsed in `m` — but nothing consumes it: `p.reply` discards it because no channel is registered for the `init_…` id. A chat-time consumer would most naturally intercept in `readLoop` (where `m` is in hand), not in `p.reply`. An interception there must tell the initialize response apart from the `int_…` interrupt responses, which arrive on the same `control_response` case: the id is not currently kept, so the available discriminators are the `init_` id prefix or the payload shape (the initialize response carries `models`).

### Verdicts on research-document claims for this item

| Claim | Verdict |
|---|---|
| `internal/claude/claude.go:203` sends the `initialize` control request on every Claude chat | **CONFIRMED** (`claude.go:203-204`, written before the read loop at 205) |
| `readLoop` discards the answer at line 240 (`p.reply(sc.Bytes())`) | **PARTLY**: `p.reply` is line **241**; the discard is inside `reply` (`ctxsplit.go:36-46`), not at the call site; the body is available there. The `int_…` interrupt responses (`claude.go:323-326`) are dropped the same way, so an interception must tell the initialize response from interrupt responses |
| effort handling near line 73 (`o.Model != "haiku"`) | **CONFIRMED** (`claude.go:73`) |

---

## 2. `internal/claude/translate.go`

### `windowFor` and the `"-"+id` match

- `windowFor` is `translate.go:214-229`; the match is `if strings.Contains(id, "-"+c.ID) { return c.ContextWindow }` at **`translate.go:224`**, iterating the package-level `claude.Catalog` (`translate.go:223-227`, i.e. `internal/claude/catalog.go`).
- It is called only from the native-subagent paths: `taskEvent` builds `info.Window = p.windowFor(p.subModel[tool])` (`translate.go:129`) and `subLine` sets `info.Window` when the subagent's `assistant.message.model` arrives (`translate.go:176`). Native `Task`/`Agent` are disallowed on every Claude spawn (`claude.go:76`), so for chats spawned by the current code these call sites are legacy; app-spawned subagents get their window from `EvUsage.CtxWindow` instead (`spawn.go:459-460`). When the path is reached, the reported id is a full API id (e.g. `claude-haiku-4-5-20251001`), so a short catalog id matches by family (`"-haiku"`), while a **full-ID catalog entry can never match** (`"…haiku…"` does not contain `"-claude-haiku-4-5-20251001"`). If the refreshed list keeps the short aliases alongside full IDs (the proposal does), the short aliases still match on this path; only models with no short alias would fall to 0.
- Precedence: `p.windows[id]` (from the last `result.modelUsage`) wins over the catalog (`translate.go:220-221`).

### Context window for a Claude chat today

- Per turn, from the `result` line: `modelUsage` is parsed at `translate.go:74-85`. Every entry's `contextWindow` is cached into `p.windows` (`75-79`); the chat's own window is `usage[p.model]["contextWindow"]` where `p.model` comes from `system/init` (`translate.go:18-20`), with a single-entry fallback (`80-85`). It is emitted as `EvUsage{CtxWindow: win}` (`100`), stored in `ChatMeta.Usage.CtxWindow` (`chats/manager.go:542-544`) and rendered by the client.
- The context-split popover gets its window from `get_context_usage.maxTokens` (`ctxsplit.go:122,198`).
- The **catalog** `ContextWindow` is therefore used only for (a) native-subagent rows via `windowFor` when that path is reached, and (b) the client's ring fallback before the first result (`Composer.tsx:551`). The refreshed catalog (which has no window) affects both.
- **Verdicts**: `translate.go:224` = CONFIRMED (subject to the reachability above: it serves native-subagent lines, which current Claude chats do not produce; app-spawned subagents take `EvUsage.CtxWindow`). "`result.modelUsage` already parsed and used" = CONFIRMED (`74-85`, `100`). "Works for short names but not full model IDs" = **PARTLY**: true for this `"-"+id` scan (full-ID entries never match it), with the nuance that short aliases act as family matchers; for the web matcher, exact match handles full ids — see §3. "The `initialize` response lacks a context window" = CONFIRMED live (see §General verification).

---

## 3. `web/src/logic/subagents.ts`

- `subModelLabel` is `subagents.ts:89-108`. Order of matching:
  1. no kind at all → the raw id (`subagents.ts:93`);
  2. exact id match against the catalog (`subagents.ts:95-96`);
  3. per-agent rules; the Claude branch is `else if (agent === "claude") { const m = models.find((m) => id.includes("-" + m.id)); … }` at **`subagents.ts:105-107`** (`"-" + m.id` on line 106).
- It is used by `SubStats` (`Subagents.tsx:66-73`) to render the subagent's "model · effort" label, and the comment (`subagents.ts:82-88`) explains the alias intent. Which path is live matters:
  - `Kind` is set only on app-spawned subagents (`spawn.go:70`, `model.go:355`). Native rows are created without it (`subagents.go:134`), and `patchSub` never sets it (`subagents.go:274-305`).
  - With no `kind`, `subModelLabel` returns the raw id at `subagents.ts:93` **before any catalog matching**. So native Claude rows (whose model is the CLI-reported dated/API id, e.g. `claude-haiku-4-5-20251001`) never reach the Claude branch.
  - App-spawned rows carry the resolved catalog id: `sub.Model` is `modelID` from `resolveSubSpawn` (`spawn.go:71`). `patchSub`, the only later writer of `Subagent.Model` (`subagents.go:274-284`), is called only from `routeSub`'s `EvSub` case (`subagents.go:143`) — native rows. `handleSubEv` returns before that on `EvSub` for the app-spawned process itself (`spawn.go:431-432`), so the CLI-reported id never overwrites it.
  - Therefore the ids that reach the `"-"+id` branch are catalog ids that were valid when the subagent was spawned but are **no longer in the current catalog** (a refreshed/replaced list, or legacy stored data).
- So with the proposed full-ID catalog and `default`:
  - Full ids and `default` label correctly through the exact-match step (`subagents.ts:95-96`) — the live path for app-spawned rows.
  - The `"-"+id` scan is reached only for ids missing from the catalog. For such an id it can never match a full-ID entry (no `"-claude-…"` inside it) and falls back to the raw id, unless a short alias is a family substring.
  - A `default` entry contributes nothing to that fallback (only an exact report of the string `default` matches, and the exact step already handles it).
  - Dated/API ids occur only on native rows, and a row without a `kind` returns at `subagents.ts:93` before any catalog matching, so dated/API ids never reach this branch.
  - If the short aliases stay in the catalog (the proposal), the only risk on the fallback path is a wrong-family match when both `sonnet` (→ Sonnet 5.5) and `claude-sonnet-5` exist: a stored `claude-sonnet-5-…` id that is no longer in the catalog matches `-sonnet` first and is labelled "Sonnet 5.5". That mislabel exists today (only `sonnet` exists) and persists unless the matcher is changed.
- **Verdict**: `subagents.ts:106` = CONFIRMED as the alias scan; "works for short names but not full model IDs" = **PARTLY**: full catalog ids and `default` match exactly at `subagents.ts:95-96`; the `"-"+id` scan is only a fallback for ids no longer in the catalog.

---

## 4. `internal/chats/namer.go`

- `ClaudeNamer.Args` is `namer.go:24-29`; `--model haiku` is on **line 25**, alongside `--no-session-persistence`, `--tools ""`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`, `--system-prompt`, and the prompt. It runs `cmd.Dir = os.TempDir()` (`namer.go:37`), independent of any chat/catalog. Both Claude and Cursor chats use `ClaudeNamer` (`cmd/ai-whiteboard/main.go:155-156`).
- **Verdict**: CONFIRMED, and it genuinely is decoupled from the catalog; `haiku` is present in the live CLI list, so it keeps working. Only failure mode is CLI-side removal/rename of the alias (the namer already returns an error and the chat keeps an empty title).

---

## 5. Web client: catalog flow, picker, rendering

### Where catalogs arrive

- Initial catalogs: the SSE **snapshot** (`web/src/conn.ts:30`, `store.ts:96-97` `applySnapshot`, filtering out nulls; `conn.ts:29` hello/`main.tsx:20` `connect()`); the server builds it from `App.Snapshot()` (`internal/app/app.go:49-72`) sent by `editorbridge/bridge.go:305-321` on welcome. `api.state()` (`web/src/api.ts:46`) exists but **is never called** (dead code).
- Updates: `case "catalog": setState((s) => ({ catalogs: { ...s.catalogs, [m.agent]: m.catalog } }))` — `web/src/conn.ts:44`. It **replaces** the agent's whole catalog; there is no merge. Server-side emitters: `chats/manager.go:523-530` (any agent's `EvCatalog`, persisted with `SetCatalog` and broadcast) and the startup refreshers (`cmd/ai-whiteboard/main.go:347-357` Cursor, `361-371` pi).
- State type: `web/src/store.ts:33` `catalogs: Partial<Record<AgentKind, Catalog>>`; `Catalog`/`CatalogModel` mirror Go at `web/src/types.ts:59-73`.
- Consumers read `s.catalogs[agent]` in three places: the composer `Toolbar` (`Composer.tsx:289`), every idle sidebar row via `subline` (`Sidebar.tsx:513-519`), and the subagent stats line (`Subagents.tsx:67`). The sidebar is therefore a consumer too: a catalog update relabels chat rows (`subline`, `Composer.tsx:40-44`) or shows the raw id when the chat's model is not in the catalog (`modelLabel`, `Composer.tsx:37`).

### How the picker builds its list

- `Toolbar` (`Composer.tsx:287-320`): `cat = s.catalogs[c.agent]` (`289`); `m = modelOf(c, cat)` = exact `id === c.model` (`36`); Model `Picker` gets `options={cat.models}` in **catalog order** (`309-312`); on pick it calls `configure({ model: id })` (`294`, `312`).
- `Picker` (`Composer.tsx:332-472`) flattens with `groupModels(filterModels(options, query))` for searchable pickers (`348-356`). `groupModels` (`web/src/logic/models.ts:11-25`) groups by `provider`, provider-less first, preserving input order; Claude entries have no provider (`model.CatalogModel.Provider` is documented "pi only", `model.go:124`), so Claude is one flat, unsorted group. `filterModels`/`modelMatches` (`models.ts:40-55`) is the only filtering; `searchText` for provider-less models is `label - id - note` (`models.ts:32-35`). There is **no sorting, no dedup, no Claude special-casing, no ID regex/allowlist** anywhere in the picker.
- Rendering: one row per model, `label` + `note` in `.menu-note` (`Composer.tsx:426-431`), checkmark on `o.id === value` (`429`), keyboard highlight via a flat index built from the same grouped sequence (`336-395`). The list scrolls (`.menu-scroll`, `453`).

### Efforts, notes, context window

- The Effort picker renders only when `m?.efforts?.length > 0` (`Composer.tsx:313-318`); a model with no effort levels shows **no effort control**. The locked-chip line `subline` (`41-43`) — also what idle sidebar rows render (`Sidebar.tsx:519`) — likewise suppresses ` · effort` when the model is found and has no efforts.
- Effort names: `effortLabel` (`web/src/logic/labels.ts:11-17`) prefers `model.effortLabels`, then `EFFORT_LABELS` (`low/medium/high/xhigh/max`), then capitalises the id. `xhigh` comes out as "Extra high" — which matches the CLI's live `supportedEffortLevels` strings (`xhigh`, not `extra-high`, verified live).
- `note` = the CLI's `description` is displayed in the row; it is also searchable (`models.ts:35`). The catalog's `contextWindow` is only a **fallback** for the composer ring: `const win = u.ctxWindow || modelOf(c, cat)?.contextWindow || 0` (`Composer.tsx:551`); after the first result `u.ctxWindow` (from `result.modelUsage`) wins. If refreshed catalog entries have no `contextWindow`, the ring is simply empty until the first reply.

### Would a 12-entry list with `default` render sensibly?

Yes, mechanically:
- 12 rows in a scrollable menu, in the order the server sends (the live CLI order is `default`, `opus`, `claude-fable-5-1`, `sonnet`, `haiku`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` — R3 §3; it matches the research table).
- `default` is a normal row; selection by exact id works (`modelOf`, `36`); the chat stores the literal `default`. Verified: `default` is an offered `value` in the CLI's list (R3 §3). **Assumption:** that the CLI *accepts* `--model default` at runtime — R3 §4 only ran `--model sonnet` and `--model claude-fable-5-1`, and this remains open (open question 6).
- Duplicate underlying models (`default` and `opus` both resolve to `claude-opus-5-5`) are shown as two distinct rows — visually confusing but not a code break. The UI never shows `resolvedModel`.
- Two labels that a user might expect to be unique (`Sonnet 5.5` from `sonnet`, `Sonnet 5` from `claude-sonnet-5`) are distinct strings, so the picker is fine.

### Verdicts on research-document claims for this item

| Claim | Verdict |
|---|---|
| Client gets the list from the snapshot; `{"type":"catalog"}` updates replace it | **CONFIRMED** (`store.ts:96-97,107`, `conn.ts:30,44`) |
| "The web client filters only through the search box" | **PARTLY**: it also groups by provider with a provider-less-first rule (`models.ts:11-25`), but that is presentation, not filtering |
| No ID regex/allowlist | **CONFIRMED** |
| Catalogs are not kept in localStorage | **CONFIRMED**: only `aiwb.sel`/`aiwb.widths`/`aiwb.theme`/`aiwb.draft.<chat>`/`aiwb.lastChat` (`store.ts:49-51,161-174`, `Resizer.tsx:10`, `logic/drafts.ts`, `logic/theme.ts:9`), `aiwb.archived` (`Sidebar.tsx:214`) and `aiwb.dirs` (`Composer.tsx:28-29`) are persisted; no sessionStorage/IndexedDB for catalogs |
| Commit `eaa7cdd` only changed client-side filtering | **CONFIRMED**: `git show --stat eaa7cdd` → `web/src/logic/models.ts`, `web/test/models.test.ts` only |
| The client renders effort per model; no effort picker when a model has none | **CONFIRMED** (`Composer.tsx:313`, `41-43`) |
| A 12-entry list with `default` renders sensibly | **CONFIRMED** on the code path (no structural blocker; runtime acceptance of `--model default` is an assumption — R3 §3 offers the value, §4 did not run it); "sensibly" is a judgement — see the duplicate-label/e2e notes |

---

## 6. Saved defaults and per-chat model selection

### Where the choice is persisted

- Per chat: `ChatMeta.Model`/`Effort` in `chats/<id>/chat.json` (`model/model.go:192-214`, `ChatView` echoes them at `model.go:264-265`). Set by `Manager.Configure` (`chats/manager.go:671`, validation at `705-733`, save at `742`), reached from `PATCH /api/chats/{id}` (`server/server.go:544-577`, `Configure` call at `571`). Locked chats reject model/effort changes (`manager.go:686-690`).
- Defaults: `ModelChoice` per agent in `Defaults.Groups[group].ByAgent` and `Defaults.Last` in `state.json` (`model/model.go:100-113`; `manager.recordDefaults` at `chats/manager.go:754-767`, called from `Configure` at `746` (catalog-validated) and from the first message send at `619` (`616-620`; the comment at `618` says "Sending the first message confirms the chat's settings as chosen, changed or not"; it passes `c.meta.Model`/`c.meta.Effort` with no catalog validation), emitting `{"type":"defaults"}`). The client just stores the `defaults` event (`conn.ts:43`); it never edits them directly.
- New chats resolve stored choice → catalog default in `defaults.Resolve` (`defaults/defaults.go:18-48`), called from `Manager.Create` (`manager.go:378`). Subagent spawns resolve in `resolveSubSpawn` (`chats/spawn.go:252-324`).

### What happens with a saved ID no longer in the catalog

- **New chat**: `Resolve` looks the model up; if missing it silently uses `cat.Default` (and then the model's `DefaultEffort` if the held effort doesn't fit) — `defaults.go:35-47`. Today `cat.Default` is `{Model:"sonnet", Effort:"high"}` (`claude/catalog.go:14`), so a stale saved id becomes `sonnet`. It is **not hardcoded to "sonnet"**; it is `cat.Default`. When `Resolve` replaces an unknown saved model with `cat.Default` (`defaults.go:35-40`), the first send in that chat records the substituted model/effort as the saved choice for both the group and `Last` (`recordDefaults` at `manager.go:619` → `defaults.RecordChange`/`apply`, `defaults.go:54-62`, `84-102`; `apply` leaves empty fields alone, but the substitute model always replaces the saved model). That substitute therefore permanently replaces the user's saved default once a message is sent in the substituted chat; with a refreshed list that can shrink, even temporarily, a saved choice is lost for good.
- **Configure (PATCH)**: unknown ids are rejected with `unknown model %q` (`manager.go:707-711`, `770-780`); an effort the model lacks is rejected (`728-731`). No silent fallback here.
- **Existing chat**: nothing re-validates. A locked chat keeps the id and passes it to the CLI on every turn. In the client, `modelLabel` falls back to the raw id (`Composer.tsx:37`), and the effort chip still renders if `m` is undefined (`41-42`).
- **`spawn_subagent`**: an explicitly supplied model is validated against `m.catalog(kind)` (`spawn.go:271-282`); inherited parent values that don't fit fall back to new-chat defaults (`spawn.go:293-322`). Because `m.catalog(model.Claude)` is the static list (`manager.go:328-341`), an agent passing a full model id (e.g. `claude-fable-5-1`) is rejected today. The research document does not mention this path.
- **Imprecise claim in the doc**: `defaults.Resolve (36-47)` does go through 36-39 but the fallback target is `cat.Default` (`38`), not a hardcoded sonnet.

### Server-side catalog source (important correction)

- `App.Snapshot` (`app.go:49-72`) starts from the built-in `claude.Catalog` (`50`) but then **already overrides any agent, Claude included, from the store**: `for _, kind := range []model.AgentKind{model.Claude, model.Cursor, model.Pi} { if c := s.Catalog(kind); c != nil { … } }` (`64-69`). So once a Claude catalog is stored, clients get it in the snapshot/`/api/state` — no `app.go` change needed.
- The only hardcoded Claude path is `Manager.catalog` (`manager.go:328-341`): `if a == model.Claude { cat := claude.Catalog; return &cat }`, bypassing the store. That is what validation, `defaults.Resolve`, and subagent spawning use.
- The manager's `EvCatalog` handler (`manager.go:523-530`) is agent-generic: it persists `s.SetCatalog(c.meta.Agent, &cat)` and broadcasts `{"type":"catalog","agent":c.meta.Agent,…}`. Cursor (`cursor/cursor.go:246`) and pi (`pi/pi.go:293`) feed it; the Claude adapter never emits `EvCatalog` (grep of `internal/claude`: none). So "nothing calls `SetCatalog(model.Claude, …)`" is literally true, but the plumbing needs no manager change.
- **Two paths do drop an `EvCatalog`:** app-spawned subagent processes discard it (`spawn.go:462-463`, in `handleSubEv`), and `ReadContextSplit`'s forked process drains all events (`ctxsplit.go:97-100`). "No manager change needed" therefore holds only for top-level chat processes.

### Verdicts

| Claim | Verdict |
|---|---|
| `findModel` (`manager.go:770-780`) only accepts exact matches, called from `PATCH /api/chats/{id}` | **CONFIRMED** (call sites `707`, `723`; route `server.go:544`) |
| `defaults.Resolve` (`defaults.go:36-47`) quietly switches an unknown saved model back to `sonnet` | **PARTLY**: the fallback is `defaults.go:35-47` and the target is `cat.Default`, which happens to be `sonnet` because of `catalog.go:14` |
| `app.go:50` should prefer the saved Claude list | **WRONG as stated**: `app.go:64-69` already prefers the stored catalog; line 50 is only the fallback |
| `manager.go:330` should prefer the saved list | **CONFIRMED** — this is the one place that bypasses the store for Claude |
| Nothing calls `SetCatalog(model.Claude, …)` | **CONFIRMED literally**; the generic path in `manager.go:523-530` would handle an adapter-emitted `EvCatalog` unchanged for a top-level chat process — app-spawned subagent processes drop it at `spawn.go:462-463` and the context-split fork drains it at `ctxsplit.go:97-100` |

---

## 7. Tests and fixtures

### Research-document list, verified

| Doc location | Actual content at those lines | Verdict |
|---|---|---|
| `internal/app/app_test.go:603-613` | `TestSnapshotCatalogs` starts at **604**. Lines 603-613 cover: Claude catalog non-nil and `Default.Model == "sonnet"` (`607`), provider empty (`610`), Cursor nil (`613`). It **does not hardcode a three-entry list**; it asserts the fallback default and the no-provider property. It has **no stored-Claude case** (only Cursor and pi are stored, `620-641`). | **PARTLY** (range off by one; description wrong) |
| `internal/defaults/defaults_test.go:11-22` | `claudeCat()` is `12-21`: three local entries sonnet/opus/haiku (`15-17`), `Default{sonnet, high}` (`19`). It is a **local fixture** for `Resolve` tests, not the app catalog; the tests use `claudeCat()` at `57,71,79,90,95,109,111,121,126,136,138,149,159,165`. | **CONFIRMED** (fixture location; note it is self-contained) |
| `web/test/subagents.test.ts:126-134` | Claude fixture `125-131` (entries `127-129`), alias assertions `133-134`; also `160`. This is the exact mirrored three-entry list. | **CONFIRMED** |
| `web/test/models.test.ts:68-74` | `bareCatalog` `70-74`: `sonnet`/`Claude Sonnet`, `deepseek-chat`, `gpt-5` — a generic search fixture, **not** the app's three-entry list. | **PARTLY** (it contains a `sonnet` entry but is not the Claude catalog) |
| `web/e2e/app.e2e.mjs:69-70,474` | `69: const CLAUDE_MODEL_LABEL = "Haiku 4.5"`, `70: const CURSOR_MODEL_LABEL = "GPT-5.4 Nano"`; `474: await pickModel(page, "Sonnet 5")`. | **CONFIRMED** |

### Additional hardcoded Claude assumptions in tests (not named by the doc)

- `internal/claude/args_test.go:149-153` `TestArgsHaikuHasNoEffort`: exact `Model:"haiku"` must produce **no** `--effort`. Breaks if the hardcoded gate is removed without an equivalent.
- `internal/claude/translate_test.go:124-126` `TestTranslateSubagentLines` expects `Window: 200000` for a subagent reporting `claude-haiku-4-5-20251001`, on a fresh `&proc{}` (`151`) and with no earlier `result` line; the later `task_*` cases (`139-147`) expect the same `Window: 200000` through the `subModel` map (the `translate.go:129` path). That value can only come from the built-in haiku entry (`catalog.go:12`) through the `"-"+c.ID` match (`translate.go:223-227`). It breaks if the fallback list loses `haiku` or its `ContextWindow`, or if `windowFor` stops reading the package-level `Catalog`.
- `internal/claude/proc_test.go:306-323` `TestSpawnSendsInitialize` pins the exact `initialize` JSON (`agentProgressSummaries:true`, `forwardSubagentText:true`). Changing the request requires updating this test.
- `internal/claude/proc_test.go:161-167` `skipInit` expects the initialize request to be the **first** stdin line in every spawned process.
- `internal/chats/spawn_test.go:87-91` expects a default Claude subagent spawn to inherit `Model:"sonnet", Effort:"high"` — i.e. `claude.Catalog.Default`.
- `internal/chats/manager_test.go:699-704` configures `"haiku"` (effort cleared; this covers only the clearing half) and rejects `"nope"`; also `"opus"` at `477-482, 680-690, 816-843, 1287`, all against `claude.Catalog`.
- `internal/server/server_test.go:570-572` PATCHes `{"model":"opus"}` on a normal chat and needs `opus` in `claude.Catalog`; the PATCHes at `496` and `502` are rejected with 409 (archived chat / locked chat) before model validation and never consult the catalog.
- Plain-data model strings (no catalog dependency, no expected breakage): `internal/store/store_test.go:49`, `internal/model/model_test.go:18,160,199` (`"sonnet"`); `internal/app/app_test.go:341,358,361,413,422`; `internal/claude/args_test.go:33,50,61,84,97,113` and `internal/claude/proc_test.go:181`; `web/test/tree.test.ts:12` (`model: "sonnet"`); `web/test/models.test.ts:32-38` (provider-less `sonnet/opus/haiku` fixture) and `43-48` (`sonnet/opus` with provider) — two more local fixtures beside `bareCatalog` in the table above.
- `web/e2e/app.e2e.mjs` also asserts `model === "haiku"` at `450`, `519`, `868`; picks `CLAUDE_MODEL_LABEL` at `447`, `865`, `1023`; and `pickModel` (`340-342`) matches by **substring** `hasText`. The locator is `.menu-label`, whose text includes the nested `.menu-note` (`Composer.tsx:428`), so a match runs over label **and** CLI description. Against the 12 labels/descriptions in `/tmp/claude-model-picker-plan/R3-cli-initialize-experiment-report.md` §3: `"Haiku 4.5"` matches only the `haiku` row (label "Haiku 4.5", description "Fastest for quick answers"); `"Sonnet 5"` matches the `sonnet` row (label "Sonnet 5.5", description "Most efficient for simpler tasks") and the `claude-sonnet-5` row (label "Sonnet 5", description "Efficient for routine tasks"). So with a refreshed catalog `pickModel(page, "Haiku 4.5")` stays unique while `pickModel(page, "Sonnet 5")` (`474`) resolves to two rows and Playwright's strict mode fails.
- Not to be confused: `internal/cursor/testdata/models.json`, `internal/cursor/catalog_test.go:62-83`, `internal/cursor/fake_test.go:259-268`, and Cursor tests use `claude-*` strings as Cursor *model values*; they are unrelated to the Claude adapter's catalog.

### How tests fake the Claude CLI

- `internal/claude/proc_test.go`: **no fake binary on disk**; the test binary re-execs itself. `TestMain` (`27-33`) checks `CLAUDE_FAKE_SCRIPT` (`18-25`) and runs `helperProcess` (`37-84`). `newFake` (`93-105`) writes scripted stdout lines and points env vars at files; `spawner()` sets `Bin: os.Args[0]` (`107-109`). The fake answers **only** `get_context_usage` when `CLAUDE_FAKE_CTX` is set (`56-78`); it does **not** answer the `initialize` control request. A code path that blocks waiting for the initialize response at spawn time would hang the fake until timeout.
- `internal/chats`, `internal/app`, `internal/server` tests use in-process fake spawners (`chats/manager_test.go:104`, `app/app_test.go:33`, `server/server_test.go:42`); they never run the CLI and get the Claude catalog from `claude.Catalog` (via `Manager.catalog`).
- `web/e2e/app.e2e.mjs` runs the **real** Claude CLI with the machine's login on the Haiku model (`5`, `69`) — it is manual and spends money (`web/e2e/app.e2e.mjs:5-12`).
- Web tests are pure fixtures (`web/test/*.test.ts`); no test covers `conn.ts` catalog events, `store.ts applySnapshot` catalog mapping, or the Composer picker rendering.

### How tests are run (no Makefile, no CI workflows present)

- Go: `go test ./...` (`README.md:224`).
- Web: `cd web && npm test` → `node --test --experimental-strip-types 'test/*.test.ts'` (`web/package.json:8`, `README.md:225`).
- Desktop: `cd desktop && npm test` → `node --test 'test/*.test.js'` (`desktop/package.json:9`, `README.md:226`).
- E2E (manual, not in `npm test`): `cd web && npm install --no-save playwright && npx playwright install chromium`, then `node web/e2e/app.e2e.mjs` (`web/e2e/app.e2e.mjs:8-9`).
- Gated real-pi adapter e2e exists (`internal/pi/e2e_test.go:6-10`, `AIWB_PI_E2E=1`); there is no equivalent gated Go e2e for Claude.

### Fixture gap relevant to the fix

- `internal/claude/testdata/` currently contains only `context_usage.json` and `usage.jsonl` — **no captured `initialize` response**. A parse test would need a new fixture.

---

## 8. Build and install

- `scripts/build-app.sh` (read in full):
  1. web client: `cd web && [ -d node_modules ] || npm ci; AIWB_VERSION=$version node build.mjs` (`18-21`);
  2. Go server: `go build -C root -ldflags "-X ai-whiteboard/internal/version.Version=$version" -o desktop/build/ai-whiteboard ./cmd/ai-whiteboard` (`23-25`);
  3. Electron bundle: `cd desktop && [ -d node_modules ] || npm ci; rm -rf dist; npx electron-builder --mac --dir -c.buildVersion=$version` (`27-31`), then `ditto "dist/mac*/AI Whiteboard.app" "bin/AI Whiteboard.app"` (`32-36`).
- The bundle (from the script header and `desktop/electron-builder.yml`): `Contents/MacOS/AI Whiteboard` (Electron), `Contents/MacOS/ai-whiteboard` (Go server, `extraFiles`), `Contents/Resources/web/` (built client, `extraResources`), `Contents/Resources/app.asar` (Electron main/preload only).
- Install: `scripts/install-app.sh` copies to `~/Applications/AI Whiteboard.app`, runs `lsregister`/`mdimport`, and warns that a running old server keeps the old binary until "Restart server" is used (`install-app.sh:1-27`).
- `bin/` contains `AI Whiteboard.app`, `AI Whiteboard.zip`, `ai-whiteboard` (the loose Go binary used by the e2e default `AIWB_E2E_BIN`, `web/e2e/app.e2e.mjs:49`).
- **Verdict on the doc's claim**: building is required for the installed app to pick up a code fix — CONFIRMED by the build layout (the binary and web assets are copied into the bundle).

---

## 9. Every place that hardcodes short Claude names / the three-entry list

Go source (non-test):

| Location | What it assumes | What breaks |
|---|---|---|
| `internal/claude/catalog.go:10-12,14` | The three entries and `Default{sonnet,high}` | Fallback list is stale (missing Fable, wrong Sonnet label); tests depend on its Default and on haiku's ContextWindow (`translate_test.go:124-126,139-147`, see §7). The research document's "exactly one commit" claim is verified: `git log -- internal/claude/catalog.go` → only `6e9b17e` |
| `internal/claude/claude.go:73` | `o.Model != "haiku"` | Full-ID haiku gets `--effort`; no catalog access in `Args` |
| `internal/claude/translate.go:224` | `"-"+c.ID` over the static `Catalog` | Full-ID-only catalog entries never match. Reached only from the native-subagent lines (`translate.go:129`, `176`), and every Claude spawn disallows the native `Task`/`Agent` tools (`claude.go:76`), so this is legacy for chats spawned by the current code; app-spawned subagents get their window from `EvUsage.CtxWindow` (`spawn.go:459-460`). The static list is used instead of the refreshed one |
| `internal/chats/namer.go:25` | `--model haiku` | Independent of the catalog; only fails if the CLI alias disappears |
| `internal/agent/agent.go:20,63` | comment "Claude alias"; `EvCatalog` comment "Cursor reported its models" | documentation only |
| `internal/model/model.go:69,121,354` | comments "(Cursor, pi)", `// "sonnet"`, `"claude-haiku-4-5-…"` | documentation only (the comment at 69 is now stale: `app.go` already reads Claude from the store) |
| `internal/chats/manager.go:330` | Claude catalog = built-in | validation/defaults/subagent spawns reject refreshed IDs |

Web source:

| Location | What it assumes | What breaks |
|---|---|---|
| `web/src/logic/subagents.ts:95-96,105-107` | exact catalog lookup, then the `"-"+id` alias fallback | Full ids and `default` match exactly (`95-96`); the `"-"+id` fallback is reached only for ids no longer in the catalog, where full-ID entries cannot match (see §3) |
| `web/src/types.ts:38-41,116` | comments | documentation only |
| `web/src/Composer.tsx:36,41-43,551` | exact id lookup, effort visibility, window fallback | graceful fallbacks (raw id, no effort chip, no window) |

Tests/e2e: `internal/app/app_test.go:607`, `internal/defaults/defaults_test.go:15-17,19`, `internal/claude/args_test.go:149-153`, `internal/claude/translate_test.go:124-126,139-147`, `internal/chats/spawn_test.go:87-91`, `internal/chats/manager_test.go:699-704` (+ `opus` sites above), `internal/server/server_test.go:570-572`, `web/test/subagents.test.ts:127-134,160`, `web/e2e/app.e2e.mjs:69,447,450-451,461,474,519,865,868,1023`. Also `internal/claude/proc_test.go` (e.g. `181`) and `ctxsplit_test.go:209` use model strings but are not catalog-dependent; so do `internal/app/app_test.go:341,358,361,413,422`, `internal/claude/args_test.go:33,50,61,84,97,113`, `web/test/tree.test.ts:12` and both local fixtures in `web/test/models.test.ts:32-38,43-48`. `internal/claude/translate_test.go` **is** catalog-dependent (see the `translate_test.go` bullet in §7).

---

## General: claims verified outside the repo (live CLI, 2.1.284)

Consistent with, and resting on, the separate reviewed experiment report `/tmp/claude-model-picker-plan/R3-cli-initialize-experiment-report.md` (12 entries, the key set below, haiku lacking effort fields, no default field, version 2.1.284). That report re-ran the exact `initialize`-only probe from the research document, also with the app's always-on flags and with inherited `CLAUDECODE`/`CLAUDE_CODE_*` variables removed. Verified:

- `control_response.response.models`: **12 entries**, `value`/`displayName` exactly as the research table (`default`, `opus`, `claude-fable-5-1`, `sonnet`, `haiku`, `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`).
- Entry keys are exactly: `value`, `resolvedModel`, `displayName`, `description`, `supportedEffortLevels`, `supportsEffort`, `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`. `supportsFastMode` is present on only **4 of 12** entries (`default`, `opus`, `claude-opus-5`, `claude-opus-4-8`). **No context-window field** anywhere. No `defaultEffort` field either. Where a `supports*` key is present it is `true` — never `false` or null — so a missing key must be read as false.
- `haiku` has only `value`, `displayName`, `resolvedModel`, `description` — `supportedEffortLevels` and all `supports*` keys are **absent** (the keys are missing, not empty arrays or null). A parser must treat missing as "no efforts".
- Effort lists: `default/opus/fable/sonnet/opus-5/...` = `[low, medium, high, xhigh, max]`; `claude-opus-4-6` and `claude-sonnet-4-6` = `[low, medium, high, max]`.
- `description` is present and non-empty on every entry.
- No other field in the response names a default/current model: `account` has only `apiProvider/email/organization/subscriptionType`; `session_state` is `"idle"`; `output_style` is `"default"`. The `default` entry is the only in-band default signal.
- `claude --version` = 2.1.284.
- `models` depends on `--model` (R3 §4, §8): the payload is identical to the no-model run (minus `pid`) for `--model sonnet` and `--model claude-fable-5-1`; an unknown value is **not** rejected — the response returns the 12 standard entries plus an appended synthesized entry (`value`/`resolvedModel`/`displayName` = the unknown name, description "Custom model", all five effort levels, `supportsEffort`/`supportsAdaptiveThinking`/`supportsAutoMode` true, no `supportsFastMode`). The app passes `--model` whenever a chat has one (`claude.go:70-72`), so an in-chat refresh from a chat holding an id outside the list gets this appended entry.

---

## Things a planner must know that the research document does not say

1. **`App.Snapshot` already prefers a stored Claude catalog** (`app.go:64-69`). Only `Manager.catalog` (`manager.go:328-341`) hardcodes Claude; that is the single server-side lookup to change.
2. **The manager's `EvCatalog` handling is already agent-generic** (`manager.go:523-530`): Cursor and pi feed it, and a Claude `EvCatalog` from `readLoop` would be persisted and broadcast with no manager change — for a top-level chat process. App-spawned subagent processes discard it (`spawn.go:462-463`, in `handleSubEv`) and the context-split fork drains all events (`ctxsplit.go:97-100`). The startup `refreshClaudeCatalog` still needs `SetCatalog(model.Claude, …)` explicitly (`main.go:353/367` pattern). Because the handler persists and broadcasts the catalog unchanged, an in-chat `EvCatalog` from a chat whose `--model` is outside the standard list would store and show the CLI's synthesized entry too (R3 §8; see item 17).
3. **The `initialize` response is already available inside `readLoop`** (`claude.go:232-235`), both raw (`sc.Bytes()`) and parsed (`m`); `p.reply` (`ctxsplit.go:36-46`) would hand it to a waiter, but no waiter is registered for the `init_…` id, so it is dropped today. Interrupt responses (`claude.go:323-326`) are dropped the same way, and no id is kept on `proc` for the initialize request, so the two are distinguishable there only by the `init_` id prefix or the payload shape.
4. **`SpawnOptions` has no effort-capability field and `Spawner` has no catalog** (`agent/agent.go:15-25`, `claude.go:25-30`). The `--effort` gate cannot consult a catalog without a new field. In practice the manager already clears efforts for models without efforts at `Configure` (`manager.go:713-719`) and `Resolve` (`defaults.go:41-46`), so the hardcoded `"haiku"` check can only matter for legacy stored chats: the account's list has no full-ID haiku entry, and `Configure` rejects ids outside the catalog (`manager.go:707-711`), so a chat cannot be set to one today.
5. **`DefaultEffort` is absent from the CLI response.** When switching to a model whose effort list doesn't include the current effort, the server sets effort to `cm.DefaultEffort`, which will be `""` (`manager.go:713-719`, `defaults.go:41-46`) → the client renders an Effort chip with an empty label (`Composer.tsx:314`). This is not new: the built-in list has no `DefaultEffort` either (`catalog.go:10-12`), so haiku → sonnet already yields effort `""` today; `manager_test.go:699-704` covers only the clearing half. With 12 models whose lists differ (xhigh present/absent), it becomes more visible; the code has no fallback convention to fall back on (open question 3).
6. **`spawn_subagent` validates agent-supplied models against `m.catalog(kind)`** (`spawn.go:271-282`); until `Manager.catalog` is fixed, full model IDs like `claude-fable-5-1` are rejected there too.
7. **The Go fake CLI never answers `initialize`** (`proc_test.go:37-84` only answers `get_context_usage`). Any synchronous wait for the initialize response in `start()` needs the fake extended (or the wait made asynchronous).
8. **`TestSpawnSendsInitialize` pins the exact initialize request JSON** (`proc_test.go:306-323`), and `TestArgsHaikuHasNoEffort` pins the haiku/effort behavior (`args_test.go:149-153`).
9. **E2E `pickModel` matches by substring over the `.menu-label`, whose text includes the nested `.menu-note`** (`app.e2e.mjs:340-342`, `Composer.tsx:428`), so uniqueness depends on the CLI descriptions too. Against R3's 12 entries, `"Haiku 4.5"` matches only the `haiku` row (its only label/description containing the string), while `"Sonnet 5"` matches both the `sonnet` row (label "Sonnet 5.5") and the `claude-sonnet-5` row (label "Sonnet 5"), so line 474's locator matches two rows and Playwright strict mode fails. `model === "haiku"` assertions (450, 519, 868) depend on which entry the picker chooses; 1023 is another `CLAUDE_MODEL_LABEL` pick, not a model assertion.
10. **The client has no test coverage of the catalog pipeline** (snapshot mapping, catalog events, picker rendering including its effort/window display; `effortLabel` itself is covered — `web/test/effort.test.ts:8-24`), and `api.state()` is dead code (`api.ts:46`).
11. **Dropping `contextWindow` from the catalog degrades the composer ring until the first reply** (`Composer.tsx:551`), and **updating the fallback catalog changes the legacy subagent window lookup** (`translate.go:223-227` uses the package-level `Catalog` when `modelUsage` hasn't seen the id). That lookup is reached only from the native-subagent lines (`translate.go:129`, `176`, legacy because native `Task`/`Agent` are disallowed at `claude.go:76`); app-spawned subagents get their window from `EvUsage.CtxWindow` (`spawn.go:459-460`). Keeping the short aliases in the fallback (as proposed) keeps `"-"+id` working.
12. **The client replaces the whole catalog on a catalog event** (`conn.ts:44`); there is no merge. "Keep the stored list on failure" only covers fetch errors, not a successful but smaller account-filtered list. An in-chat catalog event from a chat whose `--model` is outside the standard list would plant the CLI's synthesized entry in the picker, and once `Manager.catalog` reads the store it would also make that stale id pass `findModel` (`manager.go:770-780`) — see item 17.
13. **The server's stored catalog already survives restarts** (`model.State.Catalogs`, `model.go:69,93-98`), and snapshot serves it, so a *partially* applied fix (storage + probe, without `Manager.catalog`) would immediately show refreshed models in the picker but still reject them in `Configure`/defaults/subagent spawns — an inconsistent intermediate state.
14. **`internal/claude/testdata/` has no initialize fixture** (only `context_usage.json`, `usage.jsonl`), and there is no Makefile/CI: tests are `go test ./...`, `cd web && npm test`, `cd desktop && npm test` (`README.md:224-226`).
15. **The installed app is a static copy**: `scripts/build-app.sh` → `bin/AI Whiteboard.app` → `scripts/install-app.sh` → `~/Applications`; a running server keeps the old binary until restart (`install-app.sh` comment).
16. **A first message can overwrite the saved defaults with a substitute model.** `recordDefaults` is called on the first send (`manager.go:616-620`) with the chat's current model/effort and no catalog validation; `defaults.RecordChange` → `apply` (`defaults.go:54-62`, `84-102`) then writes both the group's and `Last`'s choice. When a new chat was created because the saved id was missing from the catalog, `Resolve` had replaced it with `cat.Default` (`defaults.go:35-40`) — so that substitute becomes the user's new saved default; a saved choice that disappears from a refreshed list is lost for good once a message is sent (see §6).
17. **An in-chat `initialize` response depends on the chat's `--model`** (R3 §4/§8): it is identical to the standalone probe for a value in the standard list; for a value outside it the CLI does not reject the value but appends a synthesized entry (unknown name; description "Custom model"; all five effort levels) to `models`. The app passes `--model` whenever the chat has one (`claude.go:70-72`), and a locked chat keeps its (possibly stale) id (§6). If the adapter emits `EvCatalog` from an in-chat initialize response, the existing generic path persists and broadcasts the catalog unchanged (`manager.go:523-530`) and the client replaces its whole catalog with it (`conn.ts:44`); once `Manager.catalog` reads the store, the synthesized entry would additionally make the stale id pass `findModel` (`manager.go:770-780`). An in-chat refresh has to account for this.

---

## Open questions the author could not resolve

1. **Does the in-chat `initialize` response carry the same `models` array as the standalone `--print` probe?** Per R3 §4/§8 the list is identical for `--model` values in the standard list (`sonnet` and `claude-fable-5-1` were tested); for a value outside it the CLI appends a synthesized "Custom model" entry (R3 §8; see "Things" #17) rather than rejecting it. The chat process sends the same request (`claude.go:203`) and passes `--model` whenever the chat has one (`claude.go:70-72`). Still untested: whether `--session-id`/MCP/`--append-system-prompt` change the payload (R3 §7 tested the app's always-on flags without a session, MCP or prompt; R3 open question 2).
2. **Where should `Catalog.Default` come from?** The response has no default-model field (verified); the only signal is the `default` entry, or the first entry / a persisted last choice (the Cursor adapter's `setDefault` pattern). Product decision, not resolvable from code.
3. **What should `DefaultEffort` be for refreshed entries?** No field provides it. The effect of an empty value on the UI is clear from the code, but the desired fallback is a product decision.
4. **Does `claude` accept `--effort` for a model whose list says none (e.g. full haiku id), or error?** Not tested; `Args` would pass `--effort` for a full-ID haiku if one were ever stored (`claude.go:73` matches only the exact string `"haiku"`).
5. **Do the `[1m]` variants the research document mentions exist for other accounts?** Not in this account's list, and no `[1m]` handling exists anywhere in the repo.
6. **Is the `default` alias stable, and does `--model default` honor a user-selected `--effort`?** Verified only that `default` is an offered `value`; its runtime resolution/effort behavior was not exercised.
7. **The research document's claim about the installed `bin/AI Whiteboard.app` binary carrying the old labels:** the bundle exists and how it is built was confirmed, but the shipped binary was not inspected in this job.
8. **Are there other account-dependent flags (`supportsAutoMode`, `supportsFastMode`) the app should surface?** The response exposes them; the app has no UI or model field for them.
