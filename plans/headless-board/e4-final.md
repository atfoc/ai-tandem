# E4 — Nothing else moved (goal 6.6): final confirmation

Run on branch `hb-e4` (from `headless-board` at a724cfe0, everything merged), 2026-10-16, on a Mac with nothing else testing.
No paid model was called (no `AIWB_*_E2E`, no `web/e2e/app.e2e.mjs`). Times are wall clock on this machine.

Result: **every command below passed.** One script of the device flow (`board-webview.yaml`) had a stale assumption and was
changed (see "Faults found"); no product code was touched.

## Command → result

| # | Command | Result |
|---|---|---|
| 1 | `go test ./...` | pass, all 26 packages `ok`, 15 s |
| 1 | `AIWB_TEST_FULL=1 go test -timeout 20m ./...` | pass, all `ok` (`cmd/ai-whiteboard` 17.9 s), 19 s |
| 1 | `go test -race ./internal/editorbridge ./internal/headless ./internal/boardapi ./internal/server` | pass, 4 `ok`, 14 s |
| 2 | root `npm test && npm run check` | pass, 52 s; test counts of the seven workspaces 522 (1 skipped), 62, 40, 79, 204, 1571, 50; 0 failed; type checks clean |
| 2 | `cd web && npm test` | pass, 45 tests, 1 s |
| 2 | `cd desktop && npm test` | pass, 133 tests, 5 s |
| 2 | `cd packages/conn && npm test` | pass, 204 tests, 6 s |
| 2 | `node --test web/dev/host.test.mjs` | pass, 8 tests |
| 2 | `cd packages/headless && npm test && npm run check` | pass, 50 tests, 7 s; type check clean |
| 2 | `cd packages/board-engine && npm test && npm run check` | pass, 40 tests, 2 s; type check clean |
| 2 | `cd packages/board-engine && npm run faithful` (Playwright linked from `web/node_modules`, links removed after) | pass (exit 0), 8 s: "every difference is a known one, and no picture has more than 1% of its pixels differing by more than 64"; corpus 1188/1344 lines equal, the 156 others the known CJK / Cascadia / Liberation cases |
| 3 | `cd app && npm run build:web` | ok, 2 s |
| 3 | `DIST=app/dist-web node web/e2e/newchat.e2e.mjs` | pass, 21 checks, 7 s |
| 3 | `DIST=app/dist-web node web/e2e/twopages.e2e.mjs` | pass, 65 checks, 0 failed, 100 s |
| 3 | `DIST=app/dist-web node web/e2e/remotechat.e2e.mjs` | pass, 88 checks, 111 s |
| 3 | `VIEWPORT=phone DIST=app/dist-web node web/e2e/remotechat.e2e.mjs` | pass, 88 checks, 107 s |
| 3 | `node web/e2e/localserver.e2e.mjs` | pass, 37 checks, 33 s |
| 3 | `DIST=app/dist-web node web/e2e/away.e2e.mjs` | pass, 27 checks, 6 s |
| 3 | `DIST=app/dist-web node web/e2e/readers.e2e.mjs` | pass, 70 checks, 0 failed, 28 s |
| 3 | `DIST=app/dist-web node web/e2e/headlessfail.e2e.mjs` | pass, 35 checks, 0 failed, 6 s |
| 3 | `cd desktop && npm run e2e` | pass, 26 `ok` lines, "app e2e: done", 5 s (needed the Electron binary, see "Setup notes") |
| 4 | `cd web && npm run uicheck -- L5 SEC.7 AAC.2 SEC.9` | pass, 6 of 6 checks (Playwright 1.64.1, Chromium 156.0.8078.4), 116 s |
| 4 | `cd web && npm run uicheck -- L6 L24 HB.1 A1.4 P7.4 P7.5` | pass, 8 of 8 checks, 181 s |
| 5 | A reader does not write | already checked, not added: `away.e2e.mjs`, check "4 the page made no call that writes a board, and the files and revisions are as the agent left them" (a window connects and shows two boards as a reader; no `PUT/PATCH/DELETE`, `scene`, `take`, `release` or `rpc-reply` call; the bytes of each `drawing.excalidraw` and each `scene.rev` are the same before and after the reader session). `readers.e2e.mjs` adds: "the file is as before: P2's rectangle was not written", "nothing took the board: … the file and its revision are as they were", "no page asked for the board: no take, no release, no write in any page". Both scripts passed (rows above). |
| 6 | `node app/e2e/run.mjs board-webview --platform ios --device <hb-e4, iPhone 17, iOS 26.3>` | **first run failed** at "touch strokes: 3" (stale iOS tap points of the flow, below); **after the fix: PASSED**, 43 s: `board self-test ok` (8 passed, 0 failed, 0 skipped), 3 touch strokes, text "hello". Run with `--no-build` on a development app that was not built from this commit (see "Setup notes"). The simulator was deleted afterwards. |

## Faults found

1. **`app/e2e/maestro/board-webview.yaml`, iOS tap points (the script's own stale assumption; fixed, committed).** The flow tapped the
   toolbar at the iPad's tablet layout (pencil 60%/16%, "A" 64%/16%, arrow 31%/16%). On an iPhone simulator the page draws the phone
   layout (toolbar at about 21% of the height: pencil 57%, "A" 65%, arrow 9%), so the pencil was never chosen and the flow failed at
   `Assert that "touch strokes: 3.*" is visible` with "touch strokes: 0" (screenshot in the run's folder). The Android points were
   already the phone's. The flow now uses the phone's points on both platforms. Nothing in the product moved: with the points fixed the
   board draws and types by touch.
2. The flow does not press **Edit here** and needs no change for it: `BoardSelfTest` mounts the board host alone and sends `load` with
   `viewMode: false`; there is no reader/writer bar (`board-take`) in that screen.

No other failures. No test needed a second run; none is load-sensitive in this run.

## Setup notes (not faults of the product)

- `desktop/node_modules/electron/dist` is missing from the integration worktree's `node_modules`, so `cd desktop && npm run e2e` failed
  at first with `spawn …/Electron.app/Contents/MacOS/Electron ENOENT`. The same version (44.4.5) was copied copy-on-write from the main
  checkout's `desktop/node_modules/electron/dist` (and `path.txt`); then it passed.
- Playwright's links into `packages/board-engine/node_modules` must be relative to that folder (`../../../web/node_modules/playwright`).
- **The disk ran full** (0 bytes free for a short time; other processes' work stopped writing too) while `expo run:ios` built the
  development app for the new simulator (`app/ios` 782 MB and a 956 MB DerivedData folder). Only this run's own files were removed
  (`app/ios`, its DerivedData folder, `app/dist-web`, the build's temporary folder); the run's build was abandoned. The device flow was
  then run with `--no-build` on the development app of an earlier build found in `~/Library/Developer/Xcode/DerivedData` (a build of
  another worktree, installed with `simctl install`, read only). The JavaScript of the app and the board's page (`board.html`) came from
  this worktree through Metro (`prebuild:board` ran); the native side is that earlier build's. `git diff main..HEAD` has no change in
  `app/modules`, `app/app.config.ts` or `app/package.json`, so the native inputs are those of `main`, but the device flow was not run
  on a binary built from this exact commit.

## Cleaned up

Scratch servers: every script stopped its own ("processes left: none"). Simulator `hb-e4` deleted. Removed: `app/dist-web`, `app/ios`,
`app/e2e/.tools`, `packages/board-engine/out`, `bin/`, `desktop/dist` (the last two were never made), the run's evidence folders
under `/var/folders`, the Playwright links of `packages/board-engine`.
