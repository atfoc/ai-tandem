# Where the unit tests of `web/test` went, and what proves them on the new build

Written by package `rn-sw-webtest` of the integration sweep. R1 (architecture §11) deletes `web/src` and "the old page's `web/test` leftovers". `web/test`
held 891 unit tests in 40 files (`cd web && npm test`). Some test only `@aiwb/core` (`packages/core/src`) and must outlive R1; others bundle or read
the old page's own files (`web/test/fixtures/bundle.ts`: `webSrc`, `sourceOf`, esbuild of `web/src` components) and prove the old page, not the new build.
This file says, **for each test**, which it is, where it is now, and what proves it on the new build; the tables are at the end.

## How a test was classified

A test (not a file) is read statement by statement. A statement is of the old page when it reads a file of `web/src` or `web/index.html`
(`sourceOf("Composer.tsx")`, `readFileSync(new URL("../src/…"))`), or uses what the test's esbuild bundle takes from `web/src` (`Sidebar.tsx`,
`ChatView.tsx`, `Servers.tsx`, `Library.tsx`, `board.ts`…), or a helper made of those. Then:

- **a — core only**: no statement is of the old page. The test moved to `packages/core/test/` with its name unchanged (`git mv` for a whole file, so that
  history follows). `cd packages/core && npm test` runs it; `cd web && npm test` no longer does.
- **b — old page**: nothing of the test can be kept without the old page. It stays in `web/test` (it keeps proving the old page until R1), and the table
  says what proves the same on the new build: a check of `web/dev/checks-app` as `ID@viewports` (`d` desktop, `t` tablet, `p` phone), a unit test of
  `app/test`, `packages/core/test`…, or a proof written in this package (marked **added**).
- **c — mixed**: the test has statements of both kinds and the core ones stand alone. It was **split**: `packages/core/test/<same file>` has the test
  (same name) with the statements that need nothing of the old page; `web/test/<same file>` keeps the test (same name) with the old page's statements and the
  set-up they need. The table gives both halves. A test whose core assertions only make sense after a step that is the old page's (a render, `side.select`,
  `ui.openLibrary()`) is **b**, whole: splitting it would have changed what it asserts.

Nothing a test asserts was changed: moved and split tests differ from the originals only in import paths, in the esbuild bundle's header (`coreSrc` in
place of `web/src`, the kv port from `packages/core/test/fixtures/kv.ts`), and in the statements that went to the other half. Special cases, found by
reading, not by the file's name:

- `Servers.tsx` only re-exports `answered`, `listed` and `openServers` of core's `state/serversdialog.ts`, and `Composer.tsx` `draftToShow` of
  `state/chatdraft.ts`: the tests that use those alone are core's.
- Tests that scan every file of the page (`sectiongone`, `sectionstorage`, `transport`'s "nothing reaches the network") are **c**: the core copy scans
  `packages/core/src` alone, the old copy scans both; the new build's whole is scanned by `app/test/gone.test.ts` and `app/test/storagescan.test.ts`
  (added) and, for the network, `app/test/noplainhttp.test.ts`.
- `saves.test.ts` (90 tests) bundles the old page's `board.ts` and `apply.ts`: all **b**. Sixty-seven of them were already ported to
  `packages/core/test/board/` under the same name; the rest were ported under another name (the table gives it), and five of those have their drawing part in
  `packages/board-view/test/export.test.ts` (added).

## Result

| file | tests | core only (a) | old page (b) | mixed (c) |
|---|---|---|---|---|
| `actions.test.ts` | 70 | 69 | 0 | 1 |
| `boardrow.test.ts` | 8 | 6 | 1 | 1 |
| `boardsave.test.ts` | 11 | 8 | 1 | 2 |
| `canvastheme.test.ts` | 5 | 4 | 0 | 1 |
| `chatchoices.test.ts` | 10 | 1 | 2 | 7 |
| `chatimage.test.ts` | 27 | 25 | 2 | 0 |
| `chatserver.test.ts` | 17 | 4 | 2 | 11 |
| `conn.test.ts` | 83 | 83 | 0 | 0 |
| `drafts.test.ts` | 88 | 86 | 1 | 1 |
| `draftsback.test.ts` | 6 | 5 | 0 | 1 |
| `dropmark.test.ts` | 19 | 18 | 0 | 1 |
| `flavours.test.ts` | 8 | 6 | 1 | 1 |
| `folderagents.test.ts` | 10 | 9 | 0 | 1 |
| `insert.test.ts` | 16 | 14 | 2 | 0 |
| `keptpage.test.ts` | 27 | 26 | 0 | 1 |
| `librarypopups.test.ts` | 10 | 2 | 8 | 0 |
| `newchat.test.ts` | 10 | 8 | 2 | 0 |
| `newchatwhere.test.ts` | 13 | 12 | 0 | 1 |
| `remotechat.test.ts` | 18 | 8 | 0 | 10 |
| `remoteview.test.ts` | 11 | 8 | 1 | 2 |
| `restart.test.ts` | 8 | 8 | 0 | 0 |
| `roles.test.ts` | 25 | 22 | 3 | 0 |
| `saves.test.ts` | 90 | 0 | 90 | 0 |
| `sectioncalls.test.ts` | 17 | 1 | 15 | 1 |
| `sectiongone.test.ts` | 4 | 1 | 1 | 2 |
| `sections.test.ts` | 35 | 35 | 0 | 0 |
| `sectionstorage.test.ts` | 4 | 0 | 0 | 4 |
| `sectionstore.test.ts` | 25 | 25 | 0 | 0 |
| `sectionviews.test.ts` | 25 | 2 | 13 | 10 |
| `sendend.test.ts` | 6 | 3 | 2 | 1 |
| `serverlists.test.ts` | 14 | 13 | 1 | 0 |
| `servers.test.ts` | 22 | 21 | 1 | 0 |
| `serversdialog.test.ts` | 25 | 4 | 18 | 3 |
| `sidebar.test.ts` | 29 | 0 | 25 | 4 |
| `status.test.ts` | 12 | 11 | 1 | 0 |
| `theme.test.ts` | 5 | 4 | 1 | 0 |
| `transport.test.ts` | 21 | 20 | 0 | 1 |
| `tree.test.ts` | 20 | 19 | 1 | 0 |
| `version.test.ts` | 6 | 6 | 0 | 0 |
| `waitflows.test.ts` | 31 | 31 | 0 | 0 |
| **40 files** | **891** | **628** | **195** | **68** |

Counting in the old numbers: 628 tests moved to `packages/core/test/`; 195 stay in `web/test` only; 68 are in both (their two halves). After the
split `packages/core` runs 1,542 tests (845 before), `web/test` 263 tests in 34 files (a and part of c left it). Of the 195 (b) + 68 (c) tests with an old-page half,
**41 needed a proof written in this package** (marked **added** in the tables, listed below), and 67 are proved, in the part that reads
source, by `app/test/wiring.test.ts`.

## What was written to prove the old page's tests on the new build

New tests and assertions (each says in its first comment what it ports):

| Where | What | Ports |
|---|---|---|
| `app/test/wiring.test.ts` (66 tests, the old tests' names) | the wiring of the composer, the chat view, the board's banner, the sidebar's calls and the Servers dialog, read in the new build's files, as the old page's tests read it in `web/src`. What the old tests read of the page's DOM (class names, `window` listeners, `contentEditable`) has no counterpart and is shown by the checks named in the tables | the source-reading half of `chatchoices`, `chatserver`, `remotechat`, `chatimage`, `drafts`, `draftsback`, `sendend`, `roles`, `newchat`, `tree`, `remoteview`, `servers`, `status`, `boardrow`, `boardsave`, `serverlists`, `keptpage`, `newchatwhere`, `actions`, `folderagents`, `sectioncalls`, `serversdialog` |
| `app/test/sidebar.calls.test.ts` (12) | a group renamed or moved ahead of its server is put back when the call is refused (all six refusals), the late refusal, two changes, a change that worked, nothing across servers, a chat's rename refused is said. `screens/sidebar/actions.ts` bundled with esbuild over a stub api; no browser check could show it (the mock refuses no rename) | `sectioncalls` |
| `app/test/gone.test.ts` (3), `app/test/storagescan.test.ts` (4) | what went away is in no file of the new build; what the build writes into storage, key by key, and by what | `sectiongone`, `sectionstorage` |
| `app/test/library.open.test.ts` (2) | `openLibrary` and `openInsert`: under a dialog nothing opens, a second box takes the popup from the first. (`screens/library/popups.ts` holds the two, apart from the keys and the platform, so that Node can load them) | `librarypopups` |
| `app/test/export-web.test.ts`, `app/test/tokens.test.ts` (one test each) | the theme script sets what `logic/theme.ts` sets for every saved value and for a storage that throws; the board's plain-dark ground and ink are the dark tokens' `bg` and `text` | `theme`, `canvastheme` |
| `packages/board-view/test/export.test.ts` (4) | `get_image`'s drawing part on the view's side: the fonts are waited for (also when their promise rejects), the padding, the limit on the size Excalidraw measures, `RENDER_FAILED`, `EMPTY` | `saves` (get_image) |
| `SEC.2` | a server whose every thing is archived says "Only archived things on this server."; Show archived shows the row | `sidebar` |
| `SEC.7` (board) | a board never read, its server away: the view in the canvas's place, with Servers…; back it opens; deleted there: "No longer on …" | `sectionviews` |
| `SEC.7` (chat) | the snapshot of the app's own stream comes again while the server is away: the chat stays, nothing is asked of that server | `sectionviews` |
| `SEC.10` | an archived chat shown as it was has no Unarchive and says why | `sectionviews` |
| `L7` | the words of a test of another server come out as text; a restart that fails; the section leaves the sidebar with its entry | `serversdialog`, `sidebar`, `sectionviews` |
| `L10` | a chat the server answers 404 `not_found` for: "no longer on …" in the thread's place, no Servers…, no Try again (the mock gives that answer the code `not_found`) | `sectionviews` |
| `L16` | the folder of a chat that has not started, changed from elsewhere, is the composer's at once | `sectionviews` |

Small changes in `app/src` that the tests needed: `screens/shell/confirm.ts` (the three dialog functions `nav.ts` re-exports) and `screens/library/popups.ts`
(`openLibrary`, `openInsert`), moved out of files that Node cannot load. No behaviour changed.

## What stays in `web/test` until R1, and what R1 does

`web/test` keeps 34 files, 263 tests: the 195 **b** tests and the old halves of the 68 **c** tests. At R1 every one of them is deleted with the page; each has
its proof in the tables. `web/test/fixtures/bundle.ts` goes with them. `web/package.json`'s `test` script then runs the `dev/` tests alone.
`packages/core/test/fixtures/bundle.ts` (`coreSrc`, `alias`, `inSrc`, `kvFile`, a `sourceOf` that reads core) and `fixtures/kv.ts` are what the bundling
tests of core need; `packages/core` has `esbuild` as a devDependency now (it is in the root lock already, through `board-view`).

## For the sweep to write

- **README of `checks-app`**: `SEC.2`: + "a server whose every thing is archived says so, and Show archived"; `SEC.7`: + "a board never read while its server is away" and "a snapshot
  while a section has no tree"; `SEC.10`: + "an archived chat shown as it was"; `L7`: + "what a test found out comes out as text", "a restart that fails", "the section leaves with its entry";
  `L10`: + "a chat the server does not have"; `L16`: + "a chat's folder changed from elsewhere". Each check's first comment says so.
- **AD-81**: core: "the tests of `web/test` that need nothing of the old page (628 tests) and the halves of the 68 that mix; `board/` tests on a fake channel"; app: + `wiring`,
  `gone`, `storagescan`, `sidebar.calls`, `library.open`. Old page: "until R1; then no `web/test`".
- **Parity report** (rows whose proof this package changed): A-SC-08 (`SEC.2`), A-ST-08 (`SEC.7` board), C-RO-07 (`SEC.10`), A-SB-39 and A-DD-12
  (`app/test/sidebar.calls.test.ts`, not "by code, unasserted"), A-SC-20 (`L7`: the section leaves the sidebar), A-ST-20 (`SEC.7` chat: the snapshot while away), B-RO-07 (`L10`: not_found),
  C-IM-22 and the other rows of `remotechat.test.ts` / `chatserver.test.ts` / `chatchoices.test.ts` that cite those tests (`app/test/wiring.test.ts`, same names), A-TH-08 (`app/test/export-web.test.ts`),
  D-CT-05 (`app/test/tokens.test.ts`), A-SG-01 (`app/test/storagescan.test.ts`), A-SV-24 (`L7`).

## Findings

- **Left unshown** (one test): "the composer of a chat shown as it was opens no prompt to insert, and a subagent whose thread the page does not have says why in place of loading":
  the Insert button off is shown (`SEC.10`) and the subagent chip fixed with the reason (`L19`), but nothing shows the drawer of a subagent saying why in place of "Loading…" while the server
  is away. `screens/subagents/Drawer.tsx` reads `useOffWhy`; a check needs a seeded drawer on a chat whose server drops.
- **A difference by decision**: the old composer's images asked nothing of the chat's server (`ComposerImages.tsx`, `ImageThumb.tsx`, `MessageImages.tsx` have no `serverOf`); the new strip and
  message name the thumbnail's server and chat (`ImageThumb server={…} chat={…}`), because a picture's address is the transport's `picture(server, chat, image)` (package C6). The images of a
  section's chat are shown by `R3.12-images`; `app/test/wiring.test.ts` asserts the files that hold a draft's images (`state/uploads.ts`, `chatdraft.ts`, `logic/messageimages.ts`, `logic/drafts.ts`) ask nothing.
- **Not ported because there is no counterpart**: the old tests' assertions about DOM listeners (`dropmark`: `WINDOW_EVENTS`, `window.addEventListener`; `insert`: the box's `onKeyDown`/`addEventListener`;
  `roles`: `className="side-row is-board…" onClick`). The behaviours are shown by `A3.2`/`A3.3`/`L14`/`SEC.3`/`SEC.5` and `app/test/dragdrop.test.ts` (the drag), `PL5.1`/`PL5.2` (⌘P), and
  `app/test/wiring.test.ts` "only the board's own row…" (the call with `true`).
- The mock gave no code to `flags.items = { fail: 404 }`; it now answers `not_found` (an additive change of `web/dev/mock.mjs`; the old `A4.4` that uses `flags.items` was run again and passes).

## Reading the tables

One section per file of `web/test`, in the file's order. **kind** is a, b or c as above. A check is `ID@viewports`; `packages/core/test/x.test.ts "name"` and `app/test/…` are unit tests (a name cut with
"…" is a prefix); **(added)** marks a proof written by this package; "same name" is the test of that name in the file named. **rows** are the rows of `parity-inventory.md` whose "Covered today by" names the
test (a test no row names has "—").


### actions.test.ts

70 tests: 69 core only, 0 old page, 1 mixed.

| old test (`actions.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "viewBranch: the chat is on the branch here; one fetch the first time, and nothing is sent" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-20 |
| "viewBranch: each branch's composer keeps its own draft across views; only the drafts are saved" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-20, C-DR-02 |
| "viewBranch: a failed fetch puts the chat back on the branch it was on, and tells of it" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-20 |
| "viewBranch: a pending move is undone first, as Back" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-10 |
| "viewBranch: nothing while a move is being sent" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-20 |
| "startMove: the end of a branch that is there is looked at, with no move; every other point is a move to a new branch" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-07 |
| "startMove: a branch whose list cannot be read is not gone to" | a | `packages/core/test/actions.test.ts` (same name) | B-TR-22 |
| "a move started while the source runs stays valid, through the turn and after it" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-11 |
| "a move from a running source: the last finished boundary is taken, a point inside the running turn is not" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "another branch at work does not keep a move from starting, nor drop one" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "refreshChat: `cap` keeps the move, whatever the source does" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "refreshChat: `busy` keeps the move while the source shown is busy, and drops it when that branch is at rest" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "refreshChat: a refusal without a code, or with another one, keeps the move though the source is at rest" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a 409 without a code on a move's Send keeps the move, and the next Send goes to the same point" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-13 |
| "refreshChat without a move: the list of the branch the chat is on is read again, not the current one's" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "Send: a chat of a section names its branch from its first message on, as a chat of this computer does, and is posted under its key" | a | `packages/core/test/actions.test.ts` (same name) | C-NC-09 |
| "a section's chat with the id of a chat of this computer: each composer has its own draft, and the unsaved copy of the section's is in the page's memory, never in the browser's storage" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-06 |
| "text typed in a section's chat whose server dropped is in its open composer alone: left, the chat goes with it, and nothing of it is there when the server is back" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-14 |
| "Send without a move goes to the branch the chat is on, whatever the server's current one is" | a | `packages/core/test/actions.test.ts` (same name) | C-TX-14 |
| "a sent move ends on the POST's answer and the chat is on the answer's branch: the answer first" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-07 |
| "a sent move ends on the POST's answer and the chat is on the answer's branch: the `chat` event first" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-07 |
| "a sent move whose answer names no branch (an older server) ends when the view names another current branch" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "after a sent move, plain Branch: the message was the draft of the branch left, which has none then" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-17 |
| "after a sent move, Branch and edit: the branch left keeps the draft that was put aside, whole" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-17 |
| "after a sent move, what was typed after the Send is the new branch's draft" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "after a sent move whose composer went away: the drafts of both branches are written from outside" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-17 |
| "a draft set from outside whose save failed: kept for the branch's next composer, and not written back over a newer one" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-19 |
| "a snapshot drops a pending move that is not being sent, as Back" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-11 |
| "a snapshot while a move is being sent keeps the move: the branch left keeps the draft that was put aside" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-11 |
| "a snapshot without the chat of a move being sent drops the move; the chat on screen stays, gone" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a failed Send of a move, its composer open: the move stays and the composer has the message again" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-13 |
| "a failed Send of a move, another branch's composer open: the message stays with the move, that branch's draft is not touched" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a failed Send of a move, no composer open: the message stays with the move and comes back with the composer" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a failed Send without a move, after the chat was put on another branch: the message is its own branch's draft again" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-19 |
| "a pending move is the business of the composer of the branch it was started on only" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-18 |
| "setMoveChoice: sets, replaces and clears the move's model and effort; the source's own choice is none" | a | `packages/core/test/actions.test.ts` (same name) | C-CH-15 |
| "setMoveChoice: a model picked alone holds the effort the server gives it from the source's" | a | `packages/core/test/actions.test.ts` (same name) | C-CH-15 |
| "a pending move shows the choice the server makes of what is posted, after any three picks" | a | `packages/core/test/actions.test.ts` (same name) | C-CH-15 |
| "a move's choice goes in the posted target, and is not in it when none was made" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a move's choice is kept after a Send refused with `window`, and goes with the next Send" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a move's choice is kept after a Send refused with `cap`, and goes with the next Send" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a move's choice is gone after Back: the next move starts on the source's" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "a move's choice is carried to a new move on the same branch only" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "the unsaved copy records the draft counter it was typed on; a composer opens with it only on the server's counter" | a | `packages/core/test/actions.test.ts` (same name) | C-DR-05 |
| "a file that passes is uploaded at once: its thumbnail is busy, Send waits, and the image is in the draft when the server has answered" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-10 |
| "the page closes during an upload: the draft that is saved, and the copy the browser keeps, are without the image" | c | core half: `packages/core/test/actions.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: the composer's hide saves what it holds, images included only once answered); IM3.2-images@d,t,p (a reload with the draft's images); packages/core/test/actions.test.ts (same name) | C-IM-18 |
| "images alone are a draft and a message: the draft is saved, the chat says it has one, and Send takes it" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-13 |
| "every file goes through the one check: what fails is not uploaded, and the error line says why, naming it" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-09 |
| "an upload that fails, or is cut, shows the error and leaves the strip: it is not tried again, and no image is added" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-15 |
| "an upload taken out of the strip is cut: nothing is added and nothing is said" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-14 |
| "the same picture uploaded twice is one image" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-12 |
| "a model without image input: a pasted image is refused with a line that names the model, and nothing is uploaded" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-19 |
| "an upload outlives its composer: answered with the composer open again, the image goes into that composer" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-16 |
| "an upload outlives its composer: answered with no composer of the branch open, the image goes into the branch's draft" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "an upload outlives its composer: the chat is on another of its branches, and the image goes into the draft of the branch it was added on" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "an upload outlives its composer: what was typed meanwhile is kept, also when its save is still on its way" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "an upload outlives its composer: a draft typed in another window meanwhile is not overwritten, the image is added to it" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "an upload outlives its composer under a pending move: the image is in what the composer left, and comes back with it" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "an upload whose chat is gone when it is answered adds nothing; one whose composer is gone tells of a failure in a dialog" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-16 |
| "Branch and edit and Back are not started while the chat's composer uploads, and are again once the upload is answered" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-02, C-IM-17 |
| "a move that has to go is dropped also while the composer uploads, and the image goes into what the composer then holds" | a | `packages/core/test/actions.test.ts` (same name) | — |
| "Branch and edit brings the message's images back with its text; Back gives the composer its own again" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-08, C-IM-28 |
| "Branch and edit of a message of images alone puts the images, and Send takes them" | a | `packages/core/test/actions.test.ts` (same name) | B-FK-08, C-IM-28 |
| "after a sent Branch and edit the branch left keeps the draft put aside with its images, and images added after the Send are the new branch's" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-28 |
| "a sent move that did not move joins the two drafts with the images of both, past what one message takes, and drops nothing" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-20 |
| "a failed Send after its composer went away: the images are the branch's draft again with the text, or go into the composer opened since" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-27 |
| "a draft's save that names an image the chat no longer holds: the image leaves the strip, and the line says what to add again" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-26 |
| "the same for a draft the browser kept unsaved, and for one set from outside a composer" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-26 |
| "a refused Send that names images the chat no longer holds: they leave what the composer holds" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-26 |
| "the thumbnail kept of an uploaded picture is its own chat's: the same picture in the chat of the same id on this computer and in a section" | a | `packages/core/test/actions.test.ts` (same name) | C-IM-11 |

### boardrow.test.ts

8 tests: 6 core only, 1 old page, 1 mixed.

| old test (`boardrow.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "boardMenu: a board of this computer has today's items in today's order" | a | `packages/core/test/boardrow.test.ts` (same name) | A-SB-25 |
| "boardMenu: a board of a section is renamed, moved, archived and deleted, never revealed" | a | `packages/core/test/boardrow.test.ts` (same name) | A-SB-25 |
| "the texts of the row's menu: no item removes a board from this sidebar only" | a | `packages/core/test/boardrow.test.ts` (same name) | — |
| "boardDeleteBody: the question before a board is deleted; a section's is removed on its server, for everyone who uses it" | c | core half: `packages/core/test/boardrow.test.ts` (same name); old-page half: SEC.5@d,t,p (the question before a delete names the server of a section); app/test/wiring.test.ts "boardDeleteBody: …" (the sidebar's deleteBoard gives boardDeleteBody and runs stopAll, flush, deleteBoard) | A-SB-28 |
| "a chat on a board of a section names that server and says why it is fixed" | a | `packages/core/test/boardrow.test.ts` (same name) | — |
| "moveTargets: the ungrouped area and every group that is not archived, never where the board is" | a | `packages/core/test/boardrow.test.ts` (same name) | A-SB-26 |
| "moveTargets: a board of a section stays on its server: the ungrouped area offered is that server's own" | a | `packages/core/test/boardrow.test.ts` (same name) | A-SB-26 |
| "the sidebar's board row: the menu by the board's key, the targets from the groups of the board's own server, and no server after the name" | b | SEC.5@d,t,p (a board's "Move to…" lists the groups of its own section and nothing else); SEC.1@d,t,p (no row of a section names its server); app/test/wiring.test.ts "the sidebar's board row: …" | — |

### boardsave.test.ts

11 tests: 8 core only, 1 old page, 2 mixed.

| old test (`boardsave.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "saveFailure: only a refusal drops the edit" | a | `packages/core/test/boardsave.test.ts` (same name) | — |
| "saveOutage: a 503 and a 504 of a board raise the banner, this computer's included, nothing else does" | a | `packages/core/test/boardsave.test.ts` (same name) | — |
| "a save answered 503 not_held_there (the board is being taken again on its server) is 'not yet': the edit is kept under the banner, which does not say that the server is unreachable" | c | core half: `packages/core/test/boardsave.test.ts` (same name); old-page half: packages/core/test/boardsave.test.ts (same name: the logic); packages/core/test/board/outage.test.ts "a save answered 503 keeps the edit and sets the outage, for either code"; SEC.7-board@d,t,p (the banner "Not saved, Studio Mac unreachable" and the saves at the same revision); app/test/wiring.test.ts (same name: the banner reads whether the server is connected from the tree; held and superseded call onGrant and onLost) | — |
| "a save of a board that is refused for another reason than an outage (413 too_large, 502 bad_answer): the edit is kept, and the canvas says the server's sentence" | c | core half: `packages/core/test/boardsave.test.ts` (same name); old-page half: packages/core/test/boardsave.test.ts (same name); L5-board-roles@d,t,p / b4 notes: a drawing over its limit; app/test/wiring.test.ts (same name: setSaveSaid with saveRefusal, and the banner shows what was said) | D-SV-07 |
| "the banner and the notice" | a | `packages/core/test/boardsave.test.ts` (same name) | D-SV-07 |
| "boardView: a board of this computer is judged as any other" | a | `packages/core/test/boardsave.test.ts` (same name) | — |
| "boardView: a board of a section" | a | `packages/core/test/boardsave.test.ts` (same name) | D-RB-02 |
| "the canvas reads the three from the board's key, the section's tree and the page's mark" | b | SEC.7-board@d,t,p (added: the view in the canvas's place for a board never read, its server away, and for one deleted there); AAC.2-board@d,t,p; app/test/wiring.test.ts (same name: BoardCanvas gives boardView the connection, the mark and whether a scene is kept) | D-RB-02 |
| "the view in place of the canvas" | a | `packages/core/test/boardsave.test.ts` (same name) | D-RB-02 |
| "takeoverText: a local board, and a board of a section, which another computer that uses that server may hold" | a | `packages/core/test/boardsave.test.ts` (same name) | D-TK-01, D-TK-02 |
| "serverNameOf: the name of the entry the board's key names" | a | `packages/core/test/boardsave.test.ts` (same name) | — |

### canvastheme.test.ts

5 tests: 4 core only, 0 old page, 1 mixed.

| old test (`canvastheme.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "canvasThemeOf: plain light has no filter, the others have theirs" | a | `packages/core/test/canvastheme.test.ts` (same name) | D-CT-05 |
| "plain dark's ground and ink are the --bg and --text of styles.css's dark theme" | c | core half: `packages/core/test/canvastheme.test.ts` (same name); old-page half: app/test/tokens.test.ts "plain dark's ground and ink are the bg and text of the dark theme's tokens" (added); packages/core/test/canvastheme.test.ts (same name: the core half) | D-CT-05 |
| "a filter: 20 matrix numbers, three tables of 256 that never fall, a unique id" | a | `packages/core/test/canvastheme.test.ts` (same name) | D-CT-05 |
| "every theme shows the stored white as its ground and the stored #1e1e1e as its ink" | a | `packages/core/test/canvastheme.test.ts` (same name) | D-CT-04 |
| "the dark themes' first stage is Excalidraw's invert(93%) hue-rotate(180deg), by the spec's formulas" | a | `packages/core/test/canvastheme.test.ts` (same name) | D-CT-05 |

### chatchoices.test.ts

10 tests: 1 core only, 2 old page, 7 mixed.

| old test (`chatchoices.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the toolbar has the server's name, then agent, folder, model, effort, in this order" | b | A2.3-places@d,t,p / P0.6-widths@d,t,p (the controls of each state of the fixture in their places: server, agent, folder, model, effort); app/test/wiring.test.ts (same name) | C-CH-01 |
| "the server picker is gone from the toolbar: the server is a chip that opens nothing and sends nothing" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: A2.4-popups@d,t,p (the lists the toolbar opens: agent, folder, model, effort; none for the server); SEC.7-drop@d,t,p (the server chip is fixed); app/test/wiring.test.ts (same name); a disabled option takes no pick: the wiring test below (the picker's `if (!o \|\| o.disabled) return;` and its note as the reason) | C-CH-02 |
| "an agent pick sends the agent alone and takes the chat the server answers with" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: A2.3-places@d,t,p ("an agent pick in the popup: saved, the focus on its chip": PATCH with the agent alone); packages/core/test/chatchoices.test.ts (same name: pickAgent over the fake transport); app/test/wiring.test.ts (same name) | C-CH-03 |
| "an agent pick the server refuses takes nothing, and an older server's answer without the chat neither" | a | `packages/core/test/chatchoices.test.ts` (same name) | C-CH-03, C-CH-22 |
| "the agent choice is in the toolbar only while agentOpen and the chat takes a change; the server's name only for a chat of a section, started or not" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: A2.3-places@d,t,p / P0.6-widths (the agent chip in a new chat, none in a started one); P0.3-smoke@d,t,p (A2.plain-new, A2.plain-started); app/test/wiring.test.ts (same name) | C-CH-03 |
| "each choice is drawn once, in the toolbar's row or in its popup, and the reason line is the row's own" | b | A2.3-places@d,t,p (every choice of a state is a chip in the toolbar or in the open popup, and never in both; the reason line is a line of the row under its controls, also while the chip is in the popup); app/test/wiring.test.ts (same name) | — |
| "the agent choice offers the usable agents alone; one the server lacks is marked and its line says why" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: P0.3-smoke@d,t,p (A2.plain-noagent-installed: "No agent is installed on Bare box", tone missing); app/test/wiring.test.ts (same name); packages/core/test/chatchoices.test.ts (same name: agentChoice, agentLine) | C-CH-03, C-CH-04 |
| "a chat with no agent shows the reason, and its Send is blocked with the reason as its title" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: P0.3-smoke@d,t,p (A2.plain-noagent: "Choose an agent"); SEC.7-drop@d,t,p (Send's title is the reason); app/test/wiring.test.ts (same name); packages/core/test/chatchoices.test.ts (same name: composerControls, sendTitle) | C-TX-11, C-CH-05 |
| "a Send refused for the agent keeps the typed text: the chat is not read again" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: L16-composer@d,t,p (a Send that is refused puts its text back into the box and says why under the composer; `cap` does not read the chat again, C-CH-06); app/test/wiring.test.ts (same name) | C-CH-06, C-RO-13 |
| "a chat with no agent: its header and its empty thread name no agent, say why, and offer nothing to send" | c | core half: `packages/core/test/chatchoices.test.ts` (same name); old-page half: P0.3-smoke@d,t,p (A2.plain-noagent: the empty reason, no suggestion); L10@d,t,p (the header, the empty thread); app/test/wiring.test.ts (same name) | C-CH-05, C-NC-11 |

### chatimage.test.ts

27 tests: 25 core only, 2 old page, 0 mixed.

| old test (`chatimage.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "paste: image files alone are added, and the paste is theirs" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-03 |
| "paste: a file copied in a file manager comes with its name as plain text and no rich text, and is an image to add" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-05 |
| "paste: with plain text and rich text the text wins (a copied spreadsheet cell), and nothing is added" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-04 |
| "paste: rich text without plain text does not win (a picture copied from a web page comes with its HTML)" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-06 |
| "paste: files that are not pictures are left out, and a paste of only such files goes on as it always did" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-06 |
| "paste: a picture of a type a chat does not take is still the paste's, so that the check can say why it is not added" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-06 |
| "the name of a pasted picture is the fixed one; a file's own name stays" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-07 |
| "the limits and the types are the ones the server has (model.go)" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-08 |
| "the type a file is uploaded as: its own when a chat takes it, its name's ending when it says none" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-08 |
| "check: a file that passes is taken; one of another type or over the size is not, with why" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-08 |
| "check: the count of the message, with the images it has and the uploads that run" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-08 |
| "check: the total of the message; a file that is refused takes no room from the ones after it" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-08 |
| "check: a chat that takes no image now takes none, whatever the file" | a | `packages/core/test/chatimage.test.ts` (same name) | — |
| "why a chat's composer takes no image now: its server is not connected, or the model takes none" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-19 |
| "the error line says why each file was not added, naming it, one sentence per reason" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-09, D-DW-11 |
| "an upload that failed and an image that is no longer there each have their line" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-15 |
| "a list of images has each once, by its id; an image is named by its four fields" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-12 |
| "the address of an image is the transport's address of a picture: this computer's server, the chat's own id, the image" | a | `packages/core/test/chatimage.test.ts` (same name) | B-IM-01, D-PC-01 |
| "imageAddress() is the transport's picture() for the chat's server, the chat's own id and the image, the same address imageUrl() gives, and the signal is passed on" | a | `packages/core/test/chatimage.test.ts` (same name) | — |
| "imageUrl() on a transport with no synchronous address says to use imageAddress()" | a | `packages/core/test/chatimage.test.ts` (same name) | — |
| "the address of an image of a section's chat is for that entry, with the chat's own id there" | a | `packages/core/test/chatimage.test.ts` (same name) | B-IM-01, D-PC-01 |
| "over the limit: a message of more images than one takes, or of more bytes together, cannot be sent, and says what to do" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-20 |
| "what holds a composer's Send for its images: an upload that runs, a model that takes none, a message over the limit" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-19 |
| "what the desktop app's dialog returns goes through the check as any file, and the files it left out are named" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-02, D-DW-09 |
| "a cancelled dialog, and an answer of another shape, give nothing" | a | `packages/core/test/chatimage.test.ts` (same name) | C-IM-02, D-DW-10 |
| "a chat's composer takes pasted images and has the attach button" | b | IM3.2-images@d,t,p (the attach button and the file chooser, a paste, the strip; a paste and the button go through one check); R3.12-images@d,t,p; app/test/wiring.test.ts (same name) | — |
| "the composer's Send: enabled with images alone, held by imagesHold, and the images go out with the message and back when it fails" | b | IM3.2-images@d,t,p (Send while an upload runs, a message of an image alone); IM3.5-message@d,t,p; L18-imagelimits@d,t,p (a draft over the limit holds Send; a model with no images); app/test/wiring.test.ts (same name) | C-TX-05 |

### chatserver.test.ts

17 tests: 4 core only, 2 old page, 11 mixed.

| old test (`chatserver.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "every message names its branch, the first one of a section's chat too" | a | `packages/core/test/chatserver.test.ts` (same name) | — |
| "the composer's Where is the chat's server, its name and whether it is connected" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: SEC.7-drop@d,t,p / AAC.2-localdown@d,t,p (a section's chat: the server's name in the header, its connection judged by that server); app/test/wiring.test.ts (same name) | — |
| "on this computer the texts are the ones from before" | a | `packages/core/test/chatserver.test.ts` (same name) | C-CH-07 |
| "on another server the not installed and no agent texts name the server" | a | `packages/core/test/chatserver.test.ts` (same name) | C-CH-07 |
| "a server that is not connected: no agent is offered, the line says why, and Send is off with that title" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: SEC.7-drop@d,t,p, AAC.2-localdown@d,t,p (Send off with the reason as its title, the line under the toolbar, every choice a fixed chip, the box read-only, no call); SEC.10@d,t,p (no Stop); app/test/wiring.test.ts (same name) | B-RO-12, C-CH-07 |
| "a started chat's Send is off too while its server is not connected: the view is read-only as it was" | a | `packages/core/test/chatserver.test.ts` (same name) | C-TX-10, C-RO-02 |
| "a chat of a section before its first message is a chat like any other: no line of its own, its agent open, its Send by the connection" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: R3.12-images@d,t,p (an unstarted chat of a section takes an image at once); L16-composer@d,t,p (the text stays in the box after a failed Send); app/test/wiring.test.ts (same name) | C-CH-05 |
| "a path is shortened with the home of the chat's server" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: L10@d,t,p (the header's line "~/projects/shop"); A2.4-popups@d,t,p (the folder's browser); app/test/wiring.test.ts (same name) | B-HD-01, C-CH-08 |
| "the folder picker reads the chat's server, is titled by it and starts at its default folder" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: A2.3-places@d,t,p, L16-composer@d,t,p (the folder's browser lists /api/dirs of the chat's server and starts at its folder); app/test/wiring.test.ts (same name) | C-CH-08, C-CH-09 |
| "recent folders are kept per server: this computer's in the browser, a section's in the page's memory alone" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: screens/composer/recent.ts keeps this computer's under the one key and a section's in memory); app/test/storagescan.test.ts (added) "the two keys that hold content are written for this computer's things alone" | C-CH-11 |
| "plan usage asks the chat's server, is kept by server and agent, and is titled by the server" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: L12-usage@d,t,p ("Plan usage on <Server>", Pi has none, the plan asked of the chat's server); app/test/wiring.test.ts (same name) | B-US-08, B-US-11 |
| "emptyReason: what an empty thread says of a chat that takes no message, by its server (F1, F12)" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: P0.3-smoke@d,t,p (A2.plain-off-new, A2.plain-noagent*); SEC.7-drop@d,t,p; app/test/wiring.test.ts (same name); packages/core/test/chatserver.test.ts (same name) | B-TH-16 |
| "the chat header shortens the folder with the home of the chat's server (F2)" | b | L10@d,t,p (the header says "~/projects/shop"); app/test/wiring.test.ts (same name) | B-HD-01 |
| "a refusal's sentence under the composer goes when the server is connected again, and with the chat's start and choices (F3, F4)" | b | L16-composer@d,t,p (a refused Send says why under the composer, C-RO-09); SEC.7-drop@d,t,p (back: the line is gone); app/test/wiring.test.ts (same name) | C-CH-22, C-RO-10 |
| "sendingLine: the line of a fork's or a branch's first message on its way to another server" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: A4.2-shows@d,t,p, A4.3-held@d,t,p (the lines at the foot of a thread for a fork or a branch send); app/test/wiring.test.ts (same name) | B-TH-09 |
| "offWhy: why a chat takes no call, which every control of its view that is off says" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: SEC.10@d,t,p (every control of the view is off and says why: message actions, the header's branch, Back, the tree, a permission request); app/test/wiring.test.ts (same name) | B-RO-12, C-RO-02 |
| "a chat its server no longer has takes no Send and no change, and the Send, the box and the toolbar's line say so" | c | core half: `packages/core/test/chatserver.test.ts` (same name); old-page half: SEC.10@d,t,p, SEC.7-drop@d,t,p (deleted on its server: Send off with the sentence, the box read-only); app/test/wiring.test.ts (same name) | B-RO-12, C-RO-01 |

### conn.test.ts

83 tests: 83 core only, 0 old page, 0 mixed.

| old test (`conn.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the stream is opened through the transport, and opening it again closes the one before" | a | `packages/core/test/conn.test.ts` (same name) | D-TR-13 |
| "what an older stream says after a newer one was opened is dropped" | a | `packages/core/test/conn.test.ts` (same name) | D-TR-13 |
| "a chat's list is asked for by its branch's id, and kept under the branch's key" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "moving to another branch and back: one fetch for each branch the first time, both lists kept" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the events of a branch shown earlier go on being applied to its kept list" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the events of a branch never loaded are dropped: nothing is kept for it" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "what arrives while a list is fetched is applied after the answer, by version" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a list's answer is kept under its own branch's key when the chat shows another by then" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a failed fetch keeps the list from before, with what arrived meanwhile" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a branch's record is kept for a chat not known yet, and goes with the chat" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a record of any branch is applied, loaded or not, and the view shown takes the shown branch's" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a server that sends no records: the current branch's is the view's own, and the view shown stays the chat's" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the record a list's answer brings is taken, unless one arrived by event while it was fetched" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot drops every list kept, takes its records, and the selected chat's list is fetched again" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot reads the open chat's list anew and joins no fetch that runs: one made while the stream was down started no follow" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the branch a chat is on survives a snapshot that still has the branch, and is dropped otherwise" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a chat is on no branch of its own until its first list loads: then on the server's current one" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `chat` event that names another current branch does not change the branch a chat is on" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the view shown of a branch without a record: ready, locked and empty, not another branch's state" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "what comes late for a removed chat is dropped: a list's answer with its record, and a state" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a branch's list is kept for who asks, whatever the chat shows: one fetch, then current" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a removed chat takes the lists, subagents, subagent threads and records of all its branches" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a subagent's thread is its branch's: fetched for the branch shown, and kept current when another is shown" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the subagent drawer closes when its chat shows another branch, and stays when it does not" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a chat that is not open is not fetched when its current branch changes" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a branch that turns busy or comes to rest fetches no tree" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `chat` event with another current branch or branch count fetches no tree" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a tree event patches the kept tree" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a tree event for a chat with no tree, that is not the one on screen, is dropped" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a tree event for the chat on screen with no tree starts one fetch of it" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot's tree fetch that fails is made once more after a while, and its answer is kept" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "tree events during the fetch are applied after its answer" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a failed tree fetch keeps the tree from before, with what arrived meanwhile" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "loadTree fetches once and not again while the tree is kept; force fetches" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot drops the trees and a late answer" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "nothing of a removed chat is kept" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "usable agents: the snapshot's list and the `agents` event fill the store" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a new stream holds nothing: `hello` tells the board layer before the snapshot's takes, and the role is the stream's" | a | `packages/core/test/conn.test.ts` (same name) | A-ST-16 |
| "`release_request` hands over the one board it names, and no other board is flushed" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "`superseded` loses one board: the stream stays open, and the events that follow are still applied" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "`server_stopping` writes the boards of that server and says so to it" | a | `packages/core/test/conn.test.ts` (same name) | D-SV-14 |
| "a new stream of a section's server holds nothing of that server: `hello` tells the board layer with its entry id, and this computer's role stays" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a tool call is answered with the tool's result; a reply the server no longer wants (409) is not an error" | a | `packages/core/test/conn.test.ts` (same name) | D-AG-23 |
| "a stream the transport closed for good: every entry shows as not connected, and the stream is opened again a moment later" | a | `packages/core/test/conn.test.ts` (same name) | A-ST-13, D-TR-12 |
| "a stream closed for good twice before it is opened again is opened once; connect() meanwhile takes the wait away" | a | `packages/core/test/conn.test.ts` (same name) | A-ST-13, D-TR-12 |
| "the stream's state 'open' is no change of the page: the greeting is" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the snapshot of a section's server gives its lists; the `catalog` and `agents` events of it change them, this computer's stay its own fields" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a section's lists stay while its server is not connected, and go with its entry" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot's `sections` go to the store under the page's keys, beside this computer's things of the same ids" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the list events with `server` change that section alone, under the page's keys: `groups`, `defaults`, `board`, `chat`, `branch_state`" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "an event with `server` for an entry the page has no tree of is dropped" | a | `packages/core/test/conn.test.ts` (same name) | A-ST-16 |
| "the same id on this computer and in a section is two chats: their threads, records, trees and events never mix" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree replaces the entry's things and reads again what is on screen: the list and the tree" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with null leaves the open chat and its thread in the store, and makes no call" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "what stayed on screen of a section goes once the user has left it: of an entry without a tree, and what is no longer on its server" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot is this computer's part: what is on screen of a section without a tree stays as it is, and is read again when the tree is in one" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "an entry that leaves `connected` takes its tree away, marks its library and keeps what it offered; one that is back brings all of it again" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "this computer's entry leaving `connected` takes its tree away as a section's: the page keeps its things and its library, and holds the tree again at its snapshot" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "this computer's tree is its snapshot: it makes no `sections` entry, and its entry leaving makes none go" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "this computer's server away: the reads of its chats that run are given up, and the open chat is read again when the snapshot is back" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot of this computer without the chat on screen: the chat stays, gone, with its thread; the others go; the snapshot that has it again takes the mark away" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "`chat_removed` with `server`: the chat on screen is marked gone and kept as it is, one off screen is removed" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree that lacks the chat on screen marks it gone, keeps what the page shows of it and reads nothing" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a read of a chat answered 404 `not_found` marks it gone, this computer's too; another failure and a subagent's thread do not" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "`board_removed` with `server`: what is on screen is marked gone and kept; what is off screen is removed" | a | `packages/core/test/conn.test.ts` (same name) | D-RB-09 |
| "a `section` with null keeps a board of that server whose edit waits to be saved, on screen or not; a tree that comes without it takes it away" | a | `packages/core/test/conn.test.ts` (same name) | D-RB-11 |
| "the events about one board of a section go to the board layer with the board's key" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a tool call with `server` reaches the board layer with the page's keys of the chat, its board and the target; the arguments stay the agent's own" | a | `packages/core/test/conn.test.ts` (same name) | D-AG-22 |
| "a `section` with a tree is told to the board layer, which reads and takes the board on screen of that server; one with none is not" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree and the stream's `hello` tell the open composers to save a draft that waits (logic/draftsback.ts)" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "the unsaved copy of a draft of a section's chat is kept in the page's memory, never in the browser's storage" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a failed load of a chat's list is kept with its code, and a load that works clears it" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a snapshot drops the load errors with the threads" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: a thread kept at a high version is replaced by the restarted server's, and its events are applied again" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: the read of the chat on screen fails: the kept thread goes, with the pane, and the error is stored" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: an open subagent pane stays, and its thread is read again and replaced" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: the chats of another server and the local ones keep what they have; one not on screen loads when it is opened" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: the fetches that run are given up, list and tree, and what was queued behind them goes" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: a newer read of the kept list that fails takes the list away, although the reload's own answer is then discarded" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: the kept list is marked only until a read of it answers: a later read is judged by its version again" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: the reload of the list that was shown fails after the chat went to another branch: that branch's read keeps its place" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "a `section` with a tree: an open subagent pane whose thread is not loaded is read again, a read of it in flight or failed before" | a | `packages/core/test/conn.test.ts` (same name) | — |
| "what a server that still has runs sends is ignored: its runs, their chats and their events" | a | `packages/core/test/conn.test.ts` (same name) | — |

### drafts.test.ts

88 tests: 86 core only, 1 old page, 1 mixed.

| old test (`drafts.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "draftOf drops blank text and mentions without text" | a | `packages/core/test/drafts.test.ts` (same name) | C-TX-06, C-MN-08, C-DR-01 |
| "saves the last change after a pause" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-01 |
| "skips a draft that is saved already" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-01 |
| "flush saves the pending draft at once, and only once" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-04 |
| "clearing the text saves an empty draft" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-01 |
| "the unsaved copy is kept from the change until the server has it" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-05 |
| "a refused save keeps the unsaved copy, and the same draft is tried again" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-05 |
| "changing back to the saved draft drops the unsaved copy" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-05 |
| "draftOf keeps quotes, with or without text" | a | `packages/core/test/drafts.test.ts` (same name) | C-QT-21 |
| "saves quotes and their comments, and skips them when saved already" | a | `packages/core/test/drafts.test.ts` (same name) | C-QT-21 |
| "chatHasDraft: the server's word over all branches, else the current branch's own draft" | a | `packages/core/test/drafts.test.ts` (same name) | A-SB-13, C-DR-16 |
| "draftKey and legacyDraftKey: an unsaved draft per branch, and the key it had per chat" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-22 |
| "draftKeyOf: every unsaved draft of a chat, a branch's and the one it had per chat, and no other chat's" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-22 |
| "legacyDraftRenames: a draft kept per chat goes under the chat's current branch; a branch's key and an unknown chat's are left" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-22 |
| "heldOf and sameDraft: a draft as a composer holds it; no draft is the empty one" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "joinDrafts: both texts, mentions and quotes; the same draft twice, or one with nothing, is one draft" | a | `packages/core/test/drafts.test.ts` (same name) | C-MN-08, C-DR-17 |
| "draftsAfterSent: Branch and edit leaves the draft put aside on the branch left, whole" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-17 |
| "draftsAfterSent: a move that put nothing sent the draft itself: the branch left has none" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-17 |
| "draftsAfterSent: what was typed after the Send goes to the branch sent to, never to the branch left" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-17 |
| "draftsAfterSent: while the chat still shows the branch left, what its composer holds stays its draft" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-17 |
| "draftSet: the current branch's draft goes on its record and on the chat's view" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-16 |
| "draftSet: another branch's draft goes on its record only; the view tells that a branch has one" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-16 |
| "draftSet: an empty draft clears; the view has a draft as long as another branch has one" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-16 |
| "draftSet: a view that would not change is the same view; a server without records gets none made" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-16 |
| "otherDrafts: a draft on a branch other than the one shown" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-16 |
| "each save names the counter it was typed on, and the next one names the counter the server answered" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-07 |
| "a save waits for the one in flight, and names the counter that one's answer gave" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-07 |
| "a page that goes away does not wait for the save in flight: it names the counter that save leaves" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-04 |
| "a stale refusal of a composer emptied here, with nothing typed since, shows the server's draft" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-08 |
| "a stale refusal with another window's draft keeps the text typed here, and saves it again on the new counter" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-08 |
| "a stale refusal with no draft on the server keeps the text, and saves it again on the new counter" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-08 |
| "a stale refusal with no draft on the server, the composer being empty: nothing is shown and nothing is saved again" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "text typed after a Send is kept when its save is refused as stale by the drop of the sent draft" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "text typed after a Send and saved is kept when the drop of the sent draft arrives after it" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "the drop of the sent draft that arrives while the save of the text typed since is in flight keeps the text" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "saved text that another window sent or cleared goes, when no Send of this composer's is on its way" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "sending: the removal is this composer's own until the Send is answered and the grace has passed, and each Send has its own end" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a draft deleted and typed again with no pause, then sent from the other window, does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: text typed during this window's own Send, then sent from the other window, does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a Send refused here, the text put back, then sent from the other window, does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-TX-09, C-DR-10 |
| "windows: a fork's first message, with text typed at once, keeps the text" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: an ordinary chat, whose save waits for the Send, keeps the text typed after it" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: with nothing typed after the Send the composer stays empty and nothing is saved again" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: the other window's save wins while this one's is in flight: the text typed here stays, is saved on the next counter, and the other window shows it" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a Send that failed here, then the other window's Send within the grace: the message does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: the other window's Send refused while this one's runs: this one's removal is not undone there" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a note the other window typed and deleted during this window's Send of text the server never had does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a message typed and sent at once, then text typed and saved here and sent from the other window within the grace, does not come back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a Send refused after its emptied draft was saved: the text put back is saved again, and both windows show it" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "windows: a Send refused after the other window sent the same draft puts nothing back" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "sending: what ends a Send answers whether the sent draft was removed on the server while it was on its way" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "own: only text this composer saved since its Send began is saved again when a removal comes" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-10 |
| "sending: a Send that can have removed nothing is over with its answer, without the grace" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "boxText: the box gets the draft to show as it appears, else the text the composer holds unseen (the review T105, D3)" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-20 |
| "staleTaken: what a save refused as stale tells goes into the store unless a later counter is known there" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "answerNewer: a save's answer with a later counter than the record's brings its draft with it" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "the composer shows the text it holds when its box appears, takes a save's answer and a stale one by their counters, ends its Send for the saver whatever is thrown, and puts back by what the saver tells" | c | core half: `packages/core/test/drafts.test.ts` (same name); old-page half: SEC.7-drop@d,t,p / AAC.2-localdown@d,t,p (what was typed is saved by one PUT on the counter when the server is back; the box keeps it); SEC.9-storage@d,t,p; L16-composer@d,t,p (Send empties the box and the draft); app/test/wiring.test.ts (same name: the order of the saver's steps in the composer) | C-TX-07 |
| "the composer sets a text also when it draws no box (an archived chat), puts a refused Send's text back so, and tells its saver of a refusal" | b | L16-composer@d,t,p (an archived chat draws no box but its bar, a refused Send's text goes back); app/test/wiring.test.ts (same name) | C-DR-20 |
| "a draft that is not none arriving after a Send replaces saved text as before" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a stale refusal while more was typed keeps the text, and the next save names the new counter" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a newer draft arriving with nothing pending and nothing in flight is shown" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-09 |
| "a newer draft that is the one held already is not put in again" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a newer draft arriving while something is pending leaves the text, and the next save names the new counter" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-09 |
| "a newer draft arriving while something is pending that equals it leaves nothing to save" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "an event that equals the save in flight is its echo: nothing is shown and nothing is lost" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-09 |
| "a newer draft arriving while a save is in flight is shown once the save ended, when nothing was typed since" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-09 |
| "a newer draft arriving while a save is in flight and more is typed leaves the text" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a save that failed otherwise keeps the unsaved copy on its base and the counter" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a save that failed otherwise, then a newer draft from another window: the text typed stays, with its unsaved copy" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a save that failed otherwise while a newer draft arrived, or with more typed since, keeps what was typed" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a draft whose save failed while its server was away is saved by itself when the server is back, with no keystroke" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-12 |
| "back with nothing waiting saves nothing, and with a save in flight waits for its answer" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "back saves what the composer holds now: text typed since the failed save, on the counter that server has by then" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-12 |
| "back while the server is still away fails again and keeps the text for the next time" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-12 |
| "a composer that opens with an unsaved copy saves it, whatever it was told is saved: the store has a draft from before its save was answered" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a saver with no counter names none and shows nothing" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "unsavedToShow: a copy on the server's counter is used, one on an older base is dropped, one without a base is used" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-05 |
| "staleOf: the server's counter and draft of a save refused as stale; null for another error" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "revSet: the record of a branch gets a later counter; an earlier one, or no record, changes nothing" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-07 |
| "a draft of images alone is a draft, wherever the page asks whether a branch has one" | a | `packages/core/test/drafts.test.ts` (same name) | C-IM-13 |
| "a draft has no image bytes: an image is named by its id, name, type and size, whatever the composer holds of it" | a | `packages/core/test/drafts.test.ts` (same name) | C-IM-13 |
| "what a composer holds and its draft are one another's, with the images; two drafts with other images are not the same" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "joinDrafts: two drafts joined keep the images of both, each once, also past what one message takes" | a | `packages/core/test/drafts.test.ts` (same name) | C-IM-20 |
| "draftsAfterSent: the images go where the text goes" | a | `packages/core/test/drafts.test.ts` (same name) | C-DR-17 |
| "the saver saves a draft of images alone, a change of the images alone, and the empty draft when the last image is removed" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a saver that opens on a draft with images skips that draft, and saves it when the page goes away with an image more" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a draft with images from another window is shown with them, and one typed here on images is kept over it" | a | `packages/core/test/drafts.test.ts` (same name) | — |
| "a Send of images alone is a Send of a draft: one removed on the server meanwhile is not put back, one that was refused is" | a | `packages/core/test/drafts.test.ts` (same name) | C-TX-05 |

### draftsback.test.ts

6 tests: 5 core only, 0 old page, 1 mixed.

| old test (`draftsback.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a section's tree arrives: the draft typed while that server was away is saved, and no other server's composer is asked" | a | `packages/core/test/draftsback.test.ts` (same name) | C-DR-12 |
| "the page's own connection opens again: every open composer saves what waits, this computer's chats and the others" | a | `packages/core/test/draftsback.test.ts` (same name) | C-DR-12 |
| "the draft that waits is saved with its images: one of images alone is saved too, when the section's tree arrives and when the page's connection opens" | a | `packages/core/test/draftsback.test.ts` (same name) | — |
| "a composer that went away is told no more, and a chat's server is read when the event comes" | a | `packages/core/test/draftsback.test.ts` (same name) | — |
| "the copies the browser keeps are this computer's chats' alone: a section's tree asks the open composers only, a stream's snapshot asks the kept ones" | a | `packages/core/test/draftsback.test.ts` (same name) | C-DR-13 |
| "the page: conn.ts tells of `hello`, of a stream's snapshot and of a section's tree, and each composer adds its saver while it is open" | c | core half: `packages/core/test/draftsback.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: conn.ts is core's, the composer adds its saver); SEC.7-drop@d,t,p / AAC.2-localdown@d,t,p (what was typed while the server was away is saved once when it is back); packages/core/test/draftsback.test.ts (same name) | — |

### dropmark.test.ts

19 tests: 18 core only, 0 old page, 1 mixed.

| old test (`dropmark.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a zone, a header's upper half, the dragged group and its server make the mark" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-02 |
| "leaving empties only the zone or the header that was left" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "where nothing takes the drag nothing is lit, and the dragged group and its server stay" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "a start sets the dragged group and the server anew and lights nothing" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "only an end forgets the server of what is dragged" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-03 |
| "an event that changes nothing gives the same mark back" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "a zone takes only what is dragged on its own server" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-05 |
| "a drag that did not begin in this window is taken by every server's zones: its drop is judged by what it carries" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "the window: a drop, a drag's end and a dragover as they bubble; a press, a move and a key as they are captured" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "the sidebar keeps no highlight of its own and hears the window through the table" | c | core half: `packages/core/test/dropmark.test.ts` (same name); old-page half: app/test/dragdrop.test.ts "dropEventAt: its answers drive the one mark as the page's handlers did", "…only what is on the zone's own server is taken", "…a place that refuses lights nothing"; A3.2@d,t, A3.3@d,t, L14-dragtouch@d,t,p, SEC.3@d,t,p, SEC.5@d,t,p (what lights, across servers nothing). The old test read DOM listeners (WINDOW_EVENTS), which the pointer session of dragsession.ts replaces (AD-70) | A-DD-03 |
| "G2's 23 scenarios end with an empty mark, and each move is the scenario's" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-01, A-DD-06 |
| "a pointer move or a key in mid-drag empties what is lit and leaves the dragged group" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-11 |
| "a drag that ends after its row or header was removed: the element itself hears the end" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-07 |
| "a drag whose end reaches nobody: the first pointer event or key empties what is lit" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-10 |
| "inside a section a row and a group are dragged as in the local part" | a | `packages/core/test/dropmark.test.ts` (same name) | — |
| "a row dragged from the local part lights no zone of a section, and its drop there moves nothing" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-05 |
| "a row dragged from a section lights no zone of the local part or of another section" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-05 |
| "a group is dragged neither into nor before a group of another server, the one with its own id included" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-04 |
| "a row of another window lights the zone it is over on any server, and is moved only where it is on that server" | a | `packages/core/test/dropmark.test.ts` (same name) | A-DD-10 |

### flavours.test.ts

8 tests: 6 core only, 1 old page, 1 mixed.

| old test (`flavours.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the palette: four flavours of 26 colours, the ones of @catppuccin/palette 1.8.0" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-10 |
| "contrast and mixing are WCAG's and color-mix's" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-11 |
| "a token is the palette colour of its role" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-10 |
| "Latte: a colour under its floor gives way to the next of its family, or is mixed toward Text" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-11 |
| "every floor holds in every flavour" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-11 |
| "the signs of a change have their floor on their own lines' grounds, in every flavour" | c | core half: `packages/core/test/flavours.test.ts` (same name); old-page half: packages/core/test/flavours.test.ts (the palette module holds it: same name, its half); app/test/tokens.test.ts "every name has a value in every theme and flavour" (the app's tokens are made from the module) | A-TH-11 |
| "a flavour sets no agent colour, no chart colour, no hover, backdrop or shadow" | a | `packages/core/test/flavours.test.ts` (same name) | A-TH-12 |
| "every token a flavour sets is one styles.css has, and flavours.css is what the module says" | b | app/test/tokens.test.ts "the fixture is what the stylesheets say", "every name has a value in every theme and flavour", "a flavour keeps what it does not set from the theme it is laid over". There is no flavours.css on the new build, so "flavours.css is what the module says" is n/a; the licence notice that the build keeps: A6.4@d,t,p (the build's THIRD-PARTY-NOTICES.txt) and app/test/export-web.test.ts "the export carries the palette's licence notice as a file of its own (A-TH-17)" | A-TH-12 |

### folderagents.test.ts

10 tests: 9 core only, 0 old page, 1 mixed.

| old test (`folderagents.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "sameFolder" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "folderName: the last segment" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "a busy branch is one agent, each running subagent one more" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "archived chats and unknown chats do not count" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "another folder does not count" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "here and elsewhere: every branch counts, the asking chat's own too" | a | `packages/core/test/folderagents.test.ts` (same name) | B-TR-19, C-CH-24 |
| "folderAgents: the same path on another server is another folder" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "the same id on two servers is two chats: `here` is the asking chat's own key alone" | a | `packages/core/test/folderagents.test.ts` (same name) | C-CH-24 |
| "a view that still named a server in a field is on the server of its key" | a | `packages/core/test/folderagents.test.ts` (same name) | — |
| "the folder hint gives folderAgents the chats and their records alone, and the composer shows none" | c | core half: `packages/core/test/folderagents.test.ts` (same name); old-page half: L15-fork@d,t,p (the folder hint "N others working here" on a fork); app/test/wiring.test.ts (same name) | B-TR-19, C-CH-24 |

### insert.test.ts

16 tests: 14 core only, 2 old page, 0 mixed.

| old test (`insert.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "⌘P on a Mac and Ctrl+P elsewhere, with nothing else held" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-20 |
| "⌘P is the text box's own key, and the open insert popup's: nothing else in the page listens for it" | b | PL5.1-insert@d,t,p (⌘P in a composer's box opens the popup; the key does nothing outside it); app/test/library.open.test.ts and screens/library/open.ts plugInsert (the popup keeps the key while open); packages/core/test/insert.test.ts (isInsertKey). The old test read the page's DOM handlers, which the chip input's onKey replaces | C-PL-20 |
| "in the middle of typed text: what was before and after is unchanged, the caret is after the text" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-22 |
| "in place of a selection, whichever way it was made" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-22 |
| "in an empty box" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-22 |
| "line breaks are kept, and the text goes in exactly as it is" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-22 |
| "a place that is not in the box is its nearest end" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-22 |
| "the breaks that end the box are the browser's to keep: the rest is held to the letter" | a | `packages/core/test/insert.test.ts` (same name) | C-TX-04, C-PL-23 |
| "reference chips in the box are still there after an insertion, each where it was" | a | `packages/core/test/insert.test.ts` (same name) | C-RF-22 |
| "mentions in the box still resolve after an insertion: the picked ones by their board, the typed ones by name" | a | `packages/core/test/insert.test.ts` (same name) | — |
| "the inserted text is in the draft, as typed text is, and a box filled from that draft holds it again" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-25 |
| "a later change to the prompt changes nothing in the box: what was inserted is a copy" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-25 |
| "with no popup there, opening it leaves the box as it was" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-28 |
| "the popup gets the box's target, and tells it once what to do" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-28 |
| "a popup taken back after another came does not take that one away" | a | `packages/core/test/insert.test.ts` (same name) | C-PL-28 |
| "the box holds the page against what insertText says, and the composer opens the popup from its toolbar" | b | PL5.1-insert@d,t,p (the text put into the composer's box), PL5.2-popup@d,t,p (the Insert button of the toolbar's row and the entry of the "more" popup); packages/core/test/insert.test.ts (insertText) | C-PL-23 |

### keptpage.test.ts

27 tests: 26 core only, 0 old page, 1 mixed.

| old test (`keptpage.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a `section` with a tree: the draft typed in the open composer while the server was away is saved, naming the counter the page has" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "a section's chat is left while its server is away: what was typed goes with it, and nothing of it is kept or saved when the server is back" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-14 |
| "typed in a section's chat just before a save could not get through, and left: the copy waits in the page's memory, and the next composer of the chat has it and saves it" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-14 |
| "a `section` with a tree tells the open composers alone: the draft of a branch the chat is no longer on waits for that branch's next composer" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "a composer of a section's chat is closed and opened again while its server is away: the next one has the text from the page's memory, and saves it when the server is back" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the draft changed on that server meanwhile: what was typed here stays in the open composer and is saved on the counter the new tree brings" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the server is away again when the open composer's save reaches it: the text stays in the composer, and the next `section` with a tree saves it" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-12 |
| "the page's own connection opens again: the draft of a chat of this computer whose composer is closed is saved after the snapshot, and the open composer of a section's chat at the `hello`" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-13 |
| "a page that was reloaded saves what the page before it kept of this computer's chats, and leaves what is no such chat's branch" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-13 |
| "the kept draft goes to the server as the browser kept it: its images, its quotes and a field this page does not know are in the save's body and in the store's draft" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the draft changed in another window meanwhile: the kept draft's save is refused as stale, and the text typed here is saved on the counter the refusal gave" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the snapshot tells of a newer draft than the copy was typed on: the copy is not saved over it, and the composer that opens shows the server's" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the chat is opened while its kept draft is being saved, and more is typed: what is typed stays in the composer and is the draft in the end" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "a pending move's composer left its text with the move: the copy is what Back would leave, and is not saved until the move ends" | a | `packages/core/test/keptpage.test.ts` (same name) | C-DR-18 |
| "a section's chat takes images as a chat of this computer does: the same upload, the image in its composer, and its draft saved there with the image" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-22 |
| "a server that is not connected: no image is added and the line says why; the draft keeps its images, one can be removed, and what is left is saved when the server is back" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-23 |
| "the last image is removed while its server is away: the emptied draft is what the open composer saves when the server is back, and what a closed one of this computer's chat leaves is saved when the stream is back" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-24 |
| "the stream is back with the composer closed: the kept draft goes with its images, and a draft of images alone is not left behind as empty" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the page's own connection opens again: the kept drafts of this computer's chats are saved with their images" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "an upload that outlived its composer, answered just before the page's stream was cut: the image is kept in the branch's draft by the browser, and saved when the stream is back" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-16 |
| "an upload cut by the server going away: the image leaves the strip, the error says so, and it is not in the draft" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-15 |
| "a kept draft names an image the server no longer holds: it is saved without it, and the line waits for the composer that opens next" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-26 |
| "every answer of the servers to an upload that is no image: the image leaves the strip, the line names the file with that server's sentence, nothing is in the draft, and it is not tried again" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-15 |
| "every answer of the servers to a draft save with images that was not taken: the composer and the page keep the draft, images and all, and the next save that reaches the server has it" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "a draft save answered `missing`: the images named leave the strip, the line says what to add again, and the draft on the new counter is the one without them" | a | `packages/core/test/keptpage.test.ts` (same name) | C-IM-26 |
| "a draft that another client of that server saved on a higher counter, without an image: the open composer that typed nothing since shows it, and one that typed keeps its text and saves on that counter" | a | `packages/core/test/keptpage.test.ts` (same name) | — |
| "the page starts watching before its stream opens, and conn.ts tells draftBacks of this computer's stream `hello`, of its snapshot and of a section's tree" | c | core half: `packages/core/test/keptpage.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: bootstrap.ts calls watchKeptDrafts() before connect(); conn.ts tells draftBacks); packages/core/test/keptpage.test.ts (same name) | — |

### librarypopups.test.ts

10 tests: 2 core only, 8 old page, 0 mixed.

| old test (`librarypopups.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the stream keeps the libraries: each server's snapshot gives its library, an event of it the whole library again, none of a server that left" | a | `packages/core/test/librarypopups.test.ts` (same name) | C-PL-16 |
| "the notice of a library set aside comes with the server's snapshot and stays with its library" | a | `packages/core/test/librarypopups.test.ts` (same name) | C-PL-18 |
| "both popups are closed until they are opened, and the sidebar's button says what it opens" | b | PL4.1-library@d,t,p, PL5.2-popup@d,t,p (the popups are shown by the button / the insert key, and are not there before); app/test/library.open.test.ts (added) "the library popup opens by openLibrary…" | C-PL-01 |
| "the library popup with this computer's library alone: the tree, with no level of servers" | b | PL4.1-library@d,t,p (the tree with no level of servers, "Choose a prompt to edit it", New prompt, New group, Close); PL5.2-popup@d,t,p (an empty library says so) | C-PL-03 |
| "with another server each library is under its server's name, in the order of the server list, this computer's first" | b | PL4.1-library@d,t,p, PL6.1-tree@d,t,p (each library under its server's name in the order of the server list, a server that dropped marked "not connected" with its prompts still listed) | C-PL-03 |
| "the tree is set in by depth alone: a prompt at the top is at the edge with no line, one in a group beside its group's line" | b | PL6.1-tree@d,t,p, PL4.1-library@d,t,p (the rows' level and indent, the drag handle on what can be dragged and not on a server's entry or a server that dropped) | C-PL-15 |
| "what a library says is shown as text, in both popups: names, texts, a server's name, the notice of a file set aside" | b | L20-library@d,t,p (what a library says is text, in both popups; the notice of a file set aside) | C-PL-18 |
| "the insert popup: the search and every prompt with its path, in the order of the tree; nothing to create, edit or delete" | b | PL5.1-insert@d,t,p, PL5.2-popup@d,t,p (the search, every prompt with its path in the tree's order, the first highlighted, "Edit the library"; a prompt of a server that dropped is marked) | C-PL-20 |
| "the insert popup with an empty library says so and offers the way to the library popup" | b | PL5.2-popup@d,t,p ("The library has no prompts yet.", "Open the library") | C-PL-27 |
| "the insert popup opens for a text box, and not under a dialog; a second box takes it from the first" | b | app/test/library.open.test.ts (added: the same test on screens/library/popups.ts openInsert and openLibrary); PL5.1-insert@d,t,p, PL5.2-popup@d,t,p | C-PL-28 |

### newchat.test.ts

10 tests: 8 core only, 2 old page, 0 mixed.

| old test (`newchat.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "api.newChat posts {'group':'g_1'} alone, with no agent" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat posts {'group':'__ungrouped__'} alone, with no agent" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat posts {'board':'b_1'} alone, with no agent" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat in a section posts {'group':'s_1~g_1'} to the server s_1, with that server's own id in the body" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat in a section posts {'group':'s_1~__ungrouped__'} to the server s_1, with that server's own id in the body" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat in a section posts {'board':'s_1~b_1'} to the server s_1, with that server's own id in the body" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat in a section posts {'group':'s_2~g_1'} to the server s_2, with that server's own id in the body" | a | `packages/core/test/newchat.test.ts` (same name) | — |
| "api.newChat answers a section's chat with the page's keys: its own, its group's and its board's" | a | `packages/core/test/newchat.test.ts` (same name) | C-NC-03 |
| "the places that make a chat have no agent menu and name no agent" | b | SEC.4@d,t,p (a thing is made at once on the section's server: a chat, a board, a group, no question about the place); AAC.1@d,t,p (the "+"s make things on this computer); app/test/wiring.test.ts (same name) | A-SB-33, C-NC-01 |
| "the two menus still offer a chat and a whiteboard" | b | AAC.1@d,t,p ("Chat", "Whiteboard", "Group" in a section's "+"; "New chat", "New whiteboard", "New group" in the sidebar's); L16-composer@d,t,p (the empty state's "New chat" button); app/test/wiring.test.ts (same name) | A-SB-03, C-NC-02 |

### newchatwhere.test.ts

13 tests: 12 core only, 0 old page, 1 mixed.

| old test (`newchatwhere.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a chat of a group: the new chat goes in that group" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, C-NC-06 |
| "a board, or a chat on it: the new chat goes on that board" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, C-NC-06 |
| "a chat of a section: the new chat goes in that chat's group on that server, never in the local one with the same id" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, C-NC-06 |
| "a chat in no group of a section: the new chat goes to the ungrouped area of that server" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, C-NC-06 |
| "nothing selected, or a chat that is gone: ungrouped" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, C-NC-06 |
| "the place: where the buttons offer a chat, the same place as before" | a | `packages/core/test/newchatwhere.test.ts` (same name) | — |
| "the place: none on an archived board" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-05, C-NC-07 |
| "the place: in a connected section the chat is made where the user is, on that server" | a | `packages/core/test/newchatwhere.test.ts` (same name) | C-NC-08 |
| "the place: none in a section whose server is not connected: there is nothing to make it from" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-SC-23, A-KY-05, C-NC-07 |
| "the place: none on a board its server no longer has, on screen as it still is" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-05, C-NC-07 |
| "the place asks the store whether the place is reachable, by the place's own key" | c | core half: `packages/core/test/newchatwhere.test.ts` (same name); old-page half: app/test/shortcuts.test.ts (⌘N makes a chat where the user is, if that place offers one); packages/core/test/newchatwhere.test.ts (same name); app/test/wiring.test.ts (same name) | C-NC-07 |
| "the place: none in an archived group, or on a board the store does not hold" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-05, C-NC-07 |
| "the shortcut: ⌘N on macOS, Ctrl+N elsewhere, with nothing else held" | a | `packages/core/test/newchatwhere.test.ts` (same name) | A-KY-04, A-KY-08, C-NC-06 |

### remotechat.test.ts

18 tests: 8 core only, 0 old page, 10 mixed.

| old test (`remotechat.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a section's chat before its first message has the composer of any chat: its server named and fixed, its agent, folder, model, effort and subagents open" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: A2.3-places@d,t,p (an unstarted chat of a section: the server chip, agent, folder, model, effort, subagents in place); app/test/wiring.test.ts (same name) | C-NC-08 |
| "a change of an unstarted section chat's settings is the call of a local chat under its entry, and the page takes the chat that server answers with, under its key" | a | `packages/core/test/remotechat.test.ts` (same name) | — |
| "the first message of a section's chat is an ordinary Send: the same call as any message, on its branch" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: SEC.8@d,t,p (a message sent to a section's chat and the reply, the calls to the entry's server); L16-composer@d,t,p (Enter sends the text as typed); app/test/wiring.test.ts (same name: one api.send in composer/send.ts) | C-NC-09 |
| "a first message with no answer: it is not known whether it arrived, and the page keeps the text" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: no "unconfirmed", "sent only once", "first_text_kept"…); the sending path: L16-composer@d,t,p; packages/core/test/remotechat.test.ts (same name) | — |
| "a first message with no answer whose draft that server removed meanwhile: the message arrived, and the page does not put it back" | a | `packages/core/test/remotechat.test.ts` (same name) | C-TX-09 |
| "a server that is not connected: the Send is off for every chat of it, started or not, and the box is read-only (it keeps what it holds and takes no more)" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: SEC.7-drop@d,t,p, AAC.2-localdown@d,t,p (the box is read-only: aria-readonly, what was typed stays and takes no more; Send off); R3.12-images@d,t,p (no image leaves a draft that cannot be saved); app/test/wiring.test.ts (same name) | C-RO-01 |
| "a save that fails as the server drops: the page keeps the text that was typed and not yet taken, which the open composer saves when the server is back" | a | `packages/core/test/remotechat.test.ts` (same name) | C-DR-15 |
| "the images of a section's chat go by the calls of a local chat: the upload, the fetch, the draft save and the Send, each to the chat's own address on its entry's server" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: R3.12-images@d,t,p (the pasted image becomes a thumbnail on the chat's own address, the upload goes to ${ON}/images, the draft is saved with it, the message is sent with it; this computer holds nothing of it); app/test/wiring.test.ts (same name). Deliberate: pictures are addressed by server and chat (the transport's picture(), package C6), so the strip names the server where the old page's did not | C-IM-22 |
| "a server that is not connected, or that no longer has the chat: paste of an image and the attach button are off, with the reason; the images a draft has stay, and nothing is uploaded" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: R3.12-images@d,t,p (paste and the attach button are off with the reason, the draft keeps its images, no remove control, nothing uploaded; back, the tile that could not be fetched is fetched again); app/test/wiring.test.ts (same name) | C-IM-23 |
| "an image is removed from the draft as its server drops: the save fails, the page keeps what is left, and it is saved when the server is back" | a | `packages/core/test/remotechat.test.ts` (same name) | C-IM-24 |
| "a Send that fails, or whose arrival is not known, keeps the images with the text: in the composer and as the draft" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: L16-composer@d,t,p (a refused Send puts its text back); R3.12-images@d,t,p (the draft with its images, sent when back); app/test/wiring.test.ts (same name); packages/core/test/remotechat.test.ts (same name) | C-TX-08, C-IM-27 |
| "a Send with no answer whose draft that server removed meanwhile: the message arrived, and neither its text nor its images are put back" | a | `packages/core/test/remotechat.test.ts` (same name) | C-TX-09 |
| "a Send refused because the chat's server no longer holds an image: that image stays out, the others go back, and the line says what to add again" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: L18-imagelimits@d,t,p / IM3.2-images@d,t,p (a refused upload and its line); app/test/wiring.test.ts (same name); packages/core/test/remotechat.test.ts (same name) | C-IM-26 |
| "two clients in one draft, the user's page and that server's own page or another client's: images go both ways, and a draft of images alone is nobody's empty one" | a | `packages/core/test/remotechat.test.ts` (same name) | — |
| "every answer of the servers to a Send with images that was not taken: the text and the images go back, but for those the answer says the chat no longer holds, and the page knows whether anything was sent and whether to read the chat again" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name: sentNothing decides refused); packages/core/test/remotechat.test.ts (same name: the table of answers) | C-IM-27 |
| "the line under the composer is a refusal's own sentence, else the chat's error" | c | core half: `packages/core/test/remotechat.test.ts` (same name); old-page half: L16-composer@d,t,p (a refused Send says why under the composer); app/test/wiring.test.ts (same name) | C-RO-09 |
| "a Send answered that nothing was sent (its server is not connected, the chat is gone there): the page keeps what the user typed, and the Send is over for the saver at once" | a | `packages/core/test/remotechat.test.ts` (same name) | C-RO-12 |
| "a page open while that server tells of the draft again loses nothing: the box keeps what was typed, on the same counter or a higher one" | a | `packages/core/test/remotechat.test.ts` (same name) | C-DR-15 |

### remoteview.test.ts

11 tests: 8 core only, 1 old page, 2 mixed.

| old test (`remoteview.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the sentences name the server" | a | `packages/core/test/remoteview.test.ts` (same name) | B-RO-07 |
| "remoteView: a chat of this computer is judged as any other: away, or gone from this computer" | a | `packages/core/test/remoteview.test.ts` (same name) | — |
| "remoteView: a section's chat whose server is connected shows the thread, loaded or loading" | a | `packages/core/test/remoteview.test.ts` (same name) | — |
| "remoteView: not connected with no thread says so with the entry's state, with or without a load error" | a | `packages/core/test/remoteview.test.ts` (same name) | A-ST-05, B-RO-07 |
| "remoteView: gone, by the load's code not_found or the page's mark" | a | `packages/core/test/remoteview.test.ts` (same name) | A-ST-06, B-RO-03 |
| "remoteView: gone_there is no code any more: such a load is a failed load like another" | a | `packages/core/test/remoteview.test.ts` (same name) | — |
| "remoteView: a thread on screen stays, read-only, under a warning that says the entry's state in the server list's words" | a | `packages/core/test/remoteview.test.ts` (same name) | A-ST-04, B-RO-01 |
| "remoteView: a load that failed while the server is connected shows the server's sentence" | a | `packages/core/test/remoteview.test.ts` (same name) | A-ST-07, B-RO-07 |
| "the chat view reads the three from the chat's key, the section's tree and the page's mark" | b | app/test/wiring.test.ts (same name); SEC.7-drop@d,t,p, SEC.10@d,t,p (the warning with the state, "Servers…" unless the chat is gone) | — |
| "deleteAsk: the dialog a chat's Delete opens" | c | core half: `packages/core/test/remoteview.test.ts` (same name); old-page half: SEC.5@d,t,p (the question before a delete names the server); app/test/wiring.test.ts (same name); packages/core/test/remoteview.test.ts (same name: deleteAsk) | A-SB-19 |
| "a chat is deleted on its server or not at all: nothing offers to remove it from this sidebar only" | c | core half: `packages/core/test/remoteview.test.ts` (same name); old-page half: app/test/wiring.test.ts (same name); app/test/gone.test.ts (added: "Remove from this sidebar" is in no file) | A-SB-19 |

### restart.test.ts

8 tests: 8 core only, 0 old page, 0 mixed.

| old test (`restart.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the page's version is the app's build" | a | `packages/core/test/restart.test.ts` (same name) | — |
| "Restart server asks the app (owner.restart) and waits for this computer's entry to be connected again; the page is not loaded again" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-09 |
| "the restart waits for the page to hold this computer's tree too, not for its entry's state alone" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-09 |
| "a restart the app refused is a failed one, with the app's reason; Retry restarts again" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-10 |
| "a server that does not come back in time is a failed restart too" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-10 |
| "Retry after a start that failed asks the app to start the server (owner.retry), and nothing else" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-04 |
| "while agents run the restart asks first, and a second press while it runs does nothing" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-08 |
| "Open log is the owner's thing too; the page is in the app when its way is IPC" | a | `packages/core/test/restart.test.ts` (same name) | A-OW-11 |

### roles.test.ts

25 tests: 22 core only, 3 old page, 0 mixed.

| old test (`roles.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a grant with no scene kept: the board is held, and there is nothing to save or drop" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a grant at the revision the scene is kept at: the scene stays, and its waiting edit is saved" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a grant at another revision: the kept scene goes, and a waiting edit is dropped, never saved" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "the three cases after a reconnect, by the answer of the take if free" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a take's answer with nothing unsaved drops nothing, whatever it is" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a take that waits: the role is taking, and an edit that waits is kept until the grant decides" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-14 |
| "a take if free answered busy does not undo a take that waits" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "an answer in no known state changes nothing" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-14 |
| "a loss: the role is lost, an unsaved edit is dropped with its scene, a saved scene is kept" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-08 |
| "a loss under an outage of the board's server: the scene and its edit are kept, and the next grant decides by the revision" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a take if free answered busy keeps an edit that was kept at the loss; a take that waits is not undone" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a refused save drops the edit: stale keeps the role, not_holder makes the board another window's" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "no step both saves and drops, and only a grant saves" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "a reconnect: what this window held or waited for is not asked for any more; what other windows hold stays" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "the panel shows in place of the canvas for every role but held and not asked" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-01 |
| "a click on a board's own row takes the board from the window that holds it" | a | `packages/core/test/roles.test.ts` (same name) | A-SB-21, D-TK-06 |
| "picking a chat of another board takes that board only if it is free" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-07 |
| "a selection on the board that is on screen takes it from no window: only one not asked for yet is asked for, if free" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-07 |
| "a click on a board's own row takes the board also when it is on screen already, behind the take-over panel" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-06 |
| "a click on a chat of a board another window holds takes the board only if it is free, whichever board is on screen" | a | `packages/core/test/roles.test.ts` (same name) | D-TK-07 |
| "a board this window holds or is taking is never asked for again" | a | `packages/core/test/roles.test.ts` (same name) | — |
| "the sidebar's select takes its decision from takeOnSelect, and a chat is opened with the board taken if free" | b | app/test/wiring.test.ts (same name: screens/shell/nav.ts select decides by takeOnSelect); L5-board-roles@d,t,p (the board side: "Use here" takes the board back); packages/core/test/roles.test.ts (takeOnSelect's table) | — |
| "only the board's own row in the sidebar opens it as a row click" | b | app/test/wiring.test.ts (same name: openBoard(…, true) in the sidebar's row and the rail's list only; the board's bar and a reference call it with false); packages/core/test/roles.test.ts | A-SB-21, D-TK-06 |
| "selectedOn: the page's selection counts only for the board whose canvas this window shows" | a | `packages/core/test/roles.test.ts` (same name) | C-RF-02, D-SL-05, D-SL-14 |
| "the composer's chip takes its count from selectedOn, with the role of the chat's board" | b | P0.3-smoke@d (A2.board-selected: the chip shows "3 selected"), P7.4-board@d,t / P7.4-keys@d,t (⌘L with shapes selected); app/test/wiring.test.ts (same name); packages/core/test/roles.test.ts "selectedOn: …" | D-SL-05 |

### saves.test.ts

90 tests: 0 core only, 90 old page, 0 mixed.

| old test (`saves.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a failed save stays pending after flushAll, so aiwbFlush gives false" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-05, D-SV-10 |
| "a flush once saveScene works again writes the board and clears it" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-05 |
| "flushAll retries every board whose save failed" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-06 |
| "forgetBoard on a board with a failed save clears it" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-06 |
| "an archived or removed board with a failed save is not pending" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-10, D-SV-06 |
| "a later successful write clears a failure; a later failed one sets it again" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-05 |
| "a save names the revision the scene was read at, then the one the server answered" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-02 |
| "a stale save drops the edit and reads the scene again: nothing newer is overwritten" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-03 |
| "a board this window does not hold is never written" | b | packages/core/test/board/saves.test.ts (same name) | — |
| "a save refused with not_holder: the board is another window's, and the edit is dropped" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-04 |
| "each board has its own role: taking one, finding another busy, waiting for it and getting it" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-14 |
| "an archived or unknown board is not asked for" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-10 |
| "one take runs per board: a take if free joins it, a take does not join a take if free" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-14 |
| "a take that fails leaves the role as it was" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-14 |
| "release_request: the one board's pending save is written, then it is let go; the others wait as before" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-13 |
| "a release answered free (who asked went away): the board is asked for again, if free, and not written in between" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-16 |
| "superseded: that board is lost with its unsaved edit; the stream's other boards are as before, and aiwbFlush is true" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-10, D-TK-08 |
| "a write that is on its way when the board is lost changes nothing when it answers" | b | packages/core/test/board/saves.test.ts (same name) | D-SV-15 |
| "a lost board's saved scene is kept for a grant at its revision, and read again at another" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-02, D-TK-08 |
| "a scene read that is on its way when the board is granted is not kept: the scene is read again, and the first save names the granted revision" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-05 |
| "opening a free board reads its scene once: a read on its way that lands at the granted revision is kept" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-01 |
| "a scene read that is on its way when the kept scene is dropped is not kept either" | b | packages/core/test/board/saves.test.ts (same name) | D-BD-05 |
| "after a reconnect nothing is written before the board is granted again" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-12 |
| "reconnect, the board is not free: the role is other, the pending edit is dropped, the panel says so" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-12 |
| "reconnect, the board is free at the same revision: the pending edit is saved" | b | packages/core/test/board/saves.test.ts (same name) (its third assertion is the `until` that waits for the save to end) | D-TK-12 |
| "reconnect, the board is free at another revision: the pending edit is dropped, with a note on the canvas" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-12 |
| "after a reconnect a board that showed the panel is not asked for: the window that held it is the one to get it back" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-13 |
| "after a snapshot only the board on screen and the boards with an unsaved edit are asked for, each if free" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-12 |
| "a reconnect keeps what is known of the other windows, and drops what this one held or waited for" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-13 |
| "the answer of a take made before a reconnect is not taken: that hold went with the stream" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-15 |
| "a take's `waiting` that arrives after the `held` event does not undo the grant" | b | packages/core/test/board/saves.test.ts (same name) | D-TK-15 |
| "a save answered 503 keeps the edit and sets the outage, for either code" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-03 |
| "a save answered 504 (the link broke while it was on its way) keeps the edit and sets the outage" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-03 |
| "a 503 for a board of this computer raises the banner, as for a section's; a save that got no answer raises none" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-03 |
| "a board of a section through an outage: the 503 keeps the edit and sets the outage, the board stays while there is no tree, and `held` at the same revision after the `section` saves it" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "a board of a section without a tree: one on screen stays, one with an unsaved edit stays off screen too, and both go once nothing holds them" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-11 |
| "a board that is not reachable is not asked for: its section has no tree, or it is gone from its server" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-11 |
| "a board whose read is answered 404 not_found is no longer on its server: marked gone, this computer's too, and the board of the same id on the other server is not" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-09 |
| "what is drawn on a section's board is in the window's memory alone: nothing of it is in the browser's storage, saved, waiting for its server, or dropped" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-08 |
| "`held` at the same revision saves the edit and clears the outage" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-05 |
| "`held` at another revision drops the edit with the outage notice" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-06 |
| "a drop with no outage keeps the plain notice, also after one with an outage" | b | packages/core/test/board/outage.test.ts (same name) | D-SV-03 |
| "under an outage `stale` and `not_holder` drop the edit and clear the outage" | b | packages/core/test/board/outage.test.ts (same name) | D-SV-03 |
| "superseded under an outage: the panel, and the edit is kept, unwritten, without the dropped text" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-07 |
| "superseded under an outage, then 'Use here' at the same revision: the kept edit is saved, and the outage cleared" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "superseded under an outage, then 'Use here' at another revision: the kept edit is dropped with the outage notice" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "an edit kept at the loss stays kept when a take if free finds the board busy (a `section` with a tree), and is saved at the grant" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-07 |
| "superseded with no outage drops the unsaved edit as before: a board of a section, and one of this computer, with no answer at all" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "a scene read answered 503 rejects with it, and keeps nothing" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "a scene read answered 404 names the board by its own id on its server" | b | packages/core/test/board/outage.test.ts (same name) | — |
| "a `section` with a tree: the board on screen of that server is read again when no scene is kept, and asked for if free" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-10 |
| "a `section` with a tree: a kept scene is not read again, a board this window holds or waits for is not asked for, nor one off screen with nothing unsaved, nor one of this computer" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-10 |
| "after a restart of this computer's server during the outage the board with the edit is asked for when the tree arrives, on screen or not, and the revision decides" | b | packages/core/test/board/outage.test.ts (same name) | D-RB-10 |
| "a tool call works on params.target, not on a board the page resolves" | b | packages/core/test/board/outage.test.ts (same name) | D-AG-17, D-AG-18, D-AG-20, D-AG-23 |
| "a tool call for a board this window was given without being told asks for it first; one it does not hold is refused" | b | packages/core/test/board/outage.test.ts (same name) | D-AG-17 |
| "the tools of a section's agent name a board by its own id on that server, never by the page's key" | b | packages/core/test/board/outage.test.ts (same name) | D-AG-01, D-AG-22 |
| "get_view names the board on screen to an agent of the same server only: a board of another server is not named" | b | packages/core/test/board/outage.test.ts (same name) | D-AG-22, D-SL-01, D-SL-02 |
| "the context block of a section's board chat names its board and the boards mentioned by their own ids, and mentions only boards of that server" | b | packages/core/test/board/outage.test.ts (same name) | C-MN-07, D-SL-04 |
| "get_image returns the text with the bounds and the count, and the PNG as base64" | b | packages/core/test/board/image.test.ts "get_image returns the text with the bounds and the count, and the PNG as base64; the view is sent the chosen elements and bound text" | D-EX-01 |
| "get_image gives exportToBlob the live elements, the scene's files and the options, without the canvas" | b | packages/core/test/board/image.test.ts "get_image on a board off screen sends the kept scene, its files and the saved view state, and the options; on screen the target is the live scene" | D-EX-09, D-CT-04 |
| "get_image: scale above 2 is used as 2; a bad scale, background or scope is BAD_ARGS" | b | packages/core/test/board/image.test.ts "get_image: scale above 2 is used as 2; a bad scale, background or scope is BAD_ARGS and no export request is sent" | D-EX-09 |
| "get_image: an empty board, or one of only deleted elements, is EMPTY and draws nothing" | b | packages/core/test/board/image.test.ts "get_image: an empty board, or one of only deleted elements, is EMPTY and no export request is sent" | D-EX-11 |
| "get_image: a picture above the limit is TOO_LARGE with the limit named, and no canvas is made" | b | packages/core/test/board/image.test.ts "get_image: a refusal TOO_LARGE of the view keeps its code and its text, with the limit named; the scale it asked at is in the request" | D-EX-10 |
| "get_image: the limit is checked on the size Excalidraw measures, and the bounds in the text are that size" | b | packages/core/test/board/image.test.ts "get_image: the bounds in the text are the box the view measured, a frame's name above it included, rounded to whole numbers"; packages/board-view/test/export.test.ts "get_image: the limit is checked on the size Excalidraw measures, before the canvas exists" (added) and packages/board-view/test/imagesize.test.ts "pictureSize…" | D-EX-10 |
| "get_image: an AI frame (magicframe) is measured like a frame: its name is above it and its children are clipped" | b | packages/core/test/board/image.test.ts "get_image: an AI frame (magicframe) and a child that sticks out of it are named; the side does not size the picture by the child" | D-EX-10 |
| "get_image: a child of a frame that sticks out of it does not stretch the picture, as Excalidraw clips it" | b | packages/core/test/board/image.test.ts "get_image: a child of a frame that sticks out of it does not stretch the picture: the text has the view's bounds, not the child's"; packages/board-view/test/imagesize.test.ts "rootElements: a child of a frame that is drawn adds nothing to the size" | D-EX-10 |
| "get_image: a scale that would make the picture under 1 px on a side is BAD_ARGS, and any other is rounded up to whole pixels" | b | packages/core/test/board/image.test.ts "get_image: a scale that would make the picture under 1 px on a side is the view's BAD_ARGS, passed through; any scale is sent as it is"; packages/board-view/test/export.test.ts (added) and imagesize.test.ts "pictureSize…" | D-EX-09 |
| "get_image on a board this window does not hold is NOT_HOLDER, and on an unknown board NO_BOARD" | b | packages/core/test/board/image.test.ts (same name) | D-EX-16 |
| "get_image refs: a key and an id in one call draw exactly those elements and their bound text" | b | packages/core/test/board/image.test.ts (same name) | D-EX-07 |
| "get_image refs: an id shortened to a unique prefix works as in apply; an ambiguous or unknown one is UNKNOWN_REF" | b | packages/core/test/board/image.test.ts (same name) | D-AG-08, D-EX-07 |
| "get_image refs: any ref that matches nothing is UNKNOWN_REF, naming it, and nothing is drawn; a deleted element does not match" | b | packages/core/test/board/image.test.ts "get_image refs: any ref that matches nothing is UNKNOWN_REF, naming it, and nothing is sent; a deleted element does not match" | D-EX-07 |
| "get_image refs: no refs, or a ref without key and id, is BAD_ARGS" | b | packages/core/test/board/image.test.ts (same name) | D-EX-07 |
| "get_image rect: only elements completely inside are drawn, arrows by every point; none inside is EMPTY" | b | packages/core/test/board/image.test.ts "get_image rect: only elements completely inside are named, arrows by every point; none inside is EMPTY" | D-EX-08 |
| "get_image rect: a missing or invalid rect is BAD_ARGS" | b | packages/core/test/board/image.test.ts (same name) | D-EX-08 |
| "get_image selection: draws the selected elements of the board on screen, with the bound text of the selected containers" | b | packages/core/test/board/image.test.ts "get_image selection: names the selected elements of the board on screen, with the bound text of the selected containers" | D-EX-04 |
| "get_image selection: a selected frame is drawn alone; its children are not added" | b | packages/core/test/board/image.test.ts "get_image selection: a selected frame is named alone; its children are not added" | D-EX-04 |
| "get_image selection: nothing selected, or the board is not on screen, is NO_SELECTION naming all, refs and rect" | b | packages/core/test/board/image.test.ts (same name) | D-EX-05 |
| "get_image default scope: the selection when the board is on screen and something is selected, else all; the text says which" | b | packages/core/test/board/image.test.ts (same name) | D-EX-06 |
| "get_image: all, refs and rect work on a board that is not on screen (its stored scene), while another board is live" | b | packages/core/test/board/image.test.ts "get_image: all, refs and rect work on a board that is not on screen (its kept scene), while another board is on screen" | D-EX-03 |
| "get_image leaves the scene, its version, the selection and the autosave state alone" | b | packages/core/test/board/image.test.ts (same name) | D-EX-15 |
| "get_image: an exportToBlob that throws is a RENDER_FAILED text error, not a bare rejection" | b | packages/core/test/board/image.test.ts "get_image: any other failure of the view, a thrown error or a view that went away, is RENDER_FAILED with the text of the failure"; packages/board-view/test/export.test.ts "get_image: an exportToBlob that throws is a RENDER_FAILED text error…" (added) | D-EX-14 |
| "get_image waits for document.fonts.ready before it draws, and survives a fonts promise that rejects" | b | packages/board-view/test/export.test.ts "get_image waits for the fonts to be ready before it draws, and draws also when the fonts promise rejects" (added) | D-EX-13 |
| "get_image: a board that leaves the screen while the fonts load still draws the selection it took" | b | packages/core/test/board/image.test.ts "get_image: a board that leaves the screen while the picture is drawn still gets the answer of the selection it took" | D-EX-13 |
| "get_image pads the picture by EXPORT_PADDING" | b | packages/board-view/test/export.test.ts "get_image pads the picture by EXPORT_PADDING…" (added) | D-EX-12 |
| "get_image: a rotated element is sized, reported and tested for containment by its rotated box" | b | packages/core/test/board/image.test.ts "get_image: a rotated element is measured by the view; the limit on the rotated size is the view's refusal, passed through"; and "get_image rect: a rotated element is inside the rect by its rotated box"; packages/board-view/test/imagesize.test.ts "imageBounds: …rotated elements by their corners" | D-EX-08 |
| "get_image: chosen elements that are all zero-size are EMPTY and exportToBlob is not called" | b | packages/core/test/board/image.test.ts "get_image: chosen elements that are all zero-size are EMPTY and no export request is sent" | D-EX-11 |
| "get_image: a zero-size element among real ones is not drawn, not measured and not counted" | b | packages/core/test/board/image.test.ts "get_image: a zero-size element among real ones is not named, not measured and not counted" | D-EX-11 |
| "get_image: a straight line has an extent in one direction, so it passes the EMPTY check and is drawn" | b | packages/core/test/board/image.test.ts "get_image: a straight line has an extent in one direction, so it passes the EMPTY check and is named" | D-EX-11 |
| "get_image: rotated text is measured by its rotated box" | b | packages/core/test/board/image.test.ts "get_image: rotated text is measured by the view, its rotated box is in the text" | D-EX-12 |
| "get_image refs: an ambiguous id prefix says ambiguous, a missing one says no element matches, both can be in one message" | b | packages/core/test/board/image.test.ts (same name) | D-EX-07 |

### sectioncalls.test.ts

17 tests: 1 core only, 15 old page, 1 mixed.

| old test (`sectioncalls.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "shownAhead and putBack: what a section's server told last is put back, unless it told its groups since" | a | `packages/core/test/sectioncalls.test.ts` (same name) | A-DD-12 |
| "a group of a section renamed ahead of its server is put back when the call is refused 503 server_unreachable, and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section renamed ahead of its server is put back when the call is refused 404 not_found, and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section renamed ahead of its server is put back when the call is refused 404 no_server, and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section renamed ahead of its server is put back when the call is refused 502 bad_answer, and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section renamed ahead of its server is put back when the call is refused 504 no_answer, and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section renamed ahead of its server is put back when the call is refused 400 (the server's own), and the refusal is said" | b | SEC.5@d,t,p (a group of a section is renamed on that server: the call's server is the entry, and its path has that server's own ids); app/test/sidebar.calls.test.ts (added, same name): screens/sidebar/actions.ts renameGroup over a stub api, the section shows it at once and what its server has when the call is refused (the six refusals of the contract), the refusal said in that server's words with only Close, the groups of the same ids elsewhere untouched; packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39 |
| "a group of a section moved ahead of its server is put back when the call is refused or gets no answer" | b | SEC.5@d,t,p (a drag inside a section is asked of that server); A3.2@d,t, A3.3@d,t (a drop made during the call); app/test/sidebar.calls.test.ts (added, same name) (moveGroup, every refusal); packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" | A-SB-39, A-DD-12 |
| "a change that was made after all, its answer lost: the server's `groups` event stands, and the late refusal puts nothing back" | b | app/test/sidebar.calls.test.ts (added, same name) (the server's groups event stands, the late refusal puts nothing back, and is still said); packages/core/test/sectioncalls.test.ts "shownAhead and putBack: what a section's server told last is put back, unless it told its groups since"; SEC.6@d,t,p (a group made or renamed elsewhere shows) | A-DD-12 |
| "two changes ahead of the server, both refused: the section shows what the server has, not the first change" | b | app/test/sidebar.calls.test.ts (added, same name) (both refused: the section shows what the server has); packages/core/test/sectioncalls.test.ts "shownAhead and putBack…" (the truth is the first one's) | A-SB-39 |
| "a change that worked is left as shown until that server's event says the same; the section's tree going during the call puts nothing back" | b | app/test/sidebar.calls.test.ts (added, same name) (a change that worked stays as shown; the section's tree going during the call puts nothing back); SEC.6@d,t,p, SEC.2@d,t,p (the tree going and coming back) | — |
| "a rename or a move is not sent across servers, and a group of this computer is renamed as before" | b | SEC.5@d,t,p (a drag from a section into another, into the local part and from it lights nothing and makes no call, for a row and for a group; a group of this computer is renamed as before); app/test/dragdrop.test.ts "dropEventAt: only what is on the zone's own server is taken" | — |
| "a rename of a section's chat that its server refuses, or does not answer, is said; the name is the one that server has" | b | app/test/sidebar.calls.test.ts (added, same name: renameChat over a stub api, every refusal is said by reportError, the name is the one that server has, a chat of this computer with the same id is its own call); app/test/wiring.test.ts (same name: the name box renames through renameChat); SEC.8@d,t,p (a rename of one chat never touches the other) | A-SB-29 |
| "a Send to a section's chat that is answered 404 not_found says that the chat is no longer on that server" | c | core half: `packages/core/test/sectioncalls.test.ts` (same name); old-page half: packages/core/test/sectioncalls.test.ts (same name: goneBySend); app/test/wiring.test.ts (same name: the composer marks the chat gone); SEC.10@d,t,p (a chat gone from its server: Send off, the sentence) | — |
| "the answer of the removal is here before the list's event: what is open of that server is closed by the answer" | b | L7@d,t,p (remove: the entry goes, its section leaves the sidebar (added), the server is told nothing); packages/core/test/sections.test.ts "an entry leaves the server list: everything the page has of its server goes…"; the order of the answer and the event: packages/core/test/serversdialog.test.ts "add: the events before the answer, and the answer before the events…" | A-SC-20 |
| "the list's event is here before the answer of the removal: the event closes it, and the answer finds the entry gone" | b | packages/core/test/sections.test.ts "an entry leaves the server list…" (the event closes what is open; the answer finds the entry gone); L7@d,t,p | A-SC-20 |
| "the section's event with no tree is here first, as in an outage: the chat stays until the list says that the entry is gone, by the answer or by the event" | b | SEC.7-drop@d,t,p/SEC.2@d,t,p (a server's section without a tree keeps what is open: the chat stays); packages/core/test/sections.test.ts; app/test/wiring.test.ts (same name: the removal's run calls entryRemoved) | — |

### sectiongone.test.ts

4 tests: 1 core only, 1 old page, 2 mixed.

| old test (`sectiongone.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "no file of the page names a code the local server no longer sends" | c | core half: `packages/core/test/sectiongone.test.ts` (same name); old-page half: packages/core/test/sectiongone.test.ts (same name: core's files); app/test/gone.test.ts (added: the new build's, whole) | — |
| "no file of the page has an event, a field or a call that went away" | c | core half: `packages/core/test/sectiongone.test.ts` (same name); old-page half: packages/core/test/sectiongone.test.ts (same name); app/test/gone.test.ts (added) | — |
| "the views that went away are not there: the question about the place, the row of a thing that was gone, the removal from the sidebar alone" | b | app/test/gone.test.ts "the views that went away are not there…" (added) | — |
| "no type of a thing names its server, or says that it is gone, not moved, started elsewhere or was something" | a | `packages/core/test/sectiongone.test.ts` (same name) | — |

### sections.test.ts

35 tests: 35 core only, 0 old page, 0 mixed.

| old test (`sections.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "every entry of the list but this computer's gets a section, in the order of the list" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a connected section with its tree draws its rows, says Connected and offers its +" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a connected server with nothing on it says so in a line" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-07 |
| "a connected server whose things are all archived does not say that it has nothing: it says that they are archived" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-08 |
| "until the tree has come the section says that it is connecting, and shows no rows and no +" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-06 |
| "a server that is not connected says its state, in the server list's words, and the one line; no rows, no +" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-10 |
| "a server that is too old says so, that it must be updated on that machine, and the version it reports; nothing else" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-11 |
| "rows follow the tree and words the state: the two events come in no fixed order" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-06 |
| "the local part is the local server's tree: nothing of a section is in it, also with the same ids there" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a section shows its server's tree as that server has it: the groups nested the same way, the loose items, everything by its key" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "Show archived is one switch: a section's archived group and what is in it show with it" | a | `packages/core/test/sections.test.ts` (same name) | A-SB-07 |
| "a section of another server is empty of this one's things, and a tree with nothing in it is empty" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "what is no longer on its server has no row, though the page still holds it on screen" | a | `packages/core/test/sections.test.ts` (same name) | A-SC-17 |
| "thingsOn: the entries of a map that are on one server" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a tree arrives: the section is held, and its things are in the store beside this computer's, each under its key" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a chat of a run (from a server that still has runs) is not kept: a tree that names one does not make it a sidebar chat" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a tree that arrives again replaces what the page had for the entry: what is not in it goes, another section's stays" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree goes: nothing of that server is known any more, and its section has no tree" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree goes with a chat open: the chat and its branch records stay as the page has them, not marked gone; the rest goes" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree goes with a board and its chat on screen: they stay" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree goes with a board changed and not saved: the board stays in the page's memory, on screen or not, until the server is back" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree is back: the open chat is level with it; one that is no longer in it stays on screen, marked gone" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "the tree is back without a board that had an unsaved edit and is not on screen: the board is gone, and goes" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "a thing that was marked gone and is in a tree again is there again" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "once the user leaves what stayed on screen it goes; what has a tree and is there stays" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "onScreen: the selected board and chat" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "this computer is a server like the others: its things are left behind when its tree is not held, except a board with an edit and a chat with a draft kept" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "reachable: a thing of any server while its tree is held and the thing is there; this computer's tree is `connected`" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "reachable: a section's while its tree is held and the thing is there" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "collapse is stored as a list of keys under aiwb.collapsed; anything unreadable is nothing collapsed" | a | `packages/core/test/sections.test.ts` (same name) | A-SG-03 |
| "a section and a group in it collapse and expand each by its own key; nothing changes gives the same map" | a | `packages/core/test/sections.test.ts` (same name) | A-SG-03 |
| "a collapsed section of a server that is not connected stays collapsed, with its groups; a group that is gone from a tree that is held goes" | a | `packages/core/test/sections.test.ts` (same name) | A-SG-04 |
| "an entry removed from the server list takes its collapse with it, the section's and its groups'" | a | `packages/core/test/sections.test.ts` (same name) | A-SG-04 |
| "an entry leaves the server list: everything the page has of its server goes, what is on screen and a board with an unsaved edit too; another server's and this computer's stay" | a | `packages/core/test/sections.test.ts` (same name) | — |
| "prunedLocalGroups: this computer's snapshot drops the groups it no longer has, and keeps the entries of the list, whatever their ids" | a | `packages/core/test/sections.test.ts` (same name) | A-SG-04 |

### sectionstorage.test.ts

4 tests: 0 core only, 0 old page, 4 mixed.

| old test (`sectionstorage.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the page reaches the browser's storage through the store's four functions and the kv port alone (kv.ts), and has no other storage" | c | core half: `packages/core/test/sectionstorage.test.ts` (same name); old-page half: packages/core/test/sectionstorage.test.ts (same name: core's files); app/test/storagescan.test.ts (added: the app's and core's) | — |
| "every key the page writes, by the place that writes it: a setting, a key of a thing, or content of this computer's alone" | c | core half: `packages/core/test/sectionstorage.test.ts` (same name); old-page half: packages/core/test/sectionstorage.test.ts (same name); app/test/storagescan.test.ts (added); SEC.9-storage@d,t,p (what the storage holds, in a browser) | A-SG-01 |
| "the two keys that hold content are written for this computer's things alone: an unsaved draft and the recent folders" | c | core half: `packages/core/test/sectionstorage.test.ts` (same name); old-page half: packages/core/test/sectionstorage.test.ts (same name); app/test/storagescan.test.ts (added); SEC.9-storage@d,t,p | A-SG-01, C-DR-06, C-CH-11 |
| "the board layer, the canvas, the uploads and the event layer write nothing to the browser's storage" | c | core half: `packages/core/test/sectionstorage.test.ts` (same name); old-page half: packages/core/test/sectionstorage.test.ts (same name); app/test/storagescan.test.ts (added); SEC.9-storage@d,t,p | A-SG-01 |

### sectionstore.test.ts

25 tests: 25 core only, 0 old page, 0 mixed.

| old test (`sectionstore.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "what the browser kept of the collapse is read when the page loads" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "a local chat and a section's chat with the same id are two chats, each under its own key, with its own records" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SC-18 |
| "removing the local one of two things with the same id leaves the section's, and the other way round" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "a snapshot replaces this computer's part and leaves what the page has of a section, its threads too" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "the names of an agent's boards and the boards a chat can mention are those of the chat's own server" | a | `packages/core/test/sectionstore.test.ts` (same name) | C-MN-02 |
| "a section's tree goes: its things go from the store, and the board layer forgets its boards" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "the tree goes with a chat open: the chat, its thread, its tree and its records stay as the page had them; a snapshot does not close it either" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "once the user leaves what stayed on screen it is gone from the store, with its thread; it cannot be opened until the server is back" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SC-24 |
| "the tree is back without the open chat: it stays on screen, marked gone; a `chat` of it would unmark it; leaving drops it" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "a board changed and not saved stays in the page's memory while its server is away, on screen or not, and is not forgotten" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "the selection is kept in the browser by key; a snapshot of this computer leaves a section's, which its own tree judges when it comes" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-02 |
| "a selection of a thing of this computer is judged by its own snapshot, and one of a section is not touched by it" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-02 |
| "a selection of a chat of a run in a section's tree is dropped: a server that still has runs names it, and the page keeps none" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-02 |
| "an entry removed from the server list, with a selection of it never loaded: the selection goes" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-02 |
| "what is typed in a section's chat and not saved yet is kept in the page's memory alone; a local chat's is in the browser's storage" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "the memory copy of a section's draft goes with its chat, and a local chat's stored copy with its own" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-07, C-DR-06 |
| "with the first snapshot the browser's storage is cleared of what it kept of other servers before: drafts of chats this computer does not have, and their recent folders" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-06 |
| "the collapse of this computer's section and groups is kept like a section's, and its own snapshot judges its groups" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "collapse of a section and of a group in it is kept in the browser under aiwb.collapsed, by key" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-03 |
| "a collapsed section of a server that is not connected stays collapsed with its groups; a group its server no longer has goes when the tree is here" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "an entry removed from the server list takes its collapse with it" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "a section's groups and defaults follow their events only while its tree is held" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "two sections with the same ids are apart: one's tree going leaves the other's" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "the chat a board reopens with is kept by both keys: a board of the same id here and in two sections each have their own, and nothing of a chat is kept" | a | `packages/core/test/sectionstore.test.ts` (same name) | — |
| "this computer's server away: what is left goes, but a chat with a draft the browser keeps stays, and so does its copy; the snapshot brings the tree back" | a | `packages/core/test/sectionstore.test.ts` (same name) | A-SG-07 |

### sectionviews.test.ts

25 tests: 2 core only, 13 old page, 10 mixed.

| old test (`sectionviews.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a section's chat that is connected has the view of a local one: no warning, a Send that works, and its server's name in the toolbar" | b | SEC.7-drop@d,t,p (connected: the header names the server, Send works, no warning); AAC.3-remotedown@d,t,p (this computer's chat: no warning, no server's name); A2.3-places@d,t,p (the server chip is the first control of a section's chat) | — |
| "the server drops with a chat open: the chat stays on screen as it was, read-only, under a warning that names the server and says that it is not connected" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-drop@d,t,p, AAC.2-localdown@d,t,p (the thread as it was, the warning with the server's name and its state, "Servers…", no status, Send off with the reason, the line under the toolbar, the row gone from the sidebar: AAC.2-localdown@d,t,p); SEC.10@d,t,p | A-ST-04 |
| "a busy chat whose server drops shows no live status and no Stop: what is on screen is as it was" | b | SEC.10@d,t,p (no Stop in the composer while the server is away; the header has no status: SEC.7-drop@d,t,p) | C-TX-15 |
| "an unstarted chat whose server drops offers no agent, folder, model or settings to change: each is a fixed chip that says why" | b | SEC.7-drop@d,t,p (no choice of the toolbar is a choice: every chip fixed or disabled; the line under the toolbar says why), AAC.2-localdown@d,t,p | C-CH-23, C-SS-11 |
| "a local chat is untouched by a section's outage" | b | AAC.3-remotedown@d,t,p (the chat of this computer has no warning and no line under the toolbar while a remote server is away) | — |
| "the server is back: the open chat is read again and brought level, the warning goes and the composer works again" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-drop@d,t,p (back: the chat is level with its server, the message made meanwhile once, the warning gone, Send on, the typed text saved once); packages/core/test/sectionviews.test.ts (the calls, same name) | A-ST-09 |
| "the server is back and the open chat was deleted meanwhile: the view says that it is no longer on that server, and takes nothing" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-drop@d,t,p (back, deleted meanwhile: "This chat is no longer on Studio Mac.", no "Servers…", the thread on screen, Send off); SEC.10@d,t,p | A-ST-11 |
| "a chat deleted on its server by anyone while it is open: the view stays and says so; one that is not open leaves at once" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.10@d,t,p (deleted on its server while open: the warning of the kind gone, no rename, no call); SEC.6@d,t,p (a chat deleted elsewhere leaves no row) | — |
| "a section's chat that could not be read because it is gone there says so in place of its thread" | b | L10@d,t,p (no thread kept: a load that failed says so with "Try again"; a server away before the thread came says that the chat shows again when it is back); the "gone" kind (not_found): packages/core/test/remoteview.test.ts "remoteView: gone, by the load's code not_found or the page's mark" and L10 (added: a read answered 404 not_found is the gone kind) | — |
| "a section's board whose server is away and which this window keeps no drawing of says that it opens when the server is back; one deleted there says so" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-board@d,t,p (added: a board whose drawing was never read, its server away: the view in the canvas's place says "Studio Mac is not connected" and "It opens when the server is connected again.", with Servers…; back it opens; deleted there: "No longer on Studio Mac") | A-ST-08 |
| "once the user leaves what stayed on screen it cannot be opened again until the server is back" | b | SEC.7-drop@d,t,p (left during the outage the chat is closed and the selection names nothing of it; back, the chat opens as usual) | — |
| "a snapshot while a section has no tree (the page's own stream came back) closes nothing that is on screen" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-drop@d,t,p (added: the mock's snapshot comes again while the server is away; the chat stays as it was, and nothing is asked of that server) | A-ST-20 |
| "a chat shown as it was offers no Branch, Fork or Label on a message, and a permission request that waits has no buttons and says why" | b | SEC.10@d,t,p (no Branch, Fork or Label on a message; the permission request has no buttons and says why, Allow and Don't when connected); L13@d,t,p (the permission card read-only) | A-ST-12 |
| "the fork actions of a chat shown as it was do nothing: no fork, no label, no branch and no other branch, by a button or by a key" | a | `packages/core/test/sectionviews.test.ts` (same name) | A-ST-12 |
| "the tree of a chat shown as it was is read-only: no row opens, branches, forks, labels or stops, and its foot says why" | b | SEC.10@d,t,p (the tree opens to be read: no row opens, no menu, no Stop, the foot says why, every row held) | A-ST-12 |
| "a chat shown as it was stays on the branch and at the point it shows: the header's way to another branch and the banner's Back are off, and say why" | b | SEC.10@d,t,p (the header's way to another branch and the pending move's Back are off and say why; Back does nothing; back, it undoes the move) | — |
| "an empty chat that is no longer on its server offers no message to send" | b | SEC.10@d,t,p / SEC.7-drop@d,t,p (a chat deleted on its server offers no message to send); L10@d,t,p (the empty thread of a chat that takes no message says why) | C-RO-03 |
| "an archived chat shown as it was is not unarchived from its composer: the bar says why" | b | SEC.10@d,t,p (added: an archived chat of the section has Unarchive when connected; its server dropped, the bar has none and says why; back, it has it again) | C-RO-07 |
| "the composer of a chat shown as it was opens no prompt to insert, and a subagent whose thread the page does not have says why in place of loading" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.10@d,t,p (the Insert button is off while the server is away); L19@d,t,p (the Subagents chip of a chat whose server is away is fixed, with the reason); packages/core/test/sectionviews.test.ts (the calls: nothing is asked for the subagent's thread, same name). Unshown in a browser: the drawer of a subagent whose thread the page does not have says why in place of Loading… (screens/subagents/Drawer.tsx reads useOffWhy; a test would need a seeded drawer on a chat whose server drops) | C-RF-25, C-RO-02 |
| "the warning over an open chat says why the server is not connected, in the server list's words: unreachable, too old, a state that waits for the user" | b | SEC.7-drop@d,t,p (the warning says the state's word, "Unreachable", and "Servers…"); the words of every state: packages/core/test/remoteview.test.ts "remoteView: a thread on screen stays, read-only, under a warning that says the entry's state in the server list's words" | A-ST-04 |
| "a `section` with no tree that comes twice, and a `server_state` in any order with it, close nothing that is open: a chat, a board" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.7-drop@d,t,p (the thread unchanged when the server drops; the snapshot again: added); packages/core/test/sectionviews.test.ts (the selection, the thread and the calls, same name) | — |
| "an entry removed from the server list is no outage: what is open of that server closes with its section, whichever of the two events comes first" | b | L7@d,t,p (remove: the entry's section leaves the sidebar, added); packages/core/test/sections.test.ts "an entry leaves the server list: everything the page has of its server goes, what is on screen and a board…" | A-SC-20 |
| "what another client or the owner does in a section's chat shows in the open view: the thread grows, the settings change, a Stop ends the work, an answered request loses its buttons" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.8@d,t,p/SEC.6@d,t,p (events from elsewhere shown without a reload); L13@d,t,p (a permission request decided elsewhere has no buttons and says Approved); L8-stream@d,t,p; packages/core/test/sectionviews.test.ts (the store and the calls, same name). The settings of an unstarted chat changed on another page: L16-composer@d,t,p (added: the folder chip follows a chat event from elsewhere; the store half is core's) | — |
| "the draft of a section's chat follows the other writers by that server's counter, and the counter the page has never goes down by its own doing" | a | `packages/core/test/sectionviews.test.ts` (same name) | — |
| "deleted on its server with its chat open: a chat on a board says so with its board, nothing can be sent, and leaving drops it" | c | core half: `packages/core/test/sectionviews.test.ts` (same name); old-page half: SEC.10@d,t,p (deleted on its server while open), SEC.6@d,t,p (nothing deleted left a row), SEC.7-board@d,t,p (added: a board deleted there while open: "No longer on Studio Mac") | — |

### sendend.test.ts

6 tests: 3 core only, 2 old page, 1 mixed.

| old test (`sendend.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "refusalShown: a Send refused for a server not connected says so only while that server is not connected (the browser run T109)" | a | `packages/core/test/sendend.test.ts` (same name) | C-RO-11 |
| "sentNothing: a refusal below 500 took no message, and neither did the 503 of a server that is not connected; another 5xx may hide one that was taken" | a | `packages/core/test/sendend.test.ts` (same name) | C-RO-12 |
| "the refusals of the move that carried a chat over to its server are gone with it" | b | app/test/wiring.test.ts (same name) | — |
| "underComposer: the last refusal's sentence, else the chat's own error, and nothing else" | c | core half: `packages/core/test/sendend.test.ts` (same name); old-page half: L16-composer@d,t,p (a refused Send says why under the composer); app/test/wiring.test.ts (same name); packages/core/test/sendend.test.ts (same name) | C-RO-09 |
| "putsBack: a failed Send's message goes back unless its draft was removed on the server meanwhile" | a | `packages/core/test/sendend.test.ts` (same name) | C-TX-08 |
| "the composer shows a refusal by refusalShown, and nothing stands in the thread's place for a message on its way" | b | app/test/wiring.test.ts (same name); L16-composer@d,t,p; A4.4-ends@d,t,p (nothing stands in the thread's place for a message on its way) | — |

### serverlists.test.ts

14 tests: 13 core only, 1 old page, 0 mixed.

| old test (`serverlists.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "serverOf: the entry id the thing's key names, and this computer for a key that names none" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "listsOf: the local server's from the store's own fields, another's as received" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "listsOf keeps another server's lists while it is not connected; offered gives them only while the page holds that server's tree" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "serverName: This computer, or the entry's name" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "sectionName: the name of the section a thing is in, and none for a thing of this computer" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "RECENT_KEY: this computer's recent folders have the one key in the browser; no other server has one" | a | `packages/core/test/serverlists.test.ts` (same name) | A-SG-09 |
| "serverFixed: a chat's server is never a choice, and its chip says why" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "a chat's server is no choice: the lists hold nothing to choose one with" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "server_lists: an entry's lists are set, and removed for null" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "a thread's load error keeps the server's code and sentence; it is set and cleared by chat" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "a section's tree arrives: what goes of that server's chats, and what is read again" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "a section's tree arrives: a chat that is no longer on that server is none of them, and what the page shows of it stays" | a | `packages/core/test/serverlists.test.ts` (same name) | — |
| "a subagent's model is named by the catalog of its chat's server" | b | L19-subagents@d,t,p (the rows, the stats, the drawer); app/test/wiring.test.ts (same name) | — |
| "withoutThread: a list goes with its subagents' threads, a subagent's thread alone; another branch and another chat stay" | a | `packages/core/test/serverlists.test.ts` (same name) | — |

### servers.test.ts

22 tests: 21 core only, 1 old page, 0 mixed.

| old test (`servers.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "stateLabel: each of the twelve states has its label (the twelfth, `not_started`, is this computer's alone)" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-03 |
| "rowActions: the local entry has none" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-06 |
| "rowActions: a too old server can be tested, edited and removed, and nothing connects it anyway" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-06 |
| "rowActions: every remote entry has test, edit and remove; accept is offered for a certificate alone" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-06 |
| "formError: the first problem, and an empty secret in an edit alone" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-17 |
| "formView: Save only after an OK test of the form as it is" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-19 |
| "formView: Save anyway without a test or after a failed one, but not past these four outcomes or a form error" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-19 |
| "formView: a fingerprint to accept for `fingerprint` and `cert_changed`, the second with both" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-19 |
| "removeText: names the entry, says that its section leaves the sidebar and that nothing is deleted on that server, and counts nothing" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-15 |
| "the question before a removal asks the server for nothing: the entry is removed, and that server is told nothing" | b | L7@d,t,p (remove: the question in its words, no call to that server); app/test/wiring.test.ts (same name) | A-SV-15 |
| "serversOf: a snapshot without the field gives the local entry alone" | a | `packages/core/test/servers.test.ts` (same name) | — |
| "upsertServer: replaces the entry with the id in its place, or adds it at the end" | a | `packages/core/test/servers.test.ts` (same name) | — |
| "anyNotConnected: the dot shows for any entry that is not connected" | a | `packages/core/test/servers.test.ts` (same name) | A-SB-08 |
| "insertServer: adds an entry the list lacks, and leaves one it has as it is" | a | `packages/core/test/servers.test.ts` (same name) | — |
| "stepText: the five steps by name, and nothing for another number" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-07, A-SV-08 |
| "validHost: the server's rule (remote.NormalName)" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-17 |
| "validAddress and formError: what the server's address parser takes, and no more" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-09, A-SV-17 |
| "rowResult: a test's answer adds only what the row's own lines do not say" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-07 |
| "rowResult: the message is dropped when it is the row's state label or its detail line, and kept otherwise" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-07 |
| "resultHeading: the message the row does not show, or else whether the test passed" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-07 |
| "heldResult: a test's answer is shown while the entry has the state it had when the answer came" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-07 |
| "formView: an edit of the name alone is saved without a test and with no Save anyway; any other change keeps the rule" | a | `packages/core/test/servers.test.ts` (same name) | A-SV-22 |

### serversdialog.test.ts

25 tests: 4 core only, 18 old page, 3 mixed.

| old test (`serversdialog.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "the exports of the contract" | b | n/a as a test: the old page's module surface; the shell imports ServersButton, ServersDialog and openServers from screens/servers/index.ts, so cd app && npm run check proves they exist | — |
| "the store starts with the local entry, no notice and the dialog closed" | c | core half: `packages/core/test/serversdialog.test.ts` (same name); old-page half: L7@d,t,p (no dialog before the Servers button is pressed); the store half: packages/core/test/serversdialog.test.ts (same name) | — |
| "openServers opens the dialog, with a form when one is given" | c | core half: `packages/core/test/serversdialog.test.ts` (same name); old-page half: L7@d,t,p (Add server shows the form, titled Add server); L3-addserver@phone (the form filled from a paste); the store half: packages/core/test/serversdialog.test.ts (same name) | A-SV-01 |
| "the button has a dot only while an entry is not connected" | b | SEC.1@d,t,p (the Servers button says that an entry is not connected, dot and title); A1.5-notices@d,t | A-SB-08 |
| "the dialog lists the rows with state, version, fingerprint and agents, on its own backdrop" | b | L7@d,t,p (this computer first, each row's name, state, address, detail, version and agents; the notice; Esc, the dimmed page and Close close it) | A-SV-02 |
| "the local row has no Edit and no Remove, and no test: it has the owner's things; a remote row has Edit, Remove and the test" | b | L7@d,t,p (this computer's row: Restart server alone, no Edit, Remove or Test; a remote row has the three); AAC.1@d,t,p (not started: Restart server and Retry) | A-SV-06 |
| "this computer's row: the reason a start gave as plain text, the state of its MCP listener, Restart server while one runs" | b | L7@d,t,p (owner's things: the reason as text with twelve lines and a mark, the MCP listener (up) and (down), Retry that fails and works, Restarting… with the button off, the question while an agent works; a restart that fails: added) | A-OW-13 |
| "each state's row shows its label" | b | L7@d,t,p (the twelve states' words and tones live); SEC.2@d,t,p | A-SV-02 |
| "a changed certificate shows both fingerprints and offers to accept; one not accepted yet is read first" | b | L7@d,t,p (a changed certificate: "Accepted before …" and "Presented now …", Accept fingerprint; Show fingerprint then Accept fingerprint for one not accepted yet) | A-SV-06 |
| "what another server said comes out as text: a row's version, detail, agents, name and fingerprints" | b | L7@d,t,p (a name, version, agents and notice with markup in them are drawn as text; the reason of a start) | A-SV-24 |
| "what another server said comes out as text: a test's message, detail, version, agents and fingerprints" | b | L7@d,t,p (added: a test whose message, detail, version, agents and fingerprints have markup in them is drawn as text, in the row) | A-SV-24 |
| "the add form: the fields, the secret as a password without autocomplete, and Save only after a test" | b | L7@d,t,p (add: the fields and their placeholders, the secret a password field that is left out of autofill, Save only after an OK test of the form as it is, Save anyway after a failed one, an empty form offers neither) | A-SV-16 |
| "the edit form: the secret is empty with the placeholder `unchanged`" | b | L7@d,t,p (edit: the form starts from the entry, the secret empty with the placeholder "unchanged") | A-SV-22 |
| "the form after a test: Save after an OK one; Accept fingerprint for a certificate to compare; no Save anyway for a duplicate" | b | L7@d,t,p (an OK test makes Save; a failed one Save anyway; the outcomes with no way past; the fingerprint to accept) | A-SV-18 |
| "the app's events: `servers` replaces the list and the notice, `server_state` one entry; a snapshot of this computer leaves the list as it is" | a | `packages/core/test/serversdialog.test.ts` (same name) | A-SV-04 |
| "a row after its test shows each fact once: the version, the detail, the agents and the fingerprints" | b | L7@d,t,p (test connection: the block under the row repeats nothing the row says; "connection refused" once) | A-SV-07 |
| "a failed test shows its step, in the row and in the form; one that passed shows none" | b | L7@d,t,p (the five steps by name, in the row and in the form; a test that passed shows none) | A-SV-07 |
| "a row after its test repeats nothing the row says: the block leads with whether the test passed" | b | L7@d,t,p (the block starts "Test passed"; a failed one "That did not work: step n") | A-SV-07 |
| "the edit form as saved has Save disabled; the form is judged against the saved entry, and a rename's Save sends force" | b | L7@d,t,p (edit: Save is off before something changed; a rename alone turns it on, sends only the name with force, and tests nothing) | A-SV-22 |
| "add: the events before the answer, and the answer before the events, both end with the stream's state" | c | core half: `packages/core/test/serversdialog.test.ts` (same name); old-page half: the store half is core's: packages/core/test/serversdialog.test.ts (same name); the row drawn from it: L7@d,t,p (a new entry reads Connected when the stream's state comes); app/test/wiring.test.ts "save and accept put their answer into the store through `answered` alone" | A-SV-20 |
| "edit: the answer never replaces what the stream delivered, in either order" | a | `packages/core/test/serversdialog.test.ts` (same name) | A-SV-22 |
| "accept: the answer never replaces what the stream delivered, in either order" | a | `packages/core/test/serversdialog.test.ts` (same name) | A-SV-14 |
| "the list read when the dialog opens gives the notice and the entries the store lacks, and replaces none" | a | `packages/core/test/serversdialog.test.ts` (same name) | A-SV-05 |
| "save and accept put their answer into the store through `answered` alone" | b | app/test/wiring.test.ts (same name: the ServerForm and ServerRow call `answered` alone, twice) | A-SV-14 |
| "Servers.tsx renders no HTML of its own making and no markdown" | b | app/test/wiring.test.ts (same name, on screens/servers); the screens are React Native's: L7@d,t,p (markup is drawn as text) | A-SV-24 |

### sidebar.test.ts

29 tests: 0 core only, 25 old page, 4 mixed.

| old test (`sidebar.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "with no other entry in the server list the sidebar is this computer's section, and nothing else" | b | SEC.1@d,t,p (this computer's section alone, no "Reconnecting…", no "New group" outside a menu, no update banner); AAC.1@d,t,p (its head: name, Connected, tone ok) | A-SB-02 |
| "this computer is the first section also when it is not the first in the list" | b | SEC.1@d,t,p (the order, and the list turned round); packages/core/test/localsection.test.ts "sidebarEntries: this computer's entry first and always, then the others in the order of the list" (a list that does not name it) | A-SC-01 |
| "each entry of the list has a section under this computer's, in the order of the list, with its name and state" | b | SEC.1@d,t,p (the sections in the list's order, their names, in the tree that scrolls above the foot); SEC.2@d,t,p (their state words) | A-SB-01, A-SB-06, A-SC-03 |
| "this computer's section holds only what lives on this computer: nothing of another section is in it, also where the ids are the same" | b | SEC.1@d,t,p (this computer's section has no row of Studio Mac's; the two chats with the id c_plain are one row each in their own part); SEC.8@d,t,p | — |
| "a connected section shows that server's tree: loose items first, its groups nested, a board with its chats" | b | SEC.2@d,t,p (Studio Mac's tree as its section draws it: loose items first, groups nested, a board with its chats; every group open whatever that server's page shows) | A-SB-10 |
| "a row in another section is the row of this computer's section and names no server: the section does" | b | SEC.1@d,t,p (no row of a section carries an element for a server's name); app/test/gone.test.ts (added) "the views that went away are not there…" ("Remove from this sidebar", the removal from the sidebar alone); AAC.2-localdown@d,t,p, SEC.7-drop@d,t,p (no greyed row: the rows go with the tree) | A-SB-43 |
| "a section's head is not a group's: no rename, no menu, not dragged; its + shows while the server is connected" | b | SEC.3@d,t,p (no rename, no menu, not dragged, nothing dropped on it); SEC.2@d,t,p (the "+" of a connected head); AAC.1@d,t,p (the "+" is off while this computer is not connected) | A-SC-04 |
| "a section says that it is connecting until its tree has come, and shows no rows" | b | SEC.2@d,t,p ("connecting", and "connected before its tree came": the state word, no rows, no "+") | — |
| "a connected server with nothing on it says so in a line" | b | SEC.2@d,t,p ("connected, nothing on the server": the one line, the "+") | — |
| "a connected server whose things are all archived says so, not that it has nothing; with Show archived its rows show and the line goes" | b | SEC.2@d,t,p (added: "Only archived things on this server.", not "Nothing on this server yet."; Show archived puts the row in and the line goes) | A-SC-08 |
| "a section of a server that is not connected says its state and the one line, and shows nothing else" | b | SEC.2@d,t,p (the eight states that wait: their words, the one line, no rows, no "+") | — |
| "a server that is too old says so, with the version it reports, and shows nothing else" | b | SEC.2@d,t,p ("too old": the state, "Update the server on that machine.", "Version 0.9.1", no rows) | — |
| "the tree goes (`section` with null): the rows go at once, no greyed row and no last view; the tree comes: they are there again" | b | SEC.2@d,t,p (Studio Mac dropped: no row or group, the one line; too old; back: the tree again), SEC.3@d,t,p (a server away and back: the groups as they were), AAC.2-localdown@d,t,p (this computer's section: the rows go, then they are whole again) | A-SC-15 |
| "what anyone changes on that server shows without a reload: a chat made, renamed, moved, archived and deleted; a group made, renamed and deleted" | b | SEC.6@d,t,p (a chat made, renamed and moved, a board made and renamed, a group made and renamed, a chat and a board deleted: each shown without a reload and without a call of the page); SEC.1@d,t,p ("Show archived" is one switch for every section: an archived row shows in both sections) | A-SC-16 |
| "an event of a section never changes the local thing of the same id, and a local event never a section's" | b | SEC.8@d,t,p (a rename and a delete of one never touch the other, by the page's own actions and by events from elsewhere); packages/core/test/keys.test.ts "the same id on this computer and in two sections is three things" | A-SC-18 |
| "an event that names an entry the page has no tree of is dropped" | c | core half: `packages/core/test/sidebar.test.ts` (same name); old-page half: the store half is core's: packages/core/test/sidebar.test.ts "an event that names an entry the page has no tree of is dropped" (nothing is stored of it); the sidebar draws from the store alone (SEC.2@d,t,p: a server without a tree has no row) | A-SC-19 |
| "a collapsed section draws no row, and says how much it holds; a collapsed group in a section draws none of its own" | b | SEC.3@d,t,p (a collapsed section draws no body and shows the count and its state; a collapsed group of a section collapses apart from the local group of the same id) | A-SB-37, A-SC-05 |
| "the collapse of every group is the browser's, this computer's too: the server's tree says nothing of it" | c | core half: `packages/core/test/sidebar.test.ts` (same name); old-page half: SEC.3@d,t,p (the kv key "aiwb.collapsed", over a reload and an outage, none of it sent to any server, this computer's group too; the local group and the section's of the same id are collapsed apart); packages/core/test/sidebar.test.ts (the store half, same name) | A-SC-09 |
| "removing an entry takes its section away" | b | L7@d,t,p (remove: the section leaves the sidebar with the entry (added), the server is told nothing); packages/core/test/sections.test.ts "an entry leaves the server list: everything the page has of its server goes…" | A-SC-20 |
| "this computer's section says every state in the words of the Servers dialog, and shows no row while it is not connected" | b | SEC.2@d,t,p (a section says what the Servers dialog says of each entry); AAC.1@d,t,p (the "+" is off and the rows are not drawn while it is not connected); AAC.2-localdown@d,t,p (the head says Unreachable, no rows, the "+" disabled) | A-OW-05 |
| "this computer's section while connecting says so in its head alone, and the word Connecting is the tone of waiting" | b | AAC.1@d,t,p (connecting: the head says so, and the section says no more; the sidebar's "+" is off) | A-OW-15 |
| "a start that failed: the section says Not started, the reason the start gave as plain text, Retry; the log is the app's" | b | AAC.1@d,t,p (Not started; the reason as plain text, twelve lines and a mark, markup shown as text; Retry alone; a Retry that fails shows the new reason, one that works fills the section) | — |
| "a server older than the app: the section says Too old, its version, and offers Restart server" | b | AAC.1@d,t,p (too old: "This computer's server is older than the app.", "Version 0.9.1", Restart server alone; the question when agents run, Esc leaves it; Restarting…; the page is not loaded again) | A-OW-06 |
| "a server of another build than the app: one line, with its version, and Restart server; of the app's own build, nothing" | b | AAC.1@d,t,p ("another build (old)" with its version, Restart server; the rows are there); A1.5-notices@d,t (the rail's dot for it) | A-OW-07 |
| "a restart: the section says Restarting…; one that failed says so with the reason, Retry and the rows stay off until the server is back" | b | AAC.1@d,t,p (Restarting…, then whole again; a restart that fails: "Restart failed" with the reason, Retry restarts again) | — |
| "the other sections have none of this: no Retry, no Restart server, and their words about a server too old are their own" | b | SEC.2@d,t,p (Old Mini: its own words for a server too old, no local text); AAC.1@d,t,p (the local section's extra line is this computer's alone) | A-OW-14 |
| "this computer away does not take another section's rows, and another section away does not take this computer's" | b | AAC.2-localdown@d,t,p (Studio Mac's section unchanged while this computer is away; a chat of Studio Mac opens as usual); AAC.3-remotedown@d,t,p (the reverse: a remote server away leaves this computer's section and chats as they were) | A-SC-21 |
| "this computer's section collapses as any: its head is kept in the page's storage under `local`, and nothing is drawn collapsed" | c | core half: `packages/core/test/sidebar.test.ts` (same name); old-page half: AAC.1@d,t,p (the head collapses the section, the collapse is kept as ["local"] over a reload and sent nowhere); packages/core/test/sidebar.test.ts (the store half, same name) | — |
| "what is on screen of this computer and is gone at its return stays and says so; no row is drawn for it" | c | core half: `packages/core/test/sidebar.test.ts` (same name); old-page half: AAC.2-localdown@d,t,p (a chat deleted while this computer was away: the view says it is no longer there, and the chat has no row when this computer is back); packages/core/test/sidebar.test.ts (the store half, same name) | — |

### status.test.ts

12 tests: 11 core only, 1 old page, 0 mixed.

| old test (`status.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "isBusy: the agent is in a turn or waits for approval" | a | `packages/core/test/status.test.ts` (same name) | — |
| "boardWorker: the agent of a busy chat of the board, else of a chat that just edited it; none for a board whose server is not connected" | a | `packages/core/test/status.test.ts` (same name) | A-SB-20, D-AG-14 |
| "chatBusy: some branch of the chat is in a turn or waits for approval" | a | `packages/core/test/status.test.ts` (same name) | — |
| "workingBranches: the busy records, and the idle ones whose subagents run" | a | `packages/core/test/status.test.ts` (same name) | — |
| "isWorking: busy, or subagents running; results not sent yet do not count" | a | `packages/core/test/status.test.ts` (same name) | — |
| "workingOn: the chats a board's archive and delete confirmations warn about and stop" | a | `packages/core/test/status.test.ts` (same name) | A-SB-27 |
| "composerControls: Stop shows while subagents run; Send and Esc follow the agent" | a | `packages/core/test/status.test.ts` (same name) | C-TX-10, C-TX-15, C-TX-16 |
| "composerControls: a message that starts a new branch is sent while the source runs, when the agent kind can" | a | `packages/core/test/status.test.ts` (same name) | C-TX-14 |
| "composerControls: while the agent of a fork without a message starts, no Stop, no Esc, no Send" | a | `packages/core/test/status.test.ts` (same name) | C-TX-18 |
| "refreshAfterRefusal: the chat is read again after a 409 that tells of stale state" | a | `packages/core/test/status.test.ts` (same name) | — |
| "headStatus: a chat with no agent has no status word; an archived or disabled one says so" | a | `packages/core/test/status.test.ts` (same name) | B-HD-03 |
| "the chat's header takes its status from headStatus, and draws no separator for none" | b | L10@d,t,p (the header: status, no separator for none), SEC.7-drop@d,t,p (a frozen header has no status); app/test/wiring.test.ts (same name) | B-HD-03 |

### theme.test.ts

5 tests: 4 core only, 1 old page, 0 mixed.

| old test (`theme.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "saved theme choice" | a | `packages/core/test/theme.test.ts` (same name) | A-TH-08 |
| "the theme shown follows the choice, or the system for system" | a | `packages/core/test/theme.test.ts` (same name) | A-TH-06 |
| "a flavour is laid over light or dark, whatever the system's theme: Latte over light, the others over dark" | a | `packages/core/test/theme.test.ts` (same name) | A-TH-07 |
| "the picker: the three themes, then the four flavours, with the choice marked" | a | `packages/core/test/theme.test.ts` (same name) | A-TH-01, A-TH-02 |
| "index.html's script sets what theme.ts sets, for every saved value" | b | app/test/export-web.test.ts "the theme script sets what logic/theme.ts sets, for every saved value" (added) and "the theme script sets the saved theme, or the system's, before the first paint" | A-TH-08 |

### transport.test.ts

21 tests: 20 core only, 0 old page, 1 mixed.

| old test (`transport.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "ipc call: the server, method, path and a JSON body go as they are, with an id of the call's own; the answer comes as it is" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-02 |
| "ipc call: a Blob goes as bytes with its type; bytes stay bytes" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-02 |
| "ipc call: aborting cancels the call in the app by its id and rejects with the abort; one aborted already makes no call; the answer of an aborted call is dropped" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-03 |
| "ipc call: the way failing is a TransportError, not an answer" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-04 |
| "ipc stream: the window is asked to subscribe after the page listens; envelopes come in the order of the batches; close lets go of both" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-09 |
| "ipc stream: a subscription the window refused is a stream closed for good" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-12 |
| "ipc: the address of a picture is the app's scheme with the server, the chat and the image, each one segment; the app's operations go through; the dialog is the window's" | a | `packages/core/test/transport.test.ts` (same name) | D-PC-01, D-DW-08 |
| "http call: a POST to the host with the server, method and path in the query, the JSON body as it is, no cache; the answer is the call's status, body and scene revision" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "http call: bytes go as they are with their type" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "http call: aborting rejects with the abort; the way failing is a TransportError" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "http stream: one EventSource on the host; open and closed are its states; a reconnecting error is none; a message that is no JSON is dropped; close ends it" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "http: the address of a picture is on the host with the server, the chat and the image, each one segment; an app operation is a POST to the host" | a | `packages/core/test/transport.test.ts` (same name) | D-PC-01 |
| "the same requests give the same answers over IPC and over HTTP: status, body, scene revision, refusals, empty and plain bodies, bytes" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-01 |
| "the same envelopes arrive in the same order over IPC and over HTTP, and a stream closed for good is told the same" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "a stream is opened again after a close: the new one has its own listeners and the old one none" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-13 |
| "the way is IPC when the window gave the page its functions, HTTP when the page was loaded over http, none otherwise" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-19 |
| "the way is native in the phone's app (navigator.product), before any other; transport() there is the one the app set, and none until then" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "ipc: picture() gives the same address as pictureURL(), each part one segment; an aborted signal rejects before an address is given" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "http: picture() gives the same address as pictureURL(), each part one segment; an aborted signal rejects before an address is given" | a | `packages/core/test/transport.test.ts` (same name) | — |
| "transport(): the one the page has, the same each time; none is an error that names the app; a test puts its own in the place" | a | `packages/core/test/transport.test.ts` (same name) | D-TR-19 |
| "nothing of the page outside src/transport reaches the network, the app's functions or the host: no fetch, no EventSource, no aiwbApp, no /host/, no /api/on, no aiwbDesktop" | c | core half: `packages/core/test/transport.test.ts` (same name); old-page half: packages/core/test/transport.test.ts (same name: core's files); app/test/noplainhttp.test.ts "no plain http: the app's JS reaches the network only through aiwb-net" (the app's) | D-TR-19 |

### tree.test.ts

20 tests: 19 core only, 1 old page, 0 mixed.

| old test (`tree.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "grouping, in the user's group order" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-41 |
| "ungrouped and unknown groups fall into loose" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-42 |
| "archived items are hidden" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-07 |
| "archived items are shown in place" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-07 |
| "a board chat with instructionsSent still appears when archived are hidden" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "board chats only under their board, newest first" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-22 |
| "subgroups nest under their parent, in the user's order" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-41 |
| "an archived group hides its subgroups; shown archived, they are in place" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-41 |
| "contents counts the whole subtree" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "subtree and groupPath" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "a parent cycle in bad state doesn't hang" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-42 |
| "the local part holds only what lives on this computer: nothing of a section is in it, in a group or loose" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "a section's tree holds that server's things alone, nested and ordered as the local part's" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "a section shows its things in the order that server's own page shows them, whatever order the lists came in" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "what is no longer on its server has no row: it is on screen, and in no tree" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "a section's archived group and what is in it show only with the archived items, in place" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "treeEmpty and treeCount: what a section's head says of its tree" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "holdsAny: whether a server has anything at all, archived or not, apart from what an empty tree shows" | a | `packages/core/test/tree.test.ts` (same name) | — |
| "groupPath: the path of a group among the groups of its own server; none for a server's ungrouped area" | a | `packages/core/test/tree.test.ts` (same name) | A-SB-23 |
| "the sidebar draws every section, this computer's too, with the one tree: each from the groups of its own server" | b | SEC.1@d,t,p, SEC.2@d,t,p (each section from its own server's groups); app/test/wiring.test.ts (same name: one buildTree in Section.tsx) | A-SB-43 |

### version.test.ts

6 tests: 6 core only, 0 old page, 0 mixed.

| old test (`version.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "runningChats counts thinking, writing, tool and approval" | a | `packages/core/test/version.test.ts` (same name) | A-OW-08 |
| "runningChats counts no chat of a section: its turns are not this server's to end" | a | `packages/core/test/version.test.ts` (same name) | A-OW-08 |
| "runningChats counts an idle chat whose subagents run, not one that only holds results" | a | `packages/core/test/version.test.ts` (same name) | — |
| "restartConfirmText" | a | `packages/core/test/version.test.ts` (same name) | A-OW-08 |
| "the restart is the app's owner thing, and the page is not loaded again after it" | a | `packages/core/test/version.test.ts` (same name) | — |
| "the restart confirmation counts the chats the store has through runningChats" | a | `packages/core/test/version.test.ts` (same name) | — |

### waitflows.test.ts

31 tests: 31 core only, 0 old page, 0 mixed.

| old test (`waitflows.test.ts` "name") | kind | where it is now / what proves it on the new build | rows |
|---|---|---|---|
| "a branch send: from Send the thread has the message after the cut and the line that the agent starts, and the controls are held" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-07 |
| "a branch send whose events come after the answer: the new branch looks ready, and the loading line says what goes on" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-12 |
| "a branch send that is refused: the wait ends with the call, the move stays, and nothing is held" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a branch send that times out with an unknown result: the wait ends with the call, the move stays, and nothing is held" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a branch send that loses its connection: the wait ends with the call, the move stays, and nothing is held" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "the new branch's list fails to load: the wait ends with that load, and the thread shows what a failed load shows" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-14 |
| "an older load error recorded for the chat does not end the wait: only the load of the new branch does" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a snapshot during the POST: the wait survives it, and so does the move; the thread has the message while its list is read again" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-14 |
| "a snapshot between the answer and the new branch's list: the history and the message stay, and the wait ends with the list read again" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-14 |
| "the chat is deleted during the POST: the wait goes with it, and the POST's end changes nothing" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-14 |
| "the chat is archived during the POST: the page shows nothing of the message; the move's own rule keeps it until the POST ends" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-14 |
| "a branch send answered without the branch's name: it is being sent until the chat's view names the branch, then the history stays until the list is here" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a branch send answered without the branch's name ends with a snapshot, which replaces the state it waits in" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "the user opened another chat during the POST and came back: the same picture, and the answer's list is fetched also while away" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a fork being made: a line at the foot of the source's thread, Fork is held, and the wait ends with the call" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-15 |
| "a fork that fails: the notice, and Fork is live again" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-16 |
| "a fork asked for during a branch send: neither wait ends with the other's call" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a model pick on a fresh fork: the composer has the choice the agent starts on until the call ends, whatever the agent kind tells" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-19, C-TX-13, C-CH-17 |
| "a pick on a fresh fork whose agent fails to start: the call's error is thrown on for the composer's notice, and nothing is held" | a | `packages/core/test/waitflows.test.ts` (same name) | C-CH-17 |
| "the first message of a fresh fork: after the copied history from Send until the thread has it" | a | `packages/core/test/waitflows.test.ts` (same name) | B-TH-07, B-FK-18 |
| "the first message of a fresh fork whose event comes before the answer is drawn once, and its wait ends with the answer" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-18 |
| "the first message of a fresh fork whose agent fails to start: the message leaves the thread with the call" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-18 |
| "a message to a chat that is no fresh fork begins no wait" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a branch switch whose list is not here: the thread has a loading line until the fetch ends" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-20 |
| "a branch switch whose list fails to load: the line goes with the fetch, the notice tells, and the chat is on the branch it was on" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-20 |
| "a point of another branch opened from the tree: the thread shown says at its foot that the branch is being opened, until its list is here" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-21 |
| "Branch and edit from the tree on a branch that is not loaded: the move is set, and the thread says that the branch is being opened" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-21 |
| "a branch being opened that fails to load: the notice, and the line is gone" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-21 |
| "a move on the branch shown, whose list is kept, opens nothing and draws no line" | a | `packages/core/test/waitflows.test.ts` (same name) | B-FK-21 |
| "a section's tree that arrives gives up the fetches of its chats and reads the one on screen again: the fetch given up ends nothing" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
| "a section's tree that goes gives up the fetches of its chats: none of them is still told as running, and nothing is read" | a | `packages/core/test/waitflows.test.ts` (same name) | — |
