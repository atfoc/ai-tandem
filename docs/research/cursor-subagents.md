# cursor-subagents: what the Go server can see of Cursor subagents

- **Question:** When a Cursor agent run the way this app runs it (`cursor-agent acp`, JSON-RPC over
  stdio, see `internal/cursor/cursor.go`) spawns subagents, what can the Go server read to show that
  work in the UI? For each subagent: (1) spawn + link to parent, (2) lifecycle state for foreground
  and background runs, (3) context usage, (4) transcript, (5) model, duration, cancel. It is settled
  when every cell of the data × source table is marked from a real run.
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-subagents` at `.worktrees/cursor-subagents` (evidence in
  `evidence/`, harness in `cmd/subprobe`, helpers in `scripts/`).
- **CLI version:** `cursor-agent` 2026.09.23-86fc751. Model for all runs: `gpt-5.4-mini[reasoning=medium]`
  (one custom agent on `claude-haiku-4-5`). Isolated `CURSOR_CONFIG_DIR=/tmp/subprobe/cfg` (a copy of
  `~/.cursor/cli-config.json`) so model switches did not touch the user's config.

## TL;DR

**Subagents work in ACP out of the box.** The model has a built-in Task tool (`Subagent` internally).
It runs foreground and background subagents, several in parallel, and custom subagents from
`.cursor/agents/*.md`. How much the client sees depends on **one initialize flag**:

- **As the app runs it today** (`clientCapabilities` without subagents): the parent stream shows
  **only the Task tool call** (`tool_call` `title:"Task: <description>"`, `rawInput{prompt,description,subagentType}`,
  then `completed` with `rawOutput{durationMs,isBackground}`) and a `cursor/task` **request** from the
  agent. Nothing from inside the child is streamed. A background child keeps running silently after
  the turn ends.
- **With `clientCapabilities._meta.subagents = true`** (a plain `clientCapabilities.subagents` is
  stripped by the SDK and does nothing): the agent advertises `sessionCapabilities.subagents:{}` and
  sends `subagent_spawned` / `subagent_state_update` on the parent session, plus the child's **own
  full `session/update` stream** (text, thoughts, tool calls, tool results) under
  `sessionId = subagentSessionId`. States seen: `completed`, `cancelled`. **But the parent's
  `session/prompt` then does not return until every background child has finished** (plus an
  automatic follow-up turn), and a new prompt or `session/cancel` kills the background children.

**Context usage and after-the-fact transcripts come from disk in both modes.** Each child has its
own store at `$CURSOR_CONFIG_DIR/chats/<md5(realpath cwd)>/<childAgentId>/store.db` (default
`~/.cursor/chats/…`). Its `meta` names the parent (`subagentInfo.parentAgentId`, `toolCallId`,
`typeName`). `token_details` decodes with the existing `ctxusage.go` code and updates after every
model step. Message blobs are plaintext JSON, so the transcript can be read live at step granularity.

A single child **cannot be cancelled**: `session/cancel` with its `subagentSessionId` is ignored.
**Hooks don't help**: none fire under ACP, and `subagentStart` / `subagentStop` did not fire even
in print mode.

## What was tried (one line per attempt, all on branch `cursor-subagents`)

1. `0da90ef` Added `cmd/subprobe` (the app's exact handshake and a raw line logger with ms offsets;
   it scans every `store.db` under the config dir each second). Run 01, app caps, foreground: Task tool works, child store in `chats/`, `cursor/task` request.
2. `cafb43f` Run 02 `clientCapabilities.subagents:{}`: no effect (not advertised back). Run 03 `_meta.subagents:true`: `subagent_spawned`, child stream, `subagent_state_update completed`.
3. `a223bda` Run 04 `_meta` + background child: the prompt response is held until the child ends, then a follow-up turn runs.
4. `8866006` Run 05 app caps + background: the turn ends at once and the child is visible only on disk. Run 06: parallel foreground + background.
   Runs 07–09: hooks in `<cwd>/.cursor/hooks.json`, `~/.cursor/projects/<slug>/.cursor/hooks.json`, and with a fake `$HOME` (which breaks auth). None fired under ACP.
   Run 10: print-mode `stream-json` comparison with hooks and `agent-transcripts`.
5. `04c39c8` Run 11: `session/cancel` on the child id is ignored. Run 12: cancelling the parent cascades to a foreground child (`cancelled`).
   Run 13: cancelling the parent kills a background child (`_meta`). Run 14: under app caps, `session/cancel` after the turn does **not** stop the background child.
6. `e949980` Run 15: a second `session/prompt` while one is held cancels it and the background child. Run 16: `session/load` replays spawned and state only.
   Run 17: custom `.cursor/agents` (haiku model, and a nonexistent model).
7. `0103292` Run 18: snapshots of the child transcript taken from `store.db` while it ran. Run 19: a subagent ran a command outside the workspace, and no permission request came.

To run: `go build -o bin/subprobe ./cmd/subprobe`, then
`bin/subprobe -work <dir> -cfg <cfgdir> -caps none|meta -model '<id>' -p '<prompt>' [-linger 60s] [-cancel-parent 15s] [-cancel-child 5s] [-p2-after 14s -p2 '<prompt>'] [-load <sessionId>] -log evidence/<n>.log`.
`python3 scripts/summarize.py <log>` merges the chunks. `python3 scripts/transcript.py <store.db>`
prints a store's transcript in order.

## Answers, with evidence

### 0. Does it support subagents, and how are they triggered?

Yes. Asking for "the Task tool" is enough. The parent model calls its built-in `Subagent` tool,
and ACP presents it as `taskToolCall`. The arguments come from the protobuf `TaskToolCallArgs`:
`description, prompt, model?, subagent_type, resume?, readonly?, run_in_background?, …, interrupt?`.
`subagentType` shows up as `{"unspecified":{}}` for the built-in general-purpose agent. On disk it
is `typeName:"generalPurpose"`. A custom agent shows up as `{"custom":{"name":"file-counter"}}`.
Custom agents come from `<cwd>/.cursor/agents/<name>.md` (front matter `name`, `description`,
`model`). The file-counter one really ran on Claude Haiku: its tool ids were `toolu_…`, its window
was `max=200000`, and `cursor/task` reported `"model":"claude-4.5-haiku-thinking"`. A custom agent
with `model: no-such-model-xyz` quietly fell back to the parent's model and completed (run 17).
Two Task calls in one message run in parallel (runs 06, 17). There is no subagent flag or
subcommand in `--help`. The ACP gate is `(0,B.i7)(clientCapabilities)` in `7465.index.js`, which
checks `caps.subagents || caps._meta.subagents`. The SDK's schema drops the unknown top-level key,
so only `_meta` gets through.

### 1. Spawn and link to the parent

**App caps (run 01/05/06):** the parent `tool_call` is the only live signal:
```json
{"sessionUpdate":"tool_call","toolCallId":"call_7Mg…\nfc_02e…","title":"Task: count files","kind":"other","status":"pending",
 "rawInput":{"_toolName":"task","prompt":"…","description":"count files","subagentType":{"unspecified":{}}}}
```
When the tool completes, the agent also sends a JSON-RPC **request** that the app answers today
with "method not found", which is harmless:
```json
{"jsonrpc":"2.0","id":0,"method":"cursor/task","params":{"toolCallId":"call_7Mg…","description":"count files","prompt":"…",
 "subagentType":{"custom":{"unspecified":{}}},"model":"gpt-5.4-mini-medium","agentId":"5b886cff-…","durationMs":7627}}
```
⚠ `cursor/task.agentId` is **not** the child's id. It comes from the tool *args* and never matched
the child store or `subagentSessionId` in any run. The real child id is on disk: a new
`chats/<md5(cwd)>/<id>/store.db` appears about 1 s after the tool call, and its `meta` holds the link.
```json
{"agentId":"5139d3d6-…","name":"New Agent","createdAt":1790346788878,
 "subagentInfo":{"parentAgentId":"02447319-…(= ACP sessionId)","rootParentAgentId":"02447319-…",
                 "toolCallId":"call_7Mg…\nfc_02e…(= parent tool_call id)","typeName":"generalPurpose"}}
```
The id also appears in the parent transcript's tool result: `"Agent ID: b0ce4635-… (can be used
with the resume parameter …)"`.

**`_meta.subagents` (run 03):** the link arrives 10–30 ms after the parent `tool_call`:
```json
{"sessionUpdate":"subagent_spawned","subagentSessionId":"b0ce4635-…","name":"generalPurpose",
 "task":"Run `ls` in the current directory, then read `a.txt`, …","capabilities":{},
 "_meta":{"cursor":{"toolCallId":"call_jMH…\nfc_0d0…","agentId":"b0ce4635-…","model":"gpt-5.4-mini-medium"}}}
```
`subagentSessionId` equals `_meta.cursor.agentId`, which equals the on-disk child id. `task` is the
full prompt; the description is only in the parent `tool_call`.

### 2. Lifecycle state

| case | app caps (today) | `_meta.subagents` |
|---|---|---|
| foreground | parent `tool_call` `in_progress` → `completed` (`isBackground:false`) brackets the whole run | `subagent_spawned` … `subagent_state_update {"state":"completed"}` 130 ms before the parent `tool_call` completes |
| background | `tool_call` completes after about 130 ms with `{"isBackground":true}`; **the turn ends and the child runs on silently** (run 05: store kept updating until +35 s, parent turn ended at +9 s). No end signal. | `completed` arrives when the child ends. **`session/prompt` is held** until then (run 04: 39 s instead of about 9 s), and then the agent runs a follow-up turn in the same prompt ("The background job finished…") |
| cancel parent | a foreground child is cancelled with the turn. **A background child survives** `session/cancel` after the turn (run 14: finished at +44 s) | `session/cancel` → `{"state":"cancelled"}` at once for foreground (run 12) and background (run 13) children, then `stopReason:"cancelled"` |
| new prompt while held | n/a | run 15: the new `session/prompt` cancels the held turn (`stopReason:"cancelled"`) **and** the background child (`cancelled`) |
| failed | not seen | code maps `status:"error"`→`failed`, and a cancel-cascade timeout gives `disconnected`. Not triggered: a bad model fell back and succeeded |

Neither mode reports a "running" state beyond spawn. Treat spawn to terminal as running. The child's
`agent_message_chunk` and `tool_call` updates are the heartbeat under `_meta`, and store changes
are the heartbeat on disk. Under app caps the disk shows **no reliable "done" marker** for a
background child. The last message becomes an assistant text with no tool call and the store stops
changing. That is only a heuristic.

### 3. Context usage

The existing `ctxusage.go` decoder works unchanged on the child store (run 01 onward, polled every
1 s). A child starts at about 14k tokens, since it has its own system prompt without the parent's
history:
```
+009082ms STORE chats/6895…/b0ce4635…/store.db  (meta only, no root blob yet)
+014068ms STORE chats/6895…/b0ce4635…/store.db  used=14324 max=272000
+017070ms STORE chats/6895…/b0ce4635…/store.db  used=14448 max=272000   (final)
+017049ms STORE acp-sessions/a8f0…/store.db      used=16105 max=272000   (parent)
```
`max` is the child's real model window: 200000 for the Haiku custom agent against 272000 for the
parent (run 17). ACP never carries child usage, in either mode. The store updates after every model
step, so polling gives a near-live meter (run 18). The store exists about 1 s after spawn but has
no `latestRootBlobId` until the first step, so show "starting" until then. Confirmed:
`CURSOR_CONFIG_DIR` relocates both `acp-sessions/` and `chats/`.

### 4. Transcript

- **Live, `_meta` only.** The child's updates arrive as ordinary `session/update`s whose
  `params.sessionId` is the `subagentSessionId`, in the same shapes as the parent's:
  ```json
  {"sessionId":"b0ce4635-…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"There are 2 files…"}}}
  {"sessionId":"b0ce4635-…","update":{"sessionUpdate":"tool_call","toolCallId":"call_v6p…","title":"`ls`","kind":"execute","status":"pending","rawInput":{"command":"ls"}}}
  {"sessionId":"b0ce4635-…","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_v6p…","status":"completed","rawOutput":{"exitCode":0,"stdout":"a.txt\nb.txt\n","stderr":""}}}
  ```
  ⚠ Today `proc.onUpdate` ignores `sessionId`. Turning on `_meta.subagents` without routing by
  `sessionId` would mix the child's text and tools into the parent's chat.
- **From disk, both modes, live at step granularity and after the fact.** The root blob's repeated
  field 1 holds the ordered 32-byte ids of message blobs. Each message blob is plaintext JSON
  `{"role":"system|user|assistant|tool","content":[…]}`, with `reasoning`, `text`, `tool-call` and
  `tool-result` parts (`scripts/transcript.py`). In run 18 a snapshot every 5 s showed the
  assistant and tool-result pair of step A at +25 s, step B at +35 s and the final text at +40 s.
  An in-flight tool call appears only after its result is written, not while it runs.
- **Parent-side result text:** the parent's `rawOutput` has **no** result text. The child's
  final answer is in the parent store's tool result (`"This is the output of the subagent: … Agent ID: …"`).
- **Replay:** `session/load` under `_meta` replays `subagent_spawned` and `subagent_state_update`
  for past children, but with a synthetic `toolCallId:"replay-0-1"`, `name:"general-purpose"`
  and `task` = description. It does not replay the child's transcript (run 16), so use the child's
  store for that.

### 5. Model, duration, cancel, permissions, hooks

- **Model:** `subagent_spawned._meta.cursor.model` is **wrong for custom agents**. It said
  `gpt-5.4-mini` (the parent's) for the Haiku agent, while `cursor/task.model` said
  `claude-4.5-haiku-thinking`, which was right. Under app caps only `cursor/task.model` exists.
  The store's `max_tokens` also reflects the real window.
- **Duration:** `tool_call_update.rawOutput.durationMs` and `cursor/task.durationMs` give the full
  run time for foreground children, but only the launch time for background ones (127 ms). For a
  background child, measure spawn to `subagent_state_update`, or use the store's `createdAt` to its
  last write.
- **Cancel a single subagent:** not possible. `session/cancel {sessionId: subagentSessionId}` had
  no effect (run 11: the child ran on and `completed` 28 s later). The only lever is cancelling the
  parent, which cancels all of its children under `_meta`.
- **Permissions inside a subagent:** not observed. No `session/request_permission` came in any
  run, including a subagent writing to `$HOME` (run 19); this account's settings auto-run commands.
- **Hooks:** under ACP no hook fired from `<cwd>/.cursor/hooks.json` or
  `~/.cursor/projects/<slug>/.cursor/hooks.json` (runs 07–08). In print mode the project hooks file
  fired `postToolUse` for the children's tools, but `subagentStart`, `subagentStop` and `stop`
  **did not fire** (run 10). Not usable.

### Print-mode `stream-json` comparison (run 10)

The parent emits `tool_call` `started`/`completed` with `taskToolCall`. The completed result carries
the real child `agentId`, `isBackground`, `durationMs` and the child's final text
(`conversationSteps[].assistantMessage.text`). For a background child, a
`{"type":"system","subtype":"task_notification","task_id":"<childAgentId>","status":"success","title":…,"detail":"<final text>"}`
line arrives when it finishes, and the process waits for it and a follow-up. Nothing streams from
inside the child. Print mode also writes `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`
for the parent and each child. ACP writes none.

## Data × source table

✅ = confirmed in a run, ❌ = not available (checked), ~ = partial.

| data | ACP, app caps (today) | ACP + `_meta.subagents` | child `store.db` on disk | print `stream-json` | hooks |
|---|---|---|---|---|---|
| spawned + parent tool call id | ✅ parent `tool_call` (`Task: …`) | ✅ `subagent_spawned` + `_meta.cursor.toolCallId` | ✅ `meta.subagentInfo.{parentAgentId,toolCallId}` (about 1 s later) | ✅ `taskToolCall` started | ❌ |
| child id | ❌ (`cursor/task.agentId` is not it) | ✅ `subagentSessionId` | ✅ dir name / `meta.agentId` | ✅ completed `result.agentId` | ❌ |
| subagent type | ✅ `rawInput.subagentType` | ✅ `name` | ✅ `typeName` | ✅ | ❌ |
| description / prompt | ✅ `rawInput` | ~ `task` = prompt only | ✅ first user message | ✅ | ❌ |
| state, foreground | ~ tool_call bracket | ✅ completed / cancelled | ~ heuristic | ✅ | ❌ |
| state, background after the turn | ❌ | ✅ but the turn is held until it ends | ~ heuristic, still runs | ✅ `task_notification` | ❌ |
| failed | ❌ not seen | ~ in code, not triggered | ❌ | ❌ not seen | ❌ |
| context usage, live | ❌ | ❌ | ✅ `token_details` per step | ❌ | ❌ |
| context usage, final | ❌ | ❌ | ✅ | ❌ (parent `usage` only) | ❌ |
| transcript, live | ❌ | ✅ full child `session/update` stream | ✅ step granularity | ❌ | ❌ (`postToolUse` in print only) |
| transcript, after the fact | ❌ (final text only in parent store) | ~ replay has spawned/state only | ✅ | ✅ final text + agent-transcripts | ❌ |
| model | ✅ `cursor/task.model` | ~ `_meta.cursor.model` (wrong for custom) + `cursor/task` | ~ `max_tokens` implies window | ✅ args.model | ❌ |
| duration | ✅ foreground / ❌ background (`durationMs`) | ✅ timestamps spawn→state | ~ `createdAt`→last write | ✅ | ❌ |
| cancel one child | ❌ | ❌ (parent cancel only) | — | ❌ | ❌ |

## Recommendation

- **Foreground subagents: enable `_meta.subagents`.** Send
  `clientCapabilities: {…, "_meta": {"subagents": true}}` in `initialize`. Then:
  1. Route `session/update` by `params.sessionId`: the parent id feeds the main chat, and any other
     id is a child's stream.
  2. Open a subagent card on `subagent_spawned`, keyed by `subagentSessionId` and linked to the
     parent's Task `tool_call` by `_meta.cursor.toolCallId`. Take the description from that tool
     call.
  3. Close it on `subagent_state_update` (`completed` / `cancelled` / `failed` / `disconnected`).
  4. Show the child's context meter by polling
     `$CURSOR_CONFIG_DIR|~/.cursor` `/chats/<md5(realpath(cwd))>/<subagentSessionId>/store.db` with
     the existing decoder while the card is open, with one final read at the terminal state.
  5. Take the model from `cursor/task.model` (answer that request with `{}`) rather than
     `_meta.cursor.model`.
- **Background subagents: pick the trade-off on purpose.**
  - With `_meta.subagents` they are fully observable. But the user's turn stays "running" until
    they finish, and a new message cancels them. The UI must say so: keep the Stop button meaning
    "stop everything", and gate or warn on send.
  - Without it (today) they outlive the turn, and only the disk shows them. Scan
    `chats/<md5(cwd)>/*/store.db` for `meta.subagentInfo.parentAgentId == sessionId` to find
    them, poll `token_details` and transcript, and infer "done" heuristically.
  - Recommended: use `_meta.subagents`, and treat a background child as part of the running turn.
- **Transcript after reload:** read the child stores. `session/load` replay does not include the
  children's content.

## Gaps

- No way to cancel one subagent. A "failed" state was never produced.
- Under app caps there is no reliable end signal for a background child.
- The meaning of root-blob field 4 (present only mid-run in run 18) was not established.
- Subagent permission prompts could not be exercised on this account (commands auto-run).
- The disk format and the `_meta` gate are undocumented internals, so guard both.
- `cursor-agent acp` sometimes did not exit within 5 s of stdin closing and had to be killed (7 of
  19 runs, in both modes). The app's `Close` already kills after 3 s.

## Decisions (2026-09-25)

- **Stop means stop all.** For now the Stop button keeps cancelling the parent session, which cancels
  every running subagent. Cursor has no per-subagent cancel anyway.
- **Subagent state must stay correct after Stop.** Cursor goes through the same `Manager.Stop` as
  Claude: it bumps `c.gen` and drops the process (`internal/chats/manager.go:821-824`), so `pump`
  discards later events (`manager.go:457`), including the `subagent_state_update` `cancelled`
  lines. When subagents are tracked, `Stop` (and `Shutdown`, and a crashed or killed process) must
  mark every subagent still `running` as stopped itself.
