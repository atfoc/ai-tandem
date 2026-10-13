# Build and develop

What you need to build and run AI Whiteboard from source, how to run it in the browser or as the desktop app, how to build the macOS app, and how to run the tests.

## Prerequisites

- macOS (the desktop app build is macOS only; the server alone also builds for Linux, see
  [Build the server for another machine](remote-servers.md#build-the-server-for-another-machine))
- Go 1.25+
- Node.js 22.19+ and npm
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude` on your `PATH`
  - [Cursor CLI](https://cursor.com/cli): `agent` on your `PATH`
  - pi: `pi` on your `PATH`, with an authenticated model (no pi binary is bundled with the app)

## Run it in the browser

```sh
# build the web client
cd web && npm ci && npm run build && cd ..

# build and start the server (run it from the repo root so it finds web/dist)
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
./bin/ai-whiteboard
```

Then open http://127.0.0.1:4747. Create a board, open a chat next to it and start asking.

## Run the desktop app in development

Once `bin/ai-whiteboard` and `web/dist` are built (see above):

```sh
cd desktop && npm ci && npm start
```

## Build and install the macOS app

```sh
scripts/build-app.sh    # makes bin/AI Whiteboard.app
scripts/install-app.sh  # copies it to ~/Applications, so Spotlight finds it
```

## Development

```sh
cd web && npm run watch   # rebuild the web client on change, then reload the page

go test ./...                                  # server tests, default set: fast, for while you work (about 15 seconds)
AIWB_TEST_FULL=1 go test -timeout 20m ./...    # server tests, full set: every test in full (about 40 seconds)
cd web && npm test        # web client tests
cd web && npm run check   # type check of the web client
cd desktop && npm test    # desktop app tests
```

Which set to run when, what each costs and how to write a test for either set is in
[`AGENTS.md`](../AGENTS.md).

`web/e2e/remotechat.e2e.mjs`, `apiclient.e2e.mjs`, `newchat.e2e.mjs` and
`twopages.e2e.mjs` drive the real page in headless Chrome against real servers they build and
start themselves, with the stand-in agent, and spend no money; `remotechat.e2e.mjs` runs a local
server and a remote server and shows the sections of the sidebar, an outage and the return. Each
header says how to run it.

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome against real agents. It uses
cheap models but still spends a little money; its header explains how to run it. Stop the running
AI Whiteboard app before a default run: the real-Cursor step needs exclusive port 6006 (Cursor's
org allowlist approves only `http://localhost:6006/mcp`). If 6006 is taken the suite fails fast
with an explicit message; set `AIWB_E2E_SKIP_CURSOR_MCP=1` to report the real-Cursor MCP steps as
skipped and run the rest on the hidden test-only MCP port override, so a normal app instance may
keep 6006.
