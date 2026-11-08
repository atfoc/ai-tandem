# Window lane: the view (findings per task)

Each task of the window lane's view adds its own section.

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
