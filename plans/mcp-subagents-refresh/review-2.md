# Review 2 — `plans/mcp-subagents.md`

Verdict: PASS

## Must-fix findings

None.

## Optional suggestions

1. Today `SpawnOptions.Board != nil` is one pointer for MCP URL+token **and** every board extra (`internal/agent/agent.go:22–28`, `internal/chats/manager.go:477–479`; Claude/Cursor/Pi all bundle extras on that pointer). The plan already splits the gate in D2/D8, but an implementer could still “just set `Board` on plain chats.” One sentence that the existing `if o.Board != nil` bundles must be taken apart — MCP connectivity on, board extras still off — would make that failure mode harder.

2. The named freeze list in §6 is the “no MCP / no token on plain chats” tests from `mcp-all-chats.md` §7. Board-positive pins will move too when spawn-family names join `boardtools.Tools` or when Cursor `IsTool` / `p.o.Board != nil` auto-approve/normalize start applying to every attached server (e.g. `internal/claude/args_test.go:53–71`, `internal/cursor/cursor.go:692–696` and `:817–821`). Worth naming them next to the freeze list so they are updated with the same intent, not rediscovered.

3. Cursor auto-approve of `boardtools.IsTool` currently sits behind `p.o.Board != nil`. If that pointer becomes “has MCP,” a hallucinated board-tool name on a **plain** Cursor chat would be auto-approved in the adapter and only stopped by MCP call authorization. The plan already requires that authorization; a clause that Cursor auto-approve is not the board-tool fence on plain chats would keep the two layers from being collapsed.

## Goal coverage / feasibility / consistency / detail

**Goal coverage.** Spawn family on all chats (Claude, Cursor, Pi); board tools board-only; per-chat and per-caller `tools/list` / `tools/call`; tokens + MCP config on plain chats; steering on every app chat (Claude disallow, Cursor hook on all app-spawned processes, Pi native `subagent` unregistered); UI parity; lifecycle; no `/mcp/<token>`, no command endpoint, no attach/detach.

**Feasibility.** Follows the refresh artifacts: token mint is board-only today and must become every chat; `spawnOptions` is Board-gated and must split MCP connectivity from board extras; `POST /mcp` does not require a board; empty board id is not rejected in `Relay.Call` (client `NO_BOARD`) — the plan does not use that as the filter, it authorizes before the bridge; `ByToken` does not check `Board`; association is create-time only. Assumptions and Q1/Q3/Q4 are labeled measurements, not forks.

**Consistency.** Scope, D1–D8, flows, phases, tests, and §8 agree that plain chats are in scope and native spawn is replaced everywhere. Leftover “plain chats out of scope” / “keep native Task” appears only as revoked prior stance (D5). Tool-surface matrix matches call authorization; unknown-token `tools/list` is empty and does not fight `tools/call` `isError` (never HTTP 401).

**Detail.** High-level: modules, flows, phases, acceptance. No signatures, schemas, or implementation code. The matrix and the plain-chat MCP attachment (mint, spawn-options split, per-adapter injection, list filter, named test updates) are specified enough to implement without re-deriving them from the tree.
