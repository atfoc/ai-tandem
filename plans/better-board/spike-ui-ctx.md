# Spike UI, contextual toolbar (bb-spike-ui-ctx)

Child of `bb-spike-ui`. Question: can our own contextual toolbar, on tldraw 5.6.0 with every tldraw UI component null,
show what goal 3.3 lists for each kind of selection, with each change applied at once and undone in one step?
**Answer: yes**, with the gaps below (none blocks the design).

Code: `spikes/tl-ui/src/ui/ContextToolbar.tsx` (what is shown), `src/ui/ctxActions.ts` (what a control does),
`src/model/shapes.ts` (geo with a rounded rectangle, frame with its colour shown). Shots:
`shots/spike-ui-ctx-sticky.png`, `-shape.png`, `-multi.png`.

## How it works

- The toolbar reads everything in one `useValue` (`read()`): tool and state (hidden outside `select` and in
  `BUSY_STATES`), selection, `getSelectionRotatedScreenBounds()` (above the selection, below it when there is no room
  at the top), `getSharedStyles()` for style props, and the shapes' own props for the rest.
- `SECTIONS` lists the controls per shape type. For several shapes the toolbar shows the controls every selected type
  has (the value when shared, "mixed" otherwise) plus align and distribute. `data-controls` on the toolbar lists them;
  each control has a `data-testid`.
- Every change: `editor.markHistoryStoppingPoint()` then the editor API. Style props go through
  `setStyleForSelectedShapes` + `setStyleForNextShapes` (what tldraw's own style panel does). Props that are not styles
  go through `updateShapes`.

## Controls → tldraw API

| Selection | Control (testid) | tldraw |
|---|---|---|
| sticky | colour, 16 swatches (`ctx-sticky-color`, `color-<name>`) | our style prop `StickyColorStyle` (`aiwb:sticky-color`) |
| | font size Auto/12/16/24/32/48 (`ctx-sticky-font-size`) | `updateShapes` → sticky `props.fontSize` (0 = auto) |
| | text alignment (`ctx-align`) | `DefaultHorizontalAlignStyle` |
| geo | type (`ctx-geo`) | `GeoShapeGeoStyle`: 5.6 has rectangle, ellipse, triangle, diamond (and cloud, pentagon … heart, 20 in all). **No rounded rectangle**: added as `rounded-rectangle` through `GeoShapeUtil.configure({ customGeoTypes })` (a `PathBuilder` path with arcs); it becomes a value of the style, so selecting and undoing it works |
| | fill (`ctx-fill`) | `DefaultFillStyle` (none, semi, solid, pattern, fill, lined-fill) |
| | colour (`ctx-color`) | `DefaultColorStyle`: one colour for stroke and fill (gap 1) |
| | border width (`ctx-size`) | `DefaultSizeStyle` s/m/l/xl: also the label's font size (gap 2) |
| | border style (`ctx-dash`) | `DefaultDashStyle` (solid, dashed, dotted, draw; tldraw's default is `draw`, the hand-drawn look: board-tl sets `solid` for next shapes as it sets the font) |
| | text alignment (`ctx-align`) | `DefaultHorizontalAlignStyle` |
| text | font size (`ctx-size`) | `DefaultSizeStyle` |
| | colour (`ctx-color`) | `DefaultColorStyle` |
| | alignment (`ctx-textAlign`) | `DefaultTextAlignStyle` |
| | bold (`ctx-bold`) | `updateShapes` → `props.richText`: every text node of the TipTap JSON gets or loses the `bold` mark (the mark StarterKit writes on ⌘B). The button shows "on" when every text node is bold. No TipTap editor is needed |
| arrow | kind straight/curved/elbow (`ctx-arrow-kind`) | 5.6 has `ArrowShapeKindStyle` (`arc` \| `elbow`). Straight and curved are both `arc` (bend 0 vs a bend); the control writes `kind` and `bend` with `updateShapes`, and `setStyleForNextShapes(ArrowShapeKindStyle)` |
| | line style (`ctx-dash`), width (`ctx-size`), colour (`ctx-color`) | `DefaultDashStyle`, `DefaultSizeStyle`, `DefaultColorStyle` |
| | start/end heads (`ctx-arrowheadStart`, `ctx-arrowheadEnd`) | `ArrowShapeArrowheadStartStyle` / `EndStyle` |
| frame | name (`ctx-frame-name`) | `updateShapes` → `props.name`, one history mark on focus, so a whole name edit is one undo step |
| | background colour (`ctx-color`) | 5.6's frame **has** `color` (`DefaultColorStyle`) but draws it only with `FrameShapeUtil.configure({ showColors: true })` (off by default); with it, the theme's `frameFill`/`frameStroke` of that colour |
| several | shared controls as above | `getSharedStyles()` |
| | align (`ctx-align-shapes`) | `editor.alignShapes(ids, 'left' … 'bottom')` |
| | distribute (`ctx-distribute-h`, `-v`; 3+ shapes) | `editor.distributeShapes(ids, 'horizontal' \| 'vertical')` |
| always | front, back, duplicate, lock/unlock, delete (`ctx-front`, `ctx-back`, `ctx-duplicate`, `ctx-lock`, `ctx-delete`) | `bringToFront`, `sendToBack`, `duplicateShapes(ids, {x:20,y:20})`, `toggleLock` (+ re-select, see below), `deleteShapes` |

A locked selection shows only Unlock.

## Gaps vs goal 3.3, and what board-tl does

1. **Separate border colour.** tldraw's geo has one `color` for stroke and fill, plus `labelColor`
   (`DefaultLabelColorStyle`, the text colour), and no border colour. Proposal: board-tl adds its own style prop
   `aiwb:border-color` (an enum of the same colour names, like `StickyColorStyle`) on a geo `ShapeUtil` that extends
   `GeoShapeUtil` (`static props = { ...GeoShapeUtil.props, borderColor }` plus a migration) and draws the outline in
   that colour. `color` then means the fill colour. Because it is a style prop, set-for-selection, shared styles and
   next-shape style work with no other code. The board host has to register the same util. The cheaper choice is to
   keep tldraw's single colour (fill = tinted stroke colour) for the prototype and record it as a deviation.
2. **Font size is tied to stroke width.** `DefaultSizeStyle` sets both the stroke width and the label's font size of
   geo, text and arrow. There is no separate font size. Proposal: for geo, a style prop of our own `aiwb:font-size`
   (s/m/l/xl or a few numbers) that the extended geo util uses for the label instead of `size`, leaving `size` as the
   border width. For text, `size` is the font size (text has no stroke), so this is fine. For arrows it is the label
   size, which nobody minds. The prototype shows `size` for geo as "Size" and notes the coupling.
3. **Rounded rectangle**: not in 5.6, added with `customGeoTypes` (works; the window and the board host both
   configure it).
4. **Frame background** needs `showColors: true`, and the colour names are tldraw's 13. A Miro-like frame palette
   would be a theme colour set (`spike-ui.md`).
5. **Lock.** `toggleLock` deselects what it locks, and tldraw ignores locked shapes when you click them. So once
   deselected, there is no way to select a locked element again and unlock it with a click. The spike re-selects after
   locking (the toolbar then shows Unlock). board-tl also needs a way to select a locked element (Miro: a click selects
   it, nothing moves). For example, our select tool's `pointing` state could select a locked shape under the pointer
   without starting a translate. Or the context menu could offer unlock.
6. **Z-order and arrows.** tldraw keeps a bound arrow above the shapes it connects, so "bring to front" on a shape puts
   it just under its arrows. That matches Miro's connectors. Noted only.
7. **Undo does not restore "next shape" styles.** `setStyleForNextShapes` writes `instance.stylesForNextShape`, which
   undo leaves alone. After a colour change and an undo, the next sticky still takes the undone colour. tldraw's own
   panel does the same; acceptable.
8. **Distribute and clusters.** `distributeShapes` groups shapes that are close (`getShapeClusters`). Three stickies 20
   px apart were left alone when called right after load, and were distributed in the toolbar run. It is tldraw's
   rule; board-tl keeps it.
9. Layout: the toolbar with every control wraps to 2–3 rows (max 560 px). board-tl groups controls into popovers
   (colour, text, line) as Miro does. That is design work, not risk.

## Check results (Playwright research, not committed)

`/tmp/bb-spike-ui-ctx/ctx.mjs`, Chromium 1248 (Playwright 1.64.1), 1280×800, **dev build** (`node build.mjs --dev`, no
licence gate). The run starts 5.5 s after load, so every result is from after tldraw's 5-s gate mark. **41/41 pass**:

- The editor is alive after 5.5 s on the dev build.
- Controls shown (by `data-testid`) for a sticky, a geo, a text, an arrow, a frame, two geo shapes and sticky+geo,
  each with the "always" group. Sticky+geo shows no colour (different style props) but does show text alignment
  (both use `DefaultHorizontalAlignStyle`). Three stickies show the sticky colour and font size.
- Change + `editor.undo()` restores the record for: sticky colour, font size and alignment; geo colour, type
  (→ `rounded-rectangle`), fill, size and dash; text colour, alignment and bold; arrow kind (elbow; curved gives
  bend 40), heads and colour; frame colour; frame name (typed, Enter, one undo step). Also align top, distribute
  horizontal, lock → only Unlock shown → unlock, front/back, duplicate and delete, each undone.
- A sticky colour sets `aiwb:sticky-color` for the next shape and leaves `tldraw:color` alone.
- After editing a sticky's text (Escape, then 250 ms), a colour change is undone alone and the typed text stays.
- The toolbar is absent mid-drag (`select.translating`) and back after mouse-up.
- After a wheel pan of (40, 60) the toolbar moved by exactly (−40, −60).
- No visible `[class*="tlui-"]` element, and no page errors.

The spike's unit tests (`cd spikes/tl-ui && npm test`) pass: 12/12.
