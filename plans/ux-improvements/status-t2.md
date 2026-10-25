# T2 — Tool steps, full diff, permission card and dock, busy, subagents

Lead: Opus 5.5. Worktree `.worktrees/ux-t2`, branch `ux-t2` (from `ux-improvements` a0ae381). Chunk briefs: `.worktrees/.ux-briefs/t2/`.

## Decisions (lead)
- Base contract commit: `screens/tools/ids.ts` (T2_TID); `screens/chat/rows.ts` `group` rows + `fold` option (phone only:
  `Thread.tsx` passes core's `foldOf`); chat parts `StepGroup`, `SubagentGroup` (`GroupProps`, stand-in draws every item);
  `screens/tools/diff.ts` (`DiffParams`, `openFullDiff`, screen `diff`, kind content; stub `DiffScreen.tsx`); core
  `logic/steps.ts` (`foldOf`, `readOnlyStep`), `linediff.ts` `numbered`, `anchorOf`.
- Folding: two or more finished, successful read-only calls in a row fold to one row; every run of subagent calls (one or more) is one card.
- No server data invented (D5): line numbers are the file's only when the result shows a `cat -n` snippet (`anchorOf`), else the edit's own
  (1-based, and the head says no "line N"); no step duration; the answered card's time and the busy line's seconds are the app's own
  record (when this app saw the answer / the step start), shown only when known.
- Chat files of T1 (merged, done) touched minimally: `rows.ts`, `Thread.tsx` (group rows; busy line and viewability by chunks), `parts.tsx`
  (two parts). F2's `phone/PushedRoute.tsx` `DrawerRoute` (the subagent screen draws its own ContentBar on the phone).
- Wide layouts unchanged everywhere (`usePhone()`).

## Chunks
| # | Chunk | Worktree | State |
|---|---|---|---|
| 1 | Steps (two-line cards, failure open with exit code, output, edit diff ≤ 10 rows, folded reads) + busy line | ux-t2-1 | **merged** (562b947 + lead fixes): unit+types pass; L13 A5.2 A5.3 desktop/tablet pass; phone shots match ch-04a; phone halves for chunk 7 |
| 2 | Full diff screen (`diff`) | ux-t2-2 | **merged** (last cb8317f): unit+types pass; phone shots match ch-04b (light, dark, wrap, fold, write) |
| 3 | Permission card, answered fold, dock (viewability store) | ux-t2-3 | **merged** (last 6ab2d0d): unit+types pass; phone shots match ch-05a–c (card, dock 1 of 2, folded answer) |
| 4 | Subagents in the thread (card per call, 60 pt rows, nested, report row) | ux-t2-4 | **merged** (last e40a69b): unit+types pass; L19 desktop/tablet pass; phone shots match ch-08a; phone L19 for chunk 7 |
| 5 | Subagent pushed screen (bar, pills, Prompt/Steps/Report, bottom bar) | ux-t2-5 | **merged** (last 3943a57 + lead): unit+types pass; L19 A5.2 desktop/tablet pass; phone shots match ch-08b; phone L19 for chunk 7 |
| 6 | `UX.T2-tools` check + P0.3 rows | ux-t2-6 | **merged** (last 0a1e599): UX.T2-tools passes at 3 viewports; P0.3 UXT2 rows pass |
| 7 | Existing checks' phone halves (A5.2–A5.4, L13, cards.mjs, L19, L6) | ux-t2-7 | **merged** (last 23d2dd0): A5.2 A5.3 L13 L19 L6 pass at their viewports; A5.4 found 2 app bugs (lead fixed) |

Base: aba5b30 (contract), 179759b (UXT2 seed). Briefs `.worktrees/.ux-briefs/t2/{common,c1-steps,c2-diff,c3-perm,c4-subrows,c5-subscreen}.md`, shot helper `shot.mjs`.
- 2 merged. Its decisions kept: fold rule (2 lines beside a change between changes, fold ≥ 3; edges as they are up to 12 lines), mono 13 on 22 pt rows, fold row 44 pt; core `fulldiff.ts`, `toolcard.ts` exports `changeOf`, `resultText`.
- 4 merged. Lead fix: "N running" counts a waiting subagent (it runs; the mockup says 2 running). S1.1 fails at desktop/tablet on the base too (the chip's "more" popup): not T2's, reported.
- 1 merged. Lead fixes: the card's diff starts one line before its first change (as ch-04a), rows on one line with their leading blanks kept (web `pre`), a tab as two spaces. Decisions kept: `tool-card` root + inner `step`; `StepSub` context (StepCard.tsx) for a subagent's Show full diff — the subagent screen wraps its thread in it (chunk 5 / lead at its merge); denied steps get the red mark only.
- 5 merged (conflicts with 4 in subagents/Parts.tsx and core subagents.ts: both appends kept). Lead: StepSub wraps the screen's items; ‹ › outside the cut names. Decisions kept: Copy on PROMPT and REPORT; no STEPS row for an ended subagent without tool calls; the bottom bar adds no inset (the shell's SafeAreaView has it).
- Known, not T2's: S1.1 fails at desktop/tablet on the base too (the composer's Subagents chip in the panel beside a board).
- 3 merged (import conflicts with 1 only). Integrated ux-t2: root `npm test` all pass but the known conn runner time-out; `npm run check` clean; web 99/99.
- Seen, not T2's: a chat at work on a tool says "Writing…" in its header (F3's chatWord); ch-05c note 9 draws "agent · folder" there. Left to the header's owner (T1/T3).
- Chunks 6 (UX.T2-tools + P0.3) and 7 (existing checks' phone halves) spawned.
- 6 merged (after a login stop, resumed). The check id is `UX.T2` (uicheck takes the name up to the dash). Kept: the dock after Show shows the second request ("2 of 2": it is still off screen); the folded time is "H:mm" as formatSince. Lead added P0.3 phoneSee rows for A5.junk and A5.sub. P0.3's mock restart is flaky under load (not T2's).
- 7 merged. Lead fixed the two app bugs A5.4 found: Show all output drew only the last 100k characters; a long output title (an unbreakable tool name) ran past its step. Kept: the phone's command box is plain (not coloured), no Show all on it; moved on the phone (noted in the checks): the full path title, change titles, the subagent crumb, the row's stats (now the screen's pills).
- Merged ux-improvements (H1, 3aa6bf5): one conflict (mock-ui SECTIONS). Final runs on a7a12db+: root `npm test` all pass but the known conn runner time-out; `npm run check` clean; web 99/99 (one load-sensitive failure passed on re-run); desktop 172/172. uicheck phone UX.T2 A5.2 A5.3 pass.
- Final uicheck (build of a7a12db+, unchanged app since): UX.T2, A5.2, A5.3, A5.4, L13, L19 pass at phone, tablet, desktop; L6 passes at phone and desktop; P0.3 fails only on the known board states (A2.board-selected, A6.board, SEC.board: Excalidraw's toolbar never appears; also on ux-improvements) at all three. Lead fixed P0.3's A5.junk phone row (the phone's list mounts rows near the window only).
- Merged chunk worktrees 1–7 removed (branches kept). **Package done; handed back.**
