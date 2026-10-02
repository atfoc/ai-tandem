# Review 3 of plans/unified-mcp-endpoint.md (independent reviewer, after the Pi board-token change)

Result: PASS

## Must-fix findings
None.

## Optional suggestions
1. §9 P2 test list cites `internal/pi/pi_test.go:148-259`, but the affected tests extend beyond that range (`fakeRegistry` :327-368, `TestCloseDeregistersAndAbortPushes` :370-390, `TestPlainChatRegistersEmptyBoardToken` :482). The prose ("replace the `fakeRegistry` expectations") covers them; refreshing the refs after P0 would prevent a partial edit.
2. §9 P2: when the adapter stops reading the run handle to build `AIWB_MCP_CONFIG`, the old `args_test.go` case "board chat without a minted run token gets no config" inverts — board-chat presence, not handle presence, should gate the config. Worth stating explicitly, since it is the last place where the bridge handle could silently leak back into the MCP config path (§7.7).
3. §8.6 lists an "expired credential" failure row while §4/§11 record that tokens never expire and the only open question is whether that stays out of scope. Consider "unknown/missing" now, with expiry folded in only if the token-policy answer changes.
4. §10.1 names manager-level spawner assertions for Claude and pi only; AC1 (§5) says Cursor from P3. Add Cursor there once P3 lands so the acceptance statement and the test strategy read as one contract.
5. §7.3's "There is no resolver" is a final-state statement that briefly reads against §9 P1's staged retention of the resolver on the legacy route. The phase text and D5/D6 make the ordering clear; adding "in the end state" to §7.3 would be cosmetic hardening.
6. Some `internal/pibridge/extension_boot_test.go` fixture refs in P2 (e.g. `:887`) differ from the facts artifact's env-fixture lines (`:816-820`, `:893-896`); covered by the plan's global post-P0 line-shift note, but refresh when touching the file.

## Verification notes
Checked against the full plan (941 lines), `run-token-removal.md`, `facts-digest.md`, `experiment-6006.md`, and `review-1.md`, cross-checking `main` (`669487f`) via `git show`:

- Run-token-as-credential removal is complete and consistent: D5, §7.3, §7.7, §8.1, P1→P2 staging, P2 deletions, P5 sweep, §11 decision and §12 always name the same pieces (`Relay.Runs`/`RunResolver`, `Bridge.ResolveBoardToken`, `run.boardToken`, `/mcp/<runToken>` rewrite, `main.go` resolver wiring). Remaining "run token" hits are explicitly historical ("current contract on `main`", "pre-migration adapter") or ordering rationale, never a description of the target flows.
- Bridge handle retention is accurate: D15/§7.7/§8.2/§8.5/§8.6 cover frame routing, permission/notice routing, subagent-tree abort, lifecycle and per-run replacement; the chat-id re-key rejection matches the facts artifact (stale process could deregister/abort the new run; `bridgePresent` would need a new signal). Verified in `main:internal/pibridge/bridge.go` (`run.boardToken`, `ResolveBoardToken`, `RegisterRun` replacement) and `main:internal/agent/bridge.go`.
- Contract/security change is honest: D16, §5.4, §7.7, §10.3 state argv clean, board token only inside `AIWB_MCP_CONFIG`, inherited by subagents, owner-accepted. Verified the extension forwards `headers` (`mcp.ts` `parseHeaders`, `post`) and that subagent `childEnv` inherits env, so "no runtime change needed" holds.
- Inverted tests are listed accurately: `fakeRuns`/run-token tests, `TestResolveBoardToken`, `args_test.go`/`pi_test.go` env-leak assertions, probe path assertions, and the manager-only-Claude assertion (`main:internal/chats/manager_test.go:841`) all exist as described; routing/abort/concurrency and extension tests are explicitly kept. `internal/agent/bridge.go` `RegisterRun` signature and `fakeRegistry` are covered by "adapt signatures".
- P2 atomicity and ordering hold: P1 keeps legacy route + resolver (no consumer loses tools); P2 lands shared value + Claude + pi + credential-mapping deletion + bridge contract as one change; Cursor's `BaseURL`-derived command path is unaffected until P3; P5 removes the legacy route last. No operational statement leaves any agent without board tools in any phase state.
- Level of detail: no code, pseudocode, signatures, field schemas or internal algorithms; only contracts, names and file:line pointers.
- Not independently verifiable here: live Cursor/Claude/pi MCP round-trips, org-policy behavior, and test execution (read-only review, no tests run). Post-P0 line numbers will shift, as the plan itself states.
