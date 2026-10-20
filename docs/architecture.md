# Architecture

How AI Whiteboard fits together: the server, the app on its four targets (the desktop window, iPhone, iPad and Android), who changes a board (readers, the writer, the button and the headless writer), the board engine in Node, how the app reaches every server, the MCP listener and the board tools the agents get, the subagent settings, `get_image`, images in a message, and how pi is run.

- **Server** (`cmd/`, `internal/`): a Go program. It stores boards and chats,
  runs the agent processes and gives them board tools (`list_boards`, `read_board`, `get_view`,
  `get_image`, `apply`, `delete_elements`, `create_board`, `show_board`). Claude, Cursor and pi get these over
  MCP: one fixed MCP endpoint, `http://localhost:6006/mcp`, carries the chat's token in
  the `Authorization` header (every chat). The spawn family (`spawn_subagent`, `stop_subagent`,
  `list_subagent_models`) is on every chat and replaces native Agent / Task / subagent on app chats;
  `list_subagent_models` tells an agent which `model` and `effort` values `spawn_subagent` accepts
  for each agent. An agent does not wait for a subagent or fetch its result: it ends its turn, and
  when the subagent finishes the app sends the result to the agent as a message, in a turn of its
  own once the agent is idle, or with the user's next message after a stop or a failed turn.
  A chat has two subagent settings, fixed at its first message. Its **depth** says how many
  levels of subagents it may have: off (the agent has no spawn family), 1 (its subagents start
  none, the default), 2 or 3 (a subagent may start subagents, down to that level; the subagents
  at the deepest level have no spawn family). Its **cap** is the most subagents of the chat that
  may run at once, at every level (100 by default): a spawn over it is refused, never queued.
  Each branch of a chat counts its own: what runs on another branch does not count. A
  subagent that started subagents is not finished when its turn ends: it waits, still running,
  gets their results as messages that start further turns of it, and reports to whoever started
  it only after a turn that ends with none of them running. A result that cannot be given to a
  waiting subagent fails it. A subagent stops only the subagents it started, stopping one stops
  everything below it, and what a subagent's spawn does not name (agent, model, effort) is taken
  from that subagent. For pi
  the token travels only inside `AIWB_MCP_CONFIG` (never in argv or a URL); app-spawned subagents get
  their own extra token. The owner-only UDS bridge carries a per-run, non-secret handle for permission
  asks, subagent activity, abort and MCP failure notices. pi tool
  calls are auto-approved: they run with no permission card, and only a tool that touches the app's
  own folder is refused. That guard reads the text of the tool's input, so it stops accidental
  access by a command that names the folder. It is not a sandbox: a shell command that reaches the
  folder without naming it (a glob, a variable, a symlink, a search from a parent folder) is not
  stopped. Cursor reaches the same endpoint from its ACP session, keeps one
  first-message instructions block with the same whiteboard prompt as Claude and pi, and its board calls are
  auto-approved too (no permission card). Plain (non-board) chats get no board tools. The server never changes a
  drawing itself: a client does, the one that is the board's writer ([Who changes a board](#who-changes-a-board)).
- **The app** (`app/`, with the packages in `packages/`): one React Native codebase (Expo) for four
  targets: iOS, iPadOS, Android and the desktop. A screen is written once; what differs by platform
  is a port with a file per platform (`app/src/platform/*.web.ts`, `*.native.ts`) or a layout (the
  window's width picks a phone, a tablet or a desktop layout: under 700 points the sidebar and the
  chat are screens one after the other, from 700 they are side by side). The shared code is in
  packages: `@aiwb/core` (the app's logic, store and transport interface, with no screen in it),
  `@aiwb/conn` (the connection to the servers, [below](#how-the-app-reaches-the-servers)),
  `@aiwb/board-bridge` (the typed messages between the app and the board) and `@aiwb/board-view`
  (Excalidraw behind that bridge). Two more packages are not part of the app: `@aiwb/headless`, the
  headless writer ([below](#the-headless-writer)), and `@aiwb/board-engine`, the board view's code
  in Node ([below](#the-board-engine-in-node)). The **web build** (`cd app && npm run build:web` →
  `app/dist-web`) is what the desktop app shows; no server serves it. The board is Excalidraw in
  the page itself on the web build, and in a web view on a phone or tablet, so Excalidraw is
  the one place the board is drawn in.
- **The canvas follows the theme as a view of the board, never as a change of it.** The board file
  holds the colours Excalidraw draws by default (a white ground, a `#1e1e1e` stroke) whatever the
  theme, because agents read it, the image export draws it and other windows show it. A theme is
  an SVG filter (`packages/board-view/src/CanvasFilters.tsx`, made by `packages/core/src/logic/canvastheme.ts`) that replaces
  Excalidraw's own dark-mode `--theme-filter`: it puts the theme's ground where the stored white
  lands and the theme's ink where the stored default stroke lands. Excalidraw has no prop for the
  colour quick picks of its properties panel and its code is not patched, so they stay Excalidraw's
  own in every theme; they are drawn with `filter: var(--theme-filter)`, so they show as the theme's
  versions of its colours.
- **Desktop app** (`desktop/`): an Electron app, the client of every server. Its main process holds
  the server list and the secrets and keeps one connection to each server, this computer's
  included; its window shows the web build. The app starts this computer's server, or finds the one
  already running. Quitting the app doesn't stop the server or its running chats.
- **The phone and tablet app** (iOS, iPadOS, Android): the same app with native screens. It has no
  main process and no this-computer server: the app itself holds the list of servers (the secrets
  in the device's secure storage, the Keychain or the Keystore) and keeps the connections, through
  a small native module (`app/modules/aiwb-net`) that does what only the platform can: it trusts a
  server's certificate by its fingerprint and by nothing else, and speaks HTTP/2 through the
  system's stack. Everything the app decides is in `@aiwb/conn` and `@aiwb/core`, the same code as
  the desktop's.
- **Install and tests of the phone and tablet app.** One script builds the app from the current
  code and installs it on a device ([Build and develop](development.md#install-the-app-on-a-phone-or-tablet)).
  What a browser cannot show is tested on the iOS simulator and the Android emulator, with flows
  run by Maestro (`app/e2e/`); the rest is tested in the browser on the web build, at three
  viewports (a desktop, a tablet and a phone).

## The server's listeners

A server has two listeners and one socket.

- **The client listener** is HTTPS on every IPv4 address of the machine, on the port of the set-up
  (4748 at first). It is the one listener for every client, the app on the same machine
  included, and it serves the **client API**: one set of routes, each behind the server's secret in
  the header `X-AIWB-Secret`, with the app's id in `X-AIWB-Client` and its feature level in
  `X-AIWB-Level`. The one call answered without the secret is `GET /api/hello`, the first question
  of a client (which server this is and what it offers). The listener accepts the names of the
  set-up in the `Host` header, and `127.0.0.1` and `localhost`. It serves no page, keeps no server
  list and connects to no other server: a path that is no route is 404, or 401 without the secret.
- **The MCP listener** is below.
- **The control socket** is an owner-only Unix socket in the data folder (`control.sock`). It
  answers the server program's own commands on the same machine (`status`, `stop`, `launch`, and
  the others in [Server commands and flags](server-reference.md)) and is no listener on the
  network and no part of the client API.

A server that was never set up (see [Server commands and flags](server-reference.md)) refuses to
start. Port 4747, where an earlier build served its own page, is gone.

## Who changes a board

A board has one **writer** at any moment, and any number of **readers**. The writer is the one client
that may change the board; a reader shows it, read-only, and follows the writer's changes live. The
server keeps who the writer is (in memory, never on disk) and refuses every write that is not from the
writer or that is based on an older revision than the stored one: `PUT /api/boards/{id}/scene` answers
409 `not_holder` or 409 `stale`. The board file, its format and its stored colours are the same whoever
writes.

- **Readers follow.** A window follows a board while the board is on its screen: it calls
  `POST /api/boards/{id}/follow` when the board appears and `…/unfollow` when it leaves (and follows
  again after each new stream). The answer carries the stored revision and the writer. After that the
  server sends the follower two events: `scene` (`{board, rev}`) after every accepted save, and `writer`
  (`{board, writer}`) whenever the writer changes. `writer` is `window`, `headless` or an empty string for
  nobody; the id of a client is never sent to another client. A `scene` event carries the revision and
  not the drawing: the reader reads the scene again and the board view replaces the elements in place,
  keeping the reader's own scroll and zoom. Following never delays the writer, and a reader keeps no
  change of its own: a paste or a drop in a reader's view is never kept or written.
- **The button.** Over the canvas of every board a bar says what this window is, and a reader has the
  button **Edit here**: "View only.", "View only. Another window is editing this board.", "View only. An
  agent is editing this board.", or, for a window that lost the board, "Another window took over this
  board. View only."; the writer shows a small "Editing" mark. Pressing the button is the only way a
  window becomes the writer. Opening a board, switching to it, connecting, or an agent's call never takes
  it. The one exception is a board the window has just made: the window that made a board is its writer.
- **The hand-off.** A press on a board nobody holds makes the window the writer at once. A press on a
  held board asks the writer to save and let go (`release_request`); it saves, answers with
  `POST /api/boards/{id}/release`, and the pressing window gets the board at the revision after that
  save, so nothing the old writer drew is lost and nothing is overwritten by an older version. The old
  writer is told at once that it is a reader now (`superseded`, and `writer` to the windows that show
  the board). If it does not answer within 10 seconds, it loses the board anyway and its later saves are
  refused. Two presses together: the last one wins and the other window stays a reader.
- **A writer that lost its network** does not get the board back by itself, and neither does any window
  after the server restarts: it returns as a reader, and the button is the way back. A change it made
  while it was cut off stays in the window: the button saves it if the board is still at the revision the
  change was made on, and a newer revision drops it, with a note.
- **Agent calls.** A board tool (`read_board`, `apply`, `delete_elements`, `get_image`) goes to the
  writer of the board, a window or the headless writer, as an `rpc` event, and the writer answers it with
  `POST /api/rpc-reply`. A window answers only for a board it holds; an agent's call never makes a
  window the writer. When nobody holds the board, the call goes to the headless writer, which the server
  starts for it (below). `list_boards` and `create_board` are answered by the server itself: a new board
  has no writer until a call needs one. `get_view` and `show_board` need a person's screen: they go to a
  window that shows the chat's board, a reader included, else the window that holds it, never to the
  headless writer, and when no window shows it the agent is told so in plain words, which is no failure of the board. A call cut by a
  hand-off, an archive or a delete of its board fails with a text of its own (the board was taken over in
  a window while the call ran; the earlier changes are saved).
- **A call that gets no answer.** A board call given to a window that holds the board and does not
  answer within the call time (30 seconds) is not left to fail again and again. The window loses the
  board the way a writer that does not release in a hand-off loses it: it is told at once that it is a
  reader now (`superseded`), its other open calls on that board end, and the windows that show the board
  get one `writer` event. A window waiting for the board (someone pressed **Edit here**) gets it as in a
  hand-off; otherwise the board has no writer. The board is as it was after its last saved change, and a
  late answer or a late save from that window is refused. A call that only reads (`read_board`,
  `get_image`) is then given again, in the same call of the agent, with the headless writer allowed: it
  starts if it must, answers, and the agent gets its answer late and is not told of the window. Where the
  headless writer cannot run, the second try ends as any call with no client does; it is the last one, and a
  window that took the board meanwhile and does not answer it either loses the board too. A call that changes
  the board (`apply`, `delete_elements`) is not repeated, because the window may have made
  the change and saved it before it went silent: the agent is told that the call did not finish, that the
  window no longer holds the board, and to read the board again before it changes it. The next call of
  the chat on that board goes to the headless writer, or to a window that took the board, with no wait.
  `get_view` and `show_board` free nothing and never go to the headless writer. This is not a way to
  find a dead connection sooner: a window that is gone costs an agent one late or failed call, not one
  for each call until the connection is found dead. A call to the headless writer that does not answer is
  as before ([Failure](#the-headless-writer)).
- **Feature level 7.** Both ends need these rules: a server reports 7 and the app connects to no server
  below 7, this computer's included (see [A server that is too old](remote-servers.md#a-server-that-is-too-old)).

### The headless writer

When an agent works on a board and no window holds it, the **headless writer** holds it. It is a
Node process on the server's machine that does what a window does for an agent's board call, with no
screen: it runs the app's board side (`@aiwb/core`) and the app's board engine in Node, so the same
`apply` call gives the same result whichever answers it. It is a client of the client API like a window
(`packages/headless`, started and watched by `internal/headless`): the server's secret, a client id of its
own made for each start, and the same level; it is no way in without them. The server still does not edit
a scene itself.

- **When it starts.** Only when an agent's board call needs a board that no window holds. Nothing is
  looked up or started at boot, and with no agent working away it is not running and uses no memory.
  The server finds the program and the bundle at the first such call (and again after a failed start has
  been remembered), starts the process, gives it its address, the certificate's fingerprint, the secret
  and its client id as one line on its stdin (not in argv or the environment), and waits for its stream to
  open, at most 20 seconds. The process opens its stream only after its engine is ready.
- **What it holds.** Only a board the server gave it for an agent's call. It never takes a board a
  window holds, and when the last window leaves a board it does not take over the boards that were open.
  Its changes appear live in the windows that show the board, which are readers, and the button is
  offered.
- **What it answers.** `read_board`, `apply`, `delete_elements` and `get_image` for `all`, `refs` and
  `rect`. `get_image` with `scope: selection`, `get_view` and `show_board` need a screen: the agent is
  told that no window shows the board, in plain words, and that the board itself can be read and changed
  as usual.
- **Saving.** It saves after each finished `apply` or `delete_elements`, before it answers the agent, so
  an agent that was told a change is done finds it in the board file. If the save fails, the agent is
  told the change was made but not saved.
- **Quiet time.** After an agent's last call on a board it keeps the board for a quiet time (1 minute;
  `-headless-quiet`), so the next call of a chat does not pay for a reload, then saves and lets it go.
  When it holds no board and has no call open at two looks in a row, 5 seconds apart, the server stops
  the process.
- **Yielding.** When a person presses **Edit here**, the headless writer is asked to release like any
  writer. It starts no new call on that board (the agent is told to call again in a moment, and the
  window answers), waits for the call in progress for at most 8 seconds of the 10, saves and releases. The
  person becomes the writer.
- **Failure.** If it stops in the middle of a call, the board is as it was after the last finished
  change, it has no writer, and the agent is told that the background editor stopped and to read the
  board again before it changes it. A call that does not answer in 30 seconds makes the server kill the
  process, with the same result. A failed start is remembered for 60 seconds: calls in that time fail at
  once, and the server log has one line with the reason.
- **Where Node comes from.** The first that exists: the program of `-headless-node` (or
  `AIWB_HEADLESS_NODE`); the desktop app's own Electron, when the server runs from inside the Mac app,
  started as Node; `node` of version 22 or later on the server's `PATH`. A Mac app needs no Node of its own.
- **Where the bundle comes from.** The bundle is a folder with the writer's program (`headless.mjs`), its
  `manifest.json` and `engine/`, the board engine's files ([below](#the-board-engine-in-node)). It is
  built with the server, and the server finds it in the folder of `-headless-dir`, else in
  `Resources/headless/` of the Mac app (outside `app.asar`, since a native module cannot load from
  inside it), else in `headless/` beside the server program, which is how a server folder made by
  `scripts/build-server.sh` has it. The manifest names the version of the build, and a bundle of another
  version than the server is not used; a development build of the server (version `dev`) takes any.
  The bundle is for one operating system and one processor, the server's.
- **If it is not there.** If no Node or no bundle is found, the headless writer is
  unavailable: the server works as before and an agent is told that no board is open (or, when a
  window is connected, that nobody is editing the board and the person can press **Edit here**).
  `ai-whiteboard status` says whether it is available and why not
  ([Server commands and flags](server-reference.md)).

## The board engine in Node

The headless writer must do to a board what a window does: create and change elements, fit text in
its box, route arrows, draw a picture. That is Excalidraw's code, and the app already has it behind the
board bridge (`@aiwb/board-view`), so the headless writer has no engine of its own: it runs the board
view's code in Node, with no screen, and a call gives the same result whichever answers it.

- **What runs where.** The requests on a given list of elements (`restore`, `apply`, `delete`,
  `export`) are one body of code, `packages/board-view/src/engine.ts` with `apply.ts`, `export.ts`,
  `imagesize.ts`, `faces.ts` and `indices.ts`. The app's board view runs it on the board that is on screen
  and for a board that is not (on a phone in a hidden web view when no board is shown), and the headless
  writer runs it in Node. `packages/board-engine` (`@aiwb/board-engine`) is the Node host of that code
  and has none of its own: the stand-in page, the fonts, the canvas, the bundle and its tests. What
  needs a screen (`snapshot`, anything on the board on screen) is answered "no board is shown", as a
  board view with no board does. The engine keeps nothing between two requests: the board side
  (`@aiwb/core`) keeps the scene and sends it with each one.
- **The bundle.** `node build.mjs` in `packages/board-engine` makes `engine.mjs` (about 4 MB) with
  Excalidraw inside, built with the board view's own settings and from the same lockfile, so both carry
  the same Excalidraw. The server's build puts it, with the fonts and the canvas, in `engine/` of the
  headless bundle, and the headless writer loads it from there when it starts. It is ready 70 to 100 ms
  later and the process holds about 120 to 135 MB; an `apply` takes under 10 ms and a picture 15 to 50 ms.
  Excalidraw's fonts are the files the window ships (without Xiaolai, the Chinese hand font).
- **The stand-in page.** Excalidraw expects a browser. `src/page.ts` supplies the little of one that its
  element code and its export reach for: `window`, `document` with `createElement` for canvases and
  images, `document.fonts` and `FontFace`, `FileReader`, `Image`, `Path2D`, `DOMMatrix`, `ImageData`
  and a few more. It is installed before Excalidraw is evaluated, because Excalidraw makes images and
  fonts as it loads. Nothing of Excalidraw is patched.
- **The canvas.** Drawing and measuring use skia-canvas, a native module built on Skia, which is what Chromium
  draws with too. It finds the system's fonts the way a browser does, needs no system libraries and no
  install step, and has a binary for each target (macOS arm64 and x64, Linux arm64 and x64 with glibc),
  28 to 38 MB each. It is the one native file of the bundle, `engine/node_modules/skia-canvas/lib/skia.node`.
  The server build for another target than the build machine's fetches that target's binary from npm
  (`@skia-canvas/<os>-<arch>`) and checks that it is a library of that system and processor, so it needs
  the registry (or npm's cache) at build time; a target whose binary can't be had fails the build.
- **Text is measured with real fonts.** A browser picks, for each character, the piece of the font
  whose `unicode-range` has it, then the next family, then its default font, then the system's. The
  stand-in does the same: it keeps every piece Excalidraw declares and cuts each text into runs of one
  face, at the word boundaries Blink shapes by, before the canvas measures or draws it. So text in
  Excalidraw's own fonts has the same width as in a window: on the harness's corpus, exactly, for Latin,
  accented Latin, Vietnamese, Cyrillic and Greek, in all eight families at all four sizes. Heights come from
  Excalidraw's own metrics and are always equal. Text in other scripts (Chinese, Japanese, Korean, emoji,
  Arabic, Hebrew, the Indic scripts, Thai) is in the system's fonts, in a window too, so there it follows
  the machine: a window on Windows and a window on a Mac already store different sizes for it. The headless
  writer measures it with the fonts of the server's machine. On macOS that matches a window, except that
  Han and kana text is about 0.2% wider at 20 px (up to 1.3% at 36 px) because Chromium and Skia apply the
  system's letter spacing differently. On Linux it follows fontconfig, and a machine with no CJK or emoji
  font measures those characters as missing glyphs: install **Noto Sans CJK** and **Noto Color Emoji**
  there ([the server's README](../scripts/remote/README.md)). Linux has not been measured against a
  browser yet; the Mac is.
- **Two fixes in the window.** Comparing the window with the engine showed two things in which a window
  disagreed with itself, and they are fixed in the board view's code, so they hold in a window as well.
  First, a page measured an agent's text before it had loaded the font piece for it, so a Cyrillic label in
  Nunito could be stored 320.83 px wide instead of 353.26 and stay so: `apply` and `delete` now load the faces
  their text needs first (`faces.ts`; in Node there is nothing to wait for). Second, the elements an `apply`
  added to a board that has elements got fractional indices below those before them, which only the screen
  repaired, so the same call stored a different `index` and `version` on screen and off it: `apply` now gives
  what it adds valid indices (`indices.ts`).
- **The faithfulness harness.** `cd packages/board-engine && npm run faithful` sends the same requests to
  the board view's web build in Chromium and to the Node engine, on given elements, on the board on
  screen, and in a page that has shown no board, and compares the elements (all but ids and seeds), the
  replies, and the pictures (size and bounds, and the share of pixels that differ by more than a
  quarter of a channel, which may be at most 1%), then the widths of a text corpus. It exits non-zero on a
  difference outside its short list of known ones (CJK and Cascadia on macOS, each with the reason). It
  needs Playwright ([`AGENTS.md`](../AGENTS.md)). What differs in the pictures is the anti-aliased edge
  of text and strokes; no shape is displaced.

## How the app reaches the servers

On the desktop the page talks to the app's main process and to nothing else; on a phone or tablet
the app's native module takes the main process's place (see the list above), and everything else
in this section holds for both. The connection code keeps one
connection per entry of the server list, and **this computer's server is one of the entries**:
the first, with the id `local` and the name "This computer", which is never in the list's file
and cannot be edited. Each connection is HTTP/2 over TLS with the server's secret, to a
certificate that is accepted by its fingerprint and by nothing else, this computer's included.
No secret reaches the page.

- **The transport** (`packages/core/src/transport/`) is the one interface the page has to the network. It
  has a call (a server by its entry's id, a method, a path of the client API, a body, and a way to
  cancel it), a stream (a function for each event and one for a change of the stream's state) and
  the address of a picture. The server is an argument and no part of the path. In the desktop app
  the transport is made over IPC: the window gives the page a fixed set of functions
  (`window.aiwbTransport`, `desktop/preload.js`; the page makes its `Transport` of them with
  `packages/core/src/transport/desktop.ts`) and the main process answers them. On a phone or tablet
  the transport is native and in-process (`app/src/platform/nativetransport.ts`). One stream carries
  the events of every server, each with its entry's id. A stream that is closed for good is an
  event of the transport, and the page opens it again.
- **The connection module** (`packages/conn/`, `@aiwb/conn`) has no Electron and no native code in it. It holds the
  server list and the secrets, makes the pinned connections and keeps a stream per server with its
  retries. A refused secret ends the trying until the entry changes; a stream that is silent for
  35 seconds counts as ended. Its `core/` is platform-free and takes three ports from the platform:
  the Connector and the Session (a pinned TLS connection and HTTP/2 on it), the Store (the server
  list and the client id) and, on the desktop only, this computer's server. `node/` holds the Node
  ports (`createNodeClient`, from `@aiwb/conn/node`), which the desktop app's main process and the
  test host use; the phone and tablet app gives the same core the ports of its native module and
  of the device's secure storage, and runs it inside Hermes.
- **What the app keeps.** On the desktop, in `~/Library/Application Support/AI Whiteboard/client/`:
  `servers.json`, the server list with the secrets (mode 0600, the folder 0700; no keychain), and
  `client-id`, the app's id. On a phone or tablet the list and the secrets are in the device's
  secure storage (they never leave it except to be sent to their server). Of a server's content
  the app keeps nothing.
- **This computer's server.** While the window is open the app finds the server or starts it, by
  running the server program it carries: `launch -json` prints the address and the certificate's
  fingerprint, `secret` the secret. The user types and accepts nothing for this computer. The
  server is not a child of the app and outlives it. Until it answers, the section says that it is
  connecting; a start that fails (a server never set up refuses to start, and the reason names the
  set-up command) shows in the section with the reason, **Retry** and **Open server log**, and the
  app tries again by itself at growing intervals (1, 2, 5, 10 and 30 seconds). A server that stops
  while the app is open is started again, and its section goes to not connected and back with
  the page not loaded again. A server of another build than the app carries is found and kept:
  the section says so and offers **Restart server**. Restarting it, opening its log and reading
  the state of its MCP listener are the owner's things: the app does them itself with the server
  program, and they are no part of the client API.
- **Pictures.** An image of a chat is shown from an address of the app's own URL scheme,
  `aiwb-picture://p/<entry id>/<chat id>/<image id>`. The main process answers it by fetching the
  image over the pinned connection with the secret and looking at its bytes: it is one of the
  image types a message takes (PNG, JPEG, GIF, WebP), at most 5 MB, whatever type the server
  claimed. Anything else is not shown, so no server can have the app show HTML or SVG of its
  making. The scheme answers pictures for the app's own page and for nothing else. At most 8
  pictures are fetched at a time per server.
- **Only the app's own page is answered.** A request to the main process from another window, a
  frame inside the page or a page that has gone elsewhere is refused, and a call names a server of
  the list and a path of the client API and nothing else.
- **Tests and development.** The web build runs in a headless browser for tests, through a test
  host (`web/dev/host.mjs`) that does what the main process does: it holds the server list, makes
  the pinned connections and serves the page's calls, one stream and the pictures over plain HTTP
  on `127.0.0.1`. The transport is then made over HTTP. The host is never shipped and no server
  serves it. A mock (`web/dev/mock.mjs`) stands behind the same face for the browser checks. See
  [Build and develop](development.md).

The **MCP listener** is a second loopback listener on `127.0.0.1:6006` inside the same server
process. It advertises exactly `http://localhost:6006/mcp` for every agent. That spelling is
load-bearing: Cursor's org allowlist matches the full URL, so a query string, an extra path
segment, a trailing slash, or the `127.0.0.1` or `[::1]` spelling is blocked by team policy. There
is no user-facing MCP port option (see [Troubleshooting the board MCP](troubleshooting.md)).

**Subagent settings.** A chat has two: its *depth*, the deepest level a subagent of the chat may
be at (0 = no subagents, 1 = the chat's agent starts subagents, 2 or 3 = those may start their
own), and its *cap*, the most subagents of the chat that run at the same time (1 to 100). Both are
chosen before the first message, with the **Subagents** chip of the composer's toolbar, and fixed by it; a branch and a fork have their source's, and a
chat made before the settings has depth 1 and cap 100. They are kept in the chat's `chat.json`
(`subagents`), and the last choice is remembered for the next new chat per group, for all
agents, in `state.json` (`defaults.groups.<group>.servers.local.subagents`); a group with none
uses the ungrouped group's, then depth 1 and cap 100. `PATCH /api/chats/{id}` takes them as
`subDepth` (0 to 3) and `subCap` (1 to 100): a field that is absent changes nothing, a value
outside the range is refused (400), and so is either field once the chat has started and on a
branch or a fork (409). A chat's JSON names them as `subDepth` and `subCap`, with `subOff: true`
in place of a depth of 0. A chat on a remote server has its settings on that server: it starts
with the choice that server remembers for the chat's group, which is the same for that server's
owner and for every app connected to it, and a change of them before its first message is made
there and remembered there (see [Chats on a remote server](remote-servers.md#chats-on-a-remote-server)). (A
remote server built before the settings is [too old](remote-servers.md#a-server-that-is-too-old) to connect to.)

**`get_image`** gives an agent a picture of a board (PNG), drawn by the window that holds
the board, or by the headless writer when none does, so it shows colours, layout and overlaps that `read_board` does not. `scope` picks what
is drawn: `selection` (what the user has selected; only for the board that is on their screen, so not while the
headless writer answers),
`all`, `refs` (the elements named in `refs`, by `key` or `id`, with the bound text of the chosen
shapes and arrows; a frame's children and the elements an arrow joins are not added, so a selected
frame is drawn alone) and `rect` (the elements completely inside a rectangle in board
coordinates, a rotated one by its rotated box, with the bound text of the contained shapes and
arrows; `rect` compares exact coordinates while `read_board` prints rounded numbers, so leave a
margin). `refs` and `rect` are used only with their own `scope`, otherwise they are ignored; without a `scope` the
selection is drawn when the board is on screen and something is selected, else the whole board.
`scale` is 1 by default, above 0 and at most 2 (a larger value is used as 2; below 1 gives a smaller picture); `background: false` makes the
picture transparent. A picture over 8192 px on its longest side or over 32 megapixels is refused
(`TOO_LARGE`, with its size), and a result over 24 MB of base64 is refused by the server. The reply
is the picture plus one line of text: the scope used, the bounds in board coordinates and the
element count. Errors read `CODE: message`: `NO_SELECTION`, `EMPTY`, `UNKNOWN_REF`, `TOO_LARGE`,
`BAD_ARGS`, `RENDER_FAILED`. Claude and pi get the picture as an image part of the tool result (for
pi the extension passes it on); whether their models receive it has not been checked with the real
agents. Cursor chats get no image part: the server writes the PNG to a
private folder (`aiwb-images-<uid>`, mode 0700) under the system temp folder, never under the data
folder, and the text names the file (`Image file: <path> (PNG). Open it with your file tools.`).
The same folder takes the images a user attaches to a message of a Cursor chat (see
**Images in a message** below). Files older than an hour are removed, but only when the next
file is written there for a Cursor chat, so with no further one they stay until then or until
the system cleans its temp folder. Pictures
are not stored in the board or in the chat. If the app or window that holds the board is older than
this tool, the call fails with `UNKNOWN_TOOL`; update the app.

**Images in a message.** A message of a chat can carry images: PNG, JPEG, GIF and WebP, at most
5 MB each, 10 in one message and 20 MB in one message together. In the composer an image is
added by pasting it, or with the attach button of the toolbar, which opens the desktop app's own
open dialog. A paste whose clipboard also holds
rich text (a copied spreadsheet cell) is pasted as its text, as before. An image is uploaded when it is added and shows as a thumbnail above the text;
a message can be images alone, and is then named "Image" wherever a message is named by its
words, the chat's name among them. A file that is refused is named in the composer's error line
with the reason. A sent message shows its images above its text, and a click shows one large. A
draft that the page saves by itself while its chat is not open (text typed while the page had no
connection to the server), and that names an image the chat no longer holds, is saved without
it, and the composer says what must be added again when the chat is next opened.

The composer of a chat on a [remote server](remote-servers.md#chats-on-a-remote-server) is the same one and makes
the same calls for that chat: its images are uploaded to, kept on and fetched from the chat's
server, and its draft carries them there. While that server is not connected the chat is
read-only and no image can be added: the attach button is off and a pasted image is refused,
each with the reason.

The bytes are kept in the image store of the top-level chat, `chats/<chat id>/images/`, one file
per image named by the SHA-256 of its bytes, with `index.json` beside them; the chat's branches
share the store, and a fork gets its own copies. A draft and a message name an image by
`{id, name, type, size}` and never hold its bytes. The type is found from the bytes, not from
what the upload says. The calls:
`POST /api/chats/{id}/images?name=` uploads one image (the body is its bytes; refused with the
codes `image_too_large`, `image_type` and `image_cap`), `GET /api/chats/{id}/images/{image}`
serves one, `PUT /api/chats/{id}/draft` and
`POST /api/chats/{id}/messages` take `images`. An upload is cut at the size limit before it is
read, and an image id is checked for its form before anything is looked up by it (400
`image_id`). A draft save that names an image the chat does not
hold is saved without it and answers its id in `missing`; a message is refused whole
(`image_id`, `image_missing`, `image_limit`, `image_model`). An image that was sent stays until
its chat is deleted. One that was never sent is deleted once no draft of any branch names it and
it was last used more than an hour ago (an upload, a draft save that names it or drops it and a
Send that names it are uses), never at the moment a draft stops naming it. The server looks by
itself: when it starts, so also at what an earlier run of it left, and then every five minutes,
in every chat; an upload and a draft save with images look in their chat as well. A chat holds at
most 50 such images, counted after that look.

All of this holds for a chat on a remote server, whose image store is on that server: your app
keeps no image of it. The same four calls are made on the chat's server by the app's main
process, which passes the answers to the page, a server's refusals with their codes and `missing`
of a draft save among them; a fetched image is shown only after the main process has looked at
its bytes (see [Chats on a remote server](remote-servers.md#chats-on-a-remote-server)).

Each agent gets the images of a message for that one message. Claude gets them as image parts of
the user message, ahead of the text. Cursor gets each as a file in the temp folder `get_image`
uses, named in the message text with its type, and opens it with its own file tool. pi gets them
in the `images` list of its `prompt` command. That command has no way to say where they stand:
pi builds the user message as the text and then the images, so the app's pi extension puts the
images ahead of the text in every request pi makes to its model (a `context` handler, which
changes the request and not pi's session file). pi itself resizes large images and replaces them
with a line of text for a model that takes none. A model the catalog
marks as taking no images (`noImages`; from pi's own model list, no Claude or Cursor model is
marked) gets none: the composer does not let one be added and says why, and the server refuses
such a message.

pi runs as a long-lived `pi --mode rpc` process per chat; the UDS
bridge is one listener per server keyed by a per-run, non-secret handle, and the extension presents
only that handle. The chat token is a separate MCP credential and reaches pi only inside the
`AIWB_MCP_CONFIG` header.

pi's extension also runs standalone, without the app bridge:

```sh
pi -e <extension> --mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer <board token>"}}}}'
```

That mode connects and registers the MCP tools normally, but shows no permission card: the
user-supplied MCP tools run un-gated because the ask UI comes from the app's UDS bridge.
