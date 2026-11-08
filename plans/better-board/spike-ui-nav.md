# Spike tl-ui: navigation, confirmed in a browser (goal 3.1, 6.1)

Research, not tests: temporary Playwright scripts (not committed) in `/tmp/bb-spike-ui-nav/` drove
`spikes/tl-ui/dist/index.html` from file:// in Chromium 1248 (Playwright 1.64.1). **Every run used the development build
(`node build.mjs --dev`)**: the production build without a tldraw licence key replaces the editor with the licence gate
5 s after load, so anything measured on it after 5 s is wrong. The previous agent's two shots were re-taken on the dev
build.

- Desktop: 1280×800, mouse and keyboard through Playwright (`page.mouse`, `page.keyboard`), trackpad pinch through CDP
  `Input.synthesizePinchGesture` (`gestureSourceType: "mouse"`, which Chromium delivers as Ctrl+wheel).
- Touch: `hasTouch: true, isMobile: true`, phone 390×844 and tablet 820×1180, real touches through CDP
  `Input.dispatchTouchEvent` (two touch points for pinch and two-finger pan). Board fitted (`zoomToFit`) first.
- Measured: `editor.getCamera()` before/after, shape x/y (all seeded shapes), `editor.getSelectedShapeIds()`,
  `editor.getPath()`, `editor.screenToPage(pointer)` before/after a zoom, shape count.

## Results

| # | Behaviour | tldraw option / our override | How checked | Result | Notes |
|---|---|---|---|---|---|
| 1 | Left drag on empty canvas pans, keeps the selection; a click on empty canvas clears it | override: `PointingCanvas` (select cleared on up) + `PanningCanvas` (`src/nav/select.ts`) | r1 selected, drag 150,100 px on empty canvas; click | **pass** | camera moved exactly −150,−100 (z 1), no shape moved, selection `[r1]` kept, state `select.idle`; click → selection `[]`, camera unchanged. A drag on a frame's empty area pans too (camera +50,+50, no shape moved). No slide after release (exact). |
| 2 | Drag on an element moves it; drag on one of a 2-element selection moves both | tldraw's own (`pointing_shape` → `translating`) | drag r1 by 60,40; select r1+e1, drag e1 by −30,50 | **pass** | r1 0,400 → 60,440, camera unchanged; both moved by −30,50, camera unchanged. |
| 3 | Shift-drag on empty canvas brushes and selects what it covers | override: `PointingCanvas` hands Shift/Ctrl/⌘ drags to tldraw's `brushing` | Shift held, drag 700×200 px over r1, arrow, e1 | **pass** | mid-drag `select.brushing`, brush 700×200; selection `[r1, e1, a1]` (not the stickies), camera unchanged. Shot: `shots/spike-ui-nav-brush.png`. tldraw edge-scrolls while brushing near the viewport edge (its default). |
| 4 | Wheel pans; Ctrl+wheel zooms around the pointer; trackpad pinch = Ctrl+wheel | `cameraOptions.wheelBehavior: 'pan'` | wheel (30,120); 3× Ctrl+wheel ±100 and −8 at (400,300); CDP pinch ×1.5 at (900,500) | **pass** | wheel: camera −30,−120, z unchanged. Ctrl+wheel: z 1 → 1.331 → 0.970 → 1.222; page point under the pointer unchanged (error 0.000 px). Pinch: z 1.22 → 1.82, error 0.000 px. |
| 5 | Space+drag pans also over an element; middle-button drag pans over an element | `options.spacebarPanning: true`; middle button is tldraw's own | Space held, drag from r1's centre by 120,80; middle drag from e1's centre by −100,−50 | **pass, with two notes** | Space: camera +143,+95, no shape moved, but **only once the board has keyboard focus** (see "Keyboard focus"). Middle: camera −131,−66, no shape moved. Both pan *more* than the drag: tldraw slides the camera on release after Space/middle pans (`cameraSlideFriction` 0.09); our left-drag pan does not slide. |
| 6 | Zoom stays within 10%–400% | `cameraOptions.zoomSteps: [0.1, 0.25, 0.5, 1, 2, 4]` | 60× Ctrl+wheel −200, 80× +200; 20× `zoomIn()`, 20× `zoomOut()`; pinch loops on touch | **pass** | max 4, min 0.1 by wheel, by API and by pinch (phone and tablet). `zoomIn()` from 100% steps 2, 4 (the steps; the wheel and pinch are continuous). |
| 7 | Shift+1 fits the board, Shift+2 fits the selection | tldraw's shortcuts (kept with `hideUi`) | camera at 5000,5000 z 3, click, Shift+1; select e1, Shift+2; Shift+0 | **pass** (after a click, see focus) | Shift+1: page bounds inside viewport, centred; Shift+2: e1 inside, centred (offset 0,0), z 4 (the max); Shift+0 → z 1. |
| 8 | Double-click on empty canvas creates a sticky in editing; typing goes in; Escape ends editing | override: `Idle.onDoubleClick`; `options.createTextOnCanvasDoubleClick: false` | dblclick at an empty point, type "Hello board", Escape | **pass** (after the fix below) | 8 → 9 shapes, new shape type `sticky`, `select.editing_shape`, focus in the ProseMirror editor; text "Hello board"; Escape → `select.idle`, sticky selected. Dblclick on a sticky edits it, inside a hollow geo edits its label (no new sticky). Touch double-tap on empty canvas also creates a sticky in editing. |
| 9 | Touch: one finger pans on empty / moves an element; pinch zooms; two-finger move pans; tap clears selection; long press | tldraw's own for pinch/two-finger; our select tool for one finger | per viewport: one-finger swipe on empty (−60,−80); tap; swipe on r1 (30,20); pinch 80→200 px at the centre; two-finger move (70,90); long press 1.2 s on empty and on e1 | **pass** on phone and tablet (after the fix below) | pan exactly the finger's travel, selection kept; tap → `[]`; r1 moved 30,20 screen px, camera unchanged; pinch ×2.50, page point under the midpoint unchanged; two-finger move pans 60.7,78.0 px (use-gesture's threshold eats the first ~10 px), zoom unchanged, no shape moved. Long press on empty: nothing (stays `pointing_canvas`, no menu, no shape). Long press on an element: tldraw selects it and enters `translating` (its long-press-to-drag), nothing moves on release. After a pinch tldraw emits a `long_press` event with no effect. **Bug found and fixed**: a pinch-out starting with fingers < 40 px apart created a sticky. Shot: `shots/spike-ui-nav-phone-pinch.png`. |
| 10 | Hollow geo (`fill: 'none'`): drag inside moves it; drag on a frame's empty area pans | override: `PointingCanvas.onEnter` → `pointing_shape` when a hollow shape is under the pointer (previous agent's change) | drag inside a 250×180 hollow rect by 50,30; click inside; drag on a frame's empty corner; same on touch | **pass** | moved exactly 50,30, camera unchanged, selected; click inside selects it; frame empty area pans (camera −40,+40, no shape moved), desktop, phone and tablet. Shift-drag from inside a hollow shape brushes (does not move it). |

Shots (dev build): `shots/spike-ui-nav-pan.png` (after a pan, r1 still selected), `shots/spike-ui-nav-brush.png`
(mid-brush), `shots/spike-ui-nav-phone-pinch.png` (phone after the pinch).

## What was hard, and the fix

**Pinch-out made stickies (fixed).** tldraw's `ClickManager` counts a pointer down within 40 px and 450 ms of the
previous one as a double click, and sends `double_click` (phase `down`) at that second down. Two fingers landing close
together at the start of a pinch-out are exactly that, so our `Idle.onDoubleClick`, which acted on phase `down`,
created a sticky (8 stray stickies on the tablet in one run of repeated pinches). A pinch never delivers the second
pointer's up, so the fix is to create the sticky on phase `up` (and not while `inputs.getIsPinching()`); a real
double click / double tap ends with that up, which reaches `Idle` after `pointing_canvas` goes back to idle. Checked:
6 pinch-outs from 20 px apart → 0 new shapes (8 before); desktop double-click and touch double-tap still create a sticky
in editing with the text going in. (`src/nav/select.ts`, `Idle`.)

**Keyboard focus (not fixed, outside `src/nav/`).** tldraw listens for keys on its container element, and on a fresh
page the document's focus is on `body`, so Space+drag, Shift+1/2 and every other shortcut do nothing until the user
has clicked or tapped the board (then focus is `.tl-container` and all work). `editor.getInstanceState().isFocused` is
already true, which hides it. In the app the user usually clicks the board first; if shortcuts must work straight
away, the mount should call `container.focus()` (or the editor's `focus()`), which belongs to the mount code, not here.

**A pinch over our own UI zooms the page (not fixed, outside `src/nav/`; found after merging `bb-spike-ui`).** The
context toolbar (`[data-testid=aiwb-contexttoolbar]`, `src/ui/`) has `touch-action: auto`, and the page's viewport
meta is `width=device-width, initial-scale=1`. A two-finger pinch that starts over the toolbar is the browser's own
page zoom: `visualViewport.scale` 1 → 3.13, board zoom unchanged. From then on every touch reaches tldraw shifted by
the visual viewport offset (a long press on e1 landed ~240 px away), so the board seems to ignore touches. Fix
(either, better both): `touch-action: none` on our overlay UI, and `maximum-scale=1, user-scalable=no` in the page's
viewport meta (`build.mjs`; the app's own page needs the same). The touch rows above were re-checked on the merged
build with nothing selected during the pinches (all pass).

**Camera slide after Space/middle pans.** tldraw slides the camera after those pans (friction 0.09); our left-drag pan
stops dead. Not wrong, but inconsistent; if we want one feel, `options.cameraSlideFriction` (or the same slide in
`PanningCanvas`) is the knob. Not changed.

**Licence gate.** The production build without a key goes blank after 5 s; all research must use `--dev`.

## Uncertain

- Touch was emulated (CDP touch events in desktop Chromium), not a real iPad/phone and not WebKit; Safari's
  `gesture*` events and iOS's own double-tap-zoom / long-press callout were not exercised.
- The trackpad pinch was CDP's synthetic one; a real Mac trackpad's wheel deltas differ in size, not in kind.
- The phone shot shows the toolbar wider than the screen (that is `src/ui/`, another child's area).
