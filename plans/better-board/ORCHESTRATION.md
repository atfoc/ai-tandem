# How the better-board prototype is worked on (read this first)

Every agent working on this goal reads this file and `better-board-prototype-goal.md` ("the goal") in the integration
worktree. Paths are absolute.

- Repository root: `/Users/pedjat/Documents/projects/ai-whiteboard`
- Integration worktree (branch `better-board-prototype`):
  `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/better-board-prototype`
- Plans, decisions and findings: `plans/better-board/` in the integration worktree.
- Repository rules: `AGENTS.md` (but see "Testing" below, which narrows it for this goal). How the system fits together
  today: `docs/architecture.md`. The headless writer this grows out of: `plans/headless-board/` (its architecture,
  engine and spike notes are worth reading), `packages/headless`, `packages/board-engine`, `internal/headless`.

## Who does what

- **Opus 5.5, effort high** (`spawn_subagent` with `model: "opus", effort: "high"`): decisions, architecture, splitting a
  goal into packages, reviewing, risky spikes whose outcome changes the design, and any package that a medium run failed
  twice.
- **Opus 5.5, effort medium** (`model: "opus", effort: "medium"`): implementation. **Most packages go here.**
- **Split before delegating.** A package handed to a medium run is small and well defined: what to build, where, the
  interface it must satisfy, how to check it (exact commands), what not to touch. If it is bigger, split it and
  delegate the parts (subagents may spawn subagents).
- **Escalation.** A medium package that fails is handed to medium once more with what went wrong; if that fails too,
  to high.
- **Run in parallel what is independent.** Spawn independent packages together, then end your turn and wait for their
  results (no polling, no sleeping).

## Worktrees and branches

- Every agent that changes code works in its **own git worktree under
  `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name>`**, on a branch of the same name, made from the
  branch of the agent that spawned it:
  `git -C <parent worktree> worktree add /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name> -b <name>`.
  Names start with `bb-`.
- Commit your work on your branch; the message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never leave work uncommitted.
- **The agent that spawned you merges your branch** into its own when you report done. Before reporting, merge your
  parent's branch into yours if it moved, and resolve conflicts.
- After merging a child's branch, remove its worktree (`git worktree remove`), keep the branch.
- Never push, never touch `main`, never rewrite a branch someone else uses. Never use bare `git stash`.
- Do not commit `node_modules`, build outputs or large binaries.

## Dependencies

Do not run a full `npm install` in a new worktree. Clone the parent's installed folders (APFS copy-on-write, almost no
space; workspace links are relative):

```sh
P=<parent worktree>
cp -c -R $P/node_modules ./node_modules && cp -c -R $P/app/node_modules ./app/node_modules 2>/dev/null
for d in $P/packages/*/node_modules; do cp -c -R "$d" "./packages/$(basename $(dirname $d))/node_modules"; done
```

Run `npm install` only when your branch changes a `package.json` or the lock file. For `web/` and `desktop/`, clone
the parent's if it has them, else install there.

**tldraw version.** Everyone uses the same exact tldraw version (and the matching `@tldraw/*` packages), pinned exactly
(no `^`). The first package that adds tldraw records the version in `plans/better-board/decisions.md`; later ones use it.

## Testing (the user's rules for this goal; they override the goal's "committed scripts" and `AGENTS.md` where they differ)

- **No end-to-end tests are added.** They are slow and costly and get re-run too often.
- Find the **simplest, cheapest way to confirm something works**. Usually: unit tests for logic.
- For UI: let the client run on mock data (temporary code on the client or the server, whichever is easier; no fake
  server needed) to see how it looks and behaves, then remove the temporary code.
- Prototyping on a real browser / emulator to learn how something behaves is fine, but it is **research, not a test**.
- **Full app runs** only when you must, as **temporary scripts that are not committed** (put them in `/tmp/<your
  name>/`). Keep them focused on what changed; when something changes, re-check only the affected part.
- The goal's checks (section 6) are confirmed this way; the result (and screenshots, under
  `plans/better-board/shots/`, small PNGs only) goes into the findings, not into committed test scripts.
- The repository's existing unit tests for packages you change still pass (`go test ./internal/<pkg>`, root
  `npm test && npm run check` when you touch `app/` or `packages/*`). Do not run the whole Go suite or the full set
  while iterating; no `-count=1` by habit; no paid tests ever (goal 4.11).

## The machine is shared

- **The user's real AI Whiteboard server runs on ports 4748 and 6006** (it runs this orchestration). Never stop it,
  never run `ai-whiteboard stop` without `-home <your scratch folder>`, never touch `~/.ai-whiteboard` or
  `~/Library/Application Support/AI Whiteboard`.
- To try something against a real Go server, start a **scratch server** as `web/e2e/lib/rig.mjs` (class `Scratch`)
  does: `go build -o <tmp>/ai-whiteboard ./cmd/ai-whiteboard`, `remote setup -home <tmp>/home -port <free port> -name
  127.0.0.1`, then `launch -json -home <tmp>/home -cwd <tmp>/work -claude /nonexistent/claude -cursor /nonexistent/agent
  -pi /nonexistent/pi -cursor-cost /nonexistent/cursor-cost` with `AIWB_MCP_PORT=0 AIWB_REMOTE_BIND=127.0.0.1`. Stop it
  with `stop -home <tmp>/home`.
- Other agents work in other worktrees at the same time. No device simulators for this goal (out of scope).
- **Never end your turn while a build, test or script you depend on is still running.** Your turn ending is your
  report.

## Reporting

End your run with a short report: **done / failed / blocked**, branch and last commit, what was built, the exact
commands that check it and their result, what is left or uncertain, and any decision someone else must know. Longer
findings (spike results, measurements) go in a markdown file under `plans/better-board/` on your branch. Any departure
from goal section 7 is written in `plans/better-board/deviations.md` (one entry each: what, why) so the findings report
can list them.
