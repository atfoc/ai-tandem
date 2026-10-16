# Building and testing

For agents and people who change this repository. What the app is is in `README.md` and how it fits together is in
`docs/architecture.md`; this file is only about which tests to run, when, and how to write them. The code is the Go server
(`cmd/`, `internal/`), the React Native app (`app/`, on iOS, iPadOS, Android and, as a web build, in the Electron window of
`desktop/`) with its packages (`packages/core`, `conn`, `board-bridge`, `board-view`, and `board-engine`, the board view's engine in Node, and `headless`, the Node process that edits boards while no window is open; the Go side of it is `internal/headless`), and the tools that test them (`web/dev`: the test
host, the mock and the browser checks; `web/e2e`: the end-to-end scripts; `app/e2e`: the device tests).

## Two sets of Go tests

```sh
go test ./internal/<pkg>                    # default set: fast, what you run while working
AIWB_TEST_FULL=1 go test ./internal/<pkg>   # full set: every test, each in full
```

- The **default set** starts few processes and is meant to pass on a loaded machine.
- The **full set** adds what is too slow for every edit: tests that build the server binary and
  start real server processes (`cmd/ai-whiteboard`: 38 such tests are in the full set only, six
  cheap smoke tests run in the default set too), tests that need the real `pi` installed
  (`internal/pibridge`, `internal/boardapi`) or `openssl` (`internal/remote`), and matrices and
  stress loops at their full number of cases and rounds (the default set runs a representative
  slice).
- The switch is `internal/testset`. `-short` never runs more than the default set, even with
  `AIWB_TEST_FULL=1`.
- To see what a package leaves out of the default set:

```sh
go test -v ./internal/<pkg> 2>&1 | grep 'full set only'   # tests that skip, each with its reason
grep -rn 'testset.Full()' cmd internal                    # matrices that run fewer cases
```

**Paid tests are a different thing.** `AIWB_CLAUDE_E2E=1`, `AIWB_CURSOR_E2E=1` and `AIWB_PI_E2E=1`
call paid models, and so does `web/e2e/app.e2e.mjs`. They are off by default. Never run them
unless the person asks. The other scripts of `web/e2e` and `desktop/e2e` spend no money; they are
under "The JavaScript tests" below.

## Which set to run when

| When | Run |
|---|---|
| While working on a change | The default set of the packages you changed: `go test ./internal/<pkg>`, or one test with `-run '^TestName$'`. No `-count=1`. Not the whole suite after every edit. |
| Before you finish a task | `go test ./...` once, and `AIWB_TEST_FULL=1 go test ./<pkg>` for each package whose code or tests you changed. |
| Final check of a whole piece of work (before a merge, before a release) | `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, while nothing else is testing on the machine. |
| You changed code where goroutines share state | Also `go test -race ./<pkg>` for that package. |
| You changed only `app/`, `packages/*`, `web/` or `desktop/` | From the repository root `npm test && npm run check` (every workspace: `app`, `packages/*`), `cd web && npm test`, `cd desktop && npm test` (a few seconds each). No Go tests. If the change is to what a screen shows or does: also the browser checks that touch it, `cd web && npm run uicheck -- <ids>` (the whole run is long). |
| You changed `web/dev/host.mjs`, `web/dev/hostface.mjs` or `packages/conn` | Also `cd packages/conn && npm test`, `node --test web/dev/host.test.mjs`, and the free scripts of `web/e2e` that touch what you changed. |
| You changed `packages/headless` (or `packages/core` in a way the headless writer runs: the board side) | `cd packages/headless && npm test && npm run check` (the root `npm test && npm run check` runs it too). If the change is to how the server starts, finds or stops it (`internal/headless`): also `go test ./internal/headless`, and for its flags and its status in `cmd/ai-whiteboard` the default set of that package. |
| You changed `packages/board-view/src/{engine,apply,export,imagesize,faces,indices}.ts` (the code the window and the Node engine share) or `packages/board-engine` | Also `cd packages/board-engine && npm test && npm run check`, which runs the engine in Node. If the change is to what a request answers (elements, text sizes, pictures): also `cd packages/board-engine && npm run faithful` (Playwright, see below), and `node dev/harness.mjs` in `packages/board-view` for the window's side. |
| You changed `app/modules`, the native network, the board in a web view or anything else only a device shows | Also the device flow that covers it (`node app/e2e/run.mjs <flow> --platform ios --device <your own simulator>`, `app/e2e/README.md`). They start simulators and builds: never "to be sure", and not while other agents build. |
| You changed only documentation | No tests. |

## The JavaScript tests

```sh
npm test && npm run check                # at the root: the unit tests and the type checks of app/ and packages/* (core, conn, board-bridge, board-view, board-engine, headless)
cd web && npm test                       # the test host, the mock's face, the helpers of the browser checks
cd desktop && npm test                   # the main process, the IPC face, the preload
cd packages/conn && npm test             # the connection module (@aiwb/conn) against its stand-in server
cd packages/board-engine && npm test && npm run check   # the board engine in Node (@aiwb/board-engine): the stand-in page, the font runs, the endpoint and the assets, against the real native canvas
cd packages/headless && npm test && npm run check   # the headless writer (@aiwb/headless): its loop, its start-up and its bundle, against a fake engine and a fake client
node --test web/dev/host.test.mjs        # the test host alone; `cd web && npm test` runs it too
```

These run in a few seconds and need no built page. The ones below need Playwright, which is no
dependency of the repository (`npm install --no-save playwright && npx playwright install chromium`
in `web/`; a later `npm install` there removes it). They serve or load the app's web build, `app/dist-web`
(`cd app && npm run build:web`), or build their own; none of them calls a paid model, and each says in its header how it runs.

| Command | What it does | Alone |
|---|---|---|
| `cd web && npm run uicheck [-- L1 P0.7]` | the browser checks of `web/dev/checks` (`README.md` there) on the mock (`web/dev/mock.mjs`), each at the viewports it names (desktop, tablet, phone); builds its own export, so no `npm run build:web` first | about 50 minutes for all |
| `cd web && npm run uicheck:electron [-- L8 A2.2]` | the same checks drawn by the desktop app's own Chromium (Electron, `web/dev/electron`); no check named: L8; `--all`: every check | seconds per check |
| `node web/e2e/newchat.e2e.mjs` | the app against a real server through the test host | about 7 s |
| `node web/e2e/localserver.e2e.mjs` | this computer's server in every state it can be in; builds two binaries and two builds of the app itself | about 20 s |
| `node web/e2e/twopages.e2e.mjs` | two apps on one server, one writing and the other a reader that takes the board with **Edit here** | about 100 s |
| `node web/e2e/readers.e2e.mjs` | three pages, the writer, the readers and the button (goal 6.3): a reader follows what the writer saves, a press hands the board over (a change in progress is cut, the finished ones kept), the headless writer's board, two presses together; builds the server, the page and the headless bundle | about 30 s |
| `node web/e2e/remotechat.e2e.mjs` | this computer's server and a remote one, an outage and the return; also `VIEWPORT=phone` | about 60 s |
| `node web/e2e/away.e2e.mjs` | an agent works on boards while no window is connected (reads, changes, asks for a picture, makes another board; the headless writer answers), then a window connects and shows every change in order, as a reader (goal 6.2); builds the server, the page and the headless bundle | about 10 s |
| `node web/e2e/headlessfail.e2e.mjs` | the headless writer killed in the middle of a change (the board keeps the first change, is free to take, the agent is told, a new call starts a new process), and a server on which it cannot run; builds the server, the page and the headless bundle | about 10–25 s |
| `cd desktop && npm run e2e` | the app itself (Electron, a window is opened for a few seconds) on the web build (`cd app && npm run build:web` first): the page over IPC, a stream that is cut, a picture from the app's own scheme | a few seconds |
| `cd packages/board-engine && npm run faithful` | the same requests to the board view's web target in Chromium and to the Node engine: elements, replies, pictures (size, bounds, share of pixels differing), a text corpus; builds the web target itself; writes `report.json` and the diff pictures to `out/faithful`; exit 1 on a difference outside its list of known ones (`dev/faithful.mjs`). Run it when you change `packages/board-engine` or the board view's engine (`apply`, `export`, fonts) | about 10 s |
| `node web/dev/reallibrary.mjs` | the prompt library's popups on real servers; builds what it needs | about 20 s |

The browser checks need a build with the version `uicheck` and a policy that lets the page reach the mock (`--connect-self`): the
runner makes it itself (`buildAppDist` in `web/dev/shot.mjs`; `DIST=` names one made before). The four free scripts (`newchat`, `twopages`,
`remotechat`, `localserver`) use the selectors and the navigation of `web/e2e/lib/ui.mjs` (testIDs; the phone's stack). Run them from the
repository root, `DIST=app/dist-web node web/e2e/<script>.mjs` after `cd app && npm run build:web` (`remotechat` also with `VIEWPORT=phone`;
`localserver` builds its two builds itself and ignores `DIST`). The host serves the page over HTTP, so the page needs `connect-src 'self'` in
its CSP: the shipped export has `'none'`, and the script copies it into its temp folder with that one change (an export made with
`--connect-self` is used as it is). Without `DIST` the script builds its own.

The summary of `uicheck` names the Playwright and the Chromium that drew the pages; the folder passes on Chromium 156 (Playwright 1.64.1,
`npm install --no-save playwright@1.64.1`); `web/dev/checks/README.md` says which two checks fail on older ones.

**The device tests** (`app/e2e`, Maestro on the iOS simulator and the Android emulator; `app/e2e/README.md`) spend no money either, but they
build the app and start simulators: name your own simulator (`--device`), take the lock for the Android emulator, and see the rules of
`plans/rn-rewrite/ORCHESTRATION.md` when several agents work. They run only when the change is one that a browser cannot show.

`web/e2e/app.e2e.mjs` is the paid one: real Claude and Cursor. It is never run unless the person
asks. (Its page steps still read the page the app replaced, by CSS classes, and have to be moved onto `web/e2e/lib/ui.mjs` before it
runs against the app: its header says so.)

## What it costs

Measured on a 14-core Mac; the numbers move a little.

| Command | Alone | With four suites running at once |
|---|---|---|
| `go test ./...`, nothing cached | about 15 seconds | about 50 seconds each |
| `go test ./...` again, nothing changed | about 2 seconds | |
| `AIWB_TEST_FULL=1 go test ./...`, nothing cached | about 40 seconds | about 75 seconds each |
| `go test -race ./...` | about 20 seconds | |
| `AIWB_TEST_FULL=1 go test -race ./...` | about 40 seconds | |

Per package, alone, default / full: `cmd/ai-whiteboard` 6 s / 37 s (it alone sets the time of the
full set of `./...`), `internal/chats` 8 s / 9 s, `internal/cursor`, `internal/pi` and
`internal/claude` about 5 s in either set, `internal/pibridge` 1.5 s / 3 s; every other
package (`internal/server` among them) under 3 s in either set. Inside
`go test ./...` the packages run side by side and each takes longer than alone:
`internal/chats` 11 s, `internal/cursor` and `internal/pi` 8 s.

**Why.** The tests start processes (agent stand-ins, Node, real servers), and the machine starts
only about 1,000 processes a second in total, however many cores it has. So suites that run at
the same time do not run in parallel, they queue: four at once take three to four times as long
each, and more `-p` or `-parallel` does not help. At that load the tests with short waits
can fail: see the rule below for a test your change cannot have touched.

**The test cache.** `go test` without `-count=1` reuses the result of a package whose code and
inputs did not change (inside one worktree). `-count=1` switches that off and makes every run pay
for every package. Use it only to repeat a test on purpose, when hunting a flake.

## Do not

- Add `-count=1` by habit.
- Run the whole suite while iterating.
- Run the full set of `./...` during work, or while other agents are testing.
- Raise `-p` or `-parallel`.
- Run the same suite a second time "to be sure".
- Start tests in the background and end your turn.

**A test fails that your change cannot have touched:** run that one test again alone.

```sh
go test -count=1 -run '^TestName$' ./<pkg>
```

If it passes alone, it is sensitive to load. Say so in your report, with the test's name and the
failure line, and go on; do not investigate it at length.

## Writing or changing a test

- **Which set.** Never call `testing.Short()`; use `testset`. A test goes to the full set only if,
  after it has been made as fast as it can be, it still takes more than about a second alone,
  starts hundreds of processes, or needs a tool that may not be installed (the real `pi`, `openssl`,
  a build of the server). Call `testset.SkipUnlessFull(t, reason)` with a reason that names the
  default-set test covering the same behaviour. Every distinct behaviour keeps at least one test
  in the default set: thin a matrix with `testset.Full()`, do not gate it whole.
- **Process starts are the cost.** Share what can be built once per test binary (the server
  binary, a stand-in program), and do not start a real server or a process where a test in the
  package proves the same.
- **Do not wait out production waits.** Make the wait overridable (a field, an unexported
  variable, a context value) and let the test lower it; the production value stays as it is.
  A test of real server processes (`cmd/ai-whiteboard`) cannot reach into the server, so the
  server reads the hidden variable `AIWB_TEST_WAITS` (`cmd/ai-whiteboard/testwaits.go`): a list
  such as `ping=500ms,images=2s`, with the names `ping`, `agents` and `images`; unset, every wait is
  the production one. The test does not write the list by hand: it picks a `clock`
  (`testwaits_test.go`; `fast` divides by 10), passes `fast.env(t, "ping")` as the environment of
  its servers and divides its own times with `fast.of(60 * time.Second)`, so it crosses the same
  waits in the same order. `AIWB_TEST_REAL_WAITS=1` runs these tests with the production waits, as
  a check against the real values.
  The waits of the app's connection to a server (`packages/conn`: the silence after which a stream
  counts as ended, the intervals of the retries, the time a too-old server waits before it is
  asked again, the time limits of a call) are lowered the same way, through the hidden variable
  `AIWB_APP_WAITS` (`packages/conn/core/timing.js`): a list such as `silence=3.5s,backoff=3s`, with the
  names `silence`, `backoff`, `tooold`, `call`, `start`, `scene`, `imagecall`, `delete`,
  `firstevent` and `hello`. The test host (`web/dev/host.mjs`) and the app read it; a script that
  starts a host in its own process gives the same values as the `timing` option
  (`parseAppWaits("backoff=3s")`).
- **Tests must pass when the machine is four times slower than usual.** An upper bound for
  something that must happen is generous: seconds, not milliseconds. A short timeout inside which
  a process has to start must not decide the test: wait for a sign that the process started, or
  count an attempt only when its precondition was seen and retry with a longer one.
- **Parallelism.** Tests that share no state call `t.Parallel()` (not together with `t.Setenv`).
  A package whose tests mostly wait for processes they start calls `agenttest.LimitParallel()` in
  its `TestMain`, before `m.Run()`; see `cmd/ai-whiteboard/main_test.go`.
