# Current MCP / board-access architecture (HEAD `b15640a`)

Status: facts only, against this worktree at `b15640a`. Not a plan. No proposed design.

Line numbers are against files in `/Users/pedjat/Documents/projects/ai-whiteboard-worktrees/mcp-subagents-plan` at that commit.

This document answers: **how does a board tool call reach the app today, and how is the caller identified?**

---

## 1. How MCP is served

Verified:

- The app process binds **two loopback listeners**.
  - Main app HTTP: `127.0.0.1:<port>` with default port **4747** (`cmd/ai-whiteboard/main.go:93`, `123–128`). This serves the web client and `/api/*`.
  - MCP: `127.0.0.1:<mcpPort>` with production port **6006** (`cmd/ai-whiteboard/main.go:131–137`, `internal/boardapi/endpoint.go:7`).
- Both listeners are in the **same process**. The MCP listener is served in a goroutine with `http.Serve(mcpLn, mcpHandler)` (`cmd/ai-whiteboard/main.go:201–208`); the 4747 listener is the blocking `http.Serve` (`cmd/ai-whiteboard/main.go:217`).
- They share in-process singletons: `editorbridge.Bridge`, `chats.Manager`, `boards.Service`, and one `boardapi.Relay` (`cmd/ai-whiteboard/main.go:142–151`, `179`).
- Advertised MCP URL is exactly `http://localhost:6006/mcp` — `localhost` spelling, path `/mcp`, no query, no trailing slash (`internal/boardapi/endpoint.go:9–11`; pinned by `internal/boardapi/endpoint_test.go:11–26`).
- The MCP handler serves **only** `POST /mcp` (`internal/server/server.go:179–186`). It serves no client files and no `/api/*`. `GET /api/hello` on the MCP listener is 404 (`internal/server/server_test.go:255–260`).
- Host guard on the MCP listener accepts only `localhost:<mcpPort>` and `127.0.0.1:<mcpPort>` (403 otherwise) (`internal/server/guard.go:20–31`, `internal/server/server_test.go:231–243`). The active-client (`X-AIWB-Client`) rule does not apply because the path is not under `/api` (`internal/server/guard.go:41–44`). No CORS headers are added (`internal/server/server.go:180–182`).
- Bind order: 4747 first, then 6006, **before** `server.json` is written. A 6006 bind failure is fatal and leaves no `server.json` (`cmd/ai-whiteboard/main.go:131–137`, `209–211`; message at `cmd/ai-whiteboard/main.go:236–245`).
- `server.json` records only the 4747 pid/port (`internal/store/store.go:109–118`). Launch/relaunch/stop and the desktop app health-check 4747 `/api/hello` (`desktop/lib.js:135–139`).
- Hidden test-only override: env `AIWB_MCP_PORT` (not a flag). Empty → 6006. `0` asks the OS for an ephemeral port (`cmd/ai-whiteboard/main.go:221–232`). Production always advertises `http://localhost:6006/mcp` via `boardapi.Endpoint(MCPPort)` (`internal/boardapi/endpoint.go:13–21`).
- If the MCP `http.Serve` later errors, it logs and sets `mcpUp` false; 4747 keeps running (`cmd/ai-whiteboard/main.go:203–207`).
- Diagnostics: `GET /api/mcp/status` on **4747** returns listener port/url/up plus last MCP contact per chat, with no token (`internal/server/server.go:264–279`). GET is exempt from the active-client check (`internal/server/guard.go:45–46`).

Old surfaces confirmed gone:

- No `/mcp/{token}` route on either listener. The only MCP route is `POST /mcp` (`internal/server/server.go:185`; comment at `internal/boardapi/boardapi_test.go:61`: “the only MCP route (header credential)”).
- No `/agent/{token}/{tool}` command endpoint. `internal/boardapi/` contains no `command.go`. No `ParseCommand`, `ServeCommand`, or `CommandURL` remain in the tree (search of production code).
- `GET /mcp` is 405, both from `ServeFixedMCP` (`internal/boardapi/mcp.go:179–181`) and from the MCP mux (`internal/server/server_test.go:247–252`; process test `cmd/ai-whiteboard/mcp_endpoint_test.go:53–59`).

---

## 2. How per-chat identity travels

Verified:

- Identity is the chat’s durable **board token** in the HTTP header `Authorization: Bearer <token>` (`internal/boardapi/mcp.go:177–184`, `187–193`).
- Parser: prefix `Bearer ` (case-insensitive), remainder trimmed. Anything else (missing header, `Bearer ` with empty token, `Token …`, raw token) yields `""` (`internal/boardapi/mcp.go:187–193`; cases in `internal/boardapi/mcp_fixed_test.go:83–91`).
- Token source: minted once at board-chat `Create` as `randHex(16)` (32 hex chars) when `board != ""` (`internal/chats/manager.go:364–370`, `1088–1092`). Plain chats get no token. Stored on `ChatMeta.Token` (`internal/model/model.go:204`) and persisted in `chats/<id>/chat.json` (`internal/chats/manager.go:131`). Reloaded with `Load` (`internal/chats/manager.go:222–224`). There is no rotation and no uniqueness check against existing tokens.
- Resolution: `chats.Manager.ByToken` linear-scans every loaded chat (including archived) and returns the matching `ChatMeta` (`internal/chats/manager.go:1007–1021`). Empty token → not found immediately (`internal/chats/manager.go:1009–1011`).
- `ByToken` is the only MCP token consumer. There is no run-token resolver on the MCP path.

Missing / unknown / unusable credential:

- `initialize` and `tools/list` still succeed with HTTP 200 (no token check) (`internal/boardapi/mcp.go:219–232`; `internal/boardapi/mcp_fixed_test.go:43–61`).
- `tools/call` with missing/malformed/unknown token returns HTTP 200 JSON-RPC **result** with text `"unknown board token"` and `isError: true` — not an HTTP 401/403 (`internal/boardapi/mcp.go:48–54`, `233–242`; `internal/boardapi/mcp_fixed_test.go:83–100`).
- Archived chat: token still resolves; call text `"this chat is archived"`, `isError` (`internal/boardapi/mcp.go:55–57`; `internal/boardapi/mcp_fixed_test.go:102–111`).
- Deleted chat: chat is removed from the manager map (`internal/chats/manager.go:998–999`), so `ByToken` fails → `"unknown board token"`.
- Curl-era Cursor chats with `InstructionsSent` still have a token; `Call` returns `"this chat used the old board connection"` (`internal/boardapi/mcp.go:58–60`; `internal/model/model.go:207`; spawn/send also refuse with `ErrLegacy` at `internal/chats/manager.go:68`, `437–439`, `577–580`).
- Raw token is never logged. Unknown credentials are logged as `chat=unknown` (`internal/boardapi/mcp.go:257–266`, `269–277`; `internal/boardapi/mcp_log_test.go:47–70`).

Contrast with the old surfaces (gone):

- Old Claude path: URL `/mcp/<token>` on the 4747 listener. Gone.
- Old Cursor path: `/agent/<token>/<tool>` command endpoint plus curl instructions. Gone. Cursor first-message instructions are now `prompts.Claude()` (same whiteboard body, no URL, no curl) (`internal/chats/manager.go:604–608`; assertion that the first send has no `<board-api>` or `curl` at `internal/chats/manager_test.go:858–862`).
- Old pi path: rewrite of MCP URL to `/mcp/<runToken>` using the bridge run handle as credential. Gone. Pi now uses the same header credential as Claude/Cursor (`internal/pi/args.go:104–116`, `132–148`).

---

## 3. `tools/list` and `tools/call`

Verified:

- Routing: `POST /mcp` → `Relay.ServeFixedMCP` → `serveRPC` (`internal/boardapi/mcp.go:177–184`, `196–256`). Methods handled: `initialize`, `tools/list`, `tools/call`, `ping`. Anything else is JSON-RPC error `{code: -32601, message: "method not found"}` (`internal/boardapi/mcp.go:248–250`; `internal/boardapi/boardapi_test.go:187–190`).
- Notifications (JSON-RPC with no `id`) return HTTP **202** with empty body (`internal/boardapi/mcp.go:206–209`; `internal/boardapi/mcp_fixed_test.go:135–138`).
- Bad JSON: HTTP **400** `"bad json"` (`internal/boardapi/mcp.go:202–205`).
- Non-POST: HTTP **405** (`internal/boardapi/mcp.go:179–181`).
- Package comment: “Streamable HTTP, JSON responses only” (`internal/boardapi/mcp.go:154–156`).
- `initialize` result: echoes `protocolVersion`, capabilities `{"tools": {}}`, `serverInfo: {name: "board", version: "0.0.1"}` (`internal/boardapi/mcp.go:219–228`). Server name `"board"` is why Claude/pi tool names are `mcp__board__<tool>`.
- **Tool list owner:** `boardtools.Tools` (`internal/boardtools/tools.go:44–108`). `mcpTools()` copies that slice into MCP `tools/list` shape (`internal/boardapi/mcp.go:161–174`). Seven tools, in order: `list_boards`, `read_board`, `get_view`, `apply`, `delete_elements`, `create_board`, `show_board` (`internal/boardtools/boardtools_test.go:8–12`; `internal/boardapi/boardapi_test.go:162–178`).
- **The list is global.** `tools/list` does not read the token. Same seven tools for every caller, including missing/unknown credentials (`internal/boardapi/mcp.go:229–232`; `internal/boardapi/mcp_fixed_test.go:55–61`).
- `tools/call`: decode `name` + `arguments` → `Relay.Call(token, name, args)` (`internal/boardapi/mcp.go:233–242`).
- `Relay.Call` (`internal/boardapi/mcp.go:47–75`):
  1. `ByToken` (unknown → `"unknown board token"`).
  2. Archived / `InstructionsSent` / unknown tool name → text errors.
  3. Look up the chat’s board, then `Bridge.Call("tool", {chat, board, name, args}, 30s)` (`internal/boardapi/mcp.go:22`, `63–65`).
  4. Browser SSE event `rpc` to the active client; answer via `POST /api/rpc-reply` on 4747 (`internal/editorbridge/bridge.go:201–232`; `internal/server/server.go:231–247`).
- Timeouts:
  - Board tool wait: **30 s** (`internal/boardapi/mcp.go:22–23`; editorbridge timer at `internal/editorbridge/bridge.go:222–231`, error `"the board did not answer tool in 30s"`).
  - No active browser client: **immediate** `ErrNoClient` → `NoClientText` (`internal/boardapi/mcp.go:26–28`, `67–69`; `internal/editorbridge/bridge.go:62–64`, `211–214`; `internal/boardapi/boardapi_test.go:215–229` asserts fail-at-once).
- Error format for tool outcomes: HTTP 200 JSON-RPC **result** `{content: [{type:"text", text}], isError?: true}`. `isError` is omitted on success (`internal/boardapi/mcp.go:237–242`; helper `callResult` at `internal/boardapi/boardapi_test.go:85–103`). HTTP errors are only for transport/protocol (400/405/403), not for unknown token, unknown tool, archived, or board-engine failures.
- Session / SSE / push:
  - No `Mcp-Session-Id` header anywhere in the tree.
  - Server does not open or serve a GET SSE stream on `/mcp` (405).
  - No server-initiated notifications after the handshake.
  - Pi’s MCP client *accepts* `text/event-stream` on POST responses and does not require a GET stream (`internal/pibridge/extension/mcp.ts:9–16`, `440–453`). Cursor’s historical GET/SSE behaviour is not implemented on the server today.
- Access log: one line per `initialize` (`mcp initialize chat=… client=… version=…`) and one per `tools/call` (`mcp tools/call chat=… tool=… outcome=ok|error`). Arguments and credentials are omitted (`internal/boardapi/mcp.go:269–284`; `internal/boardapi/mcp_log_test.go:23–45`). Last contact is stored in `Relay.Contacts` for `/api/mcp/status` (`internal/boardapi/mcp.go:101–105`).

---

## 4. Token model today

Verified:

### Chat board token

- One durable token per board chat, minted at create, persisted, never rotated (`internal/chats/manager.go:364–370`; `internal/model/model.go:204`).
- Handed to every board-chat spawn as `agent.BoardAccess{MCPURL, Token}` (`internal/chats/manager.go:471–480`).
  - `MCPURL` comes from `Manager.MCPURL`, set at construction to `boardapi.Endpoint(mcpBoundPort)` (`cmd/ai-whiteboard/main.go:151–152`; `internal/chats/manager.go:39`).
  - `Token` is `c.meta.Token`.
  - Plain chats: `Board == nil`.
- All three agents of a given chat receive the **same** `BoardAccess` (manager tests: Claude `internal/chats/manager_test.go:840–843`, Cursor `:852–854`, Pi `:908–914`).
- Context-split forks reuse `spawnOptions(c)` and therefore the same token (`internal/chats/contextsplit.go:67`; Claude fork config pinned at `internal/claude/ctxsplit_test.go:210–231`).

### Run-token leftover (Pi only)

- Pi still mints a per-run **bridge handle** via `pibridge.Bridge.RegisterRun` (`internal/pi/pi.go:160–165`; `internal/pibridge/bridge.go:188–211`).
- The handle is 16 random bytes, hex-encoded (`internal/pibridge/bridge.go:236–241`), put in env `AIWB_BRIDGE_RUN` (`internal/pi/args.go:144–146`).
- It is **not** an MCP credential and is **not** mapped to the board token (`internal/agent/bridge.go:8–11`, `internal/pibridge/bridge.go:8–12`). Registering the same chat id again retires the previous handle (`internal/pibridge/bridge.go:196–203`).
- Used only for the owner-only UDS bridge: permissions, notices, subagent activity, abort (`internal/agent/bridge.go:26–33`). “There is no `tool` frame: board tools are served over the app's HTTP MCP route” (`internal/agent/bridge.go:33`).
- MCP config no longer depends on a run handle: a board chat with an MCP URL gets `AIWB_MCP_CONFIG` even with an empty run token (`internal/pi/args_test.go:196–201`).

### Registries

- MCP identity registry: `Chats.ByToken` only (`internal/chats/manager.go:1007–1021`). Maps token → `ChatMeta` (chat id, board, archived, `InstructionsSent`, …). Does **not** map to a subagent sid or a caller kind.
- Pi bridge registry: `pibridge.Bridge.runs` keyed by run handle → `{chatID, handler}` (`internal/pibridge/bridge.go:37`, `188–211`). Separate from MCP.

### How a spawned process is told how to reach the board

`SpawnOptions.Board` (`internal/agent/agent.go:15–28`) is the single value. Adapters copy it into their own config (see §5). There is no extra per-process credential.

Pi native subagents (the extension’s `subagent` tool, not an app-spawned MCP subagent) inherit the parent env, including `AIWB_MCP_CONFIG`, via `childEnv` which copies every string env var (`internal/pibridge/extension/subagent.ts:161–179`, `603–605`; test `internal/pibridge/extension/test/subagent.test.ts:738–751`). So a native Pi child uses the **same** board token as the parent chat.

---

## 5. How Claude, Cursor, and Pi are configured

All three receive the same `BoardAccess` from `spawnOptions`. They differ only in how the header is injected.

### Claude — `internal/claude/claude.go`

- Flag `--mcp-config` with JSON object:
  `{"mcpServers":{"board":{"type":"http","url":"<MCPURL>","headers":{"Authorization":"Bearer <token>"}}}}`
  (`internal/claude/claude.go:84–108`).
- Also `--allowedTools` listing `mcp__board__<name>` for every `boardtools.Tools` entry, plus `--append-system-prompt` (`internal/claude/claude.go:73–81`).
- Header shape: object `headers: { Authorization: "Bearer …" }` (not an array).
- Pinned: `internal/claude/args_test.go:54–71`; context-split fork `internal/claude/ctxsplit_test.go:226–231`.
- Prompt `prompts.Claude()` does not list tools; it says they come from MCP (`internal/prompts/prompts.go:19–24`).

### Cursor — `internal/cursor/cursor.go`

- ACP `session/new` and `session/load` both send `mcpServers` (`internal/cursor/cursor.go:197`, `205`).
- Board chat payload: array of one HTTP entry, headers as **name/value array**:
  `[{type:"http", name:"board", url:"http://localhost:6006/mcp", headers:[{name:"Authorization", value:"Bearer <token>"}]}]`
  (`internal/cursor/cursor.go:262–277`).
- Plain chats: empty array `[]` (`internal/cursor/cursor.go:266–268`). Comment: the headers array must exist even when empty (ACP schema).
- Pinned: `internal/cursor/cursor_test.go:585–601`.
- Presentation: Cursor MCP calls with `providerIdentifier == "board"` and a known board tool name are renamed to `mcp__board__<tool>` (`internal/cursor/cursor.go:665–695`).
- Permissions: those board MCP calls are auto-approved in `onRequest` (prefer `allow_once`) (`internal/cursor/cursor.go:807–821`). Non-board MCP calls still ask.
- ACP traces drop raw params so the Authorization header cannot reach the log file (`internal/cursor/acp.go:193–195`, `221–222`).
- First user message of a Cursor board chat injects `prompts.Claude()` once, gated by `McpInstructionsSent` (`internal/chats/manager.go:604–608`).

### Pi — `internal/pi/args.go` + extension

- Env `AIWB_MCP_CONFIG` with the **same JSON object shape as Claude** (`internal/pi/args.go:92–127`, `147–148`).
- Frozen contract: board token appears only inside that env value, never in argv or a URL (`internal/agent/bridge.go:17–20`; `internal/pibridge/extension/index.ts:18–20`; `internal/pi/args_test.go:166–188`; `internal/pi/pi_test.go:201–205`).
- Extension reads `AIWB_MCP_CONFIG` (flag `--mcp-config` wins if set) and forwards `headers` on every POST (`internal/pibridge/extension/index.ts:88`, `151`; `internal/pibridge/extension/mcp.ts:239–267`, `440–453`).
- Handshake/discovery budget 10 s (`internal/pibridge/extension/mcp-wiring.ts:162`); `tools/call` is not bounded by that timeout (`internal/pibridge/extension/mcp-wiring.ts:156–161`).
- App-sourced `mcp__board__*` tools are auto-allowed by the permission gate (`internal/pibridge/extension/mcp-wiring.ts:75–86`; `internal/pibridge/extension/permissions.ts:8`).
- Children inherit `AIWB_MCP_CONFIG` (`internal/pibridge/extension/index.ts:194–196`).
- Standalone (no bridge) still works with the same config JSON (`README.md:43–45`).

---

## 6. Facts that bear on per-caller tokens for subagent processes

This section is observations about today’s code, not a design.

What exists that a later per-caller-token scheme could use:

- Identity already travels in `Authorization`, not in the URL. Changing the token value does not change the advertised URL (`internal/boardapi/endpoint.go:11`; `internal/agent/agent.go:26–27`).
- All three adapters copy `BoardAccess.Token` into the header as an opaque string. They do not interpret it (`internal/claude/claude.go:100–101`; `internal/cursor/cursor.go:273–274`; `internal/pi/args.go:113–114`).
- One construction site for what a process receives: `Manager.spawnOptions` (`internal/chats/manager.go:471–480`).
- `tools/list` is computed at request time from `boardtools.Tools` (`internal/boardapi/mcp.go:161–174`, `229–232`). It is not cached per connection. Today it ignores the token; a filter could be applied there if a token distinguished callers.
- `ServeFixedMCP` already extracts a bearer token per request (`internal/boardapi/mcp.go:177–184`). The endpoint is stateless: no session id, no “current chat”.
- `initialize` / `tools/list` do not reject unknown credentials (`internal/boardapi/mcp.go:219–232`). A caller that should not see spawn tools would still receive the full list unless `tools/list` started using the token.

What today would not distinguish subagent callers:

- One `ChatMeta.Token` per board chat. No in-memory extra-token table. `ByToken` returns only `ChatMeta`, not `(chat, sid)` or a caller-kind flag (`internal/chats/manager.go:1007–1021`).
- Every spawn of that chat (resume, context-split fork, Pi native child) gets the same token.
- Pi native subagents inherit the parent `AIWB_MCP_CONFIG` unchanged (`internal/pibridge/extension/subagent.ts:161–179`; `internal/pibridge/extension/test/subagent.test.ts:738–751`). They call MCP as the chat.
- The Pi run handle is explicitly not an MCP credential and is not mapped to the board token (`internal/pibridge/bridge.go:8–12`). It cannot identify an MCP caller today.
- `tools/list` is the same seven board tools for every token, including unknown ones (`internal/boardapi/mcp_fixed_test.go:55–61`).
- Token uniqueness is not enforced at mint (`internal/chats/manager.go:369`). Collision would make `ByToken` return the first match in map iteration order (`internal/chats/manager.go:1013–1019`).
- Tokens of running chats survive restart (they live in `chat.json`). There is no ephemeral-token store.

Unresolved (not evidenced in this tree):

- Whether Claude/Cursor MCP clients would accept a *different* token per child process if the app issued one at spawn. No test covers two tokens for one chat.
- Whether Cursor persists `mcpServers` across `session/load` in its own store. The adapter always re-sends them (`internal/cursor/cursor.go:197`).
- Whether any agent caches `tools/list` for the life of a connection such that a later per-token filter would not take effect until reconnect.

---

## 7. Tests and comments that freeze the current contract

URL / port / spelling:

- `internal/boardapi/endpoint_test.go:11–26` — `MCPPort == 6006`, `MCPURL == "http://localhost:6006/mcp"`, host `localhost:6006`, path `/mcp`, empty query/fragment.
- `cmd/ai-whiteboard/mcp_endpoint_test.go:17–59` — process answers MCP on the override port; GET is 405; production comment “no user-facing port flag”.
- `cmd/ai-whiteboard/mcp_endpoint_test.go:65–` — 6006-conflict fail-fast, no `server.json`.
- `internal/server/server_test.go:219–260` — MCP handler host allowlist, GET 405, no `/api` on 6006.
- `web/e2e/app.e2e.mjs:11–12, 74–80` — default e2e owns 6006 because Cursor’s allowlist is the exact URL.

Header / identity:

- `internal/boardapi/mcp_fixed_test.go:43–100` — initialize/`tools/list` permissive; valid bearer reaches the browser client; missing/bad/unknown header → `"unknown board token"` + `isError`.
- `internal/boardapi/mcp_probe_test.go:420–425` — real pi extension POSTs to `/mcp` with `Authorization: Bearer <chat token>`.
- `internal/chats/manager_test.go:840–843, 852–854, 908–914` — manager hands each spawner the fixed URL and the chat token; Pi URL must not contain the token.
- `internal/pi/args_test.go:166–188` and `internal/pi/pi_test.go:191–205` — `AIWB_MCP_CONFIG` exact JSON; token only inside that env var.
- `internal/claude/args_test.go:54–59` — `--mcp-config` exact JSON.
- `internal/cursor/cursor_test.go:585–601` — `session/new` and `session/load` mcpServers array + headers array.

Tool count / names:

- `internal/boardtools/boardtools_test.go:8–12` — seven named tools.
- `internal/boardapi/boardapi_test.go:162–178` — `tools/list` length 7, names/descriptions match `boardtools.Tools`.
- `internal/claude/args_test.go:63–71` — `--allowedTools` has one `mcp__board__*` per tool.

Error shape:

- `internal/boardapi/boardapi_test.go:207–213, 215–229, 231–248, 266–275, 278–284, 311–316` — unknown token, no-client (immediate), success through client, archived, legacy, unknown tool; all as result text + `isError`.
- `internal/boardapi/mcp.go:47–49` comment: “Errors come back as text too (isErr = true)”.

Logging / status:

- `internal/boardapi/mcp_log_test.go:23–70` — one structured line, no token, no arguments; unknown initialize logged as `chat=unknown`.
- `internal/server/server_test.go:254–310` — `/api/mcp/status` has no token; records initialize + tools/call + unknown.

Pi inheritance / run handle:

- `internal/pibridge/extension/test/subagent.test.ts:738–766` — board-chat child inherits `AIWB_MCP_CONFIG`; plain-chat child does not.
- `internal/agent/bridge.go:1–33` — frozen three-way contract (adapter / pibridge / extension).

Comments that name the contract:

- `internal/boardapi/mcp.go:1–3, 154–156, 177–178`
- `internal/agent/agent.go:25–27`
- `internal/agent/bridge.go:8–20`
- `internal/pibridge/bridge.go:8–12`
- `internal/pibridge/extension/index.ts:18–20`
- `internal/model/model.go:204, 207–208`
- `README.md:13–31`

---

## 8. Related plan note (`plans/unified-mcp-endpoint.md`)

Quoted from the unified-MCP plan, out-of-scope list (`plans/unified-mcp-endpoint.md:72–76`):

> The `plans/mcp-subagents.md` feature, which lives on the separate `mcp-subagents-plan` branch (commit `a23db03`) and is not merged into this worktree. Note: that plan's Cursor side assumes board access through the command endpoint (its scope section) and its Claude side assumes the per-token `/mcp/<token>` URL. This plan supersedes those two assumptions. If both land, the subagents work must rebase onto fixed URL + header identity and refresh its pre-pi line refs.

That rebase is the reason this architecture note exists: the two assumptions named there are no longer true at HEAD.

---

## Call path (one picture in words)

Agent MCP client
→ `POST http://localhost:6006/mcp` with `Authorization: Bearer <ChatMeta.Token>`
→ Host guard (`localhost:6006` / `127.0.0.1:6006`)
→ `Relay.ServeFixedMCP` / `serveRPC`
→ on `tools/call`: `Chats.ByToken` → `Relay.Call` → `editorbridge.Bridge.Call` (30 s)
→ browser SSE `rpc` on 4747 + `POST /api/rpc-reply`
→ JSON-RPC result `{content:[{type:"text", text}], isError?}`

Caller identity today = the chat’s board token. There is no sid, no per-process credential, and no per-caller tool list.

---

## Unresolved questions

1. Does Cursor open a `GET /mcp` SSE stream in a full tool round-trip against this server? The server answers 405. The unified-MCP plan treated a possible SSE need as a contingency (`plans/unified-mcp-endpoint.md:68–71`). No test in this tree proves Cursor’s live GET behaviour against the current handler.
2. Do Claude or Cursor cache `tools/list` for a connection, so a later per-token filter would not apply until reconnect?
3. Token collision: `randHex(16)` with no uniqueness check. Practical risk is not quantified here.
4. Whether issuing a distinct `BoardAccess.Token` per spawned process would be accepted by each agent’s MCP client (especially Pi children that today inherit env, and Cursor `session/load` if it persisted servers). Not tested.
5. `InstructionsSent` curl-era Cursor chats: token still resolves and MCP `tools/call` returns the legacy error string, but `Send`/`spawn` refuse the chat. Interaction with any future extra tokens is unstated.
