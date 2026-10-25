# R1 status — the rules check and the final sweep (lead: Opus 5.5)

Worktree `.worktrees/ux-r1`, branch `ux-r1` (from `ux-improvements` a8095d4). Chunk briefs: `.worktrees/.ux-briefs/r1/` (common.md, c<n>-*.md).
Chunk worktrees `ux-r1-<n>` from `ux-r1`; ports 41n1–41n9 for chunk n; uicheck slots `/tmp/r1-uic-{a,b,c}` (at most three at once).
Lead DIST `/tmp/r1-0/dist`.

## The walker (lead)
- `web/dev/checks/rules.mjs`: the in-page audit (target with hit slop read from React's props or `data-hit`, text 13, text17 ramp, desktop
  words, title, focus, label, stop, sheet head, danger last and red, no Cancel in a P1, state words against statewords.ts, Auto-send,
  canvas between the bar and the bottom row), the recipe runner (seed per group, mock restarted when the seed changes, steps audited,
  `allow` with a goal reason, `DEFECT…` allowances printed and counted), report.json and pictures in $R1_OUT.
- `web/dev/checks/rules/*.mjs`: recipe groups (one per chunk). `UX.R1-rules.mjs`: the check (phone, light and dark; `export const limit`).
- `web/dev/uicheck.mjs`: a check's own `export const limit = <s>;` raises the runner's limit for it.

## Defects found and fixed (lead)
- `ui:` hover titles at the phone layout (useControlRef.web.ts: no `title` when usePhone()); Home's gear was the first the walker named.

## Chunks
| # | What | Worktree | State |
|---|---|---|---|
| 1 | rules/home.mjs: Home, groups, rows, sheets, search, Archived; archive/Undo, delete asks, back landings | ux-r1-1 | merged (d070772): 17 recipes, 108 screens pass; fixes: server sheet head, search Clear 44, swipe cover (same as 2) |
| 2 | rules/settings.mjs: Settings, Servers, add flow, cert, voice settings, library; Auto-send only there | ux-r1-2 | merged (61ecded+): 15 recipes, 80 screens pass; fixes: add-flow fields 44, library name field 44, ui: swipe cover not a tab stop, "Stop sample" → "Pause sample" |
| 3 | rules/chat.mjs: header, thread, sheets, tools, perm, subagents, tree, Chat info, usage, images; item "Writing…" | ux-r1-3 | merged (31e1fa8): 11 recipes, 52 steps pass; fixes: comment field focus ring, label tag 13 pt, image viewer tab stops, quote chip (with 4); "Writing…" kept (coverage.md) |
| 4 | rules/composer.mjs: box, chips, pickers, + sheet, quotes, images; V1 TODO recipes; item Sheet footer | ux-r1-4 | merged (0f3284e): 11 recipes, 68 screens pass, 10 V1 todo; fix: quotes chip 44 pt target; Sheet footer fine on web |
| 5 | rules/board.mjs: bar states, menu, Chats sheet, board chat, pick; selection rule, view on return, canvas | ux-r1-5 | merged (5a4dd2c): 8 recipes, 58 screens pass; no app defect; lead: canvas rule skips raised sheets (walker), narrow allowances |
| 6 | coverage.md | ux-r1-6 | merged (f82611f): 127 rows; 10 not covered with reason (9 V1, 1 fallback orb not built) |
| 7 | README, P0.3 DRAWN, A6.4 new parts, docs phone layout | ux-r1-7 | merged (9e4322b): P0.3 102/102 phone, 67/67 wide; A6.4 phoneParts in six flavours; fixes: ui: okText token (phone), search placeholder muted; left: Claude mark orange 2.7:1 (brand) |
| 8 | phone halves after the no-title change | ux-r1-8 | merged (d65cfab): A2.5 L1 L12 SEC.10 fork.mjs phone halves read aria-labels; pre-existing at phone: A2.2, A2.5 sub meter, A4.3, AAC.1, SEC.6 → chunk 10 |
| 10 | pre-existing phone failures: A2.2, A2.5, A4.3 (held picker reason), AAC.1, SEC.6 | ux-r1-10 | merged (a398131): phone pass all five (SEC.6 only V1's composer-block line); app fix: ChipRow `chip-held` reason line (goal 3.1.3) |
| 9 | items: PL5.2 phone, library group title after rename, L16 tablet / A2.5 desktop on main | ux-r1-9 | merged (da4c5ba): PL5.2 phone half stale (fixed, 3 vp pass); rename title holds (UX.S4.1 scenario); L16 tablet and A2.5 desktop fail identically on main 4f49381 |

## Lead runs
- After chunks 1–9 merged (DIST /tmp/r1-0/dist2): root `npm test` (exit 0, conn passed this time), `npm run check`, web, desktop all pass;
  `uicheck -- UX.R1` at the phone: 418 screens (62 recipes, light and dark), 0 failures, 12 skipped (V1), 0 DEFECT allowances, 435 s.
- Lead fix de0850a: the Tree's filter segments 44 pt targets (the chat group had allowed them as "goal draws 32 pt"; 3.1.1 asks a 44 pt target
  around a control that looks smaller). UX.R1 chat.info, UX.T3, L15 phone, L15 desktop pass.
- V1 not merged into ux-improvements at this point: 12 recipes are `todo` naming V1 (composer.v1-* ×10, board.voice-card, board.speech-selection).
- Final (after chunk 10; ux-improvements a8095d4 merged: up to date; DIST /tmp/r1-0/distF): root `npm test` only the known conn time-out,
  `npm run check`, web, desktop pass; `uicheck -- UX.R1` phone: 418 screens, 0 failures, 12 skipped (V1), 0 defects, 498 s; UX.C2, UX.T3 phone
  pass; A4.3 phone failed once after UX.R1 ("before the Send the thread says … got Thinking… · 1 s"), passed alone: load-sensitive.

## Left / for the orchestrator
- **V1 not merged**: when it is, R1 is resumed to merge ux-improvements and fill the 12 `todo` recipes (composer.v1-* blocked states,
  dictation, speech bar, Set up voice; board.voice-card, board.speech-selection), drop the `pill`/`archived-bar` V1 allowances, and settle the
  "Stop sample" → "Pause sample" word (V1's words.ts and UX.S3 still say "Stop sample").
- SEC.6, SEC.7-drop, AAC.2-localdown phone fail only on V1's composer-block lines until V1 merges.
- Wide, predating this work: L16 tablet and A2.5 desktop (same on main 4f49381); A2.2 desktop board-panel wait (C1/X1: not ported to the
  reader model's Edit here).
- Claude's agent mark orange (#d97757) is 2.7:1 on Light/Latte grounds (A6.4 skips agent marks: the name stands beside it): a brand decision.
- The edge swipe back and the keyboard-up chip hiding are device-only (ux-stack, ux-composer).

## Second part — V1's recipes (lead: Opus 5.5)
ux-improvements b446af3 (V1 merged) merged into ux-r1 → f3563d2 (clean, no lock change). Briefs: `.ux-briefs/r1/second.md` + c11–c14.
Words decided (goal 3.7.2 "Stop is only for stopping the agent", 4.7 every screen): "Pause sample" stays (already in V1's words.ts and UX.S3);
the other non-agent stops become the vocabulary's **End** ("End dictation", "End reading", "End test", the wide pill's "End").

| # | What | Worktree | State |
|---|---|---|---|
| 11 | composer.v1-* blocked recipes (7) with said-once / read-only / draft checks; chat.mjs V1_ARCHIVED dropped | ux-r1-11 | merged (bb9a71c): 8 recipes (+ `v1-gone`), 18 screens; composer 104, chat 104 screens pass both themes; no app defect. Lead: no chip hint in the no-agent empty thread (27aeb3e) |
| 12 | rules/voice.mjs: dictate, speech bar, Set up voice, voice card, speech-mode selection; board.mjs PILL dropped | ux-r1-12 | merged (4f0c681): 6 recipes, 25 screens/theme; fix: Set up voice sheet `sheet-head` (df7a01e); UX.V1 UX.B1 VC.2 phone pass |
| 13 | SEC.6, SEC.7-drop, AAC.2-localdown, SEC.10 phone halves on composer-block; fork.mjs openActs; sel.mjs chats row | ux-r1-13 | merged (2f68ba9): SEC.6/7/AAC.2 already pass; SEC.10 reads composer-block, SEC.7-board `+` gone offline; openActs lifts by touchCancel (no app defect reproduced, 18 holds); `chatsSheetRow` = `chats-row` |
| 14 | "Stop" only for the agent: voice words → End, checks and docs | ux-r1-14 | merged (dfbe573): End dictation/reading/test, pill orb End, CV_PLAY_STOP gone, Mute tip reworded; VC.7 phone reads aria-label; VC.1 VC.5 VC.7 VC.8 UX.S3 UX.V1 pass |
| 15 | left after 13: L19 phone (old placeholder), P7.1 phone (tool cards, subagent step), A4.3 phone flake | ux-r1-15 | merged (5173224): L19 reads composer-block; P7.1 phone reads T2's step card; A4.3 compares the busy line without its seconds (3/3); fix: StepCard added-row tint 10 % (Latte "+" 3.07:1) |

- Coverage (lead, 1620557): the nine V1 rows covered; 127 rows = 71 B, 50 B+D, 2 D, 3 before, 1 N (04b fallback orb, not built).

## Second part: final (ux-improvements 313e2be merged → 584c403; conflicts sel.mjs, SEC.7-board.mjs: same fixes as chunk 13, took ux-improvements')
- Root `npm test`: only the known conn "real runner … a time-out"; `npm run check`, web 99/99, desktop 172/172.
- `uicheck -- UX.R1` phone (DIST /tmp/r1-0/distD): **504 screens (76 recipes, light and dark), 0 failures, 0 skipped, 0 DEFECT**, 979 s.
- P7.1: phone and tablet pass. Desktop: lead fix (plain-noagent-installed has no box at 300 px: V1's bar); then it stops at `board-selected`
  (`act select` waits for an editable canvas; the desktop board panel is a reader until Edit here): predates V1, same cause as A2.2 desktop.

## Left / for the orchestrator (second part)
- P7.1 desktop and A2.2 desktop: `sel.mjs` `act("select")` on a board panel needs Edit here (reader model), wide only.
- Device re-runs with V1 merged: `ux-board` (the docked orb) and `voice-mic`.
- L16 tablet and A2.5 desktop as in the first part (predate R1).
