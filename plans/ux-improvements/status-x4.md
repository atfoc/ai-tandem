# X4 — the final browser-check failures (lead: Opus 5.5)

Worktree `.worktrees/ux-x4`, branch `ux-x4` (from `ux-improvements` 25ea7ea). Chunk briefs: `.worktrees/.ux-briefs/x4/` (common.md, c<n>-*.md).
Ports 40n1–40n9 per chunk n. uicheck slots `/tmp/x4-uic-{a,b,c}` (at most three at once). Baseline DIST `/tmp/x4-0/dist`.
Failures: the orchestrator's full run on 25ea7ea (`/tmp/orch/uicheck-fails.txt`).

## Baseline alone (lead, /tmp/x4-0/dist)
- A2.2 desktop+phone, A2.3 desktop+tablet+phone: `waitForSelector composer-input` 30 s, alone too (deterministic).
- L0 desktop+phone: `waitFor home` 15 s at `showHome` ← `openRow`, alone too.

| # | Checks | Chunk | State | Cause | Fix | Result |
|---|---|---|---|---|---|---|
| 1 | A2.2 desktop/phone, A2.3 3 vp, P0.6 desktop, P7.3 desktop | ux-x4-1 | **merged** (271c903) | check-side: at < 700 px three states have V1's block, no box (`plain-noagent-installed` noagent in the box's place; `plain-off-new`/`-started` offline in the toolbar's place); P0.6/P7.3 (and A2.2/A2.3 desktop on main): `act("select")` waited for the writer's canvas without Edit here | composer.mjs `BLOCKED`, `blocked()`, `blockHeld()` (one block of the kind and place, says why, no Send/toolbar/box beside it); A2.2/A2.3 assert it there; sel.mjs `act("select")` presses Edit here when the canvas is a reader's | A2.2 A2.3 3 vp, P0.6 P7.3 desktop pass |
| 2 | L0 desktop/phone, SEC.3 phone, R3.12 phone | ux-x4-2 | **merged** (e5148b8) | all check-side, stale: L0's stand-in page drew no Home (H1); SEC.3 waited for H1's `server-sheet-stopgap` (S2's `srv-sheet` replaced it); R3.12 phone read "+"/Send while V1's offline block stands in the toolbar's place | L0-harness.mjs (Home, group screen, `placeOf`), SEC.3 `srv-sheet`, R3.12 phone reads `composer-block` "is offline" | L0 SEC.3 R3.12 pass 3 vp |
| 3 | P0.3, P7.1 (not ended after 600 s) | ux-x4-3 | **merged** (9fd0033) | P0.3: only the limit (alone: phone 408 s, tablet 154, desktop 280 = ~840 s in one process); P7.1: the limit (~980 s alone) and desktop's `select` state without Edit here (same as chunk 1's) | P0.3 `limit = 1700`; P7.1 `editHere` after open for a `select` state, `limit = 2000`; boarddraw.mjs `editHere` a no-op when the canvas is live | alone: P0.3 3 vp, P7.1 3 vp pass |
| 4 | A2.5 desktop, L16 tablet (same on main 4f49381, R1 chunk 9) | ux-x4-4 | **merged** (845cb9d) | checks stale: since core's fit e59ad9c (voice's pair keeps its room) the Model chip at a 400 px panel and the effort chip at the tablet are in "more"; A2.5's meter table expected the ring at 430/400 px (text now holds to ~340, busy ~380). **App bug** (also desktop, baseline): an effort list opened from "more" had its first row focused by the overlay; ArrowDown+Enter picked Low | A2.5 reads the chips in "more", meter table re-measured 460→300; L16 `effortChipOf`; app c077902 `Picker.tsx`: Enter is a row's own press only after a Tab since the list opened | A2.5 L16 pass 3 vp; A2.4 desktop/tablet pass |

## On main 4f49381 (lead; `.worktrees/x4-main`, DIST /tmp/x4-main/dist, main's own checks)
- L0 desktop: **passes** on main (the failure is new: this work).
- A2.2, A2.3, P0.6, P7.3 desktop: fail on main too, all at `sel.mjs` `act("select")` waiting for
  `.excalidraw:not(.excalidraw--view-mode) canvas.interactive` (the reader model of 848862a: no Edit here) — predate; on ux-x4 they stop earlier
  (`composer-input`).
- A2.3 tablet: fails on main too ("a model pick in the popup that shortens the label: … not back in the row"; tap `tchip[data-kind=effort]`).

## VC.8 (lead)
- Baseline, 3 vp alone: **pass**, 346.7 s. Under load that passes the runner's 600 s: `export const limit = 900` (e6ee75c).

## Left for the lead
- `.worktrees/x4-main` removed.

## Final (lead, merged chunks 1–4, DIST /tmp/x4-f/dist)
- Units: root `npm test` only the known conn "real runner … a time-out"; `npm run check`, web 99/99, desktop 172/172 pass.
- uicheck, 3 vp each (three runs at once, loaded): P0.3 pass 659 s, P7.1 pass 902 s (both past the old 600 s: the limits are needed); UX.R1 phone 504 screens, 0 failures, 914 s.
- uicheck, 3 vp each: A2.2 A2.3 A2.5 L16 P0.6 P7.3 L0 SEC.3 R3.12 pass; HB.1 L5 (editHere's callers) and VC.8 pass.

## Done
`git merge ux-improvements` (25ea7ea): already contained, nothing to merge. Every failure of the orchestrator's list passes at every viewport.
