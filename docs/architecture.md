# Architecture

How AI Whiteboard fits together: the server, the web client and the desktop app, how the app reaches every server, the MCP listener and the board tools the agents get, the subagent settings, `get_image`, images in a message, and how pi is run.

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
  auto-approved too (no permission card). Plain (non-board) chats get no board tools.
- **Web client** (`web/`): React + Excalidraw, built with esbuild. It is the page of the desktop
  app and ships inside it: no server serves it. The page and the app are one build.
- **Desktop app** (`desktop/`): an Electron app, the client of every server. Its main process holds
  the server list and the secrets and keeps one connection to each server, this computer's
  included; its window shows the page. The app starts this computer's server, or finds the one
  already running. Quitting the app doesn't stop the server or its running chats.

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

## How the app reaches the servers

The page talks to the app's main process and to nothing else. The main process keeps one
connection per entry of the server list, and **this computer's server is one of the entries**:
the first, with the id `local` and the name "This computer", which is never in the list's file
and cannot be edited. Each connection is HTTP/2 over TLS with the server's secret, to a
certificate that is accepted by its fingerprint and by nothing else, this computer's included.
No secret reaches the page.

- **The transport** (`web/src/transport/`) is the one interface the page has to the network. It
  has a call (a server by its entry's id, a method, a path of the client API, a body, and a way to
  cancel it), a stream (a function for each event and one for a change of the stream's state) and
  the address of a picture. The server is an argument and no part of the path. In the desktop app
  the transport is made over IPC: the window gives the page a fixed set of functions
  (`window.aiwbApp`, `desktop/preload.js`) and the main process answers them. One stream carries
  the events of every server, each with its entry's id. A stream that is closed for good is an
  event of the transport, and the page opens it again.
- **The connection module** (`desktop/conn/`) is plain Node, with no Electron in it. It holds the
  server list and the secrets, makes the pinned connections and keeps a stream per server with its
  retries. A refused secret ends the trying until the entry changes; a stream that is silent for
  35 seconds counts as ended. It is also what the test host uses.
- **What the app keeps.** In `~/Library/Application Support/AI Whiteboard/client/`: `servers.json`,
  the server list with the secrets (mode 0600, the folder 0700; no keychain), and `client-id`, the
  app's id. Of a server's content it keeps nothing.
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
- **Tests and development.** The same page runs in a headless browser for tests, through a test
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

**`get_image`** gives an agent a picture of a board (PNG), drawn by the open window that holds
the board, so it shows colours, layout and overlaps that `read_board` does not. `scope` picks what
is drawn: `selection` (what the user has selected; only for the board that is on their screen),
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

The agents' board edits go through the open window, so boards can only be changed while the app
is open. pi runs as a long-lived `pi --mode rpc` process per chat; the UDS
bridge is one listener per server keyed by a per-run, non-secret handle, and the extension presents
only that handle. The chat token is a separate MCP credential and reaches pi only inside the
`AIWB_MCP_CONFIG` header.

pi's extension also runs standalone, without the app bridge:

```sh
pi -e <extension> --mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer <board token>"}}}}'
```

That mode connects and registers the MCP tools normally, but shows no permission card: the
user-supplied MCP tools run un-gated because the ask UI comes from the app's UDS bridge.
