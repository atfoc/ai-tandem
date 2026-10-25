# S4 — The prompt library and the Prompt picker: status

Lead: Opus 5.5. Branch `ux-s4`, worktree `.worktrees/ux-s4`. Chunk briefs: `.worktrees/.ux-briefs/s4/`.

## Design decisions (lead)
- Phone screens live in `app/src/screens/library/phone/`; the wide layouts keep `LibraryDialog` and the insert dialog as they are.
  Registered: `library` (Settings' row, params `{}`; "+" at the right) and `library-group` `{server, group}` ("…" at the right; a
  nested group is one more push). `prompt-editor` is **not** a pushed screen: the goal (3.8.6) and mockup 06b draw the editor as a
  P3 FormSheet, so it is a sheet (phone/sheets.ts). Rename group and New group are P3 forms (`GroupForm`), Move is a P2
  (`MovePicker`), "+" is a P1 "New in Prompt library" (New prompt, New group), a group's "…" is the P1 of 06b-d.
- The editor's Group row opens the move picker over the form (P2 over P3) and changes the place saved with Save (one PATCH with
  `parent`); Move from a swipe or a P1 moves at once.
- Sheets are drawn by `phone/LibrarySheets.tsx`, mounted on the phone by `LibraryPopups` (the Overlays slot), opened through
  `phone/sheets.ts`. Checks open them through the seam `window.__aiwbLibrary` (uicheck builds only).
- On the phone `libraryDialog` (any caller: the insert sheet's Library, the sidebar foot) pushes `library` instead of the dialog.
- The Prompt sheet keeps the insert popup's testIDs (`insert-popup`, `insert-search`, `insert-row` …) and `openInsert`'s signature (C1's
  caller). Its title is "Insert a prompt" as the mockup draws (the goal calls the picker "Prompt"). Its "Library" closes the sheet with
  the box as it was and pushes `library`. Recent: the last inserted prompts, this computer's kept in the app's storage, a remote
  server's in memory only (as recent folders).
- Offline library: one notice per screen/section, rows open read-only, every change (New, Move, Delete, Rename, swipe) off with the reason.
- ui commit 089914e: `ConfirmSheet` `alt` + `cancelLook: "link"`, `FormSheet` `guard {title, body, saveAndClose}` (06b-f's three ways).
- Prompt sheet: sections in the tree's order, a library's top-level prompts last under "Top level" (the server's name with several),
  as the Library screen lists them. The library's own `parts.tsx` SearchField (with a `phone` size) is used: the kit's takes no key handlers.
- PL5.2's phone half fails against the sheet (42 lines: no path prefix, no first-row highlight, Library instead of "Edit the library", the
  "No prompts match" words): chunk 6 ports it.
- PL5.2 at the desktop fails at "a chat beside a board" (`waitForSelector` 20 s): the same on a clean build of ux-improvements (4e2e7e5),
  so it predates S4 (the board opening read-only on the desktop, as S1 saw for P7.1).

## Verification (lead, before chunk 7's merge)
- Root `npm test`: all pass but the known `packages/conn` "the real runner … a time-out"; `npm run check` ok; `cd web && npm test` 99/99;
  `cd desktop && npm test` 172/172.
- uicheck at the three viewports: UX.S4.1, UX.S4.2, UX.S4.3, UX.S1, PL4.1, PL6.1, L20, PL5.1 ok; PL5.2 ok at phone and tablet, desktop as above.
- After the Prompt sheet's Library and back, the box keeps its text and caret but not the focus (PL5.2's phone half proves the text and caret).
- Known limit: a pushed group screen's bar title is computed when the stack changes (F2's PushedRoute); after a rename it shows the new
  name on the next push or back.

## Chunks
| # | What | Worktree | Model | State |
|---|---|---|---|---|
| 0 | skeleton: ids, sheets store, host, registrations, seam; ui commit | ux-s4 | lead | done (089914e, f1820b5) |
| 1 | Library + group screens, P1s, swipe, delete P4, phone redirect; UX.S4.1-library, libphone.mjs | ux-s4-1 | sonnet | done (2cc253a), merged; UX.S4.1, UX.S4.2, UX.S1 ok at phone together |
| 2 | PromptEditor P3, MovePicker P2, GroupForm P3; UX.S4.2-editor | ux-s4-2 | sonnet | done (7bb30c9), merged (5f08a66), verified: UX.S4.2 ok at phone; lead ui fix 894ec31 (warn tile, centred link) |
| 3 | Prompt sheet (insert popup on the phone), recent; UX.S4.3-prompt | ux-s4-3 | sonnet | done (bc57c45); lead a1f477d: top-level prompts under "Top level" after the folders; merged (60ab29c); UX.S4 (3 checks) ok at phone; checks take 43.5 as 44 (sub-pixel) |
| 4 | PL4.1 phone half | ux-s4-4 | sonnet | done (02cad81), merged; PL4.1 ok at phone (lead) and at the three (chunk) |
| 5 | PL6.1 phone half | ux-s4-5 | sonnet | done (9ea14db), merged; PL6.1 ok at phone (lead) and at the three (chunk) |
| 6 | L20 + PL5.2 phone halves; the library file notice on the phone | ux-s4-6 | sonnet | done (e0b9a20), merged; lead: paths from names (core `placeNames`) so a server name with "/" stays whole; L20, PL5.2, PL4.1, UX.S4 ok at phone |
| 7 | reallibrary.mjs phone pass (heavy lock) | ux-s4-7 | sonnet | done (9699105), merged (973c2f9): 75 ok / 0 FAIL (37 desktop, 38 phone) before the H1 merge |

Briefs: chunk1-lists.md, chunk2-sheets.md, chunk3-prompt.md, common.md in `.worktrees/.ux-briefs/s4/`. Ports 5910/5920/5930.

## Final (after merging ux-improvements 838efe9: H1, T1)
- Fixes for H1: the phone halves wait for `home`, not `side-pane` (UX.S4.1, PL6.1); reallibrary's phone pass reaches the Library by Home's
  gear › Settings, waits for Home's connected word and the empty library, and starts a chat by Home's "+ New" › New chat (5209ec3, b9ae8c5).
- Root `npm test`: known `packages/conn` time-out and the two load-sensitive `packages/headless` "… exits 3"; `npm run check` ok; web 98/99
  (voicestandin "prints its address", load-sensitive); desktop 172/172.
- uicheck phone: UX.S4.1–3, UX.S1, PL4.1, PL6.1, L20, PL5.1, PL5.2 ok (UX.S4.1 and L20 once "the mock did not start": ok alone).
  Tablet and desktop: all ok but PL5.2 desktop (pre-existing, above).
- reallibrary.mjs after the H1 merge: one run before the last fixes: desktop pass ok, phone 2 FAIL (both H1 navigation, fixed in b9ae8c5);
  the run with the fixes is **not done**: the heavy lock was held by ux-h2-10 (device flows) from 11:51 to past 14:02 and S2 is queued.
