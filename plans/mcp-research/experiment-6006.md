# MCP Feasibility Experiment Report (verbatim from research job)

Environment: macOS, Cursor CLI `agent 2026.09.28-64d2043` (bundled Node v26.8.1), system Node v24.3.0, Python 3.9.6, curl 8.7.1, Claude Code 2.1.284. Scratch files in `/tmp/mcptest/`; all started processes were terminated (verified: port 6006 free, no `agent acp` left). Total wall-clock ~12 min.

## Experiment A — Cursor ACP `mcpServers` connect test

Handshake driven exactly as `internal/cursor/cursor.go`: `initialize` (protocolVersion 1, fs/terminal false, `_meta`) → `authenticate {methodId:"cursor_login"}` → `session/new {cwd:"/tmp", mcpServers:[{type:"http", name:"board", url, headers:[]}]}`. Raw ACP/HTTP logs: `/tmp/mcptest/acp-*.log`, `/tmp/mcptest.log`, agent debug log `$TMPDIR/cursor-agent-logs-<uid>/latest.log`.

### A.1 Schema requirement (new discovery)
`headers` is **required** by the ACP zod schema even for `type:"http"`. Omitting it returns:
```json
{"jsonrpc":"2.0","id":3,"error":{"code":-32603,"message":"Internal error",
 "data":[{"code":"invalid_union","errors":[[{"expected":"array","code":"invalid_type",
 "path":["headers"],"message":"Invalid input"}],...],"path":["mcpServers",0]}]}}
```
With `headers: []` the session is created successfully. Header entry shape (from bundle + verified live): `{"name":"...","value":"..."}`.

### A.2 Variant results (fresh `agent acp` per run, dummy server on 127.0.0.1 + ::1:6006)

| URL passed to `session/new` | HTTP reqs received | Outcome |
|---|---|---|
| `http://localhost:6006/mcp` | **yes — 3** | **CONNECTED** |
| `http://localhost:6006/mcp?token=aaaa…` | 0 | blocked by team policy |
| `http://127.0.0.1:6006/mcp?token=aaaa…` | 0 | blocked by team policy |
| `http://localhost:6006/mcp/<32hex>` | 0 | blocked by team policy |
| `http://127.0.0.1:6006/mcp` (no query) | 0 | blocked by team policy |
| `http://[::1]:6006/mcp` | 0 | blocked by team policy |
| `http://localhost:6006/mcp?` (empty query) | 0 | blocked by team policy |
| `http://localhost:6006/mcp?foo=bar` | 0 | blocked by team policy |
| `http://localhost:6006/mcp/` (trailing slash) | 0 | blocked by team policy |
| `?token=…` + `agent --approve-mcps acp` | 0 | still blocked by team policy |

`session/new` returned a valid `sessionId` in **every** case (including blocked ones); the block is not surfaced over JSON-RPC.

Successful connection raw evidence (dummy server log, trimmed):
```
REQ remote=::1 local=::1 POST /mcp headers={"host":"localhost:6006",
  "user-agent":"Cursor/1.0.0","content-type":"application/json",
  "accept":"application/json, text/event-stream"}
  body={"method":"initialize","params":{"protocolVersion":"2025-11-25",
  ...clientInfo":{"name":"Cursor","version":"1.0.0"}},"id":0}
REQ ... POST /mcp body={"method":"notifications/initialized",...}     -> 202
REQ ... GET  /mcp (Accept: text/event-stream)
```
(`tools/list` was not observed within the ~12 s window; tool listing appears to be lazy/at prompt time.)

### A.3 Exact block wording (from Cursor's own debug log — ACP hides it)
```
[2026-10-02T10:22:02.133Z] Failed to load ACP session MCP server:
  {"serverName":"board","error":"Blocked by team policy"}
```
No "not on the team network allowlist" wording appeared in any variant.

### A.4 Custom headers work on the exact approved URL
`http://localhost:6006/mcp` with
`headers:[{"name":"Authorization","value":"Bearer aaaa…"},{"name":"X-Board-Token","value":"aaaa…"}]`
→ **CONNECTED**; server logged both headers verbatim on the POSTs and the GET.

### A.5 Static confirmation from the installed bundle
`~/.local/share/cursor-agent/versions/2026.09.28-64d2043/*.js`:
- ACP MCP-load failures are caught and only logged (`"Failed to load ACP session MCP server:"`); the session is still created.
- Policy check `Ep({failOpenWhenEmpty,server,settings})` consults `settings.allowedMcpConfiguration.requireMcpServersInTeamNetworkAllowlist` + `settings.networkAllowlist` for `server.url`.
- Error strings: reason `teamNetworkAllowlist` → `"MCP server \"<name>\" is not on the team network allowlist"`; otherwise `"MCP server \"<name>\" is blocked by team policy"`.
- Debug log file is always on unless `CURSOR_AGENT_DISABLE_DEBUG_LOG` is set; path `$TMPDIR/cursor-agent-logs-<uid>/latest.log`.

## Experiment B — localhost / IPv4 / IPv6

| Listener | Node v24.3.0 `fetch('http://localhost:6006/')` | Cursor's Node v26.8.1 | Python 3.9.6 urllib | curl |
|---|---|---|---|---|
| only `127.0.0.1` | ok `from 127.0.0.1` | ok `from 127.0.0.1` | ok `from 127.0.0.1` | 200 `remote_ip=127.0.0.1` |
| only `::1` | ok `from ::1` | ok `from ::1` | ok `from ::1` | 200 `remote_ip=::1` |
| both | ok `from ::1` | ok `from ::1` | ok `from ::1` | 200 `remote_ip=::1` |

With only `::1` bound, `fetch('http://127.0.0.1:6006/')` fails `ECONNREFUSED`. All runtimes fall back correctly from `localhost` to whichever family is listening; when both exist, `::1` is preferred (consistent with Experiment A's `remote=::1`).

## Experiment C — Claude MCP capabilities (help text only, no model calls)

`claude 2.1.284`. Confirmed from `claude mcp --help` / `claude mcp add --help`:
```
# Add HTTP server with headers:
claude mcp add --transport http corridor https://app.corridor.dev/api/mcp \
  --header "Authorization: Bearer ..."
...
-H, --header <header...>     Set headers for HTTP/SSE servers (e.g. -H "X-Api-Key: abc123" ...)
-t, --transport <transport>  Transport type (stdio, sse, http)
```
Top-level: `--mcp-config <configs...>  Load MCP servers from JSON files or strings`; `--strict-mcp-config`; `claude mcp add-json <name> <json>` accepts "stdio, SSE, HTTP, or WebSocket". Claude CLI therefore supports HTTP URL + custom headers and JSON configs. Actual query-string behavior was not exhaustively tested (would require writing config or a live session).

## CONFIRMED
- ACP `session/new.mcpServers` HTTP entry requires `headers` array; `{name,value}` objects; custom headers reach the server.
- Exact URL `http://localhost:6006/mcp` connects; Cursor speaks MCP 2025-11-25 (initialize, notifications/initialized, SSE GET) from `user-agent: Cursor/1.0.0`.
- The org allowlist behaves as an exact full-URL match: query (`?token`, `?`, `?foo=bar`), path segment, trailing slash, and host variants (`127.0.0.1`, `[::1]`) are all rejected with exactly `"Blocked by team policy"`.
- The block is server-side policy, not local approval: `--approve-mcps` does not override it; no approval prompt appeared.
- ACP reports `session/new` success even when the MCP server is blocked; the error exists only in the debug log.
- `localhost` reaches a v4-only or v6-only listener in all tested runtimes; `::1` is preferred when both exist.

## NEGATIVE
- Any URL modification of the approved URL does not connect. Per-chat token via query parameter or path token is currently unusable with Cursor's ACP MCP mechanism.
- There is no ACP-level error notification for a blocked MCP server (silent drop), so the app cannot detect the block from the JSON-RPC result.
- No "not on the team network allowlist" reason was observed; the failure mode is the generic team-policy block.

## NOT TESTED / CAVEATS
- Real `tools/list`/tool-call round-trip after connection (would require a `session/prompt` / paid model call).
- Exact Claude Code query-string handling (no config writes/live runs to stay read-only and free).
- The server-side matching algorithm itself (only observed behavior; the comparison runs on Cursor's backend).
- Repeated runs under a permanently changed org policy; results reflect the policy cache on this machine today.

## Implications for the unified URL design
1. Serve MCP at exactly `http://localhost:6006/mcp` — no query, no trailing slash, advertised verbatim.
2. Pass the per-chat token as an HTTP header (`Authorization: Bearer <token>` and/or `X-Board-Token`), because header-bearing requests to the exact URL connect and headers are forwarded.
3. Do not use `127.0.0.1` or `[::1]` in the configured URL; only the `localhost` spelling passes policy.
4. Binding the listener to `127.0.0.1` alone is reachable via `localhost` from Node 24/26, Python, and curl (fallback observed); binding both makes `::1` the effective connection path.
5. `--approve-mcps`/local approvals are irrelevant here; the gate is the org's server-side allowlist, so no client-side workaround exists.
6. Since ACP hides load failures, any status/health indication must come from the app/MCP server side (e.g. server access log or a token-authenticated heartbeat).
7. The same fixed `/mcp` + `Authorization` header shape is supported by Claude Code (`--header` / `--mcp-config` JSON) and by Cursor ACP `headers:[{name,value}]`, so one URL design can serve both.
8. Repo note: `internal/cursor/cursor.go` currently sends `session/new` with `"mcpServers": []`; the tested path above requires populating that field, otherwise the curl workaround remains necessary.
