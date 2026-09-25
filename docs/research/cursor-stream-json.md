# cursor-stream-json: driving Cursor with print-mode `stream-json` instead of ACP

- **Question:** How do we drive the Cursor agent CLI (`agent`, v2026.09.23-86fc751) with
  `-p --output-format stream-json` instead of `agent acp`, behind the app's `agent.Agent` interface
  (`internal/agent/agent.go`)? It is settled when running code shows how each thing the Cursor adapter
  does today maps to print mode: multi-turn, streaming events, tool calls, permissions, interrupt,
  context meter, model choice, isolation and concurrency. It is also settled when the code shows what
  cannot be done.
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-stream-json` at `.worktrees/cursor-stream-json`
- **Builds on:** `cursor-rpc.md` (ACP vs print mode, first pass) and `cursor-context-usage.md`
  (reading the session store).

## TL;DR

Print mode works as a backend if you run **one process per turn** and chain the turns with
`--resume <session_id>`:

```
agent -p --output-format stream-json --stream-partial-output --trust \
      --model <id> [--force] [--resume <session_id>]        # prompt on stdin
```

- **Session id:** the first turn has no `--resume`. Its `system/init` event returns a
  `session_id`, and you pass that id to every later turn. `create-chat` is not needed, and it
  hangs anyway (see Gotchas).
- **Streaming:** text deltas, thinking deltas, tool start and tool result, and a final `result`
  with per-turn token `usage` all arrive as JSON lines on stdout.
- **Context meter:** the same `store.db` format as ACP, at a different path:
  `$CURSOR_CONFIG_DIR/chats/<md5(cwd)>/<session_id>/store.db`. It also updates during the turn.
- **Stop button:** kill the process with SIGINT or SIGTERM. It exits at once (130 or 143) with no
  `result` event. **The interrupted turn is lost from the chat.** The next `--resume` does not know
  about the interrupted prompt or its partial answer.
- **Permissions:** decided before the turn, with no way to ask mid-turn. A command outside the
  allowlist comes back as `rejected` straight away. `--force` runs it, and `deny` in
  `.cursor/cli.json` still blocks it. The only non-blocking option in between is `--auto-review`,
  a server classifier.

**What print mode loses compared with ACP:**
1. No `EvPermRequest` / `Decide`: a tool call cannot be approved from the browser.
2. **Each turn pays about 3.5 s of startup before `system/init`** (5–8 s to the first text delta),
   against about 1.5–3.4 s time to first token on a warm ACP session.
3. An interrupted turn is not saved.
4. Turns on one chat must be serialized, since a second process on the same chat fails at once.

**What it gains:**
1. Per-turn billing `usage` (input, output and cache tokens), which ACP never gives.
2. A much simpler protocol: no handshake, no JSON-RPC ids, no `session/load` replay to filter.
3. A crash only loses the current turn, never a long-lived process.
4. The bracket model syntax (`gpt-5.4-mini[reasoning=low]`) works directly on `--model`.

## What was tried (all on branch `cursor-stream-json`)

1. `ccab07c` Added `cmd/streamprobe`, a Go driver for one process per turn. It logs every stdout
   line with a millisecond offset, times `init`, first text and the whole turn, and reads the chat
   store's token details. Scenarios: `hello`, `multiturn`, `stdin`, `tools`, `shape`, `perm`,
   `interrupt`, `ctx`, `model`, `concurrent`, `acpresume`.
2. `71b4ca3` Added the `redirect` scenario to track down shell `spawnError`s. The cause was the
   model inventing a nonexistent `workingDirectory` (see Gotchas); print mode itself was fine.
3. Used `cmd/acpprobe` from the `cursor-rpc` branch to make an ACP session, then tried
   `--resume` on it from print mode.

To run: `go build -o bin/streamprobe ./cmd/streamprobe` and then
`bin/streamprobe -work <dir> -cfg <isolated CURSOR_CONFIG_DIR> -s <scenario>` (`-model ''` means
don't pass `--model`). Each turn's raw lines go to `<work>/<scenario>-<turn>.jsonl`.

## Answers, with evidence

### 1. Multi-turn: `--resume <session_id>`, one process per turn

`multiturn` on model `gpt-5.4-mini-medium`:
```
t1 (no --resume)       session=32143814-…  init=3582ms firstText=8138ms total=8752ms  "ok"
t2 --resume 32143814…  session=32143814-…  init=3477ms firstText=5157ms total=5819ms  "TEAL-BADGER-7"
t3 --resume 32143814…  session=32143814-…  init=12331ms firstText=14373ms total=15007ms "7-BADGER-TEAL"
same session id across turns: true
```
You never need `agent create-chat`. The first turn's `system/init` event carries the new
`session_id`, and the id stays the same across turns. **The prompt can go on stdin.** With no
prompt argument, `-p` reads stdin: "STDIN-OK" came back. A prompt of about 360 KB worked both as an
argument and on stdin ("BIG-ARGV-OK", about 72k input tokens). Use stdin anyway, since argv is
limited to about 1 MB on macOS and the prompt would show up in `ps`.

### 2. Stream events and how they map to `agent.Event`

These are the lines seen, in order (`--stream-partial-output` is needed for deltas):

| line | meaning | maps to |
|---|---|---|
| `{"type":"system","subtype":"init","session_id","model":"GPT-5.4 Mini Medium","permissionMode","cwd","apiKeySource"}` | process ready; after about 3.5 s | `EvSession` (first turn), `EvThinking` |
| `{"type":"user","message":{…}}` | echo of the prompt | ignore |
| `{"type":"thinking","subtype":"delta","text"}` / `"completed"` | reasoning deltas | `EvThinking` |
| `{"type":"assistant","message":{"content":[{"type":"text","text"}]},"timestamp_ms":…}` | **a text delta** | `EvTextStart` / `EvTextDelta` |
| `{"type":"assistant",…,"model_call_id":…,"timestamp_ms":…}` | the text segment so far, **sent again** before a tool call | ignore |
| `{"type":"assistant",…}` with **no** `timestamp_ms` | the whole reply, **sent again** at the end | ignore |
| `{"type":"tool_call","subtype":"started","call_id","tool_call":{"<kind>ToolCall":{"args":…}}}` | tool start | `EvToolStart` + `EvToolInput` |
| `{"type":"tool_call","subtype":"completed","call_id","tool_call":{"<kind>ToolCall":{"args","result":{…}}}}` | tool result | `EvToolResult` / `EvToolDenied` |
| `{"type":"connection","subtype":"reconnecting"/"reconnected"}`, `{"type":"retry","subtype":"starting"}` | network retries (seen once) | ignore, or show "reconnecting" |
| `{"type":"result","subtype":"success","result","duration_ms","is_error","usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens},"request_id"}` | end of turn | `EvTurnEnd` |
| process exit | | `EvExit` after each turn; the adapter must hide this from the chat manager |

**Delta rule (checked):** treat an `assistant` line as a delta only when it has `timestamp_ms` and
no `model_call_id`. With that rule, the concatenated deltas equal `result.result` exactly in every
run (`result.result==text: true`). The first version of the probe also counted the final line with
no `timestamp_ms`, and every reply came out twice (`"ok\n-- BoardBotok\n-- BoardBot"`).

**Text segments around tools are not separated.** One turn gave `"Checking the folder.There are 6
entries."`, text before and after an `ls`. After each tool call the adapter must start a new text
item (`EvTextStart` with a new `MsgID`) instead of appending to the old one.

**Tool kinds seen** (`tools` scenario, all with `result.success` or `result.error`):
- `readToolCall {args:{path}} → {content,totalLines,…}`
- `globToolCall {args:{globPattern,targetDirectory}} → {files,totalFiles}`
- `grepToolCall {args:{pattern,path,outputMode,…}} → {workspaceResults}`
- `editToolCall {args:{path}} → {diffString,afterFullFileContent,beforeFullFileContent,linesAdded,linesRemoved}`.
  This one is used for both creating and editing a file.
- `shellToolCall {args:{command,workingDirectory,timeout,simpleCommands,parsingResult,…}} → one of:`
  - `success{exitCode,stdout,stderr}`
  - `failure{…}` (non-zero exit)
  - `rejected{command,reason}` (not approved)
  - `permissionDenied{command,error}` (a `deny` rule)
  - `spawnError{error}`

`tool_call.toolCallId` holds the same id plus `\n` and a suffix. Use `call_id`.

### 3. Permissions: set before the turn, no routing

The `perm` scenario ran with `approvalMode: "allowlist"` in the config dir. The command was
`echo PERMTEST > perm.txt && cat perm.txt`:

| run | tool result | file written |
|---|---|---|
| no flag, no allowlist | `rejected` (twice; the agent gave up) | no |
| `--force` | `success` | `PERMTEST` |
| `--auto-review` | `success` (the classifier allowed it, with no prompt) | `PERMTEST` |
| `.cursor/cli.json` `{"allow":["Shell(echo)","Shell(cat)"],"deny":[]}`, no flag | `success` | `PERMTEST` |
| `--force` + `.cursor/cli.json` `{"deny":["Shell(cat)"]}` | `permissionDenied` "Command blocked by permissions configuration" | no |

Nothing ever blocks waiting for approval, and print mode has no way to ask. **The config dir's
`approvalMode` wins over everything.** The user's `cli-config.json` has `"approvalMode":
"unrestricted"`, and under it every command ran even without `--force`. So a config dir seeded
from the user's config must have `approvalMode` set explicitly to `"allowlist"`, or `"unrestricted"`
if you want to run everything. Not tested: what `--auto-review` does in print mode when the
classifier wants to ask.

For the app: `Decide` becomes a no-op. The approval choice moves into the chat settings (allowlist,
auto-review or run everything), and `rejected`/`permissionDenied` results show up as `EvToolDenied`.

### 4. Interrupt: kill the process; the turn is lost

The `interrupt` scenario: signal 2 s after the first text delta of a long story, then `--resume`
and ask about it.
```
long-interrupt  +9863ms SIGINT  → exit 130 at 9880ms, stderr "Aborting operation...", no result event
after-interrupt "What codeword did I give you, and how many paragraphs of the baker story…?" → "ORCA-interrupt; 0"
long-terminated +7753ms SIGTERM → exit 143 at 7768ms, no result event
after-terminated → "`ORCA-terminated`; `0` paragraphs."
```
Both signals stop the turn within about 15 ms, and the chat keeps working. But the interrupted
turn is **not saved**: the next turn remembers the turn before it, but knows nothing of the
interrupted prompt or its partial answer. ACP `session/cancel` keeps the turn. If the app wants to
keep that context, it has to add the partial text to the next prompt itself. The adapter should
send `EvTurnEnd{Aborted:true}` itself when it kills the process.

### 5. Context meter: same store format, different path

```
$CURSOR_CONFIG_DIR/chats/<md5(cwd)>/<session_id>/store.db        (~/.cursor/chats/… when unset)
   meta.json: {"schemaVersion":1,"createdAtMs","hasConversation":true,"updatedAtMs","cwd"}
```
`<md5(cwd)>` is the hex MD5 of the absolute workspace path. It checked out for both workspaces I
tried. Globbing `chats/*/<session_id>/store.db` also works. The decoder from `cursor-context-usage.md`
(`meta` key `0` → `latestRootBlobId` → field 5 `used_tokens`/`max_tokens`) reads it unchanged:
```
t1 "Say hi"           used=12791 max=272000
t2 + filler           used=24858 max=272000
t3 two shell calls, polled every 300 ms: 24858 → 25063 (+10.7s) → 25207 → 25283
```
So `EvUsage` keeps working: poll the new path during the turn and read it once more on `result`.
Print mode also gives `result.usage` per turn (billing tokens, not context).

### 6. Model: `--model` takes both syntaxes, and still writes the config

- `gpt-5.4-mini-low` → init `"GPT-5.4 Mini Low"`, and `gpt-5.4-mini[reasoning=low]` → `"GPT-5.4 Mini Low"`.
  The bracket syntax that ACP uses works here too, as `--help` says.
- `not-a-model` exits with code 1 before `init`, with stderr
  `Cannot use this model: not-a-model. Available models: auto, …`.
- **`--model` still writes the selected model into `$CURSOR_CONFIG_DIR/cli-config.json`**
  (`gpt-5.4-mini` → `gpt-5.4-nano`). Keep using an isolated config dir. With no `--model`, only the
  `privacyCache.updatedAt` timestamp changed in the global config.
- The catalog comes from `agent --list-models` (about 1.1 s, plain text: `id - Display Name`). This
  replaces the catalog that ACP's `session/new` returned.

### 7. Isolation and concurrency

- `cwd` is the workspace. The `AGENTS.md` in it was followed on every turn: every reply ended
  "-- BoardBot".
- Two chats in different directories ran at the same time: "I am workspace A…" and
  "I am workspace B…", both done in 9.4 s.
- **Two turns on the same chat at the same time:** the second exits with code 1 after 347 ms:
  `Chat 77b9863c-… may still be running, but Cursor could not verify its persistent session:
  Persistent chat ownership is currently changing for …`. The adapter must queue turns per chat;
  the app already allows only one turn at a time.
- `--resume <ACP sessionId>` does **not** load an ACP session. It started an empty chat with that
  id under `chats/`, and the agent went looking for transcripts. ACP (`acp-sessions/`) and print
  mode (`chats/`) are separate stores, so switching backends means existing Cursor chats lose their
  history.

## Gotchas

1. **`agent create-chat` prints an id and then does not exit.** It sat there for over 2 minutes
   until killed, and it writes nothing to disk. Don't use it; take `session_id` from `system/init`.
2. Only an `assistant` line with `timestamp_ms` and no `model_call_id` is a delta. The other two
   `assistant` shapes repeat text you already have.
3. There is no separator between text segments on either side of a tool call.
4. A process exits after every turn. `EvExit` from the Cursor adapter now means "turn process
   ended", so the adapter must not pass it to the chat manager as "agent died".
5. **Detached `worker-server` processes.** Each print-mode run starts
   `index.js worker-server` for its workspace (parent pid 1, about 200 MB RSS, socket at
   `~/.cursor/projects/<slug>/worker.sock`). It outlives the turn, gets reused by later turns in the
   same workspace, and exits after some minutes idle (workers older than about 5 minutes were gone).
   With many chats that means many workers; don't kill them per turn, because they are shared.
6. **`spawnError` "The shell command returned no exit status"** came from the model passing a
   `workingDirectory` that does not exist. It rewrote `…/ai-whiteboard/996c8536…` as
   `…/ai-whiteboard-996c8536…`, copying Cursor's `~/.cursor/projects/<slug>` naming. The debug log
   (`$TMPDIR/cursor-agent-logs-<uid>/session-*.log`) shows `spawn /bin/zsh ENOENT`. It only happened in
   workspaces under a long, hyphen-heavy path; under `.worktrees/cursor-stream-json/.probe/*` every
   shell call worked. Keep chat workspace paths short and plain. The same thing could happen under
   ACP; it is not specific to print mode.
7. The global `approvalMode: "unrestricted"` makes every permission test pass. Set `approvalMode`
   explicitly in the server's config dir.
8. About 3.5 s of every turn goes to startup (`startup.metrics` in the debug log: server config,
   model manager init, and about 1.3 s unaccounted). Once it took 12 s.

## Recommended adapter design (if switching from ACP)

- **Per chat:** keep `sessionID`; empty until the first turn's `system/init`. `Spawn` starts nothing
  and returns an agent object. `Send` starts
  `agent -p --output-format stream-json --stream-partial-output --trust --model <id> [--resume <sid>] <permission flag>`
  with `cmd.Dir = chat cwd`, `CURSOR_CONFIG_DIR=<app config dir>` (with `approvalMode` set), and the
  prompt on stdin. The ContentBlocks are joined as text: `<ui-context>…</ui-context>` + the message.
- **Events:** map them as in the table in section 2. Start a new text item after each
  `tool_call/completed`. `result` → `EvUsage` (billing) + `EvTurnEnd`. A non-zero exit with no
  `result` → `EvTurnEnd{Error: stderr}`. Only `Close` produces a real `EvExit`.
- **Interrupt:** SIGINT the turn process and send `EvTurnEnd{Aborted:true}`. Optionally keep the
  partial text and add it to the next prompt.
- **Decide:** no-op. Permissions become a per-chat setting, mapped to `--force`, `--auto-review`,
  or an allowlist in `<cwd>/.cursor/cli.json` (for example `Shell(curl)` for the board API).
- **Context meter:** read `$CURSOR_CONFIG_DIR/chats/<md5(cwd)>/<sid>/store.db` with the existing
  decoder.
- **Catalog:** parse `agent --list-models` once at startup.
- **Queue turns per chat**, since running two at once on one chat fails.
- **Migration:** existing ACP chats cannot be resumed in print mode. Either keep ACP for them or
  start them fresh.

**Overall:** print mode is workable and simpler, but it gives up approval routing, keeping
interrupted turns, and about 2–4 s of latency per turn. Choose it if losing browser approvals is
acceptable, for example if board edits go through an allowlisted `curl` and everything else runs
under `--auto-review` or `--force`.
