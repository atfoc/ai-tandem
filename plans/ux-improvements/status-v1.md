# V1 — Blocked states and voice in the composer and on the board: status

Lead: Opus 5.5. Worktree `.worktrees/ux-v1`, branch `ux-v1` (from ux-improvements bacf6a5). Design: `v1-design.md`.
Chunk briefs: `.worktrees/.ux-briefs/v1/` (`common.md`, `c<n>.md`). Chunk n: worktree `.worktrees/ux-v1-<n>`, PORT 43n0, dist `/tmp/v1-<n>-dist`.

## Chunks
| # | What | Worktree | Model | State |
|---|---|---|---|---|
| 1 | Blocked states: Blocked.tsx, blocked.ts + test, useBlock contract, PhoneComposer/Composer wiring, bars out of Notices, COMPOSER_LIFT | ux-v1-1 | sonnet | done (a6fbe1a), verified (screenshots match 07a/07b/notices; UX.C1 phone, wide ok), merged c25c733 |
| 2 | Composer voice: Dictate line and guess, PhoneSpeechBar (vocabulary, no Auto-send, End keeps words) | ux-v1-2 | sonnet | done (e8785a2), verified (screenshots match co-06c/d/s), merged d921aba; lead: mic accent disc while dictating |
| 3 | Set up voice sheet (every voice problem on the phone) | ux-v1-3 | sonnet | done (005590b), verified (matches co-06a; VC.2 desktop ok), merged; lead: Not now in the accent |
| 4 | Board: docked orb + voice card (BoardOrb, BoardVoice phone) | ux-v1-4 | sonnet | done (e6e5ced), verified (screenshots match bd-05a/b; UX.B1 phone, VC.6 wide ok), merged 120e8a0 |
| 5 | Seeds UXV1 + UX.V1-voice + P0.3 rows (+ page error 'reading run' vs base) | ux-v1-5 | sonnet | done (b47d559), merged: UX.V1, P0.3 phone ok, P0.3 desktop ok; page error not reproduced (0 on base and on ux-v1) |
| 6a | VC.2, VC.3, VC.4, L23, AAC.3 phone halves | ux-v1-6a | sonnet | done (079174b): all pass at phone/desktop (tablet where they run); merged |
| 6b | VC.5-readaloud, VC.6, VC.7, voice.e2e step 8 | ux-v1-6b | sonnet | done (ff1f94f), merged; VC.5/VC.6/VC.7 pass at 3 viewports (VC.6 phone with the lead's DockedOrb archived fix); voice.e2e 60/60 twice |
| 7 | device voice-mic.yaml (Read aloud via message sheet, speech bar, Set up voice) | ux-v1-7 | sonnet | done (0dcc9e4), merged: voice-mic PASSED on iOS (sim ux-v1, deleted); Dictate line, message sheet Read aloud, Microphone sheet seen; no speech-mode step in the flow; Android skipped (no JDK 17) |
| — | docs/architecture.md voice section (lead) | ux-v1 | opus | done |
| VF | empty-thread said-once check updates (UX.V1, L23, L10, L16, P0.3 rows; + VC.8, VC.5 phone) + final runs at 3 viewports + voice.e2e | ux-v1-vf | sonnet | done (99697a9), merged |

## Log
- 24 Oct 18:40: chunks 1–4 spawned (sonnet, high): sids 1 23c1dae3c416, 2 09b0b433d85a, 3 fa0203e8e764, 4 52380b97f376. Browser slots /tmp/v1-browser-{a,b}.
- VC.7 diagnosis (lead): the check resizes 1200→200 px; under 700 px the phone's PhoneComposer has no composer-tools/more popup (C1), so the narrowest wide row seen is 542 px with the pair in the row; the popup half opens at 300/200 px = phone. Caused by C1's phone composer (fails on d8a1855 after C1), not pre-C1. Chunk 6b: phone half describes the phone toolbar (mic + Talk always), the wide order/popup halves only at wide rows (find whether any wide layout still reaches the popup).
- Chunk 2 lines for 6a: VC.3 :100 reads the guess in the box (now `dictate-guess`), :140 typeIn clicks mid-box (caret); VC.4 :102 types a draft then presses Talk (phone primary is Send with text: use an empty box), :129/:269 `speech-autosend` (gone on the phone).
- Chunk 4 line for 6b: VC.6 phone :79 waits for `pill-orb` (now `voice-orb` + `voice-card`, ids in pill/ids.ts).
- Chunk 1 lines for 6a: phone AAC.3 :82 and L23 :57/:115/:145/:189 wait for the offline/gone placeholder (gone: said once in the toolbar's place); L23 :79/:81/:86 read the old archived bar's words; L23 :117 the attach button of a gone chat. Every uicheck page logs a pageerror "Cannot read properties of null (reading 'run')" (to check against the base in chunk 5). Contract as built: PhoneComposer `input(blocked)` and `toolbar.send(off)` are functions, `under` gone (refused is the block's), `useModelNotice` in Notices.tsx.
- Chunk 3 line for 6a: phone VC.2 :193 waits for `send` (pre-existing; the sheet is `setup-voice` now, `voice-problem*` testIDs kept).
- 6a notes (for the orchestrator): `sel.mjs` `IDS.chatsSheetRow` says `chats-sheet-row`, B1 ships `chats-row` (data `chat`): `openBoardChat`/`openChat` on a phone board never find the row (H1's file; not changed by V1). `fork.mjs openActs` releases its long press over the rising message sheet and can tap a row (Branch) on a long thread.
- 6b findings: the wide composer's "more" popup is unreachable now (narrowest wide row 255 px, the board panel at 300 px, pair still in the row); VC.7 asserts it only where reached and notes it. voice.e2e step 8 did not reproduce (60/60 twice): S3's failures came with a loaded machine and a dead run's scratch server. uicheck id is `VC.5` (runs both VC.5 files).
- Lead after chunk 5: the phone's empty thread no longer repeats the block's sentence (offline, gone, no agent installed); the card's × 44 pt (hitSlop 6). Merged ux-improvements (B2, X2) → ad4f2d5: conflicts Composer.tsx imports, mock-ui SECTIONS (UXB2 + UXV1). Root npm test: only the known conn 'real runner' time-out; check ok; web 99/99; desktop 172/172.

## Final runs (on ux-v1 after merging ux-improvements a8095d4; dist /tmp/v1-vf-dist)
- root `npm test`: only the known packages/conn "real runner … a time-out"; `npm run check` ok; web 99/99; desktop 172/172.
- uicheck phone/tablet/desktop: UX.V1 P0.3 · VC.1–VC.8 · L23 AAC.3 L16 · L10 UX.C1 UX.B1 · UX.B2 UX.C2 UX.S3 · UX.T3 L24 P7.4 all ok where they run,
  except L16 tablet (`tchip[data-kind="effort"]`, pre-existing, C2's, same on main).
- `node web/e2e/voice.e2e.mjs` (heavy lock): 60/60 (a first VF run failed in step 8 on an empty /api/state under load; 6b ran it 60/60 twice).
- Device: voice-mic PASSED on iOS (chunk 7). Android not run (no JDK 17). `desktop npm run e2e` not run: the key's store and the bridge are unchanged.

## Left / for others
- `sel.mjs` `IDS.chatsSheetRow` = `chats-sheet-row`, B1 ships `chats-row` (H1's file). `fork.mjs openActs` can tap a sheet row on release.
- R1: the voice card is app chrome over the canvas's lower part while a voice session runs (as bd-05a draws); at rest only the docked orb.
- No speech-mode step in any device flow (voice-mic has none).
DONE, handed back.
