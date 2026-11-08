# The window's view of the new board: what each part of the window lane built and how it was checked

Each child of the window lane adds its own section.

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
