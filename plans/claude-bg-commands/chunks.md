# Work breakdown: claude-bg-commands

Read `design.md` first (the decisions D1–D12 are referred to by number) and the goal `claude-bg-commands-goal.md`.
Read `AGENTS.md` for the test rules. **Never** run paid tests (`AIWB_CLAUDE_E2E`, `AIWB_CURSOR_E2E`,
`AIWB_PI_E2E`, `web/e2e/app.e2e.mjs`). Each chunk is done in its own worktree, on a branch off
`claude-bg-commands` that already has every chunk it depends on. Match the surrounding code's comment density,
naming and idiom: comments are full sentences that say why. Do not edit files another chunk owns unless its spec
says so; if you find you must, say so in your report.

## Overview, merge order and parallel groups

| id | title | model | depends on | owns (main files) |
|---|---|---|---|---|
| C1 | Foundation: types, the rule, the status | sonnet | — | `internal/agent/agent.go`, `internal/model/model.go`, `internal/transcript/transcript.go`, `internal/chats/background.go` (new), small edits in `internal/chats/manager.go`, `subagents.go` |
| C2 | Claude stream: background state, notices, fixtures, Translator | sonnet | C1 | `internal/claude/translate.go`, `internal/claude/replay.go` (new), `internal/claude/testdata/bg/*` (new) |
| C3 | Process-tree cleanup | **opus** | C1 | `internal/agent/procgroup.go`, `internal/agent/proctree.go` (new), `internal/claude/claude.go`, `internal/claude/proc_test.go` |
| C4 | Subagent path of the rule | sonnet | C1 | `internal/chats/spawn.go`, `internal/chats/nested.go`, `internal/chats/subagents.go` |
| C5 | Chat path of the rule, and Stop of a waiting chat | **opus** | C1 | `internal/chats/manager.go`, `internal/chats/delivery.go`, `internal/chats/branches.go` |
| C6 | Recorded-stream tests through the manager, and the docs | sonnet | C2, C4, C5 | `internal/chats/bgplay_test.go` (new), `docs/architecture.md` |
| C7 | Real-process stand-in and the leftover checks | sonnet | C2, C3, C4, C5 | `internal/agenttest/fake-claude`, `internal/agenttest/fakeclaude*.go`, `internal/chats/bgproc_test.go` (new), `cmd/ai-whiteboard/agents_stop_test.go` |
| C8 | The app: the waiting status and the browser checks | sonnet | C1 (shapes only) | `packages/core/src/{types,logic/status,logic/labels,logic/subagents}.ts`, `app/src/screens/chat/Thread.tsx`, `web/dev/checks/{L10,L11,L19}*.mjs`, `web/dev/checks/README.md` |

- **Group 0:** C1 alone. It is small, and it fixes the shapes everyone uses.
- **Group 1 (in parallel, after C1 is merged):** C2, C3, C4, C5, C8. C4 and C5 both edit `internal/chats` but in
  different files. The only shared file is `background.go`, which C1 writes and neither may change.
- **Group 2 (in parallel, after group 1):** C6 (needs C2, C4 and C5) and C7 (needs C2, C3, C4 and C5).
- **Merge order:** C1 → C2 → C3 → C4 → C5 → C8 → C6 → C7. After the last merge, one person or agent runs
  `AIWB_TEST_FULL=1 go test -timeout 20m ./...` once, with nothing else testing on the machine (AGENTS.md: final
  check).

Shared commands (AGENTS.md):
- While working: `go test ./internal/<pkg>`, or one test with `-run '^TestName$'`. No `-count=1`.
- Before finishing a Go chunk: `go test ./...` once, and `AIWB_TEST_FULL=1 go test ./internal/<pkg>` for each
  package you changed.
- Code with goroutines or timers (C3, C4, C5, C7): also `go test -race ./internal/<pkg>`.
- A failing test your change cannot have touched: run it again alone (`go test -count=1 -run '^T$' ./<pkg>`). If it
  passes alone, report it as load-sensitive with its failure line and go on.

---

## C1 — Foundation: types, the rule, the status

**Depends on:** nothing. **Model:** sonnet.

**Files and spec**

1. `internal/agent/agent.go`:
   - Add `type Background struct { Running int; Unread bool }` with the doc comment of design D2.
   - Add `EvBackground`, **appended after `EvSub`** (no existing value may change), with the comment
     `// Background: the agent's background work changed (Claude only)`.
   - Add the field `Background Background` to `Event`, documented: "EvTurnEnd: the background work at the end of
     the turn; EvBackground: its new state. Zero for Cursor and pi."
2. `internal/model/model.go`:
   - Add `StatusWaiting Status = "waiting"`, commented: the agent's turn has ended but it is not done; its own
     background work still runs or has just ended (Claude). Not in a turn, and busy for the person.
   - Update the `ChatView.Working` comment to "thinking, writing, tool, approval or waiting".
   - Add `BgWaiting bool \`json:"bgWaiting,omitempty"\`` to `Subagent`, right after `Waiting`. Doc: set while
     the subagent waits (`Waiting`) and its own background work is part of what it waits on; false whenever
     `Waiting` is false.
3. `internal/transcript/transcript.go`: `busy()` includes `model.StatusWaiting`. That is all: an `EvExit` while
   waiting then leaves "The agent stopped: …" and status stopped. `Apply` of `EvThinking` / `EvTextStart` /
   `EvToolStart` already moves the status out of waiting into the turn's status.
4. `internal/chats/manager.go`:
   - `pubOf`: `StatusWaiting` → `pubWorking`.
   - `busy(c)`: include `StatusWaiting`.
   - Add `inTurn(c *Chat) bool`: thinking, writing, tool or approval, which is `busy` without waiting. Comment:
     "a turn of the chat's agent runs, as far as its thread shows: busy, but not waiting on background work".
   - Add the `Manager` field `bgQuietWait time.Duration`, set in `New` to the const `bgQuietWait = 30 *
     time.Second`, documented like `subQuietWait`.
   - Add the field `bg bgWork` to `Chat`.
   - **Do not change any call site of `busy`**: C5 does that.
5. `internal/chats/subagents.go`: add the field `bg bgWork // its process's background work (Claude)` to `sub`.
6. `internal/chats/background.go` (new): exactly the API of design D3, with a package doc comment that states
   the one rule and its table (copy the table's meaning into prose; keep it short).
   - `waitsOnBackground(b agent.Background) bool`.
   - `bgWork{now agent.Background; gen int}` with `report`, `turnSign`, `holds`, `idle`.
   - `(m *Manager) armBgQuiet(c *Chat, b *bgWork, fire func(out *outbox, aft *after))`. It captures `at := b.gen`
     and calls `time.AfterFunc(m.bgQuietWait, …)`. In the callback it takes `c.mu` and returns at once if
     `c.deleted || c.tr == nil || b.gen != at`. Otherwise it runs `fire(&out, &aft)`, then `out.emitCounts(c)`,
     unlocks, and does `m.send(out)` and `m.finish(c, &aft)`, as `subUnread`'s timer does. Each arm also raises a
     `quiet` counter on `bgWork` (`armed int`), so a test can see that it was armed.
   - **The callers are in C4 and C5.** C1 calls `armBgQuiet` nowhere.

**Tests** (`internal/chats/background_test.go`, new; `internal/transcript` and `internal/model` where they fit):
- `TestWaitsOnBackground`: a table. `{0,false}` → false; `{1,false}` → true; `{0,true}` → true; `{2,true}` → true.
- `TestBgQuietFiresOnlyWithoutATurnSign`: with a bare `env` (`newEnv`) chat object, the manager's `bgQuietWait`
  set to 20 ms:
  - arm it; it fires once;
  - arm it, then `turnSign()` before it fires: it does not fire;
  - arm it, then mark the chat deleted: it does not fire.
  The waits use `waitFor` and a generous bound; the "does not fire" cases wait 10× the quiet time.
- `TestWaitingIsBusyNotInTurn`: a chat whose transcript status is set to `StatusWaiting` is `busy` and not
  `inTurn`, and `pubOf(StatusWaiting) == pubWorking`.
- In `internal/transcript`: `TestExitWhileWaitingNotesTheStop`. Status waiting, then `Apply(EvExit{ExitErr:""})`
  gives the note "The agent stopped: process ended" and status stopped.
- `go vet` must pass: `Event` stays comparable where it is compared. `Background` is a struct of scalars, so it is.

**Commands:**
- `go test ./internal/agent ./internal/model ./internal/transcript ./internal/chats`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/agent ./internal/model ./internal/transcript ./internal/chats`;
- then `go test -race ./internal/chats`.

**Done when:**
- [ ] The types, the status, the flag, `busy`, `inTurn`, `pubOf`, `bgWork` and `armBgQuiet` exist as specified.
- [ ] No behaviour changes for anything that exists: the existing tests all pass unchanged.
- [ ] The new tests pass, the race run is clean, and the commit is on its branch.

---

## C2 — Claude stream: background state, notices, fixtures, Translator

**Depends on:** C1. **Model:** sonnet.

**Files and spec**

1. `internal/claude/claude.go`, struct `proc` (translate state; only this chunk adds these fields):
   ```go
   bgLive   map[string]bool  // non-ambient, non-local_agent task ids of the last background_tasks_changed
   bgKnown  map[string]bool  // every task id announced as other than local_agent: background work, never a subagent or a lost task
   bgUnread bool             // a known background task's notice came after the last request to the model
   bgSent   agent.Background // the state last emitted as EvBackground
   ```
   Initialise the two maps where `start` makes the others, and in `initMaps`.
   **Do not touch `Close`, `readLoop` or `start`'s process handling**: C3 owns those.
2. `internal/claude/translate.go`:
   - In the first `type == "system"` switch, add `case "background_tasks_changed":`. Set `bgLive` to the ids of
     `tasks[]` whose `ambient` is not true and whose `task_type` is not `"local_agent"`. Add every id whose
     `task_type` is not `"local_agent"` to `bgKnown`. Return no event of its own; the change event comes from
     the common step below.
   - `taskEvent`:
     - On `task_started` with a `task_type` other than `local_agent` and a non-empty id: `bgKnown[id] = true`.
       It still returns nil.
     - In the `!ok` branch, a `task_notification` whose id is in `bgKnown`: if its `ambient` is not true, set
       `bgUnread = true`. It never touches `orphans`, and returns nil.
     - Count an orphan only for an id not in `bgKnown` (D9).
   - The top-level `status`/`requesting` case also sets `bgUnread = false`. A subagent's status line, one with
     `parent_tool_use_id`, does not.
   - The `result` case:
     - The skip condition becomes `num(m["num_turns"]) == 0 && !isErr && str(m["result"]) == "" &&
       (p.orphans > 0 || origin kind == "task-notification")`. Compute `isErr` before it.
     - The `EvTurnEnd` gets `Background: p.bgState()`.
   - **The common step.** Rename the body of `translate` to `translate1`, and make `translate` call it and then
     append `{Kind: EvBackground, Background: s}` when `s := p.bgState(); s != p.bgSent` (then `p.bgSent = s`).
     Put that event **before** a trailing `EvUsage`/`EvTurnEnd` pair: if the last event of `translate1` is an
     `EvTurnEnd`, insert it ahead of the `EvUsage` that precedes the turn end. Add
     `func (p *proc) bgState() agent.Background { return agent.Background{Running: len(p.bgLive), Unread: p.bgUnread} }`.
3. `internal/claude/replay.go` (new):
   ```go
   // Translator turns the lines of a Claude stream-json output into agent events as a chat process's
   // read loop does (translate), with no process: for stand-ins that play recorded streams (the chat
   // manager's tests). Control lines (control_request, control_response) and lines that are not JSON
   // give nothing.
   type Translator struct{ p *proc }
   func NewTranslator() *Translator
   func (t *Translator) Line(line []byte) []agent.Event
   ```
4. `internal/claude/testdata/bg/shell_and_monitor.jsonl` and `resume_notices.jsonl` (new). Synthesize them **line
   for line** as listed below.
   - Every line carries `"session_id":"bg-session"` and a unique `"uuid":"u-…"`.
   - Every assistant message has `"model":"claude-haiku-4-5-20251001"`, `"role":"assistant"` and
     `"parent_tool_use_id":null`.
   - Every result carries `"total_cost_usd"`, a `"usage"` with the four token fields, and `"modelUsage"`
     `{"claude-haiku-4-5-20251001":{"inputTokens":…,"outputTokens":…,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"contextWindow":200000}}`,
     with the cost and the counts rising monotonically (they are cumulative per process).
   - Lines with `"type":"aiwb_step"` are annotations, not CLI output. The translation ignores them (unknown
     type); C6's player splits the stream at them.

   **`shell_and_monitor.jsonl`** (goal 2.1):
   ```
   system/init {"cwd":"/tmp/bg","tools":["Bash","Monitor"],"mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode":"auto","claude_code_version":"2.1.296"}
   system/status {"status":"requesting"}
   assistant msg_1: tool_use toolu_b1 Bash {"command":"sleep 3 && echo shell-done","description":"Sleep, then print","run_in_background":true}
   system/background_tasks_changed {"tasks":[{"task_id":"b1","run_id":"r-b1","task_type":"local_bash","description":"Sleep, then print"}]}
   system/task_started {"task_id":"b1","run_id":"r-b1","tool_use_id":"toolu_b1","description":"Sleep, then print","task_type":"local_bash","is_backgrounded":true}
   user: tool_result toolu_b1 "Command running in background with ID: b1. Output is being written to: /tmp/bg/tasks/b1.output"
   system/status {"status":"requesting"}
   assistant msg_2: tool_use toolu_m1 Monitor {"command":"for i in 1 2; do sleep 2; echo tick $i; done","description":"Ticks"}
   system/background_tasks_changed {"tasks":[<b1 as above>,{"task_id":"m1","run_id":"r-m1","task_type":"local_bash","description":"Ticks"}]}
   system/task_started {"task_id":"m1","run_id":"r-m1","tool_use_id":"toolu_m1","description":"Ticks","task_type":"local_bash","is_backgrounded":true}
   user: tool_result toolu_m1 "Monitor started (task m1). Each line it prints arrives as a message."
   system/status {"status":"requesting"}
   assistant msg_3: text "waiting"
   result {"subtype":"success","is_error":false,"num_turns":3,"result":"waiting","origin":{"kind":"human"}}
   {"type":"aiwb_step","name":"the first turn ends with two running","expect":"waiting"}
   system/task_updated {"task_id":"b1","run_id":"r-b1","patch":{"status":"completed","end_time":1792620066000}}
   system/task_notification {"task_id":"b1","run_id":"r-b1","tool_use_id":"toolu_b1","status":"completed","output_file":"/tmp/bg/tasks/b1.output","summary":"Background command \"Sleep, then print\" completed (exit code 0)"}
   system/background_tasks_changed {"tasks":[<m1>]}
   {"type":"aiwb_step","name":"the shell's notice","expect":"waiting"}
   system/status {"status":"requesting"}
   {"type":"aiwb_step","name":"a turn of its own begins","expect":"working"}
   assistant msg_4: text "The shell printed shell-done."
   result {"subtype":"success","is_error":false,"num_turns":1,"result":"The shell printed shell-done.","origin":{"kind":"task-notification"}}
   {"type":"aiwb_step","name":"the shell's turn ends, the monitor runs","expect":"waiting"}
   system/status {"status":"requesting"}
   assistant msg_5: text "tick 1"
   result {… "num_turns":1,"result":"tick 1","origin":{"kind":"task-notification"}}
   {"type":"aiwb_step","name":"the first monitor event","expect":"waiting"}
   system/status {"status":"requesting"}
   assistant msg_6: text "tick 2"
   result {… "num_turns":1,"result":"tick 2","origin":{"kind":"task-notification"}}
   {"type":"aiwb_step","name":"the second monitor event","expect":"waiting"}
   system/task_updated {"task_id":"m1","run_id":"r-m1","patch":{"status":"completed","end_time":1792620071000}}
   system/task_notification {"task_id":"m1","run_id":"r-m1","tool_use_id":"toolu_m1","status":"completed","output_file":"/tmp/bg/tasks/m1.output","summary":"Monitor \"Ticks\" ended (exit code 0)"}
   system/background_tasks_changed {"tasks":[]}
   {"type":"aiwb_step","name":"the monitor's notice, nothing runs","expect":"waiting"}
   system/status {"status":"requesting"}
   {"type":"aiwb_step","name":"the last turn begins","expect":"working"}
   assistant msg_7: text "All done: the shell printed shell-done and the monitor ticked twice."
   result {… "num_turns":1,"result":"All done: the shell printed shell-done and the monitor ticked twice.","origin":{"kind":"task-notification"}}
   {"type":"aiwb_step","name":"the last turn ends","expect":"done"}
   ```
   **`resume_notices.jsonl`** (goal 6.4):
   ```
   system/init (as above, "claude_code_version":"2.1.296")
   system/task_notification {"task_id":"lost-1","status":"completed","output_file":"/tmp/bg/lost-1","summary":"Agent \"old\" finished"}
   result {"subtype":"success","is_error":false,"num_turns":0,"result":""}                                   ← skipped (orphan)
   system/task_notification {"task_id":"lost-2","status":"stopped","output_file":"/tmp/bg/lost-2","summary":"Background command \"old\" was stopped"}
   result {"subtype":"success","is_error":false,"num_turns":0,"result":"","origin":{"kind":"task-notification"}}   ← skipped (origin)
   {"type":"aiwb_step","name":"the lost tasks' empty results","expect":""}
   system/status {"status":"requesting"}
   assistant msg_r1: tool_use toolu_b9 Bash {"command":"sleep 5","description":"Wait","run_in_background":true}
   system/background_tasks_changed {"tasks":[{"task_id":"b9","task_type":"local_bash","description":"Wait"}]}
   system/task_started {"task_id":"b9","tool_use_id":"toolu_b9","description":"Wait","task_type":"local_bash","is_backgrounded":true}
   user: tool_result toolu_b9 "Command running in background with ID: b9."
   system/status {"status":"requesting"}
   assistant msg_r2: text "started b9"
   result {"subtype":"success","is_error":false,"num_turns":2,"result":"started b9","origin":{"kind":"human"}}
   {"type":"aiwb_step","name":"the message's turn ends with one running","expect":"waiting"}
   system/task_notification {"task_id":"lost-3","status":"completed","output_file":"/tmp/bg/lost-3","summary":"Agent \"older\" finished"}
   result {"subtype":"success","is_error":false,"num_turns":0,"result":""}                                   ← skipped, with work running
   {"type":"aiwb_step","name":"a lost task's empty result while work runs","expect":"waiting"}
   system/task_updated {"task_id":"b9","patch":{"status":"completed"}}
   system/task_notification {"task_id":"b9","tool_use_id":"toolu_b9","status":"completed","output_file":"/tmp/bg/tasks/b9.output","summary":"Background command \"Wait\" completed (exit code 0)"}
   system/background_tasks_changed {"tasks":[]}
   {"type":"aiwb_step","name":"b9's notice is no lost task","expect":"waiting"}
   system/status {"status":"requesting"}
   result {"subtype":"error_during_execution","is_error":true,"num_turns":0,"result":"API Error: 529 overloaded","origin":{"kind":"task-notification"}}   ← a real result: NOT skipped
   {"type":"aiwb_step","name":"the self-begun turn fails","expect":"done"}
   ```

**Tests** (`internal/claude/translate_test.go`; add `bg_test.go` if it reads better):
- `TestBackgroundStateOfShellAndMonitor`: runs `shell_and_monitor.jsonl` through `NewTranslator`. Asserts:
  - the `Background` of every `EvBackground` in order:
    `{1,false} {2,false} {2,true} {1,true} {1,false} {1,true} {0,true} {0,false}`;
  - the `EvTurnEnd`s are 5;
  - their `Background`s are `{2,false} {1,false} {1,false} {1,false} {0,false}`;
  - their `SelfBegun`s are `false true true true true`;
  - their `Final`s are the five result texts;
  - no `EvSub` is emitted at all (local_bash is no subagent).
- `TestBackgroundNoticesAreNoOrphans` (white box, a bare `&proc{}`): after the `b1` notice, `p.orphans == 0`.
  After `lost-1`'s notice, `p.orphans == 1`.
- `TestResumeNoticesSkipOnlyEmptyResults`: plays `resume_notices.jsonl`. Exactly 2 `EvTurnEnd`: "started b9", and
  then one with `Error == "API Error: 529 overloaded"` and `SelfBegun`. No turn end for the three empty results.
  `p.orphans == 0` after the `b9` notice.
- `TestAmbientAndAgentTasksAreNotBackgroundWork`: inline lines. A `background_tasks_changed` holding one
  `ambient:true` task and one `local_agent` task gives `Running 0`. A `local_agent` `task_started` still gives its
  `EvSub` as today.
- `TestNoBackgroundEventWithoutChange`: two identical `background_tasks_changed` lines give one `EvBackground`.
- Existing translate tests stay green unchanged. Exception: a test that asserts the exact event list of a stream
  holding `background_tasks_changed` (none does today; check).

**Commands:**
- `go test ./internal/claude`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/claude`.

**Done when:**
- [ ] Both fixtures exist as listed, and the translation gives exactly the sequences above.
- [ ] The orphan count is untouched by background notices, and a non-empty or errored zero-turn result is never
      skipped.
- [ ] `Translator` is exported and documented, and `claude.go` has only the new fields (no process changes).

---

## C3 — Process-tree cleanup (opus)

**Depends on:** C1 (`EvBackground`). **Model:** **opus**. Signals reach processes that are not ours if this is
done wrong.

**Files and spec** (design D8)

1. `internal/agent/procgroup.go`:
   - Extend the registry: `adopted map[int]map[int]bool // leader pgid → groups Adopt found under it`. An adopted
     group is also put in `pgids`, so `EndAll` and `SignalGroup`'s check see it.
   - Factor the poller of `Exited` into `watch(pgid int)` (`for !forget(pgid) { time.Sleep(every) }` on a
     goroutine), and use it for adopted groups too.
   - `forget` also deletes `pgid` from every `adopted` set once it is gone.
   - `EndAll` first calls `adoptAll()` (one listing, each remembered leader that is still alive), then signals
     the own and adopted groups as today.
2. `internal/agent/proctree.go` (new):
   ```go
   type procInfo struct{ pid, ppid, pgid int }
   func listProcs() ([]procInfo, error)                // exec `ps -A -o pid=,ppid=,pgid=`; parse leniently (skip bad lines)
   func descendants(root int, ps []procInfo) []procInfo // every process below root by ppid links (not root itself)
   // Adopt records the process groups that the descendants of cmd's process lead (pid == pgid), so
   // that EndTree and EndAll reach them after cmd's process is gone and they have been reparented.
   // It never adopts cmd's own group, the server's own (syscall.Getpgrp()), or a pgid <= 1. Each
   // adopted group is watched and forgotten once empty. A cmd whose group is not registered
   // (StartGroup) is ignored.
   func Adopt(cmd *exec.Cmd)
   // SignalAdopted sends sig to every group adopted under cmd that is still remembered.
   func SignalAdopted(cmd *exec.Cmd, sig syscall.Signal)
   // EndTree ends what cmd's process started, once it has exited or is about to: SIGTERM to its own
   // group and to every group adopted under it, then SIGKILL after grace to those still there. It
   // returns at once; the SIGKILL comes from a goroutine.
   func EndTree(cmd *exec.Cmd, grace time.Duration)
   // AdoptedGroups is the pgids adopted under the group of pid, for tests.
   func AdoptedGroups(pid int) []int
   ```
   Every signal goes through the registry check that `SignalGroup` uses: never a number that is not remembered.
3. `internal/claude/claude.go`:
   - `readLoop`: after `for _, ev := range p.translate(m)`, when an event is `EvBackground` whose `Running` is
     greater than the last `Running` seen (a local in `readLoop`), call `go agent.Adopt(p.cmd)`.
   - `readLoop`: after `err := p.cmd.Wait()`, call `agent.EndTree(p.cmd, time.Duration(endGraceNanos.Load()))`
     **before** `agent.Exited(p.cmd)`. This is the self-exit guarantee (goal 3.4): it runs for every exit.
   - `Close`: first `agent.Adopt(p.cmd)` (synchronous) and `agent.SignalAdopted(p.cmd, syscall.SIGTERM)`, then
     what it does today.
   - `Close`: the kill after the grace becomes `agent.SignalGroup(p.cmd, syscall.SIGKILL)`. If that reports
     false, fall back to `p.cmd.Process.Kill()`.
   - Rewrite `Close`'s doc comment: it ends the process **and what it started**. Update the `agent.Agent.Close`
     doc in `agent.go` for Claude. That is a doc-only edit to C1's file; it is allowed here.
   - Add `var endGraceNanos atomic.Int64`, 2 s, set in `init` next to the others.
4. `internal/claude/proc_test.go`:
   - Replace `TestCloseKillsOnlyTheProcess` with `TestCloseEndsTheTree`. With the same `envStay` children, both
     are gone after `Close`: one is in the process's group, the other leads its own group like Claude's detached
     shell.
   - Add a fake option `CLAUDE_FAKE_DETACH=<file>`. The fake starts a child with `Setsid: true` that itself starts
     a grandchild (`envSleep`). It writes `"<child pid> <grandchild pid>"`, prints
     `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"b1","task_type":"local_bash","description":"d"}]}`,
     then waits for the gate file of `CLAUDE_FAKE_GATE`, then **exits by itself** (status 0).
5. `cmd/ai-whiteboard/agents_stop_test.go`: in `serverTest(…)`'s reason list, replace
   `TestCloseKillsOnlyTheProcess (internal/claude)` with `TestCloseEndsTheTree (internal/claude)`.

**Tests**
- `internal/agent` (`proctree_test.go`):
  - `TestDescendantsWalk`: a pure table on a made-up listing (a chain, a fork, a cycle-safe input, an unrelated
    tree).
  - `TestListProcsSeesItself`: the listing has `os.Getpid()` with its ppid.
  - `TestAdoptRecordsDetachedGroups`: re-exec the test binary as a leader under `StartGroup`. It starts one child
    in its own group and one with `Setsid`. `Adopt` records exactly the second's pgid, never the leader's or the
    test's own.
  - `TestEndTreeEndsAdoptedAfterLeaderExit`: the leader exits by itself after `Adopt`. Its setsid child (now
    reparented) is gone after `EndTree`.
  - `TestAdoptedGroupForgottenWhenEmpty`: as `TestExitedForgetsGroupOnceEmpty`, for an adopted group, with
    `forgetEvery` lowered.
  - `TestEndAllEndsAdoptedGroups`: **in a subprocess** (re-exec with an env flag), because `EndAll` disables
    `StartGroup` for the rest of the binary. The subprocess starts a leader with a setsid child, calls `EndAll(2s)`
    and prints the child's pid. The parent asserts that the child is gone.
- `internal/claude`:
  - `TestCloseEndsTheTree`.
  - `TestAnnouncedShellEndsWithASelfExit` (`CLAUDE_FAKE_DETACH`). Wait until `agent.AdoptedGroups(fake pid)`
    holds the child's pid. Then create the gate. The fake exits by itself. After `EvExit`, the child and the
    grandchild are gone within 10 s.
  - `TestCloseSignalsTheBackgroundFirst` (optional, if cheap): after `Close` and before the 3 s grace, the
    detached child is already gone. Lower `closeGraceNanos` to 2 s; check at 1 s.
- Every "gone" check: `syscall.Kill(pid, 0)` reports `ESRCH`, or `ps -o stat= -p` shows a zombie that is not
  ours. Wait for it with a generous bound (10 s). Every test's cleanup kills what it started, by pid, whatever
  happened.

**Commands:**
- `go test ./internal/agent ./internal/claude`;
- then `go test -race ./internal/agent ./internal/claude`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/agent ./internal/claude`;
- then `AIWB_TEST_FULL=1 go test ./cmd/ai-whiteboard -run '^TestStopEndsAgentProcesses$'`.

**Done when:**
- [ ] Close, self-exit and EndAll end detached descendants, as the tests show.
- [ ] Nothing signals a group number that is not remembered.
- [ ] Cursor and pi code is untouched.
- [ ] The reversed test is renamed everywhere it is cited.

---

## C4 — Subagent path of the rule

**Depends on:** C1. **Model:** sonnet. Follow design D3 (the table's subagent column) and D6.

**Files and spec**
- `internal/chats/spawn.go`, `handleSubEv`:
  - **Turn sign.** After `before := s.meta`, if `ev.Kind == agent.EvThinking || modelOutput(ev)`, call
    `s.bg.turnSign()`. Then:
    - `EvThinking` while `s.meta.Waiting && s.meta.BgWaiting && s.carry == nil`: a turn its process began by
      itself. Set `s.meta.Waiting, s.meta.BgWaiting = false, false`.
    - The existing model-output branch that sets `Waiting = false` also sets `BgWaiting = false`.
  - **New `case agent.EvBackground`** (status running only). Call `s.bg.report(ev.Background)`. Then, if
    `s.meta.Waiting && s.meta.BgWaiting && s.carry == nil && s.bg.idle() && runningKids(c, sid) == 0 &&
    len(owedTo(c, sid)) == 0`, call `m.armBgQuiet(c, &s.bg, m.subBgQuiet(c, sid))`. Return without an emit
    unless meta changed.
  - **`case agent.EvTurnEnd`**, first thing while running: `s.bg.report(ev.Background); s.bg.turnSign()`. The
    rest is unchanged.
  - **New `(m *Manager) subBgQuiet(c *Chat, sid string) func(out *outbox, aft *after)`.** The returned func gets
    `s := c.subs[sid]` and returns if `s` is nil, is not running, is not `Waiting`, or has a carry.
    Otherwise it calls `s.bg.report(agent.Background{})` and sets `s.meta.BgWaiting = false`. Then:
    - if `runningKids == 0 && len(owedTo) == 0`: `m.finalizeAppSub(c, s, model.SubCompleted, "", endTurn, out, aft)`;
    - else `m.saveSub(c, s); out.emitSub(c, s.meta)`.
  - Update the doc comment of `handleSubEv`: background work keeps it waiting too.
- `internal/chats/nested.go`:
  - **`subWaits`.** The early return becomes `runningKids(c, id) == 0 && len(owedTo(c, id)) == 0 &&
    !s.bg.holds()`. When it waits, set `s.meta.BgWaiting = s.bg.holds()` next to `Waiting = true`. After the
    `deliverSub` attempt, when no delivery started, call `m.armBgQuiet(c, &s.bg, m.subBgQuiet(c, s.meta.ID))`
    if `s.meta.BgWaiting && s.bg.idle() && runningKids == 0 && no owed`.
  - **`waitOver`.** Add `|| p.bg.holds()` to the condition that returns early. When a waiting parent's last kid
    ends and `p.meta.BgWaiting && p.bg.idle()`, arm the quiet wait as above, instead of doing nothing.
  - **`deliverSub`.** Where it sets `Waiting = false`, also set `BgWaiting = false`.
  - Update the package doc comment at the top of `nested.go`. A subagent waits for the subagents it started
    **and for its own background work** (Claude: a background command or a Monitor). Only a turn that ends
    cleanly with neither left finishes it. Name `background.go` as the place of the rule.
- `internal/chats/subagents.go`: wherever `Waiting` is set to false (`loadSubs`, `stopSub`), also set
  `BgWaiting = false`. Do the same in `finalizeAppSub` in `spawn.go`.

**Tests** (`internal/chats/bgsub_test.go`, new; hand-built events, no fixtures; use `e.nested`, `e.child`,
`emitSpawnItem`, `waitChild`, `agentClosed`, and `e.m.bgQuietWait`, set to `time.Hour` unless the test needs it
short):
- `TestSubagentWaitsOnItsBackgroundWork`: a turn end with `Background{Running:1}` leaves the subagent running,
  `Waiting`, `BgWaiting`, its process not closed, and nothing owed or sent to the chat's agent.
- `TestSubagentSelfBegunTurnWorksThenWaits`: from waiting, `EvThinking` makes it not `Waiting`. Text, then a turn
  end with `{1,false}`, leave it waiting again. The text is in its own thread.
- `TestSubagentFinishesAfterTheLastTurn`: the turn end with `{0,false}` finishes it (completed). The chat's
  agent is handed one result whose report is that last turn's text.
- `TestSubagentWaitsOnChildAndBackgroundEitherOrder`: two subtests.
  - child first: the result is delivered while it waits on background work; the delivery's turn ends with
    `{1,false}`, and it stays waiting; the last turn with `{0,false}` finishes it.
  - background first: the turn end `{0,false}` with the child running leaves it waiting, with `BgWaiting` false;
    the child's end delivers; the delivery turn ends with `{0,false}` and finishes it.
- `TestSubagentQuietWaitEndsAWaitWithNothingRunning`: `bgQuietWait` 50 ms. Wait with `{1,false}`, then
  `EvBackground{0,true}` and nothing else: it finishes, completed, with the last text as its report. A second
  case: an `EvThinking` before the quiet time keeps it from finishing.
- `TestStoppingAWaitingSubagentClosesItsProcess`: `StopSubagent` on a subagent waiting on background work closes
  its process (`agentClosed`). Its record is stopped, with `Waiting` and `BgWaiting` false.
- `TestSubagentWithoutBackgroundUnchanged` (goal 6.5): a turn end with zero `Background` finishes it at once, as
  before. Most of this is already proven by the existing nested tests, which must pass unchanged.

**Commands:**
- `go test ./internal/chats`;
- then `go test -race ./internal/chats`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] Every test above passes, and every existing `internal/chats` test passes unchanged.
- [ ] The only decision of "waits on background work" is `s.bg.holds()` / `waitsOnBackground`; no other check of
      `Running` or `Unread` is in the subagent code.
- [ ] `BgWaiting` is false wherever `Waiting` is false.

---

## C5 — Chat path of the rule, and Stop of a waiting chat (opus)

**Depends on:** C1. **Model:** **opus**. `pump`, the delivery and the cap are intertwined; read `delivery.go`'s
and `cap.go`'s doc comments first. Follow design D3 (the table's chat column), D5 and D7.

**Files and spec**
- `internal/chats/manager.go`, `pump`:
  - Replace `wasBusy := busy(c)` with `wasInTurn := inTurn(c)`. The self-begun detection becomes
    `!wasInTurn && inTurn(c) && st != model.StatusApproval && !c.meta.TurnActive`. `TurnActive` stays true
    through a wait, so a self-begun turn in a waiting chat does not hit it, and that is right.
  - **Turn sign.** If `ev.Kind == agent.EvThinking || modelOutput(ev)`, call `c.bg.turnSign()`.
  - **`case agent.EvBackground`:** `c.bg.report(ev.Background)`. If the status is `StatusWaiting` and
    `c.bg.idle()`, call `m.armBgQuiet(c, &c.bg, m.chatBgQuiet(c))`. Nothing reaches the transcript (`Apply`
    ignores the kind anyway).
  - **`case agent.EvTurnEnd`:**
    - Compute `clean := !ev.Aborted && ev.Error == ""` and `waits := clean && waitsOnBackground(ev.Background)`.
    - Call `c.bg.report(ev.Background); c.bg.turnSign()`.
    - Set `c.meta.TurnActive = false` only when `!waits`. `Usage.Turns++` is unchanged (goal 3.6).
  - After `ups := c.tr.Apply(ev)` and the end mark: if `waits`, call `c.tr.SetStatus(model.StatusWaiting)`, then
    arm the quiet wait if `c.bg.idle()`. Do it before the `view(c) != before` emit, so the emitted view says
    waiting.
  - `stopSubs` on an aborted end or an exit is unchanged.
  - **New `(m *Manager) chatBgQuiet(c *Chat) func(out *outbox, aft *after)`.** If the status is not
    `StatusWaiting`, return. Otherwise:
    - `c.bg.report(agent.Background{})`;
    - `c.tr.SetStatus(model.StatusReady)`, `c.meta.TurnActive = false`;
    - flush, `m.logSave(c)`, `out.emitChat(c)`;
    - `aft.add(m.deliver(c, out))`.
- `internal/chats/delivery.go`:
  - **`deliverable`.** Use `!inTurn(c)` instead of `!busy(c)`: subagent results go to a waiting chat. The
    delivery's turn sets thinking. At its end the rule applies again, and the chat is waiting or idle.
  - Update the comments of `deliverable` and `deliver` (they say "not busy"), and the package doc: a waiting
    chat takes results as a waiting subagent does.
- `internal/chats/branches.go`: split `stopOne`. Its body after the lock becomes
  `(m *Manager) stopLocked(c *Chat, out *outbox) (toClose []agent.Agent)`, with c.mu held, and `stopOne` calls
  it. Behaviour is unchanged.
- `internal/chats/manager.go`, **`InterruptOf`**. After `lockBranch`, if `c.ag != nil && (c.bg.holds() ||
  status == StatusWaiting)`:
  - the person stops an agent that has background work, so its process is closed with what it started (D7);
  - call `m.stopLocked(c, &out)`, then `c.bg = bgWork{}`;
  - unlock, send, `closeAgents(toClose)`, return nil.
  - Otherwise it is unchanged.
  - Update `InterruptOf`'s doc comment.
- Check the other uses of `busy(c)`. Keep `busy` (the person's view: Send refused, Busy/BusyOf, restarts,
  forks, the tree) everywhere except the two places above. List in your report each call site you looked at.

**Tests** (`internal/chats/bgchat_test.go`, new; hand-built events on the chat's `fakeAgent`; `e.m.bgQuietWait =
time.Hour` unless short):
- `TestChatWaitsOnItsBackgroundWork`: a turn end with `{1,false}` leaves:
  - status `waiting`;
  - `Busy` true;
  - `e.m.Send` → `ErrBusy`;
  - `view.Working == 1`;
  - `TurnActive` true;
  - an `end` mark added;
  - `Usage.Turns == 1`.
- `TestChatSelfBegunTurnShowsWorkingThenWaits`: `EvThinking` gives status thinking. Text, then a turn end with
  `{1,false}`, give waiting. `Usage.Turns == 2`. The thread has both texts, and no user item was added.
- `TestChatIdleAfterTheLastTurn`: a turn end with `{0,false}` gives status ready and `TurnActive` false. Results
  owed meanwhile are delivered at that moment.
- `TestWaitingChatTakesSubagentResults`: a subagent finishes while the chat waits. A delivery is handed (the
  chat's agent got the results block) and the status is thinking. That turn's end with `{1,false}` gives
  waiting. The result's delivery is not lost: it is not owed again, and it is not given up.
- `TestChatQuietWaitEndsAWaitWithNothingRunning`: `bgQuietWait` 50 ms; `EvBackground{0,true}` while waiting;
  status ready after the quiet time. With an `EvThinking` before it, the status stays thinking.
- `TestStopWaitingChatClosesItsProcess`: `Interrupt` of a waiting chat:
  - closes the process (`agentClosed`);
  - status ready, a "Stopped." note, the chat held;
  - a next `Send` starts a new process with `Resume` set.
- `TestStopChatInATurnWithBackgroundWork`: `EvBackground{1,false}`, then `EvThinking` (in a turn), then
  `Interrupt`: the process is closed as well (not only interrupted).
- `TestExitWhileWaiting`: `EvExit` while waiting gives status stopped, with the note "The agent stopped: process
  ended".
- `TestRestartWhileWaitingShowsStopped`: `e.boot()` while waiting: the reloaded chat shows stopped, with the
  "app was closed" note (`TurnActive` stayed true).
- `TestWaitingChatHoldsATurnSlot`: with `maxTurnsPerChat = 1` (restore it after), a waiting branch makes a
  second branch's Send `ErrChatCap`. Use the existing cap test helpers.
- Goal 6.5: the existing chat tests pass unchanged, so a chat without background work is as before.

**Commands:**
- `go test ./internal/chats`;
- then `go test -race ./internal/chats`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] The tests above pass, and every existing `internal/chats` test passes unchanged.
- [ ] The chat path's only decision of waiting is `waitsOnBackground` / `c.bg`.
- [ ] Stop of a waiting chat closes its process.
- [ ] The doc comments of `pump`, `deliverable`, `deliver`, `InterruptOf` and the delivery package doc say what
      a waiting chat does.

---

## C6 — Recorded-stream tests through the manager, and the docs

**Depends on:** C2, C4, C5 (merged). **Model:** sonnet.

**Files and spec**
- `internal/chats/bgplay_test.go` (new): the player of design D10.
  ```go
  // playStep is one step of a recorded Claude stream: the agent events of its lines (through
  // claude.Translator), then what the agent is expected to be once they are applied.
  type playStep struct{ name, expect string; evs []agent.Event }
  func loadPlay(t *testing.T, fixture string) []playStep // reads ../claude/testdata/bg/<fixture>; splits at {"type":"aiwb_step"}
  func chatPhase(v model.ChatView) string  // in a turn → "working", StatusWaiting → "waiting", ready → "done"
  func subPhase(s model.Subagent) string   // running && !Waiting → "working"; running && Waiting → "waiting"; final → "done"
  ```
  Feed each step with `fakeAgent.emit(t, step.evs...)`. A chat test first sends the message with `e.send` (its
  `EvThinking` comes from the fixture). A subagent test spawns with `e.child` (its prompt is sent by the
  runner).
- `docs/architecture.md`: the text of design D11, written in the document's own voice.
  - In the Server bullet, right after the sentence that ends "…reports to whoever started it only after a turn
    that ends with none of them running", add the background-work sentences.
  - Add one sentence on what ending an agent does to what it started.
  - Add the `waiting` status where the chat's statuses are described, if a place lists them (search for
    "Thinking").
  - Keep it short: two to five sentences in all.

**Tests** (all with `e.m.bgQuietWait = time.Hour`):
- `TestBackgroundSamePhasesForChatAndSubagent` (goal 6.2, "one check covers both"):
  - Play `shell_and_monitor.jsonl` to a chat's own agent and, in the same test, to an app subagent of another
    chat.
  - After each step, `chatPhase` and `subPhase` both equal the step's `expect`.
  - Collect both lists and compare them as well.
- `TestSubagentPlaysShellAndMonitor` (goal 6.1, bullets 1 to 4):
  - after the first step: running, `Waiting`, `BgWaiting`, the process not closed, the chat's agent handed
    nothing;
  - at the end: completed, and exactly one delivery to the chat's agent, whose block holds "All done: the shell
    printed shell-done and the monitor ticked twice." and not "waiting" as the report;
  - the subagent's thread holds the five texts in order.
- `TestChatPlaysShellAndMonitor` (goal 6.2, bullets 2 to 4):
  - status `waiting` after step 1;
  - thinking in the "begins" steps;
  - ready at the end;
  - the thread holds the five texts and five `end` marks;
  - `Usage.Turns == 5`.
- `TestChainTwoLevelsWithTheMonitorAtTheBottom` (goal 6.1, bullet 6):
  - depth 2; A spawns B (`emitSpawnItem` + `e.child`);
  - A's own turn ends with zero background, so A waits on B;
  - B plays the fixture. At every step A is waiting, and B's phase is the step's;
  - at the end B completes and A is handed B's result. A's delivery turn says "A's report" and ends with zero
    background, so A completes;
  - the chat's agent gets one result with "A's report".
- `TestResumeNoticesThroughTheManager` (goal 6.4): play `resume_notices.jsonl` to a chat.
  - After step 1, `Usage.Turns == 0`.
  - Then waiting, with `Usage.Turns == 1`.
  - After the "lost task's empty result while work runs" step, still waiting, with `Usage.Turns == 1`.
  - At the end, ready (not thinking), with the error note "API Error: 529 overloaded" and `Usage.Turns == 2`.

**Commands:**
- `go test ./internal/chats -run 'Plays|SamePhases|Chain|ResumeNotices'`;
- then `go test ./internal/chats`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/chats`.

**Done when:**
- [ ] The player and the five tests pass in the default set and start no process.
- [ ] `docs/architecture.md` says that an agent with background work waits, when it is finished, the status
      `waiting`, and what ending an agent does to what it started (goal 6.7).

---

## C7 — Real-process stand-in and the leftover checks

**Depends on:** C2, C3, C4, C5 (merged). **Model:** sonnet.

**Files and spec**
- `internal/agenttest/fake-claude` (Node):
  - **`[[bg SECONDS]]`.** In the turn:
    - emit `assistant` tool_use `Bash {"command":"sleep SECONDS","run_in_background":true}` (id `toolu_bg<n>`);
    - emit `system/background_tasks_changed` listing every live background task of this process
      (`{"task_id":"bg<n>","task_type":"local_bash","description":"sleep SECONDS"}`);
    - emit `system/task_started` (local_bash, `is_backgrounded:true`);
    - emit the `user` tool_result;
    - start `child_process.spawn("sh", ["-c", "sleep SECONDS; true"], {detached: true, stdio: "ignore"})`,
      exactly as Claude starts its shell, and do not `unref` it;
    - append the child's pid and a newline to `$FAKE_CLAUDE_BGPIDS` when that is set.
    The turn's reply text is `"waiting"` when the directive was the only one.
  - **When that child exits:**
    - emit `system/task_updated` (completed);
    - emit `system/task_notification` (completed, summary `Background command "sleep SECONDS" completed (exit
      code 0)`);
    - emit `background_tasks_changed` without it;
    - then queue a self-begun turn, which runs after any turn in progress: `system/status requesting`, an
      assistant text `bg<n> done`, a result with `"origin":{"kind":"task-notification"}`.
  - **`[[leave]]`.** After this turn's result line, the process exits 0, leaving its children as they are (the
    self-exit case).
  - **On stdin close.** While a background child lives, the fake does not exit (as the real CLI does, goal 2.1).
    It exits when the last child has ended and its turn has been emitted, or at once if none lives.
  - Update the header comment's directive list, and `FakeClaude`'s doc comment in `fakeclaude.go`.
- `internal/agenttest/fakeclaude_test.go`: `TestFakeClaudeBackgroundCommand` through the real `claude.Spawner`.
  `[[bg 0.3]]` gives:
  - an `EvBackground{1,false}`;
  - a turn end with `{1,false}`;
  - later `{1,true}`, then `{0,true}`, then `{0,false}`;
  - a turn end that is `SelfBegun` with `{0,false}`.
  Skip without Node (`HasNode`).
- `internal/chats/bgproc_test.go` (new):
  - Build an env whose Claude spawner is the real
    `&claude.Spawner{Bin: agenttest.FakeClaude(t), AppRoot: <the env's root>, Home: t.TempDir()}`.
  - Use `t.Setenv("FAKE_CLAUDE_BGPIDS", file)`, so no `t.Parallel`.
  - Skip without Node.
  - `gone(t, pid)` waits up to 10 s for `syscall.Kill(-pid, 0)` to report `ESRCH`: the group of the detached shell.
  - Cleanup always kills every recorded pid's group.
- `cmd/ai-whiteboard/agents_stop_test.go`: `TestStopEndsBackgroundCommands`, modelled on
  `TestStopEndsAgentProcesses`:
  - the server runs with `-claude <agenttest.FakeClaude>` and `FAKE_CLAUDE_BGPIDS`;
  - a Claude chat is sent `[[bg 60]]` through the client API;
  - wait for the pid;
  - stop the server as the existing test does;
  - the shell's group is gone.
  - It is full set only (`serverTest`), and its reason names
    `TestEndAllEndsAdoptedGroups (internal/agent)`.

**Tests** (in `bgproc_test.go`; each starts one or two Node processes, so they stay in the default set if each
takes under about a second alone; otherwise gate them with `testset.SkipUnlessFull`, with a reason naming
`TestCloseEndsTheTree` and `TestAnnouncedShellEndsWithASelfExit (internal/claude)`):
- `TestStoppingAWaitingSubagentLeavesNoCommand`: a subagent with prompt `[[bg 60]]` waits. `StopSubagent` → the
  group is gone.
- `TestStoppingAWaitingChatLeavesNoCommand`: a chat with `[[bg 60]]` waits (status `waiting`). `Interrupt` → the
  group is gone, and the chat is ready.
- `TestDeletingAWaitingChatLeavesNoCommand`: `Delete` while waiting → the group is gone.
- `TestSelfExitLeavesNoCommand`: a chat with `[[bg 60]] [[leave]]`. The process exits by itself → the group is
  gone, and the chat shows the stop note.
- `TestBackgroundCommandEndsAndTheChatIsIdle` (the real-process end to end of goal 6.2): `[[bg 0.5]]` → waiting,
  then working, then ready. The thread has "waiting" and "bg1 done".

**Commands:**
- `go test ./internal/agenttest ./internal/chats -run 'Background|LeavesNoCommand'`;
- then `go test ./internal/agenttest ./internal/chats`;
- then `go test -race ./internal/chats`;
- then `go test ./...`;
- then `AIWB_TEST_FULL=1 go test ./internal/agenttest ./internal/chats`;
- then `AIWB_TEST_FULL=1 go test ./cmd/ai-whiteboard -run 'StopEnds'`.

**Done when:**
- [ ] Every case of goal 6.3 is shown by a test that looks at the process list afterwards: stopping a waiting
      subagent, stopping a waiting chat, delete, server shutdown, self-exit.
- [ ] The fake's new directives are documented in its header.
- [ ] No test leaves a `sleep` behind, even when it fails.

---

## C8 — The app: the waiting status and the browser checks

**Depends on:** C1 for the shapes (`status: "waiting"`, `Subagent.bgWaiting`). No Go code is touched, so it can
start as soon as C1 is merged. **Model:** sonnet.

**Files and spec** (design D5, D6)
- `packages/core/src/types.ts`:
  - `Status` gets `"waiting"`;
  - `Subagent` gets `bgWaiting?: boolean`, commented like the Go field.
- `packages/core/src/logic/status.ts`:
  - `isBusy` includes `"waiting"`. A waiting chat takes no message, and Stop and Esc stop it.
  - Add `inTurn(s)`: busy and not waiting.
  - Update the comments of `isBusy`, `composerControls` and `branchWorking`.
- `packages/core/src/logic/labels.ts`:
  - `waitingText`:
    - returns "" when archived, or when busy and not waiting;
    - for a waiting chat its first part is "Waiting for background work";
    - the subagent parts follow as today.
  - `statusText`: `case "waiting": return waitingText(c)`.
  - `dotState` and `rowLine` need no change. Verify it: a waiting chat gives the dot `waiting` and the line
    "Waiting for background work". Fix them if not.
- `packages/core/src/logic/subagents.ts`, `subWaitingText`: with `sa.bgWaiting`, n running children gives
  `Waiting on n subagent(s) and background work`, and none gives `Waiting for background work`. Otherwise as
  today.
- `app/src/screens/chat/Thread.tsx`:
  - the typing line shows only when `inTurn(c.status)`;
  - the waiting row shows `waitingText(c)`, which now covers a waiting chat.
  - No other screen changes. Check `app/src/screens/sidebar/rows.tsx` and `parts.tsx`: the dot colour for
    `waiting` exists.
- `app/src/voice/engine/reply.ts`:
  - A reply must close at its turn's `end` mark even when the chat goes on to `waiting`. Today it closes on the
    `end` item.
  - Confirm it with a unit test in the voice tests: a chat whose status goes thinking → waiting, with an `end`
    item, closes the reply. If it does not, use `inTurn` in `busy()` there.
- Browser checks (`web/dev/checks`). **Do not change the mock's seed**: other checks count its working chats.
  Set the state inside the check with `mockEval` and put it back at the end, as `AAC.1-first.mjs` does.
  - `L10-chatview.mjs`. Set a seed chat's `status = "waiting"` and send its `chat` event. At each viewport:
    - the header status and the thread's foot say "Waiting for background work";
    - the foot is the `waiting` row, not the typing line;
    - the composer shows Stop and Send is blocked.
    - Pressing Stop sends `POST /api/chats/{id}/interrupt`; read the mock's request log as other checks do.
  - `L11-sidebar.mjs`: the same chat's row has `crow-dot` with `data-state="waiting"` and the line "Waiting for
    background work".
  - `L19-subagents.mjs`: give one running seed subagent `waiting: true, bgWaiting: true` through `mockEval`. Its
    row is the still ring with the line "Waiting for background work". A subagent that waits on one child and on
    background work says "Waiting on 1 subagent and background work".
  - `web/dev/checks/README.md`: add these assertions to the rows of L10, L11 and L19.
- Unit tests:
  - `packages/core` tests for `statusText`, `waitingText`, `dotState`, `rowLine`, `composerControls`,
    `subWaitingText` and `isBusy`/`inTurn` with `"waiting"`;
  - `app` tests if `Thread`'s rows are unit-tested (`threadRows`).

**Commands:**
- from the root `npm test && npm run check`;
- `cd web && npm test`;
- `cd desktop && npm test`;
- `cd web && npm run uicheck -- L10 L11 L19`. Needs Playwright 1.64.1 (`npm install --no-save
  playwright@1.64.1 && npx playwright install chromium` in `web/`).
- No Go tests.

**Done when:**
- [ ] A waiting chat reads as "Waiting for background work" in the header, the foot of the thread and the
      sidebar row, with the muted dot.
- [ ] It shows Stop and blocks Send.
- [ ] A subagent waiting on background work says so in its line.
- [ ] Unit tests and checks L10, L11 and L19 pass at their viewports.
- [ ] No other check's expectations changed.

---

## After the last merge

- One run of `AIWB_TEST_FULL=1 go test -timeout 20m ./...` with nothing else testing.
- One run of the root `npm test && npm run check`.
- Goal 6.6, the real Claude through the app, costs money. **Only when the person asks:** one chat and one
  subagent given "start `sleep 5` in the background and a Monitor of `for i in 1 2; do sleep 2; echo $i; done`,
  then tell me when both are done". It confirms R1 and R2 of `design.md`.
