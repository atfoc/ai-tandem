# A lighter DOM than jsdom for the board host (risk 8.8)

Question: can happy-dom or linkedom replace jsdom under tldraw 5.6.0's headless Editor (`src/dom.ts`), and what does
each save? Node 24.3.0, darwin-arm64, the shared 14-core Mac (load average ~4 during the measurement).

Versions (exact pins in `package.json`): jsdom 27.4.0 (unchanged), **happy-dom 21.0.4**, **linkedom 0.18.15**
(the latest stable of each on 2026-11-08).

## How to pick a DOM

`TLHOST_DOM=jsdom|happy|linkedom` (default `jsdom`), read by `src/dom-pick.ts`, which `loadHost()` (`src/headless.ts`)
calls. The variants are `src/dom.ts` (jsdom), `src/dom-happy.ts`, `src/dom-linkedom.ts`, all with the same
`installPage()` / `Page`. What all three share (matchMedia, ResizeObserver, IntersectionObserver, FontFace,
`document.fonts`, requestIdleCallback, devicePixelRatio, the list of names put on globalThis, the iframe shim) moved
to `src/dom-shims.ts` and `src/dom-globals.ts`; `dom.ts` does what it did before.

## Results

| | jsdom | happy-dom | linkedom |
|---|---|---|---|
| Editor creates / updates / deletes the reference board | yes | yes | yes |
| Corpus (1534 cases) identical to jsdom's | (reference) | **identical** (byte-equal JSON) | **identical** (byte-equal JSON) |
| SVG export runs | yes | yes, after 1 shim + 1 fix in `export.ts` | yes, after 9 shims |
| Board PNG vs jsdom's | (reference) | **byte-identical** (picdiff 0 / 0) | **byte-identical** (picdiff 0 / 0) |
| Board PNG vs Chromium | 0.309 % strong / 2.447 % weak | same | same |

The numbers (`node dev/cost-dom.ts`, `ROUNDS=5`: each DOM in 5 fresh processes, interleaved, `--expose-gc`, two gc
before every memory reading; medians; raw runs in `out/cost-dom.json`):

| (median of 5 processes) | jsdom | happy-dom | linkedom |
|---|---:|---:|---:|
| RSS bare Node (MB) | 89 | 89 | 89 |
| RSS after DOM installed (MB) | 169 | 145 | 110 |
| heapUsed after DOM installed (MB) | 33.2 | 21.9 | 14.1 |
| RSS after tldraw + skia loaded (MB) | 235 | 210 | 184 |
| heapUsed after tldraw + skia loaded (MB) | 54.0 | 42.4 | 35.1 |
| RSS, 1 editor with the board (MB) | 253 | 223 | 197 |
| heapUsed, 1 editor with the board (MB) | 56.5 | 44.4 | 37.1 |
| RSS, 10 editors with the board (MB) | 273 | 240 | 215 |
| heapUsed, 10 editors with the board (MB) | 61.2 | 48.5 | 40.9 |
| import DOM module (ms) | 176 | 115 | 50 |
| install DOM (ms) | 20.9 | 3.8 | 1.1 |
| import + install DOM (ms) | 197 | 119 | 52 |
| load tldraw + skia + host (ms) | 246 | 242 | 242 |
| buildBoard, warm (ms, median of 20, cleared page) | 2.95 | 1.90 | 1.80 |
| PNG of the board, warm (ms, median of 10) | 103.4 | 118.8 | 103.0 |

Reading it:

- The DOM itself costs **+80 MB RSS (jsdom), +56 MB (happy-dom), +21 MB (linkedom)** over bare Node. The saving
  carries through: with ten editors the process is 273 / 240 / 215 MB, i.e. happy-dom saves ~33 MB and linkedom ~58 MB.
- The cost per editor does not depend on the DOM (~2 MB RSS per editor holding the board in every column): the DOM is
  a fixed cost per process, so the choice matters most when the host runs few boards.
- Start: jsdom's import is most of its time (176 ms); linkedom starts in ~50 ms. tldraw + skia take the same ~245 ms
  on all three.
- `buildBoard` is ~1 ms faster without jsdom (its DOM mutations are dearer: TipTap's HTML serialization and the text
  manager's divs).
- The PNG is the same on jsdom and linkedom; happy-dom is ~15 ms slower because it has a real `getComputedStyle`, so
  tldraw's StyleEmbedder walks and embeds computed styles (the SVG before conversion is 924 KB instead of 817 KB; the
  extra styles are thrown away by `textToPaths`, the picture does not change).
- Corpus time (one run each, not part of the table): jsdom 885 ms, happy-dom 762 ms, linkedom 760 ms. (A first
  linkedom run took 2.0 s; not reproduced, taken as load on the machine.)

## What broke and the shims

### happy-dom: one shim, one fix

1. **`<iframe>` without `src` has no `contentDocument`** (with or without `disableIframePageLoading`). tldraw's
   StyleEmbedder (`getDefaultStyleFrame`) reads each tag's default styles inside a hidden iframe and asserts the
   document. Shim: `blankIframeDocuments()` in `dom-shims.ts`, a `contentDocument` getter that falls back to a blank
   `document.implementation.createHTMLDocument()` per iframe (~15 lines).
2. **happy-dom serializes `font-family` + `font-size` + `line-height` as the `font` shorthand** in `style=""` when its
   computed styles complete the set (spec-correct; jsdom never does). `export.ts`'s `styleOf()` reads longhands only, so
   labels were laid out at 16 px default line height (5 % of pixels differed). **Fix in `src/export.ts`** (the only
   change to a file the parent owns, DOM-related and minimal): `styleOf()` expands a `font` shorthand into the longhands
   it lacks (`expandFont`, ~12 lines). With jsdom nothing changes (no `font` key ever appears; jsdom's PNG is
   byte-identical before and after).

Other differences that did not matter: colours stay `#000000` instead of `rgb(0, 0, 0)`; extra embedded styles
(`direction`, `color` on every `<p>`). happy-dom's own `fetch` is used only if `headless.ts`'s override is missing (it
refuses `file:`); the override works unchanged.

Settings used: `disableJavaScriptEvaluation`, `disableJavaScriptFileLoading`, `disableCSSFileLoading`,
`disableIframePageLoading`, `disableComputedStyleRendering`.

### linkedom: nine shims (about 40 lines, all in `dom-linkedom.ts`)

linkedom's `parseHTML()` window is a Proxy (`'window' in w` is false although `w.window === w`), so `copyGlobals`
now tests `w[k] != null` instead of `k in w` (same result for jsdom). Then, in the order tldraw hit them:

| Missing | Who needs it | Shim |
|---|---|---|
| `requestAnimationFrame` / `cancelAnimationFrame` | tldraw's TickManager, `timers` | 16 ms `setTimeout` (as jsdom's `pretendToBeVisual`) |
| `location` | react-dom (dev build reads `window.location.protocol`) | `new URL('http://localhost/')` |
| `document.implementation.createHTMLDocument` | TipTap `generateHTML` (rich text → HTML for measuring) | a fresh `parseHTML()` document |
| `Blob`, `FileReader` | export: font embedding (`FileHelpers.blobToDataUrl`) | Node's `Blob`; a FileReader with `readAsDataURL` only |
| `SVGSVGElement`, `SVGGraphicsElement` | `exportToSvg` asserts `instanceof SVGSVGElement` (linkedom has one `SVGElement` class) | subclasses with `Symbol.hasInstance` testing the tag |
| `getComputedStyle` | StyleEmbedder | an empty declaration (no cascade: what jsdom's output effectively carries too) |
| `<iframe>.contentDocument` | StyleEmbedder | `blankIframeDocuments()` (shared with happy-dom) |
| `XMLSerializer` | `export.ts` serializes the SVG | `outerHTML`, adding `xmlns` on the root `<svg>` (resvg refuses the SVG without it) |
| `document.styleSheets` | FontEmbedder looks for `@font-face` | `[]` |

Still missing in linkedom and not needed by anything the spike runs: `Range`, `Selection`/`getSelection`,
`TreeWalker`, `NodeFilter`, the UI event classes (`MouseEvent`, `PointerEvent`, `KeyboardEvent`, …),
`CSSStyleDeclaration`, `CSSStyleSheet`. linkedom also writes attributes in reverse order (harmless).

## Recommendation

**linkedom**, with the corpus and PNG identity kept as the guard.

- It is the only one that removes most of jsdom's cost: +21 MB instead of +80 MB over bare Node (−58 MB RSS for the
  whole host, ~20 % of a ten-board process), −20 MB heap, ~150 ms faster start, and it is as fast as jsdom for the
  PNG.
- Its results are byte-identical to jsdom's on everything checked (1534 measuring cases, the board PNG), and the
  editor's create/update/delete runs unchanged.
- The cost is the nine shims. Each is small and tied to one tldraw call site, but together they are the risk: a tldraw
  upgrade that reaches for another DOM API (a `Range`, a `TreeWalker`, real computed styles) fails on linkedom where it
  would just work on jsdom. The guard is cheap: run `node dev/node-corpus.ts` and `node dev/node-board.ts` on the
  linkedom page and compare with jsdom's outputs (byte equality) on every tldraw bump; keep jsdom selectable
  (`TLHOST_DOM=jsdom`) as the fallback.
- happy-dom is the conservative middle (one shim, a near-complete DOM, real computed styles) but saves only ~33 MB, half
  of linkedom's saving, and makes the PNG ~15 % slower. Pick it instead if the shims worry more than 25 MB.

Uncertain: numbers on a loaded shared machine (the medians of five processes were stable to a few MB and ms); only the
reference board and the corpus were exercised, not the sync room, tools or other tldraw APIs; the react-dom in use is
the development build (the production build might change both heap and export time, equally for all three DOMs).

## Commands

```sh
cd spikes/tl-host
TLHOST_DOM=<dom> OUT=out/node-corpus-<dom>.json node dev/node-corpus.ts   # then: cmp out/node-corpus-jsdom.json out/node-corpus-<dom>.json
TLHOST_DOM=<dom> node dev/node-board.ts && cp out/node-board.png out/node-board-<dom>.png
node dev/picdiff.ts out/node-board-jsdom.png out/node-board-<dom>.png
ROUNDS=5 node dev/cost-dom.ts            # the table above; out/cost-dom.json
```
