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
  own once the agent is idle, or with the user's next message after a stop or a failed turn. For pi
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
Files older than an hour are removed, but only when the next picture is written for a Cursor chat,
so with no further call they stay until then or until the system cleans its temp folder. Pictures
are not stored in the board or in the chat. If the app or window that holds the board is older than
this tool, the call fails with `UNKNOWN_TOOL`; update the app or reload the window. (A remote server
built before this tool does not list `get_image` at all.)

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
    orchestrator), and the spawn family;
  - task and merge agents: the spawn family only. They cannot see or change the run.

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

The app can use an AI Whiteboard server on another machine, a remote server, next to its own:
chats and runs started on it run there, with that machine's agents and folders, and a whiteboard
can live there too (see [Whiteboards on a remote server](#whiteboards-on-a-remote-server)). The app connects
over HTTPS with a secret, and accepts one certificate by its fingerprint. The app never installs
or starts a remote server: you set it up and start it on that machine yourself.

A remote server is meant for a private network or a VPN. Its remote port listens on every IPv4
address of the machine; keeping the port off the internet is up to that machine's network and
firewall. HTTPS and the secret do not replace that.

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

### Whiteboards on a remote server

A whiteboard can live on a remote server instead of on your own machine. You draw on it in the
app as on any board; its drawing is stored on the remote server only, and its chats run there.

- **Creation and server choice.** With at least one remote server in the list, a new whiteboard
  first asks **Where should this board live?**: **This computer**, or one of the servers. A
  server that is not connected cannot be picked, since the board is made at once. Without a
  remote server nothing is asked. The choice is final: a board cannot be moved between servers.
- **Where it lives.** The board, its drawing and its chats are on the remote server. Your own
  machine keeps a small record (name, the group it is in here, the server) in
  `~/.ai-whiteboard/remote/boards/`, and no drawing. The group and the place in your sidebar are
  yours alone; the name and the archive mark are the server's. A chat made on such a board is
  always on the board's server. A board an agent makes there with `create_board` appears in your
  sidebar next to the board its chat is on.
- **Holding.** One window draws on a board at a time, as for a local board. Among the windows of
  your app the board is handed over as usual; to the remote server your app is one user of the
  board, whatever the number of its windows. When the board is taken on the remote server
  itself, your window is asked to save and let go, and shows the take-over panel; **Use here**
  takes it back. The agents' board tools are answered by the window that holds the board, so the
  board has to be open in a window, here or there, for an agent to draw on it.
- **Outage.** While the server cannot be reached you keep drawing in the window that has the
  board open; the changes stay in that window and a banner says they are not saved. When the
  server is back they are saved if nobody changed the board there meanwhile, and dropped, with a
  notice, if somebody did. A board that is not open in a window cannot be opened during an
  outage. Rename and delete are refused until the server is back; moving the board between your
  groups works; archive and unarchive are applied here at once and on the server when it is
  back. A board that was deleted on the server stays greyed in your sidebar until you remove it.
- **What the remote server's owner sees.** The board is a normal board of that server, in a group
  named **Remote**, with the chats you made on it. Its owner can open it, draw on it (taking it
  from you), rename, archive or delete it, and add chats, which you do not see. Through the
  remote port your app reaches only the boards it made itself, never the server's own boards.
- **Limits.** A drawing saved through a remote server is at most 32 MB, images included; a
  larger one is refused and stays in the window. A board cannot be moved to another server or
  to this computer. Two people cannot draw on it at the same time. A server that was built
  before remote boards refuses the creation and has to be updated.

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
