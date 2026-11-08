# Findings: the better-board prototype

The findings report that goal section 6.9 asks for (`better-board-prototype-goal.md`, "the goal"). It covers the branch
`better-board-prototype` at `e03bdc99` (118 commits on top of `c6333946`), checked on 2026-11-08. The setup: darwin-arm64 on
a shared 14-core Mac, Node 24.3.0, tldraw 5.6.0 pinned exactly, Chromium 156 through Playwright 1.64.1.

Every claim below names the note it comes from. The notes are in `plans/better-board/`. Where a number is not in a note, the
report says it was not measured.

## Summary

**What works.** All seven parts of goal section 3 were shown on a real Go server, using the app's real web build:

- **Navigation and interaction feel like Miro.** You drag to pan, wheel to pan, and pinch or Ctrl+wheel to zoom. Touch was
  shown in Chromium with touch emulation. There is our own main toolbar, our contextual toolbar for each kind of selection,
  quick add, and undo that touches only your own changes. None of tldraw's own UI is shown.
- **Every element of goal 3.2 is there except images**, which were left out.
- **Multiplayer runs over the existing pinned transport, relayed by Go.** A change in one window shows in another in a median
  of 27–39 ms. People's cursors are named, and windows reconnect after a cut without a reload.
- **Agents always edit headless.** Every agent call goes to a Node board host. With a window open, the agent's change shows in
  14–17 ms. The board host measures text the way Chromium does: stored sizes are exact for 372 of 377 corpus cases, and the five
  that differ are all CJK auto-width text drawn in a macOS system font. It also draws pictures without a browser: same size as tldraw's
  own export, and 0.23–0.97% of pixels differ strongly against a 2% bar.
- **Saving, restarts and kills behave as goal 3.6 and 3.7 ask.**
- **Old boards are untouched.** All their tests and their two end-to-end scripts pass.
- **tldraw was neither patched nor forked.**

**Recommendation: go on this way. Before more engineering money goes in, get tldraw's licence terms in writing.** The technical
risks the goal named were answered:

- tldraw's editor runs in Node (8.1).
- Text is measured faithfully (8.2).
- Our own sticky works (8.3).
- Relayed sync is fast (8.4).
- Rooms reconnect safely after a restart (8.5, with a fix).
- Memory stays at a few hundred MB (8.8).

What remains is ordinary product work, roughly sized in section 10.

**The decisive open item is the licence (risks 4.2 and 8.6).** A release needs a commercial tldraw key, and tldraw publishes
no price. The only figure around is a third-party report of about $6,000 a year. On top of the price, three things must come
from tldraw's sales team:

- the key has to be a native key that works on the Electron `file://` page and on the phone's page;
- it has to be perpetual, or renewable in a way that works for apps already installed;
- one licence has to cover the self-hosted board host and the sync room as well.

If those answers are unacceptable, tldraw is out for a release. The work that carries over is listed in section 11.

Smaller open items:

- **CJK on macOS.** CJK text is up to 0.5% wider in the host for auto-width text, because of a macOS system font (PingFang SC).
- **Memory.** The board host does not give back memory after its rooms close: 352 MB with 10 boards stays at 353 MB.
- **Edits lost when the host is killed.** An edit the room had confirmed but not yet saved (at most 1 s old) is lost.
- **One tldraw limit.** If a window creates an element and the connection drops within a round trip, deleting that element
  while offline is undone on reconnect.
- **Not run.** Linux and Windows measuring, WebKit and phones, and the final board inside Electron.

---

## Contents

1. How it was confirmed
2. Goal 3.1–3.7: shown or not
3. Measurements (goal 6.5)
4. What was hard, what was not possible, the workarounds
5. Departures from goal section 7
6. The risks of goal section 8
7. Licence (goal 4.2)
8. Old boards untouched (goal 6.7)
9. Remote servers in principle (goal 6.8)
10. What a real build needs beyond the prototype
11. Recommendation
12. Where things are

---

## 1. How it was confirmed

Goal section 6 says "where a check is a script, it is committed on the branch and can be re-run". The user's testing rules for
this goal override that (`ORCHESTRATION.md`, "Testing"; decision O6):

- **No end-to-end tests were added.** They are slow and costly, and they get re-run too often.
- **The section 6 checks ran as temporary scripts.** They were never committed: they lived in `/tmp/bb-verify/` and in
  `/tmp/<lane>/`. They ran against:
  - **real scratch servers**: a `go build` of the branch with `-boardhost-dir packages/board-host/dist`;
  - **the real app web build**: `app/scripts/export-web.mjs` with `connect-src 'self'`, served through the test host
    (`web/dev/host.mjs`, `web/e2e/lib/rig.mjs`);
  - **the agent**, driven only by direct MCP calls with a chat's token. No paid model was used (goal 4.11).
- **How the page was read.** The scripts read the page's editor through the mount's existing `onMount(editor)` option. No
  product seam was added for them (`verify.md`, "How").
- **The lanes' own research ran the same way.** They used temporary Playwright scripts on board-tl's dev page and on fake links
  into an in-page room (`win-view.md`). The Chromium reference cases of the host lane also ran this way
  (`host-stickyref.md`, `host-h0.md`).
- **What is committed is unit tests for the logic**:
  - in board-tl: the sticky fit, the context bar's model, quick add, the socket, sync on fake links, the handle, local undo;
  - in board-host: rooms, the agent tools, picture sizes, the sticky reference;
  - in Go: `internal/tlrelay` and the changed packages.
- **The results are in the notes.** They are in `verify.md` and the lanes' notes, with small screenshots in
  `plans/better-board/shots/`.

**What this costs.** The section 6 checks cannot be re-run with one command. To re-run them, write the scripts again from the
tables in `verify.md`. Each table names its script and what it measured. A real build should turn the important ones into
committed checks (section 10).

**Bugs found and fixed during verification.** Each fix went on its own branch, and only the affected check was re-run afterwards
(`verify.md`, table at the top):

- **Undo touched others' changes.** An undo in a window put back properties that the agent or another window had changed since.
  It was fixed by field-wise local undo (V1). The first attempt still failed on the real server; the second worked.
- **Capped pictures were off by a pixel.** A tall capped picture came out 1974–2009 px on its long side, and 1 px off the
  window's export. It was fixed by sizing pictures as tldraw does (V2).
- **Space+drag did not pan.** The voice pill took the Space key.
- **The contextual toolbar could sit under the main toolbar.** It now keeps clear of our toolbars (V3).
- **Wrong tool description.** `get_image` still described only old boards' 8192 px refusal. It now names the 2000 px cap (H-4).

---

## 2. Goal 3.1–3.7: shown or not

### 3.1 Navigation: shown

| Behaviour | Result | Check and source |
|---|---|---|
| A drag on empty canvas pans and moves nothing; a drag on an element moves it; a Shift-drag brushes | pass | Spot check on the real build (`verify.md` 6.1, `c5-spot`). Dev page: `win-view.md` T2a rows 1–3; the camera moved −176.8,−117.9 with the selection kept. |
| Wheel pans; Ctrl/⌘+wheel and trackpad pinch zoom around the pointer | pass | Drift 0.000 px on the real build (`verify.md`). CDP pinch: `spike-ui-nav.md` row 4. |
| Space+drag and middle-drag pan over elements | **pass after a fix** | It failed first: the voice pill's hold took Space. After the fix (`holdkeys.web.ts`) the camera moved (109, 55) and the element stayed put (`verify.md`). |
| Touch (phone and tablet): one finger pans or moves, a pinch zooms | pass | Phone: `win-view.md` T2a rows P. Tablet: `verify.md` (`c6-touch`), spread ×3.0, pinch ×0.39, drift 0.00 px, and the page itself does not zoom. |
| Zoom controls; `Shift+1` fits the board, `Shift+2` fits the selection | pass | `win-view.md` T2a rows Z. |
| No hard edge; zoom limited to 10–400% | pass | `win-view.md` row 6, by wheel and by buttons; by pinch in `spike-ui-nav.md` row 6. |

Notes:

- Touch was emulated: CDP touch events in desktop Chromium. It was not run on WebKit or on a real device, so iOS's own
  double-tap zoom and long-press menu were not exercised (`spike-ui-nav.md`, "Uncertain").
- tldraw slides the camera on after a Space or middle-button pan; our left-drag pan stops dead. This was left as it is
  (`spike-ui-nav.md`).

Shots: [verify-board.png](plans/better-board/shots/verify-board.png),
[win-toolbar.png](plans/better-board/shots/win-toolbar.png),
[spike-ui-nav-pan.png](plans/better-board/shots/spike-ui-nav-pan.png),
[spike-ui-nav-brush.png](plans/better-board/shots/spike-ui-nav-brush.png),
[spike-ui-nav-phone-pinch.png](plans/better-board/shots/spike-ui-nav-phone-pinch.png).

### 3.2 Elements: shown, except images

| Element | Result | Check and source |
|---|---|---|
| **Sticky note** | pass | Our own shape `aiwb-sticky` with Miro's 16 colours (W1, W2, U3). Shrink-to-fit: 205 characters typed kept it at 200×200 while the font went 48 → 13 px. Resizing refits: 24 px at 320×320 and 11 px at 170×170, and it stays square (`verify.md` 6.1, `c3-sticky`). A new note gets the last colour used (`spike-ui.md` D: cyan, then the next note is cyan). |
| **Shapes**: rectangle, rounded rectangle, ellipse, triangle, diamond | pass | Fill colour, border colour, border width and border style are separate controls (W4: our geo extension with `fillColor` and `labelSize`). Each kind can be made by click and by drag (`verify.md` `c1-create`, 20/20). |
| **Text** | pass | Font size can be set. Width is automatic, or fixed with wrapping. Click → 59×32 in editing; drag → 240×32 (`verify.md`). Controls: `win-view.md` T2b. |
| **Connectors** | pass | Straight, curved and elbow. Arrowheads none/arrow/triangle/dot/diamond/bar at each end (T2b). A connector can carry text: the agent term `text`, and arrow labels measured 13/13 against Chromium (`spike-host.md` 2). Attached ends follow both elements when either moves, by mouse or by the agent (`verify.md` `c2-connector`). |
| **Frames** | pass | A named area with a background colour (W5, T2b). Moving a frame moves what it holds (`spike-host.md` A; the agent's `contains`, `host-lane.md` smoke). Dragging an element into or out of a frame is tldraw's own frame behaviour and **was not checked as a separate item**. |
| **Pen** | pass | Click and drag create (`verify.md` `c1-create`). Colour and width are in the contextual toolbar (T2b). The pen is the one tool that stays selected after use. |
| **Images** | **left out** | No toolbar button and no agent term. `read_board` would name an image `"image"` (`terms.ts`), but nothing creates one. Goal 3.2 allows leaving images out. |

Shots: [verify-board.png](plans/better-board/shots/verify-board.png) (every element kind),
[verify-sticky-fit.png](plans/better-board/shots/verify-sticky-fit.png),
[spike-ui-sticky-shrink.png](plans/better-board/shots/spike-ui-sticky-shrink.png).

### 3.3 Interacting with elements: shown

| Behaviour | Result | Check and source |
|---|---|---|
| Click selects, Shift+click adds or removes, a click on empty canvas clears | pass | `win-view.md` T2a, `spike-ui-nav.md` row 1 |
| A contextual toolbar for sticky, shape, text, connector, frame, several elements and locked elements, with goal 3.3's controls; a change applies at once and undoes in one step | pass | Dev page: 62/62 (`win-view.md` T2b). Real build: 7/7, with the colour seen in `read_board` and ⌘Z restoring it (`verify.md` 6.1). The bar follows pans exactly, hides while dragging, and stays clamped and flipped at the edges (T2b). |
| The toolbar keeps clear of the main toolbar | **pass after a fix** | V3 (`verify.md`) |
| Double-click edits text; typing starts editing a selected sticky or shape; Escape ends editing | pass | `win-view.md` T2c 3h–3r, including fast typing kept in order |
| A double-click on empty canvas creates a sticky ready to type | pass | `win-view.md` T2a row 7; also by touch double-tap (`spike-ui-nav.md` row 8) |
| Main toolbar: click places an element at its default size, a drag sizes it, the tool returns to select (except the pen) | pass | 20/20 on the real build (`verify.md` `c1-create`) |
| Quick add: "+" on each side; a click adds a copy joined by a connector; dragging the "+" draws a connector | pass | 41/41 (`win-view.md` T2c 1a–1r) |
| Alt+drag duplicates; arrow keys nudge (Shift+arrow nudges further); copy, cut, paste, duplicate, delete, select all, undo, redo | pass | `win-view.md` T2c 2a–3g. Ctrl+Y was added for redo. |
| Undo and redo touch only this window's changes | **pass after a fix** | V1: field-wise ownership on top of tldraw's history, done with public store side effects and no patch. Real-server check: the person's ⌘Z ×2 restored their own text and colour and kept the agent's x/y and font size (`verify.md` 6.4). |
| None of tldraw's default UI is shown | pass, with notes | 16/16: no `tlui-` element after selections, right-click or any of tldraw's menu shortcuts (`verify.md` `c4-noui`). See the V4 notes below. |

Notes (V4 and `win-view.md`):

- In the web build, a right-click opens the browser's own context menu.
- tldraw's hidden shortcuts that need no UI still work. For example, ⌘⇧C silently copies the selection as a PNG.
- Local undo keeps tldraw's rules for creates and deletes. Undoing a delete recreates the element even if someone else deleted
  it since.
- Undo does not restore the style chosen for the next shape (`spike-ui-ctx.md` gap 7, the same as tldraw's own panel).
- Paste was shown in headless Chromium only, not with Electron's clipboard.

Shots: [verify-ctx-sticky.png](plans/better-board/shots/verify-ctx-sticky.png),
[verify-ctx-connector.png](plans/better-board/shots/verify-ctx-connector.png),
[win-ctx-shape.png](plans/better-board/shots/win-ctx-shape.png),
[win-quickadd.png](plans/better-board/shots/win-quickadd.png),
[win-combined.png](plans/better-board/shots/win-combined.png).

### 3.4 Multiplayer: shown

The setup was one server and two pages through two test hosts; page B went through a link that could be cut (`verify.md` 6.2).

| Behaviour | Result | Measured |
|---|---|---|
| A create, move, text edit, colour change and delete in A appear in B | pass | Medians 27–39 ms; the slowest of 25 tries took 50 ms (the bar is 2 s) |
| Each page shows the other's cursor with a name | pass | 27 / 35 ms. Names are generated ("Coral Fox", D12). tldraw 5.6 writes a `user:` record, so the names are saved with the board (W8). |
| The agent appears as a peer: a marker with the agent's name | pass | The marker shows 13–35 ms after each answer, covers the changed element, and is gone after 4.6 s (`verify.md` 6.4). It is a custom message (D11), not a tldraw presence. |
| Different elements changed at the same moment | pass | 5/5 rounds converged; median 67 ms, max 79 ms |
| The same sticky's text changed at the same moment | pass | 10/10 rounds ended with one text in both pages. The last write to reach the room wins (B 7 times, A 3). No error anywhere. |
| A window's connection cut and restored | pass | "Reconnecting…" showed after 110 ms. Back 1.17 s after the restore, with the same editor and no reload. |
| Traffic only through the transport | pass | Every request went to the page's own host. No WebSocket. 54 and 23 `/api/tl/<id>/sync` calls. |

**Edits made while cut off** (goal 3.4's question; `verify.md` 6.2, W8):

- **They are kept.** Creates, moves, text edits and deletes made while offline are pushed on reconnect.
- **When both sides changed the same property, the offline window's value wins.** Its push reaches the room last.
- **One exception, which is tldraw's.** Suppose an element was created within about a round trip before the cut, and deleted
  while offline. On reconnect the element comes back, because tldraw 5.6's sync client drops its buffer of the room's answers
  when the connection is lost (`win-view.md`, "Lane lead").
- **After the room rejects a client, its unconfirmed edits are dropped**, because it gets a fresh store (W8).

Shots: [verify-cursors.png](plans/better-board/shots/verify-cursors.png),
[verify-agent-marker.png](plans/better-board/shots/verify-agent-marker.png),
[win-sync-two.png](plans/better-board/shots/win-sync-two.png),
[win-agent-marker.png](plans/better-board/shots/win-agent-marker.png).

### 3.5 Agents, headless: shown

| Behaviour | Result | Check and source |
|---|---|---|
| With no window open: list boards, create a new board, add 3 stickies, 2 shapes with text, a frame and 2 connectors, update, delete, read, and pictures of the whole board and of the frame | pass | Joint smoke on a real server (`host-lane.md`). The pictures were 784×524 and 584×344. `snapshot.tl.json` on disk held the result. Shot: [host-smoke-all.png](plans/better-board/shots/host-smoke-all.png). |
| The read answers in agent terms, and connector ends name their elements | pass | `read_board` gives a header line plus one JSON line per element (D13). A connector whose element was deleted has a free end (`host-lane.md`). |
| A window then opens the board and shows exactly those elements | pass | The page's 7 elements equal `read_board`'s: ids, types, bounds within 0.5 px, keys, parent, text, colours and bindings (`verify.md` 6.3). Shot: [verify-headless-then-window.png](plans/better-board/shots/verify-headless-then-window.png). |
| No call reached a window | pass | `status -json` `running.boardhost.calls`: 18 calls, all ok, `screenCalls` 0. Every log line reads `tl: <tool> … -> board host ok`. With a window open: 3 more calls, still `screenCalls` 0 and no `/api/rpc-reply` from the page (`verify.md` 6.3). |
| With windows open, the agent's changes show live | pass | Median 14–17 ms, max 27 ms (`verify.md` 6.4) |
| Sizes are right | pass, except CJK auto-width text | Section 3 below |
| Pictures without a browser | pass | Section 3 below |
| `get_view` and `show_board` still go to a window | built; not run end to end | Routed to the window with the newest open session (D14). The view's handle (`getView`, `zoomTo`) is covered by unit tests and was checked on fake links (`win-view.md` T3). The section 6 runs did not call these two tools through MCP on the real server. |
| Agents use the element terms of 3.2, not raw tldraw records | pass | `terms.ts`, `apply.ts`. A `ref` becomes a lasting key (`meta.key`, D10). One `apply` is one atomic transaction, and a bad op names its index and the reason (`host-lane.md` errors). |

How well real agents manage with the JSON-lines `read_board` (design 11) was not measured, because no paid model was run.

### 3.6 Saving: shown

| Behaviour | Result | Measured (`verify.md` 6.6) |
|---|---|---|
| Stored like an old board, with its name and its place in the tree, plus `kind: "tl"` | pass | `board.json` + `snapshot.tl.json` (D7, D8) |
| After an agent's change, the board is saved before the agent is told | pass | 10/10 times the file held the change right after the answer |
| People's edits are saved within a few seconds | pass | Median 1048 ms, max 1059 ms (a 1 s throttle, D8) |
| A server restart loses nothing that was saved | pass | `read_board` was the same line for line. An edit made 300 ms before the stop was saved by the host as it shut down. Shot: [verify-after-restart.png](plans/better-board/shots/verify-after-restart.png). |
| A host restart loses at most a few seconds of people's edits and nothing an agent was told | pass, with a limit | Killed 0 ms after an edit: the edit was re-pushed and kept. Killed 60 ms after: the room had confirmed the edit but not saved it, so it was lost everywhere. The loss is bounded by the 1 s throttle (V4 item 3). |

### 3.7 The board host: shown

| Behaviour | Result | Check and source |
|---|---|---|
| Started and watched by Go the way the headless writer is: the same Node and bundle lookups, the same handshake | pass | A second `internal/headless.Manager` with `Program`/`Folder`/`Name`/`NodeEnv` options (D3; design 2.8 G3). Flags `-boardhost-node` and `-boardhost-dir`. |
| It runs while needed and stops after a quiet time | pass | With `quiet=6s`: nothing starts at boot. It stopped 15.2 s after the last agent call. With a page open it kept running, and it stopped 9.9 s after the page closed (`verify.md` 6.6). |
| If it dies, Go restarts it on the next need, windows reconnect, and the board comes back from the last save | pass | SIGKILL with two pages and the agent: both pages showed "Reconnecting…" and were back in 0.8–0.9 s on a new host. 14/14 calls in flight failed within 4–11 ms with `HOST_STOPPED: …` and no hang. The next call worked on a new process. Shot: [verify-host-killed.png](plans/better-board/shots/verify-host-killed.png). |

The production quiet times are the architect's placeholders: a room closes after 30 s and the process after 60 s (D17). Goal 9
said to pick them once measured. They were exercised with lowered values, and **not re-picked from measurements**.

---

## 3. Measurements (goal 6.5)

### Text sizes against Chromium

Through the whole path: MCP → Go → board host → room → sync → the real app page. The agent wrote 377 elements; the page
re-created each one with the same props, so the window's own code measured them (`verify.md` 6.5):

| Kind | Cases | Equal | Within 0.5 px | Worst |
|---|---:|---:|---:|---:|
| Sticky (`fitted`, w, h; automatic and fixed s/m/l/xl) | 78 | 78 | 78 | 0 |
| Shape (`growY`, w, h; 5 kinds × label s/m/xl; 135 grew) | 195 | 195 | 195 | 0 |
| Text, fixed width (bounds) | 52 | 52 | 52 | 0 |
| Text, auto width (bounds) | 52 | 47 | 49 | 6.0 px |

- **The one limit: CJK text in auto-width text elements.** It is 1.7, 4.2 and 6.0 px wider in the host at sizes m, l and xl
  (0.26–0.51%). Heights and line breaks are equal.
- **Why.** Chromium draws Han characters in PingFang SC, a system font, and applies that font's tracking for each size. The
  host's canvas applies one ratio at every size, so a Han character is up to 1.7% wider (`spike-host.md` 2, per-size table).
- **What is exact.** Kana, Hangul and emoji.

At the measuring level the lanes found the same (`host-h0.md`, `host-stickyref.md`, `spike-host.md` 2):

- tldraw's note and geo: 208/208 each, exact.
- Our sticky: 46/46 exact; our geo's label size: 52/52 exact.
- The 1,534-case corpus: every non-CJK case is within 0.5 px except five. Four are overflow splits of one long word in Shantell
  Sans at a 120 px width. Shantell is tldraw's hand-drawn font, which none of our elements use. The fifth is a truncated frame
  heading, which is drawn and not stored.

### Pictures against Chromium

The host's `get_image` against tldraw's `editor.toImage` in the page, with the same ids, bounds, padding and scale, after fix V2
(`verify.md` 6.5):

| Board / scope | Host | Page | Pixels differing strongly (>64) | Worst shift |
|---|---|---|---:|---:|
| kinds (27 elements) / all | 1914×880 | 1914×880 | 0.475% | 1 px |
| kinds / frame | 554×344 | 554×344 | 0.234% | 0 |
| kinds / 2 shapes + connector | 504×194 | 504×194 | 0.383% | 0 |
| corpus / all (capped, scale 0.463) | 741×2000 | 741×2000 | 0.574% (1.95% before V2) | 1 px |
| corpus / CJK + emoji rows | 1104×694 | 1104×694 | 0.965% | 1 px |

The result passes: the same size, at most 2% of pixels differing, and no shape displaced.

- **The 2000 px cap.** A board larger than 2000 px is drawn at a lower scale, and the answer says so (H-4). After V2 the long
  side is exactly 2000: 1539.55×4260 → 741×2000 and 302.9×19000 → 38×2000.
- **Earlier comparison.** The spike's reference board differed in 0.31% of pixels (`spike-host.md` 3).

Shots: [verify-picture-sbs.png](plans/better-board/shots/verify-picture-sbs.png) (host | page) and
[verify-picture-diff.png](plans/better-board/shots/verify-picture-diff.png) (host | page | diff).

### Cost of the board host

Three fresh servers, median / max, measured while other agents shared the machine (`verify.md` 6.5):

| What | Value |
|---|---|
| Board host start, from process start to ready | 171 / 175 ms |
| First agent call, which starts the host (client side) | 234 / 235 ms |
| RSS: 1 empty room / 1 board of 10 stickies / 10 boards of 20 elements | 149 / 158 / 352 MB |
| RSS after the rooms closed | **353 MB, not given back** (V4 item 2) |
| `apply` with 1 op / 20 ops (client side) | 2–3 ms (max 17) / 11–12 ms (max 23) |
| `get_image`: 1 sticky / 20 elements / capped board of 110 elements | 6 / 25 / 57 ms |

For comparison:

- **Today's headless writer** uses 120–135 MB (goal 8.8).
- **The spike's cost script** measured 139 MB with 1 room and 166 MB with 10 (`spike-host.md` 5). That script forced garbage
  collection before each reading and used a small reference board. verify.md measured a live host without that. The cause of
  the gap between 166 MB and 352 MB was not investigated.
- **resvg's native memory.** The spike saw that resvg does not give back its native memory: 231 MB after 10 PNGs.
- **The memory finding.** RSS is not returned after rooms close, because V8 keeps its heap. No leak test was run. The process
  does stop after its quiet time (60 s), and that returns everything. So the finding matters for a host that stays busy for a
  long time.

Other sizes:

- **The board host bundle:** 7.1 MB `boardhost.mjs` in a 41 MB folder (`host-lane.md`, H-6).
- **The window's `tl.js`:** a development build of tldraw with the 16 fonts inlined. Measured for this report:
  4,361,271 bytes, 2.14 MB gzipped. `tl.css` is 84 KB.
- **What a production build would be:** about 2.0 MB minified (609 KB gzipped) plus 1.3 MB of fonts (`spike-ui-embed.md` 2).
- **For comparison,** Excalidraw's `board.js` is 3.2 MB.

The goal did not ask for the time from a page's open to the first frame on screen, and it was not measured.

---

## 4. What was hard, what was not possible, the workarounds

Nothing the goal asked for turned out to be impossible. The hard parts, each with what was done:

1. **tldraw needs a real DOM in Node.** TipTap serializes rich text with a document, and the SVG export renders React
   components and walks the result. A hand-made stand-in page, as `packages/board-engine` uses, would have to be a whole DOM
   implementation. Three real DOMs were tried, and all gave byte-identical output. The choice was **linkedom**: it needs about
   40 lines of shims, and costs +21 MB against jsdom's +80 MB and 52 ms to load against 197 ms. jsdom stays selectable as a
   fallback but is not shipped (`spike-host.md` 1, O4, H-2). Two things tldraw does in Node had to be handled:
   - It opens a `BroadcastChannel` that would keep the process alive forever; the host makes it not hold the process.
   - Every export leaves a 5 s timer behind (`host-h0.md`).
2. **Measuring text like Blink.** A canvas measure needed its own line breaking (`spike-host.md` 2):
   - **Breaks.** Line breaks follow UAX #14, **except between two ASCII characters**. There Blink uses its own table. That
     table was measured from Chromium: 241 of 8,836 pairs break, and UAX #14 disagrees on 389 pairs. For example, Chromium
     does not break a URL after `/`.
   - **Rounding.** Widths are rounded to Blink's LayoutUnit (1/64 px), with a tolerance for skia's float32 sums.
     168.0000153 against 168.0 decided whether "Hello world" fits a label.
   - **Fallback fonts.** Chromium picks serif fonts per script. Emoji-presentation clusters are always sent to the colour
     emoji font. Default-ignorable characters have no width.
   - **Frame headings.** Their positions come from prefix widths of the whole line.

   The table has to be regenerated when the reference Chromium changes.
3. **Pictures with resvg.** tldraw's export puts every label in a `<foreignObject>` of HTML, which no rasterizer outside a
   browser can lay out. The workaround is `textToPaths` (`spike-host.md` 3):
   - each label becomes glyph outlines, laid out by the same code that measures;
   - colour emoji become small PNG images;
   - tldraw's text outline becomes six offset copies;
   - frame headings get Blink's baseline shift.

   resvg was chosen over skia-canvas's SVG loader, which was 6× slower and dropped the emoji. Pictures are capped at 2000 px,
   because a 189-shape board at scale 1 took 2.5 s. Picture size is floored as tldraw does it (V2).
4. **The sticky had to be our own shape.** tldraw 5.6's `note` grows instead of shrinking its text, does its sizing in private
   methods, resizes only by scale, and hard-codes its paper look. Our `aiwb-sticky` has its own colour style prop. If it used
   tldraw's shared colour style, picking a sticky colour would also colour the next rectangle (`spike-ui.md` D, U3, W1–W3).
   The fit (`fit.ts`) is a pure function, so the window and the host run the same code.
5. **tldraw's geo shape lacks some styles.** It has one colour for fill and border, and one style for both label size and
   border width. Our geo extends tldraw's with `fillColor` and `labelSize` style props, and adds a rounded rectangle as a
   custom geo type (`spike-ui-ctx.md` gaps 1–3, W4).
6. **Miro navigation without patching.** The select tool's child states are not exported. `MiroSelectTool` swaps in subclasses
   of tldraw's own states, found by their ids (`spike-ui.md` C). Three problems came up in emulated touch and use, and were
   fixed:
   - a pinch-out was read as a double tap and made stickies;
   - a pinch over our toolbar zoomed the page;
   - shortcuts did nothing until the board had the focus (`spike-ui-nav.md`).
7. **Local undo (V1).** tldraw's history writes back whole records, so an undo put back others' changes. Ownership is now
   field by field, using public store side effects and overridden undo/redo actions. A version that stored whole records
   failed on the real server, and only the field-wise version passed (`decisions.md` V1).
8. **The restore clock shift (risk 8.5).** A room restored from an older save could leave a reconnecting window **permanently
   out of sync with no error**. Every load now shifts the room's clock forward (`snapshotForRestore`). Every returning client
   then reloads in full and pushes its unconfirmed edits again (`spike-host.md` 4, O3, `restore.ts`).
9. **tldraw's solo mode.** A sync client that sees no one else's presence runs at 1 fps, so a lone window saw the agent's
   changes about 800 ms late. The window now always runs `presenceMode: 'full'`, and the agent's changes show in about 35 ms
   (`spike-host.md` 7, O2).
10. **A race in `room.updateStore`.** It awaits its updater before writing. A window's push that arrived in that gap would be
    overwritten by the room editor's older copy. The agent now writes with `room.storage.transaction`, which commits inside
    the call and broadcasts one patch (H-7).
11. **The agent's defaults.** `createShapes` fills any style the agent leaves out from the editor's next-shape style. Because of
    that, the agent's stickies came out in tldraw's hand-drawn font. The host's editor now sets the window's next-shape styles,
    and `apply` sets the font on every element (H-9).
12. **An offline delete right after a create** is undone on reconnect. This is tldraw's limit (point 3.4 above). It was **not
    fixed**, because a fix would mean patching tldraw. A release could re-send deletes of records the room still has after a
    reconnect, or accept the behaviour.
13. **CJK and the system font.** The difference comes from PingFang SC's per-size tracking in Chromium (point 3 above). It was
    **not fixed**. There are two cheap ways out (`spike-host.md` 2):
    - ship a CJK font with the board, so the window and the host use the same file. It would be several MB, not measured.
    - scale PingFang runs by the measured table, which corrects macOS only.
14. **The licence gate.** A production bundle on a `file://` page without a key goes blank after 5 s. At first this looked like
    random failures in the research runs. Both bundles are development builds for the prototype (`spike-ui.md`, decisions).
15. **The window's own image export under `connect-src 'none'`.** tldraw fetches the font files to embed them, the fetch is
    blocked, and the text fell back to a system font. The fonts are now given as `data:` URLs (U4, W6).
16. **Conflicts with our own UI**: the voice pill took Space, and the contextual toolbar could sit under the main toolbar. Both
    were fixed (V3).

---

## 5. Departures from goal section 7

From `deviations.md`, plus the decisions that depart from section 7:

| Section | Departure | Why | Source |
|---|---|---|---|
| 7.1 | The board host is a separate package and process, not the headless writer extended. It reuses the writer's config, client and memory-store code, and its Go manager runs as a second instance. | Old boards must not change (goal 4.3), and the two processes have different lives. | `deviations.md`, D3 |
| 7.2 | The sticky is a custom ShapeUtil (`aiwb-sticky`, with its own colour style prop), not tldraw's `note`. This is the fallback 7.2 names. | `note` grows instead of shrinking, sizes itself in private methods, resizes only by scale, and has a fixed look. | `deviations.md`, U3, W1–W3 |
| 7.2 | `geo` is extended with our style props `fillColor` and `labelSize`; the rounded rectangle is a custom geo type. | tldraw's geo has one colour for fill and border, and one style for both label size and border width. | W4, `spike-ui-ctx.md` |
| 7.3 | The select tool overrides go beyond drag-to-pan. The selection is cleared on pointer up, so a pan keeps it. A drag inside a hollow shape moves the shape. A double-click on empty canvas makes a sticky (on the second release). Locked elements can be selected, and a drag on them pans. | Miro's behaviour (goal 3.1, 3.3), all through subclasses of tldraw's states. | `deviations.md`, W9 |
| 7.4 | Each session has its own routes, `POST /api/tl/{id}/open\|sync\|close`, and events `tl_sync`/`tl_closed` sent to that window alone. 7.4 had one `/api/boards/{id}/sync` route and a `sync` event. | An explicit open gives Go a session id and a moment to start the host. A follower event would echo messages back and reach windows that do not show the board. | `deviations.md`, D16 |
| 7.4 | Batching keeps one call in flight per sender, with a gap of at least 25 ms, instead of "every 50 ms". No layer drops presence. | Simpler. A dropped push would leave tldraw's client waiting for an answer. The measured latency shows no need to drop anything. | D6, design 2.4 |
| 7.5 | The agent is neither a persistent sync peer nor a short-lived editor per call. Each room has one room editor that is not a sync peer. An `apply` syncs it to the room by a record diff, runs the ops in one `editor.run`, writes the diff in one `room.storage.transaction` (not `updateStore`), saves, then answers. The marker is a custom message. | A synchronous, atomic `apply` with save-before-answer. The persistent peer's `whenSettled()` reads private fields of `TLSyncClient`. `updateStore` defers its write, so a window's concurrent edit could be overwritten. | `deviations.md`, D11, D15, O1, H-7, H-8 |
| 7.5 | The editor runs on linkedom (jsdom as a fallback that is not shipped), not on a stand-in page. | tldraw needs a real DOM. A stand-in page would have to be a DOM implementation of its own. | O4, H-2, `spike-host.md` 1 |
| 7.5 | Pictures are drawn with text as glyph outlines, then rasterized with resvg, not with embedded or loaded fonts. They are capped at 2000 px by lowering the scale (TOO_LARGE only below a scale of 0.1), with tldraw's 32 px padding (old boards use 16). | No rasterizer outside a browser lays out `<foreignObject>`. Large boards take seconds and memory. The padding matches a window's own export. | O4, H-4, V2 |
| 7.5 | Every room is loaded through `snapshotForRestore`, which shifts the clock forward. Section 7 does not have this step. | Without it, a reconnecting window can diverge silently (risk 8.5). | O3 |
| 7.6 | A `create`'s `ref` is kept on the element as a key (`meta.key`) and can be used in later calls. `read_board` answers in JSON Lines. | Agents need stable names across calls. | `deviations.md`, D10, D13 |
| 7.6 | The design's `TlElement` TypeScript type was repaired: as written, it was `never`. The JSON is unchanged. | Otherwise no element with a colour or size could be typed. | `deviations.md` (T1a) |
| 7.6 | `create_board` takes `kind: "new" \| "classic"` (classic by default). The stored kind is `"tl"`. | Agents say "new"; the storage field stays short and leaves old `board.json` files unchanged. | D7 |
| 7.7 | The board host decides when to save, and Go writes `snapshot.tl.json` on the host's `PUT /api/tl/{id}/snapshot`. Go accepts it only from the current host. | One owner of the board folders, and a dying old host cannot overwrite a new one's save. | `deviations.md`, D8 |
| 1.3 (design) | The bundle's native modules are in `dist/node_modules/`, not `dist/assets/`. Only the build machine's own OS and architecture can be built. | Node then finds them by its own lookup. | H-6 |

Not departures, but worth flagging (goal 7.0):

- **Local undo (V1)** makes goal 3.3 true on top of tldraw's history. Section 7 says nothing about undo.
- **The fonts** are tldraw's own IBM Plex Sans (O5). Goal 9 left this open.
- **There is no feature-level change** (D5). A release has to raise the level, so that older apps and servers can tell.

---

## 6. The risks of goal section 8

| Risk | Status | Answer |
|---|---|---|
| **8.1** tldraw's editor in Node | **answered** | It runs unpatched on linkedom or jsdom, with real text measuring and its own SVG export. The only seams are replacing `editor.textMeasure` and the `fontAssetUrls` option (`spike-host.md` 1). |
| **8.2** Measuring rich text | **answered** | Its own Blink-like line breaking, with the measured ASCII table. Stored sizes are exact for stickies, shapes and fixed-width text. Auto-width text is exact except CJK (section 3). |
| **8.3** Shrink-to-fit on stickies | **answered** | Not possible with tldraw's `note`. Our own ShapeUtil does it and is exact against Chromium (`host-stickyref.md`). |
| **8.4** Sync over a relayed transport | **answered for a local server** | Medians of 27–39 ms between windows and 14–17 ms for agent changes. One call in flight plus a 25 ms gap is enough, and nothing is dropped. **Open:** latency to a remote server, and load with many windows and heavy cursor traffic, were not measured. |
| **8.5** Reconnecting after the board host restarts | **answered, with a fix and two limits** | The risk was real (silent divergence). The clock shift fixes it. **Limits:** an edit the room confirmed but had not saved (at most 1 s) is lost when the host is killed (V4); an offline delete right after a create returns (tldraw's limit). |
| **8.6** Licence | **open** | No blocker in the terms. The price and three answers from sales decide (section 7). |
| **8.7** Text that depends on the machine's fonts | **recorded, not solved** | macOS: Han in PingFang SC is up to 1.7% wider per character in the host, and up to 0.51% wider on auto-width text. Kana, Hangul and emoji are exact. Linux and Windows were not measured. A decision is open: ship a CJK font, or correct for PingFang. |
| **8.8** Size of the board host | **answered, with a caveat** | 149 MB with 1 room and 352 MB with 10 boards, against 120–135 MB for the headless writer. Memory is not given back while the process lives (V4). No leak test was run. |

---

## 7. Licence (goal 4.2)

From `licence.md`. It was checked on 2026-11-08 against `tldraw`, `@tldraw/editor` and `@tldraw/sync-core` 5.6.0, the licence
text, and tldraw.dev.

- **Type.** tldraw's own source-available licence, not open source. Without a key it allows **only development use**. The
  same terms cover `tldraw`, `@tldraw/editor` and `@tldraw/sync-core`.
- **What a release needs.** A **commercial key**. It is the only kind for commercial production use without a watermark. A
  trial lasts 100 days, one per business unit. A hobby key is non-commercial, given at tldraw's discretion, and carries a
  watermark.
- **Cost.** **No public price**: "value-based pricing" and "Talk to sales", with a startup discount. About **$6,000 a year**
  was reported by press and Hacker News when SDK 4.0 launched. That figure is anecdotal and not from tldraw. A quote is needed.
- **Watermark.** None with a commercial key. Development shows a "Get a license for production" link.
- **Without a key in production,** the editor logs an error, sends a tracking ping that carries the page URL, and **goes blank
  after 5 s**.
- **The trap for this app.** The desktop app loads the web export from `file://` as a production bundle. That is
  "production" to tldraw, so it would go blank without a key.
  - **A native key is needed.** A key with the `NATIVE_LICENSE` flag treats its host patterns as regular expressions over
    `location.href`.
  - **Patterns can use lowercase parts only.** tldraw lowercases the pattern but not the address, so a pattern such as
    `^file:///.*/web/index\.html` works and one containing `Resources` never matches (`spike-ui-embed.md`).
  - **The key must not lapse inside installed apps.** An annual key that lapses gives 30 days of grace, then a blank editor.
    So the key must be perpetual, or renewed and shipped before it expires.
- **The headless board host.** No licence check runs there: an `Editor` built directly has no licence manager, and its export
  draws no watermark. sync-core has no licence code at all. **Legally,** though, a server that gives users functionality is a
  production environment, so the commercial licence must cover it.
- **Blockers in the terms: none**, if a commercial licence is bought. The terms allow commercial use, self-hosting, multiplayer,
  a public key embedded in the app, and bundling.
- **Five questions for sales** (`licence.md` 5):
  1. the price;
  2. a native key for the Electron and phone pages;
  3. perpetual or annual, and how installed copies are renewed;
  4. whether one licence covers the self-hosted board host and the sync room;
  5. whether the collaboration feature flag is in the key (a future tldraw version could tie sync to it).
- **The prototype complies.** It counts as development everywhere it runs:
  - the web build over `http://127.0.0.1`;
  - development bundles of `tl.js` and `boardhost.mjs`.

  Nothing removes the watermark or touches the licence check.

---

## 8. Old boards untouched (goal 6.7)

The orchestrator ran these on the final branch:

| Check | Result |
|---|---|
| `go test ./...` | all ok |
| Root `npm test` | exit 0 |
| Root `npm run check` | exit 0 |
| `cd web && npm test` | exit 0 |
| `node web/e2e/away.e2e.mjs` (an agent on old boards with no window, then a window as a reader) | passed, 27 checks |
| `node web/e2e/readers.e2e.mjs` (writer, readers, **Edit here**, the headless writer) | 70 checks passed, 0 failed |

- **The lanes' own runs.** They also ran `AIWB_TEST_FULL=1` for every Go package they changed, and `-race` where goroutines
  share state. That covers `internal/editorbridge`, `internal/headless` and `internal/tlrelay`, which are design 9's checks.
  The Go lane's run report (to the orchestrator) gives the results: all passed. `-race` on `editorbridge`, `tlrelay`,
  `headless`, `boardapi`, `app` and `server`; `AIWB_TEST_FULL=1` on `model`, `store`, `boards`, `server`, `editorbridge`,
  `headless`, `tlrelay`, `boardapi`, `boardtools`, `app`, `chats`, `pi` and `cmd/ai-whiteboard` (26 s); `cd packages/conn &&
  npm test` 205 passed.
- **Load failures.** No failure caused by load was recorded in the notes.
- **How old boards are kept apart.** Old boards' code paths did not change:
  - The old routes `scene` and `take` refuse a tl board with `409 tl_board` (D18).
  - Old `board.json` files are not rewritten, because `kind` is `omitempty` (D7).
  - The headless writer runs unchanged beside the board host (D3).

---

## 9. Remote servers in principle (goal 6.8)

**Nothing in the design rules remote servers out.**

- **The windows.** A window reaches a new board only through its transport: calls and stream events on the existing pinned
  HTTP/2 connection (goal 4.6). That transport already reaches remote servers.
- **Go.** Go relays the sync messages as opaque strings and never parses them (goal 4.7).
- **The board host.** It is a client of the server's own client API, with its own client id and event stream, as the headless
  writer is. It runs on the server's machine wherever that is.

What a remote server would need:

- **Node and the board host bundle on that machine.**
  - The bundle has to be built for that machine's OS and architecture, because of skia-canvas and resvg's native binaries
    (H-6). Today only the build machine's own target builds.
  - `build-server.sh` would have to ship the bundle with the server, as it ships the headless writer's.
- **The fonts.** The 16 tldraw woff2 files ship inside the bundle (`dist/assets/fonts/`), so Latin, Cyrillic and other text in
  IBM Plex measures the same anywhere. **CJK and emoji come from the system's fonts.** On a remote Linux server the host would
  measure them with that server's fonts, while each person's window measures with their own machine's. The difference of
  risk 8.7 would then be between machines, not only between Chromium and skia. The generic families and the serif fallback
  per script are set for macOS only (`spike-host.md` 6.8). Shipping a CJK font removes most of this.
- **The licence.** It must cover a self-hosted server (`licence.md` 4). "Host anywhere" is listed on the pricing page; it
  needs confirming in writing.
- **Latency.** Every sync message makes one more hop over the network. It was measured only on a local server.

---

## 10. What a real build needs beyond the prototype

Sizes are rough estimates by this report, not measurements: **S** = days, **M** = 1–3 weeks, **L** = a month or more, for one
person.

| # | Work | Size | Notes |
|---|---|---|---|
| 1 | **Licence**: buy the key; get native key patterns for the Electron `file://` page and the phone's page; settle perpetual vs annual and how installed copies are renewed; confirm the server is covered | S engineering, procurement unknown | Decides everything else (sections 7 and 11). |
| 2 | **Production bundles with the key**: `tl.js` and `boardhost.mjs` built with `NODE_ENV=production` and the key, then the faithfulness harness re-run on them | S | The spike and the prototype measured only the development React build (`spike-host.md` 6.8). |
| 3 | **Package the board host** into the desktop app and `build-server.sh`: an `extraResources` entry like `headless/`, native modules for each OS and architecture (cross builds or CI per platform), and the manifest version check | M | Out of scope for the prototype (design 1.3, H-6). |
| 4 | **Font measuring on Linux and Windows**: generic families, the serif fallback per script, emoji; the corpus re-run against Chromium on each | M | Not measured (`spike-host.md` 2, 6.8). |
| 5 | **The CJK font decision**: ship a CJK font with the board (same file in the window and the host; several MB, size not measured) or apply the macOS PingFang correction | S–M | Risk 8.7, V4 item 1. |
| 6 | **Memory**: a leak test over long sessions; restart or recycle a long-busy host; resvg's native memory | S–M | V4 item 2. The quiet-time stop already returns memory on an idle host. |
| 7 | **tldraw upgrade process**: make the faithfulness harness a committed, re-runnable tool; re-check the list of tldraw internals relied on (below) on every upgrade | M once, then S per upgrade | Harness: the corpus and pictures against Chromium, against jsdom as well, and the ASCII break table regenerated (`spike-host.md` 6.1, 6.4). |
| 8 | **Schema migrations and versions**: windows and rooms on different schema versions (shared model changes, tldraw upgrades); raise the feature level (D5); handle `CLIENT_TOO_OLD` cleanly | M | W8: a rejection that repeats stops after 3 tries, while the link keeps reopening empty sessions (`win-view.md` T3). |
| 9 | **Large boards**: measure apply, sync and pictures on boards of thousands of elements; review the message limits; check the full reload of every window after a host restart | M | Limits: sync 32 MiB, snapshot 128 MiB (design 2.2). Largest tried: a 400-op apply and 377 corpus elements (`verify.md`). |
| 10 | **Data-loss hardening**: shorten or remove the confirmed-but-unsaved window (1 s throttle); decide on re-sending offline deletes after a reconnect | S–M | V4 item 3; tldraw's limit in point 12 of section 4. |
| 11 | **Phones and WebKit**: the one-file page in a web view, a WebKit run, iOS gestures (double-tap zoom, long press), device tests; the native app currently shows "New boards are not available on this device yet" | L | The one-file build was shown in the spike (`spike-ui-embed.md` 3). WebKit was never run. |
| 12 | **The final board in Electron**: run it in the desktop window, including Electron's clipboard and the watermark link | S | Only the spike's board ran in Electron (`spike-ui-embed.md` 1). |
| 13 | **Committed checks** at the repository's level: browser checks (`uicheck`) for the new board, a few free e2e scripts (multiplayer, headless agent, host kill), the harness from row 7 | M | The prototype committed none, by the user's rules (section 1). |
| 14 | **Product gaps**: images, a context menu (today the browser's own menu opens on right-click), the dark theme, quiet times tuned from use, `get_view`/`show_board` run end to end, and how agents get on with the JSON-lines `read_board` | M–L | Goal 5 left most of these out on purpose. |
| 15 | **Converting old boards** from Excalidraw to tldraw, and retiring Excalidraw | L | Out of scope (goal 5). Needs its own goal. |
| 16 | **Docs**: `docs/architecture.md` for the board host, the relay and the new routes | S | Goal 5. |

**tldraw internals the prototype relies on.** None of them is a patch, but each must be re-checked on an upgrade:

- **The select tool's child states.** It uses their ids and their hooks (`onEnter`, `onPointerMove`, `onPointerUp`,
  `onDoubleClick`) through subclasses of classes found by id. The base methods are called through `prototype as any`
  (`navigation.ts`; `spike-ui.md` C).
- **The connector tool's `pointing` state**, replaced the same way (`navigation.ts`).
- **`hideUi`** keeps the shortcuts and the clipboard working without tldraw's UI. An asset URL of `""` makes tldraw skip that
  asset (`spike-ui.md` 11).
- **`onBeforeSendMessage`'s `message` argument**, which tldraw marks internal in its types (`rooms.ts`).
- **The room snapshot's clock fields** (`documentClock`, `tombstoneHistoryStartsAtClock`), rewritten by `snapshotForRestore`.
- **tldraw's undo and redo actions**, overridden, and the history's record-level behaviour that local undo corrects (V1).
- **The sync client's rebase buffer**, which explains the offline-delete limit.
- **Blink's ASCII line-break table** and the Chromium version the reference was measured against.
- **The licence rules** of `LicenseManager`.

---

## 11. Recommendation

**Go on this way, once tldraw's licence terms are known and acceptable.**

Reasons to go on:

- **Every part of goal section 3 was shown** on a real server and the real web build, except images, which were optional.
- **The parts the proof rests on are solid** (goal 4.12):
  - the transport carries multiplayer with tens of milliseconds of latency and no socket in the page;
  - the board host's measuring and pictures match Chromium within the goal's bars, except CJK system-font text on macOS;
  - every agent call goes to the board host, which the server's counters show.
- **tldraw was used as installed.** All the custom behaviour sits on its extension points: shape utils, tools as states,
  `components`, store side effects, `TLSocketRoom`.
- **The architecture stays inside this codebase's rules.** Go stores, routes and relays; the page opens no socket; the server
  starts the board host as it starts the headless writer.
- **Old boards are untouched.**
- **The board host is cheap to run.** It starts in under 0.2 s and uses 150–350 MB.
- **What is left is known work** (section 10), with no unknown of the size 8.1–8.5 were.

Reasons for care:

- **The licence decides.** There is no public price, and the commercial terms for a desktop app with a `file://` page, a phone
  app and a self-hosted server have to be agreed with sales. Ask the five questions of section 7 before spending more on
  engineering.
- **The prototype leans on tldraw internals** (section 10). That makes the upgrade harness of row 7 a must, not a nice-to-have.
- **Memory and CJK are open, but bounded and understood.**

**If the licence is unacceptable, change course.** Do not simply stop.

- **What carries over to another drawing library:**
  - the relay over the transport (`internal/tlrelay`, core's `TlLink`);
  - the board host process and its lifecycle under `internal/headless`;
  - agent routing by board kind;
  - storage by kind;
  - the agent terms;
  - the Blink-faithful measuring approach and the glyph-outline pictures.
- **What would have to be redone:** the window's UI, the shared model, and the sync protocol layer, because those are
  tldraw-specific.

---

## 12. Where things are

| What | Where |
|---|---|
| The window's board (our UI, sync client, local undo) and the shared model | `packages/board-tl/src/view/`, `packages/board-tl/src/model/` |
| The board host (rooms, agent tools, Node runtime, measuring, pictures, bundle) | `packages/board-host/src/`, `packages/board-host/build.mjs` |
| The relay, sessions, agent calls to the host, status | `internal/tlrelay/` |
| Routing by kind, tool texts | `internal/boardapi/`, `internal/boardtools/` |
| The app side (board screen branch, New board tile, mark, mount) | `app/src/screens/board/TlCanvas.tsx`, `app/src/platform/tlboard.*.tsx`, `app/public/tl/` |
| The spikes (research code, harness scripts) | `spikes/tl-host/`, `spikes/tl-ui/` |
| Notes | `plans/better-board/`: `design.md`, `decisions.md`, `deviations.md`, `licence.md`, `spike-host.md`, `spike-ui*.md`, `win-view.md`, `host-lane.md`, `host-h0.md`, `host-stickyref.md`, `verify.md` |
| Screenshots | `plans/better-board/shots/` |

How to run it: `cd packages/board-host && npm run build`. Then start a server with
`-boardhost-dir packages/board-host/dist -boardhost-node "$(command -v node)"`, and in the app create a board with the tile
**New board** (`host-lane.md`, `win-view.md` A1).
