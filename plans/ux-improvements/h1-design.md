# H1 — Home, groups as screens, server chips, first run: the design the chunks build

The contract is PLAN.md §3 "H1" with §2 and notes-foundation.md; this file fixes what they leave open. Lead: H1 (Opus). Mockups (board
`b_edb3unwu`): "10 Home v2" `sh2-10a…d` (rect x −7540…−5610, y −3820…−2620), "08 Empty Home and first run" `sh-08a`, `sh-08b`
(rect x 2320…3260, y −3820…−2520), the stack `sh-02b`, `sh-02c` (x −5490…−4580).

## 1. Files (all new under `app/src/screens/home/` unless named)

| File | What |
|---|---|
| `model.ts` | pure (no React, no react-native; Node loads it): the lists of a place, sub-lines, dots, counts, place line, the server entries |
| `ids.ts` | `H1_TID`, the testIDs below |
| `HomeRow.tsx` | the 60 pt row (contract below) |
| `rowactions.ts` | `useRowActions(item) → RowActions` stub returning `{}` (H2 replaces) |
| `Home.tsx` | Home: top row, large title, sub-line or chips, search, the list / problem card / first run / empty / placeholders |
| `ServerChips.tsx` | the chips row |
| `GroupScreen.tsx` | a group pushed as a screen |
| `HomeList.tsx` | the three sections of rows of a place (Home's and a group's), with the faded mode |
| `ProblemCard.tsx`, `FirstRun.tsx`, `EmptyHome.tsx`, `Placeholders.tsx` | the states |
| `newsheet.ts` | `openNewSheet(place)` stub until H2: a P1 ActionSheet "New" (New chat, New whiteboard, New group) at the place |
| `search.ts` | `openSearch()` stub until H2 (does nothing) |
| `serverseam.ts` | `openServerSheet(id)` (S2 replaces through `setServerSheet(fn)`; placeholder: a P1 sheet), `openServerDetail(id)` (`pushScreen("server", {id})` when registered, else today's Servers dialog) |
| `settings.ts` | `openSettings()`: `pushScreen("settings", {})` when S1 registered it, else the stop-gap sheet (§6) |
| `lastsync.ts` | the in-memory copy of each server's last tree (§5) |
| `seam.ts` | uicheck-only `window.__aiwbHome` (§8) |
| `index.ts` | imports seam |
| `screens/shell/phone/HomeRoute.tsx` | `HomeRoute` draws `<Home/>`, `GroupRoute` draws `<GroupScreen/>` (H1 owns this file) |

Tests: `app/test/home.test.ts` (model.ts). The wide layouts are untouched: the sidebar stays as it is.

## 2. Which server Home shows

- **Entries**: `sidebarEntries(servers)` filtered as the sidebar does (`hasThisComputer() || (!v.local && v.id !== LOCAL_SERVER)`).
  This computer is an entry named by its `name` ("This computer") like any other (D11).
- **Selected**: `useHomePlace().server` when it is one of the entries, else the first entry (Home writes it with
  `setHomeServer(first)` only when no server was saved: a saved one that is not listed yet, as after a reload before the server list
  has come, keeps its place). No entries → first run (§4).
- **Chips** only with two entries or more; a chip press `setHomeServer(id)` (no-op when it is the selected one); long press
  (`LONG_PRESS_MS`, `haptic("select")`) `openServerSheet(id)`. One entry → no chips; the sub-line under "Home" is
  `<StateWord word={useServerWord(v)}/>` preceded by the server's name: "● Studio Mac · Connected" (sh-08b #7).
- Chip look: 36 pt high (`PHONE.chip`) with a 44 pt target (hitSlop), radius 8, 1 px `line` border; a dot (8 pt) in the tone of
  `serverWord` (`toneOf`) then the name at 15–17 pt; the selected chip filled with `t.text` and its name in `t.bg`. A chip of a server
  that `needsAttention` keeps its dot red/amber (that is "the dot on its chip" of 10d #2). Horizontal scroll when they do not fit.
  Accessibility: role "tab"-like `button` with `aria-selected`, label "<name>, <word>".

## 3. The lists (model.ts, HomeList.tsx, HomeRow.tsx)

`placeLists(input, server, group: string | null) → { groups: RowItem[]; boards: RowItem[]; chats: RowItem[] }` from `buildTree`
of that server **with `showArchived = false`** (archived things are Settings › Archived's, H2), `group` null = the top level
(the tree's top groups, loose boards, loose chats), else that group's node (children, boards, chats). Sorting as `buildTree`.

`RowItem = { kind: "group" | "board" | "chat"; key; server; name; sub; subTone?: WordTone; attention: { kind: "none" } | { kind: "dot" } | { kind: "count"; n } ; agent?: string }`

- **group**: sub = the counts of its direct children, non-zero parts only, in the order boards · groups · chats ("4 boards · 2
  groups · 3 chats", "2 boards", "1 board · 1 group"); nothing in it → "Empty". attention = count of chats in its whole subtree
  (plain chats and chats on its boards, not archived) that `needsYou`; `count` when > 0.
- **board**: sub = "Whiteboard · N chats" ("1 chat", "no chats yet"), its chats = `boardChats(chats, key, false)`; no edited time
  (D5). attention = dot when any of its chats `needsYou`.
- **chat**: sub = `chatWord(c)?.text` in its tone when non-null, else `subline(c, catalog of its server)` (sidebar/subline.ts:
  "Sonnet 5.5 · Medium"). attention = dot when `needsYou(c)`. No time at the right (D5).

`placeLine(server name, group chain names)`: Home with one server = the StateWord line above; a group screen = `[server name,
...ancestor group names].join(" › ")` + " · " + its counts (as the group row's sub, "Empty" omitted): "Studio Mac · 2 groups ·
2 boards · 2 chats" (10b), "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat" (10c: the full place, server first).

**HomeList** draws, for each non-empty list, a section head (13 pt, `muted`, upper case "GROUPS" / "BOARDS" / "CHATS" at the left and
the number of rows at the right, 16 pt margins) then the rows. Prop `stale` (§5): the whole list at opacity 0.45 and a row press says
the server is offline (toast) instead of opening.

**HomeRow** {item: RowItem, onPress, swipe?: SwipeAction[], onLongPress?, dim?}: 60 pt min height (`PHONE.listRow`), 16 pt side
margins; a 36 pt icon tile (group: `GroupIcon` outline in `muted`; board: `BoardIcon` on `accentFill`-ish tile; chat: the agent's
`AgentGlyph` in a tile), then the name at 17 pt (`TYPE.control`, `numberOfLines={2}`: never cut to one line) and the sub-line at
13 pt (`TYPE.secondary`, `muted`, or the word's colour via `wordColour`), then at the right: a group's count badge (amber `warn`
fill, `onAccent`-readable text, min 20 pt) and a chevron (`DisclosureChevron`) for groups and boards; the dot (8 pt `warn`) sits on
the icon tile's top-right corner for boards and chats. Hairline separators inset to the text. No "…", no "+". With `swipe` the
row is wrapped in `SwipeRow`; `onLongPress` with `delayLongPress={LONG_PRESS_MS}`. Accessibility: role button, label "<name>,
<sub>[, needs you | N need you]". Press: group → `pushGroup(key)`; board → `openBoard(key)`; chat → `openChat(chat)`.
`useRowActions(item)` gives `{ swipe?, onLongPress?, openSheet? }`; H1's stub returns `{}`.

## 4. Home's states (in this order of precedence, for the selected entry `v`)

1. **No entry** → `FirstRun` (sh-08a): no large title, the top row is the logo + "AI Whiteboard" + the gear; three tiles; "Connect to
   your computer" (20 pt, 600); the paragraph (16 pt muted, centred); **Add a server** (`Button size="block" tone="primary"`) →
   `openAddServer("paste")`; **Scan the server's code** (`size="block"`, outlined) → `openAddServer("scan")`; the card "ON YOUR
   COMPUTER" with the three numbered steps (text as drawn); the link "How to set up a server" → `Linking.openURL` of the guide URL the
   servers code already uses (grep `setup` in `screens/servers`; if none, the repo's README section on remote servers on GitHub — ask
   the lead). `openAddServer(how)` lives in `serverseam.ts`: `pushScreen("add-server", {how})` when S2 registered it, else today's
   Servers dialog opened on its add form (`openServers()`; read `screens/servers` for how today's add is opened). No "+ New", no search.
2. **Connecting** (`v.state === "connecting"`, or connected and the tree not held yet) → the list replaced by 5 placeholder rows
   (60 pt, grey bars, `home-placeholder`), "+ New" drawn disabled (dimmed).
3. **Trouble** (`needsAttention(v)`, or iOS local network off) → `ProblemCard` above the list; the list below is the last sync's,
   faded (§5). Card (10d): `danger`-tinted for bad words, amber for Too old; first line the server's name with its dot at the left and
   the word + " · " + `formatSince(serverSince[v.id], now)` at the right ("Unreachable · since 9:12"); a sentence: unreachable/offline
   "Can't reach <name>. Its boards and chats come back when it does."; the word's `reason` when it has one (the states folded into
   Unreachable) on its own line; cert changed "<name>'s certificate changed. Nothing is sent until you review it." with **Review**
   (→ `openServerDetail(id)`) instead of Try again; too old "<name> runs an older server (version X). Update the server on that
   computer." (no minimum: D5); local network off: "Local network access is off for AI Whiteboard. Turn it on in Settings ›
   Privacy › Local Network." Buttons (44 pt, `size="touch"`): **Try again** (primary) and **Details** (outlined) →
   `openServerDetail(id)`. Try again: for a remote entry `serversApi.testSaved(id)` with the button busy ("Trying…") and the answer's
   message shown in the card if it failed; for this computer the `localExtra` actions (Retry → `startAgain`/`restartServer`,
   Restart server, Open server log) and its reason box, as `sidebar/Section.tsx` `LocalExtras` does.
4. **Connected, nothing on it** (the tree held and empty, archived ignored) → `EmptyHome` (sh-08b): two tiles, "Start a chat or a
   whiteboard" (20 pt), the agents line "<agents> are ready on <server name>." from the server's `usable` agents (`agentName`, joined
   "A, B and C"; none → "No agent is installed on <server name>."), **New chat** (block, primary) → `newChat({group: ungroupedOn(v.id)})`,
   **New whiteboard** (block, outlined) → `addBoard(ungroupedOn(v.id))`, the footnote "A whiteboard is an Excalidraw board with its own
   chats that can see it and draw on it." No search field in this state (sh-08b #7 "no search yet").
5. Otherwise the list (`HomeList`).

Home's top row (all states but first run): left the logo tile (`Logo`, 28 pt, not a button); right **+ New** (`Button size="touch"
tone="primary" label="+ New"`, `openNewSheet({server, groups: []})`; absent in first run; disabled while connecting or when the
server is not connected) and the gear (`IconButton size="touch"`, `GearIcon`, label "Settings", `openSettings()`). Then
`LargeTitle title="Home"` (sub only with one entry: §2), then the search field lookalike (a 44 pt pressable drawn like `SearchField`,
placeholder "Search boards and chats", `openSearch()`; hidden in first run and empty Home), then chips, then the state's body in
a ScrollView. Safe-area top inset respected.

## 5. The last sync (lastsync.ts)

The store drops a remote server's tree when it leaves `connected` (core `state/conn.ts` `leaves`). Home keeps, **in memory only**, the
last `placeLists` input it drew per server (`{groups, boards, chats}` of that server) and, while the server is not connected, draws
that copy faded (`stale`). A press on a faded row shows `showToast({text: "<name> is offline. Its boards and chats come back when it
does."})` and opens nothing. Nothing is saved; after a restart a server that is down shows the card alone. Group screens of that
server use the same copy.

## 6. Settings until S1 (settings.ts)

`openSettings()`: `screenSpec("settings")` → `pushScreen("settings", {})`. Otherwise a `Sheet` (detent fit, head `SheetHead
title="Settings"`, testID `home-settings-stopgap`) holding today's `sidebar/Foot.tsx` `<Foot/>` (Show archived, Servers, Library,
voice settings, theme), so the foot's testIDs (`side-archived`, `servers-btn`, `library-btn`, `settings-btn`, `theme-btn`) stay
reachable on the phone. `sel.mjs` `openFoot(page, id)` goes Home → gear → that control; S1 changes `openFoot`'s phone path when its
Settings screen replaces the sheet.

## 7. Group screen (GroupScreen.tsx)

Entry key from `useEntryKey()` (keep the id while sliding out, as F2's stand-in does). Bar: `PlaceBar back={<NavBack/>} title=""`
with `right` = **+ New** (`size="touch"`, `openNewSheet({server, groups: path to this group})`) and, when `useRowActions({kind:
"group", key}).openSheet` exists, a "…" `IconButton size="touch"` (`group-more`, H2). Then `LargeTitle title={group name}
sub={placeLine}`, then `HomeList` of the group. Empty group: "Nothing here yet" (17 pt, centred, muted) and a **+ New** button
(`home-empty-new`). A group no longer in the tree (deleted, server gone): the bar and "This group is no longer on <server>."

## 8. testIDs (`home/ids.ts` `H1_TID`) and the check seam

| testID | dataSet | Where |
|---|---|---|
| `home` | `server` (selected entry id), `state` (`first-run` \| `connecting` \| `trouble` \| `empty` \| `list`) | Home's root |
| `home-new`, `home-gear`, `home-search` | | the top row, the search lookalike |
| `home-sub` | | the one-server sub-line |
| `server-chips` / `server-chip` | chip: `server`, `word` (state key), `selected` ("true"/"false") | chips |
| `home-list` | `stale` ("true"/"false") | HomeList root |
| `home-section` | `section` (groups/boards/chats), `count` | section heads |
| `home-row` | `kind`, `key`, `server`, `attention` (none/dot/count), `count` (n or "") | HomeRow; children `home-row-name`, `home-row-sub`, `home-row-dot`, `home-row-count` |
| `group-screen` | `key` | GroupScreen root; `group-new`, `group-more`, `group-empty` (+ `home-empty-new`) |
| `problem-card` | `server`, `word` | + `problem-retry`, `problem-details`, `problem-review`, `problem-reason`, `problem-message` |
| `first-run` | | + `first-run-add`, `first-run-scan`, `first-run-guide` |
| `home-empty` | | + `home-empty-chat`, `home-empty-board`, `home-empty-agents` |
| `home-placeholder` | | each placeholder row |
| `home-settings-stopgap` | | §6 |
| `server-sheet-stopgap` | | serverseam's placeholder sheet |

F2's stand-in ids `group-row`/`group-item` go; `UX.F2-stack` is updated to `home-row` (H1 does it).

Seam (uicheck builds only, `seam.ts`, as F2's `phone/seam.ts`): `window.__aiwbHome = { placeOf(kind, key) → { server, groups:
string[] /* outermost first */, board: string | null }, server(): string | null }`, from the store: `server = serverOfKey(key)`;
a chat on a board → `board` = its board and the groups of the board; groups = the chain of `group` keys from that server's groups
(`groupPath`-like, keys not names).

## 9. sel.mjs (the checks' phone path; lead/Opus chunk)

`IDS` gains `home`, `homeRow`, `chip`, `groupScreen`; `IDS.tree`/`IDS.row` stay for the wide layouts. Phone:
- `showHome(page, server?)`: back until `home` is visible (≤ 8 backs), then press the chip of `server` when chips are drawn and it
  is not the selected one; waits for `home[data-server=…]`.
- `showList(page)`: wide unchanged; phone = `showHome(page)` and answers the `home` locator (callers that read sidebar sections on the
  phone are rewritten).
- `openRow(kind, key)`: phone = `__aiwbHome.placeOf` → `showHome(server)` → press each group row in turn, waiting for its
  `group-screen` → the row of the board (for a board chat) or the item → for a board chat: `openBoardChat(page, board, chat)`.
- `openBoardChat`: press `board-chats` if drawn; if B1's Chats sheet appears within 4 s (`chats-sheet`, rows `chats-sheet-row`
  dataSet `key` — B1's contract, named in H1's report) press the row; else `__aiwbStack.select({board, chat})`.
- `openFoot(page, id)`: wide: the sidebar's foot control; phone: Home → `home-gear` → the control in the stop-gap (or S1's screen).
- New readers in `home.mjs` (no dash): `homeSeen(page)` → `{ state, server, chips: [{server, word, selected}], sections:
  [{section, count}], rows: [{kind, key, name, sub, attention, count}], card?: {server, word, text} }`.
