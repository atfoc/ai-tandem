# Package D-e2e: the web e2e scripts on the web build, as built

`web/e2e/{newchat,twopages,remotechat,localserver}.e2e.mjs` take `APP=1` (and `DIST`): the same scenarios and assertions on the new build
(`app/dist-web`) and on the old page. Code: `web/e2e/lib/ui.mjs` (new), `web/e2e/lib/rig.mjs`.

## Run
```sh
cd app && npm run build:web && cd ..
APP=1 DIST=app/dist-web node web/e2e/newchat.e2e.mjs      # likewise twopages, remotechat
VIEWPORT=phone APP=1 DIST=app/dist-web node web/e2e/remotechat.e2e.mjs
APP=1 node web/e2e/localserver.e2e.mjs                    # builds its own two builds (the version is stamped into each)
```
Without `APP` the scripts run on the old page as before (`cd web && npm run build` first).

## The CSP the host needs
The test host serves the page over HTTP and the page calls it from its own address: `connect-src 'self'`. The shipped export has `'none'`
(AD-41). `rig.mjs pageDist`: `DIST` with `'self'` (an export made with `--connect-self`) is used as it is; the shipped one is copied into the
run's temp folder and only its CSP `<meta>` is rewritten with `cspFor({ connectSelf: true })` of `app/scripts/export-web.mjs` (so `DIST=app/dist-web`
works and is not touched); without `DIST` the script builds `buildAppDist` (version "dev", as the server program says it is). `localserver` needs
two builds of different versions: `buildPage` (`buildAppDist` with the version).

## ui.mjs
`q` (CSS selector table by name: class selectors for the old page, testID/dataSet for the new build) and functions for what is not a selector:
`lookOf` and `outline` (the sections' readers), `headButton`/`plus`/`more` (a hover, then the button of a head or row), `openRow`, `toList`,
`drag`/`dragger` (HTML5 drag on the old page, the pointer on the new build), the Servers dialog (`openServers`, `fillForm`, `serverRow`),
chips (`openChip`, `chipLabel`: on the phone the folder and effort are in the "more" popup), `rowState`/`working`/`waitsOrWorks` (the old row class
`st-*`, the new `crow-dot` state). On the phone every press on the list goes through `toList` (back through the stack to the list) and a board
made from the list is named from its row's menu (`nameNewBoard`: the phone opens the board's own screen, S1's decision).

## Findings
- **Defect fixed in the app**: Metro's cache is keyed by the file, so `EXPO_PUBLIC_AIWB_VERSION` was inlined once and every later build of another
  version said the first one's (a build for the checks said "uicheck" to `localserver`'s builds: "runs another build" on the first start).
  `app/metro.config.js` now sets `cacheVersion` to the version; a test in `app/test/export-web.test.ts`.
- New testIDs: `dialog-title`, `dialog-body` (`ui/Dialog.tsx`).
- `asksWhere` (the old question about where a new chat lives) has no counterpart in the new build: the check is vacuous there (0 elements).
- The image step of `remotechat` (step 7) needs K4 (the attach button is a disabled stand-in until it is merged): without it that one check fails
  with "the attach button gave no file chooser" and the rest goes on.
