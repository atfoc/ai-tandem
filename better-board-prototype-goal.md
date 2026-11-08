# Goal: a prototype of a Miro-like board that agents edit headless and many people edit together

This document defines an outcome. It says what the prototype shows when it is done, the decisions already made, the
bounds the work stays inside, and how to confirm each part. It is not an implementation plan and not an order of work.
Section 7 carries the implementation details agreed so far, as a reference: follow them where they hold, and flag
where they don't (7.0).

This is a **prototype**. It does not have to be shippable, polished or complete. Its job is to find a way to build
this and to prove that it can be built in this project: with this Go server, this transport, this headless process
and these agents. A part that turns out to be impossible, or much harder than expected, is a valid result if it is
shown and explained (6.9).

## 1. How to read this

**Marks.** Decisions, bounds and risks each carry one mark. A statement with no mark is `[proposed]`.

- `[user]`: the user decided it.
- `[standing]`: decided before this goal and kept. It is in `docs/architecture.md`, `AGENTS.md` or the code.
- `[proposed]`: proposed while the prototype was planned. Not a decision of the user.
- `[not verified]`: a risk or an assumption nobody has checked yet. The prototype checks it.

**Terms.**

- **New board**: a board of the kind this prototype adds, drawn with tldraw. **Old board**: the Excalidraw board that
  exists today.
- **Window**: the app (the desktop window or the web build in a browser) connected to a server.
- **Board host**: the Node process on the server's machine that holds the new boards: their live document, the
  multiplayer room and the editor agents use. It grows out of today's headless writer.
- **Room**: the live, shared document of one new board while it is open somewhere. Windows and the agent are its
  peers.
- **Element**: anything on the board a person sees as one thing: a sticky note, a shape, a text, a connector, a frame
  or a pen stroke.
- **Contextual toolbar**: the small bar that appears next to the selection, with the properties and actions of what
  is selected.

## 2. Goal

Today the board is Excalidraw. Its interface and its way of interacting are mostly fixed. One window at a time may
change a board, and an agent's board call goes as an RPC to whichever window holds the board, or to the headless writer
when none does.

At the end of the prototype:

1. **A board that feels close to Miro.** You navigate by dragging the canvas and by scrolling and pinching. You act on
   elements directly, with a contextual toolbar for the selection. There are sticky notes, shapes with text, text,
   connectors and frames. `[user]`
2. **Agents always edit headless.** An agent's board calls on a new board are always answered by the board host, never
   by a window. They work the same whether or not any window is open, and the board host renders pictures for the agent
   itself. `[user]`
3. **Multiplayer.** Several windows and the agent edit the same board at the same time. Each sees the others' changes
   live, with people's cursors. Nobody has to take or hand over the board. `[user]`
4. **A written answer.** A findings report says what works, what it costs, what is left, and whether to go on and how.

## 3. What exists when it is done

### 3.1 Navigation `[user]`

- A left-button drag on empty canvas pans the board. A drag that starts on an element moves the element (or the whole
  selection, when the element is part of it). `[user]`
- Selecting an area: a drag with Shift held on empty canvas draws a selection box. `[proposed]`
- Scrolling with a mouse wheel or a two-finger trackpad swipe pans. Ctrl/⌘ + wheel and a trackpad pinch zoom around the
  pointer. `[proposed]`
- Space + drag and middle-button drag pan from anywhere, also over elements. `[proposed]`
- On touch (the web build at phone and tablet size with touch input): one finger on empty canvas pans, one finger on an
  element moves it, two fingers pan and pinch-zoom. `[proposed]`
- Zoom controls: zoom in, zoom out, the current zoom in percent, reset to 100%, fit the whole board. Shortcuts:
  `Shift+1` fits the board, `Shift+2` fits the selection. `[proposed]`
- Panning has no hard edge. Zoom stays inside sensible limits (about 10% to 400%).

### 3.2 Elements

- **Sticky note** `[user]`: a square note in one of a fixed set of Miro-like colours (at least 8), with text. The text
  shrinks to fit as you type, so a note keeps its size. You can resize a note, and its text fits again. A new note gets
  the colour last used.
- **Shapes**: at least rectangle, rounded rectangle, ellipse, triangle, diamond. Each has optional text inside it, a
  fill colour, a border colour, a border width and style.
- **Text**: free text with no box. Its font size can be set, and its width is either automatic or fixed with wrapping.
- **Connectors**: straight and curved (elbow lines are optional), with a choice of arrowheads at each end and optional
  text on the line. An end dropped on an element attaches to it, and the connector follows when the element moves. An
  end that attaches to nothing stays where it was put.
- **Frames**: a named area that holds elements. Moving the frame moves what it holds. An element dragged into or out of
  a frame joins or leaves it.
- **Pen**: freehand strokes, with a colour and a width.
- Images are optional in the prototype. If they are left out, the report says so.

### 3.3 Interacting with elements

- Click selects one element. Shift+click adds or removes. A click on empty canvas clears the selection.
- When something is selected, the **contextual toolbar** appears next to it and follows it as you pan, zoom and move.
  It is hidden while you drag. It shows what fits the selection: `[user]`
  - sticky: colour, font size (automatic or fixed), text alignment
  - shape: shape type, fill, border colour, width and style, text alignment, font size
  - text: font size, colour, alignment, bold
  - connector: line style, line width, colour, start and end arrowheads
  - frame: name, background colour
  - more than one element: what they have in common, plus align and distribute
  - always: lock/unlock, bring to front / send to back, duplicate, delete
- A change in the toolbar applies at once and can be undone.
- A double-click on an element with text edits its text. Typing while one sticky or shape is selected starts editing
  it. Escape ends editing.
- A double-click on empty canvas creates a sticky note there, ready to type in. `[proposed]`
- Creating: a main toolbar (left or bottom) has select, sticky, shape (with its types), text, connector, frame and pen.
  With a tool chosen, a click places an element at its default size and a drag sizes it. The tool returns to select
  after one element, except the pen. `[proposed]`
- Quick add `[proposed]`: hovering a selected sticky or shape shows a small "+" on each side. A click adds a copy next
  to it, joined by a connector. Dragging the "+" draws a connector.
- Alt/Option + drag duplicates. Arrow keys nudge, and Shift + arrow nudges further.
- Copy, cut, paste, duplicate, delete, select all, undo, redo, with the usual shortcuts.
- Undo and redo undo only what this window did, never another person's or the agent's changes.
- tldraw's own default UI (its menus, style panel, toolbar and so on) is not shown. Everything the person sees is ours.
  `[user]`

### 3.4 Multiplayer `[user]`

- Two or more windows can open the same new board and all edit it at once. There is no writer, no reader, and no
  **Edit here** button on a new board.
- A change made in one window appears in the others without a reload, typically within a second on a local server.
- Each window shows the other people's cursors and selections, labelled with a name. The name in the prototype may be
  the client's or a generated one.
- The agent appears as a peer too. While it works, its cursor or a marker labelled with the agent's name shows where it
  is changing the board. `[proposed]`
- Changes to different elements made at the same moment are all kept. Changes to the same element made at the same
  moment end with one consistent result in every window, and nothing crashes or goes out of sync.
- A window whose connection drops reconnects by itself and comes back to the current board. The prototype finds out,
  and reports, what happens to edits made while the window was cut off.

### 3.5 Agents, headless

- An agent's board tools on a new board (read, change, delete, picture, list, create) are answered by the board host,
  never by a window, whether windows are open or not. `[user]`
- With no window open, an agent can read a new board, add and change sticky notes, shapes, text, connectors and frames,
  delete elements, ask for a picture of the board or of a part of it, and create a new board. When a window opens the
  board afterwards, everything is there.
- With windows open, the agent's changes appear in them live, while people keep editing.
- **Sizes are right.** When the agent writes text into a sticky, a shape or a text element, the stored size and text
  layout are what a browser would produce: the sticky's font shrinks the same way, and a shape's height grows the same
  way. The board host measures text with the real fonts, never with an estimate. `[standing]` (as for the headless
  writer today)
- **Pictures.** The board host renders the picture the agent asks for as a PNG, without a browser and without a window.
  `[user]` It looks like the board looks in a window (6.5).
- `get_view` and `show_board` still need a person's screen and still go to a window that shows the board.
  `[standing]`
- An agent says what it wants in terms of the elements of 3.2 (a sticky with this text and colour at this place, a
  connector from this element to that one), not in raw tldraw records. What it reads back is in the same terms (7.6).

### 3.6 Saving

- A new board is saved in the server's board storage like an old board, with its name and its place in the tree.
- After an agent's change, the board is saved before the agent is told the change is done. `[standing]`
- People's edits are saved soon after they are made (within a few seconds), and when the last peer leaves the board.
- A restart of the board host or of the server loses at most the last few seconds of people's edits, and no change an
  agent was told is done.

### 3.7 The board host

- It is started and watched by the Go server the way the headless writer is today: the same ways of finding Node and
  the bundle, and the same handshake. `[standing]`
- It runs while any new board is open in a window or an agent is working on one. It stops after a quiet time with
  nothing open.
- If it dies, the server starts it again when it is next needed. Windows reconnect, and the board comes back from the
  last save.

## 4. Decisions and bounds

**4.1 tldraw is the drawing library of the new board.** `[user]` The choice was made for its customizable interface,
its own shapes, its tools as state machines, and its multiplayer (`@tldraw/sync-core`). tldraw is used as installed.
We build on its extension points (shape utils, tools, UI components, side effects) and do not patch or fork it.
`[proposed]`

**4.2 Licence.** `[not verified]` tldraw needs a licence key in production. The prototype runs in development, and that
is acceptable for the prototype. The report states what a release would need: the licence type and what it costs, and
any watermark. Nothing in the prototype may depend on removing a watermark or getting around the licence check.

**4.3 Old boards keep working, unchanged.** `[proposed]` The new board is a second kind of board beside the old one.
Old boards, their writer/reader model, their tools and their tests behave exactly as before. Converting old boards is
out of scope (5).

**4.4 Agents always go to the board host.** `[user]` For a new board, no agent call is routed to a window except
`get_view` and `show_board`. The RPC-to-the-writer path is not used for new boards.

**4.5 Multiplayer, not one writer.** `[user]` On a new board, many peers edit at once, and the multiplayer layer
resolves conflicts. The single-writer rules of old boards (holder, hand-off, `409 stale`) do not apply to new boards.

**4.6 The pinned transport, no direct socket from the page.** `[standing]` A window still reaches a server only through
its transport: Electron's main process on the desktop, the native module on a phone, the test host in tests. The
connection is HTTP/2 with the certificate pinned by its fingerprint. No secret reaches the page, and the page opens no
WebSocket or other connection of its own to a server. Multiplayer traffic travels over that transport (7.4).

**4.7 The Go server does not edit board content.** `[standing]` The Go server stores, routes and relays. It does not
parse or change tldraw records. The board host is the authority over a new board's content.

**4.8 Text is measured with real fonts.** `[standing]` Text sizes in the board host come from the same fonts the
window draws with, measured by a real canvas (skia-canvas, already in the repo). An estimate is not acceptable. The
fonts may be tldraw's own or ones we choose for a Miro-like look. Either way the window and the board host use the
same files.

**4.9 Pictures without a browser.** `[user]` The board host renders pictures in Node. If that turns out not to be
possible with acceptable fidelity, the prototype says why and what it measured, and shows the fallback it tried
(headless Chromium in the board host, or asking a window). The user then decides (6.9).

**4.10 The stored colours do not depend on the theme.** `[standing]` What is stored is the same whatever the window's
theme. How a new board looks in the dark theme is left out (5).

**4.11 Nothing paid.** `[standing]` No test or check calls a paid model. Agents are driven by direct calls to the MCP
endpoint, or by the stand-in agent the repository already uses.

**4.12 Prototype quality.** `[user]` Code may be rough, with hardcoded values where they don't hide a problem.
Platforms other than the desktop window and the web build in a browser are optional. What may not be rough: whatever
the proof rests on. That is the transport for multiplayer, the board host's measuring and rendering, and the
agent-always-headless routing.

## 5. Out of scope

- Converting old boards to new boards, and removing Excalidraw.
- Phone and tablet native builds and device tests. Touch is shown in the browser with touch emulation.
- The dark theme on new boards, comments, voting, timers, templates, mind maps, tables, presentation mode, minimap,
  permissions per person, and history or versions of a board.
- Edits made while offline that survive a long disconnect (3.4 only asks the prototype to find out what happens).
- Remote servers. The prototype runs on this computer's server. The design must not rule out remote servers, and the
  report says what they would need.
- A full set of tests at the level the repository keeps for shipped features (6 says what proves the prototype).
- Docs in `docs/`. The findings report is the document of this work.

## 6. How it is confirmed

Every check here runs without a paid model. Where a check is a script, it is committed on the branch and can be
re-run. The findings report (6.9) lists each check with its result.

### 6.1 Navigation and interaction (browser, Playwright, on the web build)

- On a board with a few elements: a drag on empty canvas changes the camera and moves no element. A drag on an element
  moves that element and leaves the camera as it was. A Shift-drag on empty canvas selects the elements it covers.
- The wheel pans. Ctrl + wheel zooms around the pointer (the point under the pointer stays under it). Space + drag pans
  over an element.
- With touch emulation at the phone and tablet viewports: one finger on empty canvas pans, one finger on an element
  moves it, and a two-finger pinch zooms.
- Selecting a sticky, a shape, a text, a connector, a frame, and two elements each shows the contextual toolbar with
  the controls 3.3 lists for it. Changing a colour in it changes the stored element. Undo restores it.
- Creating each element of 3.2 through the main toolbar works, by a click and by a drag.
- A sticky with a lot of text keeps its size and its font shrinks. Resizing it refits the text.
- A connector attached to two elements still touches both after either one moves.
- tldraw's default UI is not in the page (no element of its menus, style panel or toolbar is visible).
- Screenshots of these states, at the desktop viewport, are saved for the report.

### 6.2 Multiplayer (real server, two pages through the test host)

- Two pages open the same new board. A sticky created in page A appears in page B within 2 seconds, and so do a move, a
  text edit, a colour change and a delete.
- Each page shows the other's cursor.
- Both pages change different elements at the same moment: both changes end up in both pages. Both change the same
  sticky's text at the same moment: both pages end with the same text, and no error is shown or logged.
- Page B's connection is cut and restored (through the test host): B returns to the current board without a reload.
  What happened to B's edits made while it was cut off is recorded in the report.
- The multiplayer traffic is seen to go only through the transport: the page makes no request to the server other than
  through the host, and there is no WebSocket in the page.

### 6.3 Agent, headless, no window (real server, MCP called directly)

- With no window connected, through the MCP endpoint with a chat's token: list boards, create a new board, add three
  stickies, two shapes with text, a frame holding some of them and two connectors between them, change one sticky's
  colour and text, delete one shape, read the board, and ask for a picture of the whole board and of the frame.
- The read returns the elements in agent terms (7.6), with the connectors' ends naming the elements they attach to.
- The pictures are PNGs of the right size, and they show the elements (checked by eye in the report and by a
  non-blank pixel check in the script).
- A window then opens the board and shows exactly those elements.
- No call reached a window. The server's log or a counter shows every call answered by the board host.

### 6.4 Agent and people together

- One page is open on a new board while the agent adds and moves elements through MCP. The page shows each change
  within 2 seconds, and the agent's marker (3.4) is visible while it works.
- The person moves a sticky while the agent changes its text. Both changes are kept.
- The person edits other elements meanwhile, undoes, and their undo touches only their own changes.

### 6.5 The board host is faithful

- For a corpus of texts (short, long, multi-line, accented Latin, Cyrillic, CJK, emoji) written by the agent into
  stickies, shapes and text elements: the stored sizes and font sizes after the board host's change equal those a
  browser produces for the same change, to within 0.5 px. A difference for CJK or emoji that comes from the machine's
  system fonts is recorded with its size, as the Excalidraw engine's harness does today.
- Pictures of the same boards from the board host and from Chromium (tldraw's own export in the page) have the same
  width and height. At most 2% of pixels differ by more than a quarter of a channel, and no shape is displaced.
- The board host's start time, memory with 1 and with 10 boards open, the time of an agent `apply`, and the time of a
  picture are measured and recorded.

### 6.6 Saving and failure

- After an agent's change is answered, the board file on disk has it.
- A person's edit is on disk within a few seconds.
- The board host is killed while two pages and the agent are on a board. The pages show a reconnecting state, then come
  back to the board as of the last save. The agent's next call works (the board host is started again), and its call
  in progress failed with a clear message, not a hang.
- The server restarts: new boards load from disk with everything that was saved.

### 6.7 Old boards untouched

- On the branch, the repository's tests for the packages the prototype changed pass as `AGENTS.md` says. That means
  the Go default set for each changed Go package, and the root `npm test && npm run check`.
- Free scripts that cover old boards still pass: `node web/e2e/away.e2e.mjs` and `node web/e2e/readers.e2e.mjs`.
- A failure that comes from load and passes alone is recorded as such, as `AGENTS.md` says.

### 6.8 Remote servers in principle

The report says what a remote server would need for new boards: Node and the board host on that machine, the fonts,
and the licence. It also says whether anything in the prototype's design rules them out.

### 6.9 The findings report

A file `better-board-prototype-findings.md` on the branch, at the end. It contains:

- for each of 3.1–3.7, whether it was shown, with the check and its result (6.1–6.6), and screenshots where they help
- the measurements of 6.5
- what was hard, what was not possible, and the workaround tried
- every place the work did not follow section 7, with the reason (7.0)
- the risks of section 8, each answered or still open
- the licence finding (4.2)
- what a real build would need beyond the prototype, roughly sized, and a recommendation: go on this way, change
  course, or stop

## 7. Reference implementation

### 7.0 How to use this section

This section holds the implementation details agreed or proposed so far. It is a **reference**, not a rule. Follow it
by default. It is fine not to follow a part when:

- the goal cannot be reached by following it,
- it does not work, or
- following it causes a bug.

If you see a better way, or a risk or side effect in following it, you may still follow it, but **flag** it in the
findings report (6.9). Every departure from this section, and the reason for it, is listed in the report.

### 7.1 Domains

| Domain | Where (proposed) | Owns |
|---|---|---|
| Board UI | a new package, e.g. `packages/board-tl` | the tldraw component with our UI: navigation, contextual toolbar, main toolbar, our shapes and tools, the sync client and its socket over the transport |
| Board host | a new package, e.g. `packages/board-host`, growing out of `packages/headless` | the rooms, the headless editor and agent operations, text measuring, picture rendering, saving |
| Board model | shared by both, e.g. `packages/board-tl/model` | the schema (tldraw's default shapes plus ours), the agent terms and their mapping to and from records |
| Relay and routing | Go: `internal/headless` and the board API | starting and watching the board host, carrying sync messages between windows and the board host, sending agent tools for new boards to the board host |

The window and the board host use **one** schema and one set of shape definitions, from the same code. `[standing]`
(one engine, not two)

### 7.2 Shapes

- Sticky note: tldraw's `note` shape, restyled to be square, with Miro colours, shrink-to-fit text and no tldraw
  "sticky" look, if its options allow. Otherwise a custom `ShapeUtil` of our own.
- Shapes: tldraw's `geo`. Text: tldraw's `text`. Connectors: tldraw's `arrow` with its bindings. Frames: tldraw's
  `frame`. Pen: tldraw's `draw`.
- Our own styles (the colour palette, border width) are tldraw style props, so tldraw's "set style for the selection"
  works with them.

### 7.3 Navigation and tools

- Drag-to-pan comes from changing the select tool's state when the pointer goes down on empty canvas (its idle state
  and "pointing canvas" state), not from a separate hand tool the person must pick. Shift on empty canvas goes to the
  brushing (selection box) state.
- Wheel behaviour comes from tldraw's camera options (`wheelBehavior: 'pan'`, with zoom on Ctrl/⌘ and pinch).
- Every default UI component is set to `null` or replaced through `components`. Our toolbars are React components that
  read the editor reactively (`useValue`) and change it only through the editor's API.
- The contextual toolbar takes its position from the selection's screen bounds and is hidden while the editor is in a
  dragging, resizing or rotating state.

### 7.4 Multiplayer transport

The window's sync client gets a custom socket (`TLPersistentClientSocket`) that rides on the existing transport:

```
window → server: transport call  POST /api/boards/{id}/sync   { session, messages: [...] }   (batched)
server → window: transport stream event  "sync"                { board, session, messages: [...] }
server ↔ board host: the board host's own client connection (as the headless writer has today):
                 the server hands each window's messages to the board host tagged with the session,
                 and the board host's replies come back the same way, and go to that window's stream.
board host:      room.handleSocketConnect / handleSocketMessage / handleSocketClose,
                 with one proxy socket per window session whose send() goes back through the server.
```

- A session is opened when a window shows a new board and closed when it leaves or its stream ends.
- Messages are batched (for example every 50 ms) in both directions. Presence (cursor) messages may be throttled
  harder or dropped under load. Document messages are never dropped.
- The Go server treats the messages as opaque bytes.

### 7.5 The board host

- One `TLSocketRoom` per open new board, loaded from the board file when the first peer arrives (a window session or an
  agent call), saved through `onDataChange` (throttled) and when the room closes. Closed when the last peer leaves,
  after a quiet time.
- **Agent as a peer.** Each room with agent activity has one headless tldraw `Editor` in the board host. It sits on its
  own store, connected to the room as a sync client through an in-process socket pair. So its changes reach the
  windows like any peer's, and it has presence (3.4). The alternative is a short-lived editor per call that loads the
  room's snapshot and writes the resulting diff with `room.updateStore`. Either is acceptable. The report says which
  was used and why.
- The editor runs in Node on a stand-in page (the approach of `packages/board-engine/src/page.ts`) or in jsdom.
  Its text measuring is replaced with one based on skia-canvas and the real font files (4.8).
- Pictures: the editor's SVG export, rasterized to PNG in Node (skia-canvas, or resvg), with the fonts embedded or
  loaded.

### 7.6 Agent tools on a new board

- The same tool names as today (`list_boards`, `read_board`, `apply`, `delete_elements`, `get_image`,
  `create_board`, `get_view`, `show_board`). A new board's `read_board` says it is a new board, and `apply` takes the
  element terms of 3.2. `create_board` gets a way to say which kind.
- Agent terms (shape, not final):

```jsonc
{ "ops": [
  { "op": "create", "ref": "n1", "type": "sticky",    "x": 0, "y": 0, "text": "Idea", "color": "yellow" },
  { "op": "create", "ref": "s1", "type": "shape",     "shape": "rectangle", "x": 300, "y": 0, "w": 200, "h": 100, "text": "API" },
  { "op": "create",              "type": "connector", "from": "n1", "to": "s1", "end": "arrow", "text": "calls" },
  { "op": "create", "ref": "f1", "type": "frame",     "name": "Sprint", "contains": ["n1", "s1"] },
  { "op": "update", "id": "shape:abc", "color": "green", "text": "Done" },
  { "op": "delete", "id": "shape:def" }
] }
```

- Each `ref` resolves to an id, and the answer returns those ids. Sizes left out get the defaults a person would get.
  Text is fitted as in a window.
- **One `apply` is one transaction.** All its operations are applied in one editor transaction (`editor.run`), become
  one change in the room, reach the windows together, and are saved together. If one operation is invalid, nothing of
  that `apply` is applied, and the answer says which operation and why.
- The order inside one `apply` call:
  1. take the room's current state
  2. resolve refs
  3. apply all operations in one transaction
  4. measure and fit the text
  5. send the change to the room
  6. save the board file
  7. answer the agent

### 7.7 Board storage

- A new board is stored like an old board, in its folder with its metadata, plus a field naming its kind (`tl`). Its
  content is the room's snapshot (`room.getCurrentSnapshot()`) as JSON.
- The Go server reads the kind to route the board's calls and its sync traffic, and nothing else of the content.

## 8. Risks

**8.1 tldraw's editor in Node.** `[not verified]` tldraw's own tests run the editor in jsdom with text measuring
stubbed. Whether it runs on a stand-in page or in jsdom, with real text measuring and its SVG export (which renders
React components), is the main unknown, and the first thing to prove.

**8.2 Rich text measuring.** `[not verified]` tldraw stores text as rich text (TipTap). Measuring it with a canvas
instead of the DOM may need its own line breaking. It has to match the browser's line breaking closely enough for
6.5.

**8.3 Shrink-to-fit on stickies.** `[not verified]` Whether tldraw's `note` shape can shrink its text, or keep a fixed
size, through its options, or needs a shape of our own.

**8.4 Sync over a relayed transport.** `[not verified]` Latency and load of carrying every sync message through Go and
the existing stream. Drags and cursors make many small messages, and batching may be needed to keep it smooth.

**8.5 Reconnecting after the board host restarts.** `[not verified]` What tldraw's sync client does when the room it
reconnects to has gone back to an older saved state: resend its pending changes, drop them, or fail.

**8.6 Licence.** `[not verified]` The terms may rule tldraw out for a release (4.2). The prototype answers this early,
because it decides whether the rest matters.

**8.7 Text that differs from the machine's fonts.** `[standing]` As with Excalidraw: CJK and emoji come from the system's
fonts, so they may measure differently on another machine. The prototype records it and does not have to solve it.

**8.8 Size of the board host.** `[not verified]` A room and an editor per board, with fonts and a canvas, may use much
more memory than today's headless writer (120–135 MB). 6.5 measures it.

## 9. Not decided yet

- The fonts of the new board: tldraw's own, or a Miro-like sans chosen for the prototype.
- How people's names reach the cursors (the client's name, the server's name for the client, or a generated one).
- The quiet time of the board host and of a room, and the throttle of people's saves. Picked when measured.
- Whether the agent's peer is persistent per room or short-lived per call (7.5).
