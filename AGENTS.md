# Building and testing

For agents and people who change this repository. What the app is and how it fits together is in
`README.md`; this file is only about which tests to run, when, and how to write them.

## Two sets of Go tests

```sh
go test ./internal/<pkg>                    # default set: fast, what you run while working
AIWB_TEST_FULL=1 go test ./internal/<pkg>   # full set: every test, each in full
```

- The **default set** starts few processes and is meant to pass on a loaded machine.
- The **full set** adds what is too slow for every edit: exhaustive matrices (a restart at every
  step of a run, every corner of delivering a result; the default set runs a representative
  slice), tests that build the server binary and start real server processes
  (`cmd/ai-whiteboard`: 66 such tests are in the full set only, six cheap ones run in the default
  set too, `TestRunE2ENoGit` and five smoke tests), tests that need the real `pi` installed (`internal/pibridge`,
  `internal/boardapi`), `openssl` (`internal/remote`) or the network's resolver
  (`internal/servers`), and stress loops at their full number of rounds.
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
| Before you finish a task | `go test ./...` once, and `AIWB_TEST_FULL=1 go test ./<pkg>` for each package whose code or tests you changed. If you changed `internal/rungit` or `internal/runs`, the full set of both (`runs` is the main user of `rungit`). |
| Final check of a whole piece of work (the end of a run, before a release) | `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, while nothing else is testing on the machine. |
| You changed code where goroutines share state | Also `go test -race ./<pkg>` for that package. |
| You changed only `web/` or `desktop/` | `cd web && npm test && npm run check`, `cd desktop && npm test` (a few seconds). No Go tests. |
| You changed only documentation | No tests. |

## What it costs

Measured on a 14-core Mac; the numbers move a little.

| Command | Alone | With four agents testing at once |
|---|---|---|
| `go test ./...`, nothing cached | about 1 minute | about 3 minutes each |
| `go test ./...` again, nothing changed | about 4 seconds | |
| `AIWB_TEST_FULL=1 go test ./...`, nothing cached | about 2 minutes | about 7.5 minutes each, nearly all of it `internal/runs`, which can then hit Go's 10-minute test timeout |
| `go test -race ./...` | about 1.5 minutes | |
| `AIWB_TEST_FULL=1 go test -race ./...` | about 5 minutes | |

With eight agents testing at once, `go test ./...` takes about 6 minutes each.

Per package, alone, default / full: `internal/runs` about 37 s / 1.5 min (it alone sets the time of
`./...`), `internal/rungit` 17 s / 30 s, `cmd/ai-whiteboard` 6 s / 67 s, `internal/server`
2 s / 3 s, `internal/servers/linksim` 1.5 s / 4 s. `internal/chats`, `internal/cursor`,
`internal/claude` and `internal/pi` take about 6 to 8 s in either set; every other package
(`internal/remotes` and `internal/servers` among them) under 3 s. Inside `go test ./...` the
packages run side by side and each takes longer than alone: `internal/runs` about 45 s / 2 min,
`internal/rungit` 27 s / 60 s, `internal/chats` 12 s, `internal/cursor` and `internal/pi` 10 s.

**Why.** The tests of `internal/runs` and `internal/rungit` work on real git repositories and
start tens of thousands of git processes, and the machine starts only about 1,000 processes a
second in total, however many cores it has. So tests that run at the same time do not run in
parallel, they queue: four suites at once take four times as long each, and more `-p` or
`-parallel` does not help.

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

**Your command timeout is 10 minutes** and the full set of `internal/runs` may not fit on a busy
machine. Split it in two:

```sh
AIWB_TEST_FULL=1 go test -run '^TestRestartAtEveryStep$' ./internal/runs
AIWB_TEST_FULL=1 go test -skip '^TestRestartAtEveryStep$' ./internal/runs
```

## Writing or changing a test

- **Which set.** Never call `testing.Short()`; use `testset`. A test goes to the full set only if,
  after it has been made as fast as it can be, it still takes more than about a second alone,
  starts hundreds of processes, or needs a tool that may not be installed (the real `pi`, `openssl`,
  a build of the server). Call `testset.SkipUnlessFull(t, reason)` with a reason that names the
  default-set test covering the same behaviour. Every distinct behaviour keeps at least one test
  in the default set: thin a matrix with `testset.Full()`, do not gate it whole.
- **Process starts are the cost.** A whole run of the engine in a test is about 200 git processes.
  Prefer one git command to several, share what can be built once per test binary, and do not add
  a whole run where a cheaper test proves the same.
- **Do not wait out production waits.** Make the wait overridable (a field, an unexported
  variable, a context value) and let the test lower it; the production value stays as it is.
  A test of real server processes (`cmd/ai-whiteboard`) cannot reach into the server, so the
  server reads the hidden variable `AIWB_TEST_WAITS` (`cmd/ai-whiteboard/testwaits.go`): a list
  such as `silence=3.5s,backoff=3s`, with the names `ping`, `silence`, `backoff`, `start` and
  `agents`; unset, every wait is the production one. The test does not write the list by hand: it
  picks a `clock` (`testwaits_test.go`; `fast` divides by 10), passes `fast.env(t, "silence")` as
  the environment of its servers and divides its own times with `fast.of(60 * time.Second)`, so it
  crosses the same waits in the same order. `AIWB_TEST_REAL_WAITS=1` runs these tests with the
  production waits (some four minutes for the slowest), as a check against the real values.
- **Tests must pass when the machine is four times slower than usual.** An upper bound for
  something that must happen is generous: seconds, not milliseconds. A short timeout inside which
  a process has to start must not decide the test: wait for a sign that the process started, or
  count an attempt only when its precondition was seen and retry with a longer one.
- **Parallelism.** Tests that share no state call `t.Parallel()` (not together with `t.Setenv`).
  A package whose tests start git calls `agenttest.FastGit()` and `agenttest.LimitParallel()` in
  its `TestMain`, before `m.Run()`; see `internal/rungit/rungit_test.go`.
