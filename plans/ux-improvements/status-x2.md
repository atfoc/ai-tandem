# X2 — second fix-ups (lead: Opus 5.5)

Worktree `.worktrees/ux-x2`, branch `ux-x2` (from `ux-improvements` bacf6a5). Chunk briefs: `.worktrees/.ux-briefs/x2/` (common.md, c<n>-*.md).
Ports 42n1–42n9 per chunk n. uicheck slots `/tmp/x2-uic-{a,b}` (at most two at once). Baseline DIST `/tmp/x2-0/dist`.

| # | Item | Chunk | State | Cause found |
|---|---|---|---|---|
| 1 | AAC.2 / SEC.7 chat halves at the phone | 1 `ux-x2-1` | **merged** (36de0e7): phone asserts no `remote-bar`, `chat-head-sub` "● Server · offline", server from Chat info, V1's `composer-block` (offline/gone, `block-servers` offline only), Send off/absent; Talk/Send on Studio Mac's chat. Own DIST: phone fails only on the composer-block lines (until V1); probe with ux-v1-1: phone 4/4; tablet/desktop pass | checks stale: the phone has no top banner (RemoteBar null, T3); composer half is V1's `composer-block` (not merged) |
| 2 | SEC.7 header names the server | 1 | **merged**: `headline.ts` `off` = sendOff only (a gone chat on a connected server keeps its place line), test added | phone header has no `chat-head-server`: "● Server · offline" sub-line when dropped; server in Chat info when connected; also headline says "offline" for a gone chat on a connected server |
| 3 | A6.3-markdown phone waits `side-tree` | 2 `ux-x2-2` | **merged** | check stale since H1's Home: waits for `home`; picker stage via `openFoot(theme-btn)` → `appearance-screen` (S1). 3 vp pass |
| 4 | SEC.9 `aiwb.home` | 2 | **merged** | `aiwb.search.opened` holds {key, kind} only: admitted with a keys-only assertion (`aiwb.search.recent` asserted empty); waits for `chat-head-sub` "offline"; caret helper `toEnd()` (phone box wraps); `aiwb.home` lines pass unchanged. 3 vp pass |
| 5 | A6.4 Allow; kit chevron 2.58:1; A6.3 desktop frappe 2.79:1 | 3 `ux-x2-3` | **merged** (0ceca73) | A6.4 phone expects onAccent/accentFill (4.5 floor kept; wide keeps danger pair); `ui:` DisclosureChevron draws `muted` for `faint` on the phone (≥4.86:1), A6.4 phone measures Home's chevrons; `--keybinding-color` → `ctp:subtext0` in the flavours (app's mapping in core canvaschrome.ts; Light/Dark unchanged). A6.4 3 vp, A6.3-board 3 vp, P7.5 desktop, UX.F1 phone pass |
| 6 | SEC.10 quote sheet | 2 | **merged** | not the quote sheet: `renames()` expected the header's in-place field; H2's Rename sheet stayed open over the rest. Now through `rename-input`, closed by its backdrop. 3 vp pass |
| 7 | "+" of a gone chat off with no reason | 1 (verify) | **V1's**: on the probe (ux-v1-1) the gone block replaces the toolbar, `composer-plus` absent, the reason said; the checks assert it | V1's gone block (Blocked.tsx, toolbar place) says it: V1's; chunk 1 confirms on a probe merge of ux-v1-1 |
| 8 | ended subagent's fold hides a live permission card | 4 `ux-x2-4` | **merged** (7fc3ace): `subagents/fold.ts` foldedWaiting; the waiting card stands under the fold row, the rest stays folded; L22 phone asserts it without pressing | `SubScreen` folds every item of an ended subagent, an undecided perm too: goal 3.5 violated → fix |
| 9 | second back from a dropped server's chat lands on Home | 4 | **merged**: `shell/phone/lastgroups.ts` withLastGroups (from Home's lastsync) in useStack/entriesNow; new phone check UX.X2-stack (fails on baseline). L22 R3.12 UX.F2 UX.X2 phone, L22 R3.12 UX.F2 tablet/desktop pass. Limit: needs Home/group to have drawn the server while connected | store drops the section's groups; stack finds no group. Small: use Home's lastsync groups for the stack |

## Baseline (bacf6a5, phone, /tmp/x2-0/dist)
- AAC.2-board, SEC.7-board, A6.3-board (phone) ok. AAC.2-localdown, SEC.7-drop, SEC.9, A6.3-markdown, A6.4, SEC.10 fail as in the table.

## Log
- Chunks 1–4 spawned (sonnet, high): sids 1 c22d3d694ed0, 2 11bc521a3258, 3 3b67e755858d, 4 029c7d4169bf.
- Chunks 3, 2, 4, 1 merged in that order. Merged ux-improvements 8878ec7 (B2): no conflicts.
- Post-merge (lead, 825c196): SEC.10 phone failed "deleted on its server: … / Needs your approval": chunk 1's headline let a gone chat show its
  state word; fixed (`headline` `gone`: no state word, the place line; test) and SEC.10's phone gone step expects the place line.
- Final DIST /tmp/x2-f/dist2. Phone: SEC.9 SEC.10 A6.3 A6.4 L22 UX.X2 R3.12 UX.F2 AAC.2-board SEC.7-board pass; AAC.2-localdown and
  SEC.7-drop fail only on V1's `composer-block` lines (offline block, Servers, gone line, "+" still drawn) until V1 merges. Tablet: SEC.7 A6.4
  AAC.2 pass. Desktop: A6.3 SEC.10 L22 pass. Units: root test (only the known conn time-out), check, web 99, desktop 172 pass.

## For V1 / R1
- V1: AAC.2-localdown and SEC.7-drop phone halves assert your `composer-block` (kind offline|gone, `block-servers` on offline only, no
  `composer-plus` when gone); they passed on a probe merge of ux-v1-1 0e91a2c. SEC.10's phone half still reads the empty box's
  `data-placeholder` as the warning (T3-5): with your "no placeholder while a block shows" it must read `composer-block` instead.
- R1: the stack's last groups need Home or a group screen to have drawn the server while connected (lastsync, memory only).
