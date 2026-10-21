# How the voice-devices work is worked on (read this first)

Every agent working on this goal reads this file and `voice-devices-goal.md` (the goal, "the goal" below; it builds on `voice-chats-goal.md`) in the
integration worktree. Paths below are absolute.

- Repository root: `/Users/pedjat/Documents/projects/ai-whiteboard`
- Integration worktree (branch `voice-devices`): `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/voice-devices`
- Plans and reports: `plans/voice-devices/` in the integration worktree. `plans/voice-devices/architecture.md` (once
  written) is the design every package follows; `plans/voice-devices/packages.md` lists the work packages. The design of voice as it is today: `plans/voice-chats/architecture.md` (and `status.md` there).
- Testing rules of the repository: `AGENTS.md`. They hold for every agent. How the system fits together today:
  `docs/architecture.md`. Earlier work on the React Native app: `plans/rn-rewrite/` (its `architecture.md`,
  `ORCHESTRATION.md`, and the reports of the composer, sheets and settings work are useful background).
- The board "whiteboard" the goal names is not in the repository. Where the goal leaves something open (its section 8:
  the wording of the notices, the look of the pause), follow the goal's words and the app's existing look, and write
  down what you chose in `plans/voice-devices/status.md` under "Choices to confirm".
- Other worktrees (`voice-speach-mode-transcribes-itself`, `voice-improvement`, ...) belong to other work. Do not touch them.

## Who does what

- **Opus 5.5, effort high** (`model: "opus", effort: "high"` in `spawn_subagent`): decisions, architecture, splitting
  a goal into packages, reviewing, and any package that Sonnet failed twice in a row.
- **Sonnet 5.5, effort high** (`model: "sonnet", effort: "high"`): implementation. Most packages go to Sonnet.
- **Escalation.** When you hand a package to Sonnet and it does not complete it, hand it to Sonnet once more with what
  went wrong. If the second Sonnet run also fails, hand it to Opus. "Fails" means: it reports it could not finish, or
  the package's acceptance checks do not pass when you check them yourself.
- **Split before delegating.** A package handed to Sonnet is small and well defined: what to build, where, the
  interface it must satisfy, how to check it (the exact commands), and what not to touch. If a goal is larger than
  that, split it and delegate the parts (you may spawn subagents, and they may spawn theirs).
- **Run in parallel what is independent.** Spawn independent packages at the same time, then end your turn and wait
  for their results (do not poll or sleep). Give parallel spawns distinct descriptions.
- Always name the model and the effort in `spawn_subagent`, and tell the subagent to read this file first.

## Worktrees and branches

- Every agent that changes code works in its **own git worktree under
  `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name>`**, on a branch of the same name, made from the
  branch of the agent that spawned it:
  `git -C <parent worktree> worktree add /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name> -b <name>`.
  Names start with `vd-`.
- Commit your work on your branch, with a clear message ending with a `Co-Authored-By:` line that names the model you
  are: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` or
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not leave work uncommitted.
- **The agent that spawned you merges your branch** into its own branch when you report done. Keep your branch
  mergeable: before reporting, merge your parent's branch into yours if it moved, and resolve conflicts.
- When you merge a child's branch, remove its worktree afterwards (`git worktree remove`), keep the branch.
- Never push, never touch `main`, never rewrite history of a branch someone else uses. Never use bare `git stash`.
- Do not commit `node_modules`, build outputs, simulator logs or large binaries.

## The Go server is not touched

Goal 4.1: no change under `cmd/` or `internal/`. If a package seems to need one, stop and report it; do not make it.

## No money is spent

Goal 4.12: no test, check or script calls the real ElevenLabs service (`api.elevenlabs.io`) or a paid model. Use the
stand-in voice service the architecture defines. No real ElevenLabs key exists on this machine and none is needed. No
paid tests of `AGENTS.md` (`AIWB_CLAUDE_E2E`, `AIWB_CURSOR_E2E`, `AIWB_PI_E2E`, `web/e2e/app.e2e.mjs`).

## The machine is shared

- **A real AI Whiteboard server of the user runs on ports 4748 and 6006** (it also runs this very orchestration).
  Never stop it, never run `ai-whiteboard stop` without `-home <your scratch folder>`, never touch `~/.ai-whiteboard`
  or `~/Library/Application Support/AI Whiteboard`.
- To test against a real Go server, start a **scratch server** as `web/e2e/lib/rig.mjs` (class `Scratch`) does.
- Other agents work in other worktrees at the same time. Follow `AGENTS.md` on which tests to run; no `-count=1` by
  habit, no full set of `./...`.
- Device tests (simulators) only where the goal asks for them (goal 6.5, 6.6: the native device list, route changes and the audio session);
  create your own simulator (`xcrun simctl create vd-<your name> "iPhone 17"`) and delete it at the end. For the
  Android emulator take the lock described in `app/e2e/README.md`.
- **Never end your turn while a build, test or script you depend on is still running.** Your turn ending is your
  report: nobody resumes you. Run long commands in the foreground (with a generous timeout).

## Reporting

End your run with a short report: **done / failed / blocked**, the branch and last commit, what was built, the exact
commands that check it and their result, what is left or uncertain, and any decision you made that someone else must
know. Write longer findings (spike results, measurements) as a markdown file under `plans/voice-devices/` on your
branch.

## Disk and dependencies

Check `df -h /System/Volumes/Data` before an install or a build; write no large temp files; never delete what is not
yours. **Do not run a full `npm install` in a new worktree.** Clone the installed folders of the repository root
instead; APFS copies them copy-on-write, so they take almost no space, and the workspace links are relative, so they
point at your own `packages/*`:

```sh
R=/Users/pedjat/Documents/projects/ai-whiteboard
cp -c -R $R/node_modules ./node_modules && cp -c -R $R/app/node_modules ./app/node_modules
for p in $R/packages/*/node_modules; do n=$(basename $(dirname $p)); [ -d packages/$n ] && cp -c -R $p packages/$n/node_modules; done
# web/ and desktop/ likewise if you need them and the root has them installed:
[ -d $R/web/node_modules ] && cp -c -R $R/web/node_modules ./web/node_modules
[ -d $R/desktop/node_modules ] && cp -c -R $R/desktop/node_modules ./desktop/node_modules
```

Run `npm install` only if your branch changes a `package.json` or the lock file (it then changes only what differs).
A new dependency is a decision of the architecture: name it in your report.
