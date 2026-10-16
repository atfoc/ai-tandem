# How the headless-board work is worked on (read this first)

Every agent working on this goal reads this file and `headless-board-goal.md` (the goal, "the goal" below) in the
integration worktree. Paths below are absolute.

- Repository root: `/Users/pedjat/Documents/projects/ai-whiteboard`
- Integration worktree (branch `headless-board`): `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/headless-board`
- Plans and reports: `plans/headless-board/` in the integration worktree (architecture, work packages, spike reports).
- Testing rules of the repository: `AGENTS.md`. They hold for every agent. How the system fits together today:
  `docs/architecture.md`.
- A throwaway trial made before the goal was written (Excalidraw's element code in Node with a stand-in page and a
  native canvas, compared against Chromium) is in `/tmp/exnode` (not in the repository; read it, do not depend on it).

## Who does what

- **Opus 5.5, effort high** (`model: "opus", effort: "high"` in `spawn_subagent`): decisions, architecture, splitting
  a goal into packages, reviewing, and any package that Sonnet failed twice in a row.
- **Sonnet 5.5, effort high** (`model: "sonnet", effort: "high"`): implementation. Most packages go to Sonnet.
- **Escalation.** When you hand a package to Sonnet and it does not complete it, hand it to Sonnet once more with what
  went wrong. If the second Sonnet run also fails, hand it to Opus. "Fails" means: it reports it could not finish, or the
  package's acceptance checks do not pass when you check them.
- **Split before delegating.** A package handed to Sonnet is small and well defined: what to build, where, the interface
  it must satisfy, how to check it (the exact commands), and what not to touch. If a goal is larger than that, split it
  and delegate the parts (you may spawn subagents, and they may spawn theirs).
- **Run in parallel what is independent.** Spawn independent packages at the same time, then end your turn and wait
  for their results (do not poll or sleep).

## Worktrees and branches

- Every agent that changes code works in its **own git worktree under
  `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name>`**, on a branch of the same name, made from the
  branch of the agent that spawned it:
  `git -C <parent worktree> worktree add /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name> -b <name>`.
  Names start with `hb-`.
- Install dependencies in your worktree as needed (`npm install` at its root; `node_modules` is ignored).
- Commit your work on your branch, with a clear message ending with a `Co-Authored-By:` line that names the model you
  are: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` or `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  Do not leave work uncommitted.
- **The agent that spawned you merges your branch** into its own branch when you report done. Keep your branch
  mergeable: before reporting, merge your parent's branch into yours if it moved, and resolve conflicts.
- When you merge a child's branch, remove its worktree afterwards (`git worktree remove`), keep the branch.
- Never push, never touch `main`, never rewrite history of a branch someone else uses. Never use bare `git stash`.
- Do not commit `node_modules`, build outputs, simulator logs or large binaries (font files that the product ships are
  a decision of the architecture, see its doc).

## The machine is shared

- **A real AI Whiteboard server of the user runs on ports 4748 and 6006** (it also runs this very orchestration).
  Never stop it, never run `ai-whiteboard stop` without `-home <your scratch folder>`, never touch `~/.ai-whiteboard`
  or `~/Library/Application Support/AI Whiteboard`.
- To test against a real Go server, start a **scratch server** as `web/e2e/lib/rig.mjs` (class `Scratch`) does: build
  the binary (`go build -o <tmp>/ai-whiteboard ./cmd/ai-whiteboard`), `remote setup -home <tmp>/home -port <free port>
  -name 127.0.0.1`, then `launch -json -home <tmp>/home -cwd <tmp>/work -claude /nonexistent/claude -cursor
  /nonexistent/agent -pi /nonexistent/pi -cursor-cost /nonexistent/cursor-cost`, with the environment
  `AIWB_MCP_PORT=0 AIWB_REMOTE_BIND=127.0.0.1`. Stop it with `stop -home <tmp>/home` when done.
- Other agents work in other worktrees at the same time. Do not run the whole Go suite unless `AGENTS.md` asks for it,
  never the full set of `./...` while others test, no `-count=1` by habit, no paid tests (goal 4.11).
- Device tests (simulators) only if the board's window or the native side changed (goal 6.6); create your own simulator
  (`xcrun simctl create hb-<your name> "iPhone 17"`) and delete it at the end.
- **Never end your turn while a build, test or script you depend on is still running.** Your turn ending is your
  report: nobody resumes you. Run long commands in the foreground (with a generous timeout), or wait for a background
  one in the foreground before you go on.

## Reporting

End your run with a short report: **done / failed / blocked**, the branch and last commit, what was built, the exact
commands that check it and their result, what is left or uncertain, and any decision you made that someone else must
know. Write longer findings (spike results, measurements) as a markdown file under `plans/headless-board/` on your
branch.

## Disk

The disk of this machine is nearly full (a few GB free). Each worktree's `npm install` takes about 750 MB. Check
`df -h /System/Volumes/Data` before an install or a build; write no large temp files; never delete what is not yours
(other sessions' `/tmp` folders, caches in use). When the disk runs out, report it and stop.

**Do not run a full `npm install` in a new worktree.** Clone the integration worktree's installed folders instead; APFS
copies them copy-on-write, so they take almost no space, and the workspace links are relative, so they point at your own
`packages/*`:

```sh
I=/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/headless-board
cp -c -R $I/node_modules ./node_modules && cp -c -R $I/app/node_modules ./app/node_modules
```

Run `npm install` only if your branch changes a `package.json` or the lock file (it then changes only what differs). For
`web/` and `desktop/`, clone theirs the same way if the integration worktree has them, else install there.

