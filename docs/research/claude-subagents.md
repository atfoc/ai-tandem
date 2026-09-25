# Seeing Claude Code subagents from the Go server

**Question.** When a Claude Code agent, run the way this app runs it, spawns subagents (the
Agent/Task tool, foreground and `run_in_background`), what can the Go server read to show that work
in the UI? For each subagent: (1) that it was spawned and its link to the parent, (2) its lifecycle
state, including background agents that outlive the parent turn, (3) its context usage, (4) its
transcript, (5) anything else useful. Which sources carry it (stream-json stdout, transcript files
on disk, hooks, control requests), and can one subagent be stopped on its own?

**Mode.** No human in the loop. Running code settled every point; nothing below is from reading
code alone except where marked "(schema only)".

**Branch / worktree.** `claude-subagents`, at `.worktrees/claude-subagents`.

**Tested against.** Claude Code 2.1.281 (`~/.local/bin/claude`), Go 1.25.1, macOS, OAuth login.
Parent and subagents on `--model haiku` (claude-haiku-4-5), plus one subagent on `sonnet`
(claude-sonnet-5).

## The harness

- `proto/cmd/subharness/main.go` builds the command line by calling the app's own
  `claude.Spawner.Args` (plain chat, no board), so the flags are exactly the app's:
  `-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-mode auto --permission-prompt-tool stdio --session-id <uuid> --model haiku
  --disallowedTools …`. It adds `--settings '{"hooks":{…}}'` that points the SubagentStart,
  SubagentStop, PreToolUse, PostToolUse, Stop, TaskCreated and TaskCompleted hooks at
  `proto/hook.sh`, and an optional `-extra` for flags under test.
- It logs every stdin (`>`) and stdout (`<`) line with a timestamp, answers every `can_use_tool`
  with allow, and polls `~/.claude/projects/<slug>/<session>/subagents/` every 0.5 s, logging each
  size change (`D` lines) to show when the files are written.
- `proto/hook.sh` appends each hook's stdin JSON to `evidence/<scenario>.hooks.log`.
- `proto/summarize.py evidence/<scenario>.log` prints one line per event (deltas skipped).
- Outputs, all committed: `evidence/<scenario>.log` (raw), `.hooks.log`, `.summary.txt`, and
  `.disk/` (a copy of the project folder: main transcript, sidechain files, meta files).
- Rerun: `cd .worktrees/claude-subagents && go run ./proto/cmd/subharness -s <scenario>`.

## What was tried (one line per attempt, commit)

1. `588bc30`: `fg`, one foreground subagent (Read and Bash). Found the `task_*` events, hooks and
   the sidechain file.
2. `8bdf5ec`: `bg`, one background subagent (sleep 20) with stdin left open; `parallel`, one
   foreground and one background Agent call in the same assistant message; `fg -tag -forward` with
   `--forward-subagent-text`.
3. `ed59120`: `stop`, `stopfg`, `interruptfg`, `interruptbg` and `closebg`. In `stop` and
   `interruptbg` haiku moved its `sleep` into the background (the CLI blocks a plain `sleep N`), so
   the agent had already finished. Those two were redone in attempt 4.
4. `a2bf0ad`: `stop2`, `stop_task` on a busy background agent (python sleep); `interruptbg2`,
   interrupting the parent while a background agent is busy; `bgtasks`, the `background_tasks`
   control request on a running foreground agent; `perm`, a subagent tool that needs approval;
   `fail`, a custom agent (`--agents`) on a model that does not exist.
5. `26a4561`: `model`, a subagent on `model: "sonnet"`, run with `--include-hook-events`;
   `killbg`, SIGKILL of the CLI while a background agent runs; then `resumeask`, which runs
   `--resume` on that session.

## Answer

**All five data points can be read from stdout alone, for foreground and background subagents.**
Stdout carries a `system/task_*` lifecycle stream with ids, per-tool progress with token counts, and
the subagent's messages tagged with `parent_tool_use_id`. The sidechain JSONL file on disk has the
full transcript with exact per-message usage, and it is written live. Hooks add nothing that stdout
lacks, and they miss failed and stopped agents. `stop_task` stops a single subagent.

### 1. Spawn and link to the parent

Order on stdout (from `fg.log`): the parent's `assistant` message with the `Agent` tool_use (its
`input_json_delta`s stream first), then

```jsonc
{"type":"system","subtype":"task_started","task_id":"ad45b564dde8739b1","tool_use_id":"toolu_01RNrFmNpkLFATjiLpNgG6Y1",
 "description":"read notes","subagent_type":"general-purpose","is_backgrounded":false,"spawn_depth":1,
 "task_type":"local_agent","prompt":"Use the Read tool to read notes.txt …"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Use the Read tool …"}]},
 "parent_tool_use_id":"toolu_01RNrFmNpkLFATjiLpNgG6Y1",…}      // the subagent's first prompt
```

- `tool_use_id` is the parent's Agent tool_use id. `task_id` is the agent id; the same id is the
  hook's `agent_id`, the sidechain file name, `can_use_tool.agent_id`, and the `agentId` in the
  tool result.
- A background launch is also preceded by
  `{"subtype":"background_tasks_changed","tasks":[{"task_id":"a8d3…","task_type":"local_agent","description":"slow bg job"}]}`
  and shows `"is_backgrounded":true`.
- Bash commands run by a subagent also produce `task_started` with `"task_type":"local_bash",
  "owned_by_subagent":true`. Filter on `task_type == "local_agent"` to get subagents only.
- Two Agent calls in one message (`parallel`) give two `task_started` events 0.7 s apart, each with
  its own `tool_use_id`. Their messages interleave on stdout, and `parent_tool_use_id` keeps them
  apart.

### 2. Lifecycle state

Every state change comes as `task_updated` (a patch) followed by `task_notification` (terminal):

| Case (scenario) | `task_updated.patch.status` | `task_notification.status` | Also |
|---|---|---|---|
| Normal end, fg and bg (`fg`, `bg`, `parallel`) | `completed` | `completed` | `summary` = final text, `usage` |
| API error in the subagent (`fail`) | `failed`, plus `error` text | `failed` | Agent tool_result has `is_error:true` |
| `stop_task` on a bg agent (`stop2`) | `killed` | `stopped` | its Bash child is stopped too |
| `stop_task` on a fg agent (`stopfg`) | `killed` | `stopped` | parent gets tool_result `[Request interrupted by user for tool use]`, and the parent turn goes on |
| Parent `interrupt` while a fg agent runs (`interruptfg`) | `killed` | `stopped` | parent `result` is `error_during_execution` |
| Parent `interrupt` while a **bg** agent runs (`interruptbg2`) | `killed` | `stopped` | **interrupt kills background agents too** |
| Moved to background (`bgtasks`) | `{"is_backgrounded":true}` | (later) `completed` | |
| CLI killed, then `--resume` (`killbg` → `resumeask`) | none | `stopped`, summary `Background agent "orphan" didn't finish before the previous session ended` | sent on the first turn after resume |

- "Running" is the time between `task_started` and the terminal notification.
  `task_progress` arrives at each subagent tool call. There is no separate "running" event.
- **Background agents outlive the parent turn.** In `bg` the parent's `result` came at 5.4 s. The
  subagent's messages and `task_progress` kept arriving, `task_notification completed` came at
  29.5 s, and then **the CLI started a new parent turn on its own**, with no stdin line:
  `system/init`, a streamed reply ("Agent "slow bg job" completed…"), and a second `result`. The
  app will see an unrequested turn and must handle it.
- **Closing stdin does not kill background agents** (`closebg`). The CLI waited for the agent, ran
  the follow-up turn, and exited 0 about 25 s later. The app's `Close` kills the process after 3 s,
  which kills them. After a kill, the sidechain file just stops, and `meta.json` has no end marker.
  Only a later `--resume` reports it, as a `stopped` notification.
- `result.subagent_stats` sums up each turn:
  `{"spawned":1,"requested":{"background":0,"foreground":1,…},"completed":1,"failed":0,"killed":{"parent":0,"user":0,"system":0},…}`.

### 3. Context usage

| Source | What it gives | Live? | Exact? |
|---|---|---|---|
| `assistant` lines with `parent_tool_use_id` | `message.usage` per API call: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` | yes | input side exact; **`output_tokens` is only the first-chunk value (1 to 6)** |
| `task_progress.usage` | `{"total_tokens":12658,"tool_uses":1,"duration_ms":3414}` at each tool call | yes | `total_tokens` = the last call's input + cache + output = the subagent's context fill |
| `task_notification.usage` | final `total_tokens`, `tool_uses`, `duration_ms` | at end | fg 14211 vs 14165 in the tool result: close, not identical |
| Agent `tool_use_result` (fg only) | `totalTokens`, `totalToolUseCount`, `totalDurationMs`, last-call `usage` {input, cache, output}, `resolvedModel`, `toolStats` | at end | exact. For bg the tool result is only `{"isAsync":true,"status":"async_launched","agentId":…,"outputFile":…}` |
| Sidechain JSONL (disk) | `message.usage` on every assistant entry, **with final `output_tokens`** (e.g. 370 where stdout showed 2) | written live | exact |
| `result.modelUsage` | parent **plus** subagent tokens, per model, cumulative; `contextWindow` per model | end of each parent turn | aggregate only |
| `get_context_usage` control request | parent context only (totalTokens 24492 while the subagent sat at ~13k); the request has no agent parameter | on demand | not per subagent |

- No `stream_event` (partial message) ever carries a subagent's `parent_tool_use_id`: 0 lines in
  all runs, with or without `--forward-subagent-text`. Live usage per subagent comes per API call,
  not per token.
- The subagent's context window: `modelUsage[<subagent model>].contextWindow`. In `model`:
  haiku 200000 and sonnet-5 1000000. The subagent's model is `message.model` on its lines.
- **App bug risk:** `translate.go` takes the **largest** `contextWindow` in `modelUsage` as the
  chat's window. A sonnet subagent under a haiku chat turned that into 1,000,000. Use the parent's
  model entry instead.

### 4. Transcript

- **Stdout, foreground agent, default flags:** you get the first prompt (`user`), every
  `assistant` tool_use, and every `user` tool_result, all with `parent_tool_use_id`. **Text and
  thinking-only assistant messages are not sent**, so the final report reaches you only through the
  Agent tool_result and `task_notification.summary`.
- **With `--forward-subagent-text`** (`fg-forward.log`), foreground agents also send their
  thinking and text messages (`"text":"The second line of the file is: **beta**"`), again with
  `parent_tool_use_id`.
- **Stdout, background agent:** text and thinking are sent **even without the flag** (`bg.log`,
  `parallel.log`).
- Subagent lines carry extra fields `subagent_type` and `task_description`. Content comes as whole
  messages only: no token streaming, and thinking text is empty (signature only), the same as for
  the parent.
- **Disk:** `~/.claude/projects/<cwd-slug>/<session>/subagents/agent-<task_id>.jsonl`, with every
  line `isSidechain:true` and `agentId`. It holds the prompt, attachments, thinking, text,
  tool_use, tool_result and usage.
  - It is created within 0.5 s of `task_started` and grows with each message (`D` lines in
    `bg.log`: 29 KB, then 33, 35, 103, 108 KB).
  - Next to it, `agent-<id>.meta.json` holds
    `{"agentType","description","toolUseId","spawnDepth","requestShape":"foreground"|"background","requestNonInteractive"}`
    and gains `"stoppedByUser":true` after a stop.
  - `task_notification.output_file` (`/private/tmp/claude-<uid>/…/tasks/<id>.output`) is a
    symlink to the same JSONL.
  - The parent's `<session>.jsonl` holds only the Agent tool_use and tool_result, whose
    `toolUseResult` includes `agentId`.
- **Hooks:** `SubagentStop` gives `agent_transcript_path` and `last_assistant_message`, but only on
  normal completion (see 5).

### 5. Other sources and facts

- **Hooks** (via `--settings`, which the app does not use today):
  - `SubagentStart {agent_id, agent_type}` fired for every agent.
  - `SubagentStop {agent_id, agent_type, agent_transcript_path, last_assistant_message}` fired
    **only on normal completion**. It did not fire for `failed` (`fail`), `stop_task` (`stopfg`,
    `stop2`) or interrupt (`interruptfg`, `interruptbg2`).
  - PreToolUse and PostToolUse inside a subagent carry `agent_id` and `agent_type`.
  - `Stop` lists `background_tasks:[{id,type:"subagent",status:"running",…}]`.
  - No hook has token usage.
  - `--include-hook-events` only mirrors them to stdout as `hook_started`/`hook_response` (name
    and outcome, no payload).
  - The `task_*` events are a superset, so hooks are not needed.
- **Permissions:** a subagent's `can_use_tool` request carries `"agent_id":"af0c39f66df96eea8"`,
  plus the tool's own `tool_use_id`. A parent request has no `agent_id` (`stop2`, `interruptbg2`).
  The UI can label approval cards "asked by subagent X".
- **Control requests that worked:**
  - `{"subtype":"stop_task","task_id":"<id>"}` gets `{"subtype":"success","response":{}}` in 3 ms
    and stops that one agent and its Bash children. In the background case the parent then starts
    a follow-up turn on its own. The Agent SDK wraps this as `stopTask`.
  - `{"subtype":"background_tasks","tool_use_id":"<Agent tool_use id>"}` gets
    `{"backgrounded":true}`. The running foreground agent became a background one, and the parent
    turn went on at once.
  - `{"subtype":"interrupt"}` stops the parent **and every running subagent, background ones
    included**.
- **Model and duration:** `message.model` on subagent lines; `resolvedModel` and `totalDurationMs`
  in the fg tool result; `duration_ms` in `task_progress` and `task_notification`; `end_time`
  (epoch ms) in `task_updated`.
- **Cost:** `total_cost_usd` and `modelUsage[].costUSD` include subagent spend. The app must not
  show them; use token counts only.
- **Resume after a crash:** the first turn after `--resume` sends a `task_notification stopped`
  for the lost agent, then an **empty `result`** (`num_turns:0`, cost 0) **before** the real turn's
  events and `result`. A turn tracker that counts `result` lines will end the turn too early.

## Data × source table

C = confirmed by a run; N = not available (checked); P = partial.

| Data item | stdout stream-json | Sidechain files on disk | Hooks | Control requests |
|---|---|---|---|---|
| Spawned, `task_id`, parent `tool_use_id` | **C** `task_started` | **C** meta.json `toolUseId`, file name | **C** SubagentStart (`agent_id` only; no tool_use_id) | N |
| Agent type, description, prompt | **C** `task_started` | **C** meta.json and first `user` line | P `agent_type` only | N |
| Fg / bg flag | **C** `is_backgrounded`; `task_updated` patch when moved | **C** meta `requestShape` (at spawn) | N | N |
| Started / running | **C** `task_started`, `task_progress`, `background_tasks_changed` | P file grows | P Start only | N |
| Completed | **C** | P (no end marker) | **C** SubagentStop | N |
| Failed, with error | **C** `status:failed`, `error` | N | **N** (no hook) | N |
| Stopped / killed | **C** `killed`/`stopped` | P meta `stoppedByUser` | **N** | N |
| Bg agent after the parent turn ends | **C** keeps streaming, then an auto follow-up turn | **C** | **C** (completion only) | N |
| Context fill, live | **C** `task_progress.total_tokens`; input side of each assistant `usage` | **C** per message | N | **N** (`get_context_usage` is parent-only) |
| Final tokens | **C** `task_notification.usage`; fg tool_result `totalTokens`/`usage` | **C** exact output_tokens | N | N |
| Context window size | **C** `modelUsage[model].contextWindow` (per turn) | N | N | P `get_context_usage.maxTokens` (parent model) |
| Transcript tool calls and results, live | **C** | **C** | P tool hooks with `agent_id` | N |
| Transcript text and thinking, live | **C** bg always; fg only with `--forward-subagent-text` | **C** | P `last_assistant_message` at end | N |
| Token-level streaming | **N** (no subagent `stream_event`) | N | N | N |
| Model | **C** `message.model`, `resolvedModel` | **C** | N | N |
| Duration | **C** `duration_ms`, `end_time` | **C** timestamps | N | N |
| Which agent asked for permission | **C** `can_use_tool.agent_id` | n/a | P PreToolUse `agent_id` | n/a |
| Stop one subagent | n/a | n/a | n/a | **C** `stop_task` |
| Send a fg subagent to background | n/a | n/a | n/a | **C** `background_tasks` |

## Recommendation

**Use stdout for everything live, for both kinds of subagent, and the sidechain file for history
and exact numbers.** No hooks and no new flags are required. Add `--forward-subagent-text` so
foreground agents show text as they go, the same as background ones.

1. **Keep a subagent table per chat, keyed by `task_id`** and filled from `system` events that
   `translate.go` currently ignores:
   - `task_started` with `task_type=="local_agent"` → a new row (parent `tool_use_id`,
     `subagent_type`, `description`, `prompt`, `is_backgrounded`).
   - `task_progress` → running, `total_tokens` as context fill, `tool_uses`, `last_tool_name`,
     `description` as the status line.
   - `task_updated` → `is_backgrounded`, `status`, `error`, `end_time`.
   - `task_notification` → the terminal state (`completed`, `failed` or `stopped`), final `usage`
     and `summary`.
   - Hang the row under the parent's Agent tool card via `tool_use_id`.
2. **Route messages with `parent_tool_use_id` to that row** instead of dropping them, as
   `translate.go:12` does today: tool_use, tool_result and text lines. For each assistant `usage`,
   show `input + cache_creation + cache_read` as the live context fill, against the
   `contextWindow` of the subagent's model from `modelUsage`. Ignore its `output_tokens`.
3. **Background agents:**
   - Keep the process alive while `background_tasks_changed` lists any task; don't let the 3 s
     kill in `Close` run while it does.
   - Accept unrequested turns: `system/init` → … → `result` with no user message.
   - Warn that the Stop button (`interrupt`) also kills background agents.
   - Offer a per-agent stop button that sends `stop_task`, and optionally a "send to background"
     button that sends `background_tasks`.
4. **After the fact, or on reopen:** read `~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`
   and `.meta.json` for the full transcript with exact per-message usage. The main transcript
   links the two through `toolUseResult.agentId`.
5. **Permission cards:** show "subagent <description>" when `can_use_tool` has `agent_id`.

## Gaps

- No token-level streaming of subagent text; whole messages only.
- Stdout `output_tokens` on subagent messages is a first-chunk snapshot. Exact values are only in
  the sidechain file and the final totals.
- No per-subagent `get_context_usage`.
- Background agents die with the process (SIGKILL, or the app's 3 s kill). The only later signal
  is the `stopped` notification after `--resume`, which comes with an extra empty `result` line.
- `translate.go` context window: the largest `contextWindow` across models is wrong when a
  subagent uses a different model.
- The `interruptfg` and `interruptbg2` processes exited with code 1 when stdin was closed after the
  interrupt (stderr empty). The `stop*`, `bg` and `closebg` runs exited 0. This was not
  investigated.
- Not tested: nested subagents (`spawn_depth` > 1), agent teams and SendMessage continuation, and
  the `agentProgressSummaries` option that fills `task_progress.summary` (schema only).
- Side note: `init.permissionMode` reports `"default"` although the app passes
  `--permission-mode auto`. Subagent Bash commands such as `python3 -c …` and `mkdir` still reached
  the host as `can_use_tool`.

## Decisions (2026-09-25)

- **Stop means stop all.** For now the Stop button keeps sending `interrupt`, which stops the parent and
  every running subagent, background ones included. A per-subagent stop (`stop_task`) can come later.
- **Subagent state must stay correct after Stop.** `Manager.Stop` bumps `c.gen` and drops the
  process (`internal/chats/manager.go:821-824`), so `pump` discards the process's later events
  (`manager.go:457`), including the `task_notification` `stopped` lines for its subagents. When
  subagents are tracked, `Stop` (and `Shutdown`, and a crashed or killed process) must mark every
  subagent still `running` as stopped itself, not wait for events that are never delivered.
