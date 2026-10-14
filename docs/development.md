# Build and develop

What you need to build and run AI Whiteboard from source, how to run the desktop app in development, how to build the macOS app, how to run the page in a headless browser, and how to run the tests.

## Prerequisites

- macOS (the desktop app build is macOS only; the server alone also builds for Linux, see
  [Build the server for another machine](remote-servers.md#build-the-server-for-another-machine))
- Go 1.25+
- Node.js 22.19+ and npm
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude` on your `PATH`
  - [Cursor CLI](https://cursor.com/cli): `agent` on your `PATH`
  - pi: `pi` on your `PATH`, with an authenticated model (no pi binary is bundled with the app)

## Run the desktop app in development

The app is the only way to use AI Whiteboard: the page ships inside it, and no server serves a
page. From the repo root, build the server program and the page, then start the app from the
checkout:

```sh
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
cd web && npm ci && npm run build && cd ..
cd desktop && npm ci && npm start
```

The app loads `web/dist/index.html` with no packaging and runs `bin/ai-whiteboard` for this
computer's server. The server does not start until it has been set up, so run this once (the
app's first section shows the same command when you forget):

```sh
bin/ai-whiteboard remote setup
```

then press **Retry** in the section. `AIWB_HOME` makes the app use another data folder for its
server (set the server up there too, with `-home`), `AIWB_SERVER_BIN` another server program,
`AIWB_PAGE` another page file and `AIWB_USER_DATA` another folder for the app's own files (its
server list and window state). The MCP port 6006 is fixed, so a second server on the same machine
does not start while another runs.

## Build and install the macOS app

```sh
scripts/build-app.sh    # makes bin/AI Whiteboard.app
scripts/install-app.sh  # copies it to ~/Applications, so Spotlight finds it
```

The page is built into the bundle, so the app is one build of the app, the page and the server
program.

## The page in a headless browser

The app is not used in a browser tab, but the page can still be opened in a headless browser, for
tests and for checking a change to the page without the app. The page then reaches the network
through a plain HTTP face on `127.0.0.1` instead of the app's main process. Two programs serve it
(Playwright is not a dependency: see [`AGENTS.md`](../AGENTS.md) for how it is installed):

```sh
cd web && npm run build
node web/dev/host.mjs --state-dir /tmp/aiwb-host              # the test host: a real server list, real servers
cd web && npm run mock                                        # the mock: a fake client, no server (port 4791, PORT=… to change)
```

The **test host** (`web/dev/host.mjs`) does for the page what the app's main process does: it holds
the server list and the secrets in the state folder, makes the pinned HTTPS connections with the
same module (`desktop/conn`), and serves the page's files, calls, one event stream and pictures. With
`--local-bin PATH` (and `--local-home DIR`) it finds or starts this computer's server with that
server program as the app does. It prints `Host: http://127.0.0.1:<port>/` and listens on the
loopback address only. It is never shipped and no server serves it. The **mock** (`web/dev/mock.mjs`)
stands behind the same face with a made-up world, for working on the page without a Go server;
it is not the contract, the server is. Nothing is injected into the page by either.

## Development

```sh
cd web && npm run watch   # rebuild the web client on change; reload the app's window to see it

go test ./...                                  # server tests, default set: fast, for while you work (about 15 seconds)
AIWB_TEST_FULL=1 go test -timeout 20m ./...    # server tests, full set: every test in full (about 40 seconds)
cd web && npm test        # web client tests
cd web && npm run check   # type check of the web client
cd web && npm run uicheck # the browser checks of the page on the mock
cd desktop && npm test    # desktop app tests: the main process, the connection module
cd desktop && npm run e2e # the app itself, with a stand-in server (opens a window for a few seconds)
node --test web/dev/host.test.mjs   # the test host
```

Which set to run when, what each costs and how to write a test for either set is in
[`AGENTS.md`](../AGENTS.md).

`web/e2e/newchat.e2e.mjs`, `twopages.e2e.mjs`, `remotechat.e2e.mjs` and `localserver.e2e.mjs`
drive the real page in headless Chrome, through a test host, against real servers they build and
start themselves, with the stand-in agent, and spend no money; `remotechat.e2e.mjs` runs this
computer's server and a remote server and shows the sections of the sidebar, an outage and the
return, and `localserver.e2e.mjs` runs this computer's server in every state it can be in. They
serve `web/dist` (run `cd web && npm run build` first), except `localserver.e2e.mjs`, which builds
what it needs. Each header says how to run it.

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome, through a test host, against
real agents. It uses cheap models but still spends a little money; its header explains how to run
it. Stop the running AI Whiteboard app before a default run: the real-Cursor step needs exclusive
port 6006 (Cursor's org allowlist approves only `http://localhost:6006/mcp`). If 6006 is taken the
suite fails fast with an explicit message; set `AIWB_E2E_SKIP_CURSOR_MCP=1` to report the
real-Cursor MCP steps as skipped and run the rest on the hidden test-only MCP port override, so a
normal app instance may keep 6006.
