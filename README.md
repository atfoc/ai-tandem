# AI Whiteboard

A local app for [Excalidraw](https://excalidraw.com) whiteboards with coding agents built in. Each
board has its own chats with Claude Code, Cursor or pi, and the agents can read and draw on the
board while you work on it too. Select some shapes and ask "explain this", or "draw the request flow
between these services", and the agent edits the board directly. Each change it makes is one undo
step.

Everything runs on your machine. The server keeps boards and chats in `~/.ai-whiteboard`, and
agents run with the logins you already have.

## How it fits together

- **Server** (`cmd/`, `internal/`): a Go program on `127.0.0.1:4747`. It stores boards and chats,
  runs the agent processes and gives them board tools (`list_boards`, `read_board`, `get_view`,
  `apply`, `delete_elements`, `create_board`, `show_board`). Claude, Cursor and pi get these over
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

## Prerequisites

- macOS (the desktop app build is macOS only)
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

## Server commands and flags

```sh
ai-whiteboard [serve]   # run the server in the foreground
ai-whiteboard launch    # start it in the background if it isn't running, print its URL
ai-whiteboard relaunch  # stop the running server, then launch
ai-whiteboard stop      # stop the running server
```

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

go test ./...             # server tests
cd web && npm test        # web client tests
cd desktop && npm test    # desktop app tests
```

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome against real agents. It uses
cheap models but still spends a little money; its header explains how to run it. Stop the running
AI Whiteboard app before a default run: the real-Cursor step needs exclusive port 6006 (Cursor's
org allowlist approves only `http://localhost:6006/mcp`). If 6006 is taken the suite fails fast
with an explicit message; set `AIWB_E2E_SKIP_CURSOR_MCP=1` to report the real-Cursor MCP steps as
skipped and run the rest on the hidden test-only MCP port override, so a normal app instance may
keep 6006.
