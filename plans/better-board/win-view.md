# Window lane: the view (findings per task)

Each task of the window lane's view adds its own section.

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

## T2b: the contextual toolbar

Code: `packages/board-tl/src/view/` — `ctxModel.ts` (no React, no tldraw: which controls a selection gets, the popovers they
go in, the shared values, bold on rich text, the placement of the bar and of a popover), `contextActions.ts` (what a control
does to the board; `STYLE_OF` maps a control to its tldraw style prop), `ContextBar.tsx` (the view), `ctxIcons.tsx` (inline
SVG icons), `contextbar.css`. Unit tests: `test/context.test.ts` (10 tests).

### What it shows

One compact row (Miro-like): the popover buttons, a separator, then the "always" group: **⋯ Arrange** (popover: bring to
front, send to back; for 2+ elements align ×6 and distribute ×2, distribute enabled from 3), **Duplicate**, **Lock**,
**Delete**. Each button has a `title` tooltip and a `data-testid`. The popover button shows the current value (the colour as a
dot, a shape's fill dot with its border colour as a ring, the shape type, the line kind; mixed colours as a rainbow dot).

| Selection | Row (popovers in brackets) |
|---|---|
| sticky | [Colour: 16 swatches] [Text: font size Auto/S/M/L/XL (0/16/24/32/48 px), alignment] |
| shape | [Shape: rectangle, rounded rectangle, ellipse, triangle, diamond] [Colour: Fill = none + 12 inks, Border = 12 inks] [Text: font size S–XL (`labelSize`), alignment] [Line: border width S–XL, style solid/dashed/dotted] |
| text | [Colour: 12 inks] [Text: font size S–XL, alignment] **B** (bold toggle) |
| connector | [Colour] [Line: straight/curved/elbow, width, style] [Ends: start and end heads none/arrow/triangle/dot/diamond/bar] |
| frame | name (input in the row; one undo step per edit) [Colour: "Background", 12 inks] |
| pen (not in 3.3) | [Colour] [Line: width] |
| several | the controls every selected type has (mixed values marked by nothing), plus align/distribute in Arrange |
| locked | **Unlock** only |

Inks are our agent names (`palette.ts` `INK`, so `pink` stores `light-red`), drawn with tldraw's light-theme `solid` hex
(fills with its `fill` hex, the same in the light theme). Sticky colours are our 16 with their own hexes.

### Behaviour

- **Position**: centred above the selection's screen bounds (12 px gap), clamped 8 px inside the viewport, flipped below the
  selection when there is no room above; a selection that fills the viewport gets the bar inside it, at the bottom. Coordinates
  are relative to the viewport (`getViewportScreenBounds`), so a board not at the page's top-left works. A selection panned out
  of sight hides the bar. A popover opens under its button, above it if there is no room below, clamped.
- **Hidden** outside the select tool and in `BUSY_STATES` (translating, resizing, rotating, dragging a handle, brushing,
  scribble-brushing, panning the canvas, pointing a handle). **Editing text: the bar stays visible** (so a sticky's colour or a
  text's size can be changed while typing); a press on the bar does not take the focus (`mousedown` default prevented, except
  in the frame name's input), so the text being edited and tldraw's keys keep it.
- **Popovers** close when the selection changes, on a press outside the bar, and on Escape (which then does not reach tldraw,
  so the selection stays). A pick keeps the popover open, for several changes in a row.
- Every change is one undo step: `markHistoryStoppingPoint`, then the editor API. A shape's fill colour is two style props
  (`fill: "fill"` + `aiwb:fill-color`, or `fill: "none"`) under one mark.
- `touch-action: none` on the bar and everything in it.

### Check (Playwright 1.64.1, Chromium, 1280×800, dev page from `file://`; `/tmp/bb-win-t2b/ctx.mjs`, not committed)

**62/62 pass.**

| Check | Result |
|---|---|
| sticky: controls `stickyColor,stickyFontSize,align` + always group | pass |
| sticky: colour red stored (`props.color`), undo restores light-yellow | pass |
| sticky: font size 32, align start; two undos restore 0 / middle | pass |
| popover: Escape closes it and keeps the selection; another selection closes it | pass |
| shape: controls `geo,fillColor,borderColor,lineWidth,dash,labelSize,align` | pass |
| shape: fill pink → `fill: "fill"`, `fillColor: "light-red"`; fill none; border red; each undone | pass |
| shape: type rounded rectangle, border width xl, style dashed, label size xl; all undone | pass |
| text: controls `color,fontSize,textAlign,bold`; colour blue + undo; bold (+ button pressed) + undo; size xl, align middle | pass |
| connector: controls `arrowKind,lineWidth,dash,color,arrowheadStart,arrowheadEnd`; colour red + undo; curved (bend ≥ 20), elbow, undone to straight; heads dot/diamond + undo | pass |
| frame: controls `frameName,color`; background violet + undo; name typed + Enter, undone in one step | pass |
| two shapes: same controls; mixed border colour shows no swatch marked; orange on both + undo; align shown, distribute disabled; align top (both minY 400) + undo | pass |
| sticky + shape: only `align` in common; three stickies: distribute enabled | pass |
| lock → only Unlock (one button) → unlock; duplicate, delete, bring to front, each + undo | pass |
| position: above and centred (12 px gap); follows a wheel pan of (40, 60) exactly | pass |
| position: selection at x 1180–1380 → bar's right edge at 1272 (8 px in) | pass |
| position: selection at y 20–120 → `data-below=1`, bar top 132 | pass |
| position: a popover opened there stays inside the viewport | pass |
| hidden mid-drag (`select.translating`), back after mouse-up | pass |
| no visible `[class*="tlui-"]` element; `touch-action: none` on all of the bar; no page errors | pass |

Shots: `shots/win-ctx-sticky.png` (colour popover open), `shots/win-ctx-shape.png`.

### Notes

- The old `.aiwb-contexttoolbar` rules in `board.css` (owned by another task) are no longer used: the bar's class is now
  `aiwb-ctx` (its `data-testid` is still `aiwb-contexttoolbar`). They can be deleted with the next change to `board.css`.
- The spike's controls that goal 3.3 does not ask for are gone: tldraw's fill pattern (`semi`, `pattern`, `lined-fill`) and the
  hand-drawn `draw` dash. A shape that has one of them keeps it until a fill colour or a dash is picked.
- A shape and a text selected together share no colour (border colour and text colour are different controls on the same
  tldraw style); a sticky and a shape share only alignment.
- A frame's swatches show the ink's solid hex; tldraw draws the frame's background as a very pale tint of it (`frameFill`).
- Selecting a locked element with a click is another task's (the select tool); the bar shows Unlock once it is selected.

## T2c: quick add, Alt-drag duplicate, keyboard (goal 3.3)

**Files.** `packages/board-tl/src/view/interactions.ts` (key handling, the quick-add actions on the editor),
`src/view/QuickAdd.tsx` + `quickadd.css` (the "+" overlay), `src/view/quickadd-logic.ts` (pure helpers),
`test/quickadd.test.ts` (10 unit tests); one line in `Board.tsx` (`<QuickAdd />` beside `<MainToolbar />`). `navigation.ts`
was not touched: nothing needed a select-tool change.

**What was built.**
- **Quick add.** With exactly one sticky or shape (geo) selected and the select tool idle, a pointer within 36 screen px of
  it shows a "+" 18 px outside the middle of each side. The handles are a screen-space overlay, placed from the page bounds
  and the camera, so they follow pan, zoom and moves. They are hidden while dragging, resizing, rotating, brushing, panning
  or editing (any state but `select.idle`), with more than one element selected, for other types, and for a locked or
  read-only board. On a touch screen (`isCoarsePointer`, no hover) they show whenever one element is selected.
  - **Click on a "+":** adds a copy of the same type, size and style with empty text, 60 page units away on that side and
    centred across it. A connector (tldraw `arrow`) joins them, bound at both ends (centre anchor, not precise, so it
    clips to the edges). The copy is selected, so typing fills it. If the place is taken by another element, the copy moves
    across the side by one size plus the gap at a time (+1, −1, +2, …), so copies fan out as in Miro. The copy stays in the
    source's frame if it fits inside it, else it goes on the page.
  - **Drag from a "+":** after 4 px a connector is drawn from the element and its end follows the pointer. The element
    under the pointer is hinted. Dropped on an element, the connector binds to it. **Dropped on empty canvas, a copy of the
    source is created centred on the drop point and bound to the connector (Miro's way).** Escape during the drag
    cancels it.
  - Each of these is one undo step (one history stopping point before the first change). The handles are buttons with
    `touch-action: none`. A press on one takes no focus, so the board keeps the keys.
- **Typing starts editing.** A capture-phase `keydown` on the document comes before tldraw's single-key tool shortcuts. It
  fires on one printable character (one code point) with no Ctrl/⌘/Alt, while exactly one sticky or shape is selected in
  `select.idle` and the focus is not in an input/select/textarea/editable text. It sets the element's text to that
  character and starts editing. tldraw's text editor mounts a few frames later, with the caret at the start, so the
  characters typed until then are buffered and inserted once it is ready, with the caret at the end; fast typing keeps
  its order. It is one undo step. Exceptions: Space (Space+drag pans) and Shift+0/1/2 (tldraw's zoom 100% / fit board /
  fit selection) keep their shortcuts. Other unmodified single-key shortcuts (`r`, `o`, `t`, `[`, `=`, `-`, …) are typing
  while one sticky or shape is selected, and stay shortcuts otherwise.
- **Ctrl+Y** redoes (tldraw binds only ⇧⌘Z / Ctrl+⇧Z).
- Everything else in item 3 is tldraw's own and works unchanged with `hideUi` and our select tool (table below). Undo is
  tldraw's per-store history: nothing here touches it except to add stopping points.

**Check.** `cd packages/board-tl && npm test && npm run check`: 53 tests pass (10 in `quickadd.test.ts`), tsc clean. Root
`npm test`: every workspace passes. Root `npm run check`: fails only on 6 type errors in
`packages/core/test/remotechat.test.ts`, which `bb-win` already has (this branch does not touch `packages/core`).
Browser: `npm run dev-page`, then a temporary Playwright 1.64.1 script (`/tmp/bb-win-t2c/check.mjs`, not committed), Chromium,
1280×800, from `file://`. Each item was checked through `window.__tlEditor` (records, bindings, editing id, tool, undo)
on the seeded mock board. Result: **41 of 41 pass**, no page errors.

| # | Check | Result |
|---|---|---|
| 1a | Shape selected, pointer away: no handles | pass |
| 1b | Hover the selected shape: 4 handles, one per side, outside the edges, centred | pass |
| 1c | Pan the camera by 50: the handles move by 50 × zoom | pass |
| 1d / 1e | Two selected / a text element selected: no handles | pass |
| 1f | Click the left "+" of the rectangle: a geo copy, same w/h/geo/fill/fillColor/color, text "", x = source.x − w − 60, same y | pass |
| 1g | The copy is joined by an arrow bound at start to the source and at end to the copy, and is selected (+2 shapes, +2 bindings) | pass |
| 1i | One undo removes the copy and the connector (counts as before) | pass |
| 1f′ | Right "+" where the place is taken (the ellipse): the copy goes 60 right, moved across until it overlaps nothing | pass |
| 1j | Bottom "+" of a sticky in a frame: a sticky copy, same colour and size, 60 px gap (moved across: the place below was taken) | pass |
| 1k | Typing right after the click fills the new sticky ("Next") | pass |
| 1l | Drag a "+" onto the ellipse: the ellipse is hinted during the drag; the arrow is bound to the source (start) and the ellipse (end) | pass |
| 1n | One undo removes that connector | pass |
| 1o | Drag a "+" onto empty canvas: a geo copy centred on the drop point (within 1 px), bound at both ends | pass |
| 1p | One undo removes the copy and the connector | pass |
| 1q / 1r | Handles hidden while translating the element and while editing it | pass |
| 2a | Alt+drag one shape: a new shape is moved and selected, the original keeps its x | pass |
| 2b | One undo removes the clone | pass |
| 2c | Alt+drag a two-element selection: two clones, both selected, the originals not | pass |
| 2d | One undo removes both | pass |
| 3a | → moves x by 1, Shift+↓ moves y by 10 (at 100%) | pass |
| 3b | ⌘C ⌘V pastes a copy, selected (clipboard permissions granted to the context) | pass |
| 3c | ⌘X removes the shape (and its binding), ⌘V brings it back | pass |
| 3d | ⌘D duplicates | pass |
| 3e | Delete and Backspace delete; ⌘Z undoes; ⇧⌘Z redoes | pass |
| 3f | Ctrl+Y redoes | pass |
| 3g | ⌘A selects every top-level element (6 of 6) | pass |
| 3h | Enter edits the selected shape; Escape ends editing | pass |
| 3i / 3j | Double-click on a sticky / on a shape edits it | pass |
| 3k | A shape selected, type `rx`: editing it, text "rx", the tool stays select (no `r` = rectangle) | pass |
| 3l | One undo gives back the old text ("API") | pass |
| 3m | A sticky selected, type "Hi there" with no delay: text "Hi there" (the buffered keys, the space included, kept in order) | pass |
| 3n | Alt+K, Ctrl+K: no editing, text unchanged | pass |
| 3o | Two stickies selected, `x`: no editing | pass |
| 3p | Shift+1 still fits the board, no editing | pass |
| 3q | Frame selected, typing in the context bar's frame-name field: no editing, no tool shortcut | pass |
| 3r | A sticky selected and the focus in an input of ours: the input gets the keys, the sticky is unchanged | pass |

Screenshot: `shots/win-quickadd.png` (the four "+" around a selected rectangle, under its context bar).

**Left or uncertain.**
- The top "+" sits where the context bar's bottom edge is (the bar is 12 px above the selection, the "+" 18 px). The
  handles are above the bar (z-index 1001) so they stay clickable, and they cover a few pixels of the bar's bottom padding.
  A larger gap under the bar (`ContextBar.tsx`, not this child's) would separate them.
- Characters that arrive without a `keydown` (Playwright's `insertText` for keys not on the layout, such as "ü") during the
  few frames before the text editor mounts land before the first character. A real keyboard sends a `keydown` (or an IME
  composition, which is not used to start editing). Not seen with a keyboard, only with that Playwright path.
- Quick add uses the element's axis-aligned page bounds; a rotated element's copy is not rotated.
- Paste was shown in headless Chromium with clipboard permissions granted; the system clipboard in Electron was not tried.

## A1: the app side of new boards

Branch `bb-win-a1`. Design section 6, D12.

### What was built

- **The board screen branches on the kind.** `BoardCanvas` is now a wrapper. It reads `boards[board].kind` and renders
  `TlCanvas` for `"tl"`, else `ClassicCanvas` (the old component, renamed, with no other change).
- **`TlCanvas`** (`app/src/screens/board/TlCanvas.tsx`):
  - It opens `openTlLink(board)` while the board is on screen and is known and not gone, and calls `link.close()` on unmount.
  - It passes the D12 user and registers the view's handle with `tlRegistry().setHandle(board, h)`. It clears the handle on
    unmount, and also when the view never mounted.
  - It renders `slots.BoardVoice` (not on an archived board).
  - It has no RoleBar, SaveBanner, DroppedNote or BottomRow, and makes no `boardApp.show`/`attachView` call.
  - A gone board shows `BoardOff view="gone"`.
  - Its root is `board-canvas` with `data-kind="tl"` and `data-state` `ready`/`loading`/`empty`/`off`.
- **The mounts:**
  - `app/src/platform/tlboard.web.tsx` calls `window.aiwbTlView.mount(element, { board, link, user, testID: "tl-board-view",
    onHandle })` in a View's DOM node and `unmount()` on cleanup. If `tl.js` did not load, it says "Couldn't open this board:
    the board view did not load".
  - `tlboard.native.tsx` shows "New boards are not available on this device yet."
  - The types are structural (`tlboard.types.ts`: core's `TlLink` and `TlViewHandle`, and `TlUser`). The app does not import
    tldraw or board-tl.
- **Focus.** The view focuses its container when it mounts, which is when the person opens the board. If a text field outside
  the board had the focus at mount, the host gives the focus back to that field when the view takes it in the next 3 s,
  unless the person pressed or typed in the board first. A field that no longer exists is left alone. For example,
  `show_board` selects `{board, chat: null}`, which unmounts the composer, so the board keeps the focus.
- **D12** (`app/src/screens/board/tluser.ts`): `{ id: "user:<12 chars>", name: "<Adjective> <Animal>", color }`, with the
  colour from tldraw 5.6.0's `USER_COLORS`. It is kept in `aiwb.tl.user` through the store's `safeGet`/`safeSet`, as the
  storage scan requires. Unit-tested in `app/test/tluser.test.ts`.
- **Creating a board.**
  - `nav.newBoard(group, kind?)` and `addBoard(group, kind?)` take a kind. For `"tl"`, `api.newBoard(..., "tl")` is called
    and `boardApp.takeBoard` is not.
  - The New sheet has a second row with the tile "New board", "Miro-like board, many people at once"
    (`H2_TID.newTlBoard = "new-tl-board"`). It makes the board, opens it and puts the row in rename mode, like "Whiteboard".
  - The sidebar's "New whiteboard" and the "Whiteboard" tile stay classic.
- **The "New" mark.**
  - Sidebar `BoardNode`: `NewKindTag` (`tl-tag`).
  - Home: `placeLists` adds `tl: true` to the row, and `HomeRow` draws a `tl-tag` beside the name. The screen reader label
    gains ", new board".
- **Guards:**
  - `nav.select()` skips `boardApp.flush(prev)` for a tl board.
  - The sidebar's rename skips `boardApp.flush` for a tl board.
  - Core `side.ts` `sectionBack` does not `reloadScene` a tl board on screen. `afterSnapshot` and `follow` work on `wanted`,
    which only `show()` sets, and `show()` is never called for a tl board.
  - Archive, delete and reveal still call `flush`. That is a no-op for a board with no saving state, so they were left alone.
- **The page.**
  - `public/index.html` loads `./tl/tl.css` and `<script src="./tl/tl.js" defer>` after `board.js`.
  - `export-web.mjs` step 0 also runs board-tl's `build:web` and fails if `public/tl/tl.js` is missing. `transformIndex`
    requires the two tl tags. The export checks that `tl/tl.js` and `tl/tl.css` are present.
  - New test in `app/test/export-web.test.ts`.
- **Existing tests updated:**
  - `wiring.test.ts`: `newBoard` takes only a classic board.
  - `storagescan.test.ts`: `tluser.ts` is one more place that writes a key, and the board layer's exemption.

### Checks

- `npm test` at the root passes in every workspace (app 1530 tests, 0 failures).
- `npm run check`: app (web and native), conn, board-*, headless and board-tl pass. **`@aiwb/core` fails on
  `test/remotechat.test.ts` (lines 325–340, `string | undefined`).** It fails the same way on `bb-win` without this branch,
  so it is not from A1.
- Looked at on the mock, with temporary scripts in `/tmp/bb-win-a1/` and Playwright 1.64.1:
  - Setup: board-tl `npm run build:web`, then `buildAppDist`, then `startMock`.
  - A tl board "Team map" was added to `g_shop` through `mockEval`, and the mock's `POST /api/boards` was temporarily made to
    keep `kind`. Both are reverted.
  - **Desktop 1280×800:**
    - The "New" mark is on the tl row and not on the old board.
    - `window.aiwbTlView.mount` is defined.
    - Opening the old board `arch` shows `.excalidraw`.
    - Opening the tl board gives `board-canvas[data-kind=tl][data-state=ready]`, one `.tl-container`, no `.excalidraw` and no
      RoleBar. Our toolbars show: Select, Sticky, Rect, Rounded, Ellipse, Text, Connector, Frame, Pen, the zoom bar and
      tldraw's dev watermark. The voice pill sits above them.
    - The focus is in the board. No page errors and no CSP violations.
  - **Phone 393×852:**
    - The group screen shows the "New" mark on the tl row; its label is "Team map, new board, Whiteboard · no chats yet".
    - The New sheet shows the tile. Pressing it sends `POST /api/boards {"group":"g_shop","new":false,"kind":"tl"}` with
      **no take call**. The mock stored `kind: "tl"`, and the new board opened in `TlCanvas`.
  - **Focus:**
    - With a text field outside the board focused, an agent's `show_board` (mock `rpc`) mounted the board, and further typing
      still went into the field (`"abc" + "world"`).
    - Typing in the composer of a plain chat: `show_board` unmounts the composer, so the board took the focus.
- Screenshots: `shots/win-app-board.png` (desktop, tl board open, sidebar mark) and `shots/win-app-list.png` (phone group
  screen with the mark).

### What the tl board screen shows when the session cannot open

The current `tl.js` ignores `board`, `link`, `user` and `onHandle`, so the screen shows tldraw's local empty board with our
toolbars, fully usable. Meanwhile the link retries `POST /api/tl/<id>/open` with its backoff (the mock answers 400 each
time). The browser console logs only "Failed to load resource: 400"; there are no page errors and nothing else on screen.
Showing the link's status (the "Reconnecting…" pill) is T3's job in the view. `TlCanvas` itself only says `loading` until
the link object exists, which is at once.

### Left or uncertain

- `onHandle` is never called by the current `tl.js`, so the handle registration was checked only by type. It works once T3
  calls it.
- The phone's tablet and wide layouts also mount the web view. Only `tlboard.native.tsx` shows the "not available" text.
  Native was type-checked but not run (no simulators for this goal).
- The New sheet's third tile sits in a second row at half width, because three tiles in one row would squeeze the words on
  the phone. Look at `shots/` if a different layout is wanted.

## T3: sync in the view, the mount, the agent marker, the connection line, the handle

Branch `bb-win-t3`. Files: `packages/board-tl/src/view/{socket.ts, sync.ts, AgentMarker.tsx, Status.tsx, handle.ts, sync.css}`,
`src/web/{entry.tsx, types.ts}`, a few lines in `src/view/Board.tsx` (props `user`, `markers`; `<AgentMarker/>` as a child of
`<Tldraw>`). Tests `test/{socket,sync,handle}.test.ts` with `test/fakelink.ts`.

**What it does.** `TransportSocket` is tldraw's `TLPersistentClientSocket` over core's `TlLink` (design 2.5). `TlSync` makes the
`TLStoreWithStatus`: the shared schema, the person as the store's current user and tldraw user preferences (D12), a
`TLSyncClient` always in `presenceMode: 'full'` (O2), the agents' markers from custom messages (D11), the rejection handling of
design 2.5 "as built". The mount (`window.aiwbTlView`, design 6 "as built") renders `div.aiwb-tl-root[data-testid]` (focused at
mount) with the board and the connection line (outside `<Tldraw>`, so "Connecting…" shows during the first load too, top centre:
never over the watermark or the toolbars). A rejected-for-good board renders only the red line.

**Unit tests** (`cd packages/board-tl && npm test`: 80 pass after merging bb-win, of which T3's 17; the browser check below was re-run after the merge, same results): the socket's status mapping, JSON both ways,
restart, close leaving the link open; two `TlSync`s on fake links into one in-process `TLSocketRoom` (`tlSchema`): a sticky put
by A arrives at B, B has A's presence with A's name and colour; a link cut and reopened converges; a custom message becomes a
marker (same chat replaces, another adds); a lone window gets `room.updateStore` changes in well under the 900 ms of tldraw's
solo frame; a rejection gives a fresh store and shows the reason, a connect clears it, two in a row without a connect are fatal
and nothing is retried after; the handle's refs (`{id}` with or without `shape:`, `{key}`), its `getView` and `zoomTo` on a fake
editor; the marker's timers; the status line's words.

**Edits made while the link is offline** (test "a link cut and opened again converges…", and the browser check): they stay in
the window's store (tldraw's speculative changes) and are pushed on the next connect, rebased on what the room has then. A
create, a move and a delete made offline all reached the other window; the other window's edits made meanwhile reached this
one. The same property changed on both sides ends with the offline window's value, because its push reaches the room last
(last write wins, as spike-host 4 c2). Not covered here: a board host that restarted from an older save (spike-host 4 a/b; the
host loads through `snapshotForRestore`). After a rejection the unacknowledged edits are dropped (a fresh store).

**In the browser** (temporary, `/tmp/bb-win-t3/`: a page with the built `tl.js` mounted twice side by side, each on a fake link
into one `TLSocketRoom` running in the page, bundled with esbuild; Playwright 1.64.1, Chromium 1248):

| Check | Result |
|---|---|
| "Connecting…" before the first load, nothing after | yes / 0 lines shown |
| focus at mount | tldraw's container has the focus |
| a sticky and a box made in A show in B | 81 ms |
| A's cursor in B with its generated name | B's collaborators `["Teal Otter"]`, the label drawn at the cursor (`shots/win-sync-two.png`) |
| `aiwb_agent` custom message | dashed outline + pill "Claude" around the bounds (`shots/win-agent-marker.png`); panned the camera by (100, 50): the marker moved by (100, 50) px; gone after 4 s + the fade |
| handle | `getView()` `{bounds: {x:0,y:0,w:697,h:640}, zoom: 1, selected: []}`; `zoomTo([{key:"idea"}])` true (camera fitted), `zoomTo([{key:"nope"}])` false |
| A's link cut | "Reconnecting…" pill at 12 px from the top, centred; a move and a create made in A while cut did not cross |
| A's link opened again | the offline edits arrived in B, the pill went, the same editor (no remount) |
| console | no error or warning |

**Left or uncertain.**
- The real `TlLink` and board host were not in the loop (fake links into an in-page room); the app child wires `openTlLink`.
- The user record tldraw 5.6 writes for attribution (`user:<id>`, name and colour) is a document record: it syncs and is saved
  with the board.
- At a pane 697 px wide the main toolbar's left end touches the zoom controls (bottom left), seen in the shots; T2a's area.
- A rejection that repeats on every fresh client (e.g. `CLIENT_TOO_OLD`) stops after 3; the link keeps reopening sessions that
  carry nothing until the app closes it.

## Lane lead: after the merges

- All parts together on the dev page (1280×800 and 700×600, Playwright research in `/tmp/bb-win/`): no page error, no
  visible `.tlui-` element, toolbar left, zoom bottom left, watermark uncovered. The top quick-add "+" overlapped the
  contextual toolbar; the bar now sits 36 px above the selection (`ctxModel.ts` `GAP`). `shots/win-combined.png`.
- The temporary mock seed (`dev/seed.ts`) and the mount's `seed` option are deleted: `tl.js` carries no mock data; the
  dev page is an empty local board driven through `window.__tlEditor`.
- **Finding (goal 3.4, risk 8.5): an element deleted while cut off can come back.** `test/sync.test.ts` "a link cut and
  opened again converges" failed in about 1 run in 12 under load (twice in the root `npm test`). In those runs everything
  converged except A's offline delete: the deleted sticky was back in A, B and the room. Cause, in tldraw 5.6's
  `TLSyncClient`: the room's answers to a window's pushes are buffered and applied on the next frame (`rebase`, throttled by
  `requestAnimationFrame`), and a lost connection (`resetConnection`) empties that buffer. A create made just before the cut
  (within about a round trip plus a frame) therefore still counts as the window's own unconfirmed change; a delete of it
  made while cut off cancels the create inside those changes (tldraw squashes the two into nothing), and on reconnect the
  room's copy is applied: the element returns. Edits of such an element are kept (an update squashes into the create);
  only the delete is lost. Rare in use (create, lose the connection within a few tens of ms, delete while offline), not
  ours to fix without patching tldraw; a release could re-send deletes of records the room still has after reconnect, or
  accept it. The test now waits until A has applied the room's answers before the cut (then 0 failures in 96 runs under
  load), and the convergence wait checks the end state and prints the three stores when it times out.
- Not looked at here: the real relay and board host in the loop (the Go lane and the host lane run in parallel; Wave 4
  checks it), and Electron.
