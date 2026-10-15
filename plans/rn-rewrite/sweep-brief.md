# The integration sweep: rules for its packages

The sweep (branch `rn-sweep`, worktree `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/rn-sweep`) is the
step before D2 (the desktop app switches to the web build) and R1 (the old page is retired). Its packages are named
`rn-sw-<word>`. Every package reads, before it starts:

- `plans/rn-rewrite/ORCHESTRATION.md` (worktrees, commits, the shared machine, reporting) and `AGENTS.md` (tests);
- `web/dev/checks-app/README.md` (how a check of the new build is written and run, how an old check is ported);
- `plans/rn-rewrite/LOOSE-ENDS.md` (where its item came from) and the notes of the packages its task names.

## Your worktree

```sh
git -C /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/rn-sweep worktree add ../<name> -b <name>
cd /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name>
npm ci --no-audit --no-fund                      # the workspaces (app, packages/*), about 5 s
(cd web && npm install --no-save --no-audit --no-fund playwright)   # web's own deps and Playwright (chromium is installed)
```

## Running checks

- Several agents run checks at the same time. **Always give your own mock port**: `PORT=<your port>` (named in your
  task) on every `npm run uicheck:app`, `npm run uicheck` and single check you run. One check alone:
  `cd web && PORT=<port> npm run uicheck:app -- <ID>` (or `VIEWPORT=phone PORT=<port> node dev/checks-app/<file>`).
  To save the 5 s build on repeated runs, build once and pass `DIST` (README, "DIST=").
- Do **not** run the whole `uicheck:app` (it is long and the sweep runs it at the end). Run the checks your change
  touches, at every viewport they list, and the old one with the same ID on the old page (`npm run uicheck -- <ID>`)
  when you changed anything the old one shares (`shot.mjs`, the mock).
- **A check that fails is a finding, not noise.** Find the cause and fix it in the app or the check. No retries
  around it, no longer timeouts, no `viewport !== …` to step around it, no flag set back to false without a written
  reason. If a check that your change cannot have touched fails, run it again alone once; if it passes alone, report
  its ID and failure line and go on.
- No simulator, no emulator, no paid test.

## What you may change

- What your task names. If the fix of your item needs a change elsewhere in `app/src` (a testID, a `dataSet`, a
  primitive), make it, small, and say so in your report: other packages run at the same time, and the sweep merges
  them all.
- Do **not** edit `web/dev/checks-app/README.md`, `plans/rn-rewrite/LOOSE-ENDS.md`, `plans/rn-rewrite/architecture.md`
  or `plans/rn-rewrite/parity-report.md`: put what they should say in your report, the sweep writes them.
- A check you change keeps its first comment true: what it proves, what it ports, each deviation and why.

## Finishing

- `cd app && npm run check && npm test` when you changed `app/`; `cd web && npm test && npm run check` when you changed
  `web/`.
- Commit (message ending `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`, or Opus), merge `rn-sweep` into
  your branch if it moved, run your checks again if the merge brought changes to what they cover.
- Report: done / failed / blocked, branch and last commit, what changed (files), the exact commands you ran and their
  result (each check, each viewport), and what is left or decided, with the lines the sweep should write in README,
  architecture or the parity report.
