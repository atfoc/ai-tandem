# Subagent card UI — current identity surface

Facts only, against worktree `/Users/pedjat/Documents/projects/ai-whiteboard-worktrees/mcp-subagents-plan` at `b15640a`. Line numbers are current files. Not a plan and not a design.

Verified facts use `path:line`. Anything not pinned that way is in **Assumptions** or **Unresolved**.

---

## 1. Where the card/row renders

`ItemView` routes a tool item through `isSubagentTool`; if true it is a `SubagentRow`, else a `ToolCard` (`web/src/ChatView.tsx:163`). This is the only React branch that draws a subagent card in a thread (parent chat or nested drawer thread — same `ItemView`).

```163:163:web/src/ChatView.tsx
    case "tool": return isSubagentTool(item) ? <SubagentRow item={item} chat={chat} /> : <ToolCard item={item} chat={chat} live={live} />;
```

`SubagentRow` (`web/src/Subagents.tsx:74–92`) is the card. Layout, left to right:

| Slot | Component / class | What it shows |
|---|---|---|
| Status mark | `SubMark` `.sub-mark.st-${status}` | running: pulsing `.sub-dot`; completed: `✓`; failed: `!`; stopped: `■` (`Subagents.tsx:37–39`) |
| Name | `SubName` `.sub-name` | `sa.description \|\| "Subagent"` (`.sub-desc`); optional type badge (`.sub-type`); optional `background` chip (`.sub-bg`) (`41–48`) |
| Live line | `.sub-line.${tone}` | `subLine`: running activity / `Done · …` / error / `Stopped` (`86`, `logic/subagents.ts:73–79`) |
| Stats | `SubStats` `.sub-stats` | model · effort, tool count, duration, context meter (`58–66`, `90`) |

Click / Enter / Space toggles the drawer **only if `sa.id` is set** (`Subagents.tsx:81`, `84`). Unlinked rows have nothing to open. Running rows prefetch the sub thread (`useSubThread` `20–24`, `79`). Open row gets class `on` (`84`).

**Not on the card:** agent kind, agent name, `AgentGlyph`, `agent-*` colour slot, avatars, logos. The row root is `className={`subagent st-${sa.status}${on ? " on" : ""}`}` (`84`) — status only, no `agent-claude|cursor|pi`.

CSS for the row and drawer: `web/src/styles.css:260–285` (comment `260`). Status colours on the mark: completed `--ok`, failed `--danger` (`265`). Running dot `--ok` + `pulse` (`266`). Type badge `--accent`; background chip `--muted` (`270–271`). Live line `--ok`; error `--danger` (`273`). Open row: `--accent` border + `--accent-soft` fill (`263`). No `--claude` / `--cursor` / `--pi` on `.subagent`.

Fallback if a call is **not** routed as a row: `ToolCard` uses `genericTool` cases `"Task"` and `"Agent"` → `"Subagent working|finished: <description>"` (`web/src/logic/labels.ts:41`; tested `web/test/labels.test.ts:65–66`). Pi’s raw name `"subagent"` is not in that switch.

The drawer is mounted at app root (`web/src/App.tsx:74`), not inside the thread.

---

## 2. `isSubagentTool`, `subModelLabel`, `subagentOf`, `subReport`

All in `web/src/logic/subagents.ts` (DOM-free). Tests: `web/test/subagents.test.ts`.

### `isSubagentTool` (`9–11`)

True iff `kind === "tool"` and `name === "Agent" || name === "Task"`. False for perm items, other tools, `undefined`. Does **not** match `"subagent"`, MCP names, or `mcp__board__spawn_subagent`.

### `subagentOf` (`18–34`)

Linked (`item.subagent` present in `subs`): spreads server `Subagent`, then fills blanks from the tool input:

- `description`: `sa.description || input.description`
- `prompt`: `sa.prompt || input.prompt`
- `type`: `sa.type ?? input.subagent_type`

Unlinked / missing state: built from the tool call. `id` is `item.subagent ?? ""`. Status: result or denied → completed/failed; else running only while `chatBusy`, else stopped. Error: `"Denied"` or `it.result` on `isError`. **No model, no background, no agent kind** on the unlinked object.

Displayed from this: name, type badge, background chip, status, live line, stats (model only if `sa.model` is set on the linked state).

Omitted: nothing here copies parent `ChatView.agent`. Type is the **subagent_type** string (`"Explore"`, `"general-purpose"`, …), not Claude/Cursor/Pi.

### `subBadge` (`7`, `37`)

Null for `""`, `"general-purpose"`, `"generalPurpose"`, `"general_purpose"`, `"unspecified"`. Else the raw type string is shown as `.sub-type`.

### `subReport` (`56–65`) / `showReport` (`67–70`)

Report text: `sa.summary`, else foreground completed tool `result`, else last thread text / `sa.last`, else `""`. Drawer “Report” block only when that text is not identical to last text (`Subagents.tsx:167–172`). The **row** does not show the full report; completed rows show `Done · firstLine(report)` via `subLine` (`73–79`).

### `subModelLabel` (`80–107`)

Input: `sa.model` string, **`agent: AgentKind` of the parent chat**, parent’s catalog. Returns `{ model, effort? }` or `null` if `id` is empty (then `SubStats` omits the model span, `Subagents.tsx:63`).

Matching, keyed by the **parent** `agent` argument:

| `agent` | Match |
|---|---|
| exact catalog `m.id === id` | `{ model: m.label }` (any kind) |
| `"cursor"` | `id` = `m.id + "-" + effort` → `{ model: m.label, effort: effortLabel }` |
| `"pi"` | catalog id `endsWith("/" + id)` |
| else (Claude) | catalog id contained as `"-" + m.id` in the full id (`"claude-haiku-4-5-…" → Haiku 4.5`) |
| no match | `{ model: id }` raw |

> Note (2026-10-03): the "else (Claude)" substring row no longer exists — a Claude subagent's model is matched by exact catalog id only, else shown raw (D16); see `plans/claude-model-picker-plan.md`.

Comment at `80–85`: Cursor effort lives in the model id; Claude reports no effort for subagents; Pi reports an unqualified model against provider-qualified catalog ids.

`SubStats` renders `m.model` plus ` · ${m.effort}` when the matcher returned effort (`Subagents.tsx:63`). Both row and drawer pass `agent={chat.agent}` and `cat={s.catalogs[chat.agent]}` (`78`, `90`, `118`, `164`).

**Implication (verified wiring, not a product claim):** a subagent whose runner kind differs from the parent chat would still be labelled with the **parent’s** catalog and matching rules. There is no per-subagent `AgentKind` on the object `subModelLabel` reads.

### Exact fields on `model.Subagent` / web `types`

Go (`internal/model/model.go:347–369`):

```
id, tool, parent, agentId, type, description, prompt, model, background,
status, error, summary, progress, last, tokens, window, toolUses, started, ended
```

Web mirror (`web/src/types.ts:211–231`), comment “field for field, by json name” (`types.ts:1`):

```
id, tool, parent?, agentId?, type?, description?, prompt?, model?, background?,
status, error?, summary?, progress?, last?, tokens?, window?, toolUses?, started?, ended?
```

| Field | Is it agent kind? | Notes |
|---|---|---|
| `agentId` | **No** | Claude `task_id`, Cursor `subagentSessionId` (`model.go:352`) |
| `type` | **No** | Reported subagent type: `"general-purpose"`, `"Explore"`, custom (`model.go:353`) |
| `model` | No | Reported model string; Cursor may embed effort (`model.go:356`) |
| effort | **Absent** | No `Effort` / `effort` field |
| agent kind (`claude`/`cursor`/`pi`) | **Absent** | Lives on `ChatMeta.Agent` / `ChatView.agent` (`model.go:194`, `types.ts:127`, `151`) |

`agent.SubInfo` patch (`internal/agent/agent.go:124–142`) has the same identity-ish fields (`ID`, `Type`, `Description`, `Prompt`, `Model`, `Background`) and **no** `AgentKind` / effort. `patchSub` copies those onto `model.Subagent` (`internal/chats/subagents.go:199–233`).

---

## 3. Agent identity elsewhere (existing visual language)

Single metadata module: `web/src/agents.ts`. Comment: “Everything that shows an agent goes through here” (`1–4`).

| Kind | `name` (user-facing) | `short` | `cls` / glyph | `usageTitle` |
|---|---|---|---|---|
| claude | `"Claude Code"` | `"Claude"` | `claude` | `"Plan usage limits"` |
| cursor | `"Cursor"` | `"Cursor"` | `cursor` | `"Cursor usage"` |
| pi | `"Pi"` | `"Pi"` | `pi` | `"Pi usage"` |
| unknown | raw string | raw string | `unknown` | `"Plan usage limits"` |

Helpers: `agentMeta`, `agentName`, `agentShortName`, `agentClass` (`agents.ts:32–48`). Tests: `web/test/agents.test.ts`.

**Glyphs are inline SVG**, not files. `AgentGlyph` (`web/src/icons.tsx:10–35`):

- cursor: hexagon (`12–16`)
- pi: π-like bars (`18–23`)
- claude: six rotated rects / asterisk (`25–29`)
- unknown: hollow circle (`31–34`)

`aria-label` is `m.name`. Colour via `.glyph.<key> { color: var(--<key>) }` (`styles.css:102–105`).

**No PNG/SVG/ICNS assets for Claude, Cursor, or Pi.** `assets/icon/` holds only the app icon (`AppIcon.icns`, `AppIcon.png`, `artwork.png`). The app `Logo` in `icons.tsx:63–65` is the whiteboard mark, not an agent.

**Colour slots** (`styles.css:14–19` light, `63–68` dark; applied by `.agent-<cls>` `98–101`):

| Token | Light | Dark |
|---|---|---|
| `--claude` / `--claude-soft` | `#d97757` / `#fbeee8` | `#e58c6d` / `#3a2721` |
| `--cursor` / `--cursor-soft` | `#26262b` / `#ececef` | `#d6d6dc` / `#2f2f36` |
| `--pi` / `--pi-soft` | `#0f766e` / `#e6f4f2` | `#4fd1c5` / `#1f3533` |
| `--unknown` | `--muted` / `--hover` | same pattern |

`.agent-<cls>` sets `--agent`, `--agent-soft`, `--on-agent`. Glyph wells (sidebar, header, empty thread) use `background: var(--agent-soft)` (`.side-glyph` `475`, `.crow-glyph` `323`, `.big-glyph` `241`).

Where identity is drawn today:

| Surface | What | Path |
|---|---|---|
| Sidebar chat row | `AgentGlyph` 11px in `.side-glyph.agent-${cls}` + status `.crow-dot`; subtitle is status or `subline` (model · effort), **not** the agent name | `Sidebar.tsx:536–537`, `516–519`; `Composer.tsx:40–44` |
| Sidebar new-chat menu | glyph 13px + `agentName(a)` + `" chat"` | `Sidebar.tsx:291–298` |
| Sidebar board row while a chat is busy | board icon replaced by that chat’s `AgentGlyph` | `Sidebar.tsx:485` |
| Chat header | glyph 14px in `.crow-glyph.agent-${cls}`; subtitle includes `agentName(c.agent)` · cwd · status | `ChatView.tsx:49–61` |
| Empty thread | glyph 28px in `.big-glyph`; title `agentName` | `ChatView.tsx:121–122` |
| Composer | no glyph; placeholder `Ask ${agentName(c.agent)}…` on plain chats; model/effort pickers from `catalogs[c.agent]` | `Composer.tsx:220`, `289–321` |
| Home | Claude glyph 26px + board icon; “New chat” defaults to Claude | `App.tsx:126–130` |
| Canvas presence pill | glyph 12px + `"{short} is working on {board}"` in `.presence.agent-${cls}` | `Canvas.tsx:124–126` |
| Canvas flash tags | glyph 11px + label; border/fill `--agent` | `Canvas.tsx:107–108`; `styles.css:155–158` |
| Markdown | `agent` is passed for reference-chip colour (`Where` context), not a glyph on assistant text | `Markdown.tsx:39–47`; `ChatView.tsx:157` |

`AGENT_ORDER = ["claude", "cursor", "pi"]` (`types.ts:10`; `internal/defaults/defaults.go:14`).

---

## 4. Drawer vs row

`SubagentDrawer` (`Subagents.tsx:106–173`) reuses the **same** `SubMark`, `SubName`, `subLine`, `SubStats` as the row (`152–164`). Extra in the drawer only:

- `‹ n/N ›` over `subList` (all subs of the chat, nested included) (`154–160`)
- Close × / Esc (`161`, `125–137`)
- Prompt block, clamped 8 lines / 600 chars (`91–103`, `166`)
- Sub thread via `ItemView` with `sub={sa}` (`168`) — nested Agent/Task rows are more `SubagentRow`s, still passed the **parent** `chat`
- Report markdown when `showReport` (`167–172`), with `agent={chat.agent}`
- Loading / Starting… placeholders (`167`, `169`)

Gate: hidden unless `sel.chat === subDrawer.chat` and (plain chat **or** board chat with `panel` true) (`107–111`).

Drawer CSS (`styles.css:276–285`): fixed right sheet, no `agent-*` class. Root is `sub-drawer st-${sa.status}` (`Subagents.tsx:149`). There is **no** `.sub-drawer.st-*` colour rule in `styles.css` (status class is set; only `.sub-mark.st-completed|failed` is styled).

**What a row-JSX-only change would miss:** the drawer header identity (name / stats / line), which is a separate tree that happens to call the same subcomponents. A change **inside** `SubName` or `SubStats` would appear in both. The drawer body (prompt, thread, report) has no extra agent chrome today.

**Perm card** (not the subagent card): if `item.subagent` is set, `"Asked by subagent · {description || "Subagent"}"` (`ChatView.tsx:214–222`). No glyph, no agent kind.

---

## 5. Persistence

Path: `chats/<chat>/subagents/<sid>/subagent.json` plus `items.jsonl` (`internal/chats/subagents.go:1–2`, `27–29`).

**Agent kind is not on `subagent.json`.** Confirmed on `model.Subagent` (`model.go:347–369`) and the web mirror (`types.ts:211–231`). Previous research (`plans/mcp-subagents-refresh/subagent-machinery.md` §6; `stale-inventory.md` D4.c) matches HEAD.

Parent kind is on `chat.json` / `ChatMeta.Agent` (`model.go:192–194`).

**Additive JSON extras are dropped on rewrite (verified):**

1. `loadSubs` `json.Unmarshal`s into `model.Subagent` (`subagents.go:45–49`). Go’s default decoder **ignores** unknown fields (this code does not call `DisallowUnknownFields`).
2. `saveSub` writes the **typed struct** with `store.WriteJSONAtomic` → `json.MarshalIndent(v)` (`subagents.go:75–90`; `internal/store/store.go:17–21`). Unknown extras that were on disk are not in `s.meta`, so they are not written back.
3. `saveSub` no-op only when `s.meta == s.saved` (`77–79`). A real write happens on first create (`routeSub` `156`), end, tool-result flush, shutdown, and on load if status was still `running` (rewrite to `stopped`, `56–59`).

So a hand-added `"agent": "cursor"` (or any non-struct field) on `subagent.json` would not survive the next `saveSub`.

`agentId` in JSON is the runner’s session/task id, not `"claude"|"cursor"|"pi"`.

---

## 6. Tests

**Logic (no DOM):** `web/test/subagents.test.ts` covers `isSubagentTool`, `subagentOf` (linked fallbacks for description/prompt/type; unlinked status), `subBadge`, `subActivity`, `subLine`, `subReport`/`showReport`, `subModelLabel` (cursor effort suffix, claude alias, pi suffix; **not** cross-kind), `subToolCount`, `subDurationMs`, `fmtDuration`, `subList`. No test that a `Subagent` has or lacks `agent`. No render test of `SubagentRow` / `SubName` / `SubStats`.

**Agent metadata:** `web/test/agents.test.ts` — names, classes, glyphs, unknown fallback. Not wired to the subagent card.

**Labels fallback:** `web/test/labels.test.ts:65–66` — Task → “Subagent working|finished: …”.

**No snapshot / React tests of the card.** `web/test/` has no `*.snap`. No test file imports `Subagents.tsx`.

**E2E (Playwright-style):** `web/e2e/app.e2e.mjs`

- Step 18 (`861–931`): Claude, two `.thread .subagent` rows; asserts pulsing `.sub-dot` then `✓` / `st-completed`; drawer prompt, `1/2` `2/2`, Esc; reload; `GET .../subagents/{sid}/items`; folder has `subagent.json` + `items.jsonl`. Does **not** assert model text, type badge, background chip, glyph, or agent name.
- Step 19 (`933+`): Cursor rows running, meters, Stop → stopped, still stopped after reload. Same: no agent-identity assertions.

---

## Assumptions

- Native Claude/Cursor/Pi subs at HEAD are the same kind as the parent chat, so `catalogs[chat.agent]` matching `sa.model` is the intended lookup **today**. Not re-verified by spawning a cross-kind child (the app cannot do that yet).
- Go `encoding/json` unknown-field ignore is the language default; not re-tested here beyond reading `loadSubs` / `saveSub`. Same claim already in `subagent-machinery.md` §6.

## Unresolved

- Whether `mcp__board__spawn_subagent` will be added to `isSubagentTool` is a plan decision (`plans/mcp-subagents.md` requirement k). At HEAD that name would render as a `ToolCard`, not a `SubagentRow`.
- No UI inventory of how tight the `.sub-stats` row is at typical widths (whether a glyph would fit). Not measured.
