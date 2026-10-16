# How the Excalidraw optimization is worked on (read this first)

Every agent on this work reads this file, `excalidraw-optimization-goal.md` (the goal) and `AGENTS.md` in the
integration worktree. Paths are absolute.

- Repository root: `/Users/pedjat/Documents/projects/ai-whiteboard`
- Integration worktree (branch `excalidraw-optimization`): `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/excalidraw-optimization`
- Plans, findings and measurements: `plans/excalidraw-optimization/` on your branch.

## Who does what

- **Opus 5.5, effort high** (`model: "opus", effort: "high"` in `mcp__board__spawn_subagent`, `agent: "claude"`):
  decisions, architecture, splitting a goal into packages, reviewing, and any package that Sonnet failed twice in a row.
- **Sonnet 5.5, effort high** (`model: "sonnet", effort: "high"`): implementation. Most packages go to Sonnet.
- **Escalation.** A package Sonnet does not complete goes to Sonnet once more, with what went wrong. If that second run
  also fails, it goes to Opus. "Fails": it reports it could not finish, or the package's acceptance checks do not pass
  when you run them yourself.
- **Split before delegating.** A package for Sonnet is small and well defined: what to build, where, the interface it
  must satisfy, the exact commands that check it, and what not to touch.
- **Run in parallel what is independent.** Spawn independent packages at once, then end your turn and wait for the
  results (do not poll or sleep).

## Worktrees and branches

- Every agent that changes code works in its own git worktree under
  `/Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name>`, on a branch of the same name, made from its
  parent's branch: `git -C <parent worktree> worktree add /Users/pedjat/Documents/projects/ai-whiteboard/.worktrees/<name> -b <name>`.
  Names start with `xo-`.
- A new worktree has no `node_modules`: run `npm install` at its root (and in `web/` if you need the browser tools;
  Playwright: `npm install --no-save playwright@1.64.1 && npx playwright install chromium webkit` in `web/`).
- Commit your work on your branch, message ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` or
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not leave work uncommitted.
- The agent that spawned you merges your branch into its own when you report done. Before reporting, merge your parent's
  branch into yours if it moved. After merging a child, `git worktree remove` its worktree and keep the branch.
- Never push, never touch `main`, never rewrite a shared branch's history. Never use bare `git stash`.
- Do not commit `node_modules`, build outputs (`dist-webview/`, `app/public/board/`, `app/dist-web`), `app/ios/`,
  `app/android/`, logs or large binaries.

## The machine is shared

- A real AI Whiteboard server of the user runs on ports 4748 and 6006 (it runs this orchestration). Never stop it,
  never touch `~/.ai-whiteboard` or `~/Library/Application Support/AI Whiteboard`.
- Other agents work in other worktrees. Simulators: create your own (`xcrun simctl create xo-<name> "iPhone 17"`) and
  delete it at the end. The Android emulator: lock with `mkdir /tmp/aiwb-android-emulator.lock`, `rmdir` when done.
- **Physical devices** (iPhone 15 Pro "Pedja", iPad Air 4 "Ana's iPad"; `xcrun devicectl list devices`): only one agent
  at a time installs on a device: lock with `mkdir /tmp/aiwb-ios-device.lock`, `rmdir` when done. The install script is
  `node app/scripts/install.mjs --platform ios --device <name>` (`docs/development.md`); its signing team comes from the
  user's shell: run it under `zsh -ic '...'` so `~/.zshrc` is read. Never write a team id or any Apple account detail
  into the repository or a report.
- Heavy builds are slow: never "to be sure". No paid tests (`AGENTS.md`).
- Never end your turn while a build, test or script you depend on is still running: your turn ending is your report.

## Reporting

End your run with a short report: **done / failed / blocked**, the branch and last commit, what was built, the exact
commands that check it and their result, what is left or uncertain, and any decision someone else must know. Longer
findings go in a markdown file under `plans/excalidraw-optimization/` on your branch.
