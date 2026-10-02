# Unified MCP endpoint at `http://localhost:6006/mcp`

Status: accepted after independent review (three reviews: one MUST_FIX followed by fix rounds and two PASS), updated with the owner decisions recorded in §11, and refreshed after P0 landed (local `main` is already merged into this worktree); one question (token policy) remains open. Scope: board tool access for all coding agents (Claude Code, Cursor, pi).
No implementation code, pseudocode, exact signatures, field schemas or internal algorithms; this
document fixes decisions, ownership, flows, phases and acceptance so implementation can proceed
without re-deriving them.

Evidence base (durable copies under `plans/mcp-research/`, with the review trail):

- `plans/mcp-research/facts-digest.md` — synthesis of four read-only research jobs, with
  file:line references against worktree HEAD `ea03c97` and local `main` `669487f`.
- `plans/mcp-research/experiment-6006.md` — live feasibility experiment on this machine
  (Cursor CLI `2026.09.28-64d2043`, Claude Code 2.1.284). The org admin's approval of exactly
  `http://localhost:6006/mcp` is verified there.
- `plans/mcp-research/run-token-removal.md` — run-token uses on `main`, the removal blast
  radius, and the rejected chat-id bridge re-key.
- `plans/mcp-research/review-1.md` (MUST_FIX), `review-2.md` and `review-3.md` (PASS) — the
  independent reviews and the fix rounds they drove.

All file:line references below are relative to the current merged worktree HEAD (`704dbf2`: local
`main` `eaa7cdd` plus this plan commit) and were refreshed after P0 landed. References in the
research copies under `plans/mcp-research/` still quote their original commits (`ea03c97`,
`669487f`) and are left as the historical record.

P0 is done: local `main` (the pi agent landed in `71d0418`–`f7972e4`/`669487f`; current head
`eaa7cdd`) is an ancestor of this worktree's HEAD, so what remains of P0 is only its post-merge
verify pass (§9).

---

## 1. Goal

All board chats, for every supported agent, get their board tools from one MCP server advertised
at exactly `http://localhost:6006/mcp`. Per-chat identity travels in an HTTP header, never in the
URL. The Cursor-only command endpoint (`/agent/{token}/{tool}`) and all curl-based instruction,
recognition and auto-approval machinery are removed. The app keeps its normal HTTP surface on
`127.0.0.1:4747`; the desktop app, `launch`/`relaunch`/`stop` and `server.json` are unaffected.

## 2. Scope

### In scope

- A second loopback listener on port 6006, in the app's own process, serving only the MCP
  endpoint at path `/mcp`.
- Per-chat credential transport via HTTP header on that endpoint: the chat's durable board
  token, for Claude, Cursor and pi alike.
- Agent-side configuration changes: Claude (`--mcp-config`), Cursor ACP `session/new` and
  `session/load`, pi's `AIWB_MCP_CONFIG`.
- Removal of the command endpoint, `ParseCommand`, curl prompting, and the command-specific
  Cursor recognition and auto-approval branches.
- Merge of local `main` (pi) into the worktree — done as P0; owner-confirmed as the first step,
  with the frozen pi MCP config contract updated in this migration (former Q8, §7.7).
- Server-side diagnostics for MCP connections, because Cursor's ACP layer hides MCP load
  failures.
- Tests, fixtures, e2e steps and README updates listed per phase in §9.

### Out of scope

- Any UI redesign; board tool cards and labels stay as they are (`mcp__board__*` is already the
  transport-agnostic name, see `web/src/logic/labels.ts:22,44` and `web/src/ChatView.tsx:17,179`).
- A visible UI warning/badge for a board chat whose agent never initialized. Owner-decided: it is
  deferred beyond v1 and is not required; logs, the read-only status surface, README
  troubleshooting and the permanent URL-audit test guard are the v1 diagnostics (D12, §7.9).
- Changing the app port, Electron behaviour, `server.json`, or the `/api/*` surface (beyond the
  read-only MCP status endpoint, D12, P4).
- MCP features beyond a stateless request/response surface: token expiry/rotation, session
  persistence, server-initiated SSE push/notifications, OAuth, and other MCP features. Single
  contingency: if the P3 live Cursor trace shows the client needs a minimal SSE stream on
  `GET /mcp` to complete a tool round-trip, adding exactly that stream is in scope (see §11
  assumptions);
  no other session/notification feature is.
- The `plans/mcp-subagents.md` feature, which lives on the separate `mcp-subagents-plan` branch
  (commit `a23db03`) and is not merged into this worktree. Note: that plan's Cursor side assumes
  board access through the command endpoint (its scope section) and its Claude side assumes the
  per-token `/mcp/<token>` URL. This plan supersedes those two assumptions. If both land, the
  subagents work must rebase onto fixed URL + header identity and refresh its pre-pi line refs.

## 3. Requirements

Functional:

1. The app serves MCP at exactly the URL string `http://localhost:6006/mcp` (no query, no path
   token, no trailing slash), for every board chat of every agent.
2. Each board tool request is attributed to a chat by a per-chat credential in an HTTP header.
   The board token must never appear in a URL that any agent process receives. For pi, the board
   token appears only inside the board MCP config value (`AIWB_MCP_CONFIG`) and never in argv;
   the old run-token-as-credential mechanism is gone.
3. Claude board chats, Cursor board chats and pi board chats can each list and call every
   `boardtools.Tools` tool through that endpoint.
4. The command surface is gone: no `/agent/{token}/{tool}` route, no `ParseCommand`, no curl
   instructions in any prompt, no command-specific tool normalization or auto-approval.
5. Board calls keep the existing semantics: go through the active browser client, 30 s timeout,
   errors returned to the agent as tool text (`internal/boardapi/mcp.go`, `internal/editorbridge`).
6. Unknown/missing credentials, archived chats, deleted chats, no active browser client, and a
   port-6006 conflict all have defined, observable behaviour (§8.6).
7. The app still listens on and serves the normal HTTP surface (client, `/api/*`) on 4747, and
   `launch`, `relaunch`, `stop`, `server.json` and the Electron app behave as before.

Non-functional:

1. No new external process or proxy: the MCP listener shares the app's in-process `Bridge`,
   `Chats` and `Boards` singletons.
2. The listener binds only loopback (`127.0.0.1`), never all interfaces.
3. The exact advertised URL is pinned by tests for every spawner, so an accidental query
   parameter, `127.0.0.1` spelling, or trailing slash fails CI rather than silently breaking
   Cursor in production.
4. Diagnostics identify, server-side, which agent connected for which chat, without logging raw
   tokens.
5. All existing Go, web and desktop tests pass; the e2e Cursor board-turn test passes using real
   Cursor over MCP.

## 4. Constraints (verified)

- **Org policy is an exact full-URL match.** Only `http://localhost:6006/mcp` connected; adding a
  query (even `?` alone or `?foo=bar`), a path segment, a trailing slash, or changing the host to
  `127.0.0.1` or `[::1]` produced zero HTTP requests and `"Blocked by team policy"` in Cursor's
  debug log (experiment A.2). `--approve-mcps` does not override it (A.2). This is a server-side
  org policy, not a local prompt.
- **Headers on that exact URL are forwarded and accepted.** `Authorization` and a custom header
  both reached the server verbatim on POST and GET (experiment A.4). This is the only viable
  per-chat identity channel for Cursor.
- **ACP hides MCP load failures.** `session/new` returns a valid session id even when the server
  is blocked; the failure exists only in `$TMPDIR/cursor-agent-logs-<uid>/latest.log`
  (experiment A.2, A.3). Any status indication must come from the app side.
- **The org admin has confirmed the approval (owner-relayed, resolving former Q6).** The approved
  entry is exactly `http://localhost:6006/mcp`, adding headers does not invalidate the approval,
  and no dev-machine-specific variant is needed. The live URL-audit guard in tests stays
  (§7.9, §10.4).
- **Cursor ACP requires a `headers` array for an HTTP MCP entry**, even when empty; entries are
  name/value pairs (experiment A.1). Plain Cursor chats keep the empty array.
- **Cursor's MCP client opened a `GET /mcp` SSE request** after `initialize` and
  `notifications/initialized`; no `tools/list` was observed in the short experiment window
  (A.2). Whether discovery is lazy, and the full tool round-trip, are the assumptions in §11.
- **Claude Code 2.1.284 supports HTTP MCP with custom headers** (`claude mcp add --transport http
  --header …`, top-level `--mcp-config <files-or-strings>`, `-H/--header`) (experiment C). The
  installed binary's schema strings include `headers` among server fields. The exact header value
  encoding inside a `--mcp-config` string is not yet live-verified.
- **`localhost` reaches a 127.0.0.1-only listener** from the installed Node 24/26 (which is what
  Cursor bundles), Python and curl; with both families bound, `::1` is preferred (experiment B).
- **Port 6006 is free and unreferenced in the repo today** (grep over HEAD and `main`; experiment
  ran with it free).
- **The app is a single-listener process today.** One `127.0.0.1:<port>` listener (default 4747),
  `BaseURL` built from it, and one `server.json` pid+port driving launch/relaunch/stop
  (`cmd/ai-whiteboard/main.go:92,123,136,183,196`; `internal/store/store.go:110-134`; desktop
  health-checks `<origin>/api/hello`, `desktop/lib.js:135-139`).
- **Board identity is a per-chat secret token**, minted for board chats only
  (`internal/chats/manager.go:366-369`), stored in `ChatMeta.Token`
  (`internal/model/model.go:204`), never rotated, resolved by linear scan
  (`internal/chats/manager.go:998-1012`). It is the only MCP credential after this migration;
  the header value is unambiguous, so no resolution step is needed.
- **Pi's current contract (merged with `main`; replaced by this plan)**: `AIWB_BRIDGE_RUN` is
  presented as the only credential pi sees and the board token must never reach pi env/argv
  (`internal/agent/bridge.go:5-20`, tests `internal/pi/args_test.go:141-145`,
  `internal/pi/pi_test.go:199-207`). The run token also carries bridge frame routing,
  permission/notice routing, subagent-tree abort and run lifecycle, which survive only as a
  non-secret bridge handle (D15). The pi extension already supports an MCP `headers` object and
  fetches the URL verbatim (`internal/pibridge/extension/mcp.ts:239-267,440-453`), so it needs no
  runtime change.
- **The command endpoint is Cursor-only and has no other reader.** `CommandURL` is built in
  `internal/chats/manager.go:473-476` but has no production reader at all (only the adapter test
  fixture `internal/cursor/cursor_test.go:536` sets it); the manager's prompt block at
  `internal/chats/manager.go:597-602` builds its own URL from `BaseURL`. The real Cursor access is
  the curl command taught by `internal/prompts/prompts.go:33-87` and recognized by
  `internal/cursor/cursor.go:651,758` and `internal/boardtools/command.go:9`.
- **Existing tests pin the old shapes**, notably
  `internal/boardapi/boardapi_test.go:62-63,68-89,201`,
  `internal/chats/manager_test.go:841,852-861`, `internal/claude/args_test.go:54-59`,
  `internal/boardtools/boardtools_test.go:37-83`, `internal/prompts/prompts_test.go:11,28-51`,
  `internal/cursor/cursor_test.go:25,536,591`, and `web/e2e/app.e2e.mjs:380-388,503-521`.
- **Process-level tests start the real binary on ephemeral ports**
  (`cmd/ai-whiteboard/relaunch_test.go:22-49`, `agents_stop_test.go:49`,
  `launch_race_test.go:55`). A hard-coded 6006 would make those tests collide with each other and
  with a running app, so a hidden test-only port override is required (D10); there is no
  user-facing port flag (owner-confirmed, former Q3). The e2e exception is owner-decided: real
  Cursor needs the fixed URL, so the suite owns 6006 by default and can use the override only with
  `AIWB_E2E_SKIP_CURSOR_MCP` set (D14, §10.2).

## 5. Acceptance criteria

1. **URL and identity**: every agent's board MCP configuration names exactly
   `http://localhost:6006/mcp` (pinned by unit tests, including manager-level assertions of the
   actual board-access value handed to each spawner — Claude and pi from P2, Cursor from P3 — not
   only each spawner's own test input) and carries the chat's board token in an HTTP header; no
   agent URL contains a token.
2. **Claude**: a real Claude board chat can read and edit a board through the 6006 endpoint
   (tool cards named `mcp__board__*`, no approval cards). Context-split forks keep working.
3. **Cursor**: a real Cursor board chat can read and edit a board through the 6006 endpoint; no
   approval card appears; the server sees the request from Cursor; Cursor's debug log contains no
   `Failed to load ACP session MCP server` / `Blocked by team policy` line for the board server.
4. **Pi**: on the merged tree, the shared board-access value, pi's migrated consumption and the
   run-token credential removal land in one change (P2); a real pi board chat calls board tools
   through the same endpoint with the board token in the header; the board token appears only
   inside `AIWB_MCP_CONFIG`, never in argv or a URL; the non-secret bridge handle still routes
   permissions, notices and subagent-tree aborts; existing bridge routing/abort/replacement tests
   pass, and pi tests pass after the contract comment and pinned expectations are updated.
5. **Removal**: `/agent/{token}/{tool}` answers 404 and no code, prompt, test or doc references
   the command mechanism (`ParseCommand`, `commandRe`, `ServeCommand`, `CommandURL`,
   `CursorInstructions`, `cursorTools`, curl examples or `<board-api>` blocks). `/mcp/{token}` is
   also gone by the end; `/mcp` on 6006 is the only MCP route. `InstructionsSent` stays (Cursor
   still gets one first-message instructions block), but it carries the shared MCP wording.
6. **App unaffected**: the client, `/api/*`, `launch`/`relaunch`/`stop`, `server.json` and the
   Electron app work as before on 4747.
7. **Failure behaviour**: with 6006 occupied the app refuses to start with a clear message naming
   the port and the likely holder, telling the user to stop the running instance / free 6006
   (D11; decided, no run-without-MCP mode); `serve` prints that message, `launch`/`relaunch`
   report the server stopped while starting with the message in the log tail, and the e2e run
   fails fast before touching the app when 6006 cannot be acquired, with the same explicit
   message and no timeout or silent skip (D14); an unknown credential produces a tool-result
   error, not a crash; archived and no-client behaviour is unchanged.
8. **Diagnostics**: `server.log` records one line per MCP initialize/call with chat id and client
   name; a read-only status surface reports listener state and last contact per chat; README
   documents how to verify a Cursor connection; the URL-audit unit-test guard stays. No visible
   UI warning is required for v1 (D12; the badge idea is deferred, §11).
9. **Suites**: `go test ./...`, `cd web && npm test`, `cd desktop && npm test` pass; the e2e run
   passes under the decided contract (D14, §10.2): by default the updated Cursor step runs real
   Cursor through MCP over the fixed URL, which requires exclusive 6006 and otherwise fails fast
   with the explicit 6006 message; with `AIWB_E2E_SKIP_CURSOR_MCP` set the Cursor MCP steps are
   reported as skipped and the rest of the suite (including the Claude board steps) runs against
   the hidden test-only MCP port override while a normal app instance may keep 6006.

## 6. Design decisions

| # | Decision | Rationale / evidence |
|---|----------|----------------------|
| D1 | One fixed URL `http://localhost:6006/mcp`, per-chat credential in an HTTP header (`Authorization: Bearer <token>`) | Only the exact URL passes the org allowlist; headers are forwarded on it (A.2, A.4). Query/path tokens are unusable with Cursor and would leak tokens into URLs/logs. |
| D2 | A second loopback listener on 6006 inside the app process; keep 4747 as the app URL | The app URL is embedded in Electron discovery, `server.json`, `launch`/`stop` and e2e (all verified). Moving the app to 6006 churns all of that and gives no policy benefit; an external proxy adds an unmanaged process and would fail the existing Host guard. Sharing the process also shares `Bridge`/`Chats`. |
| D3 | Advertise only the `localhost` spelling; never `127.0.0.1` or `[::1]` in a configured URL | Exact-match policy (A.2). `localhost` reaches a v4-only listener in all tested runtimes (B). |
| D4 | Bind the MCP listener to `127.0.0.1` only | Matches the existing server's security posture; no LAN exposure; verified reachable via `localhost` (B). Two-family binding buys nothing. |
| D5 | The header is the single credential channel for all agents and always carries the chat's durable board token; there is no run-token resolution step | One shape for all clients, and pi now works exactly like Claude/Cursor. Keeps the token out of URLs. The former resolver (`Relay.Runs`/`RunResolver`/`Bridge.ResolveBoardToken`) is deleted. |
| D6 | Keep the old `/mcp/{token}` route only during migration; delete it at the end. Delete `/agent/...` with the Cursor migration | Owner-confirmed (former Q1): there are no external consumers, so both legacy routes are removed outright and the staging is an in-flight ordering rule, not a compatibility commitment. Agents are children of the server and are ended on `stop`/relaunch (`cmd/ai-whiteboard/main.go` shutdown path), so no live process keeps using an old URL across an upgrade. The shared fixed value and pi's consumption migrate together (P2), so no phase lands the fixed value while a per-chat-URL consumer still runs. The end state must be one unified URL (owner goal). |
| D7 | Remove the command endpoint, `ParseCommand`, curl prompting, the per-message `<board-api>` block and the command branches in Cursor normalization/auto-approval | Owner request; no longer needed once Cursor speaks MCP; removes the token-in-URL surface and a brittle command regex. |
| D8 | Keep `initialize`/`tools/list` permissive (no token rejection); unknown credentials surface on `tools/call` as tool-result error text, and are logged | The permissive handshake matches today's `initialize`/`tools/list` behaviour (`internal/boardapi/mcp.go`); the unknown-credential log line is new work (§7.9). Cursor hides load failures anyway (A.2), so rejection adds no Cursor signal and would break diagnostic handshakes. Claude sees the tool error. |
| D9 | Cursor board MCP calls are auto-approved by the adapter, not by writing `Mcp(...)` allow rules into the user's Cursor config | The adapter already auto-approves in `onRequest`; keeping the decision in-process mirrors existing behaviour, keeps the user's config footprint minimal (`EnsureDenyRules` writes only denies), and avoids broad allow rules. |
| D10 | Add a hidden test-only MCP port override (default 6006); production always advertises the exact 6006 URL; no user-facing port flag | Fixed 6006 is machine-global; process tests start real servers on ephemeral app ports and would collide with a running app and with each other (verified in `cmd/ai-whiteboard/*_test.go`). Unit tests call the handler directly; e2e uses the real 6006 by default and the override only in the `AIWB_E2E_SKIP_CURSOR_MCP` path (D14). A user-facing switch would invite changing the port, which breaks Cursor's exact-URL allowlist (owner-confirmed, former Q3). |
| D11 | If 6006 cannot be bound, the server fails at startup with a message naming the port (and hints that another AI Whiteboard instance or program may hold it), before writing `server.json` | Owner-decided (former Q2); the "run without MCP and warn" alternative is rejected. Silent degradation would recreate exactly the Cursor silent-failure problem for all agents. Fail-fast matches the existing 4747 behaviour and `launch`'s "stopped while starting" reporting. The e2e harness applies the same policy and the same message when it cannot acquire 6006 (D14). |
| D12 | Diagnostics live on the app side: structured MCP access logging (client name, chat id, method; never the raw token) plus a read-only status endpoint on 4747. No visible UI warning in v1 | Cursor gives no ACP-level signal (A.2/A.3); the app is the only party that can observe a connection. Owner-decided (former Q5): logs, status, README and the permanent URL-audit guard are sufficient; a badge/warning for a chat whose agent never initialized is deferred, not required. |
| D13 | No client-side workarounds (`--approve-mcps`, `.cursor/mcp.json`, OAuth) | The gate is the org's server-side allowlist (A.2/A.5); the URL is already approved. |
| D14 | E2E owns 6006 by default: real Cursor over the fixed URL, with fail-fast using the explicit 6006 message if the port cannot be acquired. With `AIWB_E2E_SKIP_CURSOR_MCP` set, the real-Cursor-MCP steps are reported as skipped and the rest of the suite uses the hidden test-only MCP port override, so a normal app instance may keep 6006. The real-Cursor-on-6006 round-trip stays covered by the manual acceptance gate (§10.3); CI may use the skip flag plus the fake ACP Cursor harness | The URL cannot be randomized in the Cursor path (exact-match policy, §4), so the real-Cursor step needs exclusive 6006; a timeout or silent skip would hide the failure (same reasoning as D11). The skip flag keeps Claude board coverage and the MCP transport exercised in CI without owning the machine-global port. Owner-decided (former Q4). |
| D15 | Keep a per-run, non-secret bridge handle (`AIWB_BRIDGE_RUN` and the frame `run` field) after removing the credential role; do not re-key the bridge by chat id | The handle is load-bearing for frame routing, permission/notice routing, subagent-tree abort and run lifecycle; per-run replacement makes stale processes no-ops. Re-keying by chat id would let a stale process deregister or abort the chat's new run and would need a new `bridgePresent` signal; keeping the existing names limits churn. The handle is explicitly not a credential and is no longer mapped to the board token. |
| D16 | The durable board token now enters the pi process environment inside `AIWB_MCP_CONFIG` and is inherited by its subagents; argv stays clean | Owner-accepted trade-off of making pi work like Claude/Cursor; bounded by the chat's lifetime. The old invariant "board token never in pi env/argv" becomes "never in argv; only inside the board MCP config". No URL ever carries it. |

## 7. Components and ownership

### 7.1 Network topology

```
Cursor / Claude / pi  --POST http://localhost:6006/mcp  (Authorization: Bearer <board token>)
                              |
                    [MCP listener, 127.0.0.1:6006, in-process]
                              |
                    Relay -> Chats.ByToken -> editorbridge -> browser SSE -> board engine

Browser / Electron --HTTP--> 127.0.0.1:4747  (client, /api/*, status endpoint)   [unchanged]
```

- The two listeners share the process and the `Bridge`, `Chats`, `Boards` singletons.
- Pi additionally keeps its owner-only UDS bridge for permissions, notices, subagent activity and
  abort. That bridge's per-run handle is internal and non-secret and is not part of the MCP path.
- `server.json` records only the 4747 pid/port; `launch`, `relaunch`, `stop` and Electron are
  untouched (verified: `internal/store/store.go:110-134`, `cmd/ai-whiteboard/launch.go`,
  `desktop/lib.js:135-139`).
- The Host check stays on both listeners: the MCP listener accepts `localhost:<mcpPort>` and
  `127.0.0.1:<mcpPort>` only. Because authenticated requests carry `Authorization`, a browser
  cross-origin request would need a preflight, which the server never answers (existing
  rationale in `internal/server/guard.go:14-21`); the MCP listener must not add CORS headers.

### 7.2 The 6006 MCP listener

Owner: `cmd/ai-whiteboard` (lifecycle and wiring) and `internal/server` (handler/guard).

- A dedicated handler served only on 6006 exposes exactly `POST /mcp` (method handling as today:
  non-POST → 405; the existing `GET /mcp` 405 behaviour is kept until a real Cursor round-trip
  says otherwise, §11 assumptions). `GET /api/hello` and the client are not served on 6006.
- The listener binds after the 4747 listener and before `server.json` is written; it is closed by
  process exit. Bind failure is fatal (D11; decided — there is no run-without-MCP mode).
- The guard is parameterised by the port, so it can run on either listener without weakening the
  DNS-rebinding check.
- The existing app mux keeps `/api/*` and the client; the temporary legacy `/mcp/{token}` route
  is removed at the end of the migration (D6).

### 7.3 Request identity and token handling

Owner: `internal/boardapi` (parsing), `internal/chats` (token ownership).

- The fixed handler reads the credential from the request's `Authorization` header in bearer
  form and treats it as a board token. There is no resolver and no run-token credential: the
  resolver-first step (`RunResolver`, `Relay.Runs`) is deleted, as is `Bridge.ResolveBoardToken`
  and the run record's board-token field. The raw token is never logged; `Chats.ByToken` is the
  only token consumer.
- The result is the chat meta used by `Relay.Call`, which keeps its current checks (archived,
  known tool) and returns text + `isError` (today `internal/boardapi/mcp.go:53-79`).
- Per-chat tokens remain in `ChatMeta.Token` and survive restarts via `Load`. Pi still registers
  a per-run bridge handle for permissions/notices/abort, but it is an internal non-secret run
  identifier, no longer minted as a credential and no longer mapped to the board token. No new
  credential storage is introduced.

### 7.4 App HTTP surface on 4747

Owner: `internal/server`, `internal/app`.

- Unchanged: client files, `/api/hello`, events/SSE, chat/board/group routes, permission route.
- Add one read-only diagnostic route (suggested `GET /api/mcp/status`) returning listener
  identity/state and last-contact summaries per chat; GET routes are already exempt from the
  active-client check (`internal/server/guard.go:39-50`), so the page can read it.
- The temporary `/mcp/{token}` route on this listener exists only during migration and is removed
  in the final phase (D6, P5). It must not be deleted early, and it must not be confused with the
  fixed `/mcp` on 6006: the pre-migration pi adapter rewrites the shared `MCPURL` into
  `/mcp/<runToken>`, which can only reach the legacy route, never the 6006 listener. The atomic
  P2 ordering rule exists so no such client remains once the fixed value lands.

### 7.5 Claude integration

Owner: `internal/claude`, with the shared board-access value from `internal/chats`.

- The spawner's board configuration is built from one shared endpoint URL plus the chat's token
  and adds the credential as an HTTP header in the MCP config (`internal/claude/claude.go:58-83`
  builds today's config). The allowed-tools list stays `mcp__board__*`.
- The context-split fork uses the same board-access value
  (`internal/claude/ctxsplit.go:88-93`), so forks automatically inherit the header config.
- The prompt is unchanged (`prompts.Claude()` already says MCP tools).
- Prerequisite spike: confirm the exact header encoding accepted inside `--mcp-config` against a
  stub server before wiring the real endpoint (see §11 assumptions).

### 7.6 Cursor integration

Owner: `internal/cursor`, with the shared board-access value from `internal/chats`.

- `session/new` and `session/load` both receive the board server entry: HTTP type, the fixed URL,
  and a one-entry headers array carrying the bearer credential
  (`internal/cursor/cursor.go:197,205` today send an empty `mcpServers` array; A.1 requires the
  `headers` array to exist). Plain chats keep an empty array.
- Tool normalization: Cursor's MCP tool calls must be recognized and presented as
  `mcp__board__<tool>` with the tool's arguments, exactly as command calls are today
  (`internal/cursor/cursor.go:638-673`). Evidence from the installed bundle: MCP calls arrive as
  kind `other`, titled `<server>: <tool>` (server name `board`), with provider/tool/argument
  information in the raw input (bundle inspection in the digest). The precise wire shape must be
  confirmed from a real trace during this phase (see §11 assumptions).
- Permissions: the command-recognition auto-approve branch (`internal/cursor/cursor.go:758`) is
  replaced by recognition of board MCP calls; only those are auto-approved (D9). Everything else
  keeps existing behaviour (app-folder denial and the normal permission card). Handle the
  `allow_always` option kind defensively if Cursor offers it.
- Remove the command path entirely: `/agent` route (`internal/server/server.go:602`),
  `ServeCommand` (`internal/boardapi/command.go`), `ParseCommand` and its regex
  (`internal/boardtools/command.go`), Cursor command normalization/approval branches,
  `prompts.CursorInstructions`/`cursorTools` (`internal/prompts/prompts.go:33-87`) and the
  per-message URL block (`internal/chats/manager.go:597-602`). Cursor's first-message
  instructions become the shared MCP board-tool wording — the existing `prompts.Pi()` renderer
  (`internal/prompts/prompts.go:29-31`; note it is not wrapped in `<whiteboard-instructions>`
  like `CursorInstructions`), possibly renamed agent-neutral — still sent once and gated by
  `InstructionsSent`, with no URL block (§7.8 names what is deleted and what replaces it).

### 7.7 Pi integration (merged `main`)

Owner: `internal/pi` and the frozen contract in `internal/agent/bridge.go`; the pi extension
itself does not need runtime changes.

- Pi gets board access exactly like Claude and Cursor: the adapter injects `AIWB_MCP_CONFIG` with
  the fixed URL and the chat's board token in the config's `headers` object; the extension already
  forwards headers (`internal/pibridge/extension/mcp.ts:239-267,440-453`). The pi config type
  gains a `headers` field (`mcpServerConfig`, `internal/pi/args.go:80-83`, which has only
  `type`/`url` today). The `/mcp/<runToken>` URL rewrite (`internal/pi/args.go:92-116`) is
  deleted, and the board config no longer depends on a run token.
- The per-run bridge handle survives under its existing env/frame names for permissions, notices,
  subagent activity, abort and run lifecycle (D15). It is documented as an internal non-secret run
  identifier, not a credential, and is not mapped to the board token; the run record's
  board-token field and `Bridge.ResolveBoardToken` are deleted.
- The three-way frozen contract comment (`internal/agent/bridge.go:5-20`), the extension comment
  that claims "the board token never enters the pi process"
  (`internal/pibridge/extension/index.ts:18`) and the `README.md` pi wording must be updated in
  the same change: argv stays clean, the board token appears only inside `AIWB_MCP_CONFIG` for
  board chats, `AIWB_BRIDGE_RUN` is a non-secret bridge run handle. The owner has accepted the
  resulting security trade-off (D16): the board token now enters the pi process env and is
  inherited by its subagents, bounded by chat lifetime.
- The manager passes the same shared board-access value (fixed URL + board token) to the pi
  spawner as to Claude and Cursor.

Sequencing (mandatory): the manager's shared board-access value, this pi consumption change and
the credential-mapping deletion land in the same phase/change (P2). The pre-migration adapter
rewrites `Board.MCPURL` into `/mcp/<runToken>`, which the 6006 listener does not serve; therefore
no change may ship the fixed value in `spawnOptions` while this migration is still pending. Claude
migrates in the same phase; Cursor does not read the shared value (its command URL is built from
`BaseURL`), so it cannot enter this window.

### 7.8 Removal of the command endpoint and curl-based prompting

Owner: `internal/boardapi`, `internal/boardtools`, `internal/prompts`, `internal/chats`.

Deletions, in dependency order:

1. Cursor starts using MCP (7.6) and tests prove a board edit; the command path is still present
   until then.
2. Delete the `/agent` route and handler, `ParseCommand` and `internal/boardtools/command.go`,
   the Cursor command branches, `CommandURL` in the board-access value
   (`internal/agent/agent.go:25-29`), and the manager's cursor prompt block.
3. Delete `CursorInstructions` and `cursorTools` and their tests. Cursor keeps a first-message
   instructions block (still written once, gated by `InstructionsSent`), now rendered with the
   shared MCP board-tool wording used by pi — the existing `prompts.Pi()` renderer
   (`internal/prompts/prompts.go:29-31`), possibly renamed agent-neutral — with no `<board-api>`
   URL block. Keep `Claude()` and that MCP instructions function.
4. Remove the temporary `/mcp/{token}` route and update comments that describe two surfaces
   (`internal/boardapi/mcp.go` package doc, `internal/server/guard.go` comment,
   `internal/model/model.go:204` token comment, `README.md`).
5. Sweep tests, fixtures and docs (§9, §10).

Migration caveat: Cursor chats created before this change keep the old curl instructions in their
stored chat history. After `/agent` is removed the model may keep trying the dead endpoint until
the context rolls past those stored messages; the failed calls surface as tool-output errors and
the server log/status shows no MCP contact for the chat. No special handling is planned beyond
making the failure observable.

### 7.9 Diagnostics (because Cursor is silent)

Owner: `internal/boardapi` (observation), `internal/server` (exposure), docs.

- On every MCP `initialize`, record the client name/version and the resolved chat; on every
  `tools/call`, record the short chat id, tool, and outcome. One structured log line each; never
  the token. `initialize` from an unresolvable credential is logged as unknown and answered
  normally (D8).
- Expose listener state and last-contact-per-chat on 4747 for the page and for manual checks.
- Owner-decided for v1: no visible UI warning. Logs, this status surface, README troubleshooting
  and the permanent URL-audit guard are sufficient; a badge/warning on a board chat whose agent
  never initialized is deferred, not required (D12, former Q5, §11).
- README troubleshooting: the curl probe (POST with the header), the server log lines, and the
  Cursor debug-log check for `Failed to load ACP session MCP server`.

### 7.10 Web and desktop

- Web: no functional change expected because tool names remain `mcp__board__*`; no test changes
  expected beyond e2e (which does not inspect transport).
- Desktop: no change; it still discovers the app URL via `launch` and health-checks 4747.

## 8. Operations and flows

### 8.1 Startup and lifecycle

1. Same as today: `findRunning` decides whether to print "already running".
2. Bind 4747 (existing); bind 127.0.0.1:6006 (new). Either failure is fatal, before
   `server.json` is written. A 6006 conflict is a decided fail-fast (D11): the app exits with an
   explicit error naming port 6006, the likely holder (another AI Whiteboard instance, e.g. with
   a different data folder, or an unrelated program) and the remedy (stop that instance / free
   6006). There is no "start without MCP and warn" mode. `serve` prints that error;
   `launch`/`relaunch` surface their existing "the server stopped while starting" failure with
   the log tail containing it; a developer or e2e user sees the same message and must stop the
   instance holding 6006 before retrying. The e2e harness applies the identical policy and message
   when it cannot acquire 6006 (D14, §10.2).
3. Open store, load boards/chats, construct the `Relay` (board-token identity only), start the pi
   bridge (as it exists today, minus the resolver wiring), construct the HTTP servers.
4. Write `server.json` (4747 only); log the app URL and the MCP endpoint.
5. Serve both listeners; the MCP listener is served in a goroutine. SIGINT/SIGTERM takes the
   existing path (flush bridge, shut chats, end agents, remove `server.json`, exit), which also
   closes both listeners.
6. Optional: an in-process self-probe of the exact URL over `localhost` at startup, logged as a
   diagnostic (decision for the implementer; not required by acceptance).

### 8.2 Chat and agent spawn/resume

- Spawn/lock/Configure flows are unchanged. `spawnOptions` builds one shared board-access value
  (fixed endpoint URL + the chat's token) for board chats; plain chats get none
  (today `internal/chats/manager.go:467-478`). This value change is atomic with pi's migration
  (P2): the pre-migration pi adapter rewrites `Board.MCPURL` to `/mcp/<runToken>`, which only the
  legacy 4747 route serves, so landing the fixed value while pi still rewrites it would silently
  remove
  pi's board tools. Claude migrates in the same phase; Cursor's command path reads `BaseURL`, not
  the shared value, so it stays working until its own phase.
- Claude: new sessions get the MCP config plus allowed tools; resumes add the same config.
  Context-split forks reuse it.
- Cursor: `session/new` for a new chat and `session/load` for a locked chat both receive the
  board server entry; the app already re-invokes the handshake on resume
  (`internal/cursor/cursor.go:108-229`). Confirm that Cursor does not persist MCP servers across
  `session/load` in its own session store; the plan assumes it does not and passes them again
  (§11 assumptions).
- Pi: each spawn registers a bridge run whose handle is a per-run, non-secret identifier; the
  adapter injects the fixed URL plus the board-token header. The handle is released on exit or
  retired by the next run's registration (`internal/pibridge/bridge.go:196-223`). Subagent
  runs inherit the parent's bridge handle and MCP config.

### 8.3 One board tool call, per agent

All three agents converge on the same path:

agent MCP client → `POST http://localhost:6006/mcp` with `Authorization: Bearer <board token>` →
handler method/JSON checks (as today) → `Chats.ByToken` → `Relay.Call` →
`editorbridge.Bridge.Call` (30 s) → browser SSE + `/api/rpc-reply` → tool result
text → MCP JSON response.

Differences by agent are confined to how the tool call is named/presented in the chat UI:
Claude and pi already use `mcp__board__*`; Cursor's adapter normalizes its MCP calls to the same
names (7.6).

### 8.4 Archived, deleted and closed

- Archived chat: token still resolves, `Relay.Call` returns "this chat is archived" as tool text
  (unchanged).
- Deleted chat: token no longer resolves → "unknown board token" tool text plus a log line.
- No browser client: unchanged `NoClientText` ("the board isn't open…"), covered by the existing
  e2e step 10 for Claude.
- Archived boards/ideas: board lookup after token resolution is unchanged.

### 8.5 Multiple concurrent chats

- Identity is per request from the header; the endpoint stays stateless. No `Mcp-Session-Id`, no
  server-side "current chat".
- Same-chat concurrency (multiple turns) and cross-chat concurrency behave as today; the board
  engine's single-active-client rules are untouched.
- Pi bridge handles are unique per run and replaced per run: when a chat's run is respawned, the
  previous run's handle is retired, so any frames from the stale process are no-ops. MCP identity
  is always the chat's board token, independent of the bridge handle.

### 8.6 Failure handling

| Failure | Behaviour |
|---|---|
| Port 6006 in use | Startup fails with an explicit message naming 6006, the likely causes (another AI Whiteboard instance for a different data folder, or another program) and the remedy (stop that instance / free 6006); `server.json` is not written (D11; decided: fail-fast, no run-without-MCP fallback). The e2e harness prints the same message when it cannot acquire 6006 (D14, §10.2). |
| Unknown / missing / expired credential | `initialize`/`tools/list` still succeed (D8); `tools/call` returns error text, logged with the method and client. No crash, no 500. |
| Stale/replaced pi run | Its bridge handle no longer matches a live run, so bridge frames (permissions, notices, abort) are no-ops; MCP calls still carry the chat's board token and are attributed normally while that token is valid. |
| No browser client | Existing `NoClientText`; agent is told the window must be open. |
| Cursor blocked by policy (silent) | Server sees no request; diagnostics show no contact; README explains checking Cursor's debug log for `Blocked by team policy`. The app cannot detect it from ACP. |
| MCP listener dies while the app runs | Log; app keeps serving 4747. (Bind-time failure is fatal; a later serve error is practically unreachable.) |
| Agent crashes/restarts | Existing lifecycle; each new spawn re-sends the board config, so no stale URL state. |

### 8.7 Launch, relaunch, stop and the desktop app

- `launch`/`relaunch`/`stop` semantics are unchanged; they wait on 4747 `/api/hello`. If the MCP
  bind fails, the process exits and `launch` reports "the server stopped while starting" with the
  log tail, which now contains the port-6006 message; `serve` prints the same error directly.
- Electron is unchanged: it launches/loads 4747; quitting it does not stop the server.
- Consequence to document: exactly one app instance per machine can serve 6006, so running a
  second instance with a different data folder (or running the e2e real-Cursor steps while the
  app is up) conflicts. By default the e2e harness requires 6006 and fails fast with the same
  explicit message; with `AIWB_E2E_SKIP_CURSOR_MCP` set it reports the Cursor MCP steps as skipped
  and runs the rest on the hidden test-only override (§10.2, D14).

## 9. Build plan (phases)

Phases are sequential unless noted. Each phase ends green on its own tests; the final state (after
P5) is the acceptance state. All phases after P0 are on this branch, which already contains
`main`.

**Ordering rule that must not be broken:** P2 is one atomic change. It switches the shared
board-access value to the fixed URL and migrates every consumer of that value (Claude and pi) in
the same change. Never land the fixed value while pi's pre-migration adapter still rewrites
`Board.MCPURL` to `/mcp/<runToken>`: that path exists only on the legacy 4747 route, not on the 6006 listener, and
pi would silently lose board tools. Cursor's command path does not read the shared value, so P3
may follow P2 but must not be interleaved inside it.

### P0 — Merge local `main` (done)

Status: done — `main` (the pi agent landed in `71d0418`–`f7972e4`/`669487f`; current head
`eaa7cdd`) is an ancestor of this worktree's HEAD, and this plan's references were refreshed
against the merged tree. Owner-confirmed ordering and contract change (former Q8): `main` merges
first and updating the frozen pi MCP config contract (fixed URL plus the chat's board token
header; `AIWB_BRIDGE_RUN` becomes a non-secret bridge handle) is acceptable in this migration.

Depends on: nothing.

Verify: the post-merge pass — `go build ./...`; `go test ./...` (pi tests may skip without the pi
binary); `cd web && npm test`; a smoke run with all three agent pickers.

Tests/fixtures/docs: none new. Note the `plans/mcp-subagents.md` interaction (§2) and the README
wording from `main` (which still says Cursor uses a command endpoint; updated in P3/P4).

### P1 — Fixed MCP endpoint, header identity, 6006 listener

Work: shared endpoint/port constants and the hidden test-only port override — not a user-facing
flag (D10); second listener and guard variant; fixed `/mcp` handler reading the bearer credential
and treating it as a board token — no run-resolution hook, even staged; access logging. Keep the
legacy `/mcp/{token}` route (with its existing run-token resolver, deleted in P2) and `/agent`
working for now (migration staging only; the owner has confirmed both are removed outright at the
end, §11 resolved decisions).

Depends on: nothing (P0 is done; the worktree branch base is already current).

Verify: unit tests call the handler directly with/without credentials (including unknown and
archived chats, unknown tool, notification 202, bad JSON, wrong method); process-level test
that the app starts with a randomized test-only MCP port override and that the 6006 default is
advertised in production-mode tests where feasible; manual `curl` POST to the exact URL with a
header; manual port-conflict check confirming the fail-fast message from D11; confirm
`/api/hello` and the client still work.

Tests/fixtures/docs to update:
- `internal/boardapi/boardapi_test.go` (routing/helpers move from path token to header).
- `cmd/ai-whiteboard/relaunch_test.go` `newInstance.flags` and other process tests add the
  override; `cmd/ai-whiteboard/main_test.go` if it asserts flags.
- `internal/server/server_test.go` if it asserts the route list.
- README server/flag table: no user-facing MCP port entry (the override is hidden and test-only,
  D10); full docs in P4.

### P2 — Shared board-access value; Claude and pi on the unified endpoint; run-token credential removal (atomic)

Work (one change, do not split):
- `spawnOptions` builds the one shared board-access value (fixed endpoint URL + the chat's durable
  board token) for every board chat; Claude, Cursor (in P3) and pi all receive the same value and
  differ only in how their config carries the header.
- Claude consumes it: `--mcp-config` gains the credential header; context split inherits it; pin
  the exact URL string in tests.
- Pi consumes it: fixed URL plus the board-token header in `AIWB_MCP_CONFIG` (the config type
  `mcpServerConfig`, `internal/pi/args.go:80-83`, gains a `headers` field); delete the
  `/mcp/<runToken>` rewrite (`internal/pi/args.go:92-116`); the adapter no longer uses the run
  handle to build the board config.
- Delete the run-token credential mechanism: `Relay.Runs`/`RunResolver` (and the resolver-first
  step in the MCP handler), `Bridge.ResolveBoardToken` and the run record's board-token field,
  and the `cmd/ai-whiteboard` wiring that installs the bridge as the relay's resolver.
- Keep the per-run bridge handle for frame routing, permission/notice routing, subagent-tree abort
  and run lifecycle (D15): an internal, non-secret run identifier, no longer mapped to the board
  token and never an MCP credential. Preserve per-run replacement semantics (registering a chat's
  new run retires the previous run; its frames become no-ops).
- Update the frozen `internal/agent/bridge.go` contract comments, the extension comment in
  `internal/pibridge/extension/index.ts:18` and the `README.md` pi wording (D16): argv stays
  clean, the board token appears only inside `AIWB_MCP_CONFIG` for board chats,
  `AIWB_BRIDGE_RUN` is a non-secret bridge run handle; the pi extension needs no runtime change
  because it already forwards `headers`. Re-keying the bridge by chat id was considered and
  rejected (D15).

This phase is atomic because the pre-migration pi adapter rewrites `Board.MCPURL` to
`/mcp/<runToken>`, a path the 6006 listener does not serve; landing the shared fixed value in a
Claude-only phase would silently break pi. Cursor is unaffected by the shared-value change (its
command URL comes from `BaseURL`). Precede the Claude wiring with the header-format spike
(§11 assumptions).

Depends on: P1.

Verify: unit tests pin the fixed URL and the credential header in the generated Claude config
(existing tests `internal/claude/args_test.go:54-59`, `internal/claude/ctxsplit_test.go:210`);
**manager-level tests assert the actual board-access value handed to each spawner, including pi**
(today pi unit tests construct their own `BoardAccess` and the manager tests only assert Claude's,
so those alone cannot catch the broken window); pi tests assert the fixed URL, the board-token
header only inside `AIWB_MCP_CONFIG`, a clean argv, no URL rewrite and no run-token credential;
bridge tests still prove frame routing, permission/notice routing, subagent-tree abort and
per-run replacement (adapting identifiers, not deleting coverage); a real Claude board chat and a
real pi board chat both draw through the unified endpoint using the board-token header, no MCP URL
contains a run token, and pi permission asks (auto-answered by the adapter since `f7972e4`),
notices and aborts still route through the bridge handle; the e2e Claude board step and
context-split step pass.

Tests/fixtures/docs to update (merged tree):
- `internal/claude/args_test.go`, `internal/claude/ctxsplit_test.go`.
- `internal/chats/manager_test.go:841` (MCPURL expectation) plus a new manager-level assertion
  for the value handed to the pi spawner (`TestSendPiBoardChat`, `:883`, asserts only the sent
  text today).
- `internal/boardapi/boardapi_test.go`: delete `fakeRuns` and the run-token tests; the remaining
  helpers move to the header endpoint.
- `internal/boardapi/mcp_probe_test.go:233,263,414-416` (path assertion → header assertion; the
  `AIWB_BRIDGE_RUN` absence expectation becomes non-credential wording).
- `internal/pibridge/bridge_test.go`: delete `TestResolveBoardToken` (`:202-226`); adapt the
  register-run helper and signatures; keep routing/abort/replacement coverage.
- `internal/pibridge/concurrency_test.go`: keep the routing/abort coverage (identifiers/calls
  change).
- `internal/pi/args_test.go:123-173`: exact JSON becomes fixed URL + board-token header; the
  env-leak assertion becomes contract-aware (board token allowed only inside `AIWB_MCP_CONFIG`,
  argv clean).
- `internal/pi/pi_test.go:148-262`: replace the `fakeRegistry` expectations; invert the env-leak
  assertions; keep the deregister/abort and replacement tests. `:482-493`
  (`TestPlainChatRegistersEmptyBoardToken` pins the empty board token passed to `RegisterRun`)
  must change when the parameter is dropped.
- `internal/pi/fake_test.go`: env recording if the handle's semantics change.
- `internal/pi/e2e_test.go:177-197,208-216,285,386,403`: resolver recording/assertions deleted
  (`e2eRecordingResolver`, `e2eRecordingRegistry.RegisterRun`); the subagent board-access
  scenario stays valid with the header config.
- `internal/pi/e2e_perm_test.go`: the extra test server seam needs header support.
- `internal/pi/notice_test.go`: the `run=` log stays as the non-secret bridge handle (no change if
  the names stay).
- `internal/pibridge/extension_boot_test.go:628-629,680,698,735,872,887`: env fixtures and URL
  assertions updated; the standalone env-absence checks stay.
- Extension TS tests: `permissions.test.ts`, `protocol.test.ts` (the abort test must survive) and
  `subagent.test.ts` (child env inheritance must stay green); `mcp-wiring.test.ts`/`mcp.test.ts`
  survive unchanged because the extension needs no runtime change for headers.
- `internal/agent/agent.go:25-29`, `internal/agent/bridge.go:5-20` and
  `internal/pibridge/extension/index.ts:18` contract comments; `README.md` pi section (fixed
  URL, board token in `AIWB_MCP_CONFIG`, non-secret bridge handle; the pi auto-approve wording
  from `f7972e4` stays).
- Any fixture that quotes the old URL.

### P3 — Cursor on MCP; remove the command endpoint and curl prompting

Work: populate `session/new` and `session/load` with the board server entry (the fixed URL from
the shared value) and headers; teach normalization and auto-approval the real MCP call shape;
delete the command path and prompts (7.6, 7.8). Keep the command path until a real Cursor board
edit succeeds over MCP, then delete in the same phase. Cursor keeps one first-message
instructions block, now rendered with the shared MCP wording; only the curl wording and the
`<board-api>` URL block go away.

Depends on: P2 (the shared fixed endpoint value must exist before Cursor's handshake can carry
it; the command-path deletion itself would only need P1).

Verify: a real Cursor board chat edits a board through 6006 with no permission card and with the
expected `mcp__board__*` card; Cursor's debug log has no block line; server log shows an
initialize from Cursor and a tools/call for the chat; the first ACP chat message contains the MCP
wording and no curl/`<board-api>` block; unit tests fed by a captured real ACP trace; e2e step 7
(updated) passes under the decided e2e contract — real Cursor on 6006 by default, reported as
skipped when `AIWB_E2E_SKIP_CURSOR_MCP` is set (D14, §10.2).

Tests/fixtures/docs to update:
- `internal/cursor/cursor_test.go` (command fixtures at :25, board-command expectations at
  :536,591, session mcpServers expectations at :257,449) and `fake_test.go` if it serves ACP.
- `internal/boardapi/boardapi_test.go` command tests and route wiring.
- `internal/boardtools/boardtools_test.go:37-83` (ParseCommand tests deleted).
- `internal/prompts/prompts_test.go:11,28-51` (CursorInstructions tests replaced by a test of the
  shared MCP instructions; `TestPi` `:53-74` stays).
- `internal/chats/manager_test.go:852-861` (Cursor instructions fixture; the MCPURL expectation
  `:841` was updated in P2).
- `web/e2e/app.e2e.mjs:503-521` (step 7 messaging/labels stay; transport assertions added).
- `README.md:13-22` (Cursor wording; the pi wording is updated in P2).

### P4 — Diagnostics, status surface, docs

Work: structured access logs (7.9), `GET /api/mcp/status`, README updates for the new topology,
the exact URL, troubleshooting (curl probe, Cursor debug log, 6006 conflicts), and the
single-instance consequence.

Depends on: P1 (can start alongside P2–P3).

Verify: unit tests for the status route and log fields; manual Cursor blocked-by-policy
troubleshooting walkthrough (or a simulated unknown-token case plus the documented debug-log
check); README reviewed against actual behaviour.

Tests/fixtures/docs: `internal/server/server_test.go` (new route), README (HEAD and main
versions), `plans/` note if the subagent plan is updated.

### P5 — Final removal and sweep

Work (decided, not conditional — owner-confirmed with no external consumers, former Q1): delete
the temporary `/mcp/{token}` route; delete `CommandURL` remnants; update comments (package docs,
guard, `ChatMeta.Token`); sweep for stale references, including run-token-as-credential wording.
End state: `/mcp` on 6006 is the only MCP route, `/agent/{token}/{tool}` is gone (deleted with
Cursor in P3) and `/mcp/<runToken>` URL rewriting no longer exists.

Depends on: P2, P3, P4 (all agents migrated).

Verify: grep shows no `/agent/`, `ParseCommand`, `ServeCommand`, `commandRe`, `CommandURL`,
`CursorInstructions`, `cursorTools`, curl command examples or `<board-api>` blocks, no
command-era payload behind `InstructionsSent`, and no run-token credential remnants
(`RunResolver`, `ResolveBoardToken`, `/mcp/<runToken>` rewriting, the run handle described as a
credential), in code/tests/docs; `go test ./...`, web tests,
desktop tests, full e2e (real-Cursor step per D14/§10.2: on 6006 by default, or reported as
skipped with `AIWB_E2E_SKIP_CURSOR_MCP` set).

## 10. Verification and test strategy

### 10.1 Unit / package tests

- Handler-level tests exercise the fixed `/mcp` handler with a header credential (the board
  token), missing/unknown credentials, archived chats, method/JSON errors and notifications; no
  run-resolution hook is constructed.
- Spawner tests pin, for each agent, the exact advertised URL `http://localhost:6006/mcp` (or the
  test override) and that the credential is carried in the header, never the URL. Manager tests
  additionally assert the actual board-access value handed to each board-chat spawner (Claude and
  pi): pi's own unit tests construct their own `BoardAccess`, so without this a fixed-value /
  pre-migration-adapter split would stay green.
- Cursor adapter tests are driven by a captured real ACP trace: tool-call start/update/result
  shapes, permission requests, and normalization to `mcp__board__*`.
- Pi tests keep argv clean and assert the board token appears only inside `AIWB_MCP_CONFIG`;
  URL/path expectations move to fixed URL + header. Bridge tests keep per-run routing, abort and
  replacement coverage without the board-token mapping.
- Status endpoint tests.

### 10.2 Existing e2e (playwright, `web/e2e/app.e2e.mjs`)

- Steps 1–6, 8–14 and 16–20 continue to run (step 15 is checked by hand). Step 5 (the Claude
  board chat; step 4 is its board creation) now exercises the 6006 endpoint implicitly; step 8
  (board file protection) and step 10 (no client) still apply; step 19 exercises Cursor subagents
  (Task tool, meters, Stop, reload) and must not be dropped from the verification story.
- Step 7 is reworked: the Cursor chat still edits `arch`, cards stay `mcp__board__*`, no approval
  card, context-meter steps unchanged. Add transport checks that would have caught the old
  command path: the server log/status must show a Cursor initialize for the chat's token and a
  tools/call; the first ACP chat message sent to Cursor must contain the MCP wording and no curl
  instruction or `<board-api>` block (the old instructions went into the first chat message, not
  the process args); and the Cursor debug log must not contain a policy block. This step needs
  the fixed, policy-approved URL and therefore exclusive 6006 (below).
- Harness prerequisites (decided, D14; former Q4): by default the suite must acquire exclusive
  6006 and runs real Cursor against the fixed `http://localhost:6006/mcp`; if 6006 cannot be
  acquired it fails fast before touching the app with the same explicit message as the app's
  port-conflict policy — name port 6006, the likely holder, and tell the user to stop the running
  app / free the port; never a timeout and never a silent skip. The server args keep the ephemeral
  app port (4749) and leave the MCP port at its default so the URL is the policy-approved string.
  Document "stop the running app before e2e" in the README.
- With `AIWB_E2E_SKIP_CURSOR_MCP` set, the suite skips every step that needs real Cursor over MCP
  (step 7 and any other real-Cursor-MCP-dependent step) and reports each as skipped in the output
  — never silently drops it. In that mode the suite starts the app on the hidden test-only MCP
  port override (D10), so the remaining steps — including the Claude board steps — still exercise
  the MCP transport while a normal app instance may keep 6006.
- The real-Cursor round-trip on 6006 remains the manual acceptance gate (§10.3), and CI may use
  the skip flag plus the existing fake ACP Cursor harness. The URL-audit guard (§10.4) stays
  regardless of mode.

### 10.3 Real-agent manual checks (acceptance gate)

- Claude: new board chat, "draw a box labelled ping", verify card and board change; then resume
  the chat after a server restart and draw again; check the context meter.
- Cursor: same flow; additionally check the server log/status for Cursor's initialize and check
  the Cursor debug log for the absence of "Failed to load ACP session MCP server". This is the
  only way to observe the round-trip the experiment could not (A.2), and when the suite runs with
  `AIWB_E2E_SKIP_CURSOR_MCP` set (D14) it is the only real-Cursor-on-6006 coverage.
- Pi: same flow after P2; verify the board token appears only inside `AIWB_MCP_CONFIG` and never
  in argv, and that permission asks (auto-answered by the adapter since `f7972e4`), notices and
  aborts still route through the bridge handle.

### 10.4 How to check Cursor's MCP connection (silent ACP failure)

1. App side: `GET /api/mcp/status` (or the `server.log` initialize line) shows the chat, the
   client name and the last contact time. No contact after a prompt means the MCP server was
   never loaded (or the prompt never used it).
2. Cursor side: inspect `$TMPDIR/cursor-agent-logs-<uid>/latest.log` for
   `Failed to load ACP session MCP server` and `Blocked by team policy` (A.2/A.3).
3. Functional: ask the Cursor chat to call `read_board`; expect an `mcp__board__*` card. A reply
   that claims it has no board tools, with no server-side contact, is the silent-failure
   signature.
4. URL audit: dump the ACP `session/new` params (debug log or a focused adapter test) and assert
   the URL equals the approved string exactly — this is also a permanent unit-test guard.

## 11. Facts, assumptions, decisions and open questions

### Verified facts (evidence)

- The org allowlist matches the URL exactly; only `http://localhost:6006/mcp` connects; query,
  path token, trailing slash, `127.0.0.1` and `[::1]` are blocked (`experiment-6006.md` A.2).
- Custom headers are forwarded on that exact URL (A.4); ACP requires a `headers` array (A.1).
- ACP hides MCP load failures; the error is only in Cursor's debug log (A.2/A.3).
- Cursor speaks MCP 2025-11-25 (`initialize`, `notifications/initialized`, SSE `GET`) (A.2).
- `localhost` reaches a v4-only listener in the installed runtimes (B).
- Claude 2.1.284 supports HTTP MCP headers via CLI/config (C).
- Port 6006 is free and unreferenced in the repo (grep, experiment).
- The org admin has confirmed (owner-relayed) that the approved entry is exactly
  `http://localhost:6006/mcp`, that headers do not invalidate approval, and that no extra
  dev-machine variants are needed (former Q6).
- Current architecture, token lifetimes and the command-endpoint-only-for-Cursor story
  (`facts-digest.md` §§1–3, verified against the worktree).
- The merged tree contains pi with the frozen run-token/board-token separation and header-capable
  MCP config (`internal/pi/args.go`, `internal/agent/bridge.go`,
  `internal/pibridge/extension/mcp.ts`).
- The run token does two independent jobs: an MCP credential resolved to the board token, and the
  bridge's per-run frame identity for routing, permission/notice routing, subagent-tree abort and
  run lifecycle (`run-token-removal.md`; `internal/pibridge/bridge.go`,
  `internal/pibridge/extension/index.ts`). Only the first is removed by this plan.
- The worktree contains `main` (`eaa7cdd`); P0 is done (git check).

### Assumptions to confirm during implementation

- Cursor will actually list and call `board` tools once `mcpServers` is populated on the approved
  URL. Verified only up to connection (A.2); the round-trip is the P3 gate.
- Tool discovery is lazy: `tools/list` was not observed in the experiment's short window (A.2),
  so when (and whether) Cursor lists tools before a prompt is confirmed by the P3 round-trip.
- Cursor's MCP tool-call wire shape and permission behaviour match the installed bundle
  inference (kind `other`, title `<server>: <tool>`, raw input carries provider/tool/arguments;
  permission category `Mcp`). To be captured from a real trace in P3.
- Cursor tolerates the current JSON-only, no-SSE server (the handler 405s `GET /mcp`). If a real
  round-trip shows otherwise, add the minimal SSE stream needed; do not add it speculatively.
- Claude's `--mcp-config` header encoding is an object of header name → value. To be confirmed
  against a stub server in P2 before wiring (the binary schema includes `headers`; the exact
  JSON encoding inside a config string was not live-tested in experiment C).
- Cursor does not persist MCP servers across `session/load`; the app passes them on every
  handshake (as it does today with the empty array).
- The policy cache keeps the current result; if the org policy changes, only the URL constant
  changes, but this must be re-verified live.
- Binding 127.0.0.1 only and relying on `localhost` fallback remains safe on the target machines.

### Decisions resolved by the owner

- **Backwards compatibility (former Q1): confirmed.** Both `/mcp/{token}` and
  `/agent/{token}/{tool}` are removed outright; there are no external consumers. The staged
  migration in §9 is an in-flight ordering rule, not a compatibility commitment, and P5 is
  unconditional.
- **Port-conflict policy (former Q2): decided — fail startup when 6006 is taken.** The
  "run without MCP + warning" alternative is rejected. The surfacing of that error for `serve`,
  `launch`/`relaunch` and e2e/dev users is in §8.1, §8.6 and §8.7 (D11).
- **Test-only port override (former Q3): confirmed.** A hidden test-only override is acceptable;
  there must be no user-facing flag, because changing the port breaks Cursor's exact-URL
  allowlist (D10, P1). The e2e Cursor path keeps the real 6006.
- **Pi credential and timing (former Q8): decided.** `main` merged first (P0, done), and pi's
  board access becomes the fixed URL plus the chat's durable board token in the `Authorization`
  header of `AIWB_MCP_CONFIG` — exactly like Claude and Cursor. The run-token credential mechanism
  is removed: `Relay.Runs`/`RunResolver`, `Bridge.ResolveBoardToken`, the run record's board-token
  field, the `/mcp/<runToken>` URL rewrite and the `main.go` resolver wiring all go (§7.3, §7.7,
  P2). The bridge keeps a per-run, non-secret run handle for frame routing, permission/notice
  routing, subagent-tree abort and run lifecycle; re-keying the bridge by chat id was considered
  and rejected because a stale process could deregister or abort the chat's new run and
  `bridgePresent` would need a new signal (D15). Accepted security trade-off (D16): the durable
  board token now enters the pi process env inside `AIWB_MCP_CONFIG` and is inherited by its
  subagents; this is bounded by the chat's lifetime and was owner-accepted. The old invariant
  becomes "board token never in argv; only inside the board MCP config", and the contract
  comment/README wording moves with it (§7.7, P2).
- **E2E ownership of 6006 (former Q4): decided.** By default the e2e suite runs the
  real-Cursor MCP steps against the fixed `http://localhost:6006/mcp` and therefore requires
  exclusive use of 6006; if it cannot acquire 6006 it fails fast with the same explicit message
  as the app's port-conflict policy (name port 6006, the likely holder, and tell the user to stop
  the running app / free 6006), never a timeout or a silent skip. With `AIWB_E2E_SKIP_CURSOR_MCP`
  set, the real-Cursor-MCP-dependent steps (step 7 and any other such step) are reported as
  skipped, not silently dropped, and the rest of the suite — Claude board steps included — uses
  the already-confirmed hidden test-only MCP port override so it still exercises the MCP
  transport without owning 6006 and while a normal app instance is running. The real-Cursor
  round-trip on 6006 stays covered by the manual acceptance gate (§10.3); CI may use the skip
  flag plus the fake ACP Cursor harness. Recorded as D14 and detailed in §10.2.
- **UI diagnostics (former Q5): decided — no visible UI warning for v1.** Cursor's ACP layer
  still hides MCP load failures, but structured `initialize`/`tools/call` logging, the read-only
  status surface on 4747, README troubleshooting and the permanent URL-audit unit-test guard are
  sufficient (D12, §7.9, §10.4). The optional badge / warning on a board chat whose agent never
  initialized is deferred, not required.

### Open question still requiring an answer (owner / org admin)

1. **Token policy (formerly Q7; the only question still open).** Tokens never expire today;
   confirm that stays out of scope (the new header transport does not change it).

Non-blocking note (not a question, does not gate any phase): whether to rename `AIWB_BRIDGE_RUN`
(and the frame `run` field) so the internal, non-secret role is obvious in the name is optional
cleanup. This plan keeps the existing names to limit churn (D15); a rename, if chosen, is
mechanical and can happen in P2 or a follow-up.

## 12. References

Repo (worktree HEAD `704dbf2`, the tree with `main` already merged; references refreshed after
P0):

- `cmd/ai-whiteboard/main.go:92,123,136,183,196` — single listener, base URL, server file,
  `http.Serve`; `cmd/ai-whiteboard/launch.go` — launch/relaunch/stop; `cmd/ai-whiteboard/*_test.go`
  — process tests that need the MCP port override.
- `internal/server/server.go:162,601-607` — handler/mux and agent routes;
  `internal/server/guard.go:14-50` — Host and active-client checks.
- `internal/boardapi/mcp.go:53-79,121-182` — relay call path and MCP handler;
  `internal/boardapi/command.go` — command handler.
- `internal/chats/manager.go:366-369,467-478,597-602,998-1012` — token minting, spawn options,
  Cursor prompt block, token lookup.
- `internal/agent/agent.go:25-29` — board access value; `internal/model/model.go:204` — token.
- `internal/claude/claude.go:58-83`, `internal/claude/ctxsplit.go:88-93` — Claude board config.
- `internal/cursor/cursor.go:108-229,638-673,744-777` — ACP handshake, normalization, permissions;
  `internal/cursor/config.go` — deny rules.
- `internal/prompts/prompts.go:33-38,67-87` — Cursor instructions; `internal/boardtools/command.go`
  — command regex/parser; `internal/boardtools/tools.go` — shared tool list.
- `internal/store/store.go:109-135` — `server.json`; `desktop/lib.js:135-139` — health check;
  `desktop/main.js` — launch/reconnect flow.
- Tests: `internal/boardapi/boardapi_test.go`, `internal/cursor/cursor_test.go`,
  `internal/boardtools/boardtools_test.go`, `internal/prompts/prompts_test.go`,
  `internal/chats/manager_test.go`, `internal/claude/args_test.go`,
  `internal/claude/ctxsplit_test.go`, `web/e2e/app.e2e.mjs`.
- `README.md:13-22` and the server/flag sections.

Merged `main` code (formerly `main:` refs; now in the worktree):

- `internal/pi/args.go:39-58,92-116,123-148` — pi argv, board MCP config, env;
  `internal/agent/bridge.go:5-20` — frozen contract;
  `internal/pibridge/bridge.go:184-194,199-223` — `ResolveBoardToken` (deleted) and run
  registration/lifecycle (handle kept); `internal/boardapi/mcp.go:27-40,127-131` — run
  resolver (deleted); `internal/pibridge/extension/mcp.ts:239-267,440-453` — header support
  and fetch; `cmd/ai-whiteboard/main.go:158-170` — wiring (resolver line `:165` deleted);
  `README.md:13-30` — pi contract wording (updated in P2/P4);
  `internal/pi/args_test.go`, `internal/pi/pi_test.go`, `internal/pi/e2e_test.go`,
  `internal/boardapi/mcp_probe_test.go`, `internal/pibridge/extension_boot_test.go` —
  pinned URL/path expectations.

Research artifacts and review trail (`plans/mcp-research/`):

- `facts-digest.md` — consolidated architecture and constraints.
- `experiment-6006.md` — live A/B/C experiment: allowlist exact-match, header forwarding,
  IPv4/IPv6 reachability, Claude CLI header support.
- `run-token-removal.md` — the run token's two jobs, the removal blast radius, and the
  considered-and-rejected chat-id bridge re-key.
- `review-1.md` (MUST_FIX), `review-2.md` (PASS), `review-3.md` (PASS) — independent reviews and
  the fix rounds they drove.
