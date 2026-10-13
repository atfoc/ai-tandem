# Architecture

How AI Whiteboard fits together: the server, the web client and the desktop app, the MCP listener and the board tools the agents get, the subagent settings, `get_image`, images in a message, and how pi is run.

- **Server** (`cmd/`, `internal/`): a Go program on `127.0.0.1:4747`. It stores boards and chats,
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
- **Web client** (`web/`): React + Excalidraw, built with esbuild. The server serves it.
- **Desktop app** (`desktop/`): an Electron window that starts the server, or finds the one already
  running, and opens it. Quitting the app doesn't stop the server or its running chats.

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
this tool, the call fails with `UNKNOWN_TOOL`; update the app or reload the window.

**Images in a message.** A message of a chat can carry images: PNG, JPEG, GIF and WebP, at most
5 MB each, 10 in one message and 20 MB in one message together. In the composer an image is
added by pasting it, or with the attach button of the toolbar, which opens the desktop app's own
open dialog and in a browser tab the browser's file picker. A paste whose clipboard also holds
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
serves one, to the app's own pages only (403 `image_origin` for another site's), `PUT /api/chats/{id}/draft` and
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
keeps no image of it. The same four calls, under `/api/on/{server}/chats/{id}`, are passed on to
the chat's server, which answers them, its refusals with their codes and `missing` of a draft
save among them (see [Chats on a remote server](remote-servers.md#chats-on-a-remote-server)).

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
(or a browser tab) is open. pi runs as a long-lived `pi --mode rpc` process per chat; the UDS
bridge is one listener per server keyed by a per-run, non-secret handle, and the extension presents
only that handle. The chat token is a separate MCP credential and reaches pi only inside the
`AIWB_MCP_CONFIG` header.

pi's extension also runs standalone, without the app bridge:

```sh
pi -e <extension> --mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://localhost:6006/mcp","headers":{"Authorization":"Bearer <board token>"}}}}'
```

That mode connects and registers the MCP tools normally, but shows no permission card: the
user-supplied MCP tools run un-gated because the ask UI comes from the app's UDS bridge.
