# @aiwb/board-view

Excalidraw behind the board bridge (`@aiwb/board-bridge`, AD-50 and AD-51 of `plans/rn-rewrite/architecture.md`). The board
view is the only place Excalidraw runs: in the page itself on the web build, in a web view on a phone. The app talks to it
with the typed messages of the bridge and nothing else.

| File | What it is |
|---|---|
| `src/endpoint.ts` | `createEndpoint(post, { version })` → `{ receive(m: ToBoard), refuse(raw, error), mount }`. All the behaviour: `load`, `unload`, `viewMode`, `theme`, `select`, `scrollTo`, and the requests `apply`, `delete`, `restore`, `export`, `snapshot`; it posts `ready`, `loaded`, `changed`, `view`, `selection`, `res`, `error`. |
| `src/Board.tsx` | The React component `mount` is: Excalidraw with the page's options, the theme, the filter. No state of its own. |
| `src/apply.ts` | What the agent's `apply` call does to a scene (the old page's `apply.ts`, which this was copied from, is retired). |
| `src/export.ts`, `src/imagesize.ts` | The drawing part of `get_image` (Excalidraw's `exportToBlob`), and what needs no canvas of it (limits, sizes, which elements). |
| `src/theme.ts`, `src/CanvasFilters.tsx` | The `theme` message as CSS (`--theme-filter`) and as the SVG filter in the document. This is how the canvases are filtered on the web target, and on the phone for a filter the next file cannot make. |
| `src/phonetheme.ts` | The canvas filter of the phone target, DOM-free: `phoneCanvas(filter)` derives from the `theme` message's matrix and tables a CSS stage (`invert(93%) hue-rotate(180deg)` or none) and up to three constant-colour layers (`color-dodge`, `multiply`, `screen`) that make, per channel, the straight line through the theme's two anchors; `phoneThemeCss` is the CSS (the canvases wear the stage, `--theme-filter` stays `url(#id)` for the rest of Excalidraw); `phoneShown` models what the browser draws, held to `shown()` of `@aiwb/core` by the test. A matrix it does not know is the fallback: the SVG filter, as today. Only `src/webview/entry.tsx` passes it to the endpoint (`options.canvas`); `Board.tsx` renders the layers over Excalidraw while a board is shown. WebKit composites CSS filter functions and blend modes on the GPU but paints a canvas under a reference filter (`url(#id)`) in software on every repaint. |
| `src/fonts.ts` | Sets `EXCALIDRAW_ASSET_PATH` to the folder of the page (unless a target set it) and takes Excalidraw's CDN source out of every `FontFace`: the view loads nothing from a network. Import it before Excalidraw. |
| `src/BoardView.web.tsx` | The in-page view: `<BoardView post={...} ref={(h) => h.receive(msg)} />`. Validates what it receives. The web target wraps it. |
| `src/web/` | The **web target**: `entry.tsx` defines `window.aiwbBoardView = { mount(element, post, options) → { receive, unmount } }`; `assetpath.ts` makes `EXCALIDRAW_ASSET_PATH` the folder `board.js` was loaded from; `api.ts` is the type of that global with no Excalidraw import (what the app's type check reads). |
| `src/webview/` | The **web view target** (the phone): `entry.tsx` (`window.ReactNativeWebView.postMessage` out; in: `message` events with no source on `window` and on `document`; `aiwbBoardReceive(json)` for the harness only), `fontshim.js` (swaps each font address for a `data:` URL), `page.css`. |
| `build.mjs` | One esbuild configuration, two targets. `npm run build:web [-- --out <dir>]` → `../../app/public/board/` (git-ignored): `board.js`, `board.css`, `fonts/`. `npm run build:webview` → `dist-webview/board.html` (not committed): **one file**, about 4 MB, with the script, the style and the fonts inside and a CSP by hash. |
| `dev/bench/` | The **board bench** (`README.md` there): a dev-only build of the phone's page (`AIWB_BOARD_BENCH=1 node build.mjs webview`, never shipped) that loads fixture boards, switches theme modes, pans and pinches the same way every time and records the frame intervals; `webkit.mjs` runs it in desktop WebKit or Chromium as an indicator. |
| `dev/harness.mjs` | `node dev/harness.mjs`: drives `board.html` from `file://` in Chromium (as a web view does) and the web target under the CSP of the web build, with the same checks, a mirror kept from the `changed` deltas, and a theme step that differs by page (the phone's canvas wears the CSS stage with the blend layers over it, the web page's the SVG filter; the pixel read back is the same), and the web view's own (events on `window` and `document`, with a source ignored). It also runs `behaviours`: what an agent's `apply` does (the clean look, upsert, `ifVersion`, refusals that apply nothing, labels, arrows, cascade, `focus`, one undo step), the picture (stored colours under a dark theme, fonts) and what a person draws and does (the clean style, undo, the menu, a dropped file); `ONLY=behaviours` runs those alone on the web target. `dev/harness.html` is the web target by hand. |
| `dev/canvascheck.mjs` | `node dev/canvascheck.mjs [--engines chromium,webkit] [--out <dir>] [--sheets]`: the canvas theme in real engines (Playwright Chromium and WebKit). The phone page and the desktop page draw the same swatch board under each theme of `CANVAS_THEMES`; the pixels of the screenshots are held to `shown()` (today) and `phoneShown()` (`src/phonetheme.ts`), to each other (anchors, Excalidraw's chrome, the colour family in OKLCH), through a live theme switch (no `changed`) and through `get_image` (identical bytes in every theme). `--sheets` writes a side-by-side contact sheet per engine and theme. Needs `npm run build:webview` and Playwright. |

```sh
npm test && npm run check && npm run build:web && npm run build:webview && node dev/harness.mjs
```

The harness needs Playwright (no dependency of the repository; see `AGENTS.md`). `app/scripts/export-web.mjs` runs `build:web`
before `expo export`, so a stale board never ships.

## `changed` is a delta

The endpoint keeps a baseline per board (`@aiwb/board-bridge/delta.ts`: id → version and the ids in order, from `load`, then each
`changed` and `snapshot`) and sends the elements whose version differs, `order` when the ids or their order changed, and the files
added. The app's board side applies it to the scene it keeps (`applyDelta`). The whole scene crosses in `load` and in a
`snapshot`'s answer only.

## What a request answers

`res.value` is typed per request in `@aiwb/board-bridge` (`EngineValues`, `validateEngineValue(op, value)`). `apply` and `delete` on
`target: "live"` send the `changed` they cause before the reply; on `target: { elements }` the reply carries `elements`
and the live scene is not touched. `export` draws the elements named by `ids` (all of them when empty).

## Not in this package

The board's chrome (Excalidraw's menus and panels) takes Excalidraw's own light or dark: the canvas filter is the only
thing of the app's theme the bridge carries. The pick layer, flash boxes and the rest of the overlays are the app's.
