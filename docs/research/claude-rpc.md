# Driving Claude Code CLI as a long-lived RPC-like chat backend

**Question.** How should a Go program drive the Claude Code CLI (`claude` v2.1.x) as a long-lived,
RPC-like chat backend? That covers multi-turn sessions, streaming, the system prompt, calls from the
agent back into the Go server, permissions, per-turn context, interrupt/resume/concurrency, and
latency/cost.

**Mode.** No human in the loop. Running code settled every point.

**Branch / worktree.** `claude-rpc`, at `.worktrees/claude-rpc`.

**Tested against.** Claude Code 2.1.281 (`/Users/pedjat/.local/bin/claude`), Go 1.25.1, macOS,
OAuth login (no `ANTHROPIC_API_KEY`). Most runs used `--model haiku` (claude-haiku-4-5), and one
latency sample used `--model sonnet` (claude-sonnet-5).

## The harness

- `proto/claude/session.go` wraps the process (about 250 lines, stdlib only). It spawns `claude`,
  writes stream-json user messages and control requests to stdin, and reads stdout line by line into
  a channel. It answers `can_use_tool` control requests through a Go callback, matches
  `control_response` to `request_id`, and logs every stdin (`>`) and stdout (`<`) line with a
  timestamp.
- `proto/board/board.go` is a stand-in board API on `127.0.0.1:0`. It serves `GET /board` and
  `POST /board` as plain HTTP. It also serves `/mcp`, a minimal MCP server over the Streamable HTTP
  transport (JSON-RPC over POST, JSON responses only, no SSE) with the tools `get_board`,
  `add_element` and `approve`.
- `proto/cmd/harness/main.go` holds one scenario per point. Run one with
  `go run ./proto/cmd/harness -s <scenario> [-model haiku]`.
- `evidence/<scenario>.log` holds the raw transcripts and `evidence/<scenario>.summary.txt` holds
  the harness output. Both are committed.

## What was tried (one line per attempt, commit)

1. `578c381`: `multiturn` runs one process for three turns. It checks memory, event types, latency
   and cost.
2. `7fef175`: `sysprompt` compares `--system-prompt` with `--append-system-prompt`. `curl` has the
   agent call the Go HTTP API through Bash and curl. `mcp` has the agent call an MCP server hosted
   in the Go process over HTTP.
3. `a9fd909`: `perm-none` tests default and dontAsk modes with no handler. `perm-stdio` tests
   `--permission-prompt-tool stdio`. `perm-mcp` tests `--permission-prompt-tool mcp__board__approve`.
4. `1147510`: `perm-stdio -permdelay 45s` has the "human" take 45 s per approval.
5. `35703a9`: `context` sends per-turn UI context. `interrupt` interrupts a turn with a control
   request. `queue` sends a message while a turn is still running.
6. `52354ea`: `prewarm` spawns the process early. `curl-sysreplace` checks that tools still work
   with a replaced system prompt. `isolated` tests `--setting-sources ""`. `approve-hidden` checks
   that the permission tool still works when it is hidden from the model.
7. `38db91a`: a Sonnet latency sample, plus error-path probes (bad model, invalid stdin line). The
   probes are in `evidence/probes/`.
8. `resume`, `concurrent` and `coldstart` ran with commit 5's code and were committed with it.

## Answer, point by point

All 8 points worked. The **Evidence** column names the file under `evidence/`.

| # | Point | Result | Evidence |
|---|---|---|---|
| 1 | Long-lived multi-turn session | Works | `multiturn.summary.txt`: turn 3 answers `PAPAYA` from turn 1 |
| 2 | Streaming event types | Works | `*.log` (samples below) |
| 3 | Custom system prompt | Works, both flags | `sysprompt.summary.txt` |
| 4 | Agent calls back into Go | Works, both curl and HTTP MCP | `callback-curl.*`, `callback-mcp.*` |
| 5 | Non-interactive permissions and host approval | Works; nothing ever hangs | `perm-*.summary.txt` |
| 6 | Per-turn context | Works as a prefix or as a separate content block | `context.summary.txt` |
| 7 | Interrupt, resume, cwd, concurrency | Works | `interrupt.*`, `resume.*`, `concurrent.*` |
| 8 | Latency and cost | Measured | `coldstart.*`, `prewarm*.*`, results |

### 1. A long-lived session

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --model haiku --strict-mcp-config [--session-id <uuid>]
```

- Keep stdin open. Each user turn is one line on stdin:
  `{"type":"user","message":{"role":"user","content":"..."}}`. `content` can also be an array of
  content blocks.
- Every turn ends with exactly one `{"type":"result",...}` line, and that line is the "turn done"
  signal. The process then waits for the next line.
- Closing stdin makes the CLI finish and exit with code 0.
- The run sent three turns in one process: "Remember this codeword: PAPAYA" → `OK`, then "2+2" →
  `Four`, then "What was the codeword?" → `PAPAYA`.
- A message sent while a turn is still running is queued, not dropped. It gets its own turn and its
  own result (`result_index: 1`). See `queue.summary.txt`.

### 2. Streaming: which events arrive

Samples are trimmed real lines, in the order they arrive within a turn:

```jsonc
// once per turn, when the turn starts (not at spawn; nothing is printed before the first message)
{"type":"system","subtype":"init","cwd":"/…/claude-rpc-multiturn-…","session_id":"9d9c65ba-…","tools":["Bash",…],
 "mcp_servers":[{"name":"board","status":"connected","source":"dynamic"}],"model":"claude-haiku-4-5-20251001",
 "permissionMode":"default","claude_code_version":"2.1.281","capabilities":["interrupt_receipt_v1",…],…}
{"type":"system","subtype":"status","status":"requesting","session_id":"…"}
// with --include-partial-messages: raw Anthropic SSE events wrapped in stream_event
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","usage":{…}}},"parent_tool_use_id":null,…}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}},…}
{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,…}   // thinking text itself is empty
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hey"}},…}
{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_01VR…","name":"Bash","input":{}}},…}
{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"curl -s"}},…}
// complete messages (always present, with or without partials)
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01Eb…","name":"mcp__board__get_board","input":{}}],…},"parent_tool_use_id":null,…}
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01Eb…","type":"tool_result","content":[{"type":"text","text":"{\"elements\":[…],\"rev\":1}"}]}]},"tool_use_result":[…],…}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour",…}}
// permission denied (no handler, or the handler said no)
{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_016n…","message":"touch in '…/made-by-agent.txt' needs approval. …"}
// end of turn
{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"Done. The new revision number is **2**.",
 "session_id":"…","total_cost_usd":0.0159,"usage":{"input_tokens":10,"cache_read_input_tokens":…,"output_tokens":…},
 "modelUsage":{"claude-haiku-4-5-20251001":{"costUSD":…}},"duration_ms":5736,"duration_api_ms":…,"ttft_ms":1157,
 "permission_denials":[],"terminal_reason":"completed","stop_reason":"end_turn","queued_turn_count":0,"result_index":0}
```

Error cases:

- **API error** (bad model): a synthetic `assistant` message (`"model":"<synthetic>"`) carries the
  error text. It is followed by a `result` with `"subtype":"success","is_error":true,
  "terminal_reason":"api_error","api_error_status":404`. Stderr gets
  `[claude-code:unrecognized_model]`. Check `is_error` and `terminal_reason`, not `subtype`.
- **Interrupted turn:** `result` has `"subtype":"error_during_execution","is_error":true,
  "terminal_reason":"aborted_streaming"`, and its cost and usage are 0.
- **Invalid JSON on stdin:** the process exits with code 1 (`Error parsing streaming input line …
  SyntaxError` on stderr). An unknown `type` (`{"type":"bogus"}`) is ignored.

### 3. System prompt

Prompt used: *"You are BoardBot… Always end every reply with the exact token [BB]. Never mention
Claude Code."* Both flags were obeyed. The replies were "I'm BoardBot, your whiteboard assistant…
[BB]".

| Flag | Input tokens, turn 1 | Cost, turn 1 (haiku) | Keeps Claude Code's prompt |
|---|---|---|---|
| `--system-prompt` (replace) | 443 | $0.0010 | No |
| `--append-system-prompt` | about 6,645 (cache write) | $0.0138 | Yes |

- Tools still work with a replaced prompt. `curl-sysreplace` used Bash and curl under
  `--system-prompt` with no problem.
- Tool definitions are sent apart from the system prompt, so Bash, MCP tools and the rest still
  cost tokens.
- `--system-prompt-snapshot on`, which the `--help` text describes as the default, records the
  prompt on the first request and reuses it on `--resume`. **To change the prompt of an existing
  session you must pass `--system-prompt-snapshot off`.** This comes from `--help` only; no run
  tested it.

### 4. The agent calling back into the Go server

Both ways worked the first time. The agent read the board, added a `Cache` rectangle, and the Go
server saw every call.

**(a) Bash + curl**, with the API described in the prompt:

```
--append-system-prompt "…curl -s http://127.0.0.1:PORT/board … curl -s -X POST …/board -d '{…}'"
--tools Bash --allowedTools "Bash(curl *)" --permission-mode dontAsk
```

Server log: `HTTP GET /board ua="curl/8.7.1"`, then `HTTP POST /board
body={"type":"rectangle","label":"Cache"}`.

**(b) MCP over HTTP, served by the Go process itself.** No extra process is needed:

```
--mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:PORT/mcp"}}}' --strict-mcp-config
--tools "" --allowedTools "mcp__board__get_board,mcp__board__add_element" --permission-mode dontAsk
```

- The CLI connects at startup, before `init`, with `init` showing the server as `connected`. Its
  calls, in order:
  1. `server/discover`, which is unknown to us; we returned -32601 and the CLI carried on.
  2. `initialize` with `protocolVersion=2025-11-25`, where echoing the version back was enough.
  3. `notifications/initialized`, answered with 202.
  4. `GET /mcp`, answered with 405, which is fine.
  5. `tools/list`.
  6. `tools/call get_board`, then `tools/call add_element {"label":"Cache","type":"rectangle"}`.
- A stdlib-only JSON-RPC handler of about 100 lines was enough.

**MCP is the better choice** for this project, for these reasons:

- It needs no Bash, so Bash stays out of the tool list.
- The allow-list is exact (`mcp__board__add_element`), not a shell-glob rule that
  `curl … ; rm -rf` could slip around.
- Arguments are typed with a schema and checked by the model before the call.
- No curl syntax goes in the prompt.
- The UI gets clean `tool_use` events (`mcp__board__add_element {"type":…}`) to render, instead of
  opaque shell strings.
- The server knows which chat is calling if you give each chat its own URL, for example
  `/mcp/<chatID>`. A curl command gives no such identity unless the agent adds a header.

Cost was similar: curl $0.0159 vs MCP $0.0192, both for 3 model calls. Curl stays useful as a
fallback for agents without MCP. `cursor-agent` is covered in the other report.

### 5. Permissions

- **Nothing ever hung.** With `-p` and no handler, a tool that needs approval is **auto-denied**.
  The CLI emits `system/permission_denied`, the model sees an error tool_result, and the turn ends
  normally. `result.permission_denials[]` lists what was denied. This held in both `default` and
  `dontAsk` modes. `touch` inside the cwd needs approval, but read-only commands like `date` and
  `echo` are auto-allowed even in `default` mode.
- **The host can approve over stdio:** `--permission-prompt-tool stdio`. The flag is not in
  `--help`, but `--permission-prompts host` refers to it and it works. The CLI writes this to
  stdout:

  ```json
  {"type":"control_request","request_id":"1e9f…","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
   "input":{"command":"touch a.txt","description":"Create empty file a.txt"},"description":"Create empty file a.txt",
   "blocked_path":"/…/a.txt","tool_use_id":"toolu_01Gh…","permission_suggestions":[{"type":"addRules",…},{"type":"setMode","mode":"acceptEdits",…}]}}
  ```

  Go replies on stdin:

  ```json
  {"type":"control_response","response":{"subtype":"success","request_id":"1e9f…","response":{"behavior":"allow","updatedInput":{…}}}}
  {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"deny","message":"The user rejected this from the web UI…"}}}
  ```

  - Allow ran `touch`. Deny turned `rm` into an `is_error` tool_result with our message, and the
    model told the user it was rejected.
  - **The CLI waits as long as it takes.** With a 45 s delay per approval the turn took 96 s with
    no timeout, so a human can click Approve in the web UI.
  - `updatedInput` lets the host rewrite the tool input.
- **The host can also approve through its own MCP tool:** `--permission-prompt-tool
  mcp__board__approve`.
  - The CLI calls `tools/call approve {"tool_name":"Bash","input":{…},"tool_use_id":…}`, and the
    tool returns the text `{"behavior":"allow","updatedInput":{…}}` or
    `{"behavior":"deny","message":…}`. This worked the same as stdio.
  - Adding `--disallowedTools mcp__board__approve` hides the tool from the model: `init.tools` no
    longer lists it, and it still works as the prompt tool.
  - Stdio is simpler: no extra tool, and it sits on the channel you already have.
- **Allow-list anything that should not prompt:** `--allowedTools "mcp__board__get_board,…"` or
  `"Bash(curl *)"`. `--tools` limits which built-ins exist at all: `""` means none, `"Bash"` means
  Bash only. `--permission-mode dontAsk` denies anything not allow-listed without asking the host.
- `--permission-prompts none` exists and auto-denies prompts even when a host handler is set. It
  was not needed.

### 6. Per-turn context ("user is looking at page X")

Both forms work. The model used the right page each turn and remembered the history of what was
shown:

- Prefix in the text:
  `"<ui-context>active_page: arch.excalidraw; selection: [\"API\"]</ui-context>\nWhich page…"` →
  "You're looking at arch.excalidraw with the "API" component selected."
- A separate text block in the same message:
  `content: [{"type":"text","text":"<ui-context>active_page: roadmap.excalidraw…"},{"type":"text","text":"And now?"}]`
  → "roadmap.excalidraw with nothing selected."
- A later message with no tag, "which pages have I looked at?" → "arch.excalidraw and then
  roadmap.excalidraw."

Recommendation:

- Send the context as **its own first text block** in each user message, and tell the model what
  that block is in the system prompt ("written by the app, not the user; treat that page as the
  subject unless the user names another").
- The server builds the block; the UI shows only the user's text.
- Keep the block small: page id, revision, viewport, selection ids. The agent pulls the actual
  board through the MCP tool.
- No other mechanism is needed. A hook exists, but it is more machinery for the same result.

### 7. Interrupt, resume, cwd and isolation, concurrency

- **Interrupt.** Send `{"type":"control_request","request_id":"req_1","request":{"subtype":"interrupt"}}`.
  - The reply `{"type":"control_response","response":{"subtype":"success","request_id":"req_1","response":{"still_queued":[]}}}`
    came 1 ms later, and the turn's `result` (`error_during_execution` / `aborted_streaming`) came
    14 ms later.
  - **The process stays alive.** The next turn worked and knew it had been cut off ("you
    interrupted me… I'd only typed 'Marcus had been t'").
  - The partial text is kept in the conversation.
- **Resume.** Start with `--session-id <uuid>`, which you choose, so you know the id before
  anything is sent.
  - The transcript is written to `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.
  - After the process exits, a new process with `--resume <uuid>` answered `MANGO` from the
    earlier process, with the same `session_id`. It even worked from a **different cwd**.
  - `--fork-session` branches instead. `--no-session-persistence` turns saving off.
- **cwd.** `cmd.Dir` is the agent's working directory. It shows in `init.cwd`, and Bash `pwd`
  printed it.
- **Isolation.**
  - `--strict-mcp-config` drops the user's own MCP servers. Without it, the user's claude.ai
    connectors (Docs, Gmail and others) showed up in `init.tools`.
  - `--setting-sources ""` should drop user and project settings (hooks, allow rules,
    `defaultMode: auto`). The run confirmed only that the flag is accepted and that
    `permissionMode` stayed `default`; the rest comes from `--help`.
  - `--disable-slash-commands` drops skills.
  - `--bare` would drop even more, **but it needs `ANTHROPIC_API_KEY`**: OAuth and the keychain
    are never read. So it is not usable on a subscription login.
- **Concurrency.** Three processes ran at once with separate cwds and codewords (KIWI, LEMON,
  GRAPE). Each reported its own cwd and its own codeword, with no crosstalk. Each process is fully
  independent.

### 8. Latency and cost

**Latency, haiku.** In the harness, "time to first text" runs from writing the line to stdin until
the first `text_delta`.

| Situation | Time to first stdout line | Time to first text_delta | Result `ttft_ms` |
|---|---|---|---|
| Cold (spawn and send at the same moment) | about 1.1 s (boot) | 2.1 to 3.2 s | 1.0 to 2.1 s |
| Pre-spawned 4 s before the send | 12 to 20 ms | 0.9 to 1.2 s | 0.9 to 1.2 s |
| Later turn in the same process | 3 to 5 ms | 0.9 to 1.3 s | 0.9 to 1.5 s |
| Sonnet, pre-spawned | 13 ms | 0.8 to 1.5 s | 1.3 to 1.6 s |

- Process boot is about 1.1 s, and it happens before the first message arrives: nothing is printed
  until then, but pre-spawning still removes the boot time.
- **Spawn the process when the chat opens**, not when the first message is sent.
- Thinking stream events arrive about 0.5 s before the first text. Show them as a "thinking…"
  status.

**Cost.**

- **`total_cost_usd` and `modelUsage` in `result` are cumulative for the process.** In the
  multiturn run they read $0.01356, then $0.01483, then $0.01602. **`usage` is per turn.**
  - Per-turn cost is the difference between consecutive `total_cost_usd` values.
  - After `--resume`, the count starts again from 0 for the new process.
- Haiku with Claude Code's default prompt: turn 1 costs about $0.0136, almost all of it writing
  about 6.6k tokens of system prompt to the cache. Later short turns cost about $0.0012 to $0.0015.
- A tool-using turn (3 model calls) costs about $0.013 to $0.019.
- `--system-prompt` (replace) brings turn 1 down to about $0.001.
- Sonnet, trivial turn 1: about $0.025.
- An interrupted turn reports $0 even though tokens were spent. Cost figures under-count
  interrupts.
- `--max-budget-usd` exists as a hard cap for each process.

### ACP (Agent Client Protocol)

- Adapters exist:
  - `@agentclientprotocol/claude-agent-acp` v0.81.2, updated 2026-09-24. It succeeds
    `@zed-industries/claude-code-acp` / `claude-agent-acp`.
  - It is a TypeScript wrapper over the Claude Agent SDK. The SDK drives this same CLI over this
    same stream-json and control protocol.
- For us, ACP would add a Node dependency and a translation layer, and it would lose some detail:
  cost fields, `permission_suggestions`, raw stream events.
- It only pays off if one protocol for Claude **and** Cursor matters more than those costs.
- Driving `claude` directly is simple and complete, so it was not explored further.

## Gotchas

- `--verbose` is required with `-p --output-format stream-json`.
- `--include-partial-messages` is required for token deltas. Without it you only get whole
  `assistant` messages.
- `system/init` is emitted **at the start of every turn**, not once at spawn. Nothing is printed
  until the first user line arrives.
- `result.total_cost_usd` is **cumulative** for the process.
- An API error arrives as `subtype:"success"` with `is_error:true`. Branch on `is_error` and
  `terminal_reason`.
- A malformed stdin line **kills the process**. Always write with `json.Marshal` and one line per
  message.
- Stdout lines can be large (tool results, `init`). Raise the `bufio.Scanner` buffer; the harness
  uses up to 64 MB.
- Spawned agents inherit the user's `~/.claude` settings, MCP servers, skills, hooks and
  CLAUDE.md. Use `--strict-mcp-config`, `--setting-sources ""` and `--disable-slash-commands`, and
  always pass `--permission-mode` explicitly. This user has `defaultMode: auto` set globally.
- Read-only shell commands (`date`, `echo`, `pwd`) are auto-allowed even in `default` mode. Only
  commands that write or reach outside the cwd reach the permission handler. Use `--tools` to
  control which tools exist at all.
- `--permission-prompt-tool` does not appear in `--help` but works (`stdio` or `mcp__server__tool`).
- `--bare` is not usable with an OAuth or subscription login.
- An MCP tool used only as the permission tool should be hidden with `--disallowedTools`, or the
  model sees it.
- The system prompt is snapshotted per session by default (`--system-prompt-snapshot`). Keep that
  in mind when the whiteboard prompt changes and old chats are resumed.

## Recommended integration design for the Go server

1. **One `claude` process per chat, spawned when the chat is created** (pre-warm). Command line:

   ```
   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
     --model <per chat> --session-id <chatUUID>            # or --resume <chatUUID> when reopening
     --strict-mcp-config --setting-sources "" --disable-slash-commands
     --system-prompt-file <whiteboard prompt>               # or --append-system-prompt-file if Claude Code's coding persona is wanted
     --mcp-config '{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:<port>/mcp/<chatID>"}}}'
     --tools "<minimal built-ins, maybe none>"
     --allowedTools "mcp__board__*"
     --permission-mode default --permission-prompt-tool stdio
     [--max-budget-usd N]
   ```

   Set `cmd.Dir` to a per-chat or workspace dir.
2. **The board API is an MCP server inside the Go binary** (Streamable HTTP, JSON responses), with
   the chat id in the URL path. Board tools are allow-listed, so they never prompt. Anything else
   (Bash, Write) goes to the UI through `can_use_tool`, and the user clicks approve or deny. The
   answer returns as a `control_response`, and `updatedInput` can adjust the call. Keep an HTTP
   and curl form of the same API for agents without MCP.
3. **Session goroutine.** A single reader runs the stdout scanner and fans out to:
   - the UI over WebSocket: `stream_event` text and `input_json_delta` for live typing and tool
     previews; `assistant` and `user` for final blocks and tool results; `system/status`,
     `thinking_tokens` and `permission_denied` for status;
   - the control-request handler;
   - a turn tracker. A `result` ends the turn, and the tracker records `is_error`,
     `terminal_reason`, the cost difference and `ttft_ms`.

   A single writer, guarded by a mutex, writes user messages and control messages.
4. **Each user message** is a list of content blocks: first the `<ui-context>` block (active page,
   referenced `@pages`, selection, viewport, revision), then the user's text. Messages sent
   mid-turn can just be written; the CLI queues them. Or hold them in Go if the UI prefers.
5. **Stop button** sends `control_request {subtype:"interrupt"}`. The chat stays usable.
6. **Closing or reopening a chat:** close stdin, or kill the process. Reopen with `--resume
   <chatUUID>`; the transcript lives in `~/.claude/projects/…`.
7. **Cost:** show the per-turn difference of `total_cost_usd`. Use `--system-prompt` (replace)
   unless Claude Code's coding persona is needed; it is about 13 times cheaper on the first turn
   with haiku.

## How to rerun

```
cd .worktrees/claude-rpc
go run ./proto/cmd/harness -s multiturn      # also: sysprompt curl mcp perm-none perm-stdio perm-mcp context
                                             # interrupt queue resume concurrent coldstart prewarm
                                             # curl-sysreplace isolated approve-hidden
go run ./proto/cmd/harness -s perm-stdio -permdelay 45s
go run ./proto/cmd/harness -s prewarm -model sonnet -evidence evidence/sonnet
```

Total spend across all runs was well under $1.
