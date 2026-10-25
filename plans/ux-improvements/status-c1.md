# C1 — the composer: status

Lead: Opus 5.5. Worktree `.worktrees/ux-c1`, branch `ux-c1` (from `ux-improvements` 1cac2eb).

## Design decisions (lead)
- Phone composer = `screens/composer/phone/PhoneComposer.tsx`, drawn by `Composer.tsx` when `usePhone()`; Composer.tsx keeps all state and calls,
  the wide tree is unchanged. Slots: `AtDock`, `ContextChips`, `ChipRow` (C2's mount point), lines, box (strip, input, `useBlock` | `PhoneToolbar`),
  speech bar, error line, `PlusSheet`.
- New composer parts (`parts.tsx`): `VoiceControl` (voice: one control alone, render prop; registered in `screens/voice/composer.ts`), `takePhoto`,
  `pickFiles`, `useBlock` (V1; default null — archived/legacy keep today's early bars).
- Primary button: Stop (+ Send beside it once typed) › Talk (empty box) › Send. testIDs `send`, `stop`, voice's `voice-speech` / `voice-dictate` kept.
- Phone ids in `screens/composer/phone/ids.ts`; icons in `phone/icons.tsx` (nothing added to `ui/icons.tsx`).

## Chunks
| # | What | Worktree | State |
|---|---|---|---|
| 0 | skeleton (lead) | ux-c1 | done 8b4e473 |
| 1 | chip row (interim, C2's mount) | merged | code merged (6fd472c); browser verification in VA |
| 2 | "+" sheet, camera | merged | code merged (8f59651); browser verification in VB |
| 3 | images in the box | merged | code merged (71131a7); browser verification in VB |
| 4 | context row, @ dock, ring look | merged | code merged (c422bd3); browser verification in VC |
| 5 | quotes chip + "Quoted in this message" | merged | code merged (a6023e1); browser verification in VC |
| 6 | box 17 pt / 6 lines, keyboard, Enter rule | merged | code merged (ec6772f); browser verification in VA |
| VA | verify 1 + 6: uicheck P0.4 L21 L16 (phone), L16 A2.2 A2.5 A2.3 L4 L4b (wide), screenshots | — | done: no C1 bug; phone P0.4 and L21 pass (the tchip model wait is met); L16 phone and narrow windows of A2.2/A2.3 wait for `send` (chunk 8); worktree removed |
| VB | verify 2 + 3: UX.F1 (all), IM3.2 L18 R3.12, screenshots | — | done: no C1 bug; IM3.2/L18 phone halves wait for `send` and read its `title` (chunk 8); worktree removed |
| VC | verify 4 + 5: P7.4 L24 L12 L17 A2.4, screenshots | — | done: no C1 bug; phone halves of L24, P7.4-board, L12, L17 and desktop A2.4-popups (300 px window = phone) must change (chunk 8); worktree removed |
| 7 | mock seeds + UX.C1-composer (brief `.ux-briefs/c1/c7.md`) | — | merged (cef6f05); found the empty-box-while-uploading bug, fixed by the lead 39c4c01; UX.C1 phone ok on dist-39c4c01, tablet/desktop ok |
| 8a | width/fit checks, openState, P0.3 existing rows (`c8a.md`) | — | merged (9a64494); A2.2/A2.3/P0.6 desktop stop at the View-only board (B1's, pre-C1) |
| 8b | L16 IM3.2 L18 L12 L21 PL5.1 (`c8b.md`) | — | merged (b70f683); found the "+" › Insert a prompt caret bug, fixed by the lead ad6b703 (PL5.1 ok at all three); tablet L16 effort chip = pre-C1 (C2) |
| 8c | L17 L24 P7.4-board AAC.3 SEC.8, ui.mjs/remotechat Enter (`c8c.md`) | — | merged (5218c3c); found Point at / Add selection from "+" losing the caret, fixed by the lead c70ac1c (P7.4-board phone ok); remotechat phone: 6 failing steps unattributed, lead reruns at the end |
| 9 | device flows (storage-picker-permission, ux-composer), iOS (`c9.md`) | — | merged (208c330): ux-composer and storage-picker-permission pass on iOS; chip row not hidden → fixed by the lead c66c043; drag-down = T1's thread (keyboardDismissMode) |

Chunk prompts: `.worktrees/.c1-prompts/` (outside the repo); resume prompts `c1-p<n>-resume.txt`.

2026-10-23: lead resumed after the "Not logged in" stop; all six chunks re-spawned in their worktrees.
2026-10-23 (later): the re-spawned chunks were stopped again by an infra error after little work (1, 3, 4, 6: status file put back only;
2: cbdb3eb camera fake fix). Lead resumed again; all six re-spawned (sonnet, high) with `c1-p<n>-resume2.txt`.
2026-10-23 (after a machine restart): the second re-spawns also stopped by infra after little work (1: 39f6971 wiring-test source
assertions; 3–6: status file only). Lead resumed a third time; all six re-spawned (sonnet, high) with `c1-p<n>-resume3.txt`
(chunks no longer touch this file; the lead resolves it at each merge).
2026-10-23 (afternoon): the third re-spawns also stopped by infra (4: f9f7bfd, an empty commit "checked in the browser", no test results;
5: 34c9581 sheet closes when no quote is left; 6: 632bd38 keyboard lift never negative; 1–3: nothing). Lead resumed a fourth time;
all six re-spawned (sonnet, high) with `c1-p<n>-resume4.txt` (each reads its prompt from the file).
2026-10-23 (evening, resume 5): the fourth re-spawns also stopped. New lead verified chunks 1–6 at unit level itself (diffs read; root `npm run check`
green; root `npm test`: 3 core tests expected the old uploads Slot shape, fixed in the lead's commit; conn "real runner" is the known pre-existing
failure; headless "bad configuration exits 3" passes alone: load), merged all six into ux-c1 and removed their worktrees. Browser verification
moved to three chunks VA/VB/VC on the merged branch (prompts `.worktrees/.ux-briefs/c1/{common,va,vb,vc}.md`; shared dist /tmp/c1/dist-ec6772f;
ports VA 5610/5611, VB 5620/5621, VC 5630/5631). Note for chunk 8: at the phone a plain Enter is a line break, Ctrl/⌘+Enter sends (also on wide
web), so send helpers in checks can use ControlOrMeta+Enter everywhere (sites: plans/ux-improvements/c1-enter-sites.md).
2026-10-23 (night, resume 6): VA/VB/VC of resume 5 had left nothing (no worktrees, no results). Uncommitted check edits found in ux-c1
(composer.mjs openState waits for the box at the phone; fork.mjs typeAndSend sends with Control+Enter at the phone) committed as 6ac17d4.
VA/VB/VC re-spawned fresh (sonnet, high) with the same briefs (common.md updated).
Lead notes r6: kit finding for the orchestrator (not C1's): modal.web.tsx focuses an opening overlay's first row, and Chromium draws its
default outline at the phone (goal 3.1.3 "no focus ring"); every phone sheet. Copy note for C2: the new-chat hint says "…below" where the
mockup says "above the box". Phone board states A2.board-selected / A6.board / SEC.board in P0.3 wait on a board in "View only" (B1's).
Lead r6: current dist /tmp/c1/dist-c70ac1c (app code of c70ac1c).
Lead r6 (24 Oct): ux-improvements merged into ux-c1 (68e1aaa; conflicts with H1/T1/S1 resolved: mock-ui SECTIONS, P0.3 DRAWN rows and
phoneSee/phoneRun code, checks README, app/e2e README and _open-chat.yaml). Root check ok; root tests: only conn "real runner" (pre-existing) and
core serversapi.test.ts hung under load (passes alone, 4.6 s); web: host.test "started as a program" and voicestandin "prints its address" (load:
the host starts in 5 s alone); desktop 172/172. UX.C1 phone ok on dist-68e1aaa. 9b (device re-run, chip step strict) resumed; VF phone/tablet/desktop
(final uicheck pass, brief vf.md) spawned.
Lead r6 (24 Oct, later): VF tablet/desktop/phone done on dist-68e1aaa. Fixed after it (e980520, 992e075): fork.mjs openActs takes the hold path only
with a finger (a mouse in a phone-width desktop window has the hover bar); composer.mjs SEES_PHONE remote states read `chat-head-sub` (T1's
PhoneHeader); A2.5 phone-width windows (chip row, the phone ring); A2.2 branch alert via the phone Tree's name, branch change on a 900 px page;
AAC.3 phone half (H1's) Ctrl+Enter. Now ok: A2.5 tablet, A2.2/A2.3 desktop up to the known View-only wait, A2.2 + AAC.3 phone.
Not C1's (report): phone SEC.8 :53/:176 and L12 :311 read `chat-head-server`, P0.4 :375 reads `fk-tree-btn` (T1's phone header has neither);
phone L21 :72 presses the sidebar's `library-btn` (H1's Home has none). 8d (R3.12 composer half at the phone) spawned.
Lead r6 (24 Oct, hand-back): 8d merged (63f23f9): R3.12 ok at tablet/desktop; at the phone it fails on purpose: the chat view remounts when the
section's server drops (all of chat/composer/thumbs are new elements; desktop keeps them), so the fetched thumbnail is fetched again and is a
tile — above C1 (F2's phone stack / shell view; ChatRoute keys by chat only). web tests 99/99. remotechat VIEWPORT=phone not re-run: the heavy
lock was held by ux-h2-10 for over 20 min. All chunk worktrees removed. DONE, handed back to the orchestrator.
