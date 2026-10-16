# @aiwb/board-engine

The board view's engine in Node: the requests on given elements (`restore`, `apply`, `delete`, `export`) answered with no screen, by
the code the window runs (`engine.ts` of `@aiwb/board-view`, with `apply.ts`, `export.ts`, `faces.ts` and `indices.ts`). The headless
writer (`@aiwb/headless`) uses it to change a board and draw its picture while no window is open. This package has no engine logic of
its own: it is the Node host, which is a stand-in page for Excalidraw, Excalidraw's fonts cut into runs of one face, and a native canvas.
How it fits with the rest: "The board engine in Node" in `docs/architecture.md`.

| File | What it is |
|---|---|
| `src/node.ts` | The module `@aiwb/headless` imports (`@aiwb/board-engine/node`). `createNodeEndpoint(post, { assets, version?, warn? })` → `{ receive(m: ToBoard), refuse(raw, error), close() }`: loads `<assets>/engine.mjs`, posts `ready` once, answers each `req` with one `res`, ignores every other message; rejects, posting nothing, with the reason when `assets` lacks `engine.mjs`, the native canvas or a font folder, or the bundle does not load. `ENGINE_EXTERNALS` (`["skia-canvas"]`): what the headless build leaves out of its bundle. `copyEngineAssets(dir, { os, arch })`: writes `engine.mjs`, `fonts/` and `node_modules/skia-canvas/` with the target's binary as `lib/skia.node`. Build time only; the headless build bundles this file, so it imports nothing heavy. |
| `src/bundle.ts`, `src/page-first.ts` | The entry of the engine bundle. `page-first.ts` installs the stand-in page and is the first import, because Excalidraw makes images and its `FontFace`s as it is evaluated; `bundle.ts` makes Excalidraw declare its faces at once (one text element), then exports `createGivenEndpoint` over `answer` of `@aiwb/board-view/engine.ts` and `excalidrawVersion`. `snapshot` and a `"live"` target are answered `NO_BOARD`; a `refuse`d `req` is answered `BAD_MESSAGE`. |
| `src/page.ts` | The stand-in page: `installPage({ assets })` (idempotent) gives the global object what Excalidraw's element code and its export reach for: `window`, `document` (`createElement` of canvas, img and anything else, `fonts`), `FontFace`, `FileReader`, `Image`, `Path2D`, `DOMMatrix`, `ImageData`, `matchMedia`, `localStorage`, the observers and a few more. A canvas is skia-canvas's, with `toBlob`, and its `font` setter, `measureText`, `fillText` and `strokeText` go through the font runs. `document.fonts.load` resolves at once. Nothing of Excalidraw is patched. |
| `src/fonts.ts` | Every face Excalidraw declares (family, file, `unicode-range`, weight) is kept and registered with the canvas under an alias of its own the first time a font string names its family. `nativeFont` rewrites a font string into those aliases; `runsOf(font, text, { forDrawing? })` cuts a text into runs of one face by `unicode-range` and Blink's word boundaries (a space and each CJK ideograph is a word), then the default font, the system's emoji font for an emoji cluster, and on macOS the text fonts CoreText picks for symbols. `NOT_SHIPPED` (Xiaolai), `DEFAULT_FONT`, `EMOJI_FONT` and `SYMBOL_FONTS` are per platform; `AIWB_DEFAULT_FONT`, `AIWB_EMOJI_FONT`, `AIWB_SYMBOL_FONTS` and `AIWB_FONTS_ALL=1` override them for measuring. Registering goes through an injected function, so the module is testable without a canvas. |
| `src/canvas.ts` | skia-canvas, the only file that imports it: canvases whose context has `textRendering: "optimizeLegibility"` (as Chromium draws), `register(file, alias)` by `FontLibrary.use`, the PNG encoder. |
| `src/skia-binary.ts` | Build time: the binary of skia-canvas 4.0.0 for a target other than this machine's, from its npm package (`@skia-canvas/<os>-<arch>[-glibc]`, `npm pack`, kept in a cache folder under the system temp folder), checked by its ELF or Mach-O header and by its size (within 10% of the published one). A failed fetch is an Error that names the package and says the registry was not reached. |
| `build.mjs` | esbuild → `dist/engine.mjs` (git-ignored; about 4 MB): `src/bundle.ts` with the board view's settings (`conditions: production`, the defines, the slim plugin, CSS and font files emptied), Excalidraw inside and `skia-canvas` outside. `buildEngine({ ifStale })` is what `copyEngineAssets` calls: it builds only when `dist/engine.mjs` is missing or older than the sources of this package, the board view and the bridge. `node build.mjs` builds it. |
| `test/` | `node --test` with type stripping: `fonts.test.ts` (unicode ranges, weight matching, runs, emoji and right-to-left text), `page.test.ts` (the stand-in page on the real canvas and Excalidraw's font files), `skia-binary.test.ts` (the header and size checks on files made in the test, the cache), `node.test.ts` (`copyEngineAssets` and `createNodeEndpoint`: `ready` once, what a missing file says), `engine.test.ts` (each request through the endpoint: values the bridge accepts, `EMPTY`, `TOO_LARGE`, `BAD_ARGS`, `NO_BOARD`, widths of text in Excalidraw's own fonts, PNG, JPEG and SVG images drawn). `support.ts` makes the assets in a temp folder. |
| `dev/faithful.mjs` | The faithfulness harness: the same requests to the board view's web build in Chromium and to the Node engine through `createNodeEndpoint`, and the answers compared. Four runs: `given` (elements given, faces loaded first), `live` (the board on screen), `cold` (a page that has shown no board), `corpus` (the width of 42 lines in 8 families at 4 sizes). Elements are compared with ids replaced by their place in the scene and `seed`, `versionNonce` and `updated` left out; pictures by size, bounds and the share of pixels that differ by more than 64 in a channel (at most 1%). Exits 1 on a difference outside `KNOWN`, its list of differences of this system, each with its reason (Han and kana on macOS, the deprecated Cascadia in some scripts; Linux has none yet). Writes `out/faithful/report.json` and a diff picture of each picture (`out/` is git-ignored). |
| `dev/cases.mjs`, `dev/chromium.mjs`, `dev/node.mjs`, `dev/pictures.mjs`, `dev/corpus.mjs` | The harness's parts: the boards and `apply` sequences (labels in every script, every font, frames and groups, a saved board with an elbow arrow, images, 1,819 elements); the window side (Playwright); the Node side; the pictures and their comparison; the text corpus. |

```sh
npm test && npm run check        # the unit tests and the type check; builds dist/engine.mjs and runs it in Node
npm run build                    # dist/engine.mjs only
npm run faithful                 # the harness; needs Playwright and builds the board view's web build into a temp folder
```

The harness needs Playwright, which is no dependency of the repository
(`npm install --no-save playwright@1.64.1 && npx playwright install chromium` in this folder; Chromium 156 is the reference), and spends
no money. Its header lists the options (`--runs`, a case name, `--out`, `--dpr`, `--web`).

## What the engine does and does not match

A request gives the same elements, replies and picture size and bounds as the window; the pixels differ in the anti-aliased edge of text
and strokes. Text in Excalidraw's own fonts has the same width as in a window (Latin, accented Latin, Vietnamese, Cyrillic and Greek:
all of the harness's corpus). Text in other scripts is measured with the machine's fonts, as a window does on its machine; on macOS Han
and kana come out up to 1.3% wider. On Linux those characters need Noto Sans CJK and Noto Color Emoji installed, and Linux has not been
measured against a browser yet (`DEFAULT_FONT` and `EMOJI_FONT` are set for it; `SYMBOL_FONTS` is empty).

## What the bundle is

`copyEngineAssets` writes, and the headless writer's build puts in `engine/` of its bundle: `engine.mjs`, `fonts/` (Excalidraw's, without
Xiaolai), and `node_modules/skia-canvas/` (its JavaScript, 0.3 MB) with the native binary of the target (28 to 38 MB) as `lib/skia.node`,
the first place skia-canvas looks. A native module cannot load from inside an asar archive, so the Mac app carries the bundle in
`Contents/Resources/headless`. The runtime is Node 22 or later, or the app's Electron run as Node.
