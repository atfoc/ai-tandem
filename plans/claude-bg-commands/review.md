# Review of the merged work (C1–C8), and the fix chunks

An Opus review of `c9a0100..a1f8d74` against the goal. Its findings are handed to the fix chunks F1–F3 at the end.
Decision on finding 4: a turn end that is not clean (aborted, or with an error) while background work is held closes
the process, for the chat as it already does for a subagent (goal 3.1: the two never differ). Finding 7 is accepted
as it is (it needs pid wrap-around within 2 s). The browser checks L10, L11 and L19 were run by C8 and passed at
desktop, tablet and phone.

## Findings

### 1. Must fix: Stop kills the background shells before the CLI, so a stopped agent can start one more, unseen turn

`internal/claude/claude.go` `Close` (reached from `stopLocked` in `internal/chats/branches.go` and from
`InterruptOf` in `manager.go`). `Close` SIGTERMs the adopted shell groups first, then closes stdin and gives the CLI
its grace before killing its group. A killed shell makes the CLI emit a `task_notification`; the CLI goes on after
stdin closes (goal 2.1), and so does the stand-in (`internal/agenttest/fake-claude`: `child.on("exit")` →
`run(() => turn("", id))` after `stdinClosed`). So the notice starts a self-begun turn after the stop: a paid request,
dropped by the pump (gen changed), with the chat's MCP token still valid during the grace, and any shell that turn
starts is detached and never adopted, so it outlives the group kill (breaks 3.4, 4.5).

Fix: in `Close`, after `agent.Adopt(p.cmd)`, when `len(agent.AdoptedGroups(p.cmd.Process.Pid)) > 0`, signal the
Claude process itself first (SIGTERM to the process, or `agent.SignalGroup(p.cmd, SIGTERM)`), then
`agent.SignalAdopted(p.cmd, SIGTERM)`, then go on as now. The groups are already recorded, so nothing is lost when
the CLI exits first, and `readLoop`'s `EndTree` still runs. A finished agent has no adopted groups, so its close is
unchanged. Invert `TestCloseSignalsTheBackgroundFirst` (`internal/claude/proc_test.go`), which asserts that the
leader outlives the shells. Add a stand-in test: after `Close` of a process with a running `[[bg]]`, the fake starts
no turn (e.g. the fake logs `{"turn":"self"}` to `FAKE_CLAUDE_LOG` when `turn()` runs with `stdinClosed`, and the test
asserts no such line appears).

### 2. Must fix: `Close` runs `ps -A` synchronously, under the chat lock on several paths

`internal/claude/claude.go` `Close`, called under `c.mu` from `stopLocked`, the bg path of `InterruptOf`, `retire`
(`branches.go`) and `restart.go`. `listProcs` runs `ps -A -o pid=,ppid=,pgid=`, measured at 290–385 ms per call at
load 3, on top of the existing ≤1 s write grace. Every Stop or Delete of a Claude chat holds `c.mu` that long (over a
second at 4× load), blocking the pump and every API call on that chat; stopping several branches pays it once each.

Fix: move the whole start of `Close` into one goroutine and keep its order (adopt; signal the leader, finding 1;
signal the adopted groups; close stdin with the write grace; the grace timer). `Close` then returns at once, as its
doc says ("does not wait"). Optional: on darwin read the process table with `unix.SysctlKinfoProcSlice("kern.proc.all")`
(golang.org/x/sys is acceptable only if already a dependency; otherwise keep `ps`), on Linux from `/proc`.

### 3. Nice to have: Stop before the pump has seen the background work leaves the command running

`internal/chats/manager.go` `InterruptOf` decides close-or-interrupt from `c.bg.holds()`. If Stop comes after the
CLI started a background Bash but before the pump applied its `EvBackground`, the plain interrupt runs; the turn ends
`Aborted` with `Background.Running>0`, the chat shows Stopped and ready, the command runs on, and its notice later
starts a turn on a chat the person stopped.

Fix: in `pump`, on `ev.Kind == EvTurnEnd && ev.Aborted && waitsOnBackground(ev.Background) && c.ag != nil`: `c.gen++`,
append `c.ag` to the processes to close, `c.ag = nil`, `newBgProcess(c)`: the close of design D7. Subagents already do
this (`Aborted` → `finalizeAppSub` closes the process).

### 4. Nice to have: a chat turn that ends with an error while work runs shows idle, then works again by itself

`manager.go` (the `waits` line requires `ev.Error == ""`). A self-begun turn fails ("529 overloaded") while a Monitor
runs: the chat becomes ready and held, the process keeps the Monitor, the next notice starts a turn: the "finishing
and restarting" look goal 2 removes. A subagent in the same place is finalized and closed.

Decided fix: the same as finding 3 for any non-clean turn end (aborted or `ev.Error != ""`) while
`waitsOnBackground(ev.Background)`: the process is closed (D7), the chat keeps the error note and becomes ready as
today for an errored turn.

### 5. Nice to have: Stop does nothing on an unlisted chat object with background work

`manager.go` `InterruptOf`: `stopLocked` returns nil at once for `c.deleted || c.unlisted`; `InterruptOf` then still
calls `newBgProcess(c)` (wiping the knowledge of the work) and returns nil, with neither interrupt nor close. Fix: add
`!c.deleted && !c.unlisted` to the bg condition, so those objects fall through to the old path.

### 6. Nice to have: shells are adopted only when the task list grows, and at `Close`

`internal/claude/claude.go` `readLoop`. If the CLI announces before it spawns (order `[not verified]`; the stand-in
spawns first) the `ps` misses the shell and no later list change re-adopts it; ordinary foreground Bash shells are
detached too and never adopted while they run. A self-exit (`readLoop` → `EndTree`) then leaves the shell. Fix: also
`go agent.Adopt(p.cmd)` on `task_started` with a `task_type` other than `local_agent`, and on each `result` line while
the set of known background tasks is not empty.

### 7. Accepted: the delayed kill of `EndTree` is keyed by the leader pid (needs pid reuse within 2 s).

### 8. Nice to have: wrong wording for a waiting chat with owed results

`packages/core/src/logic/labels.ts` (around line 136): a waiting chat with owed results (only at the turn cap) says
"It goes to the agent after your next message"; a waiting chat refuses messages, and the results go out at the end
of its next turn.

### 9. Nice to have: the new `internal/agent` tests are slow for the default set

`TestAdoptRecordsDetachedGroups` 4.1 s, `TestEndAllEndsAdoptedGroups` 3.6 s, `TestEndTreeEndsAdoptedAfterLeaderExit`
2.4 s, `TestAdoptedGroupForgottenWhenEmpty` 2.0 s, mostly `ps`. AGENTS.md: about 1 s per default-set test. Make them
faster (fewer `ps` calls, shorter polls), and move what is still slow to the full set with a default-set test named
in the reason.

## Goal items not yet covered by a test that would fail

- 3.4/4.5: a stopped waiting agent starts no further turn (finding 1).
- 3.4: branch and fork endings of a waiting agent have no leftover test (stop, delete, shutdown, self-exit do).
- 6.3 self-exit timing: a process that exits right after announcing, before the asynchronous `Adopt` ran (finding 6).
- The Stop race (finding 3) and the errored turn (finding 4).
- 6.5: tokens and cost of self-begun turns are not checked (only `Usage.Turns == 5`).

## Fix chunks

| id | owns | findings |
|---|---|---|
| F1 | `internal/claude/claude.go`, `internal/claude/proc_test.go`, `internal/agent/proctree*.go`, `internal/agent/procgroup*.go`, `internal/agenttest/fake-claude` | 1, 2, 6, 9, and the tests of 1 and 6 |
| F2 | `internal/chats/manager.go`, `internal/chats/bgchat_test.go`, `internal/chats/bgproc_test.go`, `internal/chats/bgplay_test.go` | 3, 4, 5, the branch/fork leftover test, tokens and cost in 6.5 |
| F3 | `packages/core/src/logic/labels.ts` and its tests | 8 |
