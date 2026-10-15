# Spike: Excalidraw in a web view (the board of the React Native rewrite)

Branch `rn-spike-board-webview`, code in `spikes/board-webview/`. Goal sections: 4.5, 6, 9 of
`react-native-rewrite-goal.md`; architecture AD-50..AD-58 (integration worktree, `plans/rn-rewrite/architecture.md`).
Everything below was run on the iPad simulator, not argued. Android was **not** tried (the task was iOS only).

## Verdict

| # | Point | Verdict | In one line |
|---|---|---|---|
| 1 | One self-contained Excalidraw 0.18.1 bundle that ships in the app and loads with no network | **GO** | `board.html`, 4,032 KB (1,728 KB gzipped; js 3,208, css 248, fonts 576). Loaded from the app's own bundle in a Release build, 98 ms from load start to load end. |
| 2 | Typed bridge, one TS module for both sides, request/reply by id, page reaches no network and accepts only the typed messages | **GO**, with two corrections to AD-52 | Every operation asked for works (load, apply, scene changed, selection, PNG, flush, theme). 12 of 12 network attempts blocked by the page's CSP, 0 requests reached a listener on the Mac. A navigation or `window.open` from the page **opened Safari** with the architecture's `originWhitelist` (see Problems); with the fix it is refused. |
| 3 | Touch drawing | **GO for finger; Pencil not tested** | Three Maestro swipes (real touches, `pointerType: "touch"`) made three `freedraw` elements, seen through the bridge. A simulator cannot make Pencil events, so Pencil, pressure and palm rejection are **not verified**: a person must try them on an iPad. |
| 4 | Memory and load time, empty and ~2,000 elements | **GO on the simulator; the device numbers are not measured** | WebContent footprint 40 MB blank, 50–52 MB empty board, 125–130 MB with 2,000 elements (+ GPU process 14 / 21 / 45 MB). Launch to an empty board that answers: about 1.2 s. See the caveats. |

**Overall for goal 9: GO** for Excalidraw in a web view on iPad. What stays open is only what a simulator cannot show
(Pencil, a real device's memory, a phone-width layout, the keyboard for the text tool) and Android.

## How to repeat

```sh
cd spikes/board-webview && ./run.sh     # about 4 minutes: build the bundle, build and install the Release app, run everything
./run.sh --no-build                     # only the checks (when nothing in the app or the page changed)
```

`run.sh` ends with `ALL CHECKS PASSED` and exit 0. It: runs the bridge unit tests (`node --test`, 5 tests), builds the
page (`webview/build.mjs`), type-checks the app, builds the app with `expo run:ios --configuration Release --no-bundler`
(the JS and the page are inside the app, no Metro), launches it on **only** the iPad Pro 11-inch (M5) simulator
(UDID by name; `AIWB_SIM_UDID` overrides), runs the `auto` scenario inside the app (the bridge exercised, memory taken
from outside at each phase announced by the app), then the `touch` scenario with Maestro. It starts a listener on
`127.0.0.1:47931` for the network check and kills it at the end. Results land in `spikes/board-webview/out/` (git-ignored); small result files
and pictures of the last run are in `plans/rn-rewrite/spikes/board-webview/`. A plain-browser run of the same page and
the same messages (`scripts/browser-check.mjs`, Playwright on Chromium from `file://`) is not part of `run.sh`
(Playwright is no dependency); it passes too.

Versions: Excalidraw **0.18.1**, React 19.2.3, Expo SDK **57.0.28**, React Native **0.86.3**, `react-native-webview`
**13.16.1**, esbuild 0.28, Xcode 26.3, iOS simulator runtime 26.3, Maestro 2.11.0 (fetched with a JDK 17 into
`/tmp/aiwb-tools` by `scripts/get-maestro.sh` if not installed; it takes "latest", so it is not pinned), Node 24.3.

| Path | What it is |
|---|---|
| `bridge/protocol.ts` | **The one module of the bridge**: types, builders, validators. No imports, no DOM, no React Native. Metro takes it for the app, esbuild for the page, `node --experimental-strip-types` tests it. |
| `bridge/client.ts` | The app's side: `BoardBridge.call(type, params)` (id, timeout, reply matching), `onMessage` (validates), `on(listener)`, `waitFor`, `reset`. No React Native in it. |
| `bridge/protocol.test.ts` | 5 tests: every type parses, what is not a request is refused (unknown type, missing field, wrong field type, wrong version, not JSON, too big), a refused request keeps its id, the app takes only replies and the known events, the client matches by id. |
| `webview/src/entry.tsx`, `webview/build.mjs` | The page: Excalidraw, the handlers, the debounce; and the single-file build with the CSP. |
| `app/BoardView.tsx`, `app/driver.ts`, `app/scenes.ts` | The web view component with its guards; the checks run inside the app; the fixtures (4 elements, 2,000 elements). |
| `scripts/run-checks.mjs`, `memory.mjs`, `probe-server.mjs`, `flows/draw.yaml` | The runner, the memory reading, the listener for the network check, the Maestro flow. |

## 1. The bundle

`webview/build.mjs` (esbuild, `iife`, minified, target safari16, `production` condition) writes **one file**, `board.html`:
the script, the style and the fonts are inside it.

| Part | Size |
|---|---|
| js (Excalidraw 0.18.1 + React + the board code + `web/src/apply.ts`, `CanvasFilters`, `theme` used unchanged) | 3,208 KB |
| css | 248 KB |
| fonts (woff2 as data: URLs in a JS object, 33 % bigger than the files) | 576 KB |
| **`board.html`** | **4,032 KB** (4,128,690 bytes); **1,728 KB** gzipped (what a store download sees; the app container of the simulator build is 57.6 MB in all) |

- Left out, as the old page leaves them out or nothing uses them: the Xiaolai (Chinese) font (12 MB), every locale but
  English, and Mermaid (2.9 MB, only the text-to-diagram dialog uses it; `KEEP_MERMAID=1` puts it back).
- Excalidraw fetches fonts with `new FontFace(family, "url(<asset path>/fonts/…)")`. `webview/src/fontshim.js` runs
  first and swaps every such address for its data: URL, so no font is fetched; an unshipped font gets an empty data URL
  and the text falls back. `EXCALIDRAW_ASSET_PATH` points at `https://aiwb-assets.invalid/` (never reached).
- **Loads with no network**: the page is loaded from the app's file. Metro takes it as an asset (`assetExts.push("html")`
  in `metro.config.js`), `expo-asset` gives its file URI in the `.app` (`…/BoardSpike.app/assets/assets/board.html`), the
  web view reads it with `allowingReadAccessToURL` set to its folder. No native configuration was needed on iOS.
- Page load: web view `onLoadStart` to `onLoadEnd` **98 ms** (a Release build, simulator); the page's own script ready
  81 ms after the navigation started; from the app's first JS to `ready` 585 ms (asset lookup, web view creation, load,
  Excalidraw mounted).

## 2. The bridge as built

JSON text, every message `{v: 1, kind, …}`. `kind` is `request` (app to page, has `id` and `type`), `reply` (page to app,
same `id`, `ok: true, result` or `ok: false, error: {code, message}`) or `event` (page to app, nothing answers it).
Ids are strings (`<type>-<n>`). Each side parses with its own function and **drops what does not fit** (not JSON, over
64 M characters, another version, unknown type, a missing field, a field of another type); a refused request that
has an id is answered with `BAD_REQUEST` and the reason, a refused message to the app is counted and its reason kept.

**Requests (app to page)**: params and result, as `Requests` in `bridge/protocol.ts`

| `type` | Params | Result |
|---|---|---|
| `loadScene` | `{scene: {elements, appState?, files?}, readOnly?}` | `{elements, ms}` (answered after the first draw and the fonts) |
| `applyChange` | `{change: {create?, update?, delete?, select?, focus?}}` (the shape of `apply.ts` `ApplyParams`) | `{created: {key→id}, updated, deleted, conflicts, rev}` |
| `getScene` | none | `{scene, version}` (all elements, deleted too) |
| `select` | `{ids, scroll?}` | `{selected}` |
| `exportPng` | `{scale? (0.1–4), background?, selectedOnly?}` | `{base64, width, height, bytes, ms}` (no `data:` prefix; over 8192 px a side is refused with `TOO_BIG`; nothing to draw is `EMPTY`) |
| `flush` | none | `{pending, version}`; the `sceneChanged` event is sent **before** the reply |
| `setTheme` | `{theme: light\|dark\|latte\|frappe\|macchiato\|mocha}` | `{theme}` (the canvas filter and the flavour attribute, as the old page) |
| `setTool` | `{tool: selection\|freedraw\|rectangle\|ellipse\|diamond\|arrow\|line\|text\|hand\|eraser}` | `{tool}` |
| `probeNetwork` | `{urls}` (**spike only**) | what each attempt (fetch, XHR, img, WebSocket, beacon, iframe, `window.open`, `location.assign`) did, and how many CSP violations came |

**Events (page to app)**: `ready {protocol, excalidraw, loadMs}`; `sceneChanged {version, flushed, elements, scene}`
(whole scene; debounced 500 ms for the user's strokes, at once after an applied change and after `flush`; `version` is
Excalidraw's `getSceneVersion`); `selection {ids, elements: [{id, type, x, y, width, height, label?}]}` (not debounced);
`log {level, text}` (an error, a CSP violation, the first pointer of each kind).

Shared types: `El`, `SceneData`, `ApplyChange`, `ApplyResult`, `SelectedEl`, `ThemeName`, `ToolName`; `Request` is a
union built from the `Requests` map, so `bridge.call("applyChange", {...})` is typed in params and result.

**Measured through the real web view (Release, simulator)**

| What | Time |
|---|---|
| `loadScene` empty / 4 elements / 2,000 elements (1.26 MB message) | 65 / 38 / 111 ms (the page's part 86 ms for 2,000) |
| `applyChange` (create 2 with an arrow bound to them, update 1, delete 1) | 9 ms; the `sceneChanged` it caused arrived 38 ms after the request was sent |
| `applyChange` on the 2,000 board | 11 ms; `sceneChanged` (1.32 MB of JSON) 41 ms after |
| `exportPng`, 4 elements at scale 2 (1240×600, 24 KB) | 21 ms |
| `exportPng`, 2,000 elements at scale 0.5 (6510×2720, 859 KB) | 213 ms |
| `setTheme` | 19–164 ms (the first switch to a flavour is the slowest) |
| `flush` | 1–2 ms |

Checks that passed: the change was in the scene the event carried; the selection event named the selected element and
its label ("Added"); `select` raised a selection event; the PNG starts with the PNG signature and is the same size
whatever the theme (export ignores the theme); `getScene` and the last event agree on the version; a bad request
(`theme: "nope"`, `type: "eval"`) is refused by the page with `BAD_REQUEST`.

**No network, only the typed messages** (CSP in the page's head, built by hash):
`default-src 'none'; script-src <sha256 of the two scripts>; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
connect-src 'none'; worker-src blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`.
`style-src 'unsafe-inline'` is needed (Excalidraw sets inline styles); no `unsafe-eval` and no `unsafe-inline` for script.
- `probeNetwork` tried two addresses (one is the listener on `127.0.0.1:47931`, one is `https://example.com`) six ways
  each: **12 of 12 blocked by the policy** (12 violation events), **0 requests** reached the listener.
- A navigation is not covered by CSP (`navigate-to` is not implemented in WebKit), so the **app** guards it:
  `onShouldStartLoadWithRequest` refuses everything but the page's own file; `setSupportMultipleWindows` is off
  (Android; iOS has no window to give); `incognito`, `cacheEnabled={false}`. The page's `window.open(url)` and
  `location.assign(url)` were both seen by the handler and refused (`blockedNavigations` held both), and the page stayed.
- The page takes a message only when `e.source === null` (the ones the web view's `postMessage` dispatches), and the
  app takes only replies and the known events, each validated.

## 3. Touch drawing

`scenario touch`: an empty board and the freedraw tool through the bridge; then Maestro 2.11 (XCUITest) makes three
900 ms swipes on the canvas. The page's first pointer was `pointerdown: touch, pressure=0`. The bridge got a
`sceneChanged` holding a `freedraw` element; after all three swipes `getScene` held **3 freedraw elements** (45, 61 and 61
points); `flush` came back at once; `exportPng` drew them (`out/touch.png`, in `plans/rn-rewrite/spikes/board-webview/`).
Web view scrolling and bounce are off and a stroke does not scroll or pan the page.

Not verified, and cannot be on a simulator or by Maestro: **Apple Pencil** (the page should see `pointerType: "pen"`
with pressure, and a resting palm should be ignored: unknown), a two-finger pinch/pan, the on-screen keyboard for the
text tool (the spike has `textInteractionEnabled={false}`: typing text was not tried), and Excalidraw's own layout at
**phone** widths (the simulator is an iPad, so Excalidraw's desktop-style panels were shown, as in the pictures).

## 4. Memory and load time

Measured from outside, at each phase announced by the app, after a 2.5 s pause. The simulator's processes are processes
of the Mac (children of the device's `launchd_sim`); `ps -o rss=` as asked, and `footprint` (the physical footprint,
which is what iOS counts a process by). One reading per phase per run (the script takes `--runs N` and reports the median).

| Phase | WebContent rss | WebContent footprint | GPU rss | GPU footprint | App rss |
|---|---|---|---|---|---|
| page loaded, no board | 197–210 MB | **39–40 MB** | 101–102 | 14–15 | 204–205 |
| empty board | 226–236 | **50–52** | 114–116 | 20–21 | 204–206 |
| 2,000 elements, 1.26 MB of JSON, zoomed out to 10 % | 304–353 | **125–130** | 180–187 | 44–45 | 225–235 |
| after an agent's change, an export and a flush | 298–350 | 133–149 | 202–255 | 51–52 | 208–247 |
| the empty board loaded again | 299–350 | 133–149 | 134–172 | 51–52 | 208–247 |

Ranges of the two full runs of `./run.sh` made on the final code (one reading per phase each); the rss figures move
by tens of MB between runs, the footprints by a few.

- WebContent + GPU footprint: **54 MB** blank, **70–73 MB** empty board, **170–175 MB** with 2,000 elements. `rss` is much larger
  than the footprint (shared system libraries are counted in it), and the footprint is the figure that matters on iOS.
- Memory is **not given back** when the board is replaced by an empty one (the footprint stays at 133–149 MB in the web view).
  The page keeps what it allocated; if this matters, the app can end the web view (`key` change) when no board is shown.
- The Networking process (135 MB rss) is the system's, one for the app, not the board's.
- **Time**: launch to the app's first JS 530 ms; to `ready` +585 ms; `loadScene` of an empty board +65 ms: **about 1.2 s
  from launch to a board that answers**; opening a 2,000 element board 111 ms.
- **Caveats**: a simulator on an M-series Mac, a Release build, **not a phone**. A real device is slower, its limits for
  a web content process are not known here, and nothing was measured over hours. 2,000 elements here is a mix of
  rectangles with labels, shapes, arrows and hand-drawn strokes of 60 points; **images** (files as base64) were not in
  the scene and would add their size. `onContentProcessDidTerminate` (iOS kills the process under memory pressure) is
  handled in the component (the page is loaded again with a new `key`, requests in flight are rejected) but it
  **never happened** in the runs, so that path is untested.

## Problems met and how they were solved

1. **A page-initiated navigation opened Safari, and took the app to the background.** With
   `originWhitelist={["file://*"]}` (AD-52 says this) `react-native-webview` does not ask `onShouldStartLoadWithRequest`
   about a URL that fails the whitelist: it calls `Linking.openURL` on it (`lib/WebViewShared.js`,
   `createOnShouldStartLoadWithRequest`). The probe's `window.open("http://127.0.0.1:47931/probe")` therefore opened Safari
   on the simulator (the listener logged a `GET /probe` and Safari's `/favicon.ico`), the app went to the background and its JS
   stopped, which is how the first run hung. **Fix**: `originWhitelist={["*"]}`, so that every request reaches the app's
   handler, which refuses all but the page's own URL. This is the correction AD-52 needs: the whitelist is not the guard, the
   handler is. (Excalidraw can open a link on an element, so a scene from an agent can ask for this.) The real app should
   route a refused URL to its own policy (open `http(s)` in the system browser after a confirmation), never let it through here.
2. **`ready` was sent before the page could take a request.** It was sent right after `render()`; the setters the
   handlers use are bound in an effect, so a request sent on `ready` hit a no-op and waited out its 20 s fallback. **Fix**: `ready` is sent from that
   effect. The real app should also queue its requests until `ready`.
3. **Maestro's first swipe started on Excalidraw's style panel** (top left), so it drew nothing and the check saw two
   strokes. Flow changed to start clear of the panel. (A test fault, not a board one; the driver also now waits for the third stroke.)
4. Small: the size readout used `ls -l | awk` and printed 0; the page's `loadMs` was measured from the script's start
   (now from the navigation's start, `performance.now()`); `loadEnd` was read before the load ended.
5. `loadScene` waits for Excalidraw's first `onChange` and the fonts; if a board never calls it, the request ends at 20 s
   with a reply, not a hang.

## What the real implementation should do differently

- **Where the bundle is built and lives**: `packages/board-view` builds it with esbuild as the spike's `build.mjs`
  does, into `dist-webview/board.html` (one file, not committed), with the CSP by hash. The **single file** is simpler than
  AD-51/AD-56's `index.html` + `board.js` + `board.css` + `fonts/`, needs no folder copied into `ios/`, and the CSP is
  stricter than AD-51's (`default-src 'self' 'unsafe-inline' …`): keep the spike's. Cost: fonts 33 % larger as base64
  (432 KB of files become 576 KB). Ship as a Metro asset (`html` in `assetExts`, `expo-asset`) on iOS: it worked in a
  Release build with no config plugin. **Android is untested**: a Release APK stores assets differently
  (`expo-asset`'s `localUri` may be unusable by `file://`), so AD-56's `file:///android_asset/board/` path, or reading
  the page into a string for `source={{html}}`, has to be tried there before `withBoardAssets` is dropped or kept.
  A stale bundle: build it before every app build (the spike's `run.sh` does), and the page's Excalidraw version goes
  into `ready` so the app can log a mismatch.
- **`changed` should not carry the whole scene.** Here `sceneChanged` is the whole scene (1.32 MB for 2,000 elements, 41 ms
  end to end, fine on an iPad for one change but sent on every debounce while drawing, and with images in `files` it
  would be megabytes more). Send the elements whose `version` changed since the last send, plus the ids deleted, and the
  whole scene only for `flush` and `getScene`; send `files` only when their set changed (AD-50 already says so; the spike
  does not do it). The app keeps the mirror.
- **`postMessage` is enough in the other direction**: the app sends with the web view's `postMessage` (a 1.27 MB message
  went through in 111 ms round trip) and the page listens on `message` with `source === null`. AD-51's
  `window.aiwbBoardReceive` through `injectJavaScript` is not needed; the page's `__aiwb.receive` exists only for a plain browser.
- **The web view needs a `key` and a guard for its process ending** (built, untested), and the app's board host should
  send `loadScene` again from the app's copy of the scene after it.
- **Add what the spike left out**: the `view` event (scroll, zoom, size, for the pick layer), `viewMode` as its own message
  (here `readOnly` of `loadScene`), `unload`, `scrollTo` apart from `select`, the style (`currentItem*`) in `changed`.
  AD-50 has these; the spike's names (`flush` for `snapshot`, replies by string id) are equivalent and either can be kept.
- **Pencil, a phone, a real device and the text tool are the checks left for a person** (goal 7.5 already lists drawing by
  hand); do them on the first real build.
- **Memory**: if the web view is released when no board is on screen the 130 MB (2,000 elements) comes back; the memory
  of **two** web views (AD-52's headless engine) was **not measured**: with 54 MB for one blank page plus the GPU process
  it is likely to cost 50–100 MB more on a phone, so the fallback in AD-52 (engine requests to the visible view, the engine
  created only when none is visible) should be the first design, not the second.

## Where the findings differ from the architecture (AD-50, AD-51, AD-52, AD-56, AD-58)

| Where | Architecture | Spike |
|---|---|---|
| AD-52 `originWhitelist={["file://*"]}` | listed as the guard | **wrong**: it makes the library open a refused URL in Safari. Use `["*"]` and the handler. |
| AD-52 `allowFileAccess` | for the bundle folder | Android only; on iOS it is `allowingReadAccessToURL` (set to the page's folder). |
| AD-52 `textInteractionEnabled` | "as Excalidraw's text tool needs" | spike set it to `false` and did not test text; the choice stays open. |
| AD-50 message shape | `t`-tagged union, `req {id: number, op}`, `res`, separate `load`/`viewMode`/`select`/`scrollTo` | `kind` + `type`, one `request`/`reply`/`event` envelope with a version and string ids; same operations bar the ones listed above. A map `Requests` types params and result together. |
| AD-50 `changed` | at most every 250 ms, `files` only when changed | 500 ms (the old page's save debounce), whole scene and files every time: change as above. |
| AD-50 `snapshot` | the live scene now, then save | `flush`: the event is sent before the reply; measured 1–2 ms. |
| AD-51 wiring | `ReactNativeWebView.postMessage` out, `aiwbBoardReceive` via `injectJavaScript` in | `postMessage` both ways. In a plain page (the web build) the same `receive` is called directly; checked in Chromium from `file://`: all of load, apply, selection, export, flush, themes, bad request passed, with no CSP violation. AD-51's claim that the web build runs the same protocol in-process holds. |
| AD-51 CSP | `default-src 'self' 'unsafe-inline' data: blob:; connect-src 'none'` | `default-src 'none'` with script by hash; blocked 12 of 12 attempts. |
| AD-51/56 files | `index.html`, `board.js`, `board.css`, `fonts/` copied into `ios/` and `android/` by a plugin | one `board.html` as a Metro asset worked on iOS. Android untested. |
| AD-56 size "about 3–5 MB" | | **4.0 MB** (1.7 MB gzipped), with Mermaid, Xiaolai and the other locales left out. |
| AD-52 two web views | `[not verified]` memory | not measured; one costs 54–73 MB (footprint, blank / empty) on the simulator. |
| AD-58 | if touch drawing or memory fails, reconsider | neither failed: **GO**. Pencil on a real iPad is still a by-hand check. |
| `web/src/apply.ts` | moved into `board-view` "unchanged but for its imports" | used **unchanged from `web/src` by path** and bundled; the 2-element agent change with an arrow and a label worked and returned the page's own `{created, updated, deleted, conflicts, rev}`. |

## Not covered

Android (any of it); Apple Pencil; a real device's memory and speed; phone-width layout; pinch zoom; text input and the
keyboard; images in a scene; hours of use; the web view's process being killed; two web views at once; a board with
more than 2,000 elements.
