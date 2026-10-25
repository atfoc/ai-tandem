# T3 — Branches and tree, Chat info, Context and usage, images, offline/archived thread

Lead: Opus 5.5. Worktree `.worktrees/ux-t3`, branch `ux-t3` (from `ux-improvements` 3aa6bf5). Chunk briefs: `.worktrees/.ux-briefs/t3/`
(common.md, uicheck-slot.md, c<n>-*.md). Ports 47n0 (uicheck), 47n1 (hand mock). At most two chunks run uicheck at once (slot dirs
`.worktrees/.ux-t3-uicheck.{1,2}`).

## Decisions (lead)
- Base contract: `usage/open.ts` (`openUsage(chat)`, `closeUsage`, `useUsageOpen`), the phone's usage sheet opens from the meter and
  from Chat info's Context row.
- One sheet at a time (goal 3.1.4): Chat info closes before what a row opens (rename, usage, tree, delete's P4, server detail); in the
  tree sheet, the row's P1 and the Label form replace the tree sheet while open and it comes back after.
- Seams (one function each, `chat/infoseams.ts`): rename → in-place rename of T1's header until H2's `openRename(item)` lands;
  server → `home/serverseam.ts` `openServerDetail(id)` until S2's `servers/open.ts` `openServer(id)` lands.
- Archive/Unarchive of a chat: `archiveChat`/`unarchiveChat` appended to `sidebar/actions.ts` (Undo toast on the phone).
- The offline permission card (buttons off, one line) is T2's `PermCard`; the composer's offline notice and archived bar are V1's.
- Image viewer: no ⋯ (its actions are the bottom row); native Save opens the system share sheet (no photo-library dependency).

## Chunks
| # | Chunk | Worktree | State |
|---|---|---|---|
| 1 | Chat info sheet + seams + archive actions | ux-t3-1 | **merged** (a883229): L10, UX.T1 pass at 3 viewports; L10 phone half → chat-info; name uncut (lead) |
| 2 | Context and usage sheet (phone) | ux-t3-2 | **merged**: sheet matches ch-02c (light/dark); Messages and System tools expand; L12, A2.4 phone halves updated. After merge: app 1174/1174, core 1594/1594, headless 50/50; conn known failure |
| 3 | Chat tree as a full-height sheet (phone) | ux-t3-3 | **merged** (7583150): L15, L22 pass at 3 viewports; `ui:` 02d9080 (Sheet scrollRef/onScroll), 5b7cd44 (SheetHead subTestID) |
| 4 | Thread thumbnails + image viewer (phone) | ux-t3-4 | **merged**: IM3.5 pass at 3 viewports, IM3.2 phone pass, R3.12 tablet/desktop pass; R3.12 phone fails at the composer strip's away thumbnail — same on ux-improvements (pre-existing, C1's strip). Android: no Share/Save (RN Share takes no file there); Ask about it via core drafts (no composer seam) |
| 5 | Offline/archived thread side, Back online toast | ux-t3-5 | **merged**: L23, AAC.3 pass at 3 viewports; no thread dimming found; PermCard offline words left to T2; COMPOSER_LIFT 124 for V1 to replace |
| 6 | "‹ Branch 1 of 2 ›" switcher under a message | ux-t3-6 | **merged**: L15, L22 pass at 3 viewports; lead moved the pill under the user's bubble (new chat part `MessageBelow`, one fragment in T1's ItemView.tsx) |
| 8 | Phone halves our changes break elsewhere: SEC.10 (rename now in Chat info; tree rows), and the pre-existing A4.3/SEC.10 quote failures (fork/quote phone paths; they fail on ux-improvements too) | ux-t3-8 | **merged**: SEC.10, A4.3 pass at 3 viewports (check scripts only) |
| 9 | After merging ux-improvements (T2, C1): R3.12 (no bar on the phone), SEC.10 quotes and A4.3 Send phone paths on C1's composer | ux-t3-9 | **merged**: SEC.10, A4.3 pass at 3 viewports; R3.12 tablet/desktop pass, phone fails at the composer strip's away thumbnail (also on ux-improvements: the phone's chat screen remounts when its server drops, so the fetched image is asked again — not T3's; reported) |
| 7 | Seed UXT3 + `UX.T3-chatinfo` check + P0.3 rows | ux-t3-7 | **merged**: UX.T3 passes at 3 viewports (light+dark at phone); lead: YOU 13 pt, path breaks at '/', P0.3 phone rows of the offline states |

## Notes
- Baseline (ux-improvements 3aa6bf5, worktree `ux-t3-base`, build /tmp/t3-base-dist) at phone: A4.3 fails (fk-alert, acts), SEC.10 fails at `quote-sheet` — pre-existing (T1's message sheet). With T3: SEC.10 also fails at "the header does not offer to rename" (Chat info) → chunk 8.
- Merged ux-improvements e57fb70 (T2, C1) at 13d4add. Baseline rebuilt at e57fb70 (/tmp/t3-base-dist). Phone failures that are the same on the baseline (not T3's): L10 ("the line has no dots"), L22 ("the drawer of sa_x did not show its permission card"), L23 ("@ … opened no list of boards", attach button), R3.12 strip's away thumbnail. A2.4-popups phone updated by the lead (usage sheet).
- Final runs (build /tmp/t3-final-dist of 13d4add + A2.4 fix): tablet UX.T3 L10 L12 L15 A2.4(-popups, -usage) L22 IM3.5 L23 AAC.3 pass; desktop the same pass;
  phone UX.T3, L12, L15, A2.4 (both), IM3.5, AAC.3 pass, P0.3 only the 3 known board states. desktop units 172/172, app 1198/1198, web 98/99 (voicestandin, load).
- Package done; handed back. Chunk worktrees removed (branches kept).
