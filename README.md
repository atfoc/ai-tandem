# AI Whiteboard

A local app for [Excalidraw](https://excalidraw.com) whiteboards with coding agents built in. Each
board has its own chats with Claude Code or Cursor, and the agents can read and draw on the board
while you work on it too. Select some shapes and ask "explain this", or "draw the request flow
between these services", and the agent edits the board directly. Each change it makes is one undo
step.

Everything runs on your machine. The server keeps boards and chats in `~/.ai-whiteboard`, and
agents run with the logins you already have.

## How it fits together

- **Server** (`cmd/`, `internal/`): a Go program on `127.0.0.1:4747`. It stores boards and chats,
  runs the agent processes and gives them board tools (`list_boards`, `read_board`, `get_view`,
  `apply`, `delete_elements`, `create_board`, `show_board`). Claude gets these over MCP and Cursor
  through a small HTTP command endpoint.
- **Web client** (`web/`): React + Excalidraw, built with esbuild. The server serves it.
- **Desktop app** (`desktop/`): an Electron window that starts the server, or finds the one already
  running, and opens it. Quitting the app doesn't stop the server or its running chats.

The agents' board edits go through the open window, so boards can only be changed while the app
(or a browser tab) is open.

## Prerequisites

- macOS (the desktop app build is macOS only)
- Go 1.25+
- Node.js 22.6+ and npm
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude` on your `PATH`
  - [Cursor CLI](https://cursor.com/cli): `agent` on your `PATH`

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

## Development

```sh
cd web && npm run watch   # rebuild the web client on change, then reload the page

go test ./...             # server tests
cd web && npm test        # web client tests
cd desktop && npm test    # desktop app tests
```

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome against real agents. It uses
cheap models but still spends a little money; its header explains how to run it.
