# The board engine in Node (headless board: the engine)

The engine part of `headless-board-goal.md` ("the goal"): the app's own board engine (4.4), with Excalidraw as installed (4.5),
run in Node with real fonts (4.6), answering the agent's board requests with no screen. Everything around it (holding,
readers, the button, the headless writer as a connection client, how the server starts it and routes calls) is `hb-arch`'s;
section 2 is the boundary between the two.

Every number here was measured by the spike in `spikes/headless-engine/` (its `README.md` says how to run each one) on a
14-core Mac (macOS 15, darwin-arm64), Node 24.3, Chromium 156.0.8078.4 (Playwright 1.64.1), Excalidraw 0.18.1, skia-canvas
4.0.0, @napi-rs/canvas 1.0.11. Marks are the goal's (`[user]`, `[standing]`, `[trial]`, `[proposed]`, `[not verified]`);
every decision of this document is `[proposed]` until the user or the orchestrator says otherwise.

## 0. In short

- **It works, and it is faithful.** The board view's own `apply.ts` and `export.ts`, bundled for Node behind a stand-in page with
  skia-canvas, answer `apply`, `delete`, `restore` and `export` as the window does. On the harness's 7 cases (labels and
  wrapping, every script, every font, frames and groups, a saved hand-drawn board with an elbow arrow, images, 1,819
  elements) **1,920 of 1,924 elements are identical** to Chromium's, all but ids and seeds. The 4 that differ are CJK text,
  0.3 px wider. 16 of 17 pictures have the same size and bounds (the 17th is 1 px wider, from the same CJK text), and in every
  one at most 0.15% of pixels differ strongly, except a dense board drawn at scale 0.25 (0.80%).
- **Fonts per script (7.1) are solved for every script Excalidraw has fonts for.** Every Latin, accented Latin, Vietnamese,
  Cyrillic and Greek width is exact: 832 of 832, in all 8 families at all 4 sizes. The method is to register every piece
  Excalidraw declares and cut each text into runs of one face, by `unicode-range` and by Blink's word boundaries, as the
  browser does. Text outside Excalidraw's fonts (CJK, emoji, Arabic, Hebrew, Indic, Thai) is measured by the system's fonts in
  a window too, so it follows the machine. On macOS it is exact except Han (+0.2% at 20 px, up to +1.3% at 36 px) and the
  deprecated Cascadia.
- **The canvas is skia-canvas** (7.4). It is exact on 1,188 of 1,344 corpus widths, where napi-rs/canvas is exact on 41 of 120
  matrix cells (it does not find macOS's system fonts). It has prebuilt binaries for all four server targets (and Windows),
  28–39 MB each, needs no postinstall and no system libraries, and runs under Electron's own Node.
- **Two defects of today's window** came out of the comparison. Both make a window disagree with itself, and so with any
  headless writer.
  1. A page that has not loaded a font piece yet measures an agent's text with a fallback font. Measured: 320.83 instead of
     353.26 px, never corrected later.
  2. `apply` leaves invalid fractional indices that only the on-screen path repairs.

  The fix for each is small and proven (EN2, EN3). With both, a cold window agrees with Node exactly as a warm one does.
- **Cost (4.10, goal 8).** Loading the engine takes 70–100 ms and the process sits at 120–135 MB. An `apply` takes under 10 ms,
  a picture 15–50 ms. Reloading a board of 1,819 elements takes 4–7 ms, so a short quiet time costs almost nothing.

## 1. How the engine is shared (4.4) `[proposed]`

**Decision.** The engine stays in `packages/board-view`, as one file more: `src/engine.ts`, the requests on given elements,
taken out of `endpoint.ts` unchanged (work package EN1). `apply.ts`, `export.ts` and `imagesize.ts` stay where they are. A new
package, `packages/board-engine` (`@aiwb/board-engine`), is the Node host of that code and nothing else: the stand-in page,
the font runs, the native canvas, the bundle and its tests. It has no engine logic of its own.

| | `packages/board-view` keeps | `packages/board-engine` (new) has |
|---|---|---|
| Engine | `src/engine.ts` (new: `apply`, `delete`, `restore`, `export` on given elements), `apply.ts`, `export.ts`, `imagesize.ts`, `faces.ts` (EN2), `indices.ts` (EN3) | none: it imports `@aiwb/board-view/engine.ts` |
| Screen | `endpoint.ts` (the live canvas: `load`, `changed` deltas, `snapshot`, select, scroll, theme, view mode; it calls `engine.ts` for given elements and keeps its live branch), `Board.tsx`, `CanvasFilters.tsx`, `theme.ts`, `phonetheme.ts`, `web/`, `webview/`, `fonts.ts` | none |
| Node | none | `src/page.ts` (stand-in page), `src/fonts.ts` (faces and runs), `src/canvas.ts` (skia-canvas), `src/page-first.ts` (the bundle's first import: installs the page before Excalidraw is evaluated), `src/bundle.ts` (the bundle's entry: the page first, then the endpoint), `src/skia-binary.ts` (build time: the native binary of another target, fetched from npm and checked), `build.mjs` → `dist/engine.mjs`, `src/node.ts` (`createNodeEndpoint`, `ENGINE_EXTERNALS`, `copyEngineAssets`: section 2), `test/`, `dev/faithful.mjs` |
| Dependencies | adds `fractional-indexing` 3.2.0 (EN3; the version Excalidraw 0.18.1 pins) | `skia-canvas` 4.0.0 (exact), `@aiwb/board-view`, `@aiwb/board-bridge`, esbuild (dev) |

**Why here and not a third copy or a package of its own.** The engine is already shared: the window answers requests for
boards that are not on screen with exactly these element-target ops (`packages/core/src/board/side.ts` `engine()`, on a phone
a hidden web view, `app/src/screens/board/engine.ts`). The headless engine is a third host of the same code. Moving
`apply.ts` and `export.ts` into a new package would move every import of the board view for no gain. Putting the Node host
inside `board-view` would give every build of the board view a native dependency it never loads.

**Why Node bundles it the way the window does.** Excalidraw's ESM does not load in plain Node (extensionless imports such as
`roughjs/bin/rough`). The Node build is an esbuild bundle with the board view's own settings (`conditions: production`, the
same defines, the slim plugin). Excalidraw is inside it and the canvas outside, which makes 4.03 MB. Both bundles are made
from one lockfile, so they carry the same Excalidraw.

**How one test covers both.** The engine's code exists once, so:

1. The DOM-free parts are unit-tested under `node --test`: `imagesize.ts` as today, `faces.ts`'s `needs`, `indices.ts`.
2. `cd packages/board-engine && npm test` builds `dist/engine.mjs` from `board-view/src/engine.ts` and runs requests through it
   in Node. That tests the engine's own code, the code the window bundles.
3. `packages/board-view/dev/harness.mjs` runs the same code in Chromium and WebKit, as today.
4. `npm run faithful` in `packages/board-engine` (EN6) sends identical requests to the shipped web target in Chromium and to
   the Node build, and compares elements and pictures.

A change to `apply.ts` therefore runs in 2 in Node and in 3 and 4 in a browser.

## 2. The engine module interface (reconciled with `hb-arch`) `[proposed]`

`hb-arch` fixed the boundary in `architecture.md` section 4, and `packages/headless` (W5) is built against it: the engine is
**the board view's endpoint, in Node, for the requests on given elements**, with the same messages, values and error codes.
This document adopts that interface as it is:

```ts
// @aiwb/board-engine/node (packages/board-engine/src/node.ts) — what packages/headless/src/engine.ts imports.
export function createNodeEndpoint(post: (m: FromBoard) => void, options: NodeEndpointOptions): Promise<NodeEndpoint>;
//   options: { assets: string /* <bundle dir>/engine */; version?: string; warn?: (text: string) => void }
//   NodeEndpoint: { receive(m: ToBoard): void; refuse(raw: unknown, error: string): void; close(): Promise<void> }
export const ENGINE_EXTERNALS: string[];
export function copyEngineAssets(dir: string, target: { os: "darwin" | "linux"; arch: "arm64" | "x64" }): Promise<void>;
```

It answers these requests (`EngineOp` and `EngineValues` of `packages/board-bridge/src/messages.ts`, as `endpoint.ts` answers
them for a target that is not `"live"`):

| Request | Answer | In the agent's terms |
|---|---|---|
| `{op:"restore", elements}` | `RestoreValue` | load a scene (the board side keeps it) |
| `{op:"apply", target:{elements}, params, rev}` | `ApplyValue` with `elements` | create, update, delete |
| `{op:"delete", target:{elements}, refs, cascade, rev}` | `ApplyValue` with `elements` | delete_elements |
| `{op:"export", target:{elements, files, appState}, ids, scale, background}` | `ExportValue` | get_image of the board, a frame, a region, elements (the scope is resolved to ids by `@aiwb/core`) |
| `{op:"snapshot"}`, or any `target:"live"` | `res ok:false` `NO_BOARD` "no board is shown" | what needs a screen: as the board view answers it with no board shown |

Error replies are `res ok:false` with the `RpcError` code and message, and `FAILED` for anything else. "Read the board",
"create a board" and "take the current scene to save" are the board side's (`side.ts`) and the server's, as in a window. The
engine keeps nothing between requests. The plain words for what needs a screen (3.3) are the headless writer's (`hb-arch`
2.10, D23).

**What the engine side adds, within that interface** (EN5):

- **`createNodeEndpoint` loads the engine's own bundle from `<assets>/engine.mjs`** with a dynamic `import()`, and does not
  import Excalidraw itself. That bundle is built by `packages/board-engine`, with the board view's esbuild settings
  (`conditions: production`, the defines, the slim plugin, CSS emptied). It installs the stand-in page as its first import,
  so Excalidraw is always evaluated after the page, whatever `packages/headless` imports first. `packages/headless/build.mjs`
  needs no change: its esbuild bundles only the small `node.ts`, and `ENGINE_EXTERNALS` is `["skia-canvas"]` (left out by
  name in case anything names it).
- **`copyEngineAssets(dir, target)`** writes into `dir`:
  - `engine.mjs` (built if `dist/engine.mjs` is missing or older than its sources);
  - `fonts/` (Excalidraw's fonts without Xiaolai, as the window ships them);
  - `node_modules/skia-canvas/` (its JavaScript), with the target's native binary as `node_modules/skia-canvas/lib/skia.node`
    (the first place skia-canvas's loader, `lib/classes/neon.js`, looks).

  For this machine's own target the binary is copied from the installed `@skia-canvas/<platform>`. For another target it is
  taken from the npm package `@skia-canvas/<os>-<arch>[-glibc]@4.0.0` (`npm pack`, needs the registry or npm's cache), and
  checked by size and by its ELF or Mach-O header for the target.
- **`ready`** carries `options.version`, else `"excalidraw 0.18.1; skia-canvas 4.0.0"`. A failure to start (the native
  binary does not load, a font file is missing) rejects with that reason and posts nothing, as `architecture.md` section 4 asks.
- **The same code as the window.** The requests are answered by `@aiwb/board-view/engine.ts` (EN1), the module the board view's
  endpoint also calls. Its reply mapping (value → `res ok:true`, `RpcError` → its code, anything else → `FAILED`) is one helper
  used by both.

**The cost the board side's channel sees** (section 9): `ready` 70–100 ms after the start, an `apply` under 10 ms, a picture
15–50 ms, a `restore` of 1,819 elements 4–7 ms. That is the "reload" of `hb-arch`'s Q1: a quiet time of a few seconds would
already pay for itself.

## 3. The stand-in page (7.3) `[proposed]`

`spikes/headless-engine/page.mjs`, installed by the bundle's first import, before Excalidraw is evaluated (Excalidraw makes
`<img>` placeholders and its FontFaces at module load).

**What it supplies.** `window` and `self` (`globalThis`), and `document` with `createElement` for canvas, img and a generic
element, `createElementNS`, `fonts`, listeners as no-ops, `body`, `head` and `documentElement`. Also `FontFace`, `FileReader`
(`readAsDataURL`), `Image`/`HTMLImageElement` (skia-canvas's `Image`, with `naturalWidth`/`naturalHeight` and `decode`),
`Path2D`, `DOMMatrix`, `ImageData`, `devicePixelRatio` 1, `location`, `navigator`, `matchMedia`, `requestAnimationFrame`,
`requestIdleCallback`, `localStorage`, `ResizeObserver`, `IntersectionObserver`, `MutationObserver`, `getComputedStyle`, and
empty classes for `HTMLElement` and its relatives. A canvas is skia-canvas's `Canvas` with `toBlob`, `style`, `isConnected`
and `setAttribute("dir")`, which sets the context's `direction` as a browser does: Excalidraw sets `dir` for right-to-left
text.

**What Excalidraw reaches for while it works** (counted over every case of the harness, `harness/reach.mjs`):
`document.fonts` (4,189 reads), `document.createElement` (61 calls, every one a canvas), `FileReader` (17, the PNG to base64
of `export.ts`), `Image` (9), `Path2D` (3). Nothing else: no `devicePixelRatio`, `matchMedia`, `localStorage`, `location` or
observers. The rest is read only while the modules are evaluated, or never, and stays because it costs nothing.

**What each part of 7.3 needed:**

| Risk 7.3 | Result | What the stand-in needed |
|---|---|---|
| Frames (create with children, rename, move a child, picture of a frame alone and with children) | 9/9 elements, pictures same size and bounds | nothing more |
| Groups (`groupWith`, move a member) | identical | nothing more |
| Bound arrows (create bound, labels, reroute on move, delete one end) | identical | nothing more |
| Elbow arrows (a saved board's, bound by fixed points, its shape moved by an agent) | identical, picture 1.55% / 0.15% strong | nothing more (`restore` and the renderer's elbow code run as they are) |
| Loading a saved board (hand-drawn, rotated text, freedraw, curved dashed line, a frame) | 14/14 elements | nothing more |
| A large board (600 labelled shapes and 599 arrows made by one apply, then a move and a relabel) | 1,819/1,819 identical | nothing more |
| Text | see section 5 | the font setter and `measureText`/`fillText`/`strokeText` wrapped (runs); Excalidraw's faces declared at start (it declares them lazily, at the first metrics it needs, and a font string measured before that falls back) |
| Images | see section 6 | `naturalWidth`/`naturalHeight` on `Image`: Excalidraw draws an uncropped image by them; without them only cropped images were drawn |

Nothing of Excalidraw is patched (4.5). Its own `setCustomTextMetricsProvider` hook is exported and was not needed: the
canvas itself measures right, and drawing needs the same font choice as measuring.

## 4. The native canvas (7.4) `[proposed]`

**Decision: skia-canvas 4.0.0**, pinned exactly.

| | skia-canvas 4.0.0 | @napi-rs/canvas 1.0.11 | node-canvas 3 (cairo) |
|---|---|---|---|
| Text widths, matrix (15 scripts × 8 families, through `apply`) | **109/120 exact**, 117/120 within 1%, heights 120/120 | 41/120 exact, 43/120 within 1% | not measured: it draws with cairo and shapes with pango, not Skia as Chromium does |
| Why | uses the system's font manager (CoreText on macOS) for fallback, as Chromium does | scans font folders and misses macOS's system fonts (PingFang SC absent; `"Apple Color Emoji"` measures every character 20 px) | |
| Pictures with `textRendering: "optimizeLegibility"` | strongly differing pixels of a text board 0.96% → 0.12% (widths unchanged) | no equivalent tried | |
| Prebuilt binaries (`optionalDependencies`, no postinstall) | darwin-arm64 28.4 MB, darwin-x64 30.0, linux-x64-glibc 37.8, linux-arm64-glibc 37.1, linux-x64-musl 39.2, win32-x64 30.1, win32-arm64 27.1 (unpacked) | darwin-arm64 28.1, darwin-x64 33.0, linux-x64-gnu 34.8, linux-arm64-gnu 29.5, linux-x64-musl 31.1, win32-x64 38.4, win32-arm64 31.6 | not measured |
| Node ABI | N-API: runs on Node 24.3 and under Electron 44's Node 24.21 (`ELECTRON_RUN_AS_NODE=1`, measured) | N-API | not measured |
| Licence | MIT | MIT | not checked |

The server's targets are darwin/arm64, darwin/amd64, linux/amd64 and linux/arm64 (`scripts/build-server.sh`); every one has a
skia-canvas binary. Only Linux with glibc is a target: Alpine and other musl systems are not (the build asks for the `-glibc` packages
only, and `skia-binary.ts` has no musl entry). On linux-arm64 (Debian bookworm, glibc) `npm install skia-canvas@4.0.0` took 14 s and installed 36 MB
(measured in a container). Running the engine there was not measured: Docker Desktop's container store went read-only during
the run (section 12).

**How it ships.** Inside the headless writer's bundle (`hb-arch` D37, D38: `<headless>/engine/`), put there by
`copyEngineAssets` (section 2):

- `engine.mjs` (4 MB);
- `fonts/` (Excalidraw's fonts without Xiaolai, 0.43 MB, the same set the window ships);
- `node_modules/skia-canvas/` (0.3 MB of JS) with the target's binary as `lib/skia.node` (28–38 MB).

`hb-arch`'s W13 puts that bundle in `AI Whiteboard.app/Contents/Resources/headless/` (outside `app.asar`: a native module
cannot load from inside an asar) and in `bin/ai-whiteboard-server-<os>-<arch>/headless/`. For another target than the build
machine's, the binary comes from the npm package of that target (EN7). The runtime is `hb-arch`'s (D33): the app's Electron,
which runs the engine (measured: Electron 44's Node 24.21, `ELECTRON_RUN_AS_NODE=1`), or the Node 22+ of a remote server's
machine (skia-canvas needs Node 18 or later).

## 5. Fonts per script (7.1) `[proposed]`

**The problem, measured.** Excalidraw declares 232 FontFaces: Excalifont in 7 pieces, Nunito 5, Comic Shanns 4, Lilita One 2,
Virgil, Cascadia and Liberation Sans 1 each, and Xiaolai 209. Helvetica and Segoe UI Emoji are `local:`. Each is declared
with a `unicode-range`. A browser chooses, for each character, the face whose range holds it, then the next family of the
font string, then its default font, then the system's fallback for the character. The trial registered one file per family
and was right only for basic Latin.

**What makes Node agree** (`spikes/headless-engine/fonts.mjs`; each item was found by a measured difference):

1. **Every face Excalidraw declares**, taken from its own `new FontFace(...)` calls (no table copied by hand), registered under
   an alias of its own the first time a font string names its family.
2. **CSS weight matching.** Excalidraw declares Nunito at weight 500 only, and a normal-weight string uses it.
3. **Runs of one face by `unicode-range`.** The piece files hold glyphs outside their declared ranges (Google's subsets share
   glyphs), so a canvas that picks by glyph coverage keeps runs in one piece and kerns across what the browser splits.
   Measured: `ŽLUŤOUČKÝ …` in Nunito, 705.94 vs 706.24. The canvas's `measureText`, `fillText` and `strokeText` go run by run,
   each run with its own face.
4. **Blink's word shaping.** Blink shapes word by word (`CachingWordShaper`): a space, a no-break space and each CJK ideograph is
   a word of its own, so no kerning crosses a space. Measured: `n: T` in Liberation Sans, 34.45 in Chromium (the sum of its
   characters) vs 34.09 with the font's space–T kerning. Runs are cut there too.
5. **Families Excalidraw does not ship are left out**, as the window leaves them out: Xiaolai (12 MB) is not in the board
   view's builds (`build.mjs`). A `local:` family (Helvetica, Segoe UI Emoji) is the system's.
6. **The browser's fallback after the families**, in order:
   - Chromium's default font: Times on macOS; Times New Roman on Windows and Linux.
   - The system emoji font for an emoji cluster (VS16, ZWJ, skin tone, or emoji by default): Apple Color Emoji, Segoe UI
     Emoji or Noto Color Emoji.
   - On macOS, for a symbol that is an emoji only when asked to be (♥ ✔ ⚠ ☀ ✂ ☺ …), the text fonts CoreText picks there:
     Hiragino Sans, Zapf Dingbats, Lucida Grande, Apple Symbols, Helvetica, Menlo. The native canvas would take the colour
     emoji font for these.

   Right-to-left text is measured by runs too (a width does not depend on direction) but drawn whole by the native canvas.

**Measured, the text corpus** (`harness/textcorpus.mjs`: 42 lines × 8 families × 4 sizes, 16/20/28/36 = 1,344 widths, with
Excalidraw's own font strings; equal means within 0.01 px):

| Group | Virgil | Helvetica | Cascadia | Excalifont | Nunito | Lilita One | Comic Shanns | Liberation Sans |
|---|---|---|---|---|---|---|---|---|
| Latin (kerning pairs, punctuation, symbols, ligatures, spaces) | 40/40 | 40/40 | 40/40 | 40/40 | 40/40 | 40/40 | 40/40 | 40/40 |
| Accented Latin, Vietnamese, Turkish, Icelandic… | 36/36 | 36/36 | 36/36 | 36/36 | 36/36 | 36/36 | 36/36 | 36/36 |
| Cyrillic (Russian, Serbian, Ukrainian, Bulgarian, Kazakh) | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 | 20/20 |
| Greek | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 | 8/8 |
| CJK (Chinese, Japanese, Korean, mixed) | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% | 4/20 ≤1.29% |
| Emoji (ZWJ, flags, keycaps, skin tones, VS15/16) | 16/16 | 16/16 | 12/16 ≤3.7% | 16/16 | 16/16 | 16/16 | 16/16 | 12/16 ≤2.4% |
| Arabic, Hebrew, mixed RTL | 12/12 | 12/12 | 0/12 ≤31.6% | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| Devanagari, Thai, Georgian, Armenian | 16/16 | 16/16 | 8/16 ≤4.9% | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |

Total 1,188/1,344. Every width in Latin, accents, Cyrillic and Greek is exact (832/832). Heights are always equal: they come
from Excalidraw's metrics, not from the canvas.

**What differs, and why:**

- **Han and kana on macOS, every family: +0.06% to +1.29%.** Both sides use PingFang SC (asked of Chromium with CDP
  `CSS.getPlatformFontsForNode`). Chromium applies its Apple tracking table per size (12 px: 12.252, 20 px: 20.380, 36 px:
  36.288 for 你), while skia-canvas applies one ratio at every size (12.252, 20.420, 36.756). The rest of CJK (kana in Hiragino
  Sans, Hangul in Apple SD Gothic Neo) is exact.
- **Cascadia (deprecated in Excalidraw, no new element gets it) in Arabic, Hebrew and Thai.** CoreText's cascade for a
  monospace font (Courier New, Ayuthaya) is not the general one.
- **One symbol line in Liberation Sans** (♥ ☺ ✔︎ ⚠ in a font that has some of them itself).

**Other systems.** Text in Excalidraw's own fonts is the same on every system: the same font files, the same shaping, and
the default font only matters for characters a face lacks. What falls to the system's fonts follows the system, *in a window
too*: a window on Windows measures CJK and emoji with Microsoft YaHei and Segoe UI Emoji, one on macOS with PingFang and Apple
Color Emoji, and they store different sizes today. The headless writer measures them with the fonts of the server's machine.
On Linux that is fontconfig's fallback, and a bare server may have no CJK or emoji font at all. These are "Open for the user"
O2; EN8 measures Linux.

## 6. Images and `get_image` in Node (7.2, 6.4, 7.7) `[proposed]`

`export.ts` runs unchanged: Excalidraw's `exportToBlob` on a stand-in canvas, `toBlob` via skia-canvas's PNG encoder, and
`FileReader` for the base64. A PNG, a cropped JPEG, an SVG and an image inside a frame are all drawn. Before the
`naturalWidth` fix only the cropped one was drawn.

**The pictures of the harness** (warm window, given elements; size and bounds compared exactly). Strongly differing means
more than 64/255 in a channel.

| Case: picture | Size Chromium / Node | Bounds | Pixels differing | Strongly differing |
|---|---|---|---|---|
| trial: all / two shapes | 612×405 both / 612×122 both | same | 1.40% / 1.41% | 0.00% / 0.00% |
| scripts: all / the CJK row | 1259×982 both / **908×217 vs 909×217** | same / **0.32 px wider** | 4.40% / n/a | 0.05% / n/a |
| fonts: all | 652×942 both | same | 4.89% | 0.00% |
| frames-groups: all / frame / frame and children / region | equal | same | 2.03 / 0.33 / 2.22 / 0.02% | 0.01 / 0.00 / 0.02 / 0.00% |
| saved-board: all / frame / elbow arrow | equal | same | 1.70 / 0.45 / 1.55% | 0.03 / 0.00 / 0.15% |
| images: all / frame / svg | equal | same | 5.82 / 0.33 / 2.89% | 0.05 / 0.00 / 0.04% |
| large: all at scale 0.25 (1,199 elements) / region | 1643×715 both / 882×581 both | same | **22.76%** / 4.76% | **0.80%** / 0.03% |

Where the pixels differ (the diff pictures under `out/harness/`): text edges (anti-aliasing), the anti-aliased edge of
strokes, and decoded images by 1–2 levels (4.58% of the image board's pixels differ by 1–2 levels, 0.69% by 3–8). No shape
is displaced anywhere: every element is identical and every pair of bounds is equal, except where the CJK width differs.

**Chromium against itself.** The same pictures drawn by Chromium in two runs, at device pixel ratio 1 and 2, are
byte-identical in 13 of 17. The rest differ by up to 3.64% (the scale-0.25 board, by 1–8 levels). A window's picture does
not depend on its pixel ratio.

**So the count of 6.4 is the wrong measure for text** (7.7, confirmed). A board that is mostly small text differs on a
fifth of its pixels with no difference a person could see. O3 proposes the tolerance.

## 7. The faithfulness harness (6.1) `[proposed]`

`spikes/headless-engine/harness/run.mjs` with `cases.mjs`; it becomes `packages/board-engine/dev/faithful.mjs` (EN6).

- **The window side** is the shipped web target of the board view (`node build.mjs web`) in Chromium, mounted as the app
  mounts it, and asked with the bridge's `req` messages. It runs on given elements (the engine path), or with `--live` on the
  board on screen (`load`, then `target: "live"`, the scene from `snapshot`). `--cold` measures in a page that has shown no
  board and loaded no face, as a phone's hidden engine view does. Without `--cold`, the faces a case's text needs are loaded
  first.
- **The Node side** is `dist/engine.mjs` with the same requests.
- **Elements** are compared with every id replaced by its place in the scene (group ids by first use) and `seed`,
  `versionNonce` and `updated` left out. Numbers count as equal within 0.01. The replies (`created`, `updated`, `deleted`,
  `conflicts`, `rev`) are compared the same way.
- **Pictures** are compared by size, bounds, count, and the share of pixels differing (any amount, more than 64, and a
  histogram). A diff picture is written for each.
- **The cases** cover goal 6.1's list:
  - **trial**: the trial's board;
  - **scripts**: a long wrapping label per script in the normal and the hand font, relabelled and restyled;
  - **fonts**: all 8 families, text and labels, multi-line;
  - **frames-groups**;
  - **saved-board**: hand-drawn, an elbow arrow, a group, a frame, rotated text, freedraw, a curved dashed line; restored,
    then moved, relabelled, connected and deleted from;
  - **images**: PNG, cropped JPEG, SVG, an image in a frame; moved and resized;
  - **large**: 600 labelled shapes and 599 arrows (19 with labels), then a move and a relabel.

**Results:**

| Run | trial | scripts | fonts | frames-groups | saved-board | images | large |
|---|---|---|---|---|---|---|---|
| Window as shipped, given elements, faces loaded | 10/10 | 38/42 | 24/24 | 9/9 | 14/14 | 6/6 | 1819/1819 |
| Window as shipped, on screen (`--live`) | 9/10 | 27/42 | 24/24 | 9/9 | 12/14 | 5/6 | 1818/1819 |
| Window as shipped, cold page (`--cold`) | 4/10 | 13/42 | 11/24 | not run | not run | not run | not run |
| Window with EN3, on screen (faces loaded first) | 10/10 | 38/42 | 24/24 | 9/9 | 14/14 | 6/6 | 1819/1819 |
| Window with EN2 and EN3, cold page | 10/10 | 38/42 | 24/24 | 9/9 | 14/14 | 6/6 | 1819/1819 |

The 4 differences of "scripts" are CJK text (section 5); every other difference in the rows of the window as shipped is an `index` and `version` (8.2) or a size measured cold (8.1). The replies are the same in every run.

## 8. Two defects of today's window `[proposed]`

Both came out of comparing the window with itself. A headless writer cannot agree with a window that disagrees with itself.

**8.1 A text is measured before its face is loaded** (work package EN2). A page measures text with the faces it has loaded.
Excalidraw puts its faces in `document.fonts` only when it shows a board, and loads a piece only when drawn text needs it.
So the first text of a font in a script that the page has not drawn yet is measured in a fallback font. Measured
(`harness/probe-live.mjs`), for `Сервис авторизации — Žluťoučký kůň` in Nunito:

- a fresh page: 320.83 px;
- the same page once the faces were loaded: 353.26 px (Node: 353.26);
- a board on screen, 1.5 s later: still 320.83, at the same versions. Nothing corrects it.

Even plain Latin in Nunito measures 214.93 instead of 241.64 in a page that has drawn none. The board on screen shows the
label wider than its box until something re-measures it, and the file keeps the wrong size.

Fix (`spikes/headless-engine/variants/faces.ts`, `fonts-record.ts`, `endpoint-faces.ts`): `fonts.ts` keeps every FontFace
Excalidraw makes. Before `apply` and `delete` measure, `faces.ts` makes Excalidraw declare its faces if it has not yet, puts
them in `document.fonts`, and awaits `document.fonts.load("16px <family>", text)` for each family of the request and of the
live text elements. In Node the stand-in's `document.fonts.load` resolves at once: the same code, nothing to wait for.
With it, a cold page agrees with Node as a warm one does (section 7).

**8.2 `apply` leaves invalid fractional indices** (work package EN3). `convertToExcalidrawElements` numbers the elements of
each call from `a0`. Elements an apply adds to a board that has elements, and the label `relabel` makes anew, get indices
lower than the elements before them. On screen, Excalidraw's `updateScene` repairs them (`syncInvalidIndices`, which bumps
their version); on given elements nothing does, and Excalidraw exports no function that only does that (`restoreElements`
does it but also rewrites other fields: measured, a text's `boundElements: null` became `[]`). So the same request gives a
different `index` and `version` on screen and off screen.

Fix (`variants/apply-indices.ts`): `apply.ts` gives every run of elements whose index is missing or not above the one before
indices between its neighbours, with `fractional-indexing`'s `generateNKeysBetween` (the library and version Excalidraw
itself uses). Then `updateScene` finds nothing to repair, and both paths and Node end with the same scene.

Both fixes change what a window answers: 8.1 a text size (from wrong to right), 8.2 the `index` and `version` of new
elements. That touches 6.6's "a call made while a window holds the board gives the result it gave before", so it is O1.

## 9. Cost (4.10, goal 8) `[proposed]`

Measured with `harness/cost.mjs`, Node 24.3, skia-canvas:

- **Load:** a bare Node is at 55 MB. Loading the engine takes 70–100 ms and brings it to 121–133 MB. Under Electron's Node:
  69 ms, 121 MB.
- **First requests:** the first `apply` takes 7–9 ms. The first picture takes 50 ms (339 ms in one run, under Electron, the
  first after a build).
- **The large board:** 1,819 elements made by two applies in 260–430 ms (Chromium: 720–870 ms). One more update takes 0.4 ms.
  A picture of 1,199 elements at scale 0.25 takes 140–180 ms (Chromium 520–740 ms). The process then holds 176–227 MB.
- **Reload:** `restore` of the 1,819-element board (1.2 MB of JSON) takes 4–7 ms, and the first apply after it 0.7 ms.

So a reload costs well under a tenth of a second plus the server read, and the quiet time of 3.3 can be short.
`hb-arch` picks the number (goal 8); nothing in the engine argues for more than a few tens of seconds. With no agent working
away the process need not run (4.10), and starting it costs the load above.

## 10. Open for the user

**O1. May the window's own answers change, to be right?** EN2 makes a fresh window measure an agent's text with the right font
(today it can store a size measured in a fallback font: 320.83 for 353.26 px). EN3 gives new elements valid fractional
indices, so on screen and off screen give the same `index` and `version`. Both change what a window answers, against the
letter of 6.6.
*Recommendation: yes to both.* Without them, a window disagrees with itself (on screen vs off screen, fresh page vs used
one), and 3.4 and 6.1 cannot hold for any headless writer.

**O2. Text outside Excalidraw's fonts follows the machine's fonts.** CJK, emoji, Arabic, Hebrew, Indic, Thai and rare symbols
are measured with the system's fonts in a window today, so a macOS window and a Windows window already store different sizes.
The headless writer measures them with the server machine's fonts. On macOS they are exact, except:

- Han and kana in PingFang: +0.2% at 20 px, up to +1.3% at 36 px (Apple's tracking table, applied per size by Chromium and at
  one size by Skia);
- the deprecated Cascadia in Arabic, Hebrew and Thai;
- one symbol line.

On Linux this is not measured yet (EN8), and a server with no CJK or emoji font measures those characters as missing glyphs.
4.6 is met for every script Excalidraw ships fonts for: Latin, Latin-ext, Vietnamese, Cyrillic, Greek.
*Recommendation: accept it as the window's own behaviour, and let the server's setup notes name the fonts to install on Linux
(Noto CJK, Noto Color Emoji).* The alternative is to ship fonts for these scripts in both the window and the engine (Xiaolai
covers only the hand font; a CJK font is 10–20 MB, Noto Color Emoji 10 MB). That would make them equal everywhere, but it
changes what windows show and was not asked for. Not recommended now.

**O3. The tolerance of a picture (6.4 is `[proposed]`).** "No more than 2% of pixels differ" is met by 8 of the 17
pictures. Text-heavy and image boards differ more at "any difference" (4.4–5.8%, 22.8% for 1,200 labels at scale 0.25), all
in anti-aliasing and decoder rounding, and Chromium differs from itself by up to 3.6%.
*Recommendation: restate 6.4 as:*
- the same size and bounds;
- every element identical (that is the geometry);
- at most 1% of pixels differing by more than 64 in a channel (measured: at most 0.15% at scale 1, 0.80% at scale 0.25).

**O4. A native canvas of about 30–40 MB per platform ships with the server** (skia-canvas). *Recommendation: yes.* It is the
only measured way to meet 4.6 with real fonts, and it needs no system libraries.

**Taken by the orchestrator (Opus) for now, to be confirmed by the user at the end:** O1 yes (EN2 and EN3 go in), O2
accepted (setup notes name Noto CJK and Noto Color Emoji for Linux), O3 the restated tolerance (the harness also reports the
plain "share of pixels that differ" so the user sees both), O4 yes.

## 11. Work packages

Each is for Sonnet 5.5 alone. "Spike" means `spikes/headless-engine/` on branch `hb-engine` (the code to port, the numbers to
meet). Every package ends with a commit on its own branch. Test commands follow `AGENTS.md`. Playwright is installed with
`npm install --no-save playwright@1.64.1 && npx playwright install chromium` in the folder named, never saved.

### Wave 1 (in parallel)

**EN1. `packages/board-view/src/engine.ts`: the requests on given elements, out of `endpoint.ts`.**
- **Build:**
  - Move `elementsEngine` and the bodies of `apply`, `delete`, `restore` and `export` for `target: { elements }` into
    `src/engine.ts`, unchanged in behaviour, with `export type GivenOp = Exclude<EngineOp, { op: "snapshot" }>`,
    `export const engineOps` (the four, on given elements; a `"live"` target throws `RpcError("NO_BOARD", "no board is shown")`, as today) and
    `export async function request(op: GivenOp)` → value, or throws `RpcError`. The spike's `engine.ts` is the shape.
  - One helper for the reply, `answer(id, op, post)`: value → `res ok:true`, `RpcError` → its code and message, anything else →
    `FAILED`. It is what `endpoint.ts`'s `request()` does today; the endpoint and the Node endpoint (EN5) both use it.
  - `engine.ts` imports Excalidraw, `apply.ts`, `export.ts` and board-bridge types only: no React, no `Board.tsx`, no DOM
    beyond what `export.ts` already touches.
  - `endpoint.ts` calls `engineOps` for given elements and keeps its live branch and `snapshot` as they are.
  - Add `engine.ts` to the README's table.
- **Interface:** the reply values are those of `EngineValues` (board-bridge), as today.
- **Accept:**
  - `cd packages/board-view && npm test && npm run check`;
  - `npm test && npm run check` at the root;
  - `cd packages/board-view && npm run build:web && npm run build:webview && node dev/harness.mjs` (Playwright, see above)
    passes as before;
  - `git diff --stat` shows no change outside `packages/board-view`.
- **Do not touch:** `apply.ts`, `export.ts`, the messages, `packages/core`, the app.

**EN4. `packages/board-engine`: the stand-in page, the font runs, the canvas (Node only).**
- **Build:**
  - A new workspace package `@aiwb/board-engine` (`private`, `type: module`) with `dependencies: { "skia-canvas": "4.0.0" }`
    (exact) and `devDependencies` esbuild and @types/node, as board-view has them.
  - `src/fonts.ts` from the spike's `fonts.mjs`: `parseRanges`, `declare`, `usableFaces` (CSS weight matching),
    `nativeFont`, `runsOf` (by unicode-range, Blink word boundaries, the tail of default font, emoji font and symbol fonts),
    and the constants `NOT_SHIPPED`, `DEFAULT_FONT`, `EMOJI_FONT`, `SYMBOL_FONTS` (per platform, as in the spike). Font
    registration goes through an injected `register(file, alias): boolean`, so the module is testable without a canvas.
  - `src/canvas.ts`: skia-canvas only (drop napi), `register` via `FontLibrary.use`, `optimizeLegibility` on every context.
  - `src/page.ts` from `page.mjs` (no `AIWB_CTX_OPTS` knob): `installPage({ assets })`, idempotent.
  - TypeScript, checked like the other packages (`tsconfig.json` as board-view's, without DOM lib where possible). Add the
    package to the root workspaces (the root `package.json` already takes `packages/*`).
- **Interface:** `installPage(options: { assets: string }): void`; `runsOf(font: string, text: string, o?: { forDrawing?: boolean }): { font: string; text: string }[]`.
- **Accept:**
  - `cd packages/board-engine && npm test`, whose tests are under `test/`, with `node --test --experimental-strip-types` as
    board-view. They cover: `parseRanges` (`U+20-7e,U+a1` → two ranges); Nunito declared at 500 is used for weight 400; a
    family not shipped (Xiaolai) is dropped and a `local:` family kept by name; `runsOf` cuts `AŽ T` into faces by range and
    makes the space a run of its own; an emoji cluster with VS16 gets the emoji font, one with VS15 does not; a right-to-left
    text is one run for drawing and several for measuring.
  - Then `npm run check` there, and `npm test && npm run check` at the root.
- **Do not touch:** `packages/board-view`, any other package.

### Wave 2 (after wave 1; EN2 and EN3 in parallel with each other and with EN5)

**EN2. The board view loads the faces a request's text needs before it measures (8.1). Pending O1.**
- **Build:**
  - Port `variants/faces.ts` to `packages/board-view/src/faces.ts`: a DOM-free `needs(params, elements)` and
    `loadFaces(made, params, elements)`.
  - `fonts.ts` keeps every FontFace it makes (`madeFaces`, as `variants/fonts-record.ts`).
  - `engine.ts`'s `apply` and `delete`, and the live branch of `endpoint.ts`, `await loadFaces(...)` before `applyChanges`.
  - Note in the README.
- **Accept:**
  - `cd packages/board-view && npm test && npm run check`, with a new `test/faces.test.ts` for `needs`: families of
    create, update and label; the agent's style names; texts of live text elements;
  - root `npm test && npm run check`;
  - `node dev/harness.mjs` with one check added to `behaviours`: in a page that has shown no board, `apply` creating
    `Сервис авторизации — Žluťoučký kůň` in Nunito answers the same width as after the faces were loaded. The spike measured
    353.26 for the right width and 320.83 for the wrong one.
- **Do not touch:** `apply.ts`, the messages.

**EN3. `apply.ts` gives what it adds valid fractional indices (8.2). Pending O1.**
- **Build:**
  - A DOM-free `packages/board-view/src/indices.ts`:
    `validIndices<T extends { index?: string | null }>(els: T[], withIndex: (e: T, index: string) => T): T[]`, the
    algorithm of `variants/apply-indices.ts`.
  - `apply.ts` calls it on the final element list with `newElementWith`.
  - Add `"fractional-indexing": "3.2.0"` to board-view's dependencies: the version `@excalidraw/excalidraw` 0.18.1 pins.
    Check `npm ls fractional-indexing` shows one copy.
- **Accept:**
  - `cd packages/board-view && npm test && npm run check`, with a new `test/indices.test.ts`:
    - valid indices are untouched;
    - a trailing run after a valid one, a run in the middle, all null, and duplicates (`a0 a1 a0 a1`) become strictly
      increasing;
    - only the elements of invalid runs are passed to `withIndex`.
  - root `npm test && npm run check`;
  - `node dev/harness.mjs` with one check added to `behaviours`: two applies that create on a board, then a relabel, give on
    target `"live"` and on given elements the same `index` and `version` per element, strictly increasing.
- **Do not touch:** the rest of `apply.ts`'s behaviour, the messages.

**EN5. `packages/board-engine`: the Node endpoint, the bundle, its tests. After EN1 and EN4.**
- **Build:**
  - `src/bundle.ts`, the entry of the engine bundle. The stand-in page is installed by its first import; Excalidraw is made
    to declare its faces at load, as the spike's `entry.ts` does. It exports `createGivenEndpoint(post, { version, warn })` →
    `{ receive, refuse }` over `@aiwb/board-view/engine.ts`'s `request` and `answer`:
    - a `req` is answered once;
    - every other `ToBoard` message is ignored;
    - `refuse` answers a `req` `BAD_MESSAGE`, as `endpoint.ts` does.
  - `build.mjs` → `dist/engine.mjs`: esbuild, `platform: node`, `format: esm`, the board view's defines and slim plugin, CSS
    emptied, `skia-canvas` external (the spike's `build.mjs`). `dist/` is git-ignored.
  - `src/node.ts`, the module `packages/headless` imports, exactly as section 2 says (`createNodeEndpoint`,
    `ENGINE_EXTERNALS = ["skia-canvas"]`, `copyEngineAssets` for this machine's target). `createNodeEndpoint` imports
    `<assets>/engine.mjs`, posts `ready` once, and rejects with the reason when the binary or a font is missing.
  - `package.json` exports `"./node": "./src/node.ts"`.
  - The one line of `packages/headless/src/engine.ts` its header names: `export { createNodeEndpoint } from
    "@aiwb/board-engine/node";`, in place of the stand-in.
- **Interface:** section 2, and `architecture.md` section 4.
- **Accept:** `cd packages/board-engine && npm test && npm run check`. The tests use `copyEngineAssets` into a temp folder,
  then `createNodeEndpoint` on it, and cover:
  - `ready` is posted once, before the promise resolves;
  - every reply passes `validateEngineValue` of board-bridge for its op;
  - `snapshot` and `target: "live"` are `NO_BOARD`; a malformed `req` given to `refuse` is `BAD_MESSAGE`;
  - `export` of an empty scene is `EMPTY`; a picture over 8192 px is `TOO_LARGE`; a `scale` making it under 1 px is
    `BAD_ARGS`;
  - the trial case of the spike's `cases.mjs` gives 10 elements with the spike's widths for text in Excalidraw's own fonts,
    which hold on every system: Nunito "Hello world, a longer label" 241.64, Excalifont 242.02;
  - a PNG, a JPEG and an SVG image are drawn: the image's pixels are not the placeholder's grey `#E7E7E7`;
  - `assets` without `engine.mjs`, or with the binary removed, rejects with a message naming what is missing.

  Then:
  - `cd packages/headless && npm test && npm run check && node build.mjs`, after which `dist/engine/` holds `engine.mjs`,
    `fonts/` and `node_modules/skia-canvas/lib/skia.node`;
  - root `npm test && npm run check`.
- **Do not touch:** `packages/board-view` (if `engine.ts` needs a change, stop and report); in `packages/headless`, only the
  one line above.

### Wave 3

**EN6. The faithfulness harness in the product. After EN5; it passes fully with EN2 and EN3.**
- **Build:**
  - `packages/board-engine/dev/faithful.mjs` and `dev/cases.mjs`, `dev/chromium.mjs`, `dev/pictures.mjs`, from the spike's
    `harness/run.mjs`, `cases.mjs`, `chromium.mjs`, `pngs.mjs`, `hist.mjs` and `textcorpus.mjs`.
  - It builds the web target into a temp folder itself (`node ../board-view/build.mjs web --out <tmp>`), runs every case
    on given elements, `--live` and `--cold`, then the corpus, and writes a report (JSON and the diff pictures) to a
    folder it names.
  - It exits non-zero when any of these fails:
    - an element differs outside a list of known differences in the file (CJK and Cascadia on this system, each with the
      section of `plans/headless-board/engine.md` that explains it);
    - a picture's size or bounds differ outside that list;
    - more than 1% of a picture's pixels differ by more than 64 (O3).
  - `npm run faithful` runs it. Its header says how it runs and that it needs Playwright.
- **Accept:**
  - `cd packages/board-engine && npm install --no-save playwright@1.64.1 && npx playwright install chromium && npm run faithful`
    exits 0 on this machine with EN2 and EN3 in;
  - without them, the `--cold` part reports the cold-measure differences and exits non-zero, which shows the harness sees
    them;
  - `npm test && npm run check` at the root.
- **Do not touch:** board-view, the spike.

**EN7. `copyEngineAssets` for every server target. After EN5.**
- **Build:**
  - `copyEngineAssets(dir, { os, arch })` for a target that is not this machine's: the binary of
    `@skia-canvas/<os>-<arch>[-glibc]@4.0.0`, fetched with `npm pack` into a cache folder under the system temp folder, keyed
    by package and version. It is extracted and checked: the file is an ELF (Linux) or Mach-O (macOS) of the right
    architecture, and its size is within 10% of the published one.
  - It is written as `node_modules/skia-canvas/lib/skia.node` of `dir`.
  - A failed fetch is an Error that names the package and says the registry was not reached.
  - `hb-arch`'s W13 calls it from `scripts/build-server.sh` and `scripts/build-app.sh` through `packages/headless/build.mjs
    --os --arch`. Those scripts are theirs.
- **Accept:**
  - `cd packages/board-engine && npm test` (the check of the header, on a file made in the test);
  - `node -e "import('@aiwb/board-engine/node').then(m => m.copyEngineAssets('/tmp/<x>', { os: 'linux', arch: 'x64' }))"`
    for each of the four targets, listing `lib/skia.node` of the right kind (`file` names it);
  - `cd packages/headless && node build.mjs --os linux --arch arm64` makes a bundle whose engine runs in a
    `node:24-bookworm` container on this machine when Docker works (else say so in the report).
- **Do not touch:** the build scripts and the Go server (`hb-arch`'s W13 and W2 do that).

### Wave 4

**EN8. Fallback fonts per system, measured.** Run the corpus and the harness of EN6 in Chromium for Linux and in Node, in a
`node:24-bookworm` container with the fonts a server would have (Debian's, plus `fonts-noto-cjk` and `fonts-noto-color-emoji`).
Set `DEFAULT_FONT`, `EMOJI_FONT` and `SYMBOL_FONTS` for Linux in `src/fonts.ts` from what CDP `CSS.getPlatformFontsForNode`
names there (the spike's `probe-symbols.mjs` and `probe-fallback.mjs` way). Add the measured table to this document's
section 5, and the known differences for Linux to the harness's list.
- **Accept:** the corpus run in the container shows Latin, accents, Cyrillic and Greek 100% equal, and `npm run faithful`
  exits 0 in it.
- **Do not touch:** anything but `packages/board-engine/src/fonts.ts`, its tests, the harness's known list and this document.

**EN9. The documentation.** In `docs/architecture.md`, a section "The board engine in Node": what runs where, the stand-in
page, the font runs, the canvas, the fixes of EN2 and EN3, the harness. In `AGENTS.md`, add rows:
- "You changed `packages/board-view/src/{engine,apply,export,imagesize,faces,indices}.ts`: also
  `cd packages/board-engine && npm test`";
- `npm run faithful` in the table of Playwright scripts.

In `packages/board-engine/README.md`, its files table as board-view's.
- **Accept:** no tests (documentation only); the orchestrator reads it.

| Wave | Packages | Depends on |
|---|---|---|
| 1 | EN1, EN4 | nothing |
| 2 | EN2, EN3 (after O1), EN5 | EN1 (EN2, EN3); EN1 and EN4 (EN5) |
| 3 | EN6, EN7 | EN5 (and EN2, EN3 for EN6 to pass) |
| 4 | EN8, EN9 | EN6 (EN8); EN5, EN6 (EN9) |

Named EN, not E: `architecture.md` already has E1–E4, its confirmation tests (wave 5), and those need EN5 (the real engine);
`hb-arch`'s W13 (shipping) needs EN5 and EN7.

EN2 and EN3 each add a check to `packages/board-view/dev/harness.mjs`. Whichever merges second resolves the neighbouring
insertions there.

## 12. Not done, uncertain

- **Linux, measured only in part.** In a `node:24-bookworm` container on linux-arm64, `npm install` of both canvas libraries
  took 14 s (skia-canvas 36 MB, napi 29 MB). The engine, the corpus and the harness did not run there: Docker Desktop's
  container store went read-only during the run ("write …/io.containerd.metadata.v1.bolt/meta.db: read-only file system"),
  and no new container would start. It was healthy when the run began. The machine's other containers run there, so it was
  left alone (not restarted). EN8 is this run.
- **x64 (darwin and Linux) and Windows were not run.** Their binaries exist (sizes above). Windows is not a server target today.
- **The window's own variance.** The harness's window is Chromium 156 through Playwright. The desktop app is Electron 44
  (Chromium of its own) and phones are WebKit. Text in Excalidraw's fonts is shaped the same in all (the board view's harness
  runs both engines today), but pictures from WebKit were not compared.
- **Symbol fonts on macOS** are a fixed list fitted to Chromium's CoreText choices on this machine. CoreText chooses per
  character, so a symbol outside the corpus may still differ by a few pixels.
- **EN2 makes `apply` wait** for the faces it needs: about one font file fetch (from the app's own folder or `data:` URLs) the
  first time a page uses a family in a script, nothing afterwards.
