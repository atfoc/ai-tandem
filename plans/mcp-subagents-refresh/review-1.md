# Review 1 — `plans/mcp-subagents.md`

Verdict: PASS

## Must-fix findings

None.

## Optional suggestions

1. A few §7 line ranges have drifted a handful of lines while the claims stay true. `stopSubs` on abort/exit is `internal/chats/manager.go:537–541`, not `:545–548` (that range is unrequested `TurnActive`). The drawer-open gate is `web/src/Subagents.tsx:82`, not `:75`. `Send` unlocks at `:631` and calls `ag.Send` at `:644`, not `:628–637`. Worth correcting so implementers do not land on adjacent pump/UI code.

2. Say explicitly that app-spawned Cursor children (`Board != nil`) also get the isolated `CURSOR_DATA_DIR` + Task hook. D5 says “board-chat Cursor processes”; depth-1 needs the hook on those children too, because native Task is still on the model’s list even when MCP spawn-family is hidden.

3. Claude `--allowedTools` today dumps every `boardtools.Tools` name whenever `Board != nil` (`internal/claude/claude.go:75–80`). Excluding the spawn family on a child therefore needs an adapter-visible parent-vs-child distinction that `SpawnOptions` does not have today. The plan already has `tools/list` filtering and hard rejection as the real guarantee; one sentence that those two layers are sufficient if the allow-list split lags would stop implementers from blocking on a new spawn-options field.

4. D1 (handshake `tools/list` without a live token still lists board tools) and D3 (“a call on a revoked or unknown token gets tool text errors”) can be read as fighting. One clause that revoked extra tokens fail `tools/call` as unknown, while `tools/list` stays the board-only handshake list, would close that.

## Goal coverage / feasibility / consistency / detail

**Goal coverage.** Claude, Cursor, and Pi board chats; async spawn + `wait_subagents` + `stop_subagent`; UI parity via existing `sub` / `sub_items` plus `isSubagentTool`; lifecycle (stop/interrupt/abort/exit/archive/delete/shutdown vs normal turn end); steering off native spawn on all three; extra Bearer tokens on `POST http://localhost:6006/mcp`. No `/mcp/<token>`, no command endpoint.

**Feasibility.** Follows the refresh artifacts: `tools/list` is global today and must become per-caller; Pi children must not inherit parent `AIWB_MCP_CONFIG`; Cursor deny is cwd-slug + `CURSOR_DATA_DIR`, isolated for board-chat processes so plain chats keep Task; no reuse of `pump`; `Decide` extended past `c.ag`; Pi native `subagent` not registered on board chats; spawn-family never through `Relay.Call`. Assumptions are labeled; Q1/Q3/Q4 stay measurements.

**Consistency.** D1–D8, phases, verification, and §8 settled/open items agree (including Cursor hook on board chats only, Pi non-sequential spawn-family tools, depth-1 list filter + hard reject).

**Detail.** High-level: modules, flows, phases, acceptance. No implementation code, signatures, or field schemas. Identity, steering, and Pi constraints are specified enough to implement without re-deriving them.
