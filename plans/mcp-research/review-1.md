# Review 1 of plans/unified-mcp-endpoint.md (independent reviewer)

Result: MUST_FIX

## Must-fix findings

**1. §9 P2 / P4 and §7.7 / §8.2 — the shared board-access change in P2 silently breaks Pi until P4.**

- What is wrong: §8.2 and P2 move `spawnOptions` to "one shared board-access value (fixed endpoint URL + the chat's token)" and P2's own update list confirms the manager's `MCPURL` expectation changes in P2 (`internal/chats/manager_test.go:728` on HEAD). But the Pi adapter is only migrated in P4; until then it consumes `Board.MCPURL` by replacing the path with `/mcp/<runToken>` (`main:internal/pi/args.go:85-116`). Executed in the documented sequential order P1→P2→P3→P4 (P3 "recommended after P2", P4 "independent"), Pi board chats between P2 and P4 post to `http://localhost:6006/mcp/<runToken>`, which §7.2 does not serve — the 6006 listener exposes only the fixed `POST /mcp`, and the legacy `/mcp/{token}` route is on the 4747 listener (§7.4, D6). Pi silently loses board tools for that window.
- Why it matters: this is exactly the silent agent-tool failure the plan exists to eliminate, and the phase tests will not catch it: pi unit tests construct their own `BoardAccess` (e.g. `main:internal/pi/args_test.go:130-139`), and the manager tests do not assert Pi's board-access value, so P2 can be green while Pi is broken.
- What the fix must achieve: ensure the shared fixed-value change and the Pi consumption change land together (merge/bundle P2 and P4), or state an explicit integration order (P4 before/with P2), or keep the legacy per-agent board value until the last consumer (Pi) is migrated. No new design beyond the ordering/pairing needs to be introduced.

## Optional suggestions

- §2 (out of scope) vs §11 (assumptions): "MCP sessions/SSE push/notifications" is out of scope, yet §11 allows adding "the minimal SSE stream needed" if the live Cursor trace requires it. Reword the scope bullet so the contingency and the scope do not read as contradictory.
- §7.8 step 3 deletes `CursorInstructions`/`cursorTools`, while §7.6 says Cursor's first-message instructions "become the same MCP wording as the other agents". Name the replacement (e.g. reuse the Pi/MCP wording function) so Cursor does not lose its first-message instructions, which are still driven by `InstructionsSent` (`internal/chats/manager.go:598-600`).
- §10.2 enumerates e2e steps "1–6 and 8–16", but the suite has steps 1–14 and 16–20. Say that 17–20 also run; step 19 exercises Cursor tool normalization (plain chat, so likely unaffected, but it should not be dropped from the verification story).
- §10.2's "the sent process args must not contain a curl instruction" does not match Cursor: the old curl instructions went in the first ACP chat message, not the process args. Check the message/first-item content (or both message and args).
- §11 lists "tool discovery is lazy" among verified facts; A.2 only failed to observe `tools/list` in a short window. Move it to assumptions; the round-trip assumption already covers the consequence.
- Line references are HEAD-relative and shift after the P0 fast-forward (e.g. `internal/chats/manager_test.go:728` is at `:841` on `main`). Note that, or refresh after P0.
- §4/§7.8: "`CommandURL` has no production reader besides prompt text" is slightly off — it has no production reader at all; the `manager.go:602` prompt block builds the URL from `BaseURL`. Harmless, but tighten it.
- P6's grep sweep should also include `ServeCommand`, `cursorTools`, `commandRe`, and `InstructionsSent` (Cursor board chats) so no stale mechanism identifier survives.
- Migration caveat worth one line: pre-existing Cursor chats keep the old curl instructions in their stored history; after removal their model may still try the dead endpoint until the context rolls. The plan covers live processes (D6) but not stored history.

## Verification notes

Checked in the worktree (`ea03c97`) and local `main` (`669487f`):

- Git: `HEAD..main` = 3 commits (`71d0418`, `f7972e4`, `669487f`); `git merge-base --is-ancestor HEAD main` succeeds, so P0 is a fast-forward. `6006` appears nowhere in HEAD or `main` (`grep -rn 6006`).
- Single 4747 listener/URL/server.json: `cmd/ai-whiteboard/main.go:87,116,129,155,167`; `internal/store/store.go:110-134`; `desktop/lib.js:135-139`. Launch's "stopped while starting" + log tail: `cmd/ai-whiteboard/launch.go:70-80,93-118`.
- Guard and routes: `internal/server/guard.go:19-42`; `internal/server/server.go:601-605` (`/mcp/{token}`, `/agent/{token}/{tool}`, client fallback). After route removal `/agent/...` and `/mcp/...` fall through to `clientFiles` (`internal/server/client.go`), which yields 404 because no such files exist — AC5 is satisfiable without extra handlers.
- Token mechanics: mint at `internal/chats/manager.go:367-369`, stored `internal/model/model.go:175`, lookup `manager.go:995-1012` (HEAD numbering), spawn value `manager.go:474-475`, prompt/URL block `manager.go:599-602`. Run resolver on main: `main:internal/boardapi/mcp.go:27-40,126-131`, registration `main:internal/pibridge/bridge.go:196-223` (`newRunToken` = 16 bytes hex), frozen contract `main:internal/agent/bridge.go:5-25`.
- Removal surface exists as listed: `internal/boardapi/command.go`, `internal/boardtools/command.go:9,18`, `internal/prompts/prompts.go:26-59`, Cursor branches `internal/cursor/cursor.go:651,758`, `internal/agent/agent.go:25-29`; tests `boardapi_test.go:61-62,292,316`, `boardtools_test.go:37,53`, `prompts_test.go:11,28-42`, `manager_test.go:739-741`, `cursor_test.go:25,257,449,536,591`, e2e step 7 `app.e2e.mjs:497-515`, README `:14-17` (and main README `:16-18,35`).
- Claude/Cursor/Pi config lines verified: `internal/claude/claude.go:75-83`, `ctxsplit.go:88-93`; `internal/cursor/cursor.go:197,205`; `main:internal/pi/args.go:85-116,118-148`; `main:internal/pibridge/extension/mcp.ts` supports an object `headers` and documents "No GET/SSE stream is opened or required (servers answering 405 are fine)" — so the 405-GET fallback is fine for Pi.
- Plan's test/doc line references I sampled matched (manager_test, args_test, ctxsplit_test, prompts_test, cursor_test, e2e, boardapi/mcp_probe_test, extension_boot_test, pi e2e), modulo the post-merge line shift noted above.
- Experiment claims in `/tmp/aiwb-mcp-research/*` were taken as given where the live environment cannot be replayed; I could not independently re-verify the Cursor org policy behavior, the Cursor MCP tool round-trip, or Claude's `--mcp-config` header encoding — the plan correctly flags the latter two as assumptions/spikes. The plan's "verified facts" are otherwise consistent with the artifacts.
