# The window's view (`packages/board-tl/src/view`): findings per task

Each task of the window lane adds its own section.

## T2a: navigation, the main toolbar, the zoom controls

Research, not tests: temporary Playwright scripts (`/tmp/bb-win-t2a/`, not committed), Playwright 1.64.1 / its cached
Chromium, on the dev page (`npm run dev-page` → `packages/board-tl/dev-dist/index.html` from `file://`, development build of
tldraw), read through `window.__tlEditor` (camera, records, selection, current tool, state path). Desktop 1280×800 with mouse
and keyboard; phone 390×844 with `hasTouch`/`isMobile` and real CDP touch events (one and two touch points).

What was built:
- **Main toolbar** (`MainToolbar.tsx`, `toolbar.css`): vertical, left, centred; select, sticky, shape, text, connector,
  frame, pen; inline SVG icons, a `title` with the shortcut. The shape button opens a flyout with rectangle, rounded
  rectangle, ellipse, triangle, diamond; the chosen type shows on the button and is remembered (also across a remount of the
  board). Active tool highlighted (`aria-pressed`). Buttons take no focus (`tabIndex -1`, mouse down prevented) and a click
  hands DOM focus back to tldraw's container, so Space-to-pan and the shortcuts keep working.
- **Shortcuts** (`UI_OVERRIDES`, `<Tldraw overrides>`): tldraw's kept ones give V, R, O, T, A, F, D; added N and S for our
  sticky (tldraw's N chose its `note`, now unbound) and P for the pen. tldraw's other tool keys (H hand, E eraser, L line,
  K laser, Shift+D highlight) still work; no button lights for them.
- **Zoom controls** (`Zoom.tsx`): bottom left, − / percent (click: 100%) / + / fit. The steps are now
  `0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4` (limits unchanged): tldraw skips a step it is already past half of, so the old
  `…0.5, 1, 2…` jumped 85% → 200%. In/out/reset are immediate (quick clicks during tldraw's animation all aimed at the same
  step). Shift+1 / Shift+2 / Shift+0 are tldraw's.
- **Locked elements** (`navigation.ts`, select tool overrides): a down on a locked element (also on the body of a selection
  with a locked element under the pointer) goes to `pointing_canvas`; a drag pans, a click selects it, Shift+click adds or
  removes it; a double-click on it makes no sticky. tldraw itself draws no resize/rotate handles for a locked shape
  (`SelectionForegroundOverlayUtil`, code read) and ignores updates to it.
- **Connector click** (`ConnectorTool` in `navigation.ts`, a subclass of tldraw's arrow tool with its `pointing` state
  replaced): tldraw's arrow tool makes nothing on a click and stays in the tool; ours places a straight connector of 200
  to the right of the click, selects it and returns to select (goal 3.3: "a click places an element at its default size").

| Item | Result | Measured |
|---|---|---|
| 1 drag on empty canvas pans, keeps selection | pass | camera Δ -176.8,-117.9 (z 0.85), sel shape:r1 |
| 1 click on empty canvas clears selection | pass | sel [] |
| 2 drag on element moves it | pass | r1 Δ 70.7,47.1, camera unchanged true |
| 3 Shift-drag brushes | pass | sel [shape:r1,shape:e1,shape:a1] |
| 4 wheel pans | pass | camera Δ -35.4,-141.4, z same |
| 4 Ctrl+wheel zooms around the pointer | pass | z 0.848→0.933, drift 0.000 |
| 5 Space-drag pans over an element | pass | camera Δ 277.4,193.8, r1 unmoved true |
| 5 middle-drag pans over an element | pass | camera Δ -196.2,-98.8, e1 x 400 |
| 6 zoom limits 10%–400% | pass | wheel 0.1…4, buttons 0.1…4 |
| 7 double-click on empty canvas: sticky ready to type | pass | 9→10 shapes, {"type":"aiwb-sticky","path":"select.editing_shape"}, text in: true |
| 8 hollow shape drags from inside | pass | h1 Δ 58.9,35.4, camera unchanged true |
| L click on a locked element selects it | pass | sel [shape:r1], state select.idle |
| L drag on a selected locked element pans, does not move it | pass | r1 unmoved true, camera Δ 94.3,70.7, sel [shape:r1] |
| L drag on an unselected locked element pans | pass | r1 unmoved true, camera Δ -82.5, sel [] |
| L Shift+click adds a locked element | pass | sel [shape:e1,shape:r1] |
| L double-click on a locked element makes no sticky | pass | 9→9 shapes |
| T aiwb-sticky by click | pass | tool sticky lit true; made aiwb-sticky 200×200; tool after: select |
| T aiwb-sticky by drag | pass | tool sticky lit true; made aiwb-sticky 240×240; tool after: select |
| T rectangle by click | pass | tool geo lit true; made geo/rectangle 200×200; tool after: select |
| T rectangle by drag | pass | tool geo lit true; made geo/rectangle 240×160; tool after: select |
| T rounded-rectangle by click | pass | tool geo lit true; made geo/rounded-rectangle 200×200; tool after: select |
| T rounded-rectangle by drag | pass | tool geo lit true; made geo/rounded-rectangle 240×160; tool after: select |
| T ellipse by click | pass | tool geo lit true; made geo/ellipse 200×200; tool after: select |
| T ellipse by drag | pass | tool geo lit true; made geo/ellipse 240×160; tool after: select |
| T triangle by click | pass | tool geo lit true; made geo/triangle 200×200; tool after: select |
| T triangle by drag | pass | tool geo lit true; made geo/triangle 240×160; tool after: select |
| T diamond by click | pass | tool geo lit true; made geo/diamond 200×200; tool after: select |
| T diamond by drag | pass | tool geo lit true; made geo/diamond 240×160; tool after: select |
| T text by click | pass | tool text lit true; made text 25×32; tool after: select |
| T text by drag | pass | tool text lit true; made text 240×32; tool after: select |
| T arrow by click | pass | tool arrow lit true; made arrow 200×0; tool after: select |
| T arrow by drag | pass | tool arrow lit true; made arrow 240×160; tool after: select |
| T frame by click | pass | tool frame lit true; made frame 320×180; tool after: select |
| T frame by drag | pass | tool frame lit true; made frame 240×160; tool after: select |
| T draw by click | pass | tool draw lit true; made draw 9×9; tool after: draw |
| T draw by drag | pass | tool draw lit true; made draw 240×160; tool after: draw |
| T chosen shape type shows on the button and is remembered | pass | button shows triangle; next click made [triangle,triangle] |
| K tool shortcuts V N S R O T A F D P | pass | v→select n→sticky s→sticky r→geo:rectangle o→geo:ellipse t→text a→arrow f→frame d→draw p→draw |
| F toolbar clicks keep keyboard focus on the board | pass | activeElement .tl-container tl-theme__light tl-container__focused tl-container__no-focus-ring; Space-drag camera Δx 177.3; T after → text |
| Z in / out / percent / reset | pass | z 0.85 (85%) → in 1 (100%) → out×2 0.5 → reset 1 (100%) |
| Z fit button fits the board | pass | page bounds inside viewport: true |
| Z Shift+1 fits the board | pass | inside: true |
| Z Shift+2 fits the selection | pass | {"inside":true,"off":0,"z":1} |
| W the licence watermark is not covered | pass | {"cls":"tl-watermark_SEE-LICENSE","r":[1176,760,100,36],"overlap":false,"visible":true} |
| W touch-action none on all our overlay UI | pass | 19 elements: none |
| W no tldraw UI visible | pass | 0 visible .tlui- elements |
| P one finger on empty canvas pans (selection kept) | pass | screen Δ -60.0,-80.0 |
| P one finger on an element moves it | pass | e1 Δ 30.0,20.0 screen px, camera unchanged true |
| P two-finger pinch zooms around the midpoint | pass | z 0.369→0.924 (×2.50), drift 0.00 page px |
| P a pinch starting on the toolbar does not zoom the page | pass | visualViewport.scale 1 |
| P tap a tool, tap the canvas: element placed, back to select | pass | tool-sticky: tool sticky → aiwb-sticky, after select; tool-geo: tool geo → geo, after select; tool-frame: tool frame → frame, after select |
| P toolbar and zoom fit the phone, no overlap (each other, watermark) | pass | inside true,true, overlap {"tbZoom":false,"wm":false} |

Per tool, a click makes: sticky 200×200, each geo type 200×200, frame 320×180, text an empty text in editing (back to select
after Escape), connector 200 long (ours), pen a dot (stays in the pen); a drag sizes each (geo, frame, connector to the drag,
sticky square to the larger side, text a fixed width).

Notes:
- Two test artefacts were found and fixed in the script, not the code: a drag within 450 ms of a click on the same point is
  a double click to tldraw (the locked-drag check waits 600 ms); on the phone the open shape flyout sits on the canvas to the
  right of the toolbar, so a tap there chooses a type (Miro does the same).
- `board.css` still has the spike's `.aiwb-maintoolbar` / `.aiwb-zoom` rules; nothing uses those classes now (ours are
  `.aiwb-tools`, `.aiwb-zoombar` in `toolbar.css`). Left in place because `board.css` is shared with the context bar's
  child; whoever touches it next can drop them. The test ids `aiwb-maintoolbar`, `aiwb-zoom`, `zoom-*` are kept; the tool
  buttons are `tool-<tool id>` (`tool-select`, `tool-sticky`, `tool-geo`, …) and `shape-<geo>` in the flyout.
- For the other children: the select tool's `idle` now also overrides `onPointerDown` (locked elements); T2c's
  interactions should go through `installInteractions`, not another `idle` subclass, or they must compose with this one.

Shot: `shots/win-toolbar.png` (desktop, the shape flyout open with the rounded rectangle chosen, zoom bottom left, the
watermark bottom right uncovered).
