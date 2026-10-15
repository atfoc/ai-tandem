# R1: the old page retired (architecture §11, goal 6)

Branch `rn-r1`. Done after D2 (the desktop app runs the web build by default) and the parity report (every old check has its port,
passing). This note says what went, what moved or stayed and why, and what is left.

## Removed

- `web/src`, `web/index.html`, `web/build.mjs`, `web/public` (the same icons are in `app/public`; `scripts/make-icons.py` writes there now),
  `web/tsconfig.json`, `web/test` (35 files, 263 tests: the 195 that bundled or read `web/src` and the old halves of the 68 split
  ones; `parity/webtest.md` names, test by test, what proves each on the app), `web/dev/checks/` (the 54 old checks), `web/dev/reallibrary.mjs`
  (the old page's run on real servers), `packages/core/src/transport/ipc.ts` (the old page's transport), `window.aiwbApp` in
  `desktop/preload.js`, `buildDist`, `openPage`, the old page's readers and the `APP=1` switch from `web/dev/shot.mjs`, `uicheck.mjs`,
  `web/e2e/lib/{rig,ui}.mjs` and the four free e2e scripts (their `asksWhere` guard too), the old-page steps of `desktop/e2e`
  (the `window.aiwbApp` step; the `if` around the board steps), `web/package.json`'s dependencies and scripts `build`, `watch`,
  `check`, `uicheck:app`.

## Renamed or moved

- `web/dev/checks-app/` → `web/dev/checks/` (`npm run uicheck` runs it), `web/dev/reallibrary-app.mjs` → `web/dev/reallibrary.mjs`.
- The tests of `ipc.ts` in `packages/core/test/transport.test.ts` now run the same parity tests (the same answers and the same envelopes
  over IPC and over HTTP) on `desktopTransport` over a fake `DesktopBridge`; `desktop/test/faces.test.js` drives the IPC face through the
  real preload and `desktopTransport`; `desktop/test/preload.test.js` keeps its `pickImages` test (no argument, no path) on `aiwbTransport`.
- `app/test/tokens.test.ts` and `canvaschrome.test.ts` no longer read the old stylesheets; the fixtures (`tokens.json`, `canvaschrome.json`),
  written from them, hold the colours and are what the app is held to (the structural test of the chrome's property list is kept, on the fixture).
- `web/dev/readme-shots.mjs` is ported to the app (`openApp`, testIDs); `docs/screenshots/*.png` are shot from it.
- `web/dev/mock.mjs` and `host.mjs` serve `app/dist-web` by default.

## Kept

`web/dev/{host,hostface,mock,mock-ui,shot,standalone,viewports,agenttools,checklist,electron,uicheck*}.mjs` with their tests, `web/e2e/`
(`rig.mjs`, `ui.mjs`, the four free scripts, `app.e2e.mjs`), `web/package.json` (no dependency: Playwright is installed `--no-save`).
`desktop/test/*`, the IPC face and its checks.

## Not done, and why

- `web/e2e/app.e2e.mjs` (paid; never run by an agent) still reads the retired page by CSS classes. It was kept, not deleted, since it is the only
  script with real agents; its header says its page steps must be moved onto `lib/ui.mjs` before it runs on the app. Its page is now `pageDist`.
- `spikes/` (code of the spikes; their reports are in `plans/rn-rewrite/spikes`) still names `web/src` and `desktop/conn`: they are history,
  like `plans/`, and run against their own copies. The grep of R1 is clean everywhere else.
- Comments in `internal/` that named `web/src/...` now name where the code lives (a comment-only change; the server is not touched).
- The chat view's part slots keep their stand-in fallbacks (`screens/chat/parts.tsx`), as the parity report said they may.
