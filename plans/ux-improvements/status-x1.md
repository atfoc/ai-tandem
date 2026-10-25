# X1 — fix-ups (lead: Opus 5.5)

Worktree `.worktrees/ux-x1`, branch `ux-x1` (from `ux-improvements` dadf522). Chunk briefs: `.worktrees/.ux-briefs/x1/` (common.md, c<n>-*.md).
Ports 44n1–44n9 per chunk n. uicheck slots `/tmp/x1-uic-{a,b}` (at most two at once). Baseline DIST `/tmp/x1-0/dist`.

| # | Item | Chunk | State | Cause found |
|---|---|---|---|---|
| 1 | F1 kit: focus ring on an opening sheet (phone, web) | 1 `ux-x1-1` | **merged** (1de83e3 + lead ui: fix) | `modal.web.tsx` focused the first tabbable on open; Chromium marks a script focus focus-visible when nothing (or a keyboard-focused control) had the focus. Fix (ui:): at the phone the layer's root takes the focus (tabIndex -1, no outline); also when an overlay above closes. UX.F1 phone asserts no ring (fails on baseline: 6), L1 phone, UX.F1/L21 desktop, L21 tablet pass |
| 2 | T1 thread: drag down lowers the keyboard | 1 `ux-x1-1` | **merged** | no `keyboardDismissMode`: added on the phone (interactive iOS / on-drag), `keyboardShouldPersistTaps=handled`; source test `app/test/threadkeyboard.test.ts`; device check left for the final device pass |
| 3 | SEC.8 / P0.4 phone halves read `chat-head-server` / `fk-tree-btn` | 2 `ux-x1-2` | **merged** (6d38435) | checks stale since T1's phone header: SEC.8 reads the server from Chat info's Server row, rename through `chat-info-rename`; P0.4 reads `chat-tree`. Pass phone/tablet/desktop (baseline DIST) |
| 4 | L21 phone presses `library-btn` | 2 `ux-x1-2` | **merged** | check stale since H1's Home: phone half opens the library via `openFoot` (Settings › Prompt library), the row sheet's label action; focus return skipped at the phone (note). The library is still a dialog: S4's screen will need `openFoot`/L21 updated |
| 5 | phone L10 / L22 / L23 | 3 `ux-x1-3` | **merged** (a91c85b) | all check-side: L10 busy = spinner (T2), waiting chat shows Stop alone (C1); L22 phone folds an ended subagent's steps (open the fold), `sub-screen-next`, `sub-report-row`; L23 @ list = `mention-dock`, attach = "+" Files row. Pass 3 viewports (pre-merge) |
| 6 | phone R3.12: chat remounts on a server drop | 4 `ux-x1-4` | **merged** (7510acf) | proved: the section's groups vanish on a drop (and return) → `follow` = reset → `navigation.reset` with keyless routes → every screen remounts. Fix: `keepRoutes` keeps the route keys of entries the navigator holds. R3.12 phone/tablet/desktop, UX.F2, UX.T3 phone pass. Not done (suggestion): keep a dropped section's last groups so Back lands on the group |
| 7 | P0.3 board states: toolbar never appears / View only (diagnose only) | lead | **diagnosed** | checks not ported to the reader model (848862a, on main): see below |

## Baseline (dadf522, phone)
- L10: "thinking/tool: the line has no dots"; `send` not found (:215). L22: "the drawer of sa_x did not show its permission card" (:114).
  L23: "@ … opened no list of boards"; "the attach button of a live chat of a section is off" (:100).

## Item 7 — diagnosis (no change made; B1's to apply)
- Cause: since `848862a` (Headless board: readers, one writer, the button; on `main` too) a board opens as a **reader's**, in Excalidraw's view
  mode, and only **Edit here** (`board-take`, RoleBar.tsx → `boardApp.takeBoard`) makes the window its writer; the app takes a board by itself
  only when it makes one (`nav.ts` `newBoard`). The mock follows the server (`/follow` answers `writer: ""`; `held` only after `/take`).
  `A6.3-board.mjs`, P0.3's `A6.board`, `SEC.board` (TOOLBAR = `.excalidraw:not(.excalidraw--view-mode) .App-toolbar`) and `A2.board-selected`
  (⌘A needs an editable canvas), and P7.1's board stage at desktop, were never ported: they wait for the writer's toolbar without pressing
  Edit here. The checks that were ported (P7.5, L5, L24, P7.4-board, HB.1, SEC.7, AAC.2, VC.6) call `editHere(page)` from `boarddraw.mjs`.
  Same files and same app behaviour on `main`: not a UX regression.
- Proof: A6.3 desktop on the baseline: `waiting for locator('.excalidraw:not(.excalidraw--view-mode) .App-toolbar') to be visible` (30 s);
  A6.3-markdown passes.
- Proposed fix (checks only): `await editHere(page)` after the board is open in A6.3-board (each flavour's page) and P7.1's board stage;
  in P0.3 a step `edit: true` on `A6.board`, `SEC.board`, `A2.board-selected` that calls `editHere` before `see` (and before the ⌘A).
  At the phone `editHere` needs B1's board screen to keep the id `board-take` on its Edit here control (or B1 updates `boarddraw.mjs`).

## Merge of ux-improvements b206eaf (H2, S2, S4) into ux-x1 — no conflicts
- Units on the merge: root `npm test` + `npm run check`, web, desktop: all pass.
- Phone, DIST /tmp/x1-f/dist: pass P0.4, L22, L1, R3.12, UX.F1, UX.F2. Fail (new since the merge): L21 :76 (`library-dialog`: S4's screens),
  SEC.8 :155 and L10 :316 (rename: H2's Rename sheet), L23 :170 and UX.T3 ("the Server row opened no server detail": S2's servers; T3 seams).
- Chunk 5 `ux-x1-5` (c5-postmerge.md): fix those; first tells apart merge regressions from X1's modal change (UX.T3 on a plain ux-improvements DIST).
- Chunk 5 merged (61961c8): all check-side (the app's seams were already swapped: H2 `openRename`, S2 `openServerDetail`, S4 `lib-screen`):
  SEC.8/L10 rename through H2's `rename-sheet`; L23/UX.T3 Server → S2's `srv-facts` screen, closed by Back; L21 phone block on S4's library
  screens. Phone L21 SEC.8 L10 L23 UX.T3 pass; tablet/desktop L21 L10 UX.T3 pass.
- Merged ux-improvements d8a1855 (orchestrator's UX.T3 fix): one conflict in UX.T3-chatinfo.mjs, kept X1's (also checks the server's id). UX.T3 phone passes.
- Wide: desktop L21 UX.F1 R3.12, tablet L21 R3.12 pass on the merged DIST.

## Handed back (f37cab3+)
Left for the final device checks: the thread's drag-to-lower-keyboard on iOS (item 2). Suggestions: keep a dropped section's last groups in the
stack (Back lands on the group, not Home, during an outage); at the phone an ended subagent's folded steps can hide its permission card (T2/R1 to judge).
