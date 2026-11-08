# Spike: the tldraw board in the window, in the app's page and as one file (bb-spike-ui-embed)

Child of the UI risk spike (`bb-spike-ui`), goal 4.2, 4.6, 6.1. Done 2026-11-08 with tldraw 5.6.0 (the spike `spikes/tl-ui/`),
Electron 44.4.5 (desktop's), Playwright 1.64.1 with Chromium 1248. All runs were temporary scripts in `/tmp/bb-spike-ui-embed/`
(not committed). The only repository change is `--onefile` in `spikes/tl-ui/build.mjs`.

## Summary

- **The window works.** In Electron from `file://`, under the app's exact CSP, the board renders. Nothing reaches the network:
  every request is `file://` or `blob:`. There are no CSP violations except tldraw's licence ping, which the CSP blocks. tldraw
  needs no worker, no eval, no wasm and no inline script.
- **Licence:** the production bundle on `file://` shows tldraw's licence gate after 5 s, which leaves an empty page. The
  development bundle stays and shows the "Get a license for production" watermark. A release needs a NATIVE_LICENSE key
  (see "Licence" below).
- **Two boards on one page work.** `board-tl.js` loads beside Excalidraw's `board.js` in the app's web build, as a second web
  target of the same kind. Both boards mount and draw on the same page, and their two React roots don't clash. tldraw's CSS
  leaves the app's UI unchanged (pixel comparison below). The fonts load from `board-tl/fonts/` when the bundle is loaded with
  `defer`. **Recommendation: a second web target like `board.js`, not an iframe.**
- **The phone shape works.** A one-file `board-tl.html` (script inline and allowed by its hash, fonts as `data:` URLs) runs from
  `file://` with no other file at all. Size: 3.8 MB, 1.9 MB gzipped. WebKit was **not** tried: Playwright's WebKit isn't
  installed here (only `chromium-1248` is in `~/Library/Caches/ms-playwright`).
- **One real gap: image export.** tldraw's SVG/PNG export `fetch`es the font files and `board-tl.css` to embed the fonts.
  `connect-src 'none'` blocks those fetches. The export still succeeds, but its text falls back to a system font. With fonts as
  `data:` URLs, tldraw doesn't fetch them (`FileHelpers.urlToDataUrl` returns a `data:` URL as it is), so the export is
  correct. That is the case in the one-file build, and it is the fix for the window too (see 4).

## 1. Electron (the window)

How it was run: a temporary main script started the repository's Electron (`desktop/node_modules/.bin/electron`). It opened a
`BrowserWindow` with `show: false`, `contextIsolation: true`, `sandbox: true`, a preload that forwards `securitypolicyviolation`
events, and its own `userData` in `/tmp`. It called `loadFile` on the spike page `index.html` (built with `node build.mjs`
and with `--dev`; the page has the CSP from `cspFor()`). It recorded `session.webRequest.onBeforeRequest` for `<all_urls>`
and `console-message`, probed the DOM at 1.5 s and 7.5 s, then took `capturePage()`.

| | production bundle (`node build.mjs`) | development bundle (`--dev`) |
|---|---|---|
| renders at 1.5 s | yes, 8 shapes, 16 fonts loaded | yes, 8 shapes, 16 fonts loaded |
| at 7.5 s | **licence gate**: `[data-testid=tl-license-expired]`, no canvas, a blank window | still drawn; watermark `.tl-watermark_SEE-LICENSE` ("Get a license for production") |
| console | "No tldraw license key provided! … sales@tldraw.com", then the CSP error for the ping | only React's DevTools hint |
| CSP violations | 1: `connect-src`, `https://cdn.tldraw.com/5.6.0/watermarks/watermark-track.svg?…&url=file%3A%2F%2F…&environment=production` | none |
| requests (webRequest) | `index.html`, `board-tl.css`, `board-tl.js`, `page.js`, 16 × `fonts/*.woff2`, all `file://` | the same |
| network | none: the CSP blocks the ping before it leaves (webRequest never sees it) | none |

- **Workers, eval, wasm, blob:** none show up as violations. The app's CSP has no `worker-src` and no `'unsafe-eval'`, and
  `default-src 'none'` would report any of these. A static scan of the production bundle agrees: no `new Worker`, `eval(`,
  `new Function`, `WebAssembly`, `importScripts`, `WebSocket` or `XMLHttpRequest`. The four `Function("return this")` are
  lodash's global lookup, behind `self` (`…||self||Function(…)`), so they never run. `blob:` is used for images only: 14
  `blob:` image URLs at mount (the fill patterns, 7 zoom levels × light/dark), and `img-src` allows `blob:`.
- Screenshot of the development window: `shots/spike-ui-embed-electron-dev.png`.

## 2. In the app's page, beside Excalidraw

How it was run:
- `cd app && npm run build:web`, plus a `--connect-self` build with version `uicheck` so the page can reach the mock.
- Temp copies of each build got `board-tl/` (the spike's `board-tl.js`, `board-tl.css` and `fonts/`). Their `index.html` got
  `<link rel="stylesheet" href="./board-tl/board-tl.css">` and `<script src="./board-tl/board-tl.js" defer>` before the root,
  where `board/board.js` already loads with `defer`. At the end it got `<script src="./tl-mount.js" defer>`, a small file
  (the CSP allows no inline script) that mounts `aiwbBoardTl` into one fixed box. It also mounts Excalidraw's `aiwbBoardView`
  into a second box, then sends it `load` and an `apply` that draws a rectangle with a label and an ellipse.
- The pages were loaded from `file://` and through `web/dev/mock.mjs` (`startMock({ dist })`) in Playwright Chromium, at
  desktop (1280×800) and phone (390×844) size.
- The repository's files are unchanged.

Results:
- **Both boards together.** Excalidraw answered `ready`, `view`, `loaded`, `changed` and `res`, and drew its canvas. tldraw drew
  its 8 shapes. There were no page errors, no console errors and no CSP violations. Over the mock nothing went outside
  `127.0.0.1` (only `data:` and `blob:` besides). Screenshot: `shots/spike-ui-embed-app-both.png`, the app home with the
  sidebar, Excalidraw on the left and tldraw on the right.
- **The app's UI is not restyled.**
  - Plain build against the same build plus `board-tl.css`, at the home screen: 5 of 1,024,000 pixels differ at desktop size
    (an anti-aliasing speck on the "+" button, the same by eye) and 0 at phone size.
  - With both boards mounted and then hidden: 82 and 42 pixels differ, inside the same button. The rest is Excalidraw's undo
    buttons, which stay visible through `visibility:hidden` (that is the test's hiding, not a CSS clash).
  - tldraw's stylesheet has a single unscoped rule: `input, *[contenteditable], *[contenteditable] * { user-select: text }`.
    Everything else is under `.tl-*`, `.tlui-*` or the spike's `.aiwb-*`. It has no `@font-face` (tldraw adds fonts with the
    `FontFace` API) and no `rem`, so the page's 13 px root (`html { font-size: 13px }`, set for Excalidraw) doesn't change it.
  - Computed styles of `html` and `body` (font size, colour, background, margin, touch action) are the same with and without.
- **No global clash.** Each bundle is an IIFE with its own React 19 and its own root. They share only `window.aiwbBoardView`
  and `window.aiwbBoardTl`.
- **CSP holds** (`script-src 'self'`, `font-src 'self' data:`, `connect-src 'none'`, `img-src 'self' data: blob: …`), with
  one exception: the production bundle's licence ping on `file://`, which the CSP blocks. Over the mock (`http://127.0.0.1`)
  the production bundle counts as development: no ping and no gate after 7 s, only the watermark.
- **Asset base with `defer`.** `document.currentScript` is set for a classic deferred script. The fonts came from
  `board-tl/fonts/IBMPlex….woff2`, all 16 loaded (`document.fonts`).

Size added to the web build (`board-tl/`):

| | raw | gzip -9 |
|---|---|---|
| `board-tl.js` production | 2,023 KB | 609 KB |
| `board-tl.js` development | 5,505 KB | 1,058 KB |
| `board-tl.css` | 78 KB (dev 90 KB) | 14 KB |
| `fonts/` (16 woff2) | 1,337 KB | 1,345 KB (woff2 is already compressed) |
| **total, production** | **3.4 MB** | **≈ 2.0 MB** |

For comparison, Excalidraw's `board/board.js` is 3,220 KB (1,194 KB gzipped), its `board/` folder 4.9 MB, and the app's own
bundle 4.1 MB.

## 3. The phone's shape: one file

`node build.mjs --onefile [--dev] [--out <dir>]` (new; `spikes/tl-ui/build.mjs`):
- It writes a single `board-tl.html`, built the way board-view's `webview` build is.
- An esbuild plugin swaps `@tldraw/assets/selfHosted` (read by `src/assets.ts`) for a module that imports tldraw's 16 woff2 with
  the `dataurl` loader. `src/assets.ts` is not changed: it still blanks icons, embed icons and translations.
- The style is inline. The script is inline (with `</script` escaped) and allowed by its sha256 in the CSP:
  `default-src 'none'; script-src 'sha256-…'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
  connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`. That is board-view's
  webview CSP without `worker-src`.

Run from `file://` in Chromium (Playwright, 390×844, touch, mobile):

| | development | production |
|---|---|---|
| size | 7,381 KB | **3,885 KB** (gzip 1,976 KB); the fonts are about 1.8 MB of it, as base64 |
| requests | 1 `file://` (the page) and 14 `blob:` images | the same |
| 1.5 s | 8 shapes, 16 fonts loaded, no CSP violation | the same, plus the licence ping's `connect-src` violation |
| 7 s | still drawn, watermark | licence gate (blank) |
| PNG export | 154,511 bytes, text in IBM Plex (fonts embedded) | the same |

So **tldraw runs with no external file at all**. The phone faces the same licence question as the window: its page is
`file://` (`expo-asset`'s local file, `app/src/platform/boardpage.native.ts`). **WebKit was skipped:** Playwright's WebKit
isn't installed (`npx playwright install webkit` would add it). iOS WKWebView is therefore unverified. Nothing seen here is
Chromium-specific: no worker, no wasm, and the build targets `safari16`.

## 4. What tldraw 5.6 asks for at runtime in this setup

| What | When | In this setup |
|---|---|---|
| **Fonts**: 16 woff2 (IBM Plex Sans/Serif/Mono Medium+Bold ×italic, Shantell Sans ×4) | **all 16, eagerly, at mount**: `<Tldraw>` calls `editor.fonts.requestFonts(allDefaultFontFaces)` on mount (`InsideOfEditorAndUiContext`), as `FontFace` objects (font-src) | from `board-tl/fonts/` (`font-src 'self'`) or `data:` (one file). Not tried: loading only what we use (sans) would need `<TldrawEditor>` or an upstream option |
| **Icons** (`icons/icon/0_merged.svg#…`, ~170) | preloaded as `<img>` at mount if given | blanked (`""`): on `file://` the preload fails CORS, and our UI doesn't use them |
| **Embed icons** (YouTube, Figma, …) | preloaded likewise | blanked; the embed shape isn't used |
| **Translations** (`translations/*.json`) | `fetch`ed for any locale other than built-in English | locale forced to `en`, so no fetch (`connect-src 'none'` would block one) |
| **Watermark image** | dev, or a hobby key | **inline**: two `data:image/svg+xml` constants in the bundle; no request |
| **Licence ping** `https://cdn.tldraw.com/5.6.0/watermarks/watermark-track.svg?…&url=<location.href>` | production without a valid key | blocked by `connect-src 'none'` (a console error and a CSP violation); after 5 s the licence gate |
| **Fill patterns** | at mount | 14 `blob:` URLs (`URL.createObjectURL`), allowed by `img-src blob:` |
| **Export fonts** (`getSvgString`, `toImage`) | on each export | `fetch(fontUrl)` and `fetch(<stylesheet href>)` to embed them: **blocked** by `connect-src 'none'` for file URLs. The export succeeds without fonts, so text falls back to a system font (seen: Helvetica in place of IBM Plex). `data:` font URLs skip the fetch and export correctly |
| Workers, `eval`/`new Function`, wasm | never, in what was exercised | none; no `'unsafe-eval'`, `'wasm-unsafe-eval'` or `worker-src` needed |
| IndexedDB / localStorage | only with `persistenceKey` (not used) | not exercised |

**Export fix (for board-tl, to decide):** either pass the fonts as `data:` URLs in the web target too (+0.5 MB to `board-tl.js`
after base64 and gzip, no `fonts/` folder, a single file to ship), or give tldraw a font embedding that reads the already
loaded faces. The first fits the CSP as it is and matches the phone. Opening `connect-src` to `'self'` is not an option: on
`file://` that would mean every file the page can reach, and goal 4.6 keeps the page from making connections. The export
inside the window matters only if the window exports (copy as image). The board host's export in Node is separate.

## Recommendation: embedding

**A second web target like `board.js`, not an iframe.**
- It works today under the CSP and in Electron.
- It costs no new security surface. An iframe would need `frame-src`/`child-src`, which `default-src 'none'` forbids, and
  `file://` frames are opaque origins, so the board would talk to the app over `postMessage` in place of today's function call.
- It keeps the app's channel model: `mount(element, post, options)` as in `board.web.tsx`.
- The isolation an iframe would buy proved unnecessary: no CSS leak, no global clash.

`board-tl` should then define `window.aiwbBoardTl` with the same `mount(element, post, options) → { receive, unmount }` shape as
`aiwbBoardView`, and be built into `app/public/board-tl/` by `build:web`. The phone gets the `--onefile` build in a web view,
as today.

## Licence: what it means for the window

(Details are in `licence.md` §3; this is what the runs showed.)
- **The production bundle on `file://` is production for tldraw.** With no key it pings the CDN (blocked here by our CSP) and
  after 5 s replaces the board with a blank `tl-license-expired` div. This happens in Electron (`loadFile`) and in the
  one-file page. **The prototype's window has to load a development bundle** (`build.mjs --dev`, i.e.
  `NODE_ENV=development`), which stays and shows the "Get a license for production" watermark. In the real app that watermark
  is a link to `tldraw.dev/pricing`, which the window's link handler opens in the system browser. The development bundle
  costs 5.5 MB in place of 2.0 MB (1.06 MB gzipped in place of 0.61 MB).
- **Over `http://127.0.0.1`** (the test host, the mock, the browser checks) any bundle counts as development. The browser checks
  never see the gate.
- **A release on `file://` needs a key with the `NATIVE_LICENSE` flag.** For such a key every listed host is used as a regular
  expression against `window.location.href` (`new RegExp(host.toLowerCase().trim()).test(location.href)`). Things to know when
  asking for one:
  - The **host is lowercased before it becomes a regex**, but `href` is not. The packaged page is
    `file:///Applications/AI%20Whiteboard.app/Contents/Resources/web/index.html` on macOS, and something like
    `file:///C:/Users/<u>/AppData/Local/Programs/AI%20Whiteboard/resources/web/index.html` on Windows. Its path depends on where
    the app is installed and holds capitals, so a pattern must match only lowercase parts, for example
    `^file:///.*/web/index\.html`. A pattern like `.../Resources/web/...` would never match after lowercasing, and character
    classes such as `[Rr]` are broken by it.
  - The phone's page is a `file://` too, at a path inside the app container that `expo-asset` chooses, so it needs a pattern
    of its own (`^file:///.*/board-tl\.html` or similar). A dev build may load it from Metro over `http://`.
  - The key must be perpetual, or renewed before installed copies lapse (30 days of grace). See `licence.md`.
- Nothing in the prototype removes the watermark or touches the check (goal 4.2).

## Open questions

- WebKit / WKWebView: not run (WebKit not installed). Worth one run with `npx playwright install webkit` before the phone work.
- Should board-tl ship fonts as `data:` URLs everywhere, for a correct export and one file, or keep `fonts/` and fix the export
  another way?
- Can the 12 unused faces (serif, mono, draw) be left out? `<Tldraw>` requests all 16 at mount. Dropping them would mean a
  theme without those fonts, or `<TldrawEditor>`. Not tried.
