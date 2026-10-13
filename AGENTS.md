# Building and testing

For agents and people who change this repository. What the app is and how it fits together is in
`README.md`; this file is only about which tests to run, when, and how to write them.

## Two sets of Go tests

```sh
go test ./internal/<pkg>                    # default set: fast, what you run while working
AIWB_TEST_FULL=1 go test ./internal/<pkg>   # full set: every test, each in full
```

- The **default set** starts few processes and is meant to pass on a loaded machine.
- The **full set** adds what is too slow for every edit: tests that build the server binary and
  start real server processes (`cmd/ai-whiteboard`: 49 such tests are in the full set only, six
  cheap smoke tests run in the default set too), tests that need the real `pi` installed
  (`internal/pibridge`, `internal/boardapi`), `openssl` (`internal/remote`) or the network's
  resolver (`internal/servers`), and matrices and stress loops at their full number of cases and
  rounds (the default set runs a representative slice).
- The switch is `internal/testset`. `-short` never runs more than the default set, even with
  `AIWB_TEST_FULL=1`.
- To see what a package leaves out of the default set:

```sh
go test -v ./internal/<pkg> 2>&1 | grep 'full set only'   # tests that skip, each with its reason
grep -rn 'testset.Full()' cmd internal                    # matrices that run fewer cases
```

**Paid tests are a different thing.** `AIWB_CLAUDE_E2E=1`, `AIWB_CURSOR_E2E=1` and `AIWB_PI_E2E=1`
call paid models, and so does `web/e2e/app.e2e.mjs`. They are off by default. Never run them
unless the person asks.

## Which set to run when

| When | Run |
|---|---|
| While working on a change | The default set of the packages you changed: `go test ./internal/<pkg>`, or one test with `-run '^TestName$'`. No `-count=1`. Not the whole suite after every edit. |
| Before you finish a task | `go test ./...` once, and `AIWB_TEST_FULL=1 go test ./<pkg>` for each package whose code or tests you changed. |
| Final check of a whole piece of work (before a merge, before a release) | `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, while nothing else is testing on the machine. |
| You changed code where goroutines share state | Also `go test -race ./<pkg>` for that package. |
| You changed only `web/` or `desktop/` | `cd web && npm test && npm run check`, `cd desktop && npm test` (a few seconds). No Go tests. |
| You changed only documentation | No tests. |

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
`internal/claude` about 5 s in either set, `internal/pibridge` 1.5 s / 3 s,
`internal/servers/linksim` 1.5 s / 4 s; every other package (`internal/server`,
`internal/remotes` and `internal/servers` among them) under 3 s in either set. Inside
`go test ./...` the packages run side by side and each takes longer than alone:
`internal/chats` 11 s, `internal/cursor` and `internal/pi` 8 s.

**Why.** The tests start processes (agent stand-ins, Node, real servers), and the machine starts
only about 1,000 processes a second in total, however many cores it has. So suites that run at
the same time do not run in parallel, they queue: four at once take three to four times as long
each, and more `-p` or `-parallel` does not help. At that load the tests with short waits
failed in some of the measured runs (`TestStepLimit` of `internal/servers`, `TestRoundTrip` of
`internal/servers/linksim`, some tests of `internal/remotes`): see the rule
below for a test your change cannot have touched.

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
  such as `silence=3.5s,backoff=3s`, with the names `ping`, `silence`, `backoff`, `start`,
  `agents`, `images`, `tooold` and `imagecall`; unset, every wait is the production one. The test does
  not write the list by hand: it picks a `clock` (`testwaits_test.go`; `fast` divides by 10), passes
  `fast.env(t, "silence")` as the environment of its servers and divides its own times with
  `fast.of(60 * time.Second)`, so it crosses the same waits in the same order.
  `AIWB_TEST_REAL_WAITS=1` runs these tests with the production waits (some four minutes for the
  slowest), as a check against the real values.
- **Tests must pass when the machine is four times slower than usual.** An upper bound for
  something that must happen is generous: seconds, not milliseconds. A short timeout inside which
  a process has to start must not decide the test: wait for a sign that the process started, or
  count an attempt only when its precondition was seen and retry with a longer one.
- **Parallelism.** Tests that share no state call `t.Parallel()` (not together with `t.Setenv`).
  A package whose tests mostly wait for processes they start calls `agenttest.LimitParallel()` in
  its `TestMain`, before `m.Run()`; see `cmd/ai-whiteboard/main_test.go`.
