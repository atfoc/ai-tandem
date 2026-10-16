# Spike: the board engine in Node

Throwaway code that proved `plans/headless-board/engine.md`. Not shipped, not a workspace of the repository, no tests of its own.
The product work is the work packages of that document.

```sh
cd spikes/headless-engine
npm install && npm install --no-save playwright@1.64.1      # Chromium 156 is the reference (see AGENTS.md)
(cd ../../packages/board-view && node build.mjs web --out ../../spikes/headless-engine/out/web)   # the window, as shipped
node build.mjs                                              # the Node engine -> out/engine.mjs (skia-canvas by default; AIWB_CANVAS=napi)
cd harness
node run.mjs [case ...] [--live] [--cold] [--dpr 2]         # the faithfulness harness: elements and pictures, Chromium vs Node
node textcorpus.mjs                                         # 42 lines x 8 families x 4 sizes, widths Chromium vs Node
node textmatrix.mjs                                         # a text per script x family, through apply, on both canvas libraries
node cost.mjs                                               # load time, memory, the large board
```

The window with the two engine fixes the spike proposes (work packages E2 and E3):

```sh
AIWB_APPLY_VARIANT=apply-indices.ts node build.mjs
AIWB_APPLY_VARIANT=apply-indices.ts AIWB_WEB_FACES=1 node build-web.mjs      # -> out/web-variant
cd harness && AIWB_WEB_DIR=../out/web-variant node run.mjs --cold            # also --live
```

| File | What it is |
|---|---|
| `engine.ts` | The board view's requests on given elements (`apply`, `delete`, `restore`, `export`), taken from `endpoint.ts`'s `ops` (work package E1 moves it into `packages/board-view/src/engine.ts`). |
| `page.mjs`, `page-first.mjs` | The stand-in page (window, document, canvas, img, FontFace, document.fonts, FileReader...), installed before Excalidraw is evaluated. |
| `fonts.mjs` | Every FontFace Excalidraw declares, registered with the canvas under an alias; a font string cut into runs of one face by unicode-range and by Blink's word boundaries, with the browser's fallbacks (default font, emoji font, symbol fonts). |
| `canvaslib.mjs` | skia-canvas or @napi-rs/canvas behind one face. |
| `entry.ts`, `build.mjs` | The Node bundle (esbuild, Excalidraw inside, the canvas outside). |
| `variants/` | The proposed changes of `packages/board-view` (valid fractional indices in `apply.ts`; the faces a request needs loaded before it is measured), swapped into both builds by `build.mjs` / `build-web.mjs`. |
| `harness/` | `run.mjs` and `cases.mjs` (the faithfulness harness), `chromium.mjs` (the web target in Playwright), `node.mjs`, `pngs.mjs`/`hist.mjs` (pixel comparison), and the probes the findings came from (`probe-*.mjs`, `reach.mjs`, `cost.mjs`, `textcorpus.mjs`, `textmatrix.mjs`). |
