# B1 status — the board screen on the phone

Lead: Opus 5.5. Branch `ux-b1` (worktree `.worktrees/ux-b1`). Design and contracts: `b1-design.md`.

| Chunk | What | Worktree / branch | State |
|---|---|---|---|
| 0 | design, contract stubs (`board/ids.ts`, `chatssheet.ts`, `rowinset.ts`), `BoardOrb` slot | ux-b1 | done (lead) |
| 1 | bridge messages + board-view phone chrome, menu, band, open view | ux-b1-1 | done, merged (harness ok) |
| 2 | phone bar, state words, bottom row, no floating parts (`ui:` ContentBar state, StateWord colour) | ux-b1-2 | done, merged |
| 3 | Chats sheet | ux-b1-3 | done, merged |
| 4a | side.ts: setPhoneChrome, setOpenView, onMenu, boardPicture, clearBoard | ux-b1-4 | done, merged |
| 4b | app glue: chrome sending (null in landscape), viewmemory, menu.ts, platform/shareimage | ux-b1-4 | done, merged (root npm test green) |
| 5 | landscape floating controls | ux-b1-5 | done, merged (b90d974) |
| 6 | `UX.B1-board` (bar, row, sheet, dark; + menu, clear, share, inset, open view) + P0.3 rows | ux-b1-6 | done, merged (4d8374f; UX.B1 and P0.3 pass at 3 viewports; inset holds, no fallback) |
| 7 | existing checks' phone halves (L5, HB.1, AAC.2, SEC.7, P7.5, A6.3, L24) | ux-b1-7 | done, merged (2591805: + the reader's dropped toast fix by the lead; boarddraw.mjs editHere phone path; A6.3 desktop frappe contrast 2.79:1 pre-existing, masked before) |
| 8 | device: `ux-board.yaml`, `board-webview.yaml` | ux-b1-8 | done, merged (53f5ca0): ux-board and board-webview pass on iOS (sim ux-b1, deleted); Android skipped (no JDK 17); + `spread` scene in app/e2e/lib/scenes.mjs |
| 9 | device findings of 8: web view after Edit here and after a rotation (timing or bug), landscape top inset (`topInset` message) | ux-b1-9 | done, merged (f2a811d): A was timing (the flow now waits for the web view's toolbar and Undo); B the landscape top inset, proven on iOS (`ux-board` pass ×2); `board-webview` fails on this host's simulator (web content process SIGBUS in dyld, also on the pre-inset code), passed in chunk 8 |

Left: the hand-back (post-merge checks). Chunk briefs are in `.worktrees/.ux-briefs/b1/` (re-usable on a resume).

Second resume (Opus lead, 2026-10-23): chunk 5 found finished uncommitted, checked (app check, landscape test) and merged; 4a WIP committed.

Third resume (Opus lead, 2026-10-23, after a machine restart): 4a's hanging tests fixed on disk (committed 52a37be); 4b and 6a re-spawned.

Fourth resume (Opus lead, 2026-10-23 evening): 4b found finished, tests green, merged; 6 and 7 spawned.

Fifth resume (Opus lead, 2026-10-23 night): 6 found clean with 6a committed; 7 never started. Both re-spawned.
Resume 6: 6 verified (UX.B1 phone pass on the merge) and merged; 8 spawned. Note for V1: the VC-28 pill floats over the phone board's menu (covers Share/Clear) until the docked orb replaces it.
Resume 6 verification (lead, merged ux-improvements incl. S1): root npm test (only conn "the real runner … a time-out", pre-existing), npm run check, web, desktop, board-engine tests, board-view harness ok.
uicheck 3 viewports: UX.B1 L5 HB.1 AAC.2 SEC.7 L24 P7.5 VC.6 VC.7 P0.3 ok; P7.4 and L6 phone paths fixed by the lead (sheet row; state word) and pass;
A6.3 desktop frappe contrast (pre-existing, masked before). Phone: L0 L13 L2 PL5.2 SEC.6 VC.2 VC.8 ok; SEC.9 (aiwb.home, F2's key) and VC.4 (Home's settings-btn) not B1's.
Post-merge (ux-improvements 1d0eaae: H1, H2, S2, X1, …) at three viewports: UX.B1 L5 HB.1 L24 L6 P7.4 ok, AAC.2-board SEC.7-board ok; P7.5 phone fixed (S1's pickTheme) and ok.
Not B1's (base, after the other merges): AAC.2-localdown and SEC.7-drop phone (chat warning / composer empty), A6.3-markdown phone (waits for side-tree), VC.6 phone (Home lists boards without chats), A6.3-board desktop frappe contrast.
