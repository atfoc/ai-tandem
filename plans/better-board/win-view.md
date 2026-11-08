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
