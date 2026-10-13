# AI Whiteboard

A local app for [Excalidraw](https://excalidraw.com) whiteboards with coding agents built in. Each
board has its own chats with Claude Code, Cursor or pi, and the agents can read and draw on the
board while you work on it too. Select some shapes and ask "explain this", or "draw the request flow
between these services", and the agent edits the board directly. Each change it makes is one undo
step.

Everything runs on your machine. The server keeps boards and chats in `~/.ai-whiteboard`, and
agents run with the logins you already have.

## How it fits together

- **Server** (`cmd/`, `internal/`): a Go program on `127.0.0.1:4747`. It stores boards, chats and
  [runs](#runs), runs the agent processes and gives them board tools (`list_boards`, `read_board`, `get_view`,
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
is no user-facing MCP port option (see [Troubleshooting the board MCP](#troubleshooting-the-board-mcp)).

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
there and remembered there (see [Chats on a remote server](#chats-on-a-remote-server)). (A
remote server built before the settings is [too old](#a-server-that-is-too-old) to connect to.)
[Runs](#runs) have no such settings.

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
rich text (a copied spreadsheet cell) is pasted as its text, as before; the box of a run's goal
takes no images. An image is uploaded when it is added and shows as a thumbnail above the text;
a message can be images alone, and is then named "Image" wherever a message is named by its
words, the chat's name among them. A file that is refused is named in the composer's error line
with the reason. A sent message shows its images above its text, and a click shows one large. A
draft that the page saves by itself while its chat is not open (text typed while the page had no
connection to the server), and that names an image the chat no longer holds, is saved without
it, and the composer says what must be added again when the chat is next opened.

The composer of a chat on a [remote server](#chats-on-a-remote-server) is the same one and makes
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
save among them (see [Chats on a remote server](#chats-on-a-remote-server)).

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

## Runs

A **run** is a sidebar item next to boards and chats. You type a goal and leave: an *orchestrator*
agent splits the goal into tasks, *task agents* carry them out in parallel, and the run goes on
until the orchestrator says the goal is met (or cannot be), a limit is reached, or you stop it. You
pick the agent (Claude, Cursor or pi), the models and the folder before you start; they are fixed
from then on. The models are one for each of the three tiers the orchestrator gives its tasks
(deep, standard, light) and, if you want, one for the orchestrator itself, which otherwise runs on
the deep tier's. The run view shows the turns, the tasks and what every agent is doing, and each
agent's transcript.

- **Where its state lives.** Everything the app records about a run is in
  `~/.ai-whiteboard/runs/<run id>/`, never in the folder the run works on:

  ```
  run.json                         what you set up: name, group, agent, model, folder, limits
  goal.md                          the goal
  journal.jsonl                    one line per change to the run; state.json, tasks.json,
                                   turns.json and agents.json are a checkpoint of it
  notes/v0001.md, …                the orchestrator's notes, every version
  tasks/T01/brief.r1.md            a task's brief, every revision
  tasks/T01/a1.report.md           what its agent reported (a1 = attempt 1)
  tasks/T01/a1.changes.json        what it changed; a1.setup.log is the setup command's output
  agents/<chat id>/                the chat of each of the run's agents
  chats/<chat id>/                 the chats you open on the run
  ```

- **With git.** When the run's folder is inside a git work tree, the run starts from the
  repository's last commit (uncommitted changes are not seen, and not touched). Every task gets a
  checkout of its own, a linked work tree in `<parent of the data folder>/aiwb-run-work/<run id>/`
  (`~/aiwb-run-work/<run id>/` by default) on a branch `aiwb/<run id>/<task>`. A finished task's
  work is committed and merged into the branch **`aiwb/<run id>/integration`**, which is the run's
  result. Your own branch and work tree are not changed while the run is going. When the run ends
  with its goal achieved, the app applies the result to your folder if that touches none of your
  uncommitted work; otherwise, after a run that did not reach its goal, or with automatic applying
  off for the run, you apply it with one action in the run view. When a
  merge conflicts, a *merge agent* resolves it in the task's checkout. A task's checkout is removed
  when the task ends, the run's own when it finishes or is deleted; the branches stay. A repository
  with no commit cannot start a run.
- **Without git.** In a folder that is not in a git work tree the agents work directly in that
  folder. Tasks that change files run one at a time, tasks that only report may run beside them,
  nothing is merged and nothing is undone when a task fails or is cancelled.
- **Tools.** Run tools are MCP tools on the same `board` endpoint, and the endpoint decides per
  chat token who may call what:
  - the orchestrator: `get_run`, `get_task`, `get_agent`, `get_notes`, `set_notes`, `add_task`,
    `update_task`, `cancel_task`, `retry_task`, `finish_run`. It runs read-only (it cannot edit
    files) and has no spawn family;
  - a chat you open on a run: `get_run`, `get_task`, `get_agent`, `get_notes`, `add_task`,
    `update_task`, `cancel_task`, `retry_task`, `tell_orchestrator` (a message for the
    orchestrator), and the spawn family, as its own subagent settings say: it is an ordinary
    chat in this;
  - task and merge agents: the spawn family only. They cannot see or change the run. Their
    subagents start none, and no cap holds for them.

  No chat of a run gets board tools. The run's agents run unattended: nothing they do raises a
  permission card, and a request that comes anyway is refused at once.
- **Limits.** A run stalls, and waits for you, when it reaches its number of orchestrator turns or
  its cost limit (Resume with a higher value), or when the orchestrator is started three times in a
  row with nothing running and changes nothing. The cost is what the agents report: Cursor reports
  none, so a Cursor run has no cost and no cost limit.
- **Stop, resume, restart.** Stop interrupts the run's agents; Resume continues every task and turn
  where it was. When the server stops in an orderly way (`ai-whiteboard stop` or `relaunch`, a
  restart from the app) a working run is halted and **continues by itself** when the server starts
  again. After a crash or a kill it does not: the dead server's agents may still be working in the
  checkouts, so the run shows as stopped and waits for Resume. A run that was closed three times
  within a minute of continuing waits for Resume too.
- **Requirements.** Runs are for macOS and other Unix systems, and a run with git needs git 2.27
  or newer.

## Prompt library

The **prompt library** keeps texts you type often and puts one into a message with a few keys.
A *prompt* is a name and a text; *groups* hold prompts and other groups.

- **The library popup.** The book button at the foot of the sidebar, between **Servers** and
  the theme picker, opens it: a search box, the tree, and an editor for the chosen prompt (its
  name and its text). In a group, groups come before prompts and both are sorted by name; there
  is no manual order. A prompt at the top level stands at the tree's left edge; what is in a
  group is set in, beside a line that runs down from the group. Nothing is saved while you
  type: **Save** (or ⌘↵, Ctrl+↵) saves, and leaving unsaved changes asks first. Deleting asks
  first too, and for a group the question says how many prompts go with it. A save the server
  refuses (a name that is taken, a prompt deleted meanwhile) shows why and keeps what you
  typed. Esc and a click beside the popup close it.
- **Where a prompt is.** The group of a prompt or of a group is set in the tree; the editor
  only says where the item is. A right click in the tree offers **New prompt** and **New
  group** for the place that was clicked: in the group that was clicked, beside the prompt that
  was clicked, at the top level on the space under the rows. The buttons under the tree make
  the new item in the chosen group, beside the chosen prompt, or at the top level with nothing
  chosen. While you type its name, the tree shows the new item's row where it will be. To move
  a prompt or a group, drag it onto a group (onto a prompt: it lands beside that prompt), or to
  the top level: the space under the rows, a server's entry, or the **Move to the top level**
  bar that stands in the buttons' place during a move. The place is lit before you let go, and
  nothing is lit where the item cannot go: where it already is, a group's own contents,
  another server's library. **Move…** of the right-click menu does the same with the keys: the
  arrows choose the place, Enter moves the item there, Esc cancels. A move is saved at once and
  leaves what is typed in the editor as it is; one the server refuses (a name that is taken
  there, groups too deep) says why under the tree, and nothing has moved.
- **Inserting.** ⌘P on a Mac, Ctrl+P elsewhere, in the text box of a chat or of a run's goal
  opens the insert popup: a search box and the list of prompts with their paths, nothing else.
  The arrow keys move the highlight, Enter or a click inserts, Esc closes with the box as it
  was. The prompt's text goes in at the cursor, in place of a selection if there is one, as
  plain text with its line breaks; references and mentions in the box stay as they are. What
  was inserted is from then on text you typed: it is saved with the draft, and a later change
  to the prompt does not change it. In a text box ⌘P does not print the page; anywhere else it
  is the browser's, as before. The composer's toolbar has an **Insert a prompt** button that
  does the same: a run's goal always has it beside Send, a chat's toolbar where its row has
  room left, or as an entry of its **…** popup when the row has that chip.
- **Search.** Both popups search the same way, by path and name (`git/commit message`); the
  text of a prompt is not searched. The typed words must all be there, as parts of words, in the
  typed order; upper and lower case are the same (the matching of the model picker). First come
  the prompts with the first words in the path and the rest in the name, then those with all
  words in the name, then those with all words in the path. A search for a group's name lists
  its prompts.
- **Rules.** A name has 1 to 80 characters, no `/` and no line break, and is unique in its
  group whatever the case: two groups, or a group and a prompt, cannot share one either. A
  text has at most 100,000 characters. A library holds at most 5,000 groups and prompts and
  4 MB of names and texts, and groups nest at most 16 deep. A group cannot be moved into itself
  or below itself, and deleting a group deletes everything in it. The library's own server
  checks all of this, whoever calls. Two windows that save the same prompt at about the same
  time: the later save wins.
- **Where it is kept.** In `~/.ai-whiteboard/prompt-library.json` (a file with a version). A
  file that cannot be read is set aside as `prompt-library.json.unreadable-<UTC time>`, never
  deleted, and the library starts empty; the popup says so.
- **Several servers.** Every server has its own library, and the app shows this computer's
  together with those of the servers in the [server list](#use-a-server-on-another-machine).
  With a remote server's library there, the tree has one top entry per server, this computer
  first, and a path starts with the server's name, which a search finds too. A remote library
  is the one its owner sees in their own app, and whoever can connect to the server can change
  it: a new prompt belongs to the library it is made in, and nothing is moved or copied between
  servers. Changes arrive by themselves in every open window, here and there. When a server
  drops, its prompts stay in both popups from the copy last received, marked **not connected**:
  they can be inserted, and changed once it is back. That copy is kept in memory only, never in
  a file and never in this computer's library: after a restart of your own server, a server
  that is still unreachable shows no prompts until it connects. A server removed from the list
  takes its prompts with it, and a server that is [too old](#a-server-that-is-too-old) shows
  none, and no error.
- **Agents get nothing of it.** No tool reads the library, and no prompt reaches an agent
  unless you inserted it into a message. The instructions the app gives its agents are another
  thing and are not in the library.

The routes, on the server's own port (the popups use them):

| Route | Body | Answer |
| --- | --- | --- |
| `GET /api/library` | | `{"libraries": [...]}`, this computer's first |
| `POST /api/library/{server}/groups` | `name`, `parent` | `{"group": {id, name, parent}}` |
| `PATCH /api/library/{server}/groups/{id}` | `name`, `parent` | `{"group": ...}` |
| `DELETE /api/library/{server}/groups/{id}` | | `{"ok": true}` |
| `POST /api/library/{server}/prompts` | `name`, `parent`, `text` | `{"prompt": {id, name, parent, text}}` |
| `PATCH /api/library/{server}/prompts/{id}` | `name`, `parent`, `text` | `{"prompt": ...}` |
| `DELETE /api/library/{server}/prompts/{id}` | | `{"ok": true}` |

`{server}` is `local` for this computer or the id of a server in the list; a call for another
server is passed on to it over the connection the app's server already holds, and that server
checks the rules. `parent` is the id of a group, `""` for the top of the library; in a `PATCH`
a field that is left out keeps its value. Each library of the list has `server`, `name`,
`connected`, `groups` and `prompts` (flat lists: the tree is in the `parent` fields). A call
that breaks a rule is refused with `{"error": <a sentence>, "code": <code>}`: `bad_name` and
`bad_text` (400), `not_found` and `no_group` (404), `name_taken`, `bad_move`, `library_full` and
`too_deep` (409), `text_too_long` (413), and `no_server` (404) for a server that has no library
here. A call for another server can also end with `server_unreachable` (503: not connected,
nothing was sent), `no_answer` (504) or `bad_answer` (502). The calls that change a library
need a known client, as every write on this port. The windows get the libraries in the
snapshot (`libraries`), one `library` event with the whole library after every change of it,
and `library_removed` when its server leaves the list; no window polls.

**On the remote port** the same seven routes are what a client may do with the server's own
library, and with no other: `{server}` must be `local`. The client's snapshot has the library
as `library` (`groups` and `prompts`), and after every change, whoever made it, the client
gets it whole in an `own_library` event. The library is level 3 of the
[feature levels](#a-server-that-is-too-old) a server reports, so every server the app connects
to has one. The app holds what it gets to the rules above before it keeps or shows it.

## Prerequisites

- macOS (the desktop app build is macOS only; the server alone also builds for Linux, see
  [Build the server for another machine](#build-the-server-for-another-machine))
- Go 1.25+
- Node.js 22.19+ and npm
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude` on your `PATH`
  - [Cursor CLI](https://cursor.com/cli): `agent` on your `PATH`
  - pi: `pi` on your `PATH`, with an authenticated model (no pi binary is bundled with the app)

## Getting started

### Run it in the browser

```sh
# build the web client
cd web && npm ci && npm run build && cd ..

# build and start the server (run it from the repo root so it finds web/dist)
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
./bin/ai-whiteboard
```

Then open http://127.0.0.1:4747. Create a board, open a chat next to it and start asking.

### Run the desktop app in development

Once `bin/ai-whiteboard` and `web/dist` are built (see above):

```sh
cd desktop && npm ci && npm start
```

### Build and install the macOS app

```sh
scripts/build-app.sh    # makes bin/AI Whiteboard.app
scripts/install-app.sh  # copies it to ~/Applications, so Spotlight finds it
```

### Build the server for another machine

```sh
scripts/build-server.sh              # for this machine's system and processor
scripts/build-server.sh linux/amd64  # or darwin/arm64, darwin/amd64, linux/arm64
```

It makes `bin/ai-whiteboard-server-<os>-<arch>/`: the server binary, the web client (`web/`),
`setup-remote.sh`, `start-server.sh` and a `README.md` with the steps for that machine. Every
target builds on any of them, without cgo. There is no installer and no service file: copy the
folder to the machine. See [Use a server on another machine](#use-a-server-on-another-machine).

## Use a server on another machine

The app can use an AI Whiteboard server on another machine, a remote server, next to its own.
Each remote server shows as a section of the sidebar that holds everything on that machine: its
groups, whiteboards, runs and chats. What is made in a section is made on that machine and runs
there, with that machine's agents and folders (see
[Chats on a remote server](#chats-on-a-remote-server) and
[Whiteboards on a remote server](#whiteboards-on-a-remote-server)). Its
[prompt library](#prompt-library) shows next to your own. The app connects over HTTPS with a
secret, and accepts one certificate by its fingerprint. The app never installs or starts a
remote server: you set it up and start it on that machine yourself.

A remote server is meant for a private network or a VPN. Its remote port listens on every IPv4
address of the machine; keeping the port off the internet is up to that machine's network and
firewall. HTTPS and the secret do not replace that. The secret gives all or nothing: whoever has
it reads and changes everything the app keeps on that machine, the owner's own chats too. They
read every thread and every unsent draft, send in any chat, answer a permission request of an
agent somebody else started, draw on every whiteboard, and rename, move, archive and delete
every chat, whiteboard, run and group. Nothing marks who made a thing, and nothing limits an app
to what it made. The secret does not give that machine's own server list with the secrets in it,
its settings, its restart and update, or its data folder as files.

**On the other machine,** with the folder from `scripts/build-server.sh` (its `README.md` has the
same steps in full):

```sh
sh ai-whiteboard-server-linux-amd64/setup-remote.sh   # asks nothing
sh ai-whiteboard-server-linux-amd64/start-server.sh   # starts the server in the background
```

**On a Mac that has the app,** the script is in the bundle and sets the app's own server up:

```sh
sh ~/Applications/AI\ Whiteboard.app/Contents/Resources/remote/setup-remote.sh
~/Applications/AI\ Whiteboard.app/Contents/MacOS/ai-whiteboard relaunch   # restart the app's server
```

Set-up prints the addresses (every name and address the machine has, with the remote port, 4748),
the certificate's fingerprint and the secret, and how to restart the server. Run again, it
changes nothing and prints the same. A set-up takes effect at the server's next start, except a
new secret, which a running server takes at once. On macOS
with the firewall on, incoming connections to the server can be blocked: allow `ai-whiteboard`
when macOS asks, or add it in System Settings, Network, Firewall.

**In the app on your own machine,** open **Servers** at the foot of the sidebar, choose **Add
server** and enter a name, one of the addresses (`https://host:4748`) and the secret, and tick
**Self-signed certificate**. Compare the fingerprint the app shows with the one set-up printed
and accept it only when they are the same. **Test connection** says at which step a connection
fails.

**In the sidebar,** the part at the top holds what lives on this computer and nothing else: no
row in it names a server, and no group of it holds a thing of a remote server. Below it comes
one section per entry of the server list, in the order of the list; with no entry there is no
section. The sections scroll with the rest of the tree. **Servers** is the one place where a
server is added, edited, tested and removed.

- **A section** stands for one remote server. Its head shows the server's name, as the server
  list has it, and its state, in the words **Servers** uses. A click on the head collapses or
  expands the section. A section is not a group: it has no menu, it is not renamed, archived,
  deleted or dragged, nothing is dragged onto its head, and it is in no list of groups a row can
  be moved to. While the server is connected the head has a "+" for a new chat, whiteboard, run
  or group on that server, outside any group. The "+" of the sidebar's head makes things of this
  computer only, and **Show archived** is one switch for this computer's part and every section.
- **A connected server** shows its whole tree in its section, as that machine has it: the same
  groups, nested the same way and in the same order, with the whiteboards, runs and chats in
  them, and what is in no group first. Everything on that machine is there, whoever made it: its
  owner on that server's own page, your app, or another app that is connected to it. A row does
  not say who made it and carries no server name. The rows are those of this computer's part and
  behave as they do: a whiteboard with its chats, a run with its chats and agents, a chat with
  its working mark and its draft mark, a group with its "+" and its menu. Only what makes no
  sense on another machine is left out: a whiteboard's file is not revealed in this machine's
  file manager. A chat, a whiteboard or a run opens in the same view as one of this computer. A
  change made anywhere shows without a reload: a chat somebody else made appears, and a rename,
  a move, an archive mark, a deletion and every change of a group are followed. Until the tree
  has come the section says that it is connecting and shows no rows, and a server with nothing
  on it says so in one line.
- **A server that is not connected** shows its state in its section, with one line that its
  chats show when the server is back, and nothing else: no rows and no last view. Nothing of
  that server can be opened, made, changed or deleted, and nothing of it can be read, except
  what is open in a window at the moment the connection ends: an open chat and an open run view
  stay on screen, read-only (see [Chats on a remote server](#chats-on-a-remote-server)), and an
  open whiteboard can still be drawn on (see
  [Whiteboards on a remote server](#whiteboards-on-a-remote-server)). After a restart of your
  own server, or a reload of the page, during the outage, nothing of that server is known until
  it connects. The app keeps trying the connection, and **Servers** says at which step it fails.
  A server that is [too old](#a-server-that-is-too-old) says so in its section, with the version
  it reports, and shows nothing else.
- **Where a thing is made decides where it lives.** A chat, a whiteboard, a run or a group made
  in a section is made on that server at once, in the group it was made in, and shows in the
  section of every app connected to that server and on its owner's page. One made in this
  computer's part is on this computer. The app asks nothing about the place, and the place is
  final: nothing is moved from one server to another, or between a section and this computer's
  part, and no drop between them is offered.
- **Arranging a section** is arranging that server, for everyone. You make, rename, move, nest,
  archive and delete the groups of a section from your app, with the rules of a group of this
  computer, deleting a group with everything in it among them. A whiteboard, a run or a chat is
  moved between the groups of its own section, by menu and by drag, and is renamed, archived,
  unarchived and deleted from your app. Each of these changes is made on that server and shows
  to its owner and to every connected app: a group you delete is deleted for all of them, with
  what is in it. What anyone deletes there leaves every section at once, and a window that has
  it open says that it is no longer on that server.
- **What the owner of that server sees** on that server's own page is the same tree. What you
  make there is an ordinary chat, whiteboard or run of that server, in the group you made it in,
  or in no group: no group of that server stands for the apps that connect to it. A server that
  the owner's machine itself connects to shows as a section on the owner's page only: it is not
  part of that machine's tree, and your section never shows another machine's sections.
- **What your machine keeps.** On disk, the server list and nothing else of a remote server: no
  record of a chat, a whiteboard or a run, no last view, no draft, no image, no place in a
  group, no archive mark, no memory of what was made there, and no remembered choice for new
  chats. The server's log (`server.log` in the data folder, when the server was started in the
  background) names a remote server by the id of its entry in a line about a failure, and
  nothing that is on that server: no id of a chat, a run or a prompt, and no word of what it
  sent. In memory, your server holds what it got from a connected server (its tree, what it
  offers for a new chat or run, its prompt library) and which window holds an open whiteboard;
  a restart loses all of it. Whether a section is collapsed, and whether each group inside it
  is, is kept in the browser's storage, per browser, as the sidebar's width is. It survives a
  reload and a restart, and it is never sent to the remote server and never taken from it:
  collapsing a group changes nothing for the owner or for another app, a browser tab and the
  desktop app each have their own, and clearing the browser's storage shows everything
  expanded. A group that is new to the page shows expanded. The browser's storage holds no
  content of a remote server.
- **Removing a server from the list** takes its section away and tells that server nothing:
  everything on it stays there. The question before the removal says so. What is open of that
  server in a window is closed with its section.
- **The update from a version without sections.** Before sections, the app filed the chats,
  whiteboards and runs of a remote server in your own groups, kept a record of each in the
  folder `remote/` of its data folder, and reached only what it had made itself, which that
  server kept in a group named **Remote**. At its first start the updated app removes the folder
  `remote/` with everything in it: the records, their last views, the drafts kept with them and
  `makes.json`. Nothing is deleted on any server for it. The things themselves are on their
  servers, and show in their sections once that server is updated as well and connects (until
  then it is [too old](#a-server-that-is-too-old)); the update of a remote server removes its
  group **Remote** and leaves what was in it in no group. On your machine, the place those
  things had in your own groups is lost, and a group that held only such things stays, empty,
  for you to delete. What the app remembered per group and server for new chats is dropped, and
  so is an archive mark that was set here while the server was away and had not reached it. A
  chat that never had a message and was still kept here for a remote server becomes a chat of
  this computer, with its draft, in the group it was in. A run that had not started and named a
  remote server becomes a run of this computer that has not started, with its goal. Each gets
  the agent, the folder and the other settings a new chat or run in its place starts with on
  this computer, in place of that server's. Such a chat on a whiteboard or on a run of that
  server has no place on this computer and is deleted, with its draft; one on a run that
  becomes this computer's stays on it. A draft that was kept with the record of a started
  chat, and had not been carried over to its server, is lost. The app looks for all of this at
  every start and changes nothing in a data folder that holds none of it.

### A server that is too old

A server says what it offers a client with one number, its feature level (`featureLevel` of
`/api/hello`): level 1 is chats and runs, 2 adds
[whiteboards](#whiteboards-on-a-remote-server), 3 the [prompt library](#prompt-library), 4
the chat's draft kept on the server (`PUT /api/chats/{id}/draft`) and the images of a message,
with their upload and fetch (`/api/chats/{id}/images`), and 5 the server's whole tree: a client
is given every group, whiteboard, run and chat of the server and changes them with the calls the
server's own page makes (see [Chats on the remote port](#chats-on-the-remote-port)). A server
of this version reports 5, and the app connects to no server below 5: it shows a server's whole
tree, which an older server does not give, so an older server is not kept usable without it.
A server of level 5 in turn serves no app below 5 (see
[Chats on the remote port](#chats-on-the-remote-port)).

Such a server shows in **Servers**, and in the head of its section of the sidebar, as **Too
old: update the server on that machine**, with the version it reports. Until it is updated:

- Its section says that it is too old and shows nothing else: no group, no chat, no run and no
  whiteboard of that machine.
- It takes no call: nothing of it can be opened, made, changed or deleted from this app.
  Nothing is deleted, here or there.
- The app sends it nothing but the question whether it is still too old: once every five
  minutes, and at once when you edit the entry, press **Test connection** or start the app.

Update the server on that machine (copy the new folder from `scripts/build-server.sh` there, or
update the app there, and restart it). The entry then connects by itself within five minutes,
and its section shows that machine's tree.

| `setup-remote.sh` option | What it does                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `--name NAME`            | adds a DNS name or IPv4 address clients reach the machine by; may be repeated      |
| `--port N`               | the remote port (default: keep it, or 4748 at the first set-up)                    |
| `--new-cert`             | replaces the key and the certificate: every client must accept the new fingerprint |
| `--new-secret`           | replaces the secret: every client needs the new one; a running server takes it at once |
| `--home DIR`             | the data folder (default `~/.ai-whiteboard`)                                       |
| `--server-port N`        | the server's own port, when it is not the running server's or 4747                 |

`start-server.sh [--restart] [server flags]` runs `launch` (with `--restart`, `relaunch`) with
the absolute path of the folder's `web/`, so it works from any folder; the other arguments are
the server's flags below. The scripts are called through `sh` because a copy may lose its
executable bit. They need no `openssl`.

### Chats on a remote server

A chat in a section lives on that remote server: its agent runs there, in a folder of that
machine, and its thread, its settings, its draft and its images are stored there. Your own
machine stores nothing of it and passes every call on. What is said here of the calls, their
answers and the events holds for the groups, the [runs](#runs) and the
[whiteboards](#whiteboards-on-a-remote-server) of a section too. What that server offers the
apps that connect to it is in [Chats on the remote port](#chats-on-the-remote-port).

- **A new chat** is made in a group of the section, outside any group from the section's head,
  or on a whiteboard or a run of the section: a chat on a whiteboard or on a run is on the
  board's or the run's server. It is made on that server at once, before any message
  (`POST /api/on/{server}/chats` with `group`, `board` or `run`), and the answer is the chat,
  with `locked` false. It starts with what that server remembers for its group: agent, folder,
  model, effort and subagent settings. Those choices are that server's own, shared by its owner
  and every connected app: what one of them picked last in a group is what the next new chat of
  that group starts with, whoever makes it. Your app remembers none for a remote server. The
  settings before the first message are changed there, and the first message is an ordinary
  message: the agent starts there. A make that the server cannot take is refused with that
  server's status, code and sentence, and makes nothing, here or there.
- **A run** made in a section is on that server from the moment it is made
  (`POST /api/on/{server}/runs`), before it starts, with its name, its settings and the goal
  being typed. Its owner and every connected app see it in the section, with its goal, and
  change and start it as a run of their own. The goal being typed has no counter: the last save
  stands. The run works in a folder of that machine, with that machine's agents.
- **Several apps and the owner.** The owner of the server and every app connected to it can have
  the same chat open at the same time. Each sees the thread grow, and the draft and the working
  state as the others change them. Anyone who has the chat open sends, stops, answers a
  permission request and changes the settings before the first message, where the chat's own
  state allows it. A message to a branch that is working is refused (409, `busy`), whoever sent
  the one before. The first answer to a permission request decides, and a later one is refused
  (400). Of two changes of the settings the later one stands. The chat of an agent of a run is
  read and never written, for everyone (409).
- **The draft** of a branch is one draft for all of them, kept on the chat's server with that
  server's counter. A save (`PUT /api/on/{server}/chats/{id}/draft?rev=N`) names the counter it
  was typed on and is passed on with the JSON that came, its `images` too (one that names none
  byte for byte), and the answer, `missing` too, is that server's. A save on another counter
  than the stored one is refused (409, `stale`, with the stored counter and draft), so nobody
  replaces what another typed without being told. Your pages get the draft and its counter from
  that server's events. A save with `replace` is refused by your app (400, `replace_refused`).
- **Images** are the chat's server's too (see **Images in a message**), and your app keeps none.
  - An upload (`POST /api/on/{server}/chats/{id}/images?name=`) is cut at the size limit by your
    app before it is read (413, `image_too_large`), and is then passed on with its bytes, the
    type it states and its name. The answer is that server's: the image, or its refusal
    (`image_type`, `image_cap`). While the server is not connected, or is too old, the upload is
    refused unread (503, `server_unreachable`).
  - A fetch (`GET /api/on/{server}/chats/{id}/images/{image}`) is never handed on as it came.
    Your app takes the bytes of that server's answer alone, finds the type from them, and serves
    them under its own headers, the ones an image of this computer is served with. Bytes that
    are not a PNG, JPEG, GIF or WebP image of at most 5 MB are answered 502 `bad_answer`,
    whatever type that server claimed for them: no server of your list can have your app serve
    HTML or SVG of its making. A refusal of that server reaches the page with its status, code
    and sentence, and nothing else of it.
  - An image id is checked for its form by your app before it is sent anywhere. A fetch with
    another is refused (400, `image_id`), and so is a message that names one, as for a chat of
    this computer, or whose `images` are no list. A draft save is passed on without such an id,
    and the answer names it in `missing`, with what that server says the chat does not hold.
    What is passed on of a draft or a message that names images is the same JSON object with one
    `images`, the checked list, however the body spelled that key.
  - The chat of an agent of a run takes no upload (409), and a fetch is passed on as for any
    chat.
- **When the server drops,** its chats leave the sidebar with the rest of the section, and none
  can be opened, made or changed. A chat that is open in a window stays on screen as the page
  had it when the connection ended, read-only, under a warning that names the server and says
  that it is not connected. Nothing is sent, stopped or changed, and the composer says why: its
  box is read-only meanwhile, it keeps what it holds and takes no typing, and no image can be
  removed from the draft. Text that was typed before the connection ended and that the server
  has not taken stays in the open composer and is saved when the
  server is connected again, if the chat is still open then, on the counter the page has (a save
  that is refused as `stale` is handled as any). It is kept nowhere else: the browser's storage
  holds no draft of a chat on a remote server, so it is lost when you leave the chat, reload or
  close the page before the server is back. A chat that was left cannot be opened until the
  server is back, and a reload of the page or a restart of your own server during the outage
  leaves the chat closed until then. An open run view behaves as the chat does: shown as it was,
  read-only, under the same warning.
- **When the server is back,** its section shows its tree as it is then. An open chat or run
  view is brought level with its server, the warning goes and the composer works again. One that
  was deleted there meanwhile says that it is no longer on that server.
- **A make whose answer was lost** (504, `no_answer`) can still have made the chat on that
  server. The chat then shows in the section as any other. Your app looks for none and deletes
  nothing on its account, so an empty chat can stay on that server, where its owner and every
  connected app see it, until somebody deletes it.
- **The calls.** A thing of a section is named by two values: the id of its entry in the server
  list, and its own id on that server. An id is unique on one server only, so the same id can
  name a chat of this computer and a chat of a section. The call for a thing of a section is the
  call for a thing of this computer with `/api/on/{server}` in the place of `/api`, `{server}`
  being the entry's id: `POST /api/on/s_0123456789ab/chats/{id}/messages?branch=main` sends a
  message to a chat of that section. Method, the rest of the path, the query and the body are
  those of the local call, and every id in them is that server's own. A call is sent to that
  server as it came, and its answer is handed to the page as it came, status and JSON body, with
  that server's codes and sentences. Your app answers a few by itself: the end of a follow
  (`POST …/unfollow` of a chat and of a run); the take, the release, the read and the save of a
  [whiteboard](#whiteboards-on-a-remote-server); the fetch of an image;
  `POST …/boards/{id}/reveal` (400, `not_here`: the file is on another machine, in every state
  of the entry); and
  `PATCH …/groups/{id}` with `collapsed` (400, `collapsed_refused`: collapse is the page's own).
  Another path under the prefix is 404, and so is every call under `/api/on/local/…` or under
  an id that is no entry of the list (`no_server`), these few among them. Every write
  under the prefix needs a known client, as every write on this port. Not under the prefix are
  the folders and the usage of an agent of that server (`GET /api/dirs?server=` and
  `GET /api/usage/{agent}?server=`, with the entry's id), the answer to an agent's board tool
  (`POST /api/rpc-reply`) and the [prompt library](#prompt-library). The routes without the
  prefix (`/api/chats/…`, `/api/boards/…`, `/api/runs/…`, `/api/groups/…`) serve the things of
  this computer only: an id that is none of theirs is 404 `not_found`, whatever another server
  has under it, and a `POST /api/chats`, a `POST /api/boards` or a `PATCH /api/runs/{id}` whose
  body names a `server` other than `local` is refused (400, `server_refused`), as
  `PATCH /api/chats/{id}` with a `server` is (409, `server_fixed`).
- **The answer of a call** follows the entry's state. A `{server}` that is no entry of the list
  is 404 `no_server`. An entry that is not connected, or is
  [too old](#a-server-that-is-too-old), is 503 `server_unreachable` with a sentence that says
  which, and nothing was sent; an entry that waits for its next try is made to try at once.
  Connected, the answer is that server's own: for a chat, a run, a whiteboard or a group that is
  not there it is 404 with the code `not_found`, which the page shows as no longer on that
  server. A 401 of that server is 503 `server_unreachable` (the secret is the entry's matter),
  an answer that is no JSON or is too long is 502 `bad_answer`, and a call that was sent and got
  no answer in time, or whose connection ended, is 504 `no_answer`; for a message that is 504
  `send_unknown`, since it is not known whether it arrived. While the entry is not connected,
  the end of a follow and the release of a whiteboard are answered 200 all the same. A call has
  15 seconds between the two servers. A call that can wait for an agent's start, or for a live
  run to stop, has 45: a message, a fork, the opening of a branch, a read of a chat's context
  that asks the agent, a run's start, stop, resume, apply, archive and unarchive, and the
  archive of a group. A drawing and an image have 60, and the delete of a run, and of a group
  with what is in it, 3 minutes.
- **The snapshot and the events.** The snapshot your server gives a page (`GET /api/state`, and
  the start of its event stream) has in `groups`, `boards`, `chats`, `states`, `runs` and
  `defaults` what lives on this computer and nothing else. The trees of the remote servers are
  in `sections`, an object by entry id, each with the same six lists as that server has them
  (without `collapsed` of a group). An entry has a key there only while your server holds its
  tree: its connection is up and its tree was read. A `section` event tells every page of a
  change of that: `{"type": "section", "server", "tree"}` with the whole tree when the server
  connects, the first time or again, which replaces what the page had; and with `"tree": null`
  when your server holds no tree of the entry any more, because the connection ended or the
  entry was removed. An event about a thing of a section is the event of a thing of this
  computer with one more top-level field, `server`, the entry's id; an event without it is about
  this computer. `groups`, `defaults`, `board`, `board_removed`, `chat`, `chat_removed`,
  `branch_state`, `run` and `run_removed` go to every page, in that server's order; `tree`,
  `chat_items`, `sub`, `sub_items`, `run_detail` and `run_activity` to the pages that follow the
  chat or the run; `held`, `release_request`, `superseded` and `rpc` to the one page concerned.
  A page follows a chat or a run from its first read of the thread, the tree, a subagent's
  thread or the run's detail until `…/unfollow`, and your server follows the thing on its server
  for all its pages together. Every follow ends when the entry's tree goes: after a `section`
  with a tree, a page reads again what it shows.

### Whiteboards on a remote server

A whiteboard in a section lives on that remote server. You draw on it in the app as on any
board; its drawing is stored on the remote server only, and its chats run there.

- **Creation.** A new whiteboard made in a section, from the "+" of one of its groups or of its
  head, is made on that server at once, in that group, and the window that made it draws on it.
  One made in this computer's part is on this computer. The app asks nothing about the place,
  and the place is final: a board is not moved to another server or to this computer.
- **Where it lives.** The board, its drawing, its name, its group, its archive mark and its
  chats are on the remote server, and your own machine stores nothing of it. Every board of that
  server is in the section, whoever made it, and one an agent makes there with `create_board`
  shows there as the others do. Rename, move, archive, unarchive and delete are made on that
  server and show to its owner and to every connected app. A chat made on such a board is on the
  board's server, and is made there at once.
- **Holding.** One window draws on a board at a time, among the owner's windows and the windows
  of every app connected to that server. Among the windows of your app the board is handed over
  as usual; to the remote server your app is one user of the board, whatever the number of its
  windows. When the board is taken by the owner or by another app, your window is asked to save
  and let go, and shows the take-over panel; **Use here** takes it back. The agents' board tools
  are answered by the window that holds the board, so the board has to be open in a window, of
  the owner or of a connected app, for an agent to draw on it.
- **Outage.** While the server is not connected you keep drawing in the window that has the
  board open: a save is answered 503 `server_unreachable`, the changes stay in that window and a
  banner says they are not saved. The board's row leaves the sidebar with the rest of its
  section, and the window stays. No other window gets the board, and a board that is not open in
  a window cannot be opened: a take and a read are answered 503 too. When the server is back,
  your app takes the board there again for the window that holds it: the changes are saved if
  nobody changed the board there meanwhile, and dropped, with a notice, if somebody did. When
  somebody else holds the board by then, the window shows the take-over panel and keeps the
  changes until **Use here**. A save made after the server is back, while your app is still
  taking the board there again, is answered 503 `not_held_there`: the changes stay under the
  banner, which then reads "Not saved yet, waiting for" the server, and are saved or dropped by
  the same rule when the board is held again. After a restart of your own server during the
  outage the window still has the drawing, with the changes that were not saved, but the board
  cannot be drawn on until the server is back: the window then asks for the board when the
  section's tree is back, and the same rule saves or drops the changes. A board that was deleted
  there meanwhile says that it is no longer on that server.
- **The calls** are those of a board of this computer under `/api/on/{server}/boards/…`, with
  the answers and the events of [Chats on a remote server](#chats-on-a-remote-server). Your
  server alone decides which of its windows holds the board, and holds the board on its server
  for as long as one of them does. An agent's board tool on that server reaches the window that
  holds the board as an `rpc` event with `server`, and the window answers with
  `POST /api/rpc-reply`.
- **Limits.** A drawing saved through a remote server is at most 32 MB, images included; a
  larger one is refused (413, `too_large`) and stays in the window. Two people cannot draw on a
  board at the same time.

### Chats on the remote port

What a client, another AI Whiteboard server, does on a server's remote port. **A client is
served as the server's own page.** It is given the server's whole tree, whoever made what is in
it, and it changes that tree with the calls the server's page makes, with the same answers. No
mark of who made a thing decides who sees or changes it: whoever has the secret reads and writes
everything on the machine, the owner's own chats too.

- **The snapshot** (`GET /api/state`, and the start of the client's event stream) holds every
  group of the server in its order (`groups`), what the server remembers per group for a new
  chat or run (`defaults`), and every whiteboard (`boards`), chat (`chats`, with one entry of
  `states` for each branch) and run (`runs`, the ones that have not started too), archived ones
  included; and, as before, the server's `agents`, `catalogs`, `home`, `defaultCwd` and its
  prompt `library`. Each list has one order, the same at every read and the one the server's
  own page is given: the groups in the server's order, the whiteboards, the chats and the runs
  oldest first (two of the same moment by their id), and the branch states by their chat. It
  never holds the server's own server list, anything of the servers that machine is itself a
  client of, or its data folder.
- **The events** keep that tree current for every client and every page of the server alike:
  `groups` and `defaults` (each whole, after every change), `board` and `board_removed`, `chat`,
  `chat_removed` and `branch_state`, `run` and `run_removed`, in the order of the changes,
  whoever made them: the owner on the server's own page, this client, another client or an
  agent. The events of a thread and of a run's detail go to whoever follows the chat or the
  run: a read of the thread, the tree or the run's detail starts the follow, and `…/unfollow`,
  the end of the stream or the removal of the thing ends it.
- **There is no group named Remote.** What a client makes is in the group it names, or in no
  group. A server that is updated from before level 5 removes that group once, at its first
  start: the group its `state.json` remembers as `remoteGroup`, whatever its name is by then.
  The whiteboards, runs and chats in it go to no group and keep their own archive marks (a chat
  on a whiteboard or on a run stays with it), and a group nested in it goes to the top level
  with what is in it. A group that is merely named "Remote" is an ordinary group and stays.

The calls that have something of their own on the remote port:

| Route | Body | Answer |
| --- | --- | --- |
| `POST /api/chats` | `id`, `agent`, and one of `group`, `board`, `run` | the chat, `locked` false |
| `PATCH /api/chats/{id}?branch=B` | `name`, `group`, `agent`, `model`, `effort`, `cwd`, `subDepth`, `subCap` | `{"ok": true, "chat"}` |
| `PUT /api/chats/{id}/draft?rev=N&branch=B` | the draft | `{"ok": true, "rev", "missing"}` |
| `POST /api/chats/{id}/messages` | `text`, `context`, `references`, `images`, `target` | `{"ok": true, "branch"}` |
| `POST /api/chats/{id}/images?name=` | the bytes of one image, `Content-Type` its type | `{"id", "name", "type", "size"}` |
| `GET /api/chats/{id}/images/{image}` | | the bytes of the image |
| `POST /api/groups` | `name`, `parent` | the group |
| `PATCH /api/groups/{id}` | `name` | `{"ok": true}` |
| `POST /api/groups/{id}/move` | `parent`, `before` | `{"ok": true}` |
| `DELETE /api/groups/{id}?contents=delete\|keep` | | `{"ok": true}` |
| `POST /api/boards` | `name`, `group`, `new` | the whiteboard |
| `POST /api/runs` | `group`, `name` | the run, `status` `draft` |
| `PATCH /api/runs/{id}` | `name`, `group`, `agent`, `tiers`, `cwd`, `settings` | the run |
| `PUT /api/runs/{id}/draft` | the goal being typed | `{"ok": true}` |
| `POST /api/runs/{id}/start` | `goal` | the run |

- **A new chat** (`POST /api/chats`) is made in the group, on the whiteboard or on the run the
  body names (`group` is a group's id, or `__ungrouped__` for none), unstarted: no agent starts
  and nothing is sent. `id` is a UUID of the client's making, or absent. The chat starts with
  what the server remembers for its place (agent, folder, model, effort and subagent settings),
  and it feeds those choices as any chat of that server does: they are the server's own, the
  same for its owner and every client. Its settings are changed with `PATCH` until its first
  message; once the chat has started, the agent, the model and the subagent settings are refused
  (409). `PATCH` with `group` moves a chat to another group of the server.
- **The first message** is an ordinary message to the chat that has not started
  (`POST /api/chats/{id}/messages`): the agent starts on this server, the branch's draft is
  removed and its counter goes up. A message to a branch that works is refused (409, `busy`),
  whoever sent the one before.
- **The draft** of each branch lives on this server, with a counter that goes up at every change.
  A save names the counter it was typed on (`rev`, 0 for a branch that never had a draft) and is
  refused when that is not the stored one: 409 with `"code": "stale"`, the stored counter (`rev`)
  and the stored draft (`draft`, `null` for none). An empty draft is none. A branch the chat does
  not have is 404 with `"code": "no_branch"`. The page of this server and every client save into
  the same draft, and the counter decides between them: nobody replaces what another typed
  without being told. A draft may name `images`: one the chat does not hold is left out of what
  is stored, and the answer names those left out in `missing` (absent when there are none). The
  chat's `chat` and `branch_state` events and the snapshot carry `draft` and `draftRev`, for a
  chat that has not started too. A save with `?replace=` is refused on both ports (400,
  `"code": "replace_refused"`) and stores nothing: a draft is no longer carried over from
  another server.
- **Images.** The upload and the fetch are the calls this server's own page makes (see
  **Images in a message**), with the same answers: the upload is cut at the size limit before
  it is read, the type is found from the bytes, and a draft save and a message name images by
  id. The chat of a run's agent takes no upload (409).
- **Groups** are made, renamed, moved, nested, archived, unarchived and deleted by a client with
  the rules they have on the server's own page: a group cannot go inside itself or into an
  archived one, and `contents=delete` deletes a group with everything in it, for everyone.
  Whether a group shows collapsed is the server's own matter and each client's: a `PATCH` whose
  body has `collapsed` is refused (400, `"code": "collapsed_refused"`), and the order of the
  groups as a whole (`PUT /api/groups/order`) is not offered.
- **Whiteboards.** A client makes a board in a group (`POST /api/boards`) and holds it at once
  if its stream is open, as a page does. It takes, reads, draws on, renames, moves
  (`PATCH /api/boards/{id}` with `group`), archives and deletes every board of the server, the
  ones its owner made too. One window draws on a board at a time, across the owner's pages and
  every client: to the server a client is one user of the board. A drawing a client saves is at
  most 32 MB (413, `"code": "too_large"`).
- **Runs.** A run is made on the server before it starts (`POST /api/runs`), with the status
  `draft`, and shows to the owner and every client with its goal as it is typed
  (`PUT /api/runs/{id}/draft`; the last save wins). Its agent, tiers, folder and settings are
  changed with `PATCH` until it starts (`POST /api/runs/{id}/start`). The run's own view says
  what a start there would meet: `git`, `dirty`, `blocked`, `folderMissing`, `tierDefaults`.
- **Several clients and the owner** may have the same chat open. Each gets its thread, its draft
  and its working state as the others change them. A permission request is answered by whoever
  follows the chat: the first answer decides, and a later one is refused (400). The settings of
  a chat that has not started are the last caller's. The chat's current branch is one for all of
  them: it is the branch the last message with `?branch=` or with a `target` went to, whoever
  sent it, and opening a branch (`POST /api/chats/{id}/open`) does not change it. Which branch a
  window shows is that window's own matter. The chat of a run's agent is read and never written
  (409).
- **Refusals of a client alone.** A body that names a `server` is refused on `POST /api/chats`,
  `POST /api/boards`, `PATCH /api/chats/{id}` and `PATCH /api/runs/{id}` (400,
  `"code": "server_refused"`): what a client makes lives on the server it called, and no server
  passes a client's call on to a third one. `GET /api/dirs` does not list the app's own folder
  or the folder of the runs' checkouts.
- **What is gone.** A call that names a chat, a run, a whiteboard or a group that is not there
  is answered 404 with `"code": "not_found"`, on both ports. A 404 for a part that is missing
  keeps its own code or has none (a branch: `no_branch`; a subagent, an image, a task).
- **A client that is too old.** A client states its own level in the header `X-AIWB-Level` of
  every request. A client that states none, or one below 5, is served nothing but `/api/hello`:
  every other request is answered 400 with `"code": "client_too_old"` and the sentence "This app
  is too old for this server: update AI Whiteboard on the machine that connects." An app from
  before level 5 cannot show that sentence: its entry for the server says that the server's
  event stream did not open, and it tries again. The sentence is in the log of the server it
  called, once a minute for each address that tries.
- **What a client cannot reach.** Every route outside the remote port's table is answered 404:
  the server list and the secrets in it (`/api/servers`), the calls for another server's things
  (`/api/on/…`), `POST /api/restart`, the status routes, the reveal of a board's file in that
  machine's file manager, and the page's own files. The data folder is not served as files.

## Server commands and flags

```sh
ai-whiteboard [serve]   # run the server in the foreground
ai-whiteboard launch    # start it in the background if it isn't running, print its URL
ai-whiteboard relaunch  # stop the running server, then launch
ai-whiteboard stop      # stop the running server
```

The commands for remote access (see
[Use a server on another machine](#use-a-server-on-another-machine)):

| Command                  | What it does |
| ------------------------ | ------------ |
| `remote setup`           | makes what is missing (secret, key and certificate, configuration) and replaces nothing; prints port, names, fingerprint and the server's own port, and whether the next start will work. `-port N` sets the remote port (4748 at first), `-name X` adds a name or IPv4 address (may be repeated) |
| `remote setup -new-cert` | replaces the key and the certificate |
| `remote status`          | what the running server does (off, or listening with port, names and fingerprint) and what the files say for the next start, with the reason when the server will not start. Never the secret |
| `remote off`             | removes the remote configuration only; a running server keeps listening until its next start, and a later set-up gives the same secret and fingerprint |
| `secret`                 | prints the secret |
| `secret -new`            | replaces the secret and prints the new one; a running server takes it at once and disconnects its clients |

Each takes `-home` for the data folder; `remote setup` and `remote status` take `-server-port`
for the server's own port when it is not the running server's or 4747. They exit 1 when they
refuse or fail, and also when the files are written and the server will not start with them: the
message says which file or port, and the command that repairs it. A server whose remote set-up
is broken does not start at all. The flags in the table below belong to `serve`, `launch`,
`relaunch` and `stop`.

| Flag       | Default            | What it does                              |
| ---------- | ------------------ | ----------------------------------------- |
| `-port`    | `4747`             | port to listen on                         |
| `-home`    | `~/.ai-whiteboard` | data folder for boards and chats          |
| `-cwd`     | current folder     | default working folder for new chats      |
| `-client`  | `web/dist`         | built web client to serve                 |
| `-claude`  | `claude`           | Claude Code binary                        |
| `-cursor`  | `agent`            | Cursor agent binary                       |
| `-pi`      | `pi`               | pi binary                                 |
| `-pi-namer-model` | pi's default | pi model used to name new chats (empty = the CLI's current model) |

At boot the server logs `pi <version> at <path>` (or a warning when pi is missing), so a broken pi
install is visible without failing startup: pi chats then show the error in the chat.

There is no MCP port flag. The MCP listener is always on 6006, because Cursor's org allowlist
approves exactly `http://localhost:6006/mcp`; the only other value is a hidden test-only override.
Only one AI Whiteboard instance per machine can serve MCP: if 6006 is taken the app refuses to
start (see [Port 6006 is taken](#port-6006-is-taken)).

## Troubleshooting the board MCP

The board tools reach agents over one fixed MCP endpoint. Cursor hides MCP load failures in its
ACP layer, so check the app side first.

### Is the listener up and has an agent connected?

```sh
curl -s http://127.0.0.1:4747/api/mcp/status | python3 -m json.tool
```

The reply has the listener (`port`, the exact advertised `url`, `up`) and one entry per chat that
has contacted MCP, most recent first. `chat` is the first 8 characters of the chat's id (a UUID),
so it is a bare short id with no prefix. It is read-only and exposes no token and no board
content; an entry with `"chat": "unknown"` means a client connected with a credential that
resolves to no board chat, and no entry for a chat after a prompt means its agent never loaded the
MCP server, or never used a board tool.

```json
{
  "listener": { "port": 6006, "url": "http://localhost:6006/mcp", "up": true },
  "chats": [
    { "chat": "1a2b3c4d", "client": "Cursor", "clientVersion": "...", "method": "tools/call",
      "tool": "read_board", "outcome": "ok", "at": "2026-01-01T00:00:00Z" }
  ]
}
```

### Probe the endpoint by hand

A chat's token is in the chat's `chat.json` in the app's data folder, under `"token"`
(the app never prints it). POST an MCP `initialize` exactly as an agent would:

```sh
curl -sS -X POST http://localhost:6006/mcp \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer <chat token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"curl","version":"0"}}}'
```

A 200 whose result has `serverInfo.name` `board` means the listener is reachable and the Host
check passed. Replace the method with `tools/list` to see the tools for that chat (spawn family on
every chat; board tools only on board chats; none for an archived chat). `curl` may use either
the `localhost` or `127.0.0.1` spelling; **agents must never be configured with `127.0.0.1`** (see
above). The `initialize` and `tools/list` handshakes are permissive, so an unknown token still
answers them with an empty list; the `tools/call` then returns tool text (`isError`), never HTTP 401.

### The server log

Each MCP event is one line in the server log (stderr: the foreground `serve` output, or the log
`launch` writes):

```
mcp initialize chat=1a2b3c4d client="Cursor" version="..."
mcp tools/call chat=1a2b3c4d tool="read_board" outcome=ok
```

An unknown credential logs `chat=unknown`. The token itself is never logged, and tool arguments
are not logged.

### Cursor shows no board tools (silent ACP failure)

1. `GET /api/mcp/status` (or the `mcp initialize` log line) shows no contact for the chat: the
   MCP server was never loaded, or the prompt never used a board tool.
2. Cursor's own debug log is at `$TMPDIR/cursor-agent-logs-<uid>/latest.log`. Search it for
   `Failed to load ACP session MCP server` and `Blocked by team policy`. A `Blocked by team
   policy` line means the configured URL does not match the org allowlist exactly.
3. Functional check: ask the Cursor chat to call `read_board`. Expect an `mcp__board__*` card. A
   reply that claims it has no board tools, with no server-side contact, is the silent-failure
   signature.
4. URL audit: a unit test pins the exact `http://localhost:6006/mcp` string for every spawner, so
   an accidental query, path, trailing slash or host spelling fails CI.

### Port 6006 is taken

The app binds 6006 before it writes `server.json`. If it cannot, it exits without touching the
running instance and prints:

```
cannot serve the MCP endpoint on port 6006: ... address already in use
Port 6006 is probably held by another AI Whiteboard instance (for a different data folder) or by another program.
Stop that instance or free port 6006, then start AI Whiteboard again.
```

`launch`/`relaunch` report the server stopped while starting with that message in the log tail.
Because the port is fixed, exactly one instance can serve MCP per machine, so stop a running app
before the default e2e run (see Development).

## Limitations

- Your own pi extensions are not loaded: pi runs with `--no-extensions` plus the app's extension,
  so the app's runs are deterministic.
- The guard on pi's tool calls is not a sandbox. It refuses a tool input that names the app's own
  folder, which stops accidental access; a shell command that reaches the folder without naming it
  is not stopped.
- `/api/usage/pi` is not offered (pi has no plan-limit reporter).
- The pi context split is computed live from the running process and cached; it is not recomputed
  offline once the process exits.
- pi subagents are app-managed via the MCP spawn family: the app spawns child `pi --mode rpc`
  processes and reports them as subagent threads; the extension's native `subagent` tool is not
  registered on app chats.

## Development

```sh
cd web && npm run watch   # rebuild the web client on change, then reload the page

go test ./...                                  # server tests, default set: fast, for while you work (about 1 minute)
AIWB_TEST_FULL=1 go test -timeout 20m ./...    # server tests, full set: every test in full (about 2 minutes)
cd web && npm test        # web client tests
cd web && npm run check   # type check of the web client
cd desktop && npm test    # desktop app tests
```

Which set to run when, what each costs and how to write a test for either set is in
[`AGENTS.md`](AGENTS.md).

`web/e2e/remotechat.e2e.mjs`, `remoterun.e2e.mjs`, `apiclient.e2e.mjs`, `newchat.e2e.mjs` and
`twopages.e2e.mjs` drive the real page in headless Chrome against real servers they build and
start themselves, with the stand-in agent, and spend no money; the first two run a local server
and a remote server and show the sections of the sidebar, an outage and the return. Each header
says how to run it.

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome against real agents. It uses
cheap models but still spends a little money; its header explains how to run it. Stop the running
AI Whiteboard app before a default run: the real-Cursor step needs exclusive port 6006 (Cursor's
org allowlist approves only `http://localhost:6006/mcp`). If 6006 is taken the suite fails fast
with an explicit message; set `AIWB_E2E_SKIP_CURSOR_MCP=1` to report the real-Cursor MCP steps as
skipped and run the rest on the hidden test-only MCP port override, so a normal app instance may
keep 6006.

At most 4 branches of one chat and 12 chats and branches overall work at the same time (a message
beyond that is refused with HTTP 429, code `cap`); for tests, `AIWB_CHAT_CAP` and `AIWB_APP_CAP`
(positive integers, read at start) override the two limits.
