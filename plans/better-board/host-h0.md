# H0: the board host's node runtime (lifted from spikes/tl-host)

Package H0 of the host lane, branch `bb-host-h0`. Measured 2026-11-08 on the shared 14-core Mac (darwin-arm64, macOS 27),
Node 24.3.0, tldraw 5.6.0; the Chromium reference is Chromium 156.0.8078.4 (Playwright 1.64.1).

## What is where

- `packages/board-host/src/node/`: `page.ts` (+ `dom-linkedom.ts`, `dom-jsdom.ts`, `dom-shims.ts`, `dom-globals.ts`),
  `install-page.ts` (first import of `src/bin.ts`), `fonts.ts`, `measure.ts` + `ascii-breaks.json`, `editor.ts`,
  `runtime.ts`, `export.ts`. `src/restore.ts` (`snapshotForRestore`, O3), used by `rooms.ts` for every load.
  `src/schema.ts` now also gives `shapeUtils`, `bindingUtils`, `STICKY_TYPE = "note"`; `boardSchema()` is made from them.
- `packages/board-tl/src/model/corpus.ts`: the corpus (nothing Node-only). `packages/board-host/dev/`: `board.ts`,
  `node-corpus.ts`, `node-board.ts` (write `packages/board-host/out/`, gitignored).
- `packages/board-host/test/reference.ts`: four Chromium cases (notes and geo rectangles, `sans`, size m) for this and
  later tests.

measure.ts and textToPaths are the spike's byte for byte except imports; fonts.ts adds a settable folder; export.ts
drops the skia-canvas rasterizer and takes `background` as a boolean or a colour.

## Harness

- **Equivalence with the spike** (`TLHOST_DOM=linkedom` in `spikes/tl-host`): `node-corpus.json`, `node-board.png`,
  `.svg` and `-records.json` are **byte-identical** to the lifted code's.
- **Against Chromium**: the same as spike-host.md sections 2 and 3, to the case:

| kind | cases | ≤0.01 | ≤0.5 px | max | in case |
|---|---|---|---|---|---|
| raw | 468 | 447 | 458 | 49 | raw:mixed:draw:36:120 |
| note | 208 | **208** | 208 | 0 | |
| geo | 208 | **208** | 208 | 0 | |
| geoellipse | 208 | 207 | 207 | 43 | geoellipse:cjk:mono:xl |
| text | 208 | 185 | 199 | 6.047 | text:cjk:mono:xl |
| textfixed | 208 | 207 | 207 | 59 | textfixed:hyphens:draw:xl |
| arrow | 13 | 13 | 13 | 0 | |
| frame | 13 | 10 | 12 | 5.998 | frame:mixed |

  Reference board: same size (904×573), **0.309% strongly differing pixels** (weak 2.45%), as in the spike (0.31%).

## Cost (unbundled, `node --experimental-strip-types`, React development build)

- `loadRuntime` from process start: linkedom ~360 ms, 212 MB RSS; jsdom ~540 ms, ~290 MB.
- `src/bin.ts` logs `board host ready: linkedom, 16 fonts, 431 ms` (time since process start).
- Bundled with esbuild into one ESM file (research, `/tmp`, not committed; `NODE_ENV=production`, jsdom, skia-canvas and
  resvg external): ready in 155 ms (linkedom), 352 ms (jsdom), from the bundle's `assets/fonts/`.

## Seen on the way

- **tldraw opens a `BroadcastChannel` when it is evaluated** (`TLUserPreferences`), which keeps a Node process alive for
  ever. `page.ts` makes channels unref'd before tldraw loads. Every module that evaluates tldraw must come after
  `install-page.ts` (the H1 tests `host.test.ts` and `main.test.ts` now import it first, since rooms.ts → schema.ts
  imports tldraw).
- **Every tldraw export leaves a 5 s timer** (`ExportDelay.resolve`'s uncleared `sleep(maxExportDelayMs)`). It is harmless
  in the host's process, but it holds a test file open, so the package's test script passes `--test-force-exit`.
- React (development build) prints "Download the React DevTools…" to stdout through `console.info`. The production build
  (H4: `NODE_ENV=production`) does not.

## For H4 (the bundle)

- Keep **jsdom** external (it is `require`d through `createRequire(import.meta.url)` inside `dom-jsdom.ts`, so it resolves
  from the bundle's folder, which needs a `node_modules/jsdom` beside it, or the fallback is not shipped). Keep
  **skia-canvas** and **@resvg/resvg-js** external (native).
- Copy the 16 woff2 files of `@tldraw/assets/fonts/` to `dist/assets/fonts/`; `bin.ts` uses that folder when it exists.
- `install-page.ts` must stay the first import of `bin.ts`. esbuild keeps ESM evaluation order, as checked above.
- The research bundle needed a `require` for the bundled CommonJS dependencies in ESM output (banner
  `import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);`), as the headless writer's bundle
  does.
