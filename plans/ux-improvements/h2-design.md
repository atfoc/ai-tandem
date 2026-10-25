# H2 — Row actions, rename, + New, Archived, search: the design the chunks build

The contract is PLAN.md §3 "H2" with §2, notes-foundation.md and h1-design.md; this file fixes what they leave open. Lead: H2 (Opus).
Goal: 3.3, 3.1.3 (archive has Undo, delete asks). Mockups (board `b_edb3unwu`, `get_image` scope rect, scale ≤ 1):
"04 Row actions" `sh-04a…c` (x −2920…−1490, y −3830…−2130), "05 Renaming" `sh-05c` (x −330…260, y −3830…−2600),
"11 New sheet v2" `sh2-11a`, `sh2-11b` (x −1390…−440, y −3830…−2600), "07 Settings › Archived" `sh-07b` (x 1750…2210,
y −3830…−2600), "09 Search" `sh-09a`, `sh-09b` (x 3350…4300, y −3830…−2600).

## 0. Decisions (H2)

| # | Decision | Why |
|---|---|---|
| H2-1 | Search searches the server selected on Home only (its live tree, or the last sync's copy, faded, while it is away); the no-result text names it ("Searched Studio Mac."). Recently opened is filtered to that server too. | goal 3.3 "Home's server chip stays a filter"; 4.1 #5 no "All" |
| H2-2 | No time and no archive date on any H2 row (D5): Archived's sub-line is the row's sub of Home (model line, "Whiteboard · N chats", group counts); search rows have none at the right | goal 4.6 |
| H2-3 | Deleting a **group** on the phone keeps today's two-choice confirm (move contents up / delete everything): `confirm()` draws the dialog for > 1 action (notes-foundation F1). Chats and boards get the P4 of 04c. | no mockup for a group's delete; the choice matters |
| H2-4 | The P1 sheet opens on release of a long press that did not move; a move of 10 pt after the hold starts a drag instead. Drop targets on the phone are the group rows of the screen (into that group); "Move to…" covers every other place. | 3.3; drag targets on a flat list |
| H2-5 | `chatWord` of a chat `waiting` with no running subagent is "Waiting for background work" (tone `wait`), the words T1's header already says; Home and the header now read one list | the brief: Home said "Writing…" |
| H2-6 | Search is a mode of Home (not a pushed screen): Home draws `<Search/>` in place of its top row, title and body while `useSearch()` is open; Back/Cancel closes it | 09a: the bar and the title slide away, the field moves to the top |
| H2-7 | Archived lists, per server whose tree is held: archived groups, archived boards and archived chats that are not inside an archived group or board of the same `archiveOp` (those come back with it). Under each server, items are headed by the name of the (unarchived) group they are in, outermost path joined " › ", upper case; ungrouped first with no head. A server whose tree is not held shows its heading with its state word and "Its archived chats show when it is connected." | archiveOp semantics (model.Archive) |
| H2-8 | Unarchive (Archived's right swipe) shows "Unarchived “X”" with **Undo** (archives again); Archive (Home's swipe/sheet) shows "Archived “X”" with **Undo** (unarchives). The row comes back in its group, in the tree's own order | 3.1.3 reversible → Undo |
| H2-9 | Rename/New/Row sheets are global hosts mounted through `setSlot("Overlays", …)` (home/index.ts), so `openRename(item)` works from Home, a chat (T3's Chat info) and a board (B1's title) | one sheet everywhere |

## 1. Files

| File | Chunk | What |
|---|---|---|
| `home/h2ids.ts` | lead | `H2_TID`, every testID below |
| `home/RenameSheet.tsx` | 1 | `openRename(item)`, `RenameHost` (P3) |
| `home/rowactions.ts`, `home/RowSheet.tsx`, `home/archive.ts`, `home/deletes.ts` | 2 | `useRowActions`, the P1 sheet + Move to… P2, archive with Undo, P4 deletes |
| `home/NewSheet.tsx`, `home/newsheet.ts` | 3 | the "New" sheet with its Where page |
| `home/Archived.tsx`, `home/archivedmodel.ts` | 4 | the `archived` screen (pure model in its own file, unit-tested) |
| `home/Search.tsx`, `home/search.ts`, `home/searchmodel.ts`, `home/recent.ts` | 5 | search mode, its pure model (tested), the two kv lists |
| `home/Home.tsx` (H1's; H2 edits it) | 5 | draws `<Search/>` while open |
| `home/HomeRow.tsx`, `sidebar/drag.tsx` (optional args only) | 6 | drag after the hold |
| `packages/core/src/logic/statewords.ts` + test | lead | H2-5 |
| `web/dev/mock.mjs` `// ux-h2` block, `mock-ui.js` `UXH2`, `checks/UX.H2-rows.mjs`, `checks/rows.mjs` readers, P0.3 `DRAWN` rows, README row | 7 | seeds + the check |
| `SEC.4`, `SEC.5`, `SEC.10` phone halves | 8 | |
| `L14-dragtouch` phone half; `sel.mjs` `openFoot("side-archived")` phone path, `A6.4`, `A1.5`, `SEC.1`, `SEC.6`, `L11` phone uses of Show archived | 9 | |
| `app/e2e/maestro/ux-rows.yaml` | 10 | device |

Tests for pure files go in `app/test/h2.test.ts` (one file; each chunk adds its own `describe`/`test` block, chunks in separate worktrees
add separate files `app/test/h2-<word>.test.ts` to avoid conflicts). Run by the root `npm test`.

## 2. Rename (RenameSheet.tsx) — 05c

`export type RenameItem = { kind: "chat" | "board" | "group"; key: string }`; `export function openRename(item: RenameItem): void`;
`export function RenameHost()` (mounted once, H2-9). A module store holds the open item (as `newsheet.ts` does).

- `FormSheet` (P3): title "Rename chat" / "Rename whiteboard" / "Rename group"; `sub` = the place then the server: the names of the
  groups the item is in, outermost first, joined " › ", then " · " and the server's name ("Checkout service · Studio Mac"); an item
  in no group: the server's name alone. A chat on a board: the board's name first ("Checkout flow · Studio Mac").
- One 44 pt `TextInput` (17 pt, `PHONE.target` min height, 1 px accent border when focused, radius 10), the whole name selected on
  open (`selectTextOnFocus` + autoFocus), a clear button (a 44 pt target, a grey round × glyph; label "Clear name"), `returnKeyType="done"`,
  Return saves when Save is on. Save off while the trimmed name is empty or equal to the current name. `dirty` = changed.
- Save: chat → `api.renameChat(id, name)` (awaited; the error shown in the sheet); board → `boardApp.flush(id)` then
  `upsertBoard(await api.renameBoard(id, name))`; group → `renameGroup(g, name)` (actions.ts; shows at once). Close on success.
- The name read at open: chat `chatTitle(c, threadOf(s, id)?.items)`, board `b.name`, group `g.name`. An item gone while open: close.
- testIDs: sheet `rename-sheet` dataSet {kind, key}; field `rename-input`; clear `rename-clear`. Save/Cancel are FormSheet's
  (`sheet-right`, `sheet-left`).

## 3. Row actions (rowactions.ts, RowSheet.tsx, archive.ts, deletes.ts) — 04a…c

`useRowActions(item: {kind, key}) → { swipe, onLongPress, openSheet }` (signature unchanged), for a live row (HomeList already gives
none to a faded one):
- `swipe` = `[{id:"archive", label:"Archive", tone:"grey", full:true, onPress: archive}, {id:"delete", label:"Delete", tone:"danger",
  onPress: askDelete}]` — a full swipe archives only (`full` on Archive alone). Groups, boards and chats alike.
- `onLongPress` = `openSheet` = `openRowSheet(item)`.
- **archive.ts** `archiveItem({kind,key})`: chat → `api.archive("chats", id)`; board → `archiveBoard(b)` of actions.ts (it asks
  first when an agent works on it, then archives); group → `archiveGroup(g)`. On success `showToast({ text: \`Archived “${name}”\`,
  action: { label: "Undo", run: () => api.unarchive(kind+"s", id) } })`. Add to actions.ts (append) an `onDone?: () => void` optional
  argument to `archiveBoard`/`archiveGroup` if the toast needs to wait for the call (wide callers pass nothing: unchanged).
  `unarchiveItem` the same, toast "Unarchived “X”", Undo archives again (Archived's swipe).
- **deletes.ts** `askDelete({kind,key})`: chat → `confirm({ title: \`Delete “${name}”?\`, body: <what is lost and where>,
  confirmLabel: "Delete chat", actions: [{ label: "Delete", tone: "danger", run: () => api.deleteChat(id) }] })`; body: "Its history
  is removed on <server>, for everyone who uses that server. This can't be undone.\n\nTo keep it out of the way instead, archive it."
  (this computer: "Its history is removed from this computer. This can't be undone. …"). Board: title `Delete “<name>”?`, body
  `boardDeleteBody(busy, there)` + the archive sentence, confirmLabel "Delete whiteboard", run as `deleteBoard` does (stop busy chats,
  flush, delete): add an exported helper to actions.ts rather than copying. Group: `deleteGroup(g)` as today (H2-3).
- **RowSheet.tsx** `openRowSheet(item)`, `RowSheetHost` (H2-9): `ActionSheet` (P1) head {icon: the row's tile glyph, title: name, sub:
  "Chat · Checkout service · Studio Mac" (kind word "Chat"/"Whiteboard"/"Group", the group path, the server)}; items: **Open**
  (`openItem`), **Rename…** (`openRename`), **Move to…** with `note` = the current group's name ("Not in a group" at the top) and a
  chevron-like note "›" (→ closes, then a `PickerSheet` (P2) "Move to" sub "<name> is in <group>": options = `moveTargets(groups,
  current)` for boards/chats (`moveTo("board:"+id | "chat:"+id, group)`), for a group the groups it may go into (not itself or its
  subtree; "Top level" = parent ""; `moveGroup(id, parent)`); a chat on a board has no Move to… row), **Archive**; destructive
  **Delete chat…** / **Delete whiteboard…** / **Delete group…** → `askDelete`. Icons 20 pt from `ui/icons.tsx` (add none to ui;
  use what exists: an "Open" arrow may be `ChevronIcon`-like — use existing glyphs, plain text glyph only if none). Each pick closes
  the sheet first, then runs (`later` of sidebar/menus.tsx: a second modal can't rise while the first goes on iOS).
- The group screen's "…" (`group-more`) already calls `openSheet` (GroupScreen.tsx).
- testIDs: sheet `row-sheet` dataSet {kind, key}; rows are ActionSheet's `action-row` dataSet `action` = open|rename|move|archive|delete;
  move picker `move-sheet`; toast is the kit's (`toast`, `toast-action`).

## 4. New (NewSheet.tsx, newsheet.ts) — 11a, 11b

`openNewSheet(place)` unchanged. The sheet (`Sheet` detent fit, `SheetHead title="New"`; on the Where page the head is
`left={label:"‹ New"}` (back to the first page), title "Where", `right={label:"Done", strong}` (back to the first page)).
- Page 1: section label "WHERE" (13 pt muted caps), a card (48–60 pt, radius 10, `line` border): folder tile, the group's name (17 pt;
  "<server name>" at the top level), its sub "● <server> · the group you are in" (dot in the server word's tone; at the top
  level: "● <server> · not in a group"), and **Change ›** (accent, 44 pt target) — the whole card presses into page 2. Then a bigger
  gap (24 pt), "WHAT TO MAKE", two tiles side by side (min 100 pt high, radius 10, border): **Chat** (agent glyph tile, "Talk to an
  agent") and **Whiteboard** (board tile, "A board agents can draw on"); then a row (50 pt) **Group** with the note "Name it next ›".
  Footnote 13 pt muted "A chat on a board starts from the board".
- Chat → `newChat({ group: chosen || ungroupedOn(server) })`; Whiteboard → `addBoard(group)`; Group → `newGroup(server, chosen)` then
  `openRename({ kind: "group", key })` (named next). Each closes the sheet first.
- Page 2 (Where): "● <server>" line and "Things are made on the server Home shows" (13 pt muted); a crumb row: server name, then each
  group of the path, accent, each pressable (goes up to that level); the current level's own name plain. Then a tinted row (accent soft
  fill) "Put it in <level name>" with ✓ when it is the chosen one (top: "Put it at the top of <server>"); then "GROUPS IN <LEVEL>" and a
  48 pt row per child group with a chevron (goes one level down). Choosing a level sets the chosen group and goes back to page 1.
  One level at a time, no indent; only the selected server's tree (`placeLists`-like source: `buildTree` of that server, archived out).
- testIDs: sheet `home-new-sheet` (kept: SEC.4 reads it) dataSet {page: "what"|"where", group}; `new-where` (the card), `new-change`,
  `new-chat`, `new-board`, `new-group`; page 2: `new-crumb` dataSet {group} ("" = top), `new-put` dataSet {group}, `new-level` dataSet {group}
  (a child row), `new-back` is SheetHead's `sheet-left`, Done `sheet-right`.

## 5. Archived (Archived.tsx, archivedmodel.ts) — 07b

`registerScreen("archived", { kind: "place", title: () => "Archived", component: Archived })` at import (wins over S1's placeholder:
home/index.ts imports it). Body: a ScrollView on `t.bg`:
- per server (`homeEntries` order): a 20 pt 600 heading with the name and `<StateWord word={useServerWord(v)}/>`; then H2-7's lists:
  a section head (13 pt muted caps, the count at the right, as HomeList's) per group path, then rows drawn with `HomeRow` (same row,
  full contrast, sub per H2-2) wrapped in a `SwipeRow` with `left=[{id:"unarchive", label:"Unarchive", tone:"accent", full:true}]` and
  `right=[{id:"delete", label:"Delete", tone:"danger"}]` (Delete → `askDelete`). A tap opens the item (read-only thread or board).
  `HomeRow` gains an optional `left?: SwipeAction[]` prop (H1's file, backward compatible) or Archived wraps the row itself: the chunk
  picks the smaller change.
- Footer (13 pt muted, 16 pt margins): "Archived chats are read-only. Unarchive one to continue it."
- Nothing archived anywhere: "Nothing is archived." centred (17 pt muted) above the footer.
- testIDs: `archived-screen`; `archived-server` dataSet {server}; `archived-section` dataSet {server, group, count}; rows are `home-row`
  (dataSet adds `archived: "true"`), `archived-empty`, `archived-foot`.
- `sel.mjs` `openFoot("side-archived")` on the phone: Settings › Archived pushes this screen and answers it (chunk 9).

## 6. Search (Search.tsx, search.ts, searchmodel.ts, recent.ts) — 09a, 09b

`openSearch()` / `closeSearch()` / `useSearch(): boolean` (search.ts). Home draws `<Search/>` instead of its top row, title, chips and
body while open (H2-6); Android back / `goBack` while open closes it (register through whatever Home already uses for back; if none,
`BackHandler` on native, nothing on web — Cancel is the way there).
- Top: `SearchField` (ui) autoFocus, placeholder "Search boards and chats", `onCancel` = close. Under it scope chips **All**,
  **Boards**, **Chats** (36 pt, 44 pt target, selected filled `t.text` with `t.bg` text, as ServerChips).
- Before typing (query empty): "RECENT SEARCHES" with **Clear** at the right, rows (44 pt+, a search glyph, the words, an × "Remove";
  a tap fills the field); then "RECENTLY OPENED": the last boards and chats opened on the selected server (≤ 5), 60 pt rows (`HomeRow`
  look) with the place "Studio Mac › Checkout flow" as sub. Empty lists are not drawn.
- Typing: results by kind — BOARDS, CHATS, GROUPS (scope chips filter: Boards → boards only, Chats → chats only; All → all three)
  — each with a count; name match case-insensitive substring, the matched part bold (`weight="600"`); sub "server › group › group"
  (a chat on a board: "server › on <board name>"); a faded result (the server away: last sync) at opacity 0.45 with "● <server> ·
  offline"-style sub using the server's state word. Group rows have a chevron.
- Open: board → `openBoard`; plain chat → `openChat`; a chat on a board → `select({ board, chat })` (back goes to the board); group →
  `setHomePlace({ server, groups: path keys })` and close search (Home then shows the stack of that group: F2's `pushGroup` chain);
  board/chat: close search, then open. Opening records the query in recent searches.
- No results: "No boards or chats match “<q>”" (17 pt), "Searched <server name>." (13 pt muted), and a **New chat “<q>”** button
  (`size="touch"`) → `newChat({ group: ungroupedOn(server) })` and the words put in its draft through the composer's own draft path if
  one exists (the chunk finds it; if none, the chat opens empty and the chunk reports it).
- recent.ts: `aiwb.search.recent` (JSON string[] , newest first, ≤ 8, de-duplicated case-insensitively), `aiwb.search.opened`
  (JSON {key, kind}[] newest first, ≤ 10): kv through the app's `safeGet`/`safeSet` (grep them). `noteOpened` is fed by a store
  subscription made once in home/index.ts: each change of `sel.board`/`sel.chat` to a non-null value records it (the chat when there
  is one, else the board).
- testIDs: `search` (root, dataSet {scope, state: "recent"|"results"|"none"}); field `search-field` (SearchField's own default id
  is fine if it is that); `search-scope` dataSet {scope, selected}; `search-recent` dataSet {words}, `search-recent-remove`,
  `search-clear`; `search-section` dataSet {section, count}; `search-row` dataSet {kind, key, server, stale}; `search-none`,
  `search-new-chat`.

## 7. Drag after the hold (chunk 6) — 04b #2

`HomeRow` rows that have actions: one RNGH `Gesture.Pan().activateAfterLongPress(LONG_PRESS_MS)` replacing the Pressable's
`onLongPress` on native and web-touch: on activation `haptic("select")`; if the finger then moves ≥ 10 pt, a drag starts through
`sidebar/drag.tsx` (a new optional parameter of `useDragGesture` for the hold time and the "moved" threshold; its wide behaviour is
unchanged) with the group rows of the screen registered as drop places (`usePlace("zone", groupKey)`; a group row draws the drop mark
when `dropAt.zone === key`); release with no move → `openSheet()`. The SwipeRow's horizontal pan and the list's scroll still work
(a swipe before the hold is a swipe). On the web build a mouse has no long press drag (as SwipeRow).

## 8. Check UX.H2-rows (chunk 7)

Seeds `UXH2` (mock-ui.js; mock.mjs `// ux-h2` block for what it needs): one server with a group "Checkout service" (two boards, chats,
a subgroup), loose chats, and archived things (an archived chat in a group, an archived board, an archived group holding a chat; a
second server with one archived chat). Steps at phone, light and dark where 6.1 asks: swipe left shows Archive and Delete 88 pt wide
and the row's height; full swipe archives and the toast says "Archived “…”" with Undo; Undo puts the row back at the same index;
Delete asks (P4: title in quotes, "Delete chat", Cancel) and Cancel keeps it, confirm removes it; long press opens the P1 sheet with
Open, Rename…, Move to… (note = group), Archive, Delete … last red; Move to… moves; Rename from a row (Save off when unchanged,
Return saves), from the group screen's "…", and `openRename` for a board (through a seam or B1's title when merged) — T3's Chat info
calls the same; + New: card, Change, Where page (crumb, Put it in, child level), Chat/Whiteboard/Group make in the chosen group;
Archived: grouping by server and group, Unarchive by right swipe (+ toast), Delete by left swipe (asks), footer; Search: recent state
(after one search, recent and recently opened), results (bold match, sections, a board chat "on <board>", group opens Home on it),
scope chips, no results with the server named and New chat; a faded result while the server is away. Sizes: targets ≥ 44, text ≥ 13.

## 9. Device (chunk 10)

`app/e2e/maestro/ux-rows.yaml` on the lead's own iOS simulator `ux-h2` under the heavy lock: swipe left on a Home row (Archive,
Delete), full swipe and Undo, long press opens the sheet (the haptic cannot be asserted: the flow names it), long press + move
starts a drag that drops on a group row. Android: skipped (no JDK 17, notes-foundation).
