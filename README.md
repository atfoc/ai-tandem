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
  `apply`, `delete_elements`, `create_board`, `show_board`). Claude and pi get these over MCP (pi
  through the app's pi extension), and Cursor through a small HTTP command endpoint. For pi the
  app injects a run-scoped `/mcp/<runToken>` URL and resolves it through the owner-only UDS run
  registry, so the board token never enters the pi process. The UDS bridge remains for permission
  asks, subagent activity, abort and MCP failure notices. Plain (non-board) pi chats get no board
  tools.
- **Web client** (`web/`): React + Excalidraw, built with esbuild. The server serves it.
- **Desktop app** (`desktop/`): an Electron window that starts the server, or finds the one already
  running, and opens it. Quitting the app doesn't stop the server or its running chats.

The agents' board edits go through the open window, so boards can only be changed while the app
(or a browser tab) is open. pi runs as a long-lived `pi --mode rpc` process per chat; the UDS
bridge is one listener per server keyed by a per-run token, and the extension presents only that
token, never the board token.

pi's extension also runs standalone, without the app bridge:

```sh
pi -e <extension> --mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://…/mcp/…"}}}'
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

## Limitations

- Your own pi extensions are not loaded: pi runs with `--no-extensions` plus the app's extension,
  so the app's runs are deterministic.
- `/api/usage/pi` is not offered (pi has no plan-limit reporter).
- The pi context split is computed live from the running process and cached; it is not recomputed
  offline once the process exits.
- pi subagents are app-managed: the app's extension spawns child `pi --mode rpc` processes and
  reports them as subagent threads; pi's own spawn-subagent extension is not used.

## Development

```sh
cd web && npm run watch   # rebuild the web client on change, then reload the page

go test ./...             # server tests
cd web && npm test        # web client tests
cd desktop && npm test    # desktop app tests
```

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome against real agents. It uses
cheap models but still spends a little money; its header explains how to run it.
