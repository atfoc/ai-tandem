# X3 — the end-to-end scripts on the new phone screens (lead: Opus 5.5)

Worktree `.worktrees/ux-x3`, branch `ux-x3` (from `ux-improvements` 313e2be). No chunks: the lead made the edits.

| # | Item | State | Cause, fix |
|---|---|---|---|
| 1 | `VIEWPORT=phone remotechat` | **67 ok, 1 fail (= item 3)** | H2's New sheet (tiles `new-chat`/`new-board`, row `new-group`, no `action-row`); T3's Chat info → H2's Rename sheet for a chat's name; a new group opens the Rename sheet (closed, the group keeps its name); C2's chip sheets (folder sheet "Start the agent in · <server>", `dir-path` before `dir-input`; effort in the model sheet; a model with no effort leaves the sheet with no Done: closed by the backdrop); T2's card (`perm-who`, answered = `perm-folded` "Allowed · …"); C1's "+" › Files for the attach; V1's offline/gone `composer-block` in the toolbar's place (no Send); the phone's head names the server only in trouble; the thread is an inverted list (newest first, older drawn on scroll); a check reordered (Home's outline walk had left the chat). App: a removed entry stayed in `aiwb.home` and `aiwb.search.opened` (check 10): core `onEntryGone` (conn.ts) and the app's `forgetHomeServer` / `forgetOpenedOn` at bootstrap, tests in `app/test/forgetserver.test.ts` and core `conn.test.ts` |
| 2 | `reallibrary` | **75 ok** | its New chat pressed the old `action-row` (now H2's `new-chat` tile); then the phone's chat had V1's "No agent" block in the box's place: A runs the stand-in agent (fake-claude) |
| 3 | desktop `remotechat` check 50 (owner's Stop) | **predates** | `main` 4f49381 built in `.worktrees/x3-main` (removed): 87 ok, the same check 50 fails. Left as is; the phone half (check 30) is the same check |

## Runs (dist of ux-x3)
- `VIEWPORT=phone remotechat`: 67 ok, check 30 (item 3). Desktop `remotechat`: 87 ok, check 50 (item 3), as on `main`.
- `reallibrary`: exit 0 (75 ok). `newchat`: 21 checks pass. `twopages`: pass.
- Root `npm test`: one failure, conn "the real runner … a time-out" (15 s): fails alone and on the `ux-improvements` worktree too (not X3's). `npm run check` ok. `web` 99/99.
- uicheck phone SEC.9 SEC.2 UX.H1 UX.H2 UX.S2 ok. AAC.1 phone (its "+ New" half reads the old rows: H2's sheet) and SEC.3 phone ("a long press on a chip opened no server sheet") fail; not touched by X3, left to their owners.
