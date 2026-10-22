# Design: a Claude agent's background commands keep it waiting, not finished

The architecture for `claude-bg-commands-goal.md` (the goal). The work breakdown is in `chunks.md`, next to this
file. Section numbers like "goal 3.4" point into the goal. Every decision has a one-line reason.

## 0. What was checked before deciding

- **The CLI's own description of its stream** (Claude Code 2.1.296, installed here). These schemas were read from the
  binary's strings. Nothing paid was run.
  - `system/background_tasks_changed` `{tasks:[{task_id, run_id?, task_type, subagent_type?, description,
    parent_task_id?, ambient?, awaited?}], uuid, session_id}`. The CLI calls this *"The full set of live background
    tasks, emitted whenever membership changes … A level signal … consumers that only need 'is background work
    running' should replace their set with each payload rather than pairing edges"*. Its ordering note: *"a task that
    starts in the background joins the level before its task_started, and a finishing task leaves it after its
    task_updated and task_notification"*. It is per process: *"nothing is emitted at startup"*.
    `ambient` = *"tasks that are not activity … hosts should exclude them from activity indicators"*.
  - `system/task_started` `{task_id, tool_use_id?, description, task_type?, is_backgrounded?, …}`.
    `task_type` is `local_bash` for a backgrounded Bash command and **also for a Monitor** (the Monitor tool registers
    a `local_bash` task with an internal kind "monitor"). It is `local_agent` for a native subagent.
  - `system/task_updated` `{task_id, patch:{status?: pending|running|completed|failed|killed|paused, …}}`.
  - `system/task_notification` `{task_id, tool_use_id?, status: completed|failed|stopped, output_file, summary,
    usage?, ambient?, …}`. It has **no `task_type` field**, so today's orphan count (`task_type == nil`) counts every
    notice for a task the process did not start as a subagent. That includes background commands (goal 3.5).
  - A Monitor *event* (a line the watched command prints) is no `task_notification`: that line's status enum has
    no "running" value. It reaches the model as a queued message that starts a turn. In the stream there is only
    the new turn, which ends with a result whose `origin.kind` is `"task-notification"`.
  - A control request `stop_task {task_id}` exists. It is **not** used (decision D7).
- **How the CLI starts shells.** The bash shell provider is `{type:"bash", …, detached: true}`, so every shell
  command (a background one too) runs in **a session and process group of its own**. Signalling the Claude
  process's group cannot reach it. This explains the leftover monitor of goal 2.1. The Claude Code session that
  wrote this plan showed the same thing: its shell's pid equals its pgid.
- **Finding processes by an environment mark does not work on macOS.** `ps -E` shows no environment for platform
  binaries (`/bin/sh`, `/bin/sleep`), and those are what a background command runs. Checked on macOS 15.7. So
  cleanup goes by the process tree and process groups (D8).
- **Today's code.** `internal/claude/translate.go` reads `task_*` lines only for `local_agent`.
  `internal/agent/procgroup.go` starts every agent as the leader of its own group, and signals that group only in
  `EndAll` at shutdown. `claude.(*proc).Close` closes stdin and kills only the leader after 3 s (test
  `TestCloseKillsOnlyTheProcess`). A subagent's clean turn end with no subagents running finishes it
  (`handleSubEv` → `subTurnOver` → `subWaits` → `finalizeAppSub`, which closes the process). A chat's clean
  turn end sets status ready (`transcript.Apply`) and `TurnActive=false` (`pump`).

## 1. Decisions

**D1. The source of "has background work" is the CLI's level signal, plus its notices.**
The Claude adapter keeps, per process:
- `bgLive`: the task ids of the last `background_tasks_changed`, leaving out entries with `ambient: true` and
  entries with `task_type: "local_agent"`. **Running = len(bgLive).**
- `bgKnown`: every task id the process announced as anything other than `local_agent` (from `task_started` and from
  `background_tasks_changed`). These ids are background work and never subagents or lost tasks.
- `bgUnread` (bool): set by a `task_notification` for an id in `bgKnown` that is not `ambient`. Cleared by the next
  top-level `system/status` `requesting` line, which is a request to the model and so reads the queued notices.
  **Unread = bgUnread.**

Reason: the CLI documents `background_tasks_changed` as the signal for "is background work running" (goal 4.2: from
what the process says, not from text or timing). `local_agent` is left out because native subagents already have
their own path, and an app chat disallows native Task/Agent (goal 3.6). `Unread` covers the moment between a
task's end (the level drops after its notice) and the turn that the notice starts.

**D2. The agent contract: a `Background` value on the turn end, and one new event kind.**
```go
// internal/agent/agent.go
// Background is what an adapter knows of the background work of its process: commands the agent
// started that run on after the turn that started them (Claude: a Bash command run in the
// background, a Monitor). Only Claude reports it; for Cursor and pi it is always the zero value.
type Background struct {
	Running int  // background tasks the process reports live (Claude: background_tasks_changed, ambient ones and native subagents left out)
	Unread  bool // a background task ended after the process's last request to the model: a turn that reads its notice may be to come
}
// New kind, appended after EvSub so that no existing value changes:
EvBackground // Background changed between or during turns
// New field on Event:
Background Background // EvTurnEnd: the state at the end of the turn; EvBackground: the new state
```
The Claude adapter emits `EvBackground` whenever `(Running, Unread)` differs from the last value it emitted.
It also sets `Event.Background` on every `EvTurnEnd`. Reason: the field is zero for the other adapters and they
never emit the kind, so it is harmless to them (goal 4.7). The transcript ignores an unknown kind (`Apply`
returns nil).

**D3. The one rule, in one place: `internal/chats/background.go`.**
```go
// waitsOnBackground is the one rule of goal 4.1: an agent whose turn ended cleanly while this holds
// is waiting, not done. The chat's own agent and every subagent, at any depth, ask it and nothing else.
func waitsOnBackground(b agent.Background) bool { return b.Running > 0 || b.Unread }

// bgWork is what the manager knows of one agent process's background work (Chat.bg, sub.bg).
// Methods are called with c.mu held.
type bgWork struct {
	now agent.Background // the adapter's last report (EvBackground, EvTurnEnd)
	gen int              // raised by every sign of a turn and every turn end: a quiet timer armed under an older gen does nothing
	armed int            // how many times the quiet wait was armed (for tests)
}
func (b *bgWork) report(v agent.Background) // b.now = v
func (b *bgWork) turnSign()                 // b.gen++ (a turn began: EvThinking, or model output)
func (b *bgWork) holds() bool               // waitsOnBackground(b.now)
func (b *bgWork) idle() bool                // b.now.Running == 0: what runs has ended, a notice may still start a turn
// armBgQuiet starts the quiet wait (D4) of b: after m.bgQuietWait, under c.mu, fire runs if b.gen is
// still what it is now and c is not deleted; out and aft are then sent and finished as handleSubEv does.
func (m *Manager) armBgQuiet(c *Chat, b *bgWork, fire func(out *outbox, aft *after))
```
Both paths do the same things at the same events. They differ only in what being done means:

| event (from the agent's process) | chat's own agent (pump, C5) | subagent (handleSubEv, C4) |
|---|---|---|
| `EvBackground` | `c.bg.report`; while waiting and `idle()`: arm the quiet wait | `s.bg.report`; the same |
| `EvThinking` or model output | `c.bg.turnSign()`; status leaves waiting (the transcript sets thinking/writing/tool) | `s.bg.turnSign()`; `Waiting=false` when it waited on background work (`BgWaiting`) |
| clean `EvTurnEnd` | `c.bg.report(ev.Background)`; `turnSign()`; **if `waitsOnBackground`**: status waiting, `TurnActive` stays true, and the quiet wait is armed if `idle()`; else idle as today | `s.bg.report(ev.Background)`; `turnSign()`; `subWaits` waits **if kids run, or a result is owed, or `waitsOnBackground`**; `BgWaiting = s.bg.holds()`; arm the quiet wait when it waits on background work alone and `idle()` |
| quiet wait fires | `c.bg.report(zero)`; status ready, `TurnActive=false`, owed results delivered (`deliver`) | `s.bg.report(zero)`; finished (`finalizeAppSub(…, SubCompleted, "", endTurn, …)`) if no kid runs, nothing is owed and no carry is open; else `BgWaiting=false` and it waits on its kids as before |
| `EvExit` while waiting | as for any exit while busy: note "The agent stopped: …", status stopped | as for any exit: `finalizeAppSub` stopped/failed |

Reason: goal 4.1 asks for one rule that both go through, and that the two cannot drift. A test plays one recorded
stream to both and compares the phases (C6).

**D4. A bounded "quiet wait" ends a wait whose work has ended but whose last turn never comes.**
`Manager.bgQuietWait` is 30 s by default and a field so tests can lower it (like `subQuietWait`). It is armed only
while an agent waits on background work and `Running == 0`. Any turn sign or turn end cancels it, through `gen`.
In the sequence of goal 2.1 it is armed when the last task's notice arrives and is cancelled a moment later by the
turn that notice starts, so it is never waited out. Reason: two cases can leave an agent waiting with nothing
running. A notice may be read inside a turn that was already making requests, and a task may end with no turn
after it. A wait must not then last forever. Goal 4.9 is about work that *runs* forever, not about this.

**D5. A waiting chat has its own status, `"waiting"`.**
- `model.StatusWaiting Status = "waiting"`, sent in `ChatView.status` and `BranchState.status`. Packages/core
  `Status` gets `"waiting"`.
- It counts as **busy** for the person, like a working chat (goal 3.3 [proposed]):
  - `Send` is refused with `ErrBusy`, and the composer shows Stop and blocks Send. Esc stops.
  - It counts as working in `pubOf`, so in `ChatView.working`, the tree's marks and the turn cap.
  - `transcript.busy()` includes it, so a process exit while waiting leaves "The agent stopped: …".
  - Model changes and restarts are refused as for a working chat.
- It is **not in a turn**. A new helper `inTurn(c)` (thinking, writing, tool, approval) replaces `busy(c)` in:
  - `deliverable`: subagent results are delivered to a waiting chat, as to a waiting subagent (goal 3.2, 3.3);
  - the pump's detection of a turn the agent began by itself.
- `TurnActive` stays true while waiting. A server restart then shows the chat as stopped ("Stopped: the app was
  closed while the agent was working."), and its background work was ended by the shutdown (D8).
- The app shows it in three places:
  - the status line "Waiting for background work", shown as the static waiting row at the foot of the thread,
    not as the typing line;
  - the sidebar dot state `waiting` (its muted colour exists already);
  - the row line "Waiting for background work".
- Feature level stays 7. An app of level 7 that predates this shows the `waiting` dot (its `dotState` passes an
  unknown status through) and no status text. That is acceptable.

Reason: the goal wants a state the person can tell from working and from idle (3.3). The status is what `busy`,
the cap mirror, the tree and every client already read. A separate flag next to `ready` would leave `ready` lying
to every one of them.

**D6. A waiting subagent keeps the existing `Waiting`, plus one flag for its line.**
`model.Subagent.BgWaiting bool \`json:"bgWaiting,omitempty"\``: *set while the subagent waits and its own background
work is part of what it waits on*. It is meaningful only with `Waiting`. It is cleared everywhere `Waiting` is set
to false: `loadSubs`, `stopSub`, `finalizeAppSub`, `deliverSub`, a turn sign in `handleSubEv`.
The app's subagent line:
- "Waiting for background work" (no running children);
- "Waiting on N subagent(s) and background work" (with running children);
- otherwise as today.

Reason: it is the same waiting (goal 4.1, cap and status unchanged). Only the line needs to know why: without the
flag it would say "Waiting on its subagents' results". The individual commands stay hidden (goal section 5).

**D7. Stopping an agent that has background work closes its process. It is not only interrupted.**
- **Chat.** `InterruptOf` checks `c.bg.holds()` and whether the status is waiting. When either holds and the chat
  has a process, it does what `stopOne` does for the branch, under the same lock: open permission cards denied,
  the carry settled as stopped by the human, subagents stopped, the process detached and closed (and with it its
  tree, D8), a "Stopped." note, status ready, `TurnActive=false`, the hold set. The next message resumes the
  session in a new process, as after any stop that closed the process. To share the code, `stopOne`'s body
  becomes `stopLocked(c *Chat, out *outbox) (toClose []agent.Agent)`.
- **Subagent.** The existing stop paths (`stopSub`, `finalizeAppSub`) already close the process. With D8 the
  close ends its tree.

Reason: an interrupt does not end background tasks. `stop_task` per task makes the CLI announce each stop and
start another turn. Goal 4.5 says ending is not left to the agent.

**D8. Process cleanup: Claude's `Close` and exit end the whole tree.**
- **`internal/agent/proctree.go`** (new, C3):
  - `listProcs()` runs one `ps -A -o pid=,ppid=,pgid=` (macOS and Linux).
  - `descendants(root, procs)` walks the parent links.
  - **`Adopt(cmd)`** records, under `cmd`'s group in the existing registry, the process group of every descendant
    that leads its own group. Those are the detached shells: a group is adopted only when its leader (pid ==
    pgid) is a descendant. It never adopts the server's own group, a pgid ≤ 1, or the leader's own group.
  - Each adopted group gets the forget poller `Exited` already uses. It is forgotten as soon as it is empty, so
    a remembered number is never one that the system may have reused. This is the same guarantee
    `SignalGroup` has today.
  - **`EndTree(cmd, grace)`** sends SIGTERM to `cmd`'s own group and to every group adopted under it, and SIGKILL
    after `grace` to whatever of them is still there. It does not block.
  - `SignalAdopted(cmd, sig)` signals only the adopted groups.
  - **`EndAll`** first adopts the descendants of every live leader, then ends own and adopted groups as today.
- **The Claude adapter** (`internal/claude/claude.go`, C3):
  - In the read loop, `go agent.Adopt(p.cmd)` runs when the `background_tasks_changed` list shows a new task, on a
    `task_started` of a task other than `local_agent`, and on each `result` line while background tasks are known
    (review finding 6). A shell is recorded while its parent chain is intact, so a later exit of Claude (which
    reparents it to launchd) cannot hide it.
  - `Close` returns at once (it is called under the chat lock; review finding 2). In one goroutine it calls
    `Adopt(p.cmd)`; when that found background groups, it signals the **Claude process first** and then the
    groups (`SignalAdopted(p.cmd, SIGTERM)`), so the CLI cannot start a turn on the notices of the shells it is
    losing (review finding 1). The background work ends now, which is an act of stopping (goal 4.6). Then stdin
    closes as before. After the 3 s grace the **group** is killed (`agent.SignalGroup(p.cmd, SIGKILL)`), not only
    the leader.
  - In `readLoop`, after `cmd.Wait` returns, whatever the cause (Close, a kill, self-exit), it calls
    `agent.EndTree(p.cmd, endGrace)` (2 s, an atomic var for tests) before `agent.Exited`.
- Every way an agent ends reaches one of these:
  - stop, delete, archive (`stopOne`, `stopSub`, `closeAgents`);
  - branch or fork: a source that is working keeps its process, and a copy never had the source's process;
  - the subagent cap and depth limits (`stopSub`);
  - shutdown (`Manager.Shutdown`, then `agent.EndAll`);
  - self-exit (`readLoop`).
- Cursor and pi are untouched (goal 4.7).

Reason: Claude's shells are detached (section 0), so only a walk of the tree finds them, and only while their
parent chain is intact. The env mark cannot be read on macOS. `TestCloseKillsOnlyTheProcess` is reversed on
purpose: goal 4.5 says nothing is left running.

**D9. Notices never count as lost tasks (goal 3.5).**
- `taskEvent` counts an unknown task's notice as an orphan only when its id is not in `bgKnown`.
- The empty result of a lost task is skipped only when it is really empty: `num_turns == 0 && !is_error &&
  result == "" && (orphans > 0 || origin.kind == "task-notification")`.

Reason: the second condition protects a real result too. A self-begun turn that fails before its first request
also has `num_turns 0` and origin `task-notification`, and today it would be skipped. The chat would then show
thinking forever.

**D10. The recorded stand-in streams.**
- **Fixtures.** Synthesized JSONL in the stream-json format of 2.1.x, in `internal/claude/testdata/bg/`. Each line
  is one CLI line, plus annotation lines `{"type":"aiwb_step","name":"…","expect":"working|waiting|done"}`, which
  the translation ignores (an unknown type). The sequences are given line by line in `chunks.md`, C2.
  - `shell_and_monitor.jsonl`: goal 2.1. A background shell and a Monitor; a clean end "waiting" with two
    running; a self-begun turn for the shell's notice; one turn per monitor event; the monitor's end; the final
    answer.
  - `resume_notices.jsonl`: goal 6.4. Lost-task notices and empty results of a resumed session, a background
    task of this process, its notice, then a self-begun turn that fails with `num_turns 0`.
- **`claude.Translator`** (new, exported, `internal/claude/replay.go`). It runs lines through the same `translate`
  as the read loop, without a process.
- **The chats test player** (`internal/chats/bgplay_test.go`). It reads a fixture through `Translator`, splits it
  at the annotation lines into steps, and feeds each step's events to a `fakeAgent` (`emit`). It is in the
  default set and starts no process.
- **The real-process stand-in.** The Node `fake-claude` gets a directive `[[bg SECONDS]]`. It emits the
  announcement lines, starts `sh -c 'sleep SECONDS; true'` with `detached: true` exactly as Claude does, and
  appends the shell's pid to `$FAKE_CLAUDE_BGPIDS`. It ends the turn with "waiting". When the shell exits it emits
  the notice, the empty level, and a self-begun turn. The manager-level leftover tests (goal 6.3) use it through
  the real `claude.Spawner`. The shutdown case is in `cmd/ai-whiteboard`, because `EndAll` disables starts for
  the rest of a test binary.

Reason: goal 4.10 forbids paid calls, and we have no recording. A synthesized stream in the CLI's documented shapes
is what both layers can share. Annotations put the expected phases next to the lines that cause them.

**D11. Documents (goal 6.7).** These go in `docs/architecture.md`:
- in the subagents paragraph of the Server bullet, where a subagent that started subagents waits: an agent with
  background work (a Claude background command or Monitor) waits the same way, chat or subagent, and is finished
  after a turn that ends with none running;
- a waiting chat has the status `waiting`;
- ending an agent ends what it started: the tree, detached shells included, on stop, delete, limits, shutdown and
  its own exit.
- `AGENTS.md` is not changed: no new test commands.

**D12. Out of the design on purpose:**
- merging turns;
- a time limit on background work (goal 4.9; the quiet wait of D4 runs only once nothing runs any more);
- steering changes (goal 4.8);
- showing the commands;
- changes for Cursor and pi;
- a feature-level bump.

## 2. Sequence, as the manager sees it

```
turn 1 (the prompt's)        … EvTurnEnd{Background{Running:2}}            → waiting (chat: status waiting; sub: Waiting, BgWaiting)
shell ends                   EvBackground{Running:2,Unread:true}, then {1,true}
                             EvThinking                                    → working (turnSign; Unread cleared by the adapter: {1,false})
                             … text … EvTurnEnd{Background{1,false}}       → waiting
monitor event ×2             EvThinking … EvTurnEnd{{1,false}}             → working, then waiting (each)
monitor ends                 EvBackground{1,true}, then {0,true}           → still waiting; quiet wait armed (idle)
                             EvThinking  (adapter: {0,false})              → working; quiet wait cancelled
                             … "All done…" EvTurnEnd{{0,false}}           → done: sub reports "All done…" once / chat ready
```

## 3. Risks and open points

- **R1 `[not verified]`: the read mark.** It is assumed that `status: requesting` reads every queued notice (as
  an attachment of the request), and that notices queued between turns are read by one turn. If the CLI runs
  queued notices one per turn, an agent may be done one turn early: a subagent reports the text of the turn before
  the last, and a chat shows idle for a moment and then works by itself. D4 never makes it wait forever. The paid
  run of goal 6.6 is the check.
- **R2: the exclusions.** `ambient` tasks and `local_agent` are left out. If an ambient task did start turns, the
  agent would be done too early, with the same effect as R1.
- **R3: a waiting chat blocks the person.** A Monitor that runs for hours keeps the chat refusing messages and
  holding a slot of the turn cap until the person stops it. This follows goal 3.3 and 4.9, both `[proposed]`, so
  the user should confirm it.
- **R4: nothing an agent starts outlives it.** A dev server an agent was asked to leave running is killed when the
  chat's process is closed: stop, delete, model change, server shutdown. This is goal 4.5 by intent. It changes
  what users may be used to.
- **R5: escapes from the tree.** A command that calls `setsid` itself inside a background command, and whose
  parent exits before the next walk, escapes the tree. That is accepted.
- **R6: Linux and macOS only.** `ps -o pid=,ppid=,pgid=` behaves the same on both. The server builds for no other
  OS.
- **R7: a result delivered into a self-begun turn.** A delivery handed to a waiting **chat** just as a self-begun
  turn starts is settled as delivered by that turn's output. The CLI has the message queued, so nothing is lost
  (goal 3.3), but the chat may show idle for a moment before the queued turn runs. A subagent keeps its existing
  `subUnread` handling.
