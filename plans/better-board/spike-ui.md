# Spike bb-spike-ui: tldraw in the app, our own UI, Miro navigation, the sticky

The UI risk spike of the better-board prototype (goal 3.1, 3.2, 3.3, 4.1, 4.6, 6.1, 7.2, 7.3, 8.3). Built in
`spikes/tl-ui/` (tldraw **5.6.0**, pinned exactly, recorded in `decisions.md`): a standalone page with seeded mock
elements, built the way the app builds today's board. Detail reports from the child runs:
`spike-ui-nav.md` (navigation, touch), `spike-ui-ctx.md` (contextual toolbar), `spike-ui-embed.md` (assets, CSP, Electron,
the app's page, the phone page). Screenshots: `shots/spike-ui-*.png`.

```sh
cd spikes/tl-ui
npm install                 # its own node_modules (not a workspace)
npm test && npm run check   # the shrink-to-fit unit tests (12) and the type check
node build.mjs --dev        # dist/: board-tl.js, board-tl.css, fonts/, index.html (the app's CSP); open dist/index.html
```

`node build.mjs` without `--dev` is the production bundle; from `file://` with no licence key tldraw hides it after 5 s
(see "Licence"). Research scripts were temporary (`/tmp/bb-spike-ui*`), as ORCHESTRATION.md asks.

## Answers in short

| Question | Answer |
|---|---|
| A. Embedding | **A second web target of the same kind as `board.js`**: `board-tl.js` (IIFE, defines `window.aiwbBoardTl.mount(element, options)`, its own React root), `board-tl.css`, `fonts/` beside it; mounted into a box of the app's page like `aiwbBoardView`. No iframe. Renders under the CSP the app ships, from `file://`, with no network. A one-file page (fonts as `data:`) is the phone's way, as today. |
| B. Our UI only | `hideUi` + every `TLUiComponents` entry `null`. tldraw's shortcuts, clipboard and actions stay (they live in the UI context, not the layout). Our main toolbar is a child of `<Tldraw>`, the contextual toolbar is `components.InFrontOfTheCanvas`, both read the editor with `useValue`. Nothing of tldraw's chrome is in the page; the dev build shows tldraw's licence watermark ("Get a license for production", bottom right). |
| C. Navigation | Wheel/pinch/Ctrl-wheel zoom, zoom limits, Space-drag, middle-drag: **options only** (camera options, editor options). Drag-on-canvas pans, Shift-drag brushes, selection cleared on click not on pan, double-click makes a sticky: **select tool overrides** (`src/nav/select.ts`, subclasses of tldraw's own `pointing_canvas` and `idle` states plus a `panning_canvas` state). Touch: see the table below. |
| D. Sticky | **A custom `ShapeUtil` (`sticky`)**, not tldraw's `note`. Shrink-to-fit is a pure function of a text-measure callback (`src/sticky/fit.ts`, 12 unit tests), run in `onBeforeCreate`/`onBeforeUpdate` through `editor.textMeasure.measureHtml`, so the board host's skia-canvas measure runs the same code. Colour is our own style prop `aiwb:sticky-color` (16 Miro-like colours), so the last colour is tldraw's own "style for next shape". |
| E. Fonts | **tldraw's own IBM Plex Sans (`sans`)** as the font of every element for the prototype, set as the next-shape font style at mount. The woff2 files ship with `@tldraw/assets`, are OFL, and skia-canvas 4.0.0 loads them and measures **exactly** what Chromium measures (below). A Miro-like font later is one entry of tldraw 5.6's theme (`theme.fonts.sans`) plus the files. |

## A. Embedding

Today the Excalidraw board on the web build is not an iframe: `@aiwb/board-view`'s web target `board.js` is loaded by
`app/public/index.html` before the app's bundle, defines `window.aiwbBoardView`, and `app/src/platform/board.web.tsx`
mounts it into a `View`'s DOM element (its own React root, the messages of the bridge as function calls). The Electron
window loads `app/dist-web/index.html` with `loadFile` (`file://`), under the CSP of `cspFor()` in
`app/scripts/export-web.mjs` (`script-src 'self'`, `font-src 'self' data:`, `img-src 'self' data: blob: aiwb-picture:`,
`connect-src 'none'`). On a phone the board is a one-file HTML page in a web view (fonts as `data:` URLs, CSP by hash).

The spike builds tldraw the same way (`spikes/tl-ui/build.mjs`: one esbuild configuration, IIFE, `target: safari16`),
and its page carries the app's CSP imported from `cspFor()`, not copied. Results (Chromium from `file://`; Electron and the
app's page: `spike-ui-embed.md`):

- tldraw renders and works under that CSP. It needs **no worker, no wasm, no eval** and no `connect-src`: fonts load through
  `FontFace` from `fonts/` (`font-src 'self'`), cursors are CSS `data:` SVGs, the export and patterns use `blob:`/`data:`
  images (allowed).
- **Assets.** Only the 16 woff2 fonts (1.3 MB) are shipped. tldraw *preloads* every icon and embed icon it is given as a
  cross-origin `<img>`, which `file://` refuses (CORS errors, 21 failed requests); the icons are for tldraw's own UI, which
  is not shown, so they are given as `""` and tldraw skips them (`src/assets.ts`). Translations: only English is built in;
  any other browser locale makes tldraw `fetch` a JSON file (blocked by `connect-src 'none'`), so the locale is forced to
  `en` at mount. The asset base is the folder of `board-tl.js` (`document.currentScript`, as board-view's `assetpath.ts`).
- **The page's font.** tldraw leaves the font of its own canvas chrome to the page: frame names inherited the page's
  Times. `board.css` sets `.tl-container { font-family: var(--tl-font-sans) }`. (tldraw measures frame names with
  `"Inter, sans-serif"` and draws them in SVG export with `"Arial"`, fonts it does not ship: a fidelity point for the board
  host's pictures, 6.5.)
- Size: `board-tl.js` 2.0 MB minified (production) / 5.5 MB (development, unminified), `board-tl.css` 78 KB, fonts 1.3 MB.
  (Gzip sizes and the app-page check: `spike-ui-embed.md`.)

**Decision: a second web target of the same kind**, `packages/board-tl` built into `app/public/board-tl/` (beside
`app/public/board/`), loaded by `index.html` and mounted by a `board-tl.web.tsx` host like `board.web.tsx`, and a one-file
`build:webview` for phones. Why: it is how the app already ships a board (same build, same CSP, same `file://` story, same
web view story on phones), the app's Metro bundle never sees tldraw, and the two React roots share nothing but the
element. An iframe would add a second document, a `frame-src`/`child-src` to the CSP and a postMessage hop for every sync
message, for nothing the in-page target lacks. The difference from `board.js`: the new board's traffic is sync messages
over the transport (goal 7.4), so the mount takes a socket-like object (the custom `TLPersistentClientSocket`'s ends)
rather than the bridge's request/response messages.

## Licence (what the spike saw; goal 4.2, 8.6)

From tldraw 5.6's `LicenseManager`:

- tldraw counts a page as **development** if it is served over `http:` (any host), over `https:` on a loopback host, or
  bundled with `NODE_ENV !== "production"`. A `file://` page with a production bundle is **production**.
- Production with no key: a console banner, a tracking request to
  `https://cdn.tldraw.com/5.6.0/watermarks/watermark-track.svg?...&url=<the page's file:// path>` (blocked by our CSP), and
  **after 5 s the editor is replaced by an empty licence gate** (`[data-testid=tl-license-expired]`). Seen in the spike: the
  page goes blank at 5 s. The Electron window (`file://`) would hit this.
- Development: the editor stays, with tldraw's watermark (a small "Get a license for production" link, bottom right), and
  no tracking request.
- **So the prototype's board bundle is built with `NODE_ENV=development`** (`build.mjs --dev`): the prototype runs in
  development, which goal 4.2 accepts. No watermark is removed and no check is bypassed; the dev build is what tldraw
  itself treats as development. Recorded in `decisions.md`.
- A release needs a key valid for the window's origin. Keys have a `NATIVE_LICENSE` flag: its hosts are regular
  expressions tested against `location.href`, which is how a `file://` (Electron) or app-bundle (web view) page can be
  licensed. Keys also carry feature flags; without a valid licence in production the `collaboration` feature is off
  (`getEnabledFeatures`), which matters for `@tldraw/sync` (multiplayer, goal 3.4). Price and terms are not in the code;
  the licence finding of the report needs tldraw's sales answer.
- Also: with a tracked/evaluation/watermarked licence tldraw pings its CDN; our CSP blocks it. Whether a licence requires
  that ping to succeed is a question for tldraw.

## B. Our own UI, tldraw's hidden

`src/Board.tsx`: `<Tldraw hideUi components={{ ...every TLUiComponents key: null, InFrontOfTheCanvas: ContextToolbar }}>`
with `<MainToolbar/>` as a child. What `hideUi` does in 5.6: `TldrawUiInner` still runs `useKeyboardShortcuts()` and
`useNativeClipboardEvents()` and renders the children, but not `TldrawUiContent` (menus, panels, toolbar, toasts,
dialogs, a11y). So undo/redo, delete, duplicate, select all, copy/cut/paste, arrow nudges, `Shift+1`/`Shift+2` keep working
with no tldraw element on screen. Editor-level components (canvas, shapes, selection handles, collaborator cursors) are
kept: they are the board, not tldraw's chrome.

- **Main toolbar** (`src/ui/MainToolbar.tsx`): select, sticky, rectangle, ellipse, text, connector, frame, pen; zoom out,
  the zoom in percent (click: 100%), zoom in, fit. `editor.setCurrentTool`, `setStyleForNextShapes(GeoShapeGeoStyle, …)`
  for the shape type, `zoomIn/zoomOut/resetZoom/zoomToFit`. A click with a tool places an element at its default size and
  a drag sizes it; the tool returns to select after one element (tldraw's own tools do this; the pen stays).
- **Contextual toolbar**: positioned at `editor.getSelectionRotatedScreenBounds()` (screen coordinates; it follows pan,
  zoom and moves because `useValue` re-reads it), hidden while the editor is in a gesture state (`select.translating`,
  `resizing`, `rotating`, `dragging_handle`, `brushing`, `panning_canvas`, the `pointing_*` handle states). Its per-type
  content and the gaps against goal 3.3: `spike-ui-ctx.md`.
- Positioning detail for board-tl: the toolbar must be clamped to the viewport and flip below the selection when there is
  no room above (the spike's runs off the edge for a selection near the top right; `shots/spike-ui-sticky-board.png`).

## C. Navigation

The spike's navigation is in `src/nav/options.ts` (options) and `src/nav/select.ts` (overrides). Full checks, with
touch at the phone and tablet viewports: `spike-ui-nav.md`.

| Behaviour (goal 3.1) | How |
|---|---|
| Wheel / two-finger swipe pans | option: `cameraOptions.wheelBehavior: 'pan'` |
| Ctrl/⌘ + wheel and trackpad pinch zoom around the pointer | tldraw's own with `wheelBehavior: 'pan'` (Ctrl inverts it; its gesture handler maps ⌘ to `ctrlKey`; Chromium sends a pinch as Ctrl+wheel) |
| Zoom limits ~10%–400% | option: `cameraOptions.zoomSteps: [0.1, 0.25, 0.5, 1, 2, 4]` (first and last are the limits) |
| Space + drag pans, also over elements | option: `spacebarPanning: true` (default) |
| Middle-button drag pans | tldraw's own, no option (`Editor` sets `isPanning` for button 1) |
| Right-button drag | option `rightClickPanning` (default true); set **false** to keep the right button for a context menu |
| Left drag on empty canvas pans | **override**: our `pointing_canvas` goes to a new `panning_canvas` state on drag |
| Selection kept when panning, cleared by a click on empty canvas | **override**: tldraw clears it on pointer down; ours on pointer up |
| Shift (or Ctrl/⌘) drag on empty canvas brushes | **override** routes it to tldraw's own `brushing` |
| Drag on an element moves it (or the selection) | tldraw's own (`pointing_shape` → `translating`) |
| Drag inside an unfilled shape | tldraw treats the inside of a hollow shape as canvas, so it would pan; **override** hands it to `pointing_shape` (spike-ui-nav.md, item 10) |
| Double-click on empty canvas makes a sticky ready to type | option `createTextOnCanvasDoubleClick: false` + **override** of `idle.onDoubleClick` |
| `Shift+1` fit board, `Shift+2` fit selection | tldraw's own shortcuts (kept with `hideUi`) |
| Touch: one finger pans / moves, two fingers pinch | one finger on canvas reaches the same `pointing_canvas` → `panning_canvas`; two fingers are tldraw's own pinch (`@use-gesture`) |

How the overrides are made without patching tldraw: the select tool's child-state classes are not exported, so
`MiroSelectTool extends SelectTool` returns `SelectTool.children()` with `pointing_canvas` and `idle` replaced by subclasses
of the classes found there by id, plus `PanningCanvas`. Passing it in `tools` replaces the default `select` (tldraw merges
tools by id). The subclasses call the base methods through the prototype for what they don't change. This depends on the
state ids and on `onEnter/onPointerMove/onPointerUp/onDoubleClick` being the hooks tldraw calls: stable across 3.x–5.x,
but a tldraw upgrade must re-check it.

## D. The sticky

### Why not tldraw's `note`

Read from 5.6's `NoteShapeUtil`:

- It **grows** instead of shrinking: when the text overflows, `growY` makes the note taller. Its only font adjustment,
  `fontSizeAdjustment`, shrinks the font until no single word is wider than the note, never for height. Both are computed
  in private methods (`getNoteSizeAdjustments`, `measureNoteLabelSize`) called from `onBeforeCreate/onBeforeUpdate`;
  changing that means overriding private methods, i.e. depending on tldraw's internals.
- It resizes only by **scale** (`resizeMode: 'scale'`): the whole note and its text are scaled, so "resizing refits the
  text" is not a refit at all, and the stored size is a scale factor.
- Its look is hard-coded: the paper shadow (`getNoteShadow`), the bottom border at low zoom, the attribution badge (that
  one can be `null`).
- Its options (5.6's display values: `noteWidth`, `noteHeight`, `noteBackgroundColor`, `labelFontSize`, …) can make it
  square and recolour it, but `labelFontSize` cannot be a fit (it is read *inside* the measurement loop).
- Colour is tldraw's `DefaultColorStyle`, shared with every other shape (next point).

### What the custom shape is

`src/sticky/StickyShapeUtil.tsx`, type `sticky`, props: `w`, `h` (square: `isAspectRatioLocked`), `color`
(`aiwb:sticky-color`), `font` (`DefaultFontStyle`), `align` (`DefaultHorizontalAlignStyle`), `verticalAlign`
(`DefaultVerticalAlignStyle`), `richText`, `fontSize` (0 = automatic, else a fixed size), `fitted` (the size drawn, written
by the fit). It draws with tldraw's exported `RichTextLabel` (so editing, rich text and the text-editing keyboard behaviour
are tldraw's) and exports with `RichTextSVG`. Tool: `StickyTool extends BaseBoxShapeTool` (click → 200×200, drag → sized,
square, back to select).

- **Shrink-to-fit** (`src/sticky/fit.ts`): `fitFontSize({ w, h, padding, fixed?, empty?, min?, max?, step? }, measure)`
  → `{ fontSize, overflows, measured }`. `measure(fontSize, maxWidth)` returns `{ w, h, scrollWidth }` of the text laid out
  at that size, words never broken. Binary search on integer sizes between 6 px and `0.24 × w` (48 px on a 200 px note):
  fitting is monotonic in the font size, so at most ~7 measurements. A text fits when its height and its widest word fit
  the inner box (0.5 px tolerance). Fixed size: kept, with `overflows`. Empty: the largest size, no measuring. No DOM and
  no tldraw import: the board host runs it as it is.
- **Where it runs**: `onBeforeCreate` and `onBeforeUpdate` (when the text, size, font or fixed size changed), the hooks
  tldraw's own note uses for `growY`. The measure is `editor.textMeasure.measureHtml(renderHtmlFromRichTextForMeasurement(...),
  { …, disableOverflowWrapBreaking: true, measureScrollWidth: true })` — the same call tldraw's note makes. The board
  host replaces `editor.textMeasure` with its skia-canvas measure, so it needs `measureHtml` with those two options
  (the widest word as `scrollWidth`); then the same code fits there.
- **Only the changing peer fits.** tldraw calls `onBeforeCreate/onBeforeUpdate` from `editor.createShapes/updateShapes`,
  not as store side effects, so remote changes are not refitted by every window (no back-and-forth between two windows
  whose measures differ by a fraction). Consequence for the board host: agent operations must go through the editor API
  (`createShapes/updateShapes`), not `store.put` or `room.updateStore` with raw records, or the fit does not run.
- **Fonts first.** A fit measured before the font face loaded stores a size for a fallback font. The spike awaits
  `editor.fonts.ensureFontIsLoaded` for the sans faces before seeding; board-tl must do it before it lets a person edit
  (the board host loads fonts synchronously).
- **Colour.** First the spike put the Miro colours into tldraw's `DefaultColorStyle` through 5.6's theme registry
  (`themes` prop; `registerColorsFromThemes` adds colour names at runtime). It works, but tldraw keeps one "next" value per
  style prop, so choosing a sticky colour also coloured the next rectangle, arrow and text, and the first sticky was
  tldraw's default black. Now the sticky has its own style prop `aiwb:sticky-color` (`StyleProp.defineEnum`, default
  `light-yellow`): "set the style of the selection" and "a new note gets the colour last used" are tldraw's own machinery.
  The 16 colours: `light-yellow, yellow, orange, light-green, green, dark-green, cyan, light-pink, pink, violet, light-red,
  light-blue, blue, dark-blue, grey, black` (stored by name; theme-independent, 4.10). The theme registry remains the way
  to give *shapes* a Miro-like palette.

### Checked (Playwright, dev build, desktop 1280×800, from `file://`)

| Check | Result |
|---|---|
| Sticky tool click → note | 200×200, `light-yellow`, fitted 48 px, tool back to select |
| Typing into it, 5 → 159 characters | fitted 48 → 34 → 25 → 21 → 18 → 16 px; size stays 200×200; the drawn text (168×154) is inside the box |
| Resize ×2 / ×0.3 / by the corner handle (+80,+20) | 400×400 fitted 36; 120×120 fitted 8; 280×280 (stays square) fitted 24 |
| Colour from the contextual toolbar, then a new note | the selected note turns `cyan`; the next note is `cyan` |
| Drag-create 150×60 | 150×150 (square), fitted 36 (empty: 0.24 × 150), back to select |
| Double-click on empty canvas | a new sticky, in editing, typing goes into it |
| Colour change then `editor.undo()` | restored |
| Seeded long note | 16 px, fits (`shots/spike-ui-seeded.png`) |

Screenshots: `shots/spike-ui-sticky-shrink.png` (a long text shrunk, editing), `shots/spike-ui-sticky-board.png`,
`shots/spike-ui-seeded.png`.

## E. Fonts

**Recommendation: tldraw's own IBM Plex Sans (`sans`) for every element in the prototype.** Set as the next-shape font at
mount (`setStyleForNextShapes(DefaultFontStyle, 'sans')`; tldraw's default is its hand-drawn `draw`).

- The files are in `@tldraw/assets/fonts` (woff2; Medium is tldraw's "normal", Bold its bold, with italics), shipped
  beside the bundle; nothing to choose, license (OFL) or host.
- **skia-canvas 4.0.0 (the board host's canvas) loads them** (`FontLibrary.use('tldraw_sans', [Medium, Bold])`) and
  measures the same widths Chromium does to the hundredth of a pixel: "Hello world, this is a sticky" at 24 px 292.37
  (bold 301.54), Cyrillic/Czech at 16 px 281.76, Shantell (draw) at 24 px 338.45 — identical in both. The board host must
  register the files under tldraw's family names (`tldraw_sans`, …): a request for weight `normal` then picks the Medium
  file (it declares 500).
- Miro-like alternative: tldraw 5.6's theme has `fonts: { sans: { fontFamily, faces } }` (and `TLThemeFonts` can be
  augmented with more names), so swapping in Inter or Open Sans is one theme entry and its files, for both sides. Not worth
  doing before the prototype works; Plex's Medium as body weight is a little heavier than Miro's.
- Frame names are measured in `"Inter, sans-serif"` and exported in `"Arial"` by tldraw (neither shipped): the board host
  should give those families a face (or board-tl a frame label of its own) for 6.5.

## Guidance for `packages/board-tl`

1. **Package shape**: `src/model/` (schema: `StickyShapeUtil` without React parts split out if the board host wants
   it lighter — but the board host runs the editor and the SVG export, which need the components anyway; style props;
   `fit.ts`; the agent-term mapping later), `src/ui/` (toolbars), `src/nav/` (the select tool), `src/web/entry.tsx`
   (`window.aiwbBoardTl`), `build.mjs` (`web` → `app/public/board-tl/`, `webview` → one file). Lift the spike's files as
   they are; `fit.ts` and its test unchanged.
2. **Pin** `tldraw` and `@tldraw/assets` exactly at 5.6.0 (+ `@tldraw/sync-core` / `@tldraw/sync` at 5.6.0 for 7.4).
3. **Build** with `NODE_ENV=development` for the prototype (licence above), minified anyway. Ship `fonts/` only; blank
   icons and embed icons; force locale `en`.
4. **Mount**: `<Tldraw hideUi components={…all null…} shapeUtils={[StickyShapeUtil]} tools={[MiroSelectTool,
   StickyTool]} cameraOptions={CAMERA} options={OPTIONS} assetUrls={ASSET_URLS}>`; at mount: locale `en`, next font
   `sans`, await the sans faces, then connect the store (sync) and allow editing.
5. **Shapes and props the board host must know**: the `sticky` util and `aiwb:sticky-color` are part of the schema; a
   record with a type or style value one side does not know fails validation there. One module, imported by both.
6. **Text measure contract for the board host**: `measureHtml(html, { fontFamily, fontSize, lineHeight, maxWidth,
   fontWeight, fontStyle, padding, disableOverflowWrapBreaking, measureScrollWidth }) → { x, y, w, h, scrollWidth }`,
   for the sticky (and tldraw's own shapes).
7. **Agent ops** through `editor.createShapes/updateShapes` (the fit runs there); the sticky's `fontSize: 0` means
   automatic, `fitted` is output only.
8. **Contextual toolbar**: clamp to the viewport, flip below the selection near the top; the per-type controls and the
   gaps of tldraw's styles against goal 3.3 (one colour for a shape's fill and border, size driving both stroke and
   label): `spike-ui-ctx.md`.
9. **tldraw upgrades** re-check: the select tool's child-state ids and hooks, `hideUi`'s keeping of shortcuts, the
   `AssetUrlsProvider` skipping `""`, the licence rules above.

## What was hard / surprising

- The licence gate: the production bundle works for 5 s from `file://` and then vanishes. It first looked like random
  failures in the research runs (undo not restoring, a double-click doing nothing) until the screenshot was blank.
- tldraw's asset preloading of its UI icons fails under `file://` even with the UI hidden.
- The shared "next style" of `DefaultColorStyle` (above): the theme route to a sticky palette works technically but
  couples sticky and shape colours.
- tldraw relies on the page's font for frame names.

## Not done here

- Multiplayer, the board host, agent terms (other spikes).
- The full per-type contextual toolbar is in the child report; quick-add "+" handles, Alt-drag duplicate (tldraw's own),
  the zoom controls' styling, the dark theme (out of scope).
- Phones beyond the one-file page check in a desktop engine (no simulators in this goal).
