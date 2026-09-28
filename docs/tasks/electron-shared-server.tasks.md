# Handoff: tasks for the Electron app over the Go server

This file holds 23 tasks, `T01` to `T23`. Everything needed to create them is here.

How to read it:

- Each task starts with a `## Txx` heading, followed by three fields and a body:
  - **Title**: the rest of the line after `**Title:** `, exactly as written (backquotes included).
  - **For agent**: `yes` means tag the task `for-agent`; `no` means do not tag it.
  - **Blocked by**: the IDs of the tasks in this file that must be completed before this one may
    start, or `none`. Map each ID to the task created for it and set it as a blocker.
  - **Body**: every line strictly between `=====BEGIN BODY Txx=====` and `=====END BODY Txx=====`,
    exactly as written (Markdown). The marker lines themselves are not part of the body.
- Tasks are listed so that every task's blockers come before it; creating them from top to bottom
  means every blocker already exists when it is needed.
- The `Txx` IDs exist only in this file. Do not put them in titles or bodies.
- Summary: all 23 tasks are `for-agent`; there is no manual (human) verification task.

| ID | Title | For agent | Blocked by |
|---|---|---|---|
| T01 | Go: the ai-whiteboard binary opens nothing; launch prints the server URL on stdout | yes | none |
| T02 | Go: test that two launchers racing start exactly one server | yes | T01 |
| T03 | Go: relaunch command, POST /api/restart, and webVersion in /api/hello | yes | T01, T02 |
| T04 | Web: version stamping and the update banner (Restart server / Reload) | yes | T03 |
| T05 | Desktop: Electron app that starts or finds the server through `ai-whiteboard launch` | yes | T01 |
| T06 | Desktop: links leave the app window for the default browser | yes | T05 |
| T07 | Desktop: reconnect by running launch again when the server is gone | yes | T06 |
| T08 | Desktop: closing, reloading or quitting waits for board saves | yes | T07 |
| T09 | Packaging: build AI Whiteboard.app with electron-builder, and update the docs | yes | T03, T04, T05 |
| T10 | Environment `terminal` for the terminal launch/serve check | yes | T01, T02, T03 |
| T11 | Check: `ai-whiteboard launch` and `serve` in a terminal print the URL and open nothing | yes | T10, T01 |
| T12 | Environment `banner` for the version banner check in browser tabs | yes | T03, T04 |
| T13 | Check: version banner, Restart server, Reload and `relaunch` in browser tabs | yes | T12, T03, T04 |
| T14 | Environment `app-lifecycle` for the app start-up and quit check | yes | T08, T09 |
| T15 | Check: the app starts or finds the server, stays a single instance, and quitting leaves the server running | yes | T14, T05, T09 |
| T16 | Environment `links` for the app link-handling check | yes | T08, T09 |
| T17 | Check: links in the app window open in the default browser and the window stays on the server | yes | T16, T06, T09 |
| T18 | Environment `reconnect` for the app reconnect check | yes | T08, T09 |
| T19 | Check: the app brings back a killed or stopped server | yes | T18, T07, T09 |
| T20 | Environment `close-flush` for the app close/quit flush check | yes | T08, T09 |
| T21 | Check: Cmd+Q and closing the window wait for board saves | yes | T20, T08, T09 |
| T22 | Environment `app-update` for the app update check | yes | T08, T09 |
| T23 | Check: installing a new build over a running old server shows Restart in the app, and Restart works | yes | T22, T03, T04, T09 |

---

## T01

- **Title:** Go: the ai-whiteboard binary opens nothing; launch prints the server URL on stdout
- **For agent:** yes
- **Blocked by:** none

=====BEGIN BODY T01=====
## Why

AI Whiteboard is moving from "a Go launcher opens a browser tab" to an Electron app window. Opening a
window becomes Electron's job only; the Go binary only starts servers and reports where they are.
This task makes that change on the Go side. The design's goal, as written:

## Goal

- Replace "Go launcher opens a browser tab" with an Electron app window.
- The server stays the Go program (`cmd/ai-whiteboard`), unchanged in what it does.
- One `AI Whiteboard.app` holds everything: Electron, the Go binary, the built web client. Nothing
  gets installed outside the bundle.
- The app connects to a server that is already running, or starts one if none is.
- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

## What already exists

## What already exists (and stays)

The Go side already does almost all of the server lifecycle:

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.
- `serve` refuses to start a second server (it runs `findRunning` first) and removes
  `server.json` on SIGINT/SIGTERM.
- `bundleResources()` finds `Contents/Resources` when the binary is at `X.app/Contents/MacOS/…`,
  and serves the web client from `Contents/Resources/web`.
- `/api/hello` already returns `version` and `pid`.

So Electron must **not** reimplement discovery or start-up. It calls the Go binary's `launch` and
gets back a URL.

## What to change (from the design, verbatim)

Go changes needed for this: **the Go binary never opens anything.** Opening a window is
Electron's job only; the binary starts servers and reports where they are.

- Remove `openBrowser()` and every call to it (`serve` twice, `launch` twice), and remove the
  `-no-open` flag.
- `serve` boots the server exactly as now. If a server is already running, it prints
  `AI Whiteboard is already running at <url>` (as now) and exits, without opening it. When it
  starts, it logs the URL as now.
- `launch` does everything it does now: find the running server, or take PATH from the login
  shell, start `serve` detached (Setsid, output to `server.log`), and poll `/api/hello` for up to
  30 s. The only difference is the end: instead of opening the URL, it **prints the URL on
  stdout** as the only line (`http://127.0.0.1:4747/`). It prints the same way whether it found a
  server or started one, so Electron and scripts can read it.
- Failures: `fail()` writes the message to stderr and exits 1. The `osascript` alert goes away.
  It was there only because a Finder or Spotlight launch had no terminal. With Electron as the
  bundle's executable, Finder never runs the Go binary directly, and Electron shows the stderr
  text in its own dialog.
- `command()`: the rule "no arguments inside a bundle means `launch`" existed for Finder
  launches. Finder no longer runs the Go binary, so it can go, and no command always means
  `serve`. Electron always passes `launch` explicitly.
- Using a browser tab instead of the app: run `ai-whiteboard launch` (or `serve`) and open the
  printed URL yourself.

### 6. Browser tab still works

Nothing changes on the server, so `ai-whiteboard` from a terminal and the browser tab keep
working. The app window and a browser tab are just two clients. The editor bridge already handles
more than one client (active/pending client, `/api/client/release`).

### The work item

1. **Go: the binary opens nothing** (see 2):
   - Remove `openBrowser()` and `-no-open`.
   - `launch` prints the URL on stdout as its only line, both when it finds a server and when it
     starts one.
   - `fail()` goes to stderr plus exit 1, with no `osascript` alert.
   - Drop the "no arguments in a bundle means launch" rule in `command()`.
   - Update the tests in `cmd/ai-whiteboard/main_test.go` and the usage comment in `main.go`.

## Details for this task

- Files: `cmd/ai-whiteboard/main.go`, `cmd/ai-whiteboard/launch.go`,
  `cmd/ai-whiteboard/main_test.go`, and `web/e2e/app.e2e.mjs`.
- Remove the `noOpen` field of `options`, the `-no-open` flag, the `openBrowser` function, and all
  four calls: two in `serve` (the "already running" branch and the `o.client != "" && !o.noOpen`
  one after start) and two in `launch` (the "found a running server" branch and the "the started
  server answers" branch).
- `launch` starts `serve` with launch's own flags only (`serve <args>`, no `-no-open`).
- `launch` writes the URL followed by a newline to stdout in both branches, and nothing else to
  stdout. To make that testable, have `launch` write to an `io.Writer` that `main` passes as
  `os.Stdout`.
- `fail()` keeps its current stderr text (`AI Whiteboard: <title>` then the detail) and
  `os.Exit(1)`; the `osascript` call and the comment about Spotlight go away.
- `command()`: with no command (no arguments, or the first argument starts with `-`) it always
  returns `serve`. The `resources` parameter that existed only for this rule goes away.
- Update the doc comments: the usage block at the top of `main.go` (drop the line "Inside AI
  Whiteboard.app, running with no arguments means launch (spec 4.14).", describe `launch` as
  "start the server in the background if needed, print its URL, exit" and `serve` as running the
  server in the foreground, or printing the running one's URL), and the comment above `launch`.
- `web/e2e/app.e2e.mjs` passes `-no-open` in `serverArgs()`; remove it there, since the flag no
  longer exists and the server would refuse to start with it.
- Do not change `scripts/build-app.sh` here. Until the bundle is rebuilt around Electron, its
  Go-binary-as-executable bundle runs `serve` when opened from Finder; that is expected for now.
- `stop` is unchanged.

## Verification (automated)

- `go build ./... && go vet ./...` succeed.
- `go test ./...` passes, including:
  - `TestCommand` updated: no arguments means `serve` whether or not the binary is in a bundle;
    the `-no-open` case is gone.
  - A new test: with a running server (the existing `hello("ai-whiteboard")` httptest helper),
    `launch` writes exactly `http://127.0.0.1:<port>/` plus a newline to its writer and nothing
    else.
- `grep -rnE "openBrowser|osascript|no-open|noOpen" cmd/ web/e2e/` prints nothing.
=====END BODY T01=====

---

## T02

- **Title:** Go: test that two launchers racing start exactly one server
- **For agent:** yes
- **Blocked by:** T01

=====BEGIN BODY T02=====
## Why

Only one AI Whiteboard server may run for a data folder. The app and a terminal can both run
`ai-whiteboard launch` at the same moment, so the race between two launchers must be covered by a
test. From the design:

### 3. Only one app, only one server

- Server: already handled by the Go side (`findRunning` in `launch` and in `serve`, fixed port
  4747 as fallback). Two launchers racing: the second `serve` either sees the first via
  `/api/hello` or fails to bind 4747 and exits. The losing launcher keeps polling and finds the
  winner. **Check this race in a test.**

### The work item

4. **Go: launcher race test**: two `launch` at once → one server, both print the same URL.

## What already exists

## What already exists (and stays)

The Go side already does almost all of the server lifecycle:

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.
- `serve` refuses to start a second server (it runs `findRunning` first) and removes
  `server.json` on SIGINT/SIGTERM.
- `bundleResources()` finds `Contents/Resources` when the binary is at `X.app/Contents/MacOS/…`,
  and serves the web client from `Contents/Resources/web`.
- `/api/hello` already returns `version` and `pid`.

So Electron must **not** reimplement discovery or start-up. It calls the Go binary's `launch` and
gets back a URL.

`launch` no longer opens anything. The design for it, verbatim:

- `launch` does everything it does now: find the running server, or take PATH from the login
  shell, start `serve` detached (Setsid, output to `server.log`), and poll `/api/hello` for up to
  30 s. The only difference is the end: instead of opening the URL, it **prints the URL on
  stdout** as the only line (`http://127.0.0.1:4747/`). It prints the same way whether it found a
  server or started one, so Electron and scripts can read it.
- Failures: `fail()` writes the message to stderr and exits 1. The `osascript` alert goes away.
  It was there only because a Finder or Spotlight launch had no terminal. With Electron as the
  bundle's executable, Finder never runs the Go binary directly, and Electron shows the stderr
  text in its own dialog.

## Details for this task

- Add the test in a new file `cmd/ai-whiteboard/launch_race_test.go` (package `main`). Skip it
  under `testing.Short()`.
- Build the real binary once in the test (`go build -o <t.TempDir()>/ai-whiteboard` of
  `ai-whiteboard/cmd/ai-whiteboard`).
- Each round uses a fresh data folder (`t.TempDir()`) and a free port (the `freePort` helper in
  `main_test.go`). Never use port 4747 or `~/.ai-whiteboard`: the user's own server may be there.
- Start two `<bin> launch -home <dir> -port <port> -client ""` processes at the same moment (both
  goroutines wait on one barrier, then `exec.Command(...).Output()`).
- Pass when: both exit 0; each stdout is exactly one line; both lines are equal and equal
  `http://127.0.0.1:<port>/`; `GET /api/hello` on that port answers `app == "ai-whiteboard"`;
  exactly one server process runs for that data folder (`pgrep -f -- "serve -home <dir>"` lists one
  pid, the one `/api/hello` reports).
- Run three rounds.
- Cleanup (`t.Cleanup`) always runs `<bin> stop -home <dir> -port <port>` and kills any process
  still matching `-home <dir>`, so no server outlives the test.
- If the test fails because the losing launcher gives up as soon as its own `serve` exits (in
  `launch`'s wait loop the `exited` case calls `fail` before `findRunning` is asked again), change
  `launch` so that the losing launcher keeps polling and finds the winner: after its own `serve`
  has exited, keep polling `findRunning` until the 30 s deadline for as long as something accepts
  connections on the port, and fail with the log tail ("the server stopped while starting") only
  when nothing listens there. Nothing else in `launch` changes.

## Verification (automated)

- `go test ./cmd/ai-whiteboard -run Race -count=3 -v` passes.
- `go test ./...` and `go vet ./...` pass.
- After the test run, no process matching `serve -home <the test's temp folders>` is left.
=====END BODY T02=====

---

## T03

- **Title:** Go: relaunch command, POST /api/restart, and webVersion in /api/hello
- **For agent:** yes
- **Blocked by:** T01, T02

=====BEGIN BODY T03=====
## Why

After a new AI Whiteboard build is installed, a server started by the old build keeps running and
serving the new web files. The page will detect this and offer to restart the server. This task is
the Go side of that: the `relaunch` command, the `POST /api/restart` endpoint that runs it, and the
disk version of the web client in `/api/hello`. From the design's goal:

- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

## What already exists

## What already exists (and stays)

The Go side already does almost all of the server lifecycle:

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.
- `serve` refuses to start a second server (it runs `findRunning` first) and removes
  `server.json` on SIGINT/SIGTERM.
- `bundleResources()` finds `Contents/Resources` when the binary is at `X.app/Contents/MacOS/…`,
  and serves the web client from `Contents/Resources/web`.
- `/api/hello` already returns `version` and `pid`.

So Electron must **not** reimplement discovery or start-up. It calls the Go binary's `launch` and
gets back a URL.

`launch` prints the URL on stdout as its only line and never opens anything. The design for it,
verbatim:

- `launch` does everything it does now: find the running server, or take PATH from the login
  shell, start `serve` detached (Setsid, output to `server.log`), and poll `/api/hello` for up to
  30 s. The only difference is the end: instead of opening the URL, it **prints the URL on
  stdout** as the only line (`http://127.0.0.1:4747/`). It prints the same way whether it found a
  server or started one, so Electron and scripts can read it.
- Failures: `fail()` writes the message to stderr and exits 1. The `osascript` alert goes away.
  It was there only because a Finder or Spotlight launch had no terminal. With Electron as the
  bundle's executable, Finder never runs the Go binary directly, and Electron shows the stderr
  text in its own dialog.

## The design (verbatim)

### 4. Server from an older build (updates)

After installing a new `.app`, a server started by the old build keeps running. It keeps serving
`Contents/Resources/web` from disk, so the new web files end up on the old server, which can break.
`install-app.sh` already warns about this.

Starting the app never stops a server: a restart ends all running agent chats, so the user
decides when. `launch` connects to the running server whatever its version and prints its URL. The
page notices the mismatch and shows a banner at the bottom of the left sidebar.

#### How versions are determined

- `scripts/build-app.sh` computes one version, `V = git describe --tags --always --dirty`, and
  stamps it into both halves of the build:
  - Go: `-ldflags -X ai-whiteboard/internal/version.Version=V`, as now.
  - Web: `build.mjs` reads `V` from `AIWB_VERSION` (default `dev`), sets it in the bundle with an
    esbuild `define` (`__APP_VERSION__`), and writes `dist/version.json` = `{"version": V}`.
- `GET /api/hello` returns `version` (the running binary's, fixed when it started) and
  `webVersion`, read from `version.json` in the served client folder on each request (`dev` when
  the file is missing).
- On every connect and reconnect, the page calls `/api/hello` and compares three versions: its own
  (`page`), the server's (`server`) and the one on disk (`disk`):

  | Case | Meaning | Banner |
  |---|---|---|
  | all equal, or any is `dev` | nothing to do | none |
  | page = disk ≠ server | new app installed, old server still running | **Restart server** |
  | page ≠ disk | page loaded before the server was replaced | **Reload** |

- Why the version on disk: `git describe` strings can't be ordered. The files on disk always come
  from the newest install, so they show which side is stale.

#### Banner

- Stale server: "New version installed. The server is still running the old one." +
  **[Restart server]**.
- Stale page: "This page is out of date." + **[Reload]** (`location.reload()`, no restart).
- × hides the banner until the next reconnect.
- While restarting: "Restarting…". On failure: "Restart failed" + **[Retry]** **[Open log]** (in a
  browser tab, the path of `server.log` instead of Open log).

#### What "Restart server" does

1. If agents are running, confirm: "Restart ends N running agent chats." Otherwise no dialog.
2. Flush board changes (`window.aiwbFlush()`) and show "Restarting…". Drafts are already on the
   server.
3. `POST /api/restart`. The server only spawns `<os.Executable()> relaunch` detached (Setsid,
   output to `server.log`), replies 202 and keeps running. After an in-place install that path
   holds the new binary. If it is gone (app moved or deleted), the server replies 409 and the
   banner says to quit the app and run `ai-whiteboard relaunch`.
4. `relaunch` is **stop + launch**, and does the same when run from a terminal:
   - `findRunning()` → pid and port, check `/api/hello` is ours.
   - SIGTERM, wait up to 10 s. The server takes its normal SIGTERM path: flush, end agents,
     remove `server.json`, exit.
   - Then everything `launch` does: PATH from the login shell, start `serve` detached, poll
     `/api/hello` up to 30 s, print the URL, exit. Failure → stderr, exit 1.
   - With no server running, it is just `launch`.
5. The page polls `/api/hello` every 0.5 s until `version` differs from the old one, then
   `location.reload()`. No new version within 45 s → "Restart failed".
6. Other open clients reconnect to the new server, find page ≠ disk, and show **Reload**.

The HTTP endpoint never shuts the server down itself, so a restart from the banner and
`ai-whiteboard relaunch` in a terminal go through the same code.

### The work item

2. **Go: versions and relaunch** (see 4):
   - `relaunch` command = `stop` + `launch`; add it to `command()` and the usage comment.
   - `POST /api/restart`: spawn `relaunch` detached from `os.Executable()`, reply 202; 409 when
     the binary is gone.
   - `/api/hello` adds `webVersion` from `version.json`.
   - `launch` never stops a server, whatever its version.
   - Tests: `relaunch` with no server = `launch`; `relaunch` over a running server → new pid;
     `/api/restart` → 202, and a new server answers.

## Details for this task

- Files: `cmd/ai-whiteboard/main.go`, `cmd/ai-whiteboard/launch.go`, their tests,
  `internal/server/server.go`, `internal/server/server_test.go`.
- `relaunch`:
  - Add it to the `main` switch, to the "unknown command" message (`serve, launch, relaunch,
    stop`) and to the usage comment at the top of `main.go` ("stop the running server if any,
    then launch; prints the URL").
  - It takes the same flags as `launch` and passes them on the same way.
  - Its stdout carries only the URL line, like `launch`: the stop step prints nothing on stdout.
  - Stop step: `findRunning()`; if a server answers, take its pid from its `/api/hello` answer,
    send SIGTERM, and wait up to 10 s for it to stop answering. If it is still answering after
    10 s, `fail()` (stderr, exit 1). Then run `launch`.
- `POST /api/restart`:
  - Add a hook to `server.Server` (for example `Restart func() error`) that `main` sets. The
    handler calls it; on success it replies 202 and the server keeps running; when the hook
    reports that the binary is gone it replies 409 with `writeError(w, 409, "binary_missing")`;
    any other error is a 500.
  - The hook in `main`: `exe := os.Executable()`; if `os.Stat(exe)` fails, return the "binary
    gone" error. Otherwise start `<exe> relaunch <this server's flags>` detached: its own session
    (`Setsid`), stdout and stderr appended to `server.log` in the data folder, working folder the
    home folder, not waited for (reap it in a goroutine).
  - "This server's flags" are the arguments after the command that this server was started with
    (for `ai-whiteboard serve -home H -port P` that is `-home H -port P`; with no command, all
    arguments), so the relaunched server uses the same data folder, port, client folder and agent
    binaries.
  - The route sits behind the existing `guard`, like every other POST under `/api/`: it needs the
    active client's `X-AIWB-Client` header.
  - The handler never shuts the server down itself.
- `/api/hello` adds `webVersion`: read `version.json` (`{"version": "<v>"}`) from the server's
  client folder (`Server.Client`) on each request; `dev` when the client folder is empty, the file
  is missing, or it can't be parsed. `version` and `pid` stay as they are.
- `launch` stays as it is: it never stops a server, whatever its version.

## Verification (automated)

`go test ./...` and `go vet ./...` pass, with these tests added. The process-level tests build the
real binary into a temp folder, use a temp data folder (`-home`), a free port and `-client ""`,
skip under `testing.Short()`, and always stop their servers in cleanup. They never use port 4747
or `~/.ai-whiteboard`.

- `relaunch` with no server running behaves as `launch`: exit 0, stdout is exactly the URL line,
  and a server answers `/api/hello`.
- `relaunch` over a running server: prints the same URL; `/api/hello` then reports a different
  pid; the old pid is gone.
- `/api/restart` end to end: start a server with `launch`; become the active client by opening
  `GET /api/events?client=<id>`; `POST /api/restart` with `X-AIWB-Client: <id>` → 202; then
  `/api/hello` answers with a new pid within 45 s.
- Handler tests in `internal/server`: a `Restart` hook reporting the binary gone → 409
  `binary_missing`; a successful hook → 202 and the hook was called once.
- `/api/hello` returns `webVersion` from `version.json` in the client folder, and `dev` when the
  file is missing.
- `launch` against a running server whose `/api/hello` reports another version (httptest) prints
  that server's URL and the server keeps answering.
=====END BODY T03=====

---

## T04

- **Title:** Web: version stamping and the update banner (Restart server / Reload)
- **For agent:** yes
- **Blocked by:** T03

=====BEGIN BODY T04=====
## Why

After a new AI Whiteboard build is installed, a server started by the old build keeps running and
serves the new web files from disk, which can break. Starting the app never stops a server, so the
page must notice the mismatch and let the user decide when to restart. From the design's goal:

- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

## The design (verbatim)

### 4. Server from an older build (updates)

After installing a new `.app`, a server started by the old build keeps running. It keeps serving
`Contents/Resources/web` from disk, so the new web files end up on the old server, which can break.
`install-app.sh` already warns about this.

Starting the app never stops a server: a restart ends all running agent chats, so the user
decides when. `launch` connects to the running server whatever its version and prints its URL. The
page notices the mismatch and shows a banner at the bottom of the left sidebar.

#### How versions are determined

- `scripts/build-app.sh` computes one version, `V = git describe --tags --always --dirty`, and
  stamps it into both halves of the build:
  - Go: `-ldflags -X ai-whiteboard/internal/version.Version=V`, as now.
  - Web: `build.mjs` reads `V` from `AIWB_VERSION` (default `dev`), sets it in the bundle with an
    esbuild `define` (`__APP_VERSION__`), and writes `dist/version.json` = `{"version": V}`.
- `GET /api/hello` returns `version` (the running binary's, fixed when it started) and
  `webVersion`, read from `version.json` in the served client folder on each request (`dev` when
  the file is missing).
- On every connect and reconnect, the page calls `/api/hello` and compares three versions: its own
  (`page`), the server's (`server`) and the one on disk (`disk`):

  | Case | Meaning | Banner |
  |---|---|---|
  | all equal, or any is `dev` | nothing to do | none |
  | page = disk ≠ server | new app installed, old server still running | **Restart server** |
  | page ≠ disk | page loaded before the server was replaced | **Reload** |

- Why the version on disk: `git describe` strings can't be ordered. The files on disk always come
  from the newest install, so they show which side is stale.

#### Banner

- Stale server: "New version installed. The server is still running the old one." +
  **[Restart server]**.
- Stale page: "This page is out of date." + **[Reload]** (`location.reload()`, no restart).
- × hides the banner until the next reconnect.
- While restarting: "Restarting…". On failure: "Restart failed" + **[Retry]** **[Open log]** (in a
  browser tab, the path of `server.log` instead of Open log).

#### What "Restart server" does

1. If agents are running, confirm: "Restart ends N running agent chats." Otherwise no dialog.
2. Flush board changes (`window.aiwbFlush()`) and show "Restarting…". Drafts are already on the
   server.
3. `POST /api/restart`. The server only spawns `<os.Executable()> relaunch` detached (Setsid,
   output to `server.log`), replies 202 and keeps running. After an in-place install that path
   holds the new binary. If it is gone (app moved or deleted), the server replies 409 and the
   banner says to quit the app and run `ai-whiteboard relaunch`.
4. `relaunch` is **stop + launch**, and does the same when run from a terminal:
   - `findRunning()` → pid and port, check `/api/hello` is ours.
   - SIGTERM, wait up to 10 s. The server takes its normal SIGTERM path: flush, end agents,
     remove `server.json`, exit.
   - Then everything `launch` does: PATH from the login shell, start `serve` detached, poll
     `/api/hello` up to 30 s, print the URL, exit. Failure → stderr, exit 1.
   - With no server running, it is just `launch`.
5. The page polls `/api/hello` every 0.5 s until `version` differs from the old one, then
   `location.reload()`. No new version within 45 s → "Restart failed".
6. Other open clients reconnect to the new server, find page ≠ disk, and show **Reload**.

The HTTP endpoint never shuts the server down itself, so a restart from the banner and
`ai-whiteboard relaunch` in a terminal go through the same code.

### The work item

3. **Web: version banner** (see 4): `AIWB_VERSION` + `version.json` in `build.mjs`, the
   three-way compare on connect, the sidebar banner, the restart flow and Reload.

### Two clients

Nothing changes on the server, so `ai-whiteboard` from a terminal and the browser tab keep
working. The app window and a browser tab are just two clients. The editor bridge already handles
more than one client (active/pending client, `/api/client/release`).

## What the server already provides

- `GET /api/hello` → `{"app": "ai-whiteboard", "version": <running binary's version>, "pid": <pid>,
  "webVersion": <version.json of the served client folder, or "dev">}`.
- `POST /api/restart` → 202 (the server has started `relaunch` and keeps running for now), or 409
  `{"error": "binary_missing"}` when the server's program is gone. Like every POST under `/api/`
  it needs the active client's `X-AIWB-Client` header, which the helpers in `web/src/api.ts` add.
- The client already exposes `window.aiwbFlush()` in `web/src/main.tsx`: it resolves `true` once
  every board is written.
- Only one tab or window is the active client at a time; an older one is superseded and shows the
  "Opened in another window" screen until the user clicks "Use here", which connects it again.

## Details for this task

- `web/build.mjs`: `const version = process.env.AIWB_VERSION || "dev"`; add
  `__APP_VERSION__: JSON.stringify(version)` to the esbuild `define`; write `dist/version.json` as
  `{"version": "<version>"}` in both build and watch mode. Declare `__APP_VERSION__` for
  TypeScript (`declare const __APP_VERSION__: string`).
- The compare is a pure function in `web/src/logic/version.ts`, e.g.
  `bannerFor(page, server, disk): "none" | "restart" | "reload"`: `none` when any of the three is
  `dev` or all are equal; otherwise `reload` when `page ≠ disk`; otherwise (`page = disk ≠
  server`) `restart`.
- When: on every SSE `hello` event (each connect and reconnect, including after "Use here", in
  `web/src/conn.ts`), call `GET /api/hello` and set the banner state in the store. Page =
  `__APP_VERSION__`, server = `version`, disk = `webVersion`. A dismissed (×) banner shows again
  when the next reconnect computes it again.
- Where: at the bottom of the left sidebar (`web/src/Sidebar.tsx`).
- Texts exactly as in the design. The 409 text: "The server's program is gone (the app was moved
  or deleted). Quit the app and run `ai-whiteboard relaunch`."
- Running agent chats: chats whose `status` is `thinking`, `writing`, `tool` or `approval`. When
  there are N > 0, confirm with the existing `confirm()` dialog (`web/src/Dialogs.tsx`): body
  "Restart ends N running agent chats.", actions Cancel and Restart. With none, no dialog.
- Restart flow: remember the server's current `version`; `await window.aiwbFlush()`; show
  "Restarting…"; `POST /api/restart`; on 202 poll `GET /api/hello` every 500 ms until `version`
  differs, then `location.reload()`; after 45 s without a new version, or on a failed POST other
  than 409, show "Restart failed". While restarting, a reconnect's compare does not replace the
  "Restarting…" state.
- "Restart failed" shows **[Retry]** (runs the whole flow again, from the confirm) and:
  - in the desktop app, **[Open log]**, which calls `window.aiwbDesktop.openServerLog()`. The
    desktop app's preload exposes exactly that function; its presence is how the page knows it
    runs in the app. The page must work without it;
  - in a browser tab (no `window.aiwbDesktop`), the path `<dataDir>/server.log` as text, where
    `dataDir` is the data folder already in the client's store.
- **[Reload]** only calls `location.reload()`; it never restarts the server.

## Verification (automated)

- `cd web && npm test` passes, with new tests in `web/test/version.test.ts`:
  - every row of the table: all equal → none; any of the three `dev` → none; page = disk ≠
    server → restart; page ≠ disk → reload (including page ≠ disk = server);
  - the running-chat count and the confirm text ("Restart ends 2 running agent chats.") for a list
    of chats with mixed statuses (keep that logic in a pure helper so it can be tested).
- `cd web && node build.mjs` writes `dist/version.json` = `{"version":"dev"}`.
- `cd web && AIWB_VERSION=test-1 node build.mjs` writes `dist/version.json` =
  `{"version":"test-1"}` and `grep -q test-1 dist/main.js` succeeds; run `node build.mjs` again
  afterwards so `dist` is back to `dev`.
- `go test ./...` still passes.
=====END BODY T04=====

---

## T05

- **Title:** Desktop: Electron app that starts or finds the server through `ai-whiteboard launch`
- **For agent:** yes
- **Blocked by:** T01

=====BEGIN BODY T05=====
## Why

## Goal

- Replace "Go launcher opens a browser tab" with an Electron app window.
- The server stays the Go program (`cmd/ai-whiteboard`), unchanged in what it does.
- One `AI Whiteboard.app` holds everything: Electron, the Go binary, the built web client. Nothing
  gets installed outside the bundle.
- The app connects to a server that is already running, or starts one if none is.
- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

## What already exists

## What already exists (and stays)

The Go side already does almost all of the server lifecycle:

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.
- `serve` refuses to start a second server (it runs `findRunning` first) and removes
  `server.json` on SIGINT/SIGTERM.
- `bundleResources()` finds `Contents/Resources` when the binary is at `X.app/Contents/MacOS/…`,
  and serves the web client from `Contents/Resources/web`.
- `/api/hello` already returns `version` and `pid`.

So Electron must **not** reimplement discovery or start-up. It calls the Go binary's `launch` and
gets back a URL.

The Go binary never opens anything any more: `ai-whiteboard launch` finds the running server or
starts one detached, waits until it answers, prints its URL on stdout as the only line and exits
0; on failure it writes the message to stderr and exits 1.

## The design (verbatim)

### Bundle layout (what the app is loaded from)

- The renderer is the existing web client, loaded from the server URL. Electron does **not**
  bundle its own copy of the UI. The server stays the only thing serving it, so a browser tab and
  the app window show the same client.

### 2. Start-up: Electron asks the Go launcher

In the Electron main process, on `ready`:

```js
const bin = path.join(path.dirname(process.execPath), 'ai-whiteboard');
execFile(bin, ['launch'], { timeout: 40_000 }, (err, stdout, stderr) => {
  if (err) return showStartError(stderr);      // dialog: message + "Open server log" + "Retry"
  win.loadURL(stdout.trim());                  // e.g. http://127.0.0.1:4747/
});
```

- `launch` either finds the running server or starts one detached, waits until it answers, prints
  the URL, and **exits**. The server is never a child of Electron: it is a child of a launcher
  that already exited, in its own session. So quitting (or crashing) Electron can't take the
  server down, and Electron never needs a kill or `before-quit` hook.
- While `launch` runs, show a small "Starting…" window (or keep the main window hidden) so a
  30 s cold start doesn't look like a hang.

### 3. Only one app, only one server

- App: `app.requestSingleInstanceLock()`. A second launch focuses the existing window.

### 5. Window and client behaviour in Electron

- `BrowserWindow` loads `http://127.0.0.1:<port>/`, with `contextIsolation: true`,
  `nodeIntegration: false`, and no preload API needed at first.

- Quitting: macOS convention. Closing the last window keeps the app in the Dock; Cmd+Q quits
  Electron. The server keeps running either way.
- Remember window size and position (e.g. `electron-window-state`).

### 6. Browser tab still works

Nothing changes on the server, so `ai-whiteboard` from a terminal and the browser tab keep
working. The app window and a browser tab are just two clients. The editor bridge already handles
more than one client (active/pending client, `/api/client/release`).

### 7. Packaging (the folder)

- New folder `desktop/`: `package.json` (electron, electron-builder), `main.js`, and
  `electron-builder.yml`.

### 8. Development

- `cd desktop && npm start` runs Electron and points it at `../bin/ai-whiteboard` (or `go run`)
  through an env var such as `AIWB_SERVER_BIN`.
- Optional: `AIWB_URL=http://127.0.0.1:4747/` skips `launch` and just loads a server you already
  run in a terminal.

### The work items

5. **`desktop/` Electron app**: main process with the single-instance lock, a "Starting…" state,
   `launch` via `execFile`, error dialog (Retry, Open `~/.ai-whiteboard/server.log`), and
   `loadURL`.

10. **Dev mode**: `AIWB_SERVER_BIN` / `AIWB_URL`.

## Details for this task

- New folder `desktop/`:
  - `package.json`: `"private": true`, `"main": "main.js"`, scripts `"start": "electron ."` and
    `"test": "node --test test/"`; devDependencies `electron` and `electron-builder`; dependency
    `electron-window-state`. Commit `package-lock.json`.
  - `main.js` (Electron main process), `preload.js`, `lib.js` (pure helpers with no `electron`
    import, so `node --test` can load them), `test/*.test.js`, and `.gitignore` (`node_modules/`,
    `build/`, `dist/`).
  - The electron-builder config and `scripts/build-app.sh` are not part of this task.
- Server binary: `AIWB_SERVER_BIN` when set (in dev and in a packaged app alike); otherwise, when
  packaged (`app.isPackaged`), `path.join(path.dirname(process.execPath), 'ai-whiteboard')`;
  otherwise (`npm start`) `path.resolve(__dirname, '../bin/ai-whiteboard')`.
- Arguments: `['launch']`. When not packaged, also `-client <absolute path of ../web/dist>`: an
  unbundled binary serves `web/dist` relative to its working folder, which for the detached server
  is the home folder.
- `AIWB_URL` set: skip `launch` and load that URL.
- Single instance: call `app.requestSingleInstanceLock()` first; without the lock, `app.quit()`.
  On `second-instance`, restore the main window if minimized, show and focus it (or open it if
  there is none).
- "Starting…": while `launch` runs, show a small window (about 320×120, not resizable) with the
  text "Starting…"; the main window is created hidden and shown once its page has loaded, and then
  the Starting window closes. It also closes when the error dialog appears.
- Start error: `dialog.showMessageBox` (async) with message "AI Whiteboard could not start its
  server", detail = the stderr text (or the error message when stderr is empty), buttons
  `['Retry', 'Open server log', 'Quit']`. Retry runs `launch` again. Open server log calls
  `shell.openPath(path.join(os.homedir(), '.ai-whiteboard', 'server.log'))` and shows the dialog
  again. Quit calls `app.quit()`.
- Main window: `webPreferences` `{ contextIsolation: true, nodeIntegration: false, preload:
  <preload.js> }`. Size and position through `electron-window-state` (default 1280×800).
- Preload: the only API is `window.aiwbDesktop.openServerLog()`, exposed with `contextBridge`; it
  calls `ipcRenderer.invoke('aiwb:open-server-log')` and main answers with the same
  `shell.openPath` of `~/.ai-whiteboard/server.log`. The web client uses it for the Open log button
  of its update banner when it is present.
- Quitting follows the macOS convention: `window-all-closed` does not quit; `activate` with no
  window runs the start-up again (`launch`, then the window). Cmd+Q (Electron's default app menu)
  quits. There is no `before-quit` hook, kill or stop for the server; the server is never a child
  of Electron.
- Keep Electron's default application menu.
- Put the testable logic in `lib.js`, for example `serverBin({ env, execPath, isPackaged, dirname
  })`, `launchArgs({ isPackaged, dirname })`, `parseLaunchOutput(stdout)` (the trimmed output
  must be one http(s) URL, otherwise it is an error), and a start-up runner that takes its
  collaborators as parameters (`execFile`, show/hide Starting, load URL, show error) so it can be
  tested with fakes.
- Link handling, reconnecting after connection loss, and waiting for board saves on close are not
  part of this task.

## Verification (automated)

- `cd desktop && npm ci && npm test` passes, with tests for:
  - `serverBin`: `AIWB_SERVER_BIN` wins; packaged → next to `process.execPath`; dev →
    `../bin/ai-whiteboard`;
  - `launchArgs`: packaged → `['launch']`; dev → `['launch', '-client', <abs ../web/dist>]`;
  - `parseLaunchOutput`: `"http://127.0.0.1:4747/\n"` → that URL; empty or non-URL output → error;
  - the start-up runner with a fake `execFile`: success → Starting shown, the URL loaded, Starting
    hidden; failure → the error shown with the stderr text; Retry → `execFile` called again with
    the same binary and arguments; `AIWB_URL` → no `execFile` call.
- `node --check desktop/main.js desktop/preload.js desktop/lib.js` succeeds.
- `cd desktop && npx electron --version` prints a version.
=====END BODY T05=====

---

## T06

- **Title:** Desktop: links leave the app window for the default browser
- **For agent:** yes
- **Blocked by:** T05

=====BEGIN BODY T06=====
## Why

In the Electron app window, chat links and links on whiteboard elements would otherwise open in a
bare new app window. They must open in the user's default browser, and the window must stay on
the server's origin.

## What already exists

`desktop/` holds the Electron app: `main.js` creates the main `BrowserWindow`
(`contextIsolation: true`, `nodeIntegration: false`, a preload) and loads the server URL that
`ai-whiteboard launch` prints (`http://127.0.0.1:<port>/`); `lib.js` holds pure helpers with no
`electron` import, tested with `node --test` (`npm test` in `desktop/`).

## The design (verbatim)

- **Links open in the default browser.** Chat links (`Markdown.tsx`, `target="_blank"`) and links
  on Excalidraw elements both go through `window.open`. Without a handler, Electron would open them
  in a bare new app window. Any link that would leave the server's origin goes to
  `shell.openExternal`, which opens the user's default browser. Only `http`, `https` and `mailto`
  are opened; anything else (`file:`, `javascript:`) is dropped.

  ```js
  const appOrigin = new URL(url).origin;
  const openOutside = (u) => { if (/^(https?|mailto):/i.test(u)) shell.openExternal(u); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => {
    if (new URL(u).origin !== appOrigin) { e.preventDefault(); openOutside(u); }
  });
  ```

### The work item

6. **Navigation rules** (code in 5): `setWindowOpenHandler` + `will-navigate` →
   `shell.openExternal` (default browser); the window stays on the server origin.

## Details for this task

- Put the decision in `lib.js`, e.g. `linkAction(url, appOrigin)` returning `'stay'` (same origin
  as the app), `'open'` (another origin, and the scheme is `http`, `https` or `mailto`) or
  `'drop'` (anything else, such as `file:`, `javascript:`, `data:`); unparsable URLs are dropped.
- `setWindowOpenHandler` always returns `{ action: 'deny' }` and opens the URL outside when its
  scheme is allowed, as in the design's code.
- `will-navigate` to another origin is prevented and the URL opened outside when allowed;
  same-origin navigation goes through.
- Attach both handlers to every main window the app creates. Take `appOrigin` from the URL the
  window loads, and update it whenever the window loads a new server URL.
- Only `main.js`, `lib.js` and tests change.

## Verification (automated)

- `cd desktop && npm test` passes, with tests for:
  - `linkAction`: `https://example.com/` → open; `http://127.0.0.1:9999/` from app origin
    `http://127.0.0.1:4747` → open; `mailto:a@b.c` → open; `file:///etc/hosts`,
    `javascript:alert(1)`, `data:text/html,x` → drop; `http://127.0.0.1:4747/?x=1` → stay;
  - the handlers attached to a fake window (EventEmitter `webContents` with a recorded
    `setWindowOpenHandler`, a recording `shell`): window.open of an allowed URL → one
    `openExternal` call and `{ action: 'deny' }`; of a `file:` URL → no call and deny;
    `will-navigate` to another origin → `preventDefault` called and `openExternal` called;
    same origin → neither.
- `node --check desktop/main.js desktop/lib.js` succeeds.
=====END BODY T06=====

---

## T07

- **Title:** Desktop: reconnect by running launch again when the server is gone
- **For agent:** yes
- **Blocked by:** T06

=====BEGIN BODY T07=====
## Why

The server can crash or be stopped while the app window is open. The app never stops the server,
but it should bring it back: running `ai-whiteboard launch` again restarts a crashed server, and
the window then reloads.

## What already exists

`desktop/` holds the Electron app: `main.js` runs `ai-whiteboard launch` with `execFile` (binary
from `AIWB_SERVER_BIN`, next to `process.execPath` when packaged, or `../bin/ai-whiteboard` in
dev), loads the URL it prints into the main `BrowserWindow`, and shows an error dialog when the
first start fails; `lib.js` holds pure helpers with no `electron` import, tested with
`node --test` (`npm test` in `desktop/`). `launch` finds the running server or starts one
detached, prints its URL as the only stdout line and exits; on failure it writes to stderr and
exits 1.

## The design (verbatim)

- Connection loss (server crashed or was stopped): the client's SSE reconnect already shows the
  state. Add a main-process retry: if the page can't load or SSE stays down, run `launch` again
  and reload. That restarts a crashed server.

- Quitting: macOS convention. Closing the last window keeps the app in the Dock; Cmd+Q quits
  Electron. The server keeps running either way.

### The work item

7. **Reconnect**: on load failure or long SSE loss, run `launch` again and reload.

## Details for this task

- "SSE stays down" is detected from the main process: once the main window has loaded, main asks
  `GET <origin>/api/hello` every 2 s (1 s timeout; it counts only a JSON answer with
  `app == "ai-whiteboard"`). After 3 failures in a row, or at once on a `did-fail-load` of the main
  frame (ignoring error code -3, an aborted load), it runs `launch` again with the same binary and
  arguments as at start-up and, on success, loads the URL it prints.
- If that `launch` fails, try again 5 s later. No dialog: the page already shows that it is
  disconnected.
- Never run two `launch` at once; a trigger while one runs is ignored.
- Stop checking while no main window is open or the app is quitting; resume when a window opens.
- Put the logic in `lib.js` as a reconnector that takes its collaborators and timer functions as
  parameters (check, launch, load, setTimeout/clearTimeout), so it can be tested with a fake clock.
- Only `main.js`, `lib.js` and tests change.

## Verification (automated)

- `cd desktop && npm test` passes, with tests (fake clock and fakes) for:
  - 1 or 2 failed checks → no launch; 3 in a row → exactly one launch, then the printed URL is
    loaded and the failure count resets;
  - a successful check between failures resets the count;
  - `did-fail-load` → launch at once; error code -3 → nothing;
  - launch fails → a new launch 5 s later, no dialog;
  - a second trigger while a launch runs → still one launch;
  - stopped (window closed / quitting) → no checks.
- `node --check desktop/main.js desktop/lib.js` succeeds.
=====END BODY T07=====

---

## T08

- **Title:** Desktop: closing, reloading or quitting waits for board saves
- **For agent:** yes
- **Blocked by:** T07

=====BEGIN BODY T08=====
## Why

Board edits are saved to the server shortly after they are made. In a browser, closing with
pending saves shows a "Leave page?" prompt; in Electron the close is cancelled silently, so the
app must wait for the saves itself and then finish the close, quit or reload. Quitting never
touches the server.

## What already exists

- `desktop/` holds the Electron app: `main.js` creates the main `BrowserWindow` and loads the
  server URL; `lib.js` holds pure helpers with no `electron` import, tested with `node --test`
  (`npm test` in `desktop/`). Closing the last window keeps the app running; Cmd+Q quits it.
- The web side is done: in `web/src/main.tsx`, `beforeunload` calls `e.preventDefault()` when
  saves are pending, and `window.aiwbFlush()` resolves `true` once every board is written.

## The design (verbatim)

- **Closing waits for board saves.** When saves are pending, the client's `beforeunload` calls
  `e.preventDefault()` (`web/src/main.tsx`). A browser turns that into a "Leave page?" prompt.
  Electron instead cancels the close (or reload, or Cmd+Q) silently and fires
  `will-prevent-unload`. Main uses that event:
  1. The close stays cancelled for now.
  2. Main waits for `window.aiwbFlush()`, which the client exposes. It resolves `true` once every
     board is written.
  3. Main then does the same action again: close the window, `app.quit()` if this was Cmd+Q, or
     reload. This time nothing is pending, so it goes through.
  4. If the flush doesn't finish within 10 s (server down), a dialog asks
     "Board changes are not saved. Close anyway?". Choosing "Close anyway" lets the next
     `will-prevent-unload` through.
  With no pending saves none of this runs, and the window closes at once.

  ```js
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });

  let closing = false, force = false;
  win.on('close', () => { closing = true; });            // fires before beforeunload
  win.webContents.on('will-prevent-unload', async (e) => {
    if (force) { force = false; e.preventDefault(); return; }  // preventDefault = unload anyway
    const wasClosing = closing, wasQuitting = quitting;
    closing = quitting = false;                          // the close/quit was cancelled
    if (!(await flushed(win))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: 'Board changes are not saved.',
        detail: 'The server did not answer. Close anyway and lose them?',
        buttons: ['Cancel', 'Close anyway'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return;
      force = true;
    }
    if (wasQuitting) app.quit();
    else if (wasClosing) win.close();
    else win.webContents.reload();
  });

  function flushed(win) {
    const done = win.webContents.executeJavaScript('window.aiwbFlush ? window.aiwbFlush() : false', true);
    const timeout = new Promise((r) => setTimeout(() => r(false), 10_000));
    return Promise.race([done, timeout]).then((v) => v === true, () => false);
  }
  ```

  Quitting never touches the server; this only makes sure the page has written its boards.
  **Test: edit a board and press Cmd+Q within 500 ms. The app quits, and the edit is in the
  board file. Stop the server, edit and close: the dialog appears.**

- Quitting: macOS convention. Closing the last window keeps the app in the Dock; Cmd+Q quits
  Electron. The server keeps running either way.

### The work item

8. **Close/quit flush** (code in 5): `will-prevent-unload` → await `window.aiwbFlush()` →
   close / quit / reload again; dialog if the flush times out. The web side (`aiwbFlush` in
   `web/src/main.tsx`) is done. Nothing touches the server on quit.

## Details for this task

- Put the design's code in `lib.js` as a function that takes its collaborators, e.g.
  `attachCloseFlush({ app, win, dialog, flushTimeoutMs = 10_000 })`, keeping the design's
  behaviour, dialog texts and buttons exactly; `main.js` calls it for every main window it creates.
  Register the app-wide `before-quit` listener only once, not once per window.
- Nothing in this task stops, signals or calls the server.
- Only `main.js`, `lib.js` and tests change.

## Verification (automated)

- `cd desktop && npm test` passes, with tests using fake `app`, `win`, `webContents` (EventEmitters
  with recorded `close`, `reload`, `executeJavaScript`) and a recording `dialog`:
  - `close` then `will-prevent-unload`, flush resolves `true` → `win.close()` called again, no
    dialog;
  - `before-quit` then `will-prevent-unload`, flush `true` → `app.quit()` called;
  - `will-prevent-unload` with neither → `webContents.reload()`;
  - flush never resolves (short `flushTimeoutMs`) → the dialog is shown with message
    `Board changes are not saved.`, detail `The server did not answer. Close anyway and lose
    them?`, buttons `['Cancel', 'Close anyway']`; response 0 → nothing else happens; response 1 →
    the action is repeated and the next `will-prevent-unload` calls `e.preventDefault()`;
  - `executeJavaScript` rejects → treated as not flushed.
- `node --check desktop/main.js desktop/lib.js` succeeds.
=====END BODY T08=====

---

## T09

- **Title:** Packaging: build AI Whiteboard.app with electron-builder, and update the docs
- **For agent:** yes
- **Blocked by:** T03, T04, T05

=====BEGIN BODY T09=====
## Why

## Goal

- Replace "Go launcher opens a browser tab" with an Electron app window.
- The server stays the Go program (`cmd/ai-whiteboard`), unchanged in what it does.
- One `AI Whiteboard.app` holds everything: Electron, the Go binary, the built web client. Nothing
  gets installed outside the bundle.
- The app connects to a server that is already running, or starts one if none is.
- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

## What already exists

## What already exists (and stays)

The Go side already does almost all of the server lifecycle:

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.
- `serve` refuses to start a second server (it runs `findRunning` first) and removes
  `server.json` on SIGINT/SIGTERM.
- `bundleResources()` finds `Contents/Resources` when the binary is at `X.app/Contents/MacOS/…`,
  and serves the web client from `Contents/Resources/web`.
- `/api/hello` already returns `version` and `pid`.

So Electron must **not** reimplement discovery or start-up. It calls the Go binary's `launch` and
gets back a URL.

- `desktop/` holds the Electron app (`package.json` with `electron`, `electron-builder` and
  `electron-window-state`, `main.js`, `preload.js`, `lib.js`). It runs `ai-whiteboard launch` from
  `path.join(path.dirname(process.execPath), 'ai-whiteboard')` when packaged.
- `web/build.mjs` reads `AIWB_VERSION` (default `dev`), stamps it into the bundle and writes
  `dist/version.json`.
- The Go binary has a `relaunch` command (stop the running server, then launch).
- Today `scripts/build-app.sh` builds a bundle whose executable is the Go binary, writes
  `Info.plist` by hand (with `LSUIElement`) and signs ad hoc with `codesign --force --sign -`.

## The design (verbatim)

### 1. Bundle layout

### 1. Bundle layout

```
AI Whiteboard.app/Contents/
  MacOS/AI Whiteboard        Electron (CFBundleExecutable)
  MacOS/ai-whiteboard        Go binary (electron-builder "extraFiles")
  Frameworks/...             Electron frameworks + helpers
  Resources/app.asar         Electron main + preload only (small)
  Resources/web/             built web client (web/dist), served by the Go server
  Resources/AppIcon.icns
```

- The Go binary sits in `Contents/MacOS/`, so the existing `bundleResources()` and `-client`
  default work with no change.
- It must be outside `app.asar`: a binary can't be run from inside an asar.
- The renderer is the existing web client, loaded from the server URL. Electron does **not**
  bundle its own copy of the UI. The server stays the only thing serving it, so a browser tab and
  the app window show the same client.
- `Info.plist`: `CFBundleExecutable` becomes the Electron binary, and `LSUIElement` goes away (the
  app now has a window and a Dock icon). Keep `CFBundleIdentifier` `local.ai-whiteboard`.

### How versions are determined

- `scripts/build-app.sh` computes one version, `V = git describe --tags --always --dirty`, and
  stamps it into both halves of the build:
  - Go: `-ldflags -X ai-whiteboard/internal/version.Version=V`, as now.
  - Web: `build.mjs` reads `V` from `AIWB_VERSION` (default `dev`), sets it in the bundle with an
    esbuild `define` (`__APP_VERSION__`), and writes `dist/version.json` = `{"version": V}`.

### 7. Packaging

- New folder `desktop/`: `package.json` (electron, electron-builder), `main.js`, and
  `electron-builder.yml`.
- `scripts/build-app.sh` becomes:
  1. build the web client (`AIWB_VERSION=V node web/build.mjs`), which also writes
     `version.json` (see 4)
  2. `go build` with the version ldflag into `desktop/build/ai-whiteboard`, as now
  3. `electron-builder --mac --dir`, with:
     - `extraFiles`: `ai-whiteboard` → `Contents/MacOS/ai-whiteboard`
     - `extraResources`: `web/dist` → `web`, and `AppIcon.icns`
     - `appId: local.ai-whiteboard`, `productName: AI Whiteboard`
     - ad-hoc signing like today (`identity: "-"`), or a real identity later. electron-builder
       signs the nested Go binary too.
  4. output `bin/AI Whiteboard.app`
- `install-app.sh` stays as is.

### 4. Server from an older build (updates)

After installing a new `.app`, a server started by the old build keeps running. It keeps serving
`Contents/Resources/web` from disk, so the new web files end up on the old server, which can break.
`install-app.sh` already warns about this.

Starting the app never stops a server: a restart ends all running agent chats, so the user
decides when. `launch` connects to the running server whatever its version and prints its URL. The
page notices the mismatch and shows a banner at the bottom of the left sidebar.

### The work items

9. **Packaging**: electron-builder config, new `scripts/build-app.sh`, Info.plist without
   `LSUIElement`, icon, ad-hoc signing.

11. **Docs**: update `docs/PROJECT.md` (the client is Electron now, not "React Native later"),
    and the `install-app.sh` note.

## Details for this task

- `desktop/electron-builder.yml`:
  - `appId: local.ai-whiteboard`, `productName: AI Whiteboard`, `directories.output: dist`;
  - `files`: `main.js`, `preload.js`, `lib.js`, `package.json` (electron-builder adds the runtime
    dependency `electron-window-state`), `asar: true`;
  - `extraFiles`: `build/ai-whiteboard` → `MacOS/ai-whiteboard`;
  - `extraResources`: `../web/dist` → `web`, `../assets/icon/AppIcon.icns` → `AppIcon.icns`;
  - `mac`: `target: dir`, `icon: ../assets/icon/AppIcon.icns`, `identity: "-"`,
    `hardenedRuntime: false`; no `LSUIElement` anywhere.
- `scripts/build-app.sh` keeps computing `version` as today and then:
  1. `cd web`, `[ -d node_modules ] || npm ci`, `AIWB_VERSION="$version" node build.mjs`;
  2. `go build -C "$root" -ldflags "-X ai-whiteboard/internal/version.Version=$version" -o
     "$root/desktop/build/ai-whiteboard" ./cmd/ai-whiteboard`;
  3. `cd desktop`, `[ -d node_modules ] || npm ci`, `npx electron-builder --mac --dir
     -c.buildVersion="$version"` (so `CFBundleVersion` stays the version, as today);
  4. `rm -rf "$app"` and `ditto` the built `AI Whiteboard.app` from `desktop/dist/mac*/` to
     `bin/AI Whiteboard.app`.
  The hand-written `Info.plist` and the `codesign` line go away; the header comment describes the
  new bundle.
- `scripts/install-app.sh` keeps its steps; only its closing note changes: when a server from the
  previous build is running, say that the app will offer to restart it (Restart server, at the
  bottom of the sidebar), or run `"$dest/Contents/MacOS/ai-whiteboard" relaunch`.
- `docs/PROJECT.md`: the client is the web client, shown in the Electron app window
  (`desktop/`, `AI Whiteboard.app`) or in a browser tab; drop "a React Native macOS app later".
  Also update the "Server-first" bullet (`ai-whiteboard` starts or finds the server and prints its
  URL; the app opens the window) and the architecture sketch's client line.

## Verification (automated)

- `scripts/build-app.sh` exits 0 and produces `bin/AI Whiteboard.app`.
- In it: `Contents/MacOS/AI Whiteboard` and `Contents/MacOS/ai-whiteboard` are executable;
  `Contents/Resources/app.asar`, `Contents/Resources/web/index.html` and
  `Contents/Resources/AppIcon.icns` exist; `Contents/Resources/web/version.json` is
  `{"version": V}` with V = `git describe --tags --always --dirty`.
- `plutil -extract CFBundleExecutable raw` → `AI Whiteboard`; `CFBundleIdentifier` →
  `local.ai-whiteboard`; `CFBundleVersion` → V; `plutil -extract LSUIElement raw` fails (absent).
- `codesign --verify --deep --strict "bin/AI Whiteboard.app"` succeeds.
- `npx @electron/asar list "bin/AI Whiteboard.app/Contents/Resources/app.asar"` lists `main.js`,
  `preload.js`, `lib.js`, `package.json` and `electron-window-state` (with its own dependencies)
  only: no web client files, no Go binary.
- The bundled Go binary, with a temp data folder and a free port (never 4747 or
  `~/.ai-whiteboard`): `"bin/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" launch -home <tmp>
  -port <free>` prints the URL; its `/api/hello` reports `version` V and `webVersion` V (the
  bundle's own web folder); then `... stop -home <tmp> -port <free>`.
- `bash -n scripts/install-app.sh` succeeds; `grep -n "React Native" docs/PROJECT.md` no longer
  presents React Native as the planned client.
=====END BODY T09=====

---

## T10

- **Title:** Environment `terminal` for the terminal launch/serve check
- **For agent:** yes
- **Blocked by:** T01, T02, T03

=====BEGIN BODY T10=====
## Why

An automated check, "Check: `ai-whiteboard launch` and `serve` in a terminal print the URL and open nothing", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`terminal`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-terminal` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-terminal/home` |
| Port (`$AIWB_ENV_PORT`) | `4761` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4761/` |
| Go binary (`$AIWB_ENV_BIN`) | `/tmp/aiwb-env-terminal/live/ai-whiteboard` |
| Web client (`$AIWB_ENV_CLIENT`) | `/tmp/aiwb-env-terminal/live/web` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-terminal/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4761 -client "$AIWB_ENV_CLIENT" <other args>` with `exec` |
| Spare port (`$AIWB_ENV_SPARE_PORT`) | `4771` (nothing listens there) |
| Variables | `source /tmp/aiwb-env-terminal/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-terminal/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-terminal/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-terminal` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-terminal/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-terminal` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-terminal` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-terminal`. Create
   `/tmp/aiwb-env-terminal` and `/tmp/aiwb-env-terminal/home`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock:
   - `go build -C /Users/pedjat/Documents/projects/ai-whiteboard -o /tmp/aiwb-env-terminal/live/ai-whiteboard ./cmd/ai-whiteboard` (no version
     stamp: the binary reports `dev`);
   - `cd /Users/pedjat/Documents/projects/ai-whiteboard/web && ([ -d node_modules ] || npm ci) && node build.mjs`, then
     `cp -R /Users/pedjat/Documents/projects/ai-whiteboard/web/dist /tmp/aiwb-env-terminal/live/web`.

3. Write `/tmp/aiwb-env-terminal/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-terminal/live/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-terminal/home" -port 4761 -client "/tmp/aiwb-env-terminal/live/web" "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-terminal`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-terminal/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-terminal/stop.sh` and `/tmp/aiwb-env-terminal/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-terminal/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-terminal/env.sh`; nothing answers on port `4761` before starting (and nothing on the spare port 4771).
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- `/tmp/aiwb-env-terminal/live/ai-whiteboard` and `/tmp/aiwb-env-terminal/live/web/index.html` exist.
- `/tmp/aiwb-env-terminal/stop.sh` exits 0; afterwards nothing answers on port `4761` and no process matches
  `-home $AIWB_ENV_HOME`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-terminal/home` may keep the data the trial run
  wrote).
=====END BODY T10=====

---

## T11

- **Title:** Check: `ai-whiteboard launch` and `serve` in a terminal print the URL and open nothing
- **For agent:** yes
- **Blocked by:** T10, T01

=====BEGIN BODY T11=====
## What to confirm

The Go binary never opens anything: run from a terminal, `launch` and `serve` print where the server is, and a browser tab is opened by the user, not by the binary. A browser tab on the printed URL still works.

From the design (verbatim):

- `serve` boots the server exactly as now. If a server is already running, it prints
  `AI Whiteboard is already running at <url>` (as now) and exits, without opening it. When it
  starts, it logs the URL as now.
- `launch` does everything it does now: find the running server, or take PATH from the login
  shell, start `serve` detached (Setsid, output to `server.log`), and poll `/api/hello` for up to
  30 s. The only difference is the end: instead of opening the URL, it **prints the URL on
  stdout** as the only line (`http://127.0.0.1:4747/`). It prints the same way whether it found a
  server or started one, so Electron and scripts can read it.
- Failures: `fail()` writes the message to stderr and exits 1. The `osascript` alert goes away.
  It was there only because a Finder or Spotlight launch had no terminal. With Electron as the
  bundle's executable, Finder never runs the Go binary directly, and Electron shows the stderr
  text in its own dialog.
- Using a browser tab instead of the app: run `ai-whiteboard launch` (or `serve`) and open the
  printed URL yourself.

### 6. Browser tab still works

Nothing changes on the server, so `ai-whiteboard` from a terminal and the browser tab keep
working. The app window and a browser tab are just two clients. The editor bridge already handles
more than one client (active/pending client, `/api/client/release`).

The check, as the design lists it:

- `ai-whiteboard launch` / `serve` in a terminal → prints the URL, no browser opens.

Also: with no command the binary runs `serve` (never `launch`), and the `-no-open` flag no longer
exists.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-terminal`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the Go binary's command-line behaviour: `launch` prints the URL as its only stdout line and opens nothing; `serve` opens nothing; failures go to stderr with exit 1 and no alert; no command means `serve`; `-no-open` is gone.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-terminal/env.sh`. If `/tmp/aiwb-env-terminal/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`terminal`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-terminal` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-terminal/home` |
| Port (`$AIWB_ENV_PORT`) | `4761` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4761/` |
| Go binary (`$AIWB_ENV_BIN`) | `/tmp/aiwb-env-terminal/live/ai-whiteboard` |
| Web client (`$AIWB_ENV_CLIENT`) | `/tmp/aiwb-env-terminal/live/web` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-terminal/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4761 -client "$AIWB_ENV_CLIENT" <other args>` with `exec` |
| Spare port (`$AIWB_ENV_SPARE_PORT`) | `4771` (nothing listens there) |
| Variables | `source /tmp/aiwb-env-terminal/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-terminal/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-terminal/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-terminal` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-terminal/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-terminal` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-terminal/env.sh`. Make `$AIWB_ENV/shims/` with two executable scripts, `open` and
   `osascript`, that append their name and arguments to `$AIWB_ENV/shims/calls.log` and exit 0,
   and an executable `$AIWB_ENV/shims/fake-shell` that ignores its arguments and prints a newline,
   then `__AIWB_PATH__$AIWB_ENV/shims:/usr/bin:/bin:/usr/sbin:/sbin`, then a newline. `launch`
   takes PATH from the login shell by running `$SHELL -ilc` and reading the line after the marker
   `__AIWB_PATH__`, so with `SHELL=$AIWB_ENV/shims/fake-shell` and
   `PATH=$AIWB_ENV/shims:$PATH` any `open` or `osascript` the binary (or the server it starts) runs
   lands in `calls.log`. Run every command below with those two variables set.
1. Nothing answers on `$AIWB_ENV_PORT`. `"$AIWB_ENV_WRAPPER" launch` → exit 0 within 35 s; stdout is
   exactly one line, equal to `$AIWB_ENV_URL`. `GET ${AIWB_ENV_URL}api/hello` → `app` is
   `ai-whiteboard`; remember its `pid`.
2. `"$AIWB_ENV_WRAPPER" launch` again → exit 0; stdout exactly the same one line; `/api/hello` pid
   unchanged.
3. `"$AIWB_ENV_WRAPPER" serve` while the server runs → exit 0 within 5 s; its output contains
   `AI Whiteboard is already running at` followed by the server URL; pid unchanged.
4. Browser tab: Playwright `chromium` opens `$AIWB_ENV_URL`. Pass: the app's sidebar
   (`.side-pane`) is visible within 15 s and the page shows no "Opened in another window" screen.
   Close the browser.
5. `"$AIWB_ENV_WRAPPER" stop` → nothing answers on the port within 10 s. Then start
   `"$AIWB_ENV_WRAPPER" serve` in the background, capturing its output. Pass: within 30 s the
   output contains `http://127.0.0.1:$AIWB_ENV_PORT` and `/api/hello` answers. Send it SIGTERM →
   it exits within 10 s and `$AIWB_ENV_HOME/server.json` is gone.
6. No command: start `"$AIWB_ENV_BIN" -home "$AIWB_ENV_HOME" -port $AIWB_ENV_PORT -client "$AIWB_ENV_CLIENT"`
   in the background. Pass: it stays in the foreground as a server (the process is still running
   after 3 s and `/api/hello` answers with that process's pid). SIGTERM it.
7. `"$AIWB_ENV_BIN" serve -no-open -home "$AIWB_ENV_HOME" -port $AIWB_ENV_PORT` → exits non-zero
   with a "flag provided but not defined" error, and nothing answers on the port.
8. Failure goes to stderr: start a listener on `$AIWB_ENV_SPARE_PORT` that is not AI Whiteboard
   (`python3 -m http.server $AIWB_ENV_SPARE_PORT --bind 127.0.0.1` in the background). Run
   `"$AIWB_ENV_BIN" launch -home "$AIWB_ENV/home-fail" -port $AIWB_ENV_SPARE_PORT -client "$AIWB_ENV_CLIENT"`.
   Pass: exit 1 within 40 s; stdout empty; stderr starts with `AI Whiteboard: `. Kill the listener
   and any process matching `-home $AIWB_ENV/home-fail`.
9. `$AIWB_ENV/shims/calls.log` does not exist or is empty: no `open` and no `osascript` ran.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-terminal-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-terminal/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T11=====

---

## T12

- **Title:** Environment `banner` for the version banner check in browser tabs
- **For agent:** yes
- **Blocked by:** T03, T04

=====BEGIN BODY T12=====
## Why

An automated check, "Check: version banner, Restart server, Reload and `relaunch` in browser tabs", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`banner`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-banner` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-banner/home` |
| Port (`$AIWB_ENV_PORT`) | `4762` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4762/` |
| Go binary (`$AIWB_ENV_BIN`) | `/tmp/aiwb-env-banner/live/ai-whiteboard` |
| Web client (`$AIWB_ENV_CLIENT`) | `/tmp/aiwb-env-banner/live/web` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-banner/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4762 -client "$AIWB_ENV_CLIENT" <other args>` with `exec` |
| Builds of three versions | `/tmp/aiwb-env-banner/versions/e2e-v1`, `.../e2e-v2`, `.../e2e-v3`, each holding `ai-whiteboard` (Go binary stamped with that version) and `web/` (web client stamped with that version, with its `version.json`) |
| Install a version in place | `/tmp/aiwb-env-banner/install.sh <v>`, where `<v>` is `e2e-v1`, `e2e-v2` or `e2e-v3`: `rm -rf "$AIWB_ENV/live"` then `cp -R "$AIWB_ENV/versions/<v>" "$AIWB_ENV/live"`, like an in-place install: a running server keeps running its old program, while the files on disk (binary and web client) become the new version |
| Variables | `source /tmp/aiwb-env-banner/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-banner/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-banner/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-banner` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-banner/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-banner` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-banner` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-banner`. Create
   `/tmp/aiwb-env-banner` and `/tmp/aiwb-env-banner/home`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock, for each `v` in `e2e-v1`, `e2e-v2`, `e2e-v3`:
   - `go build -C /Users/pedjat/Documents/projects/ai-whiteboard -ldflags "-X ai-whiteboard/internal/version.Version=$v" -o /tmp/aiwb-env-banner/versions/$v/ai-whiteboard ./cmd/ai-whiteboard`;
   - `cd /Users/pedjat/Documents/projects/ai-whiteboard/web && ([ -d node_modules ] || npm ci) && AIWB_VERSION=$v node build.mjs`, then
     `cp -R /Users/pedjat/Documents/projects/ai-whiteboard/web/dist /tmp/aiwb-env-banner/versions/$v/web`.

   Then, still under the lock, `cd /Users/pedjat/Documents/projects/ai-whiteboard/web && node build.mjs` so `web/dist` is left as a plain
   (`dev`) build. Install `e2e-v1`: `cp -R /tmp/aiwb-env-banner/versions/e2e-v1 /tmp/aiwb-env-banner/live`.
   Write `/tmp/aiwb-env-banner/install.sh` (executable) as described in the table.

3. Write `/tmp/aiwb-env-banner/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-banner/live/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-banner/home" -port 4762 -client "/tmp/aiwb-env-banner/live/web" "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-banner`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-banner/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-banner/stop.sh` and `/tmp/aiwb-env-banner/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-banner/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-banner/env.sh`; nothing answers on port `4762` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- For each version, `/tmp/aiwb-env-banner/versions/<v>/web/version.json` is `{"version":"<v>"}`.
- In the trial run above, before stopping: `/api/hello` reports `version` `e2e-v1` and `webVersion`
  `e2e-v1`. Then `/tmp/aiwb-env-banner/install.sh e2e-v2` while the server runs → `/api/hello` still
  reports `version` `e2e-v1` with the same pid, and `webVersion` `e2e-v2`.
- After `stop.sh`, run `/tmp/aiwb-env-banner/install.sh e2e-v1` so the environment is left with `e2e-v1`
  installed.
- `/tmp/aiwb-env-banner/stop.sh` exits 0; afterwards nothing answers on port `4762` and no process matches
  `-home $AIWB_ENV_HOME`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-banner/home` may keep the data the trial run
  wrote).
=====END BODY T12=====

---

## T13

- **Title:** Check: version banner, Restart server, Reload and `relaunch` in browser tabs
- **For agent:** yes
- **Blocked by:** T12, T03, T04

=====BEGIN BODY T13=====
## What to confirm

When the server runs an older build than the files on disk, the page offers to restart it; when the page is older than the files on disk, it offers to reload; restarting from the banner and `ai-whiteboard relaunch` in a terminal give the same result.

From the design (verbatim):

### 4. Server from an older build (updates)

After installing a new `.app`, a server started by the old build keeps running. It keeps serving
`Contents/Resources/web` from disk, so the new web files end up on the old server, which can break.
`install-app.sh` already warns about this.

Starting the app never stops a server: a restart ends all running agent chats, so the user
decides when. `launch` connects to the running server whatever its version and prints its URL. The
page notices the mismatch and shows a banner at the bottom of the left sidebar.

#### How versions are determined

- `scripts/build-app.sh` computes one version, `V = git describe --tags --always --dirty`, and
  stamps it into both halves of the build:
  - Go: `-ldflags -X ai-whiteboard/internal/version.Version=V`, as now.
  - Web: `build.mjs` reads `V` from `AIWB_VERSION` (default `dev`), sets it in the bundle with an
    esbuild `define` (`__APP_VERSION__`), and writes `dist/version.json` = `{"version": V}`.
- `GET /api/hello` returns `version` (the running binary's, fixed when it started) and
  `webVersion`, read from `version.json` in the served client folder on each request (`dev` when
  the file is missing).
- On every connect and reconnect, the page calls `/api/hello` and compares three versions: its own
  (`page`), the server's (`server`) and the one on disk (`disk`):

  | Case | Meaning | Banner |
  |---|---|---|
  | all equal, or any is `dev` | nothing to do | none |
  | page = disk ≠ server | new app installed, old server still running | **Restart server** |
  | page ≠ disk | page loaded before the server was replaced | **Reload** |

- Why the version on disk: `git describe` strings can't be ordered. The files on disk always come
  from the newest install, so they show which side is stale.

#### Banner

- Stale server: "New version installed. The server is still running the old one." +
  **[Restart server]**.
- Stale page: "This page is out of date." + **[Reload]** (`location.reload()`, no restart).
- × hides the banner until the next reconnect.
- While restarting: "Restarting…". On failure: "Restart failed" + **[Retry]** **[Open log]** (in a
  browser tab, the path of `server.log` instead of Open log).

#### What "Restart server" does

1. If agents are running, confirm: "Restart ends N running agent chats." Otherwise no dialog.
2. Flush board changes (`window.aiwbFlush()`) and show "Restarting…". Drafts are already on the
   server.
3. `POST /api/restart`. The server only spawns `<os.Executable()> relaunch` detached (Setsid,
   output to `server.log`), replies 202 and keeps running. After an in-place install that path
   holds the new binary. If it is gone (app moved or deleted), the server replies 409 and the
   banner says to quit the app and run `ai-whiteboard relaunch`.
4. `relaunch` is **stop + launch**, and does the same when run from a terminal:
   - `findRunning()` → pid and port, check `/api/hello` is ours.
   - SIGTERM, wait up to 10 s. The server takes its normal SIGTERM path: flush, end agents,
     remove `server.json`, exit.
   - Then everything `launch` does: PATH from the login shell, start `serve` detached, poll
     `/api/hello` up to 30 s, print the URL, exit. Failure → stderr, exit 1.
   - With no server running, it is just `launch`.
5. The page polls `/api/hello` every 0.5 s until `version` differs from the old one, then
   `location.reload()`. No new version within 45 s → "Restart failed".
6. Other open clients reconnect to the new server, find page ≠ disk, and show **Reload**.

The HTTP endpoint never shuts the server down itself, so a restart from the banner and
`ai-whiteboard relaunch` in a terminal go through the same code.

The checks, as the design lists them:

- `ai-whiteboard relaunch` in a terminal → same result as the banner's Restart.

How the page behaves in this build:

- Only one tab is the active client at a time. Opening a new tab makes it the active one; the
  older tab shows "Opened in another window" with a **Use here** button, and connects again only
  when that button is clicked. The banner is at the bottom of the left sidebar, so it is seen in the
  active tab.
- The 409 banner text is "The server's program is gone (the app was moved or deleted). Quit the
  app and run `ai-whiteboard relaunch`."
- "Restart failed" in a browser tab shows **Retry** and the path `<data folder>/server.log`
  instead of an **Open log** button.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-banner`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the web client's version stamping, three-way compare and banner, together with the server's `/api/restart`, `webVersion` and the `relaunch` command, in browser tabs.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-banner/env.sh`. If `/tmp/aiwb-env-banner/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`banner`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-banner` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-banner/home` |
| Port (`$AIWB_ENV_PORT`) | `4762` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4762/` |
| Go binary (`$AIWB_ENV_BIN`) | `/tmp/aiwb-env-banner/live/ai-whiteboard` |
| Web client (`$AIWB_ENV_CLIENT`) | `/tmp/aiwb-env-banner/live/web` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-banner/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4762 -client "$AIWB_ENV_CLIENT" <other args>` with `exec` |
| Builds of three versions | `/tmp/aiwb-env-banner/versions/e2e-v1`, `.../e2e-v2`, `.../e2e-v3`, each holding `ai-whiteboard` (Go binary stamped with that version) and `web/` (web client stamped with that version, with its `version.json`) |
| Install a version in place | `/tmp/aiwb-env-banner/install.sh <v>`, where `<v>` is `e2e-v1`, `e2e-v2` or `e2e-v3`: `rm -rf "$AIWB_ENV/live"` then `cp -R "$AIWB_ENV/versions/<v>" "$AIWB_ENV/live"`, like an in-place install: a running server keeps running its old program, while the files on disk (binary and web client) become the new version |
| Variables | `source /tmp/aiwb-env-banner/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-banner/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-banner/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-banner` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-banner/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-banner` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-banner/env.sh`; `/tmp/aiwb-env-banner/install.sh e2e-v1`. Open one Playwright
   `chromium` browser; each "tab" below is a new page in one context.
1. `"$AIWB_ENV_WRAPPER" launch` → prints `$AIWB_ENV_URL`; `/api/hello` → `version` `e2e-v1`,
   `webVersion` `e2e-v1`; remember pid P1.
2. Tab A opens `$AIWB_ENV_URL`. Pass: sidebar visible; neither "New version installed" nor "This
   page is out of date" on the page.
3. `install.sh e2e-v2` (the server keeps running). `/api/hello` → `version` `e2e-v1`, `webVersion`
   `e2e-v2`, pid P1.
4. Tab B opens `$AIWB_ENV_URL` (it becomes the active client; tab A shows "Opened in another
   window"). Pass: within 10 s tab B shows "New version installed. The server is still running the
   old one." and a **Restart server** button at the bottom of the sidebar.
5. Click × on the banner → the banner is gone. Reload tab B (a new connect) → the banner is back.
6. Click **Restart server** (no agent chats run, so no confirm dialog appears; if one appears, the
   step fails). Pass: "Restarting…" shows; within 45 s `/api/hello` → `version` `e2e-v2` with a pid
   P2 ≠ P1; P1 is no longer running; tab B reloads by itself (a new page load) and then shows no
   banner.
7. Tab A: click **Use here**. Pass: within 10 s tab A shows "This page is out of date." and a
   **Reload** button. Click **Reload** → tab A reloads and shows no banner; `/api/hello` pid is still
   P2 (Reload never restarts the server).
8. Program gone: `install.sh e2e-v3`; reload tab A → the Restart banner shows. `mv
   "$AIWB_ENV_BIN" "$AIWB_ENV_BIN.moved"`, then click **Restart server**. Pass: the banner shows the
   409 text containing `ai-whiteboard relaunch`; `/api/hello` still reports pid P2 and `version`
   `e2e-v2`. Move the binary back.
9. `relaunch` in a terminal: reload tab A → the Restart banner shows (server `e2e-v2`, page and
   disk `e2e-v3`). Run `"$AIWB_ENV_WRAPPER" relaunch`. Pass: exit 0; stdout exactly one line,
   `$AIWB_ENV_URL`; `/api/hello` → `version` `e2e-v3` with a new pid P3; within 30 s tab A has
   reconnected by itself and shows no banner — the same result as the banner's Restart.
10. Restart failed: `install.sh e2e-v2`; reload tab A → Restart banner (server `e2e-v3`, page and
    disk `e2e-v2`). Replace `$AIWB_ENV_BIN` with an executable script `#!/bin/sh` / `exit 1`, so
    the relaunch the server starts does nothing. Click **Restart server**. Pass: "Restarting…",
    then within 50 s "Restart failed" with a **Retry** button and the text
    `$AIWB_ENV_HOME/server.log` (the data folder's log path), and no **Open log** button;
    `/api/hello` still reports pid P3. Then `install.sh e2e-v2` (the real binary again) and click
    **Retry** → within 45 s `/api/hello` → `version` `e2e-v2` with a new pid, tab A reloads and
    shows no banner.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-banner-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-banner/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T13=====

---

## T14

- **Title:** Environment `app-lifecycle` for the app start-up and quit check
- **For agent:** yes
- **Blocked by:** T08, T09

=====BEGIN BODY T14=====
## Why

An automated check, "Check: the app starts or finds the server, stays a single instance, and quitting leaves the server running", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`app-lifecycle`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-app-lifecycle` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-app-lifecycle/home` |
| Port (`$AIWB_ENV_PORT`) | `4763` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4763/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-app-lifecycle/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-app-lifecycle/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-app-lifecycle/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4763 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-app-lifecycle/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-app-lifecycle/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-app-lifecycle/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-app-lifecycle` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-app-lifecycle/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-app-lifecycle` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-app-lifecycle` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-app-lifecycle`. Create
   `/tmp/aiwb-env-app-lifecycle` and `/tmp/aiwb-env-app-lifecycle/home` and `/tmp/aiwb-env-app-lifecycle/userdata`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock: `/Users/pedjat/Documents/projects/ai-whiteboard/scripts/build-app.sh`, then
   `ditto "/Users/pedjat/Documents/projects/ai-whiteboard/bin/AI Whiteboard.app" "/tmp/aiwb-env-app-lifecycle/AI Whiteboard.app"`.

3. Write `/tmp/aiwb-env-app-lifecycle/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-app-lifecycle/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-app-lifecycle/home" -port 4763 "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-app-lifecycle`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-app-lifecycle/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-app-lifecycle/stop.sh` and `/tmp/aiwb-env-app-lifecycle/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-app-lifecycle/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-app-lifecycle/env.sh`; nothing answers on port `4763` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- The app starts isolated: launch the Electron app as below, then
  `app.evaluate(({ app }) => app.getPath('userData'))` resolves (after `realpath`, since `/tmp`
  is `/private/tmp`) to `$AIWB_ENV_USERDATA`, and a window loads `$AIWB_ENV_URL`. If the app ignores
  `--user-data-dir` (the path is `~/Library/Application Support/AI Whiteboard`), stop and report
  it: the check cannot be isolated from the user's own app then. Quit the app afterwards.

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.
- `$AIWB_ENV_ELECTRON` and `$AIWB_ENV_BIN` exist and are executable.
- `/tmp/aiwb-env-app-lifecycle/stop.sh` exits 0; afterwards nothing answers on port `4763` and no process matches
  `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-app-lifecycle/home` may keep the data the trial run
  wrote).
=====END BODY T14=====

---

## T15

- **Title:** Check: the app starts or finds the server, stays a single instance, and quitting leaves the server running
- **For agent:** yes
- **Blocked by:** T14, T05, T09

=====BEGIN BODY T15=====
## What to confirm

The built AI Whiteboard.app connects to a running server or starts one through `ai-whiteboard launch`, shows "Starting…" meanwhile, shows an error dialog when that fails, runs as a single instance, remembers its window, follows the macOS quit convention, and never stops the server.

From the design (verbatim):

## Goal

- Replace "Go launcher opens a browser tab" with an Electron app window.
- The server stays the Go program (`cmd/ai-whiteboard`), unchanged in what it does.
- One `AI Whiteboard.app` holds everything: Electron, the Go binary, the built web client. Nothing
  gets installed outside the bundle.
- The app connects to a server that is already running, or starts one if none is.
- Quitting the app never stops the server. The app has no "stop server" control. The only
  restart is one the user asks for after an update (see 4).

- `ai-whiteboard launch` (`cmd/ai-whiteboard/launch.go`): `findRunning()` checks the port in
  `~/.ai-whiteboard/server.json`, then port 4747. A port counts only if `GET /api/hello` answers
  `app == "ai-whiteboard"`. If nothing answers, `launch` starts `serve -no-open` detached
  (`Setsid`, output to `server.log`, working folder = home). It waits up to 30 s for the server to
  answer, then exits. It also takes PATH from the login shell, so `claude` and `agent` are found
  when the app is started from Finder or Spotlight.

- `launch` either finds the running server or starts one detached, waits until it answers, prints
  the URL, and **exits**. The server is never a child of Electron: it is a child of a launcher
  that already exited, in its own session. So quitting (or crashing) Electron can't take the
  server down, and Electron never needs a kill or `before-quit` hook.
- While `launch` runs, show a small "Starting…" window (or keep the main window hidden) so a
  30 s cold start doesn't look like a hang.

- App: `app.requestSingleInstanceLock()`. A second launch focuses the existing window.

- `BrowserWindow` loads `http://127.0.0.1:<port>/`, with `contextIsolation: true`,
  `nodeIntegration: false`, and no preload API needed at first.
- Quitting: macOS convention. Closing the last window keeps the app in the Dock; Cmd+Q quits
  Electron. The server keeps running either way.
- Remember window size and position (e.g. `electron-window-state`).

### 6. Browser tab still works

Nothing changes on the server, so `ai-whiteboard` from a terminal and the browser tab keep
working. The app window and a browser tab are just two clients. The editor bridge already handles
more than one client (active/pending client, `/api/client/release`).

The checks, as the design lists them:

- Quit the app → `ai-whiteboard` still in `ps`, the browser tab still works.
- Relaunch → same server pid.
- Launch with no server → one server starts, window opens.
- Launch from Spotlight/Finder → `claude` and `agent` are found (login PATH).

How the app behaves in this build:

- While `launch` runs, a small window with the text "Starting…" is shown; the main window appears
  once its page has loaded, and the Starting window closes.
- When `launch` fails: `dialog.showMessageBox` with message "AI Whiteboard could not start its
  server", the stderr text as detail, and buttons `Retry`, `Open server log`, `Quit`. Open server
  log calls `shell.openPath(<home>/.ai-whiteboard/server.log)` and shows the dialog again; Retry
  runs `launch` again.
- The page gets one preload API, `window.aiwbDesktop.openServerLog()`, which does the same
  `shell.openPath`.
- `AIWB_SERVER_BIN` makes the app run that program instead of its bundled `ai-whiteboard`.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-app-lifecycle`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the desktop app's start-up (`launch` through `AIWB_SERVER_BIN`, Starting window, error dialog, preload API), the single-instance lock, window state, the quit convention, and that the packaged app, launched from Finder, gets the login PATH.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

### Starting the app

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-app-lifecycle/env.sh`. If `/tmp/aiwb-env-app-lifecycle/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`app-lifecycle`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-app-lifecycle` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-app-lifecycle/home` |
| Port (`$AIWB_ENV_PORT`) | `4763` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4763/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-app-lifecycle/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-app-lifecycle/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-app-lifecycle/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4763 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-app-lifecycle/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-app-lifecycle/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-app-lifecycle/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-app-lifecycle` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-app-lifecycle/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-app-lifecycle` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-app-lifecycle/env.sh`. Nothing answers on `$AIWB_ENV_PORT`. Write
   `$AIWB_ENV/slow-bin` (executable): `sleep 4; exec "$AIWB_ENV_WRAPPER" "$@"`.
1. Launch with no server: start the app with `AIWB_SERVER_BIN=$AIWB_ENV/slow-bin`. Pass: within 3 s
   some window's text contains "Starting…"; within 45 s the main window's URL is `$AIWB_ENV_URL`
   and its sidebar (`.side-pane`) is visible; the Starting window is gone; `/api/hello` answers;
   exactly one server process matches `serve -home $AIWB_ENV_HOME`. Remember the pid P1.
2. Window settings: `BrowserWindow.getAllWindows()` main window's
   `webContents.getLastWebPreferences()` has `contextIsolation: true` and `nodeIntegration: false`;
   in the page, `typeof require === 'undefined'` and `typeof window.aiwbDesktop.openServerLog ===
   'function'`. Replace `shell.openPath` with a recorder, call `window.aiwbDesktop.openServerLog()`
   from the page → one recorded call with `<home>/.ai-whiteboard/server.log` (only recorded;
   nothing opens).
3. Single instance: in the main process count `second-instance` events; minimize the main window;
   start the Electron executable a second time (plain `child_process.spawn`, same
   `--user-data-dir`, same environment). Pass: the second process exits within 10 s; the count is
   1; there is still one main window, not minimized and visible.
4. Quit keeps the server: set the main window's bounds to x 100, y 100, 1000 × 700; quit the way
   Cmd+Q does. Pass: the Electron process exits within 15 s; P1 is still running (`ps -p P1`);
   `/api/hello` answers with P1; a Playwright `chromium` tab on `$AIWB_ENV_URL` shows the sidebar
   (the browser tab still works). Close the browser.
5. Relaunch → same server: start the app again (normal wrapper). Pass: the main window loads
   `$AIWB_ENV_URL`; `/api/hello` pid is still P1; the main window's bounds are x 100, y 100,
   1000 × 700 (±2 px).
6. macOS convention: close the main window. Pass: after 3 s the Electron process is still running
   and the server still answers. `app.emit('activate')` in the main process → a main window loads
   `$AIWB_ENV_URL` again. Quit.
7. Start error: `"$AIWB_ENV_WRAPPER" stop`. Write `$AIWB_ENV/fail-bin` (executable):
   `sleep 4; if [ -f "$AIWB_ENV/fail-off" ]; then exec "$AIWB_ENV_WRAPPER" "$@"; fi; echo "AI Whiteboard: simulated failure" >&2; exit 1`.
   Start the app with `AIWB_SERVER_BIN=$AIWB_ENV/fail-bin` and, within the 4 s, replace
   `dialog.showMessageBox` with a recorder that answers the index of `Open server log` the first
   time and, from the second call on, creates `$AIWB_ENV/fail-off` and answers the index of
   `Retry`; replace `shell.openPath` with a recorder. Pass: the first dialog call's text contains
   "simulated failure" and its buttons include `Retry` and `Open server log`; `shell.openPath` got
   `<home>/.ai-whiteboard/server.log`; a second dialog call follows; then the main window loads
   `$AIWB_ENV_URL` and `/api/hello` answers. Quit; `rm $AIWB_ENV/fail-off`.
8. Launch from Finder or Spotlight finds `claude` and `agent`: quit the app and
   `"$AIWB_ENV_WRAPPER" stop`. Find where the user's login shell has them:
   `"$SHELL" -ilc 'command -v claude; command -v agent'`. Check whichever of the two is installed;
   if neither is, report this step as not checkable. Start the app through LaunchServices, as Finder
   and Spotlight do: `open -n --env AIWB_SERVER_BIN="$AIWB_ENV_WRAPPER" "$AIWB_ENV_APP" --args
   --user-data-dir="$AIWB_ENV_USERDATA"` (if this `open` has no `--env`, instead start
   `env -i HOME="$HOME" USER="$USER" SHELL="$SHELL" PATH=/usr/bin:/bin:/usr/sbin:/sbin
   AIWB_SERVER_BIN="$AIWB_ENV_WRAPPER" "$AIWB_ENV_ELECTRON" --user-data-dir="$AIWB_ENV_USERDATA"`,
   the bare PATH a Finder launch gets). Pass: within 45 s `/api/hello` answers; the PATH in the
   server process's environment (`ps -E -ww -o command= -p <pid>`, or `ps eww <pid>`) contains the
   folder of each installed `claude` / `agent`. Then kill the app (`pkill -f --
   "--user-data-dir=$AIWB_ENV_USERDATA"`).

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-app-lifecycle-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-app-lifecycle/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T15=====

---

## T16

- **Title:** Environment `links` for the app link-handling check
- **For agent:** yes
- **Blocked by:** T08, T09

=====BEGIN BODY T16=====
## Why

An automated check, "Check: links in the app window open in the default browser and the window stays on the server", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`links`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-links` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-links/home` |
| Port (`$AIWB_ENV_PORT`) | `4764` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4764/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-links/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-links/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-links/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4764 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-links/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-links/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-links/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-links` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-links/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-links` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-links` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-links`. Create
   `/tmp/aiwb-env-links` and `/tmp/aiwb-env-links/home` and `/tmp/aiwb-env-links/userdata`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock: `/Users/pedjat/Documents/projects/ai-whiteboard/scripts/build-app.sh`, then
   `ditto "/Users/pedjat/Documents/projects/ai-whiteboard/bin/AI Whiteboard.app" "/tmp/aiwb-env-links/AI Whiteboard.app"`.

3. Write `/tmp/aiwb-env-links/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-links/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-links/home" -port 4764 "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-links`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-links/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-links/stop.sh` and `/tmp/aiwb-env-links/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-links/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-links/env.sh`; nothing answers on port `4764` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- The app starts isolated: launch the Electron app as below, then
  `app.evaluate(({ app }) => app.getPath('userData'))` resolves (after `realpath`, since `/tmp`
  is `/private/tmp`) to `$AIWB_ENV_USERDATA`, and a window loads `$AIWB_ENV_URL`. If the app ignores
  `--user-data-dir` (the path is `~/Library/Application Support/AI Whiteboard`), stop and report
  it: the check cannot be isolated from the user's own app then. Quit the app afterwards.

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.
- `$AIWB_ENV_ELECTRON` and `$AIWB_ENV_BIN` exist and are executable.
- `/tmp/aiwb-env-links/stop.sh` exits 0; afterwards nothing answers on port `4764` and no process matches
  `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-links/home` may keep the data the trial run
  wrote).
=====END BODY T16=====

---

## T17

- **Title:** Check: links in the app window open in the default browser and the window stays on the server
- **For agent:** yes
- **Blocked by:** T16, T06, T09

=====BEGIN BODY T17=====
## What to confirm

Links from the app window go to `shell.openExternal` (the default browser) and never open in an app window; only `http`, `https` and `mailto` are opened; the window never leaves the server's origin.

From the design (verbatim):

- **Links open in the default browser.** Chat links (`Markdown.tsx`, `target="_blank"`) and links
  on Excalidraw elements both go through `window.open`. Without a handler, Electron would open them
  in a bare new app window. Any link that would leave the server's origin goes to
  `shell.openExternal`, which opens the user's default browser. Only `http`, `https` and `mailto`
  are opened; anything else (`file:`, `javascript:`) is dropped.

  ```js
  const appOrigin = new URL(url).origin;
  const openOutside = (u) => { if (/^(https?|mailto):/i.test(u)) shell.openExternal(u); };
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => {
    if (new URL(u).origin !== appOrigin) { e.preventDefault(); openOutside(u); }
  });
  ```

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-links`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the desktop app's navigation rules (`setWindowOpenHandler` and `will-navigate`) in the packaged app.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

### Starting the app

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-links/env.sh`. If `/tmp/aiwb-env-links/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`links`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-links` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-links/home` |
| Port (`$AIWB_ENV_PORT`) | `4764` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4764/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-links/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-links/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-links/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4764 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-links/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-links/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-links/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-links` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-links/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-links` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-links/env.sh`. Start the app (normal wrapper); wait for the main window on
   `$AIWB_ENV_URL` with the sidebar visible. Replace `shell.openExternal` in the main process with a
   recorder (it records and resolves; nothing opens). Remember the number of windows W.
1. In the page, `window.open('https://example.com/a')`. Pass: recorded `https://example.com/a`;
   still W windows.
2. In the page, append `<a href="https://example.com/b" target="_blank">x</a>` and click it with
   Playwright (the way chat links work). Pass: recorded `https://example.com/b`; still W windows;
   the main window's URL unchanged.
3. `window.open('mailto:someone@example.com')` → recorded.
4. `window.open('file:///etc/hosts')` and `window.open('javascript:alert(1)')` → nothing recorded,
   still W windows.
5. `location.href = 'https://example.com/c'`. Pass: recorded `https://example.com/c`; after 1 s
   the main window's URL still starts with `$AIWB_ENV_URL`.
6. `location.href = 'file:///etc/hosts'` → nothing recorded; the URL still starts with
   `$AIWB_ENV_URL`.
7. Same origin: `location.href = '${AIWB_ENV_URL}?x=1'`. Pass: the main window navigates there
   (its URL ends with `?x=1`) and nothing is recorded.
8. Quit the app.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-links-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-links/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T17=====

---

## T18

- **Title:** Environment `reconnect` for the app reconnect check
- **For agent:** yes
- **Blocked by:** T08, T09

=====BEGIN BODY T18=====
## Why

An automated check, "Check: the app brings back a killed or stopped server", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`reconnect`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-reconnect` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-reconnect/home` |
| Port (`$AIWB_ENV_PORT`) | `4765` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4765/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-reconnect/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-reconnect/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-reconnect/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4765 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-reconnect/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-reconnect/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-reconnect/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-reconnect` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-reconnect/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-reconnect` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-reconnect` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-reconnect`. Create
   `/tmp/aiwb-env-reconnect` and `/tmp/aiwb-env-reconnect/home` and `/tmp/aiwb-env-reconnect/userdata`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock: `/Users/pedjat/Documents/projects/ai-whiteboard/scripts/build-app.sh`, then
   `ditto "/Users/pedjat/Documents/projects/ai-whiteboard/bin/AI Whiteboard.app" "/tmp/aiwb-env-reconnect/AI Whiteboard.app"`.

3. Write `/tmp/aiwb-env-reconnect/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-reconnect/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-reconnect/home" -port 4765 "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-reconnect`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-reconnect/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-reconnect/stop.sh` and `/tmp/aiwb-env-reconnect/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-reconnect/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-reconnect/env.sh`; nothing answers on port `4765` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- The app starts isolated: launch the Electron app as below, then
  `app.evaluate(({ app }) => app.getPath('userData'))` resolves (after `realpath`, since `/tmp`
  is `/private/tmp`) to `$AIWB_ENV_USERDATA`, and a window loads `$AIWB_ENV_URL`. If the app ignores
  `--user-data-dir` (the path is `~/Library/Application Support/AI Whiteboard`), stop and report
  it: the check cannot be isolated from the user's own app then. Quit the app afterwards.

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.
- `$AIWB_ENV_ELECTRON` and `$AIWB_ENV_BIN` exist and are executable.
- `/tmp/aiwb-env-reconnect/stop.sh` exits 0; afterwards nothing answers on port `4765` and no process matches
  `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-reconnect/home` may keep the data the trial run
  wrote).
=====END BODY T18=====

---

## T19

- **Title:** Check: the app brings back a killed or stopped server
- **For agent:** yes
- **Blocked by:** T18, T07, T09

=====BEGIN BODY T19=====
## What to confirm

When the server dies or is stopped while the app window is open, the app runs `launch` again, which starts a new server, and reloads the window.

From the design (verbatim):

- Connection loss (server crashed or was stopped): the client's SSE reconnect already shows the
  state. Add a main-process retry: if the page can't load or SSE stays down, run `launch` again
  and reload. That restarts a crashed server.

The check, as the design lists it:

- `kill -9` the server → the app restarts it on reconnect.

How the app behaves in this build: once the window has loaded, the main process asks
`/api/hello` every 2 s; after 3 failures in a row (or when the page fails to load) it runs
`launch` again and loads the URL it prints; a failed `launch` is retried 5 s later, without a
dialog.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-reconnect`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the desktop app's reconnect (running `launch` again after the server is gone) in the packaged app.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

### Starting the app

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-reconnect/env.sh`. If `/tmp/aiwb-env-reconnect/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`reconnect`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-reconnect` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-reconnect/home` |
| Port (`$AIWB_ENV_PORT`) | `4765` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4765/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-reconnect/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-reconnect/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-reconnect/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4765 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-reconnect/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-reconnect/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-reconnect/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-reconnect` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-reconnect/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-reconnect` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-reconnect/env.sh`. Start the app (normal wrapper); wait for the main window on
   `$AIWB_ENV_URL` with the sidebar visible. `/api/hello` → pid P1. In the main process count the
   main window's `did-finish-load` events, and replace `dialog.showMessageBox` with a recorder.
1. `kill -9 P1`. Pass: within 30 s `/api/hello` answers with a pid P2 ≠ P1; exactly one server
   process matches `serve -home $AIWB_ENV_HOME`; the `did-finish-load` count has grown; the main
   window's URL starts with `$AIWB_ENV_URL` and its sidebar is visible; no dialog was recorded.
2. Stopped the normal way: `"$AIWB_ENV_WRAPPER" stop`. Pass: within 30 s `/api/hello` answers with
   a pid P3 ≠ P2; one server process; the window reloaded again and shows the sidebar; no dialog.
3. Quit the app. Pass: P3 is still running.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-reconnect-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-reconnect/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T19=====

---

## T20

- **Title:** Environment `close-flush` for the app close/quit flush check
- **For agent:** yes
- **Blocked by:** T08, T09

=====BEGIN BODY T20=====
## Why

An automated check, "Check: Cmd+Q and closing the window wait for board saves", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`close-flush`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-close-flush` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-close-flush/home` |
| Port (`$AIWB_ENV_PORT`) | `4766` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4766/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-close-flush/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-close-flush/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-close-flush/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4766 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-close-flush/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-close-flush/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-close-flush/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-close-flush` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-close-flush/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-close-flush` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-close-flush` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-close-flush`. Create
   `/tmp/aiwb-env-close-flush` and `/tmp/aiwb-env-close-flush/home` and `/tmp/aiwb-env-close-flush/userdata`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock: `/Users/pedjat/Documents/projects/ai-whiteboard/scripts/build-app.sh`, then
   `ditto "/Users/pedjat/Documents/projects/ai-whiteboard/bin/AI Whiteboard.app" "/tmp/aiwb-env-close-flush/AI Whiteboard.app"`.

3. Write `/tmp/aiwb-env-close-flush/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-close-flush/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-close-flush/home" -port 4766 "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-close-flush`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-close-flush/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-close-flush/stop.sh` and `/tmp/aiwb-env-close-flush/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-close-flush/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-close-flush/env.sh`; nothing answers on port `4766` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- The app starts isolated: launch the Electron app as below, then
  `app.evaluate(({ app }) => app.getPath('userData'))` resolves (after `realpath`, since `/tmp`
  is `/private/tmp`) to `$AIWB_ENV_USERDATA`, and a window loads `$AIWB_ENV_URL`. If the app ignores
  `--user-data-dir` (the path is `~/Library/Application Support/AI Whiteboard`), stop and report
  it: the check cannot be isolated from the user's own app then. Quit the app afterwards.

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.
- `$AIWB_ENV_ELECTRON` and `$AIWB_ENV_BIN` exist and are executable.
- `/tmp/aiwb-env-close-flush/stop.sh` exits 0; afterwards nothing answers on port `4766` and no process matches
  `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-close-flush/home` may keep the data the trial run
  wrote).
=====END BODY T20=====

---

## T21

- **Title:** Check: Cmd+Q and closing the window wait for board saves
- **For agent:** yes
- **Blocked by:** T20, T08, T09

=====BEGIN BODY T21=====
## What to confirm

Quitting or closing the app window right after a board edit first writes the edit to the board file; when the server is down, a dialog asks before losing the edit; with nothing pending the window closes at once. Quitting never touches the server.

From the design (verbatim):

- **Closing waits for board saves.** When saves are pending, the client's `beforeunload` calls
  `e.preventDefault()` (`web/src/main.tsx`). A browser turns that into a "Leave page?" prompt.
  Electron instead cancels the close (or reload, or Cmd+Q) silently and fires
  `will-prevent-unload`. Main uses that event:
  1. The close stays cancelled for now.
  2. Main waits for `window.aiwbFlush()`, which the client exposes. It resolves `true` once every
     board is written.
  3. Main then does the same action again: close the window, `app.quit()` if this was Cmd+Q, or
     reload. This time nothing is pending, so it goes through.
  4. If the flush doesn't finish within 10 s (server down), a dialog asks
     "Board changes are not saved. Close anyway?". Choosing "Close anyway" lets the next
     `will-prevent-unload` through.
  With no pending saves none of this runs, and the window closes at once.

  ```js
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });

  let closing = false, force = false;
  win.on('close', () => { closing = true; });            // fires before beforeunload
  win.webContents.on('will-prevent-unload', async (e) => {
    if (force) { force = false; e.preventDefault(); return; }  // preventDefault = unload anyway
    const wasClosing = closing, wasQuitting = quitting;
    closing = quitting = false;                          // the close/quit was cancelled
    if (!(await flushed(win))) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning', message: 'Board changes are not saved.',
        detail: 'The server did not answer. Close anyway and lose them?',
        buttons: ['Cancel', 'Close anyway'], defaultId: 0, cancelId: 0,
      });
      if (response !== 1) return;
      force = true;
    }
    if (wasQuitting) app.quit();
    else if (wasClosing) win.close();
    else win.webContents.reload();
  });

  function flushed(win) {
    const done = win.webContents.executeJavaScript('window.aiwbFlush ? window.aiwbFlush() : false', true);
    const timeout = new Promise((r) => setTimeout(() => r(false), 10_000));
    return Promise.race([done, timeout]).then((v) => v === true, () => false);
  }
  ```

  Quitting never touches the server; this only makes sure the page has written its boards.
  **Test: edit a board and press Cmd+Q within 500 ms. The app quits, and the edit is in the
  board file. Stop the server, edit and close: the dialog appears.**

How the app behaves in this build: when the server is gone, the app also tries to bring it back by
running `launch` again every few seconds (quietly, without a dialog). Step 3 blocks that so the
server stays down.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-close-flush`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the desktop app's close/quit flush (`will-prevent-unload` → `window.aiwbFlush()`) in the packaged app.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

### Starting the app

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-close-flush/env.sh`. If `/tmp/aiwb-env-close-flush/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`close-flush`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-close-flush` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-close-flush/home` |
| Port (`$AIWB_ENV_PORT`) | `4766` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4766/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-close-flush/AI Whiteboard.app` |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-close-flush/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-close-flush/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4766 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Variables | `source /tmp/aiwb-env-close-flush/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-close-flush/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-close-flush/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-close-flush` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-close-flush/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-close-flush` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-close-flush/env.sh`. Write `$AIWB_ENV/guard-bin` (executable):
   `if [ -f "$AIWB_ENV/no-start" ] && [ "$1" != stop ]; then echo "blocked for the check" >&2; exit 1; fi; exec "$AIWB_ENV_WRAPPER" "$@"`.
   Always start the app with `AIWB_SERVER_BIN=$AIWB_ENV/guard-bin`. For creating and opening a
   board and drawing a rectangle on its canvas, reuse the UI steps of `/Users/pedjat/Documents/projects/ai-whiteboard/web/e2e/app.e2e.mjs`
   (its `drawRect`, `tool` and `canvasBox` helpers and how it creates and opens a board). A board's
   file is `$AIWB_ENV_HOME/boards/<board id>/drawing.excalidraw`.
1. Cmd+Q right after an edit: start the app, create and open a board, wait 3 s, count the
   `rectangle` elements (not `isDeleted`) in its board file (N). Draw a rectangle and, within
   500 ms of the mouse-up, quit the way Cmd+Q does. Pass: the Electron process exits within 15 s;
   the board file now has N + 1 rectangles; the server still answers `/api/hello` with the same pid.
2. Nothing pending: start the app, open the board, wait 3 s; replace `dialog.showMessageBox` with a
   recorder; close the main window. Pass: the window is gone within 2 s and nothing was recorded.
   Quit.
3. Server down: start the app, open the board, wait 3 s. Replace `dialog.showMessageBox` with a
   recorder that answers `{ response: 0 }` (Cancel). `touch $AIWB_ENV/no-start`;
   `"$AIWB_ENV_WRAPPER" stop`; wait until `/api/hello` no longer answers. Draw a rectangle, then
   close the main window. Pass: within 20 s the recorder has a call with message
   `Board changes are not saved.` and buttons `Cancel` and `Close anyway`; after the answer the
   window is still open. Make the recorder answer `{ response: 1 }` (Close anyway) and close the
   window again. Pass: within 20 s the dialog is recorded again and then the window is gone.
4. `rm $AIWB_ENV/no-start`; quit the app.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-close-flush-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-close-flush/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T21=====

---

## T22

- **Title:** Environment `app-update` for the app update check
- **For agent:** yes
- **Blocked by:** T08, T09

=====BEGIN BODY T22=====
## Why

An automated check, "Check: installing a new build over a running old server shows Restart in the app, and Restart works", drives a live AI Whiteboard as a simulated user. Checks like it
run at the same time, and two checks sharing one server, port, data folder or app would set it up,
change it and tear it down under each other. This task stands up an environment that this one
check uses and nothing else uses. It prepares and verifies the environment and leaves it stopped;
the check brings it up, uses it, and destroys it with `destroy.sh` when it is finished.

## The environment

Environment **`app-update`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-app-update` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-app-update/home` |
| Port (`$AIWB_ENV_PORT`) | `4767` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4767/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-app-update/live/AI Whiteboard.app` (the "installed" app) |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-app-update/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-app-update/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4767 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Two builds of the app | `/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app` (Go binary and web client stamped `e2e-old`, `$AIWB_ENV_OLD_VERSION`) and `/tmp/aiwb-env-app-update/versions/new/AI Whiteboard.app` (the normal build, stamped with `git describe --tags --always --dirty`, `$AIWB_ENV_NEW_VERSION`) |
| Install a build in place | `/tmp/aiwb-env-app-update/install.sh <which>`, where `<which>` is `old` or `new`: `rm -rf "$AIWB_ENV_APP"` then `ditto "$AIWB_ENV/versions/<which>/AI Whiteboard.app" "$AIWB_ENV_APP"`, the same way `scripts/install-app.sh` replaces an installed app: a running server keeps running its old program, while the files on disk become the new build |
| Variables | `source /tmp/aiwb-env-app-update/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-app-update/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-app-update/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-app-update` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-app-update/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-app-update` can `import { chromium, _electron } from "playwright"` |

## Safety

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps

1. If `/tmp/aiwb-env-app-update` already exists, run its `destroy.sh` if there is one, then `rm -rf /tmp/aiwb-env-app-update`. Create
   `/tmp/aiwb-env-app-update` and `/tmp/aiwb-env-app-update/home` and `/tmp/aiwb-env-app-update/userdata`.
2. Build what the environment runs:

Builds write to fixed paths in the repository (`web/dist`, `desktop/build`, `desktop/dist`,
`bin/AI Whiteboard.app`), and other environments may be built at the same time. Hold a build lock
for every build and for copying its output: take it with
`until mkdir /tmp/aiwb-build.lock 2>/dev/null; do sleep 2; done`, release it with
`rmdir /tmp/aiwb-build.lock` (in a `trap` so a failure releases it too). If the lock folder is
older than 30 minutes and no build (`node build.mjs`, `go build`, `electron-builder`,
`build-app.sh`) is running, it is stale: remove it and take it.

   Under the lock:
   - `/Users/pedjat/Documents/projects/ai-whiteboard/scripts/build-app.sh`; `ditto "/Users/pedjat/Documents/projects/ai-whiteboard/bin/AI Whiteboard.app" "/tmp/aiwb-env-app-update/versions/new/AI Whiteboard.app"`.
     `AIWB_ENV_NEW_VERSION` is `git -C /Users/pedjat/Documents/projects/ai-whiteboard describe --tags --always --dirty` (the version that
     build stamped).
   - `ditto` the new app to `/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app`, then turn that copy
     into the old build: `go build -C /Users/pedjat/Documents/projects/ai-whiteboard -ldflags "-X ai-whiteboard/internal/version.Version=e2e-old" -o "/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" ./cmd/ai-whiteboard`;
     `cd /Users/pedjat/Documents/projects/ai-whiteboard/web && AIWB_VERSION=e2e-old node build.mjs`, replace the copy's
     `Contents/Resources/web` with `/Users/pedjat/Documents/projects/ai-whiteboard/web/dist`; then rebuild `web/dist` with
     `AIWB_VERSION="$AIWB_ENV_NEW_VERSION" node build.mjs` so it matches the normal build again.
   - Re-sign the changed copy: `codesign --force --deep --sign - "/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app"`.
   - Install the old build: `ditto "/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app" "/tmp/aiwb-env-app-update/live/AI Whiteboard.app"`.
     Write `/tmp/aiwb-env-app-update/install.sh` (executable) as described in the table.

3. Write `/tmp/aiwb-env-app-update/server-bin` (bash, executable):

   ```bash
   #!/bin/bash
   cmd="$1"; shift
   exec "/tmp/aiwb-env-app-update/live/AI Whiteboard.app/Contents/MacOS/ai-whiteboard" "$cmd" -home "/tmp/aiwb-env-app-update/home" -port 4767 "$@"
   ```

   It must `exec` the binary at its path inside `/tmp/aiwb-env-app-update`, so that the server's own program path
   (`os.Executable()`) is that file. Because the wrapper puts `-home` and `-port` right after the
   command, every command (`launch`, `serve`, `stop`, `relaunch`) acts on this environment's data
   folder and port, and a server that restarts itself passes the same flags on.
4. Write `/tmp/aiwb-env-app-update/env.sh` exporting every `$AIWB_ENV_*` variable in the table (absolute paths), and
   `/tmp/aiwb-env-app-update/stop.sh` and `/tmp/aiwb-env-app-update/destroy.sh` as described in the table (both executable, both exit 0 when
   there is nothing to stop).
5. `ln -s /Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules /tmp/aiwb-env-app-update/node_modules`. Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

## Verification (automated)

- `source /tmp/aiwb-env-app-update/env.sh`; nothing answers on port `4767` before starting.
- `"$AIWB_ENV_WRAPPER" launch` exits 0 and prints exactly one line, `$AIWB_ENV_URL`.
- `GET ${AIWB_ENV_URL}api/hello` answers `app == "ai-whiteboard"`; the server process's command
  line contains `-home $AIWB_ENV_HOME`; `$AIWB_ENV_HOME/server.json` exists; `GET $AIWB_ENV_URL`
  returns the web client's HTML.
- The app starts isolated: launch the Electron app as below, then
  `app.evaluate(({ app }) => app.getPath('userData'))` resolves (after `realpath`, since `/tmp`
  is `/private/tmp`) to `$AIWB_ENV_USERDATA`, and a window loads `$AIWB_ENV_URL`. If the app ignores
  `--user-data-dir` (the path is `~/Library/Application Support/AI Whiteboard`), stop and report
  it: the check cannot be isolated from the user's own app then. Quit the app afterwards.

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.
- `versions/old/.../Contents/Resources/web/version.json` is `{"version":"e2e-old"}` and
  `versions/new/.../Contents/Resources/web/version.json` is `{"version":"$AIWB_ENV_NEW_VERSION"}`.
- In the trial run above, before stopping: `/api/hello` reports `version` `e2e-old` and
  `webVersion` `e2e-old`.
- The environment is left with the old build installed.
- `/tmp/aiwb-env-app-update/stop.sh` exits 0; afterwards nothing answers on port `4767` and no process matches
  `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`.
- The folder is left in place, prepared and stopped (`/tmp/aiwb-env-app-update/home` may keep the data the trial run
  wrote).
=====END BODY T22=====

---

## T23

- **Title:** Check: installing a new build over a running old server shows Restart in the app, and Restart works
- **For agent:** yes
- **Blocked by:** T22, T03, T04, T09

=====BEGIN BODY T23=====
## What to confirm

After a new build is installed while a server from the old build runs, opening the app connects to the old server (never stopping it) and shows the Restart banner; Restart gives a new server on the new version and a reloaded page without a banner; a browser tab still holding the old page shows Reload.

From the design (verbatim):

### 4. Server from an older build (updates)

After installing a new `.app`, a server started by the old build keeps running. It keeps serving
`Contents/Resources/web` from disk, so the new web files end up on the old server, which can break.
`install-app.sh` already warns about this.

Starting the app never stops a server: a restart ends all running agent chats, so the user
decides when. `launch` connects to the running server whatever its version and prints its URL. The
page notices the mismatch and shows a banner at the bottom of the left sidebar.

#### How versions are determined

- `scripts/build-app.sh` computes one version, `V = git describe --tags --always --dirty`, and
  stamps it into both halves of the build:
  - Go: `-ldflags -X ai-whiteboard/internal/version.Version=V`, as now.
  - Web: `build.mjs` reads `V` from `AIWB_VERSION` (default `dev`), sets it in the bundle with an
    esbuild `define` (`__APP_VERSION__`), and writes `dist/version.json` = `{"version": V}`.
- `GET /api/hello` returns `version` (the running binary's, fixed when it started) and
  `webVersion`, read from `version.json` in the served client folder on each request (`dev` when
  the file is missing).
- On every connect and reconnect, the page calls `/api/hello` and compares three versions: its own
  (`page`), the server's (`server`) and the one on disk (`disk`):

  | Case | Meaning | Banner |
  |---|---|---|
  | all equal, or any is `dev` | nothing to do | none |
  | page = disk ≠ server | new app installed, old server still running | **Restart server** |
  | page ≠ disk | page loaded before the server was replaced | **Reload** |

- Why the version on disk: `git describe` strings can't be ordered. The files on disk always come
  from the newest install, so they show which side is stale.

#### Banner

- Stale server: "New version installed. The server is still running the old one." +
  **[Restart server]**.
- Stale page: "This page is out of date." + **[Reload]** (`location.reload()`, no restart).
- × hides the banner until the next reconnect.
- While restarting: "Restarting…". On failure: "Restart failed" + **[Retry]** **[Open log]** (in a
  browser tab, the path of `server.log` instead of Open log).

#### What "Restart server" does

1. If agents are running, confirm: "Restart ends N running agent chats." Otherwise no dialog.
2. Flush board changes (`window.aiwbFlush()`) and show "Restarting…". Drafts are already on the
   server.
3. `POST /api/restart`. The server only spawns `<os.Executable()> relaunch` detached (Setsid,
   output to `server.log`), replies 202 and keeps running. After an in-place install that path
   holds the new binary. If it is gone (app moved or deleted), the server replies 409 and the
   banner says to quit the app and run `ai-whiteboard relaunch`.
4. `relaunch` is **stop + launch**, and does the same when run from a terminal:
   - `findRunning()` → pid and port, check `/api/hello` is ours.
   - SIGTERM, wait up to 10 s. The server takes its normal SIGTERM path: flush, end agents,
     remove `server.json`, exit.
   - Then everything `launch` does: PATH from the login shell, start `serve` detached, poll
     `/api/hello` up to 30 s, print the URL, exit. Failure → stderr, exit 1.
   - With no server running, it is just `launch`.
5. The page polls `/api/hello` every 0.5 s until `version` differs from the old one, then
   `location.reload()`. No new version within 45 s → "Restart failed".
6. Other open clients reconnect to the new server, find page ≠ disk, and show **Reload**.

The HTTP endpoint never shuts the server down itself, so a restart from the banner and
`ai-whiteboard relaunch` in a terminal go through the same code.

The check, as the design lists it:

- Install a new build over a running old server → the app opens on the old server with the
  Restart banner. Restart → new pid and version, the page reloads, no banner. A second browser
  tab shows Reload.

How the page behaves in this build: only one tab or window is the active client at a time. When
the app window opens, it becomes the active client and an older browser tab shows "Opened in
another window" with a **Use here** button; that tab connects again (and compares versions) when
the button is clicked.

## How

Write a throwaway script that simulates the user and run it; do not commit it (keep it in
`/tmp/aiwb-env-app-update`). It drives the UI with Playwright (the Electron app through `_electron`, browser tabs
through `chromium`, headless is fine), and uses shell commands and HTTP requests only for what is
functional (starting commands, reading `/api/hello`, reading files, listing processes). Nothing is
checked by a human.

This verifies the whole update path in the packaged app: the server's `webVersion` and `/api/restart` with `relaunch`, the web banner, and `launch` never stopping an old server.

Playwright is in `web/node_modules`; if `chromium` is not installed yet, run
`cd /Users/pedjat/Documents/projects/ai-whiteboard/web && npx playwright install chromium`.

### Starting the app

```js
import { _electron as electron, chromium } from "playwright";
const app = await electron.launch({
  executablePath: process.env.AIWB_ENV_ELECTRON,
  args: [`--user-data-dir=${process.env.AIWB_ENV_USERDATA}`],
  env: { ...process.env, AIWB_SERVER_BIN: process.env.AIWB_ENV_WRAPPER },
});
```

The app first shows a small "Starting…" window; the main window is the one whose URL starts with
`$AIWB_ENV_URL` (poll `app.windows()` for it). Main-process state is read and changed with
`app.evaluate(({ app, BrowserWindow, dialog, shell }) => ...)`. Native dialogs cannot be seen by the
script, so where a step needs one, first replace `dialog.showMessageBox` in the main process with a
recorder that stores its arguments in `globalThis` and returns a chosen `{ response }`; replace
`shell.openExternal` / `shell.openPath` with recorders the same way. Quitting the way Cmd+Q does
(the app menu's Quit calls `app.quit()`) is `app.evaluate(({ app }) => app.quit())`, then wait for
the Electron process (`app.process()`) to exit.

## Environment

This check runs against the environment below and no other. It was prepared before this task
(built, verified, left stopped). Start from `source /tmp/aiwb-env-app-update/env.sh`. If `/tmp/aiwb-env-app-update/env.sh` is missing, stop
and report that the environment was not prepared.

Environment **`app-update`**, used by one check and by nothing else:

| What | Where |
|---|---|
| Folder (`$AIWB_ENV`) | `/tmp/aiwb-env-app-update` |
| Data folder (`$AIWB_ENV_HOME`) | `/tmp/aiwb-env-app-update/home` |
| Port (`$AIWB_ENV_PORT`) | `4767` |
| Server URL (`$AIWB_ENV_URL`) | `http://127.0.0.1:4767/` |
| App copy (`$AIWB_ENV_APP`) | `/tmp/aiwb-env-app-update/live/AI Whiteboard.app` (the "installed" app) |
| Electron executable (`$AIWB_ENV_ELECTRON`) | `$AIWB_ENV_APP/Contents/MacOS/AI Whiteboard` |
| Go binary (`$AIWB_ENV_BIN`) | `$AIWB_ENV_APP/Contents/MacOS/ai-whiteboard` |
| Electron user-data folder (`$AIWB_ENV_USERDATA`) | `/tmp/aiwb-env-app-update/userdata` |
| Server wrapper (`$AIWB_ENV_WRAPPER`) | `/tmp/aiwb-env-app-update/server-bin`: runs `"$AIWB_ENV_BIN" <command> -home "$AIWB_ENV_HOME" -port 4767 <other args>` with `exec` (the bundled binary finds its own `Contents/Resources/web`). The app is always started with `AIWB_SERVER_BIN=$AIWB_ENV_WRAPPER`, which makes it use this wrapper instead of its bundled binary directly. |
| Two builds of the app | `/tmp/aiwb-env-app-update/versions/old/AI Whiteboard.app` (Go binary and web client stamped `e2e-old`, `$AIWB_ENV_OLD_VERSION`) and `/tmp/aiwb-env-app-update/versions/new/AI Whiteboard.app` (the normal build, stamped with `git describe --tags --always --dirty`, `$AIWB_ENV_NEW_VERSION`) |
| Install a build in place | `/tmp/aiwb-env-app-update/install.sh <which>`, where `<which>` is `old` or `new`: `rm -rf "$AIWB_ENV_APP"` then `ditto "$AIWB_ENV/versions/<which>/AI Whiteboard.app" "$AIWB_ENV_APP"`, the same way `scripts/install-app.sh` replaces an installed app: a running server keeps running its old program, while the files on disk become the new build |
| Variables | `source /tmp/aiwb-env-app-update/env.sh` exports every `$AIWB_ENV_*` above |
| Stop everything | `/tmp/aiwb-env-app-update/stop.sh`: `"$AIWB_ENV_WRAPPER" stop`, then kills any process whose command line contains `-home $AIWB_ENV_HOME` or `--user-data-dir=$AIWB_ENV_USERDATA`, and waits until nothing answers on the port. Leaves the files. |
| Destroy | `/tmp/aiwb-env-app-update/destroy.sh`: `stop.sh`, then `rm -rf /tmp/aiwb-env-app-update` |
| Node modules for throwaway scripts | `/tmp/aiwb-env-app-update/node_modules` is a symlink to `/Users/pedjat/Documents/projects/ai-whiteboard/web/node_modules`, so an ES module script saved in `/tmp/aiwb-env-app-update` can `import { chromium, _electron } from "playwright"` |

Never touch anything of the user's own AI Whiteboard: port 4747, port 4749 (the web e2e
script's default), `~/.ai-whiteboard`, `~/Applications/AI Whiteboard.app`, or
`~/Library/Application Support/AI Whiteboard`. The user's real server or app may be running. Never
stop or kill a process that does not belong to this environment (match on `-home $AIWB_ENV_HOME`
or `--user-data-dir=$AIWB_ENV_USERDATA`, never on the program name alone).

## Steps and pass criteria

0. `source /tmp/aiwb-env-app-update/env.sh`; `/tmp/aiwb-env-app-update/install.sh old`.
1. Old server running: start the app; wait for the main window on `$AIWB_ENV_URL`. `/api/hello` →
   `version` `e2e-old`, `webVersion` `e2e-old`, pid P1. No banner in the window. Quit the app
   (the server keeps running; P1 still answers).
2. Tab T: a Playwright `chromium` tab opens `$AIWB_ENV_URL` (an old page). No banner.
3. Install the new build over it: `install.sh new`. `/api/hello` → `version` `e2e-old`, pid P1,
   `webVersion` `$AIWB_ENV_NEW_VERSION`.
4. Start the app (now the new build). Pass: the main window loads `$AIWB_ENV_URL`; `/api/hello`
   pid is still P1 (starting the app did not stop the old server); within 10 s the window's sidebar
   shows "New version installed. The server is still running the old one." and **Restart server**;
   tab T shows "Opened in another window".
5. Count the main window's `did-finish-load` events in the main process, then click **Restart
   server** in the app window (no agent chats run, so no confirm dialog; if one appears, the step
   fails). Pass: "Restarting…" shows; within 45 s `/api/hello` → `version`
   `$AIWB_ENV_NEW_VERSION` and a pid P2 ≠ P1; P1 is gone; the window reloaded (the count grew) and
   shows no banner.
6. Tab T: click **Use here**. Pass: within 10 s tab T shows "This page is out of date." and
   **Reload**. Click **Reload** → no banner; `/api/hello` pid still P2.
7. Close the browser and quit the app. Pass: P2 is still running.

## Done

The task is done when every step passes. When a step fails, the script stops there and the
report names the step, what was expected, and what the script saw (command output, exit codes,
`/api/hello` answers, the main-process recorders' contents, the page text, and a screenshot of the
window or tab). Copy screenshots and `$AIWB_ENV_HOME/server.log` to `/tmp/aiwb-check-app-update-report/`
before tearing down. Whatever the outcome, finish by running `/tmp/aiwb-env-app-update/destroy.sh` and closing every
browser and app the script opened.
=====END BODY T23=====
