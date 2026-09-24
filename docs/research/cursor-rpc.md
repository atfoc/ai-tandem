# cursor-rpc: driving the Cursor agent CLI from Go as an RPC-style chat backend

- **Question:** How should a Go program drive the Cursor agent CLI (`cursor-agent` / `agent`,
  v2026.09.23-86fc751) as a long-lived, RPC-like chat backend? The question is settled once running code
  answers these eight points: multi-turn, stream events, system prompt, callbacks into Go (shell and
  MCP), permissions, per-turn context, interrupt/resume/isolation/concurrency, and latency/usage/model.
- **Mode:** without a human in the loop.
- **Branch / worktree:** `cursor-rpc` at `.worktrees/cursor-rpc`
- **Auth:** `cursor-agent status` reported that it was logged in, so auth did not block anything.

## TL;DR

**Use ACP.** `cursor-agent acp` is a hidden subcommand that `--help` does not list. It runs an
Agent Client Protocol server: JSON-RPC 2.0 over stdio, one JSON object per line. It covers everything
the project needs:

- One process stays up across turns and can hold several sessions.
- Text and thought deltas stream as `session/update` notifications. Tool calls arrive as
  `tool_call` and `tool_call_update` with `rawInput` and `rawOutput`.
- Tool approvals come to the Go side as `session/request_permission` requests, so they can be routed
  to the browser UI.
- `session/cancel` stops a turn. It returns `stopReason:"cancelled"` within about 2 ms, and the
  session keeps working afterwards.
- `session/load` resumes a session after the process exits and replays the history.
- `session/new` takes a per-session `cwd` and `mcpServers`.

Print mode (`-p --output-format stream-json` plus `--resume`) also works. But every turn is a new
process, so each turn pays about 4 to 6 s of extra startup. It has no approval routing: a tool call
outside the allowlist is simply rejected unless you pass `--force`. It also has no clean interrupt:
SIGINT kills the turn with exit 130.

**Blocker for MCP on this account.** Every MCP server, HTTP or stdio and wherever it is configured,
is refused with "blocked by team policy". The team's admin settings (`allowedMcpConfiguration`) cause
this, not a CLI limitation. So an agent calling back into Go has only been proven through
**shell + curl**, which works with both modes.

## What was tried (one line per attempt, all on branch `cursor-rpc`)

1. `483ad5e` Added `cmd/acpprobe`, an ACP stdio JSON-RPC client in Go, and `internal/board`, an
   in-process board API with `GET/POST /board` plus a minimal streamable-HTTP MCP server at `/mcp`.
   With them I ran the hello, multiturn, rules, context, resume, callback and perm scenarios.
2. `ae6acab` Model selection over ACP. Added an isolated `CURSOR_CONFIG_DIR` after finding that model
   changes write into the user's global config.
3. `6e81a8e` Registered the MCP server three ways: ACP `mcpServers`, `.cursor/mcp.json`, and
   `--approve-mcps`. Added a catch-all request logger. Then checked `agent mcp list` / `list-tools` by
   hand.
4. `6ec37ca` Added `cmd/printprobe`, which runs one process per turn in print mode with `create-chat`
   and `--resume`, testing `--force` against no force and SIGINT. Also added the ACP `shell` scenario,
   which tests a `.cursor/cli.json` allowlist and `--yolo`.

How to run them: `go build -o bin/acpprobe ./cmd/acpprobe` and then
`bin/acpprobe -work <dir> -cfg <isolated-config-dir> -s <scenario>`. The scenarios are hello,
multiturn, rules, callback, mcp, perm, shell, context, interrupt, resume (`-session <id>`),
concurrent and model. Each run writes every JSON-RPC line, with a millisecond offset, to
`<work>/<name>.acp.log`.

## Answers, with evidence

### 1. Multi-turn: yes, one long-lived process (ACP)

The handshake is `initialize` → `authenticate {methodId:"cursor_login"}` → `session/new {cwd, mcpServers}`.
After that, each turn is one `session/prompt` call. The **response** to that call comes when the turn
ends and carries `{"stopReason":"end_turn"}`. Everything in between arrives as `session/update`
notifications.

Three turns on one `acp` process:
```
>>> Remember this codeword: PURPLE-OTTER-42. Reply only 'ok'.        <<< "ok"
>>> What codeword did I give you? Reply with only the codeword.      <<< "PURPLE-OTTER-42"
>>> Reverse the words of that codeword, joined by '-'.               <<< "42-OTTER-PURPLE"
```
Print mode is the other option: one process per turn. `agent create-chat` prints a chat id, and each
turn runs `-p ... --resume <id> "<prompt>"`. It remembered across turns: t1 set "TEAL-BADGER-7", and
both t2 and t6 answered "TEAL-BADGER-7". Print mode has **no stdin streaming input**. It takes no
`--input-format`, and the prompt is a command-line argument.

### 2. Stream output

**ACP `session/update` kinds seen:** `agent_message_chunk` (text deltas), `agent_thought_chunk`
(reasoning deltas), `tool_call`, `tool_call_update`, `session_info_update` (an auto-generated title),
`available_commands_update` (slash commands), and `user_message_chunk` (only during a `session/load`
replay). The bundle also defines `plan`, `current_mode_update`, `subagent_spawned` and
`subagent_state_update`. Trimmed real lines:

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"session_info_update","title":"Shell Board Update"}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":" MCP"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":" fetch"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"tool_call","toolCallId":"call_7hj…\nfc_052…","title":"`curl -s http://127.0.0.1:62252/board && …`","kind":"execute","status":"pending","rawInput":{"command":"curl -s http://127.0.0.1:62252/board && …"}}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_7hj…","status":"in_progress"}}}
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"746c…","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_7hj…","status":"completed","rawOutput":{"exitCode":0,"stdout":"{\"elements\":[…]}","stderr":""}}}}
{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}
```
Other tool kinds seen: `read` ("Read File", with `locations:[{path}]`), `search` ("Find"), and
"List MCP Resources". Errors come back as JSON-RPC errors, for example
`{"code":-32602,"message":"Invalid params","data":{"message":"Invalid model value: …"}}`.

**Print-mode stream-json events seen:** `system/init` (has `session_id`, `model`, `permissionMode`),
`user`, `assistant` deltas (each carries `timestamp_ms`), `thinking/delta`, `thinking/completed`,
`tool_call/started`, `tool_call/completed`, a final full `assistant` message, and `result/success`:
```json
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"…/ws","session_id":"568d…","model":"GPT-5.4 Mini Medium","permissionMode":"default"}
{"type":"thinking","subtype":"delta","text":" need","session_id":"568d…","timestamp_ms":1790273064996}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\":{\""}]},"session_id":"568d…","timestamp_ms":1790273070141}
{"type":"tool_call","subtype":"started","call_id":"call_p0B…","tool_call":{"shellToolCall":{"args":{"command":"curl -s -X POST …","workingDirectory":"…","timeout":30000,"simpleCommands":["curl"],…}}}}
{"type":"tool_call","subtype":"completed","call_id":"call_p0B…","tool_call":{"shellToolCall":{…,"result":{"success":{"exitCode":0,"stdout":"{\"board\":…}"}}}}}
{"type":"result","subtype":"success","duration_ms":7474,"duration_api_ms":7474,"is_error":false,"result":"…","session_id":"568d…","request_id":"5a20…","usage":{"inputTokens":740,"outputTokens":307,"cacheReadTokens":28160,"cacheWriteTokens":0}}
```
A shell call that was not approved comes back as `"result":{"rejected":{"command":…,"reason":""}}`.

**Gotcha:** before a tool call, print mode sends the text segment so far again as a single
`assistant` event that carries both `model_call_id` and `timestamp_ms`. A naive delta concatenation
therefore duplicates that text. Skip `assistant` events that have `model_call_id`, or rely on
`result.result`.

### 3. Custom system prompt / instructions: rules files in the cwd work; no flag exists

Neither mode has a system-prompt flag or ACP parameter. The ACP code has no `systemPrompt` and does
not read `_meta` for one. Both of these files in the session `cwd` were followed at the same time on
every turn:
- `AGENTS.md`: "Always end every reply with the exact line `-- BoardBot/AGENTS`."
- `.cursor/rules/whiteboard.mdc` with front matter `alwaysApply: true`: "Always start every reply
  with `[WB]`."

Result: `"[WB] Hi!\n-- BoardBot/AGENTS"` and `"[WB] 4\n-- BoardBot/AGENTS"`. Print mode also
followed `AGENTS.md`: every reply ended with `-- BoardBot`.

For the whiteboard product, the Go server should write `AGENTS.md` and/or `.cursor/rules/*.mdc` into
each chat's workspace directory. A prompt prefix on the first turn is the fallback.

### 4. Agent calling back into the Go server

- **Shell + curl: works in both modes.** The board server logged
  `HTTP GET /board`, `HTTP POST /board add="rect:cache-shell"` and `HTTP GET /board` for ACP, and
  `HTTP POST /board add="rect:print-mode"` for print mode with `--force`. The agent learned the
  endpoints from `AGENTS.md`.
- **MCP: blocked by team policy on this account, so it could not be proven end to end.** I tried:
  - an HTTP MCP passed in ACP `session/new.mcpServers` as
    `{"type":"http","name":"board","url":"http://127.0.0.1:PORT/mcp","headers":[]}`. ACP advertises
    `mcpCapabilities:{http:true,sse:true}`.
  - `.cursor/mcp.json` in the cwd, with and without `--approve-mcps`.

  In every case the Go MCP endpoint received **zero requests**. The agent could see the name
  (`List MCP Resources (board)`) but answered "no board MCP server available". Checking by hand in a
  workspace with `.cursor/mcp.json`:
  ```
  $ agent mcp enable board   → ✓ Enabled and approved MCP server: board
  $ agent mcp list           → board: Error: MCP server 'board' is blocked by team policy.
  $ agent mcp list-tools board → Failed to list tools: MCP server 'board' is blocked by team policy.
  ```
  A stdio server (`{"command":"/bin/cat"}`) is blocked the same way. The same happens under a fresh
  config dir on the account's other team (Zynga). The CLI source shows the block comes from
  server-side team admin settings (`allowedMcpConfiguration.disableAll`, or a server allowlist with
  reason `teamPolicy`).
- **Which is better:** shell + curl works today with no setup. It depends on the shell tool, which
  needs an allowlist entry for `Shell(curl)` (see point 5). MCP would give typed tools and no shell,
  and the ACP `mcpServers` field would let Go inject a per-chat HTTP MCP URL with no files. But this
  account can only use it if a Cursor team admin allows it. Re-run `-s mcp` on an account without the
  policy to confirm it; the Go MCP endpoint in `internal/board` is ready. **Design for curl, and keep
  MCP optional.**

### 5. Permissions

- **ACP routes approvals to Go.** With `approvalMode: "allowlist"`, a shell command outside the
  allowlist sends an agent→client **request**:
  ```json
  {"method":"session/request_permission","params":{"sessionId":"e5c3…","toolCall":{"toolCallId":"call_a2N…","title":"`echo PERMTEST > out.txt && cat out.txt`","kind":"execute","status":"pending","content":[{"type":"content","content":{"type":"text","text":"Not in allowlist: cat, echo"}}]},"options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},{"optionId":"allow-always","name":"Allow always","kind":"allow_always"},{"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
  ```
  Answering `{"outcome":{"outcome":"selected","optionId":"allow-once"}}` ran the command
  (`out.txt` = "PERMTEST"). Answering `reject-once` blocked it, and the agent said so. The request
  blocks until Go answers, so it can wait for a click in the browser. `{"outcome":"cancelled"}` is
  also valid.
- **Pre-approval so nothing asks:** `<cwd>/.cursor/cli.json` with
  `{"permissions":{"allow":["Shell(curl)"],"deny":[]}}` led to **0 permission requests** while the
  curl still ran. **Gotcha:** `deny` is required. Without it the process exits at startup with
  "Invalid project config … schema validation failed", and `initialize` fails with "process exited".
- `--yolo` / `--force` before `acp` (`agent --yolo acp`) did **not** stop ACP permission requests;
  one was still sent. In ACP, use allowlists or answer the requests.
- **Print mode:** with no `--force`, a command outside the allowlist comes back as `rejected`
  straight away. It does not hang, and the agent reports "the shell rejected the curl command". With
  `--force` it runs. Print mode has no way to route approvals.
- The user's global `~/.cursor/cli-config.json` has `approvalMode: "unrestricted"`. That setting
  would silently auto-approve everything, which is one more reason to run with an isolated
  `CURSOR_CONFIG_DIR` (see Gotchas).

### 6. Per-turn context injection: prepend a content block to each prompt

ACP `session/prompt.prompt` is an array of content blocks. Sending a context block before the user's
text works, and the agent followed changes from turn to turn:
```
[{"type":"text","text":"<ui-context>\nactive_page: arch.excalidraw\nselection: rect:api-gateway\n</ui-context>"}, {"type":"text","text":"Which page am I looking at…"}]
→ "You're looking at `arch.excalidraw`, and the selected item is `rect:api-gateway`."
[{…"active_page: roadmap.excalidraw\nselection: none"…}, {"text":"And now which page?"}]
→ "You're now looking at `roadmap.excalidraw`, with nothing selected."
```
A `resource_link` block (`{"type":"resource_link","uri":"whiteboard://pages/sales.excalidraw","name":"sales.excalidraw"}`)
is also accepted and understood, which fits `@page` references. `embeddedContext` is `false`, so do
not send embedded `resource` blocks; `image` is `true`. In print mode, put the same text prefix inside
the prompt argument; that worked too.

### 7. Interrupt, resume, cwd/isolation, concurrency

- **Interrupt (ACP):** the notification `session/cancel {sessionId}` was sent 4 s into a long story.
  The `session/prompt` response `{"stopReason":"cancelled"}` came back **2 ms later**. The next prompt
  on the same session and process answered "still alive". **Print mode:** SIGINT gives exit 130 and
  "Aborting operation...", with no `result` event. The next `--resume` still remembered the chat.
- **Resume after exit (ACP):** a new `acp` process, then `session/load {sessionId, cwd, mcpServers}`.
  That took 3.5 s and replayed the history as `user_message_chunk`, `agent_thought_chunk` and
  `agent_message_chunk` updates before responding. The next prompt answered "PURPLE-OTTER-42". ACP
  sessions are stored under `$CURSOR_CONFIG_DIR/acp-sessions/<id>/{store.db,meta.json}`, so **keep
  the config dir stable** or `session/load` will not find them. `sessionCapabilities.list` means
  `session/list` exists too.
- **cwd/isolation:** `session/new.cwd` sets the workspace. Rules, `.cursor/cli.json`, `mcp.json` and
  shell working directory all follow it. Each session read its own `marker.txt`.
- **Concurrency:** two `acp` processes in different cwds ran at the same time: "I am workspace A" |
  "I am workspace B", both in 8.3 s. **Two sessions in one process**, each with its own cwd, also ran
  at the same time: "I am workspace A" | "I am workspace B", 6.1 s. Three separate probes also ran
  side by side with no interference.

### 8. Latency, usage, model

| step (ACP, gpt-5.4-mini) | measured |
|---|---|
| spawn + `initialize` + `authenticate` | ~1.5 s |
| `session/new` | 1.5–4 s (once 8 s under parallel load) |
| `session/set_config_option` model | 1.1–3.4 s (10 s once, after `session/load`) |
| time to first `agent_message_chunk`, warm session, trivial prompt | 1.5–3.4 s (once 14 s, an outlier) |
| `session/cancel` → cancelled response | 2 ms |

Print mode: the time to the first text delta was **6.7–9 s per turn**, because every turn pays for
process start, auth and session load.

- **Usage:** only print mode reports it, in `result.usage`
  (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) plus `duration_ms`. **ACP
  exposes no usage or cost.** The prompt result is only `{stopReason}`, and the bundle has no usage
  update. Neither mode reports a dollar cost.
- **Model:**
  - Print mode: `--model <id>` with ids from `agent models`, such as `gpt-5.4-mini-medium`.
  - ACP: `session/new` returns `models.availableModels` and a `model` config option whose values use
    a *different* syntax, `gpt-5.4-mini[reasoning=medium]`. `session/set_config_option
    {configId:"model", value}` (or `session/set_model`) takes only a value listed exactly. It
    rejected `gpt-5.4-mini[reasoning=low]`, `gpt-5.4-nano` and `gpt-5.4-nano-low`, and accepted
    `gpt-5.4-nano[reasoning=medium]`.
  - Modes `agent` / `plan` / `ask` are available through `session/set_mode` or the `mode` config
    option.

## Gotchas

1. **Model changes persist to the global config.** `-p --model gpt-5.4-mini-low` rewrote the user's
   default in `~/.cursor/cli-config.json`. ACP `set_config_option model` does the same (it wrote
   `acp-config.json` and `cli-config.json` in the config dir). **Always spawn with
   `CURSOR_CONFIG_DIR=<server-owned dir>`.** Auth still comes from the keychain, so no login is
   needed. Seed the dir with a copy of the user's `cli-config.json` so the active team stays the same;
   a blank dir picked a different team (Zynga instead of Enterprise). **Side effect of this
   prototype:** my first print-mode test changed the user's global default model from
   `claude-opus-5-5` (Claude Opus 5.5 1M Medium) to `gpt-5.4-mini`. My attempt to restore
   `~/.cursor/cli-config.json` was blocked by the harness's permission guard, so the user should
   reset it with `/model` in the CLI.
2. `acp` is not listed in `--help`; `agent acp --help` shows it.
3. `authenticate {methodId:"cursor_login"}` is required before `session/new`. The error if you skip
   it: "Authentication required…".
4. An invalid `.cursor/cli.json` (for example, one missing `deny`) kills the process at startup.
5. Print mode repeats the pre-tool text as an `assistant` event with `model_call_id` (see point 2).
6. `toolCallId` values contain a literal `\n`. Treat them as opaque strings.
7. `--yolo` does not apply to ACP permission requests.
8. MCP is blocked by team policy on this account (see point 4).

## Recommended integration design for the Go server

- **One `agent acp` subprocess per chat** fits the project's "new chat = new process" model. One
  process can also multiplex sessions, which is useful later.
  - Spawn with `cmd.Env += CURSOR_CONFIG_DIR=<appdata>/cursor-config`, seeded once from the user's
    config. Then run `initialize` → `authenticate` → `session/new {cwd: <chat workspace>}` →
    `session/set_config_option model` → store the `sessionId`.
- **Chat workspace directory per chat**, written by the server:
  - `AGENTS.md`: the whiteboard-editing system prompt and the board API URL with a per-chat token.
  - `.cursor/cli.json`: `{"permissions":{"allow":["Shell(curl)", …],"deny":[]}}`, so board calls
    never prompt.
  - Optionally `.cursor/rules/*.mdc` with `alwaysApply: true`.
- **Board API over localhost HTTP**, called by the agent with curl. Include a chat id or token in the
  URL or a header, so the server knows which chat is editing. Also pass the same server as an HTTP MCP
  in `session/new.mcpServers`. It costs nothing, and it starts working on accounts whose team allows
  MCP.
- **Per turn:** `session/prompt` with `[ {text: "<ui-context>active_page…viewport…selection</ui-context>"}, {text: userMsg}, …resource_link per @page ]`.
  Stream `agent_message_chunk`, `agent_thought_chunk`, `tool_call` and `tool_call_update` to the UI
  over WebSocket. Finish the turn on the prompt response's `stopReason`.
- **Approvals:** forward any `session/request_permission` to the UI and answer with the chosen
  `optionId`. Keep a timeout that answers `cancelled`.
- **Stop button:** `session/cancel`. **Server restart:** respawn, then `session/load` with the stored
  `sessionId` and the same config dir.
- **Usage/cost:** ACP gives none. If it is needed, a separate print-mode call could read
  `result.usage`; otherwise leave it out of the UI.
- **Fallback path:** print mode, one process per turn: `create-chat` once, then
  `agent -p --output-format stream-json --stream-partial-output --trust --model <id> [--force] --resume <id> "<ctx+msg>"`.
  Use it only if ACP breaks. It is slower, has no approval routing, and interrupts by killing the
  process.
