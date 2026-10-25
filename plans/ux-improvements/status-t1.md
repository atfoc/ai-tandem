# T1 — The chat: header, thread, messages, Markdown, quotes from a message

Lead: Opus 5.5. Worktree `.worktrees/ux-t1`, branch `ux-t1` (from `ux-improvements` 1cac2eb).

## Decisions (lead)
- Base contract commit: `screens/chat/ids.ts` (T1_TID), `screens/chat/chatinfo.ts` (T3 stub: `setChatInfo`, `openChatInfo` → false until
  T3; the header's title then renames in place as before), `ChatParts.AboveComposer` (T2's dock; drawn between Banner and Composer),
  `quotes/sheetstore.ts` `openPick(chat, index, mode: "quote" | "select")`.
- The link sheet is not drawn on the board: a P1 with the link's text as title, the address as sub, rows **Open link**, **Copy link**.
- **Select text** (message sheet) opens the Quote sheet's text in mode "select": title "Select text", buttons **Copy selection**, **Copy all**.
- The phone header's Tree badge counts the chat's branches and turns amber when another branch waits for approval or failed (the wide
  header's branch alert is not drawn on the phone; T3 may refine).
- Wide layouts unchanged everywhere (phone branches by `usePhone()`).

## Chunks
| # | Chunk | Worktree | State |
|---|---|---|---|
| 1 | Header (ContentBar, Tree + ⋯, sub-line words) | ux-t1-1 | **merged** (011f810; last c3042c7): L10/L22 tablet+desktop pass; phone L10 (state words, sub-line) and L22 (`fk-tree-btn` → `chat-tree`) for chunk 8 |
| 2 | Thread type (16/1.5, h2 20, h3 17, lists 24, code chip, 16 pt margins) + Latest pill | ux-t1-2 | **merged** (b9e5d0c; last 03191a3): L8, L9, A6.3-markdown pass at 3 viewports; inline chip `hover2` on the phone |
| 3 | Tables: bleed, pinned column, hint, Open full table → `table` screen (pinned header/col, zoom, Copy as Markdown) | ux-t1-3 | **merged** (08ca31f; last d215d15): L9, A6.3-markdown pass at 3 viewports; landscape viewer only on a device (chunk 9) |
| 4 | Code head (lang, Wrap, Copy) + link underline + link sheet | ux-t1-4 | **merged** (c7ae50e; last 0e6f733): L9, A6.3-markdown pass at 3 viewports; link sheet's lift guard 300 ms |
| 5 | Message P1 sheet on long press (quick row, rows, waits, lift), no floating ⋯ on phone | ux-t1-5 | **merged** (0c37a82; last d678735): verified by chunk (L15/L17 tablet+desktop pass; phone L15 `fk-more`, L17 hold→sheet expected, chunk 8) |
| 6 | Quote sheet (phone look), Select text mode, comment sheet "Add to message" | ux-t1-6 | **merged**: unit/types pass, L17 desktop pass (L17 has no tablet); phone L17 (`quote-text` after a hold → now the message sheet) for chunk 8 |
| 7 | Mock seeds + `UX.T1-thread` check | ux-t1-7 | **merged** (31a9375; last 0167652): seed `UXT1`, check `UX.T1-thread` passes tablet/desktop, phone with chunk 4 (re-run at the end); P0.3 rows UXT1.* |
| 8 | Existing checks' phone halves (L10, L9, A6.3, L17, L15/fork.mjs, L8, L22) | ux-t1-8 | **merged** (last 824e2be): L10, L22, L8, L9, L15, A6.3-markdown pass at 3 viewports, L17 at desktop+phone |
| 10 | P0.3-smoke's chat states on the phone (`phoneSee`/`phoneAct`); is A6.3-board's failure T1's? | ux-t1-10 | **merged** (last bf24b4d): P0.3 chat states pass at 3 viewports; board states fail on ux-improvements too (not T1's) |
| 9 | Device flow `ux-table.yaml` (iOS, landscape) | ux-t1-9 | **merged** (last 1cd68de): `ux-table.yaml` passed by hand (--hold) on iOS 26.3; its two full `run.mjs` runs failed (first tap on Open full table lost; flow now re-presses) |

## Base commits
- 3880c27 base contract; 8e3a226 look.phone; 65d3014 markdown/register.ts + holdclaim.ts

## Resume (2026-10-23)
The first lead and chunks 1–6 stopped ("Not logged in"). Every chunk had its code committed, none verified. Re-spawned all six to
verify and finish in their worktrees. Decision: `ContentBar` gets `titleTestID`/`subTestID` (a `ui:` commit in ux-t1-1) so the phone keeps
`chat-head-name`/`chat-head-sub` and the checks that read them.

## Resume 2 (2026-10-23 11:30)
Stopped again (~11:06). Each chunk had added commits (1: ui titleTestID; 3: viewer widths; 4: link hold; 5: lift height; 6: quotewords.ts).
Their uicheck failures were "the mock did not start" under a load average of 56 (unit tests of 20 min), not code. Re-spawned all six
with each its own uicheck port (49n0), hand-mock port (48n1), one prebuilt DIST per change, ≤3 ids per run.

## Resume 3 (2026-10-23 12:45)
Stopped by a machine restart; the prompts in /tmp/t1p were lost. Rewritten in `.worktrees/.ux-briefs/t1p/` (common.md + s1–s6.md,
outside the repo, survive a restart). New commits since resume 2: none; uncommitted WIP in 3 (table widths) and 5 (lifted bubble
right edge), judged plausible and left to the chunks to commit. Re-spawned all six, same ports.

## Resume 4 (2026-10-23 15:30)
The second lead stopped after chunk 5 came back (14:39). Since resume 3 the chunks committed: 2 (margin, bubble, Latest pill for a
growing last message), 3 (textWidth; reach to the screen's edges), 4 (code Copy toasts), 5 (lifted bubble edges), 6 (text box
height, Copy all as written); 1 nothing. Nothing uncommitted anywhere. Prompts updated (done lists; never kill processes by name).
Re-spawned 1, 2, 3, 4, 6; the lead verifies 5.

## Resume 5 (2026-10-23 evening)
Everything stopped again after resume 4; no chunk committed since (last commits 13:12–14:39). New orchestrator note: at most 3
chunks running uicheck at a time. Spawned 5 (e2cce45e553c), 2 (35cd8aeaa688), 1 (4d4ec5c7aa51) to verify and finish in their
worktrees (prompts `.worktrees/.ux-briefs/t1p/`); 3, 4, 6 follow as these come back.
- 5 back and merged (0c37a82). Lead fixed `quotes.model.test.ts` for the base contract's `mode` (e606fc5). 3 spawned (cdf846d5826e).
  Note for the orchestrator: the kit's P1 head is centred with a divider; the mockups draw it left-aligned (F1's, not changed by T1).

## Resume 6 (2026-10-23 night)
Resume 5 stopped again; no chunk committed since. Nothing uncommitted anywhere, no heavy lock. Briefs got a "Resume 6" line (work order:
unit, one build, screenshots, uicheck; no polish). Spawned 1 (d44a51df5021), 2 (32a99e119b5f), 3 (a58db3803c6e); 4 and 6 follow.
- 3 back and merged (08ca31f). Spawned 4 (6f2276ef19f4) and 9 (ecb56aa4305c, device flow, heavy lock). Briefs s7–s9 written.
- 1 back and merged (011f810; fix: a chat waiting on background work says so). Spawned 6 (8443bbcafd96). Note: ContentBar allows a two-line sub (goal 3.5 says two lines; the mockup draws one): kept.
- 6 back and merged. Known, not changed: the Quote sheet's text is `displayed.ts`'s, which joins paragraphs with no gap ("runs.I'll"); quote offsets count in it, so a change is a contract change (left for later).
- 2 back and merged (b9e5d0c). Spawned 7 (17a1cbd1b446) and 8 (cc43c7b3c11f) before 4 lands (they merge ux-t1 again at the end).
- 4 back and merged (c7ae50e). Lead fixed a type error the merge of 2+3 exposed (Table.tsx bleed state, 67c8f93). `A6.3-board` fails (board toolbar wait) in every chunk: not T1's; to confirm on ux-improvements at hand-back.
- 7 back and merged (31a9375). P0.3 at phone fails on 10 chat states (server pill, fk-tree-btn, tree popup) and 3 board states: chunk 10 (903436d63a87).
- 8 back and merged. Decisions: the phone's message sheet says "Label…" (the mockup), no "Label ✓"; the phone header's only branch signal is the Tree count and its amber state/label (no crumb, no pill).
- Lead merged ux-improvements (S1; openlink conflict: S1's `openLink` kept, d43a9ce) and compared the phone thread (UXT1 seed, light+dark) with ch-03a: matches (table header text a little larger than the mockup's; kept).
- 10 back and merged. `A2.board-selected`, `A6.board`, `SEC.board`, `A6.3-board` fail on ux-improvements 4e2e7e5 too (Excalidraw toolbar never appears): pre-existing, reported to the orchestrator.
- Final runs (lead, build /tmp/t1-lead-dist of d43a9ce+, app unchanged since): root `npm run check` clean; `npm test` app 1129/1129,
  fails only in packages T1 does not touch (conn "the real runner … a time-out": fails on ux-improvements too under load; headless 2
  timeouts: pass alone 50/50); web 98/99 (voicestandin "prints its address": passes alone); desktop 172/172. uicheck phone: UX.T1,
  L10, L22, L9, L8, A6.3-markdown, L15, L17 pass; A6.3-board and P0.3's 3 board states fail (also on ux-improvements). Tablet and
  desktop: UX.T1, L10, L22, L9, L8, L15 pass.
- Tablet/desktop A6.3-markdown pass, L17 desktop pass (no tablet viewport); only the board-toolbar failures (pre-existing). Removed merged chunk worktrees 1–8, 10 (branches kept).
- 9 back and merged; worktree removed. Package done; handed back.
