# Coverage: every mockup of goal section 3 against the check that shows it (goal 6.1)

Written by R1 chunk 6 on branch `ux-r1-6` (from `ux-r1` 1892683). Sources: `ux-improvements-goal.md` (3.1 to 3.8, 6.1 to 6.3), the board
`plans/ux-improvements/board-v3.txt` (titles and callouts), the headers of `web/dev/checks/UX.*.mjs` and of the older checks whose phone
halves were rewritten, the seeds of `web/dev/mock-ui.js`, `P0.3-smoke`'s `DRAWN` table (102 seeded states), `app/e2e/maestro/*.yaml` and every
`plans/ux-improvements/status-*.md`. Nothing here was re-run: "passed" is what a status file says its owner saw.

**How to read the tables.**

- A **mockup** is a numbered frame of the board with its title ("10a Home v2", "04 Row actions"; a lettered frame is a row of its own).
  "Before" frames (the first design of an area, kept on the board as the thing replaced) are listed with the tag `BEFORE` and are not designs to build.
- **Check · scenario** names the file and the scenario of its header (`UX.H1 · four`); `P0.3` means the seeded state also appears in `DRAWN`
  (each is drawn at the three viewports with no page error). Unless the Note says otherwise a `UX.*` check runs at the phone, in the light
  theme; the dark theme is said where the check runs it (UX.H1, UX.S1, UX.S3, UX.S4.x, UX.T2, UX.T3, UX.F1, UX.B1, UX.B2 and one colour
  assertion each in UX.H2).
- **Rules** is the UX.R1 recipe group that walks the screen for goal 6.2 (targets, text sizes, desktop words, focus, sheet heads, state words;
  `web/dev/checks/rules/<group>.mjs`): `home`, `settings`, `chat`, `composer`, `board`. The groups are being written in parallel by chunks
  1 to 5; this column follows the split of their briefs (cite the group, not a recipe), so a screen's exact recipe is the group owner's.
- **Device flow** is `app/e2e/maestro/<flow>.yaml`, only where goal 6.3 says a device alone shows the thing.
- Note starts with the status of the row: `B` a browser check covers it, `B+D` a browser check and a device flow, `D` a device flow only,
  `N` not covered (with the reason), `BEFORE` a before frame.
- V1 (blocked states and voice) **is merged** (ux-improvements b446af3, into `ux-r1` f3563d2). R1's second part (lead Opus 5.5) filled the
  recipes that waited for it: `composer.v1-*` (the blocked states, chunk 11) and the group `voice` (`voice.dictate`, `voice.speech-bar`,
  `voice.speech-bar-send`, `voice.setup`, `voice.card`, `voice.speech-selection`, chunk 12); V1's own check `UX.V1-voice` (scenarios 1 blocked,
  2 dictate, 3 speech, 4 set up, 5 board) and the VC phone halves (VC.2 to VC.7) are on `ux-r1` with it. Rows that said "N (V1)" are updated below.

## 3.1.4 The five patterns ("00 Five phone patterns every area reuses")

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 00a P1 Action sheet | 3.1.4 | UX.F1 · sheets (ActionSheet: 50 pt rows, 17 pt labels, destructive last after a separator, no Cancel row); users: UX.H2 · sheet, UX.T1 · message, UX.T3 · info | every group (the walker's rules: sheet head, danger last and red, no Cancel in a P1) | `sheets` 7a (detents) | B+D |
| 00b P2 Picker sheet | 3.1.4 | UX.F1 · picker (✓ and aria-checked, tap picks and closes, Done with `extra`, search pinned past eight); users: UX.C2 · 2 to 5, UX.S1 · Appearance, UX.S3 · settings | composer, settings | `sheets` 7a | B+D |
| 00c P3 Form screen | 3.1.4 | UX.F1 · forms (Cancel · Title · Save, Save off, guard on a dirty form); users: UX.H2 · rename, UX.S3 · Add key, UX.S4.2 · editor | home, settings | `sheets` 7b (rides the keyboard, Save above it) | B+D |
| 00d P4 Confirm | 3.1.4 | UX.F1 · forms (ConfirmSheet: tile, 20 pt title, 50 pt button, Cancel, busy and error inside; `confirm()` as a sheet); users: UX.H2 · swipe, UX.T3 · delete, UX.S2 · remove | every group | none needed | B |
| 00e P5 Pushed list screen | 3.1.4 | UX.F1 · cells (Cell/CellGroup 48 pt, chevrons, PlaceBar, ContentBar, LargeTitle); users: UX.S1, UX.S2 · list | settings | `ux-stack` (a pushed screen's back) | B+D |

## 3.2 Home and the stack

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 10a Home v2 (one server at a time, chips, dot and count) | 3.2 | UX.H1 · one (no chips, "Studio Mac · Connected"), four (four chips with state words, a chip press switches the server, GROUPS · BOARDS · CHATS with counts, group count, dot on a chat, no "…" or "+" in a row, rows ≥ 60 pt), kinds (count 2, a board with a busy chat has no dot, one with an approval has the dot); P0.3 UXH1.one, four, kinds | home | `ux-stack` (Home row → group) | B. Light and dark. The chip's state words against the one list: UX.S2 · list and the unit test `statewords.test.ts`. |
| 10b Group screen | 3.2 | UX.H1 · nested (large title, place line with the full place, back naming the parent), kinds; UX.F2 · from a row; P0.3 UXH1.nested | home | `ux-stack` | B+D. Light and dark. |
| 10c Nested group, empty group | 3.2 | UX.H1 · nested (each back one level, then down by the rows), empty-group ("Nothing here yet" and its "+ New"); UX.F2 · hold (the stack sheet of the held back); P0.3 UXH1.empty-group | home | `ux-stack` (hold the back, Home row of the sheet) | B+D |
| 10d Trouble on the selected server | 3.2 | UX.H1 · trouble (card above a faded list, press on a faded row says "offline"), cert ("Certificate changed · Review", no list); UX.X2 (the stack and the faded group during an outage); AAC.2-localdown, AAC.3 phone halves; P0.3 UXH1.trouble, cert | home | none needed | B. Light and dark (UX.H1). "Details opens the server's sheet" is UX.S2 · sheet. |
| 02b The stack and the back (content screens: chevron alone) | 3.1.2, 3.2 | UX.F2 · from a row, labels (content back has no label, place back names its parent), system back; UX.B1 · the bar (`nav-back` without label) | home | `ux-stack` (edge swipe back on a chat and a group; on a board the edge swipe does not leave it, its back control does) | B+D. iOS passed (F2 chunk 8; kept passing after H1's PlaceBar fix); Android half written, not run (no JDK 17). |
| 02c A chat on a board: stack Home › board › chat, hold the back | 3.1.2 | UX.F2 · from a chat, hold; UX.X2; UX.B1 · the sheet (chat's back lands on the board); P0.3 | home, board | `ux-stack` (hold the chat's back, "Go back to", Home row) | B+D. Android's back: written, not run. |
| 08a First run | 3.2 | UX.H1 · none (three buttons, no "+ New", no search, no large title); P0.3 UXH1.none; device: `storage-picker-permission` part 3a (add form's words) | home | `storage-picker-permission` (via `_h2-add-server`/`_add-server`) | B+D |
| 08b Empty Home on a connected server, and connecting | 3.2 | UX.H1 · empty-server (two buttons, agents line, no search), connecting (five placeholder rows, "+ New" dimmed); P0.3 UXH1.empty-server, connecting | home | none needed | B. "Connecting" is not drawn on the board (a note says so); the goal states it. |

## 3.3 Rows, renaming, creating, archive, search

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 04a Row actions: swipe | 3.3 | UX.H2 · swipe (Archive and Delete 88 pt and as high as the row; a full swipe archives with the "Archived …" toast and Undo, the row back at the same index); UX.F1 · swipe (the primitive, 20 pt edge rule, mouse drag does nothing) | home | `ux-rows` 1, 2 (partial swipe on the group row, full swipe on a chat); `sheets` 7c | B+D. `ux-rows` passed on iOS (H2 run 6). Open for a person (status-h2): under Maestro's one-move finger a partial swipe on a chat or board row read as a tap, so the flow swipes the group row and the full chat row; a real finger is untested. |
| 04b Row actions: long press sheet and drag | 3.3 | UX.H2 · sheet (head "Chat · Checkout service · Studio Mac", Open, Rename…, Move to… with the group, Archive, Delete chat… last, red; Move to… moves the chat); a board's and a group's sheet name their kind | home | `ux-rows` 3 (hold opens the sheet), 4 (hold then move drops a chat into a group), 5 (scroll still scrolls) | B+D. The haptic cannot be asserted on a simulator (no engine): `sheets` 7c only shows expo-haptics is linked. Android not run. |
| 04c Row actions: delete asks, archive does not | 3.3, 3.1.3 | UX.H2 · swipe (Delete asks with the name in quotes, "Delete chat", Cancel keeps it, the go button removes it); UX.T3 · archive, delete | home | none needed | B. The R1 `home` group adds the behaviour steps (archive does not ask, Undo restores in place). |
| 05 Renaming (P3 from a row, Chat info, a board) | 3.3 | UX.H2 · rename (Save off while empty or unchanged, whole name selected, Return saves; from a row's sheet, a group's "…", a board by the seam `window.__aiwbHome.rename`); UX.T3 · info (Rename opens the name field); SEC.10 phone half | home, chat | `sheets` 7b (form on the keyboard) | B+D. |
| 11a New sheet v2: where first, then what | 3.3 | UX.H2 · new (the card with the place, Chat and Whiteboard tiles, Group row; made in the chosen group; "+ New" in a group starts at that group); UX.H1 · empty-group | home | none needed | B |
| 11b The Where page ("‹ New", crumb, "Put it in", Done) | 3.3 | UX.H2 · new (Change opens the Where page, the crumb goes up, a child level, Done) | home | none needed | B |
| 07 Settings › Archived | 3.3, 3.8.1 | UX.H2 · archived (by server then by group, footer, right swipe unarchives with a toast and the row is back on Home, left swipe's Delete asks); UX.S1 · Settings (the Archived row and count); P0.3 UXH2.archived | home | `ux-rows` (swipe shape) | B. Archive date: the server gives none, so the row shows the chat's last activity (goal 4.6, by design). |
| 09a Search: before typing | 3.3 | UX.H2 · search (recent searches with Clear and ×, recently opened with place); P0.3 UXH2.search | home | none needed | B |
| 09b Search: results, scopes, no results, an offline server | 3.3 | UX.H2 · search (BOARDS · CHATS · GROUPS with counts, bold match, a board's chat "on <board>", scope chips, a result opens with its board under it or a group's screen, no results names the server and offers New chat with the words in its draft, faded results of a server that is away; P0.3 UXH2.away) | home | none needed | B |

## 3.4 A board, and the chats on it

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 01a Top bar: reader as the board opens | 3.4 | UX.B1 · the bar (back without label, name, place, state word, Chats button with count and busy), the row, no floating parts; L5, HB.1 phone halves; P0.3 A2.board-selected | board | `ux-board` a (the bar, row, shapes in the canvas) | B+D. Light and dark. |
| 01b Top bar: the Chats sheet | 3.4 | UX.B1 · the sheet (title `Chats on “<board>”`, `chats-new` first, rows ≥ 50 px, a row opens that chat full screen, back lands on the board) | board | `ux-board` (chats step) | B+D. The "Voice" mark on the chat voice talks to: R1 `voice.card` asserts it in the voice card's "To:" sheet. |
| 02 The board opens fitted | 3.4 | UX.B1 · open view (fitted inside the visible rect, margins about 16 px, zoom ≤ 1; left and opened again it is where it was left); UX.B2 · 0 (a chat opened directly leaves the board mounted and fitted by "+" › Point at) | board | `ux-board` a (screenshot) | B+D |
| 03a View only / Taking over… (reader) | 3.4 | UX.B1 · the bar and the row (reader: "View only", `board-take` "Edit here" 44 pt; a take on its way "Taking over…"); HB.1; L5 | board | `ux-board` | B+D. The toast "Another window took over" is asserted only when it is drawn (UX.B1 notes it as B1-3's). |
| 03b Editing (the holder) | 3.4 | UX.B1 · the bar and the row (holder: "Editing", no Edit here, the orb slot); "Another window is editing" | board | `ux-board` inset step (holder's footer: undo, redo not under the orb's slot) | B+D |
| 04a One bottom row: docked orb | 3.4, 4.4 | UX.B1 · inset (one 64 px row flush with the bottom, the bar's ground, a line above, no Excalidraw footer control under `board-row`, in the reader's, the holder's and the selected footer); `board-orb-slot` empty | board (the canvas rule) | `ux-board` inset (menu tappable, footer clear of the slot; passed on iOS ×2, B1 chunk 9) | B+D. The orb itself: UX.V1 · 5 board, VC.6 phone half, R1 `voice.card` (orb at rest with the canvas rule). Whether the inset survives an Excalidraw update is judged by people (goal 6.5). |
| 04b Fallback: floating orb | 3.4 | none | none | `ux-board` inset would show a break | N. Drawn as the fallback to ship only if the inset breaks; B1 found the inset holds (status-b1, chunk 6), so it is not built. |
| 05a Voice card: listening | 3.4, 3.7.2 | UX.V1 · 5 board (at rest only `voice-orb` in `board-orb-slot`; the orb opens `voice-card`, "To:" opens the Chats sheet); VC.6 phone half | board (menu rows not covered by the orb or card), voice (`voice.card`: orb at rest with the canvas rule, the card, its "To:" sheet with the "Voice" mark, a row opens the chat) | none | B |
| 05b Voice card: reply spoken (Interrupt, Open chat, "Claude · moved") | 3.4, 3.7.2 | UX.V1 · 5 board (speaking has Interrupt and Open chat, which pushes the chat); the bar's "<Agent> is working…" and the Chats count: UX.B1 · the bar | board, voice (`voice.card`: Interrupt, the orb ends the session) | none | B |
| 06a Between a board and its chats: the chat full screen | 3.4 | UX.B1 · the sheet (a row opens the chat, stack …, board, chat, back lands on the board); UX.F2 · from a chat; UX.B2 · 6, UX.C1 · 6 (the board chip first in the context row) | board, chat | `ux-board` (chats step: row opens the chat, back returns); `ux-stack` | B+D. "Returns at the view left": UX.B1 · open view covers the stored view; the R1 `board` group adds the return from a chat. |
| 07a Point at: 1 Ask (labelled chips, D14) | 3.4, 3.6 | UX.C1 · 4 (the "+" sheet's Point at and Add selection rows under "Board · <name>"; the chips of the mockup were replaced by the "+" sheet, goal 3.6) | composer, board | none needed | B |
| 07b Point at: 2 Tap (accent banner, Cancel, pin) | 3.4 | UX.B2 · 1 (`pick-bar` kind point, `pick-cancel` 44 px, "Picking a point", Chats dimmed, border; Cancel, system back and goBack each return the chat), 2 (pin and label, the chat back within 5 s), 7 (dark: bar ground is the accent, title 4.5:1) | board | none (the native tap is unchanged, status-b2) | B |
| 07c Point at: 3 Back in the chat as a chip | 3.4 | UX.B2 · 2 (the chip "Point near Payments" with its × of 44 px; Send puts `<point x y>` into the message, the draft kept), 3 (× takes it out) | composer, board | `composer-chips` (the chip's caret behaviour) | B+D |
| 08 Excalidraw's menu on the phone | 3.4 | UX.B1 · the menu (a group titled with the board's name, exactly Find, Fit, Export image…, Share image…; the holder's "Clear the board…" last), clear (the confirm names the board, one undo brings it back), share (`<name>.png`); A6.3-board (contrast in the flavours) | board | `ux-board` inset (the menu opens and is tappable) | B+D. UX.B1 still hides the old voice pill (gone with V1: a no-op now); R1's `board` group reads the menu rows with the docked orb present and fails if the orb or the card covers one (none does). |
| 09a Dark theme: an agent at work | 3.4 | UX.B1 · dark (bar and sheet take the theme's ground), the bar (state "<Agent> is working…", Chats takes the agent's colour); P7.5 (the canvas follows the theme) | board | none needed | B |
| 09b Landscape, reading view | 3.4 | none in a browser | board (canvas rule only at the phone's portrait) | `ux-board` landscape (iOS: the simulator is rotated; the floating controls replace the bar and row); B1 chunk 5's unit test of the chrome | D. Passed on iOS (B1 chunk 9, ×2); Android not run. |
| 10 New chat on a board, full screen (bd2-e) | 3.4 | UX.B1 · the sheet (`chats-new` opens a new chat on the board); UX.C1 · 9 (the chip row in a new chat on a board) | board, composer | none needed | B. That the title becomes the chat's topic after the first message is asserted by no check (gap). |
| 11a Add selection: 1 in the chat | 3.4 | UX.B2 · 4 (the "+" sheet's "Add selection", "Select shapes on the board") | composer, board | `composer-chips` (Add selection chip) | B+D |
| 11b Add selection: 2 on the board (accent bar "Select items · Add (n)") | 3.4 | UX.B2 · 4 (`pick-bar` kind select, "Select items", `pick-add` "Add (0)" disabled, "Add (2)" after Excalidraw's own selection, `pick-take` for a reader), 5 (Back cancels, draft as it was) | board | none | B |
| 11c Add selection: 3 back as a chip | 3.4 | UX.B2 · 4 (chip "2 shapes · Payments, Inventory"; Send puts `<selection ids>` with exactly those ids) | composer | `composer-chips` | B+D |
| 12 A Selecting on the board, speech mode off | 3.4, 6.2 | UX.B2 · 6 (two shapes selected, the chat opened from the Chats sheet has no chip, no `ctx-act`; Add selection row says "2 shapes selected on the board", Back puts nothing in); L24 phone half | board | none | B |
| 12 B Selecting on the board, speech mode on | 3.4, 3.7.2 | UX.V1 · 5 board ("With 1 selected shape", the orb's badge, × takes it out, Send carries the tag to the voice chat, a typed message never does); UX.B2 · 6 the other half | voice (`voice.speech-selection`: nothing sent or attached outside speech mode; in it one spoken message with the tag, to the card's chat only) | none | B |
| 12a (sh2) A new chat on a board: the bar's Chats 2 | 3.4 | UX.B1 · the bar (Chats button, `count`, `busy`; the dot says one needs you: H1's `kinds` on Home) | board | none needed | B |
| 12b (sh2) A new chat on a board: Chats sheet, + New chat on top | 3.4 | UX.B1 · the sheet (`chats-new` first, one row per chat; the chat's back lands on the board; Done and the swipe down are asserted by no check) | board | `ux-board` | B+D |
| 12c (sh2) A new chat on a board: the empty chat "on Checkout flow" | 3.4 | UX.B1 · the sheet (opens, back lands on the board); UX.C1 · 9, UX.C2 · 6 (empty thread) | board, composer | `ux-board` | B+D. Title-becomes-topic: see mockup 10. |

## 3.5 A chat

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 01a Header and thread | 3.5 | UX.T1 · header (title in ≤ 2 lines, sub-line, Tree with count badge, ⋯), type (16 px over 24 px, h2 20, h3 17, list indent 24, code chip, 16 pt margins, no floating ⋯), latest (the Latest pill); P0.3 UXT1.thread, plain | chat | `ux-composer` (the thread keeps its last message above the box) | B+D. UX.T3 and UX.T2 add the dark theme. |
| 01b Header and thread: before | 3.5 | n/a | n/a | n/a | BEFORE |
| 02a Chat info | 3.5 | UX.T3 · info (rows in order name, agent, folder, server, context, tree, archive, delete; locked note "Fixed after the first message. Fork the chat…"; the whole folder path and Copy toasts; Server row's state word is the server's and opens its detail); P0.3 UXT3.chat | chat | none needed | B. Light and dark. |
| 02b Rename chat | 3.5, 3.3 | UX.T3 · info (Rename opens the name field); UX.H2 · rename; SEC.10 | chat, home | `sheets` 7b | B+D |
| 02c Context and usage | 3.5 | UX.T3 · usage (title, sub, 36 %, legend rows ≥ 38 pt, Messages expands, amber from 80 %); L12-usage phone sheet | chat | none needed | B |
| 03a Markdown: type, tables, code, links | 3.5 | UX.T1 · type, table (bleeds, pinned column, hint, Open full table), code (head: language, Wrap, Copy), link (underlined; hold opens `link-sheet`); L9, A6.3-markdown (contrast) | chat | none needed | B |
| 03b The full table viewer | 3.5 | UX.T1 · table (`table-screen` titled "Table · 6 columns, 4 rows", Copy puts the table as Markdown, back returns) | chat | `ux-table` (landscape turn, pinned header and first column, Copy toast, back) | B+D. `ux-table` passed by hand with `--hold` on iOS 26.3; its two full `run.mjs` runs failed (first tap on Open full table lost; the flow now re-presses) — status-t1. |
| 04a Tool steps: groups, diffs, failures | 3.5 | UX.T2 · steps (failed step open by itself, "exit code 1", command with `$` and Copy, last 6 of 14 lines and Show all; reads folded as one `step-group`; edit "+5 −2", at most 10 `diff-row`s, Show full diff, Copy); P0.3 UXT2.steps | chat | none needed | B. Dark: UX.T2 · dark. |
| 04b The full diff screen | 3.5 | UX.T2 · full diff (`diff-screen`, "+5 −2 · 2 changes", "1 of 2" then "2 of 2", the fold "41 unchanged lines" opens, Wrap, Copy) | chat | none needed | B |
| 05a Permission request card | 3.5 | UX.T2 · permission (sub-line "Needs your approval" in amber, "Claude wants to run a command", the whole command, `perm-deny` and `perm-allow` ≥ 48 px, Allow in the accent); P0.3 UXT2.perm; A6.4 phone Allow line | chat | none needed | B |
| 05b Permission dock | 3.5 | UX.T2 · permission (no dock at the end of the thread; at its top "1 of 2", Show scrolls and the dock leaves; the dock's Allow makes one POST naming `w1`; answering one answers both) | chat | none needed | B |
| 05c Answered card and busy line | 3.5 | UX.T2 · permission (folded "Allowed ·" with the time, a tap opens it), busy (spinner, `busy-seconds`); P0.3 UXT2.busy | chat | none needed | B. Seen, not T2's (status-t2): a chat at work on a tool says "Writing…" in its header where ch-05c draws "agent · folder"; R1 chunk 3 has this item. |
| 05p Permission request: before | 3.5 | n/a | n/a | n/a | BEFORE |
| 06a Message actions: press and hold, one sheet | 3.5 | UX.T1 · message (`msg-sheet` with the lifted `msg-lift`, quick row Copy, Quote, Select); IM3.5-message, VC.5-readaloud phone half (Read aloud in the message sheet); P0.3 | chat | `voice-mic` (Read aloud from the message sheet; `ux-v1`) | B. The dimmed thread, "Branch and edit" first, an action that waits staying faded: only through the rules' sheet checks. |
| 06b Quote from Claude's reply | 3.5 | UX.T1 · message (Select text opens the Quote sheet in mode `select`; Quote → comment sheet "Add to message" → the quote reaches the composer's draft with its comment); SEC.10, A4.3 phone halves | chat | none needed | B. Known (status-t1): the Quote sheet's text is `displayed.ts`'s, which joins paragraphs with no gap; left for later. |
| 07a Branches: "‹ Branch 1 of 2 ›" | 3.5 | UX.T3 · pill (› switches the branch in place, ‹ brings it back, the middle opens the tree); UX.T1 · header (badge count 3, amber when another branch waits); L22-branches; P0.3 UXT1.thread, UXT3.chat, A4.two-branches | chat | none needed | B |
| 07b The chat tree sheet | 3.5 | UX.T3 · tree (Done 44 pt, switch 32 pt, search 44 pt, rows 48 pt, one "You are here", "Labeled · 1"; a hold opens the row's P1; Label… form; Save sends the label); L15-fork; P0.3 A6.tree-popup | chat | none needed | B |
| 08a Subagents: rows | 3.5 | UX.T2 · subagents (one `sub-card` `count` 4 `running` 2, four `sub-row`s ≥ 60 px, nested one indented, report row ≥ 48 px); S1.1-subagents, L19 phone halves; P0.3 UXT2.subs | chat | none needed | B |
| 08b The subagent screen | 3.5 | UX.T2 · subagents (`sub-screen`: "Subagent 1 of 4 · Done", pills, `sub-steps` folded, Copy toasts, `sub-screen-next` names the next, no `sub-close`, back returns) | chat | none needed | B |
| 09a Empty chat | 3.5 | UX.C2 · 6 Empty chat (56 px tile, 22 px title, 16 px line, `config-hint`, "TRY ASKING" starters ≥ 48 px at the foot, a tap sends); P0.3 UXC2.new | chat, composer | none needed | B. The hint says "below" where the mockup says "above the box" (status-c1 note). |
| 09b Images: thumbnails and the viewer | 3.5 | UX.T3 · images (116 × 140 thumbnails, black viewer with name, "Image 1 of 2 · your message", dots, Share, Save, Ask about it 44 pt; a swipe changes the image; Ask puts the image in the composer); IM3.5-message, IM3.2-images | chat | none needed (the system share sheet is not exercised) | B. Android has no Share or Save of a file (RN Share takes none there; status-t3). |
| 10a Another server: offline | 3.5, 3.7.1 | UX.T3 · offline (no `remote-bar`, thread not dimmed, Chat info's Rename, Archive, Delete disabled with the reason, the Server row says "unreachable", the toast "… is back online"); UX.X2; AAC.2-localdown, AAC.3, SEC.7-drop, SEC.10 phone halves; P0.3 UXT3.remote, remote-off | chat | none needed | B for the thread, header and Chat info. The composer's offline notice ("is offline since … Your draft is kept", **Servers**): UX.V1 · 1, R1 `composer.v1-offline`, and the X2 halves' `composer-block` lines (R1 chunk 13). |
| 10b Another server: archived | 3.5, 3.7.1 | UX.T3 · archived ("Archived · …" sub-line, Chat info offers Unarchive, Rename faded with its reason); L23-gone; P0.3 UXT3.archived | chat | none needed | B for the header and Chat info. The archived bar in the box's place with **Unarchive**: UX.V1 · 1, R1 `composer.v1-archived`. |
| 10x Another server: before | 3.5 | n/a | n/a | n/a | BEFORE |

## 3.6 The composer: its box, its chips and its sheets

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 01a The box and its toolbar | 3.6 | UX.C1 · 1 the box (17 px, one line empty, 8 lines show 6 and scroll, images' strip above), 2 the toolbar (+, ring 44 px, Dictate, one primary), 3 the keys (Return adds a line, Ctrl+Enter sends, the button sends), 8 the ring (amber from 80 %); P0.3 UXC1.new, started | composer | `ux-composer` (Return adds a line and sends nothing; Send sends; the message on the server) | B+D |
| 01s The primary button in each state | 3.6 | UX.C1 · 2 (Talk while empty, Send once typed, Stop while busy with Send beside it); P0.3 UXC1.busy | composer | `ux-composer` (Talk / Send visible with the keyboard up) | B+D |
| 02a The chat's setup: the chip row | 3.6 | UX.C2 · 1 the row (agent, folder, model · effort, subagents, 36 px chips, 15 px names); UX.C1 · 9 (a new chat has `composer-chip-row`, a started one has none); P0.3 UXC2.new | composer | `composer-chips` (row in sight; model and folder sheets pass on the iPhone 17 simulator, status-c2); `ux-composer` (the row hides while the keyboard is up and returns) | B+D. The web build's `useKeyboardUp` is always false: the hiding is asserted on the device only. |
| 02c The chat's setup: Chat info holds the locked rows | 3.6, 3.5 | UX.T3 · info (locked rows with "Fixed after the first message") | chat | none needed | B |
| 02s The chip row's other states (started, fork, missing agent) | 3.6 | UX.C2 · 1 (`started` no row, `fork` the model chip with "Only the model can change", `missing` red chip and `agent-reason`); P0.3 UXC2.started, fork, missing | composer | none needed | B |
| 03a Picker: Model and effort | 3.6 | UX.C2 · 3 Model (sub, Done, rows ≥ 50 px with context notes, `effort-seg`, a tap keeps the sheet open) | composer | `composer-chips` (model sheet) | B+D |
| 03b Picker: Agent | 3.6 | UX.C2 · 2 Agent (title, sub, ✓, the footer line, no Done, no Cancel, a tap picks and closes); dark pass of the Agent sheet | composer | none needed | B. Light and dark. A missing agent dimmed with its reason: UX.C2 · 1 `missing`. |
| 03c Picker: Subagents | 3.6 | UX.C2 · 5 (segmented depth and cap, ≥ 44 px, depth Off greys the cap with its line) | composer | none needed | B |
| 03d Picker: Folder | 3.6 | UX.C2 · 4 (Cancel left, "Start the agent in", Up and path ≥ 44 px, rows ≥ 52 px, sticky "Use <name>", tap the path types one) | composer | `composer-chips` (folder sheet) | B+D |
| 03e Picker: Model and effort for Pi (headings) | 3.6 | UX.C2 · 3 (in `pi`: provider headings, a search that filters); P0.3 UXC2.pi | composer | none needed | B |
| 03f Picker: empty folder | 3.6 | UX.C2 · 4 (`dir-empty` "No subfolders" and "Use this folder, or go up.") | composer | none needed | B |
| 04a The "+" sheet | 3.6 | UX.C1 · 4 (titled, rows with a sub-line ≥ 50 px; Files, Insert a prompt; Add selection and Point at under "Board · <name>" in a board chat only) | composer | `storage-picker-permission` part 2 (Photo library through the system picker; Take photo asks for the camera with the app's words) | B+D. The web build has no camera and no library row (PlusSheet says so): Take photo and Photo library are device-only. |
| 04b Images in the box | 3.6 | UX.C1 · 5 (a ring on a 72 px thumb, Send soft with "An image is being uploaded", every × ≥ 44 px, a refused file marked with its reason, 11 images give the limit line and dim the library row); IM3.2-images, L18-imagelimits phone halves | composer | `storage-picker-permission` part 2 (thumbnails, PNG and JPEGs on the server, a BMP and a 5 MB file refused) | B+D |
| 04c Prompt: insert a prompt | 3.6 | UX.S4.3 (head Cancel · "Insert a prompt" · Library, 44 pt search at 17 px, section heads, two-line rows, Recent first, no results, empty library); PL5.1, PL5.2 phone halves | composer, settings | `sheets` 6 (the insert popup's keyboard avoidance) | B+D. Light and dark. |
| 05a A board chat's context: the row | 3.6 | UX.C1 · 6 the context row (board chip first, mention, "2 quotes", no "Add 3 selected" while shapes are selected); UX.B2 · 4 (selection chip); P0.3 UXC1.board-new, board-started | composer | `composer-chips` | B+D |
| 05b Quoted in this message | 3.6 | UX.C1 · 6 ("2 quotes" opens the sheet: a card per quote, the comment field or "+ Add a comment", a 44 px trash; the last quote removed closes it); P0.3 A2.plain-quotes | composer | none needed | B |
| 05c @ suggestions dock | 3.6 | UX.C1 · 7 (`mention-dock` ≤ 4 rows of 52 px, full width, above the box; a tap picks); L23-gone (the list is gone when the server drops) | composer | none needed | B |
| 05s The context row in each state | 3.6 | UX.C1 · 6 and 8; UX.B2 · 2, 4, 6; P0.3 UXC1.board-draft | composer | none needed | B |
| 07c Notices, and the keyboard | 3.6 | UX.C1 · 1 (the box grows to 6 lines and scrolls inside), 3 (Return adds a line); UX.F1 · forms (a P3 rides the keyboard) | composer | `ux-composer` (keyboard up, the box above its top, Send on screen, Return, the thread above the box, drag down); `sheets` 7b | B+D. Keyboard geometry, the 6 pt gap and "no home gap" are seen only by the device flow's screenshots. The thread's drag-to-lower is X1's fix; the device check is left (status-x1; an optional step in `ux-composer`). |
| 07a Notice: offline said once | 3.6, 3.7.1 | UX.V1 · 1 blocked (offline, gone); AAC.2-localdown, SEC.7-drop, SEC.10 phone halves (`composer-block`) | composer (`composer.v1-offline`: said once, read-only and greyed, the draft visible, Servers opens the detail and back is still blocked once; `composer.v1-gone`) | none | B |
| 07b Notice: archived, one bar with Unarchive | 3.6, 3.7.1 | UX.V1 · 1 blocked (archived, archived + offline) | composer (`composer.v1-archived`: one bar, Unarchive 44 pt gives the box back; `composer.v1-archived-offline`: both said once, no button) | none | B |
| 06a Voice in the composer: Set up voice | 3.6, 3.7.2 | UX.V1 · 4 set up; VC.2 phone half | voice (`voice.setup`: from Dictate and from Talk; head, no Cancel row, Open Settings › Voice lands there, back to the chat) | `voice-mic` (Microphone sheet; passed on iOS, V1 chunk 7) | B+D. R1 fix: the sheet had no `sheet-head` (df7a01e). |
| 06c Voice in the composer: Dictate | 3.6, 3.7.2 | UX.V1 · 2 dictate; VC.3 phone half | voice (`voice.dictate`: the line inside the box, the mic's accent, Send stays the primary, no Auto-send) | `voice-mic` (Dictate line passed on iOS, V1 chunk 7) | B+D |
| 06d Voice in the composer: speech bar | 3.6, 3.7.2 | UX.V1 · 3 speech; VC.4 phone half | voice (`voice.speech-bar`: Listening, Muted, End leaves the words as a draft) | none (`voice-mic` has no speech-mode step) | B |
| 06s Speech bar, state by state | 3.6, 3.7.2 | UX.V1 · 3 speech (Listening, Muted, Sending in N s with Cancel, Thinking…, Speaking with Interrupt; no voice control labelled Stop) | voice (`voice.speech-bar`, `voice.speech-bar-send`: each state audited, no Auto-send text or switch, the turn sent once with the words alone) | none | B |

## 3.7 The composer: what blocks it, and voice

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 07a, 07b Notices (offline, archived) | 3.7.1 | see 3.6 (rows 07a and 07b) | composer | none | B. Counted in 3.6. |
| (no mockup) No agent installed | 3.7.1 | UX.V1 · 1 blocked (no agent); UX.C2 · 1 `missing` (the chip side) | composer (`composer.v1-no-agent`: a started chat and a new one, said once, no button, no chip hint in the empty thread) | none | B. R1 fix: the empty thread hinted at chips that are not drawn (27aeb3e). The goal's prose, not a mockup. |
| (no mockup) An old board connection | 3.7.1 | UX.V1 · 1 blocked (legacy with and without a board) | composer (`composer.v1-old-board-connection`: the bar, "New chat on this board" opens an empty chat on the board) | none | B. Prose only. |
| (no mockup) A model too small for the chat | 3.7.1 | UX.V1 · 1 blocked (a model too small) | composer (`composer.v1-model-too-small`: amber, no ×, said once, Send greyed with the reason, Pick a model opens the sheet) | none | B. Prose only. |
| (no mockup) A refused send (the folder is gone) | 3.7.1 | UX.V1 · 1 blocked (a refused send); L23-gone (wide halves) | composer (`composer.v1-refused-send`: red above the box, the reason once, the text kept, × keeps it) | none | B. Prose only. |
| 06 Voice in the composer (a, c, d, s) | 3.7.2 | see 3.6 | voice | `voice-mic` | B (a, c also D). Counted in 3.6. |
| 05 Talking to the board: the voice card | 3.7.2 | see 3.4 (05a, 05b) | board, voice | none | B. Counted in 3.4. |
| 07b Settings › Voice | 3.7.2, 3.8.5 | see 3.8 (07b Voice, no key, Add key, Choose voice) | settings | `voice-devices`, `voice-mic` | Counted in 3.8. |
| Auto-send is one setting (3.7.3) | 3.7.3, 6.2 | UX.S3 · settings (Auto-send flips `autoSend` and back); VC.4 phone half drops `speech-autosend` (V1's 6a on `ux-v1`) | settings (Auto-send only there) | none needed | B for the setting; "in no other place" is the R1 `settings` group's rule. |

## 3.8 Settings, servers, certificates, the prompt library

| Mockup (board title) | Goal | Check · scenario/state | Rules (UX.R1 group) | Device flow | Note |
|---|---|---|---|---|---|
| 01a Menus: P1 action sheet (a chat's “…”) | 3.8, 3.1.4 | UX.H2 · sheet; UX.F1 · sheets | home | `sheets` 7a | B+D |
| 01b Menus: P2 picker sheet (Speech model) | 3.8, 3.8.5 | UX.S3 · settings (Language is a P2 with its search pinned; Playback speed), devices (Microphone sheet lists only when opened); UX.F1 · picker | settings | `voice-devices` (Microphone and Speaker sheets) | B+D |
| 02a Confirm: P4 delete a chat | 3.8, 3.1.4 | UX.H2 · swipe (Delete asks); UX.T3 · delete; UX.F1 · forms | home, chat | none needed | B |
| 03a Servers: list | 3.8.2 | UX.S2 · list (A–Z, each row's state word and second line, 64 pt rows, "+ Add server" last and the bar's "+", a press pushes the detail); P0.3 UXS2.list | settings | none needed | B. Light only (the sizes in the walker's recipes). |
| 03b Servers: server detail | 3.8.2 | UX.S2 · detail (Build box: address with Copy, version, agent chips, the certificate row, Test connection in place); P0.3 UXS2.detail | settings | none needed | B |
| 03c Servers: Remove server… (P4) | 3.8.2 | UX.S2 · remove (names the server, says nothing is deleted there, Cancel keeps it, the confirm pops to the list) | settings | none needed | B |
| 03d Servers: detail, Unreachable (and Too old, Slow link) | 3.8.2 | UX.S2 · detail (Attic: why, numbered tries, Test again; Old Mini: both versions and how to update; Slow link connecting); P0.3 UXS2.unreachable, too-old | settings | none needed | B. **Local network off** (iOS only) has no browser state: logic in the unit tests `statewords.test.ts`, `serverfacts.test.ts`, `localnetworkfeed.test.ts`; the device flow shows the words and **Open Settings**. |
| 04a Add: 1 Choose how (P1) | 3.8.3 | UX.S2 · add-match (paste "In clipboard", manual, help; scan only where a camera exists); L3-addserver phone half | settings | `storage-picker-permission` 3a (iOS: why the system will ask) | B+D |
| 04b Add: 2 Scan the code | 3.8.3 | none in a browser (the build draws no scan button, L3 checks that) | settings | `_v4-scan` (part 4 of `storage-picker-permission`: the scanner's screen and the camera permission both ways; the code's text typed into "Paste text instead" fills "New server" and matches; × closes the camera) | D. The scan itself is by hand (goal 7.5; neither the simulator nor the emulator can show a camera a picture). iOS passed with S2 (iPhone 17); Android not run. |
| 04c Add: 3 Check and test (P3) | 3.8.3 | UX.S2 · add-match (the clipboard's setup text fills the form, the secret is dots and nowhere in the page, the test), add-manual (Test connection off until valid) | settings | `_v4-localnet`, `_v4-localnet-why` (Local Network announced before the system asks; the refusal's words and "Open Settings") | B+D. iOS passed with S2; the simulator never asks for the permission itself. |
| 04d Add: 4 Trust and save (matching fingerprint) | 3.8.3 | UX.S2 · add-match (green 16 blocks, Trust and save) | settings | none needed | B |
| 04e Add: 4B Fingerprint does NOT match | 3.8.3 | UX.S2 · add-mismatch (every block red, "In the code: …", no way to trust, Save off, only Cancel, `servers.add` never called) | settings | none needed | B |
| 05a Cert: 1 The list marks it | 3.8.4 | UX.S2 · list (Cert box keeps its place, "Certificate changed · paused"); UX.H1 · cert (Home's card); P0.3 UXS2.cert | settings, home | none needed | B |
| 05b Cert: 2 The detail explains | 3.8.4 | UX.S2 · detail (the danger notice, Compare fingerprints, no "Last connected") | settings | none needed | B |
| 05c Cert: 3 Compare | 3.8.4 | UX.S2 · cert-paste (the command and Copy, 16 red blocks and the old one muted; a code with another fingerprint is refused and sends no `servers.accept`, the matching one trusts with no P4); P0.3 UXS2.compare | settings | none needed | B |
| 05d Cert: 4 Trust, once more (P4) | 3.8.4 | UX.S2 · cert-trust ("Trust and reconnect" sends `servers.accept`, Cancel sends nothing, Not now pops) | settings | none needed | B |
| 06a Library screen (P5) | 3.8.6 | UX.S4.1 · the bar, "+", the search, the sections, the rows, offline, the footer; no `DRAWN` row (the library's sheets are opened through the uicheck seam `window.__aiwbLibrary`) | settings | none needed | B. Light and dark. |
| 06b Prompt editor, keyboard up (P3) | 3.8.6 | UX.S4.2 · editor (Cancel · Prompt · Save, Return adds a line, "Edited · not saved" bar with Done, Group row opens the move picker), delete, problems, offline | settings | `sheets` 7b (a form's Save above the keyboard) | B+D |
| 06b-c Group screen and swipe | 3.8.6 | UX.S4.1 · a group, swipe (Move grey and Delete red ≥ 44 pt, a long press opens the row's P1) | settings | `sheets` 7c (swipe shape) | B+D |
| 06b-d A group's "…" sheet (P1) | 3.8.6 | UX.S4.1 · a group (head "Group in git · 2 prompts", Delete last, no Cancel; Delete asks "Delete group and 2 prompts") | settings | none needed | B |
| 06b-e Move picker (P2) | 3.8.6 | UX.S4.2 · Group row, move (top level first, groups by depth, "Now here", other servers dimmed with the reason; a group's picker does not offer itself) | settings | none needed | B |
| 06b-f Leave guard (P4) | 3.8.6 | UX.S4.2 · guard (Discard changes red, Save and close, Keep editing as a link; a press on the dimmed page asks too) | settings | none needed | B |
| 07a Settings (P5) | 3.8.1 | UX.S1 · Settings (six rows in order, ≥ 44 pt, label 17 px, chevron, no switch or field; Servers line amber when something needs attention; each row pushes and its back lands on Settings; back after Settings lands on Home); P0.3 | settings | `ux-stack` (a pushed screen over Home) | B+D. Light and dark. |
| 07b Voice (dark theme) | 3.8.5 | UX.S3 · with a key (rows in order, Remove key last and red), sizes in the dark; P0.3 | settings | `voice-devices` (Part 1 passed on iOS) | B+D |
| 07b-c Voice, no key yet | 3.8.5 | UX.S3 · no key (`vs-nokey-card`, the one button, the elevenlabs.io link, the privacy line, the dimmed voice row; no `/voice` request and no `getUserMedia` or `enumerateDevices` from opening it) | settings | `voice-devices` (no key: the card and no microphone alert) | B+D |
| 07b-d Add key (P3, large detent) | 3.8.5 | UX.S3 · Add key (Cancel · ElevenLabs key · Save, hidden mono field with the eye, Paste, Test key good and bad, Discard changes, the canary key in no storage or text) | settings | `voice-mic` (Add key, Test key, Save passed on iOS before V1's Read aloud step) | B+D |
| 07b-e Choose voice (P5) | 3.8.5 | UX.S3 · Choose voice (search visible, chosen voice first and checked, a tap chooses and stays, play shows "Playing sample…", "N of M voices" and Show all voices) | settings | none needed | B |
| 07b-f Catppuccin flavours (P2) and Appearance | 3.8.1 | UX.S1 · Appearance (Theme as a checked list, the flavour row opens a sheet of four 50 pt rows with swatch and Light/Dark; Mocha applies at once; a reload keeps it); A6.4-floors (contrast in each flavour) | settings | none needed | B |
| 13a Server sheet (long press on a chip) | 3.2, 3.8.2 | UX.S2 · sheet (`window.__aiwbServers.openServerSheet`: facts, rows, a test in place, closing); UX.H1 · four (a held chip opens its sheet) | home, settings | none needed | B |
| 13b Settings v2 (Appearance as a row) | 3.8.1 | UX.S1 · Settings; P0.3 | settings | none needed | B |
| 13c Appearance page | 3.8.1 | UX.S1 · Appearance | settings | none needed | B |

## Goal 6.1 list

Every item of the enumeration in goal 6.1, with the check that shows it. "light and dark" means the check runs both themes at the phone.

| 6.1 item | Check · scenario | Rules group | Note |
|---|---|---|---|
| Home, one server | UX.H1 · one; P0.3 UXH1.one | home | light and dark |
| Home, several servers | UX.H1 · four; P0.3 UXH1.four | home | light and dark |
| Home, a problem on the selected server | UX.H1 · trouble, cert; P0.3 UXH1.trouble, cert; UX.X2 | home | light and dark |
| Home, a dot and a count | UX.H1 · four, kinds; P0.3 UXH1.kinds | home | |
| Home, first run | UX.H1 · none; P0.3 UXH1.none | home | |
| Home, empty | UX.H1 · empty-server, empty-group; P0.3 UXH1.empty-server, empty-group | home | |
| A group and a nested group | UX.H1 · nested; UX.F2 · from a row, from a result; P0.3 UXH1.nested; UX.H2 · rows of a group's screen | home | |
| "+ New" and its Where page | UX.H2 · new | home | |
| A row's sheet | UX.H2 · sheet | home | |
| Swipe and Undo toast | UX.H2 · swipe; UX.F1 · swipe, toast | home | |
| Rename | UX.H2 · rename; UX.T3 · info | home, chat | |
| Search in each of its states | UX.H2 · search (before typing, typing, scopes, a result opens, no results, a kept search, a server away); P0.3 UXH2.search, away | home | |
| Archived | UX.H2 · archived; UX.S1 · Settings; P0.3 UXH2.archived | home | |
| A board's bar in each of its states | UX.B1 · the bar (reader, holder, taking over, another window, archived, busy), the row; L5, HB.1 | board | light and dark |
| The Chats sheet | UX.B1 · the sheet | board | the "Voice" mark is asserted by no check (see 3.4 01b) |
| A board chat | UX.B1 · the sheet; UX.B2 · 0, 6; UX.C1 · 6; UX.F2 · from a chat | board, chat | |
| Point at | UX.B2 · 1, 2, 3, 7 | board | |
| Add selection | UX.B2 · 4, 5 | board | |
| The chat's header | UX.T1 · header; UX.T3 · archived, offline | chat | the "Writing…" wording is R1 chunk 3's item |
| Thread | UX.T1 · type, table, code, link, latest | chat | |
| Tool steps | UX.T2 · steps, full diff | chat | |
| Permission card and dock | UX.T2 · permission, busy | chat | |
| Message sheet | UX.T1 · message | chat | |
| Branches and tree | UX.T3 · pill, tree; UX.T1 · header; L22, L15 | chat | |
| Chat info | UX.T3 · info, archive, delete | chat | light and dark |
| Usage | UX.T3 · usage; L12 | chat | |
| The composer: a new chat with chips | UX.C1 · 9; UX.C2 · 1; P0.3 UXC1.new, UXC2.new | composer | |
| The composer: started | UX.C1 · 9; UX.C2 · 1; P0.3 UXC1.started, UXC2.started | composer | |
| The composer: each blocked state (offline, archived, no agent, old board connection, model too small, refused send) | UX.V1 · 1 blocked; SEC.7-drop, AAC.2-localdown, SEC.10 phone halves | composer (`composer.v1-*`, eight recipes with `v1-gone`) | Said once, read-only and greyed, the draft visible (6.2), asserted per state; the two the design keeps writable (too small, refused) assert Send greyed and the text kept. |
| The composer: dictation | UX.V1 · 2 dictate; VC.3 phone half | voice (`voice.dictate`) | Device: `voice-mic` Dictate passed on iOS (V1 chunk 7). |
| The composer: speech mode | UX.V1 · 3 speech; VC.4 phone half | voice (`voice.speech-bar`, `voice.speech-bar-send`) | `voice-mic` has no speech-mode step. |
| The composer: board context | UX.C1 · 6, 7; UX.B2 | composer | |
| The composer: quotes | UX.C1 · 6 ("2 quotes" sheet); UX.T1 · message (Quote → comment) | composer | |
| The composer: images | UX.C1 · 5; IM3.2, L18; UX.T3 · images | composer | |
| The composer: keyboard up | UX.C1 · 1; device `ux-composer` | composer | the soft keyboard is the device's |
| Each picker | UX.C2 · 2 (Agent), 3 (Model, Pi), 4 (Folder), 5 (Subagents); UX.S4.3 (Prompt) | composer | |
| Settings and every page under it | UX.S1 (Settings, Appearance, About); UX.S2 (Servers); UX.S3 (Voice, Add key, Choose voice); UX.S4.1 (Prompt library); UX.H2 · archived | settings, home | |
| Servers and its detail in each state | UX.S2 · list, detail (Connected, Unreachable, Too old, Connecting, Certificate changed), sheet | settings | Local network off: browser cannot show it (iOS only); unit tests and `_v4-localnet` |
| The add flow with a matching and a non-matching fingerprint | UX.S2 · add-match, add-mismatch, add-manual | settings | the scan step is device-only (`_v4-scan`) |
| A changed certificate | UX.S2 · cert-paste, cert-trust, detail; UX.H1 · cert | settings, home | |
| Voice settings with and without a key | UX.S3 · no key, Add key, with a key, Choose voice, devices, remove | settings | light and dark |
| The prompt library | UX.S4.1, UX.S4.2, UX.S4.3 (PL4.1, PL5.x, PL6.1 are the wide layouts') | settings | light and dark |

## Device-only (6.3)

Devices: iOS simulator (iPhone 17, one per package, deleted after); Android: no JDK 17 and no emulator on this machine, so **every Android half
was written, none run** (notes-foundation.md). "Passed" is the owner's status line; nothing here was re-run.

| Item of 6.3 | Flow | Last run |
|---|---|---|
| Swipe and long press on rows, the drag after 10 pt | `ux-rows`; the primitive in `sheets` 7c | iOS passed (H2 run 6). Open: a partial swipe on a chat or board row ended as a tap under Maestro's one-move finger (a real finger is untested); the haptic cannot be read on a simulator. Android not run. |
| The swipe back from the edge and its exclusion on a board | `ux-stack` | iOS passed (F2; again with H1's PlaceBar fix). Android back (chat → group → Home, board → group) written, not run. |
| Holding the back opens the stack sheet | `ux-stack` | iOS passed. |
| Sheet detents and keyboard avoidance | `sheets` 7a to 7c; `ux-composer` | `sheets` iOS passed (F1-9). `ux-composer` iOS passed (C1 chunk 9; the chip row not hiding was fixed by the lead, c66c043); its drag-down steps are optional and the thread's `keyboardDismissMode` (X1) is left for a final device check. Android not run. |
| Take photo and the system pickers | `storage-picker-permission` part 2 | iOS passed (C1 chunk 9, again with S2). The simulator has no camera: the app says so. Android not run. |
| The camera scan | `_v4-scan` (part 4 of `storage-picker-permission`) | iOS: the scanner's screen and permission both ways passed; the scan itself is by hand (goal 7.5). Android not run. |
| Local Network | `_v4-localnet-why`, `_v4-localnet` (parts 3a and 3) | iOS passed with S2 (the simulator never asks; the forced refusal shows the words and Open Settings). Android has no such permission. |
| The board's bottom row with the orb docked, and the fallback | `ux-board` (inset step) | iOS passed ×2 (B1 chunk 9): the inset holds, no fallback built. V1's orb is merged now; the flow has not been re-run with it (a device run for the orchestrator). Android not run. |
| Landscape on a board | `ux-board` (landscape step) | iOS passed (B1 chunk 9, rotated simulator). Android not run. |
| Landscape on a table | `ux-table` | iOS: passed by hand with `--hold` (iOS 26.3); its two full `run.mjs` runs failed on a lost first tap on Open full table, and the flow now re-presses (T1 chunk 9). Android not run. |
| Android's back | `ux-stack` (Android half) | Not run (no JDK 17). |
| The board's web view | `board-webview` | Passed in B1 chunk 8; in chunk 9 it failed on this host's simulator (web content process SIGBUS in dyld, also on the pre-inset code). Not B1's code; reported. |
| The composer's chip input (Add selection chip, caret) | `composer-chips`, `composer-chips-gallery` | iOS: the C2 steps (row, model sheet, folder sheet) passed on the iPhone 17; the flow then failed at the caret check `caret-at-chip-start` (tap points measured on an iPhone 16e; new estimates committed, not run); after B1's merge the Chats-sheet step was not run. One device run is left (status-c2). |
| Voice: the microphone and devices | `voice-devices` | iOS Part 1 passed (S3, after the lead's 392da75); Part 2 needs a real microphone. |
| Voice: dictation and Read aloud | `voice-mic` | V1 chunk 7 repaired it (message-sheet Read aloud) and it passed on iOS (Dictate line, Read aloud, Microphone sheet); merged into `ux-r1` with V1, not re-run here. No speech-mode step. Android not run. |

## Counts

Rows of the tables of 3.1.4 and 3.2 to 3.8 (a lettered frame is a row; the 3.7 table repeats rows counted elsewhere and is left out):
**127 mockup rows** = **71** covered by a browser check, **50** by a browser check and a device flow, **2** by a device flow only
(04b Scan the code, 09b Landscape on a board), **3** before frames (not designs: 01b, 05p, 10x), **1** not covered: board 04b (the fallback
orb: not built, the inset holds). The nine rows that were V1's (05a, 05b, 12 B, 06a, 06c, 06d, 06s, 07a, 07b) are covered since V1 merged
(R1 second part): UX.V1-voice, the VC phone halves and the R1 recipes `composer.v1-*` and `voice.*`; 06a and 06c also by `voice-mic`.
Every item of the goal's 6.1 enumeration names its check.

## Findings for the lead (gaps a check does not close)

These are in the tables above; listed once so they can be picked up.

1. **Chats sheet "Voice" mark** (goal 3.4): settled: R1 `voice.card` asserts it in the voice card's "To:" sheet (a chat voice is set to).
2. **A new board chat's title becomes its topic after the first message** (goal 3.4, mockup 12c): asserted by no check.
3. **Blocked states** (3.7.1), the voice card, Set up voice, Dictate and the speech bar: settled with V1 merged (UX.V1-voice, VC phone halves, R1 `composer.v1-*` and `voice.*`). Left: re-run `ux-board` and `voice-mic` on a device with the merged code.
4. **Landscape on a board** has no browser coverage by nature (device only) and the Android halves of every device flow were never run.
5. **Local network off** has no browser state (iOS only): unit tests and `_v4-localnet`.
6. **Speech mode on the board** (12 B): settled: UX.V1 · 5 board and R1 `voice.speech-selection`.
7. `P0.3` `DRAWN` has 102 states; the header of the file still says 85 (counted here; the file's own header is a README item).

## Open items the packages left, settled by R1

- **The chat header says "Writing…" while a tool runs** where `ch-05c` note 9 draws "agent · folder". Kept as built. Goal 3.5 allows the
  sub-line to be "Claude Code · checkout-service, **or the state**", and goal 3.1.3 names "a chat's header" among the places that use the one
  list of state words, with **Writing…** for a chat at work; Home's row says the same word for the same chat (one list, goal 6.2). The note is
  a picture of one moment of the permission mockup, not a rule against the state; the goal, written after the board and reconciling it, says
  the state may stand there. While a request waits the header says "Needs your approval" (UX.T2, UX.R1 `chat.perm`).
- **PL5.2 at the phone failed at `openBox`**: the check's phone half was stale (the phone toolbar has no `more-chip`; an empty phone box shows
  Talk, not `send`); rewritten to the "+" sheet's Insert a prompt, the toolbar section played only in windows of 700 px and more. PL5.2 passes
  at the three viewports (R1 chunk 9).
- **The web `Sheet` has no footer slot** (C2's folder sheet keeps "Use <folder>" down with a height estimate): judged fine for this goal.
  With the path typed and the window cut to 55 % of its height, and with a 16-folder list scrolled to its end, "Use <folder>" stays shown and
  uncovered (R1 chunk 4; UX.R1 `composer.chips-long-folder`). Native lifts the sheet with its own keyboard handling (`ux-composer`,
  `composer-chips` device flows). No `ui: Sheet foot` is added.
- **A pushed screen's bar title after a rename** (S4's known limit; S2's `PushedRoute` reads the title through `useStore`): holds for library
  groups, a nested one and the screen under it (its back label) — new scenario in UX.S4.1 (R1 chunk 9).
- **L16 at the tablet** ("after a model pick the toolbar has no effort chip") and **A2.5 at the desktop** ("board-new in a 400 px panel: 0
  elements match tchip[title^=Model]…") fail identically on `main` 4f49381 with main's own checks and build: they predate this work. The wide
  layouts are not redesigned (goal 4.2).
