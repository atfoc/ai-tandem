# B2 status — Point at, Add selection, the selection rule

Lead: Opus 5.5. Branch `ux-b2` (worktree `.worktrees/ux-b2`, from ux-improvements 7284225). Design and contracts: `b2-design.md`.
Chunk briefs: `.worktrees/.ux-briefs/b2/` (common.md + chunk<n>.md). Ports: chunk n uses 45n0 (dist per chunk in /tmp/b2-<n>-dist).

| Chunk | What | Worktree / branch | State |
|---|---|---|---|
| 0 | design; store `pickFor`, refs.ts `startSelect`/`finishSelect`/`pickingFor`, side.ts view mode, BOARD_WORDS picking/selecting, tests | ux-b2 | done (lead) |
| 1 | `board/refbox.ts` (split/join/shift) + `board/reflabels.ts` + unit tests | ux-b2-1 | done, merged (shiftRefs caret hint added by the lead) |
| 2 | board side: PickBar, BottomRow, PickLayer on the phone (no hint, pin 600 ms, border), bar state + Chats dimmed, landscape | ux-b2-2 | done, merged (lead: voice pill hidden while a wait is on, pin label clamped) |
| 3 | RefBox + RefChips, Composer phone wiring, ContextChips (refChips, no Add N selected), PlusSheet rows | ux-b2-3 | done, merged (lead: RefBox reports an unchanged set); shared DIST /tmp/b2-dist-e7a8a5a |
| 4 | mock seeds + `UX.B2-pick` + P0.3 rows | ux-b2-4 | done, merged (4b: UX.B2 phone ok on /tmp/b2-dist-c3e3103) |
| 5 | existing checks' phone halves: P7.4-board, L24-boardui, others reading the old rows/chips | ux-b2-5 | done, merged (+ SEC.7-board phone half) |

Device: none planned (the pick's native tap is unchanged; RefBox draws the same ChipInput with plain text).

Lead (24 Oct): all chunks merged and their worktrees removed. Lead fixes beside the chunks: voice pill hidden while a wait is on (BoardCanvas),
the pin's label clamped by a transform, RefBox reports an unchanged set, shiftRefs caret hint, and **board-view endpoint.ts**: a fit asked while
the view has no size (the phone's board mounted under its chat when {board, chat} is opened directly) waits until it has one (was zoom 0.1;
B1's open view; board-view harness ok, board-engine tests ok).
Not B2's (same on the base): PL5.2 phone (`openBox` locator.tap / waitForSelector `send`), SEC.7-drop phone (B1's list), L16 tablet effort chip (C2's).
ux-improvements (bacf6a5, C2) merged into ux-b2 (ca68d82): conflicts in mock-ui.js (SECTIONS + header: both kept) and UX.C1 (B2's side).
Post-merge (ca68d82, DIST /tmp/b2-dist-ca68d82): root check ok; root tests only conn "the real runner … a time-out" (pre-existing); web 99/99; desktop 172/172.
uicheck phone: UX.B2 P7.4 L24 UX.C1 UX.B1 P0.3 SEC.7-board UX.C2 ok (SEC.7-drop phone pre-existing; P7.4-quote is desktop/tablet only).
tablet and desktop: P7.4 L24 UX.C1 P0.3 SEC.7 UX.B1 ok. DONE, handed back.
