# Run-token removal facts (from read-only research on `main` = 669487f)

## The run token has two independent jobs

A. **MCP credential** (the one the owner wants removed):
- Pi's MCP URL is rewritten to `scheme://host/mcp/<runToken>` (`main:internal/pi/args.go:92-103`).
- `Relay.Runs = pb` (`main:cmd/ai-whiteboard/main.go:164-165`) + `RunResolver` (`main:internal/boardapi/mcp.go:27-32,39,126-131`).
- `Bridge.ResolveBoardToken` maps run token → board token (`main:internal/pibridge/bridge.go:184-194`, `run.boardToken` `:44`).
- Purpose: keep the durable board token out of Pi's env/argv (contract `main:internal/agent/bridge.go:5-20`; tests `main:internal/pi/args_test.go:141-145`, `main:internal/pi/pi_test.go:199-207,239-243`, `main:internal/pi/e2e_test.go:237,464-479`).

B. **Bridge frame identity / lifecycle** (load-bearing even if MCP credential is removed):
- Every frame is looked up by `frame.Run` against the token-keyed registry (`main:internal/pibridge/bridge.go:175-182,351-354`; `BridgeFrame.Run` `main:internal/agent/bridge.go:55`).
- `AIWB_BRIDGE_RUN` is read by the extension (`main:internal/pibridge/extension/index.ts:93`) and `bridgePresent = socketPath !== "" && run !== ""` (`:94`) gates the permission gate, the `subagent` tool and the control/abort channel (`:188`). If the var is removed with the socket still set, the extension silently degrades to standalone (no app-dir auto-deny, no subagent tool, no abort).
- Used for: frame routing (`bridge.go:362-401`), abort of subagent trees (`AbortRun` `:236-245`, extension `killChildren` `index.ts:53-75,269`, `protocol.ts:115`), notice reporting (`bridge.go:390-396`, `main:internal/pi/notice.go:19`), deregister/replacement (`pi.go:171-176,338-340,432-435`; replacement `bridge.go:206-222`).
- All runs/chats share one owner-only socket (dir 0700, socket 0600; `bridge.go:72-79,103-120`); `AIWB_CHAT_ID` exists in Pi's env (`args.go:126`) and in the run record (`bridge.go:204`) but is never read by the extension or sent on frames.
- Subagent children inherit the parent's `AIWB_BRIDGE_RUN`/socket (`extension/subagent.ts:150-169,591`), so whatever handle remains must be inheritable.

## Owner decision being applied

Pi must work like Claude/Cursor for MCP: fixed URL `http://localhost:6006/mcp` + board token in `AIWB_MCP_CONFIG` headers. The run-token **credential mapping is deleted**. The bridge still needs a per-run handle for routing/abort/lifecycle; keep that as a **non-secret internal run handle** (documented as not a credential), not a board-token mapping. A full re-key of the bridge by chat id is a rejected alternative: stale processes would be able to deregister/abort the *new* run (`bridge.go:206-234`, tests `bridge_test.go:373-403`), and `bridgePresent` would need a new signal. Renaming the env/frame field is optional cleanup with wide churn; not required to remove the credential role.

## Removal blast radius (files to change when (A) is deleted, with (B) kept)

Production:
- `main:internal/boardapi/mcp.go` — delete `RunResolver`/`Relay.Runs` and the resolution block; credential is the board token only.
- `main:internal/pibridge/bridge.go` — delete `run.boardToken` `:44`, `ResolveBoardToken` `:184-194`; keep registry/routing/abort; `RegisterRun` no longer needs board token (signature change); `newRunToken` may stay as a non-secret run-id generator (rename optional).
- `main:cmd/ai-whiteboard/main.go` — delete `relay.Runs = pb` `:165`; keep bridge construction/Close.
- `main:internal/pi/pi.go` — `RegisterRun` call `:160-170` (drop board-token arg), failure dereg `:171-176`, `waitExit` `:338-340`, `Interrupt` abort `:413-415`, `Close` `:432-435`. The `runToken` field remains the bridge handle but is no longer an MCP credential.
- `main:internal/pi/args.go` — add `Headers` to `mcpServerConfig` (`:80-83`); replace the `/mcp/<runToken>` rewrite (`:85-116`) with fixed URL + board-token header; MCP config no longer gated on run token (`:93`); `AIWB_BRIDGE_RUN` injection stays for the bridge (`:133-135`).
- `main:internal/pi/notice.go` — run= log can stay (non-secret handle) or be dropped.
- `main:internal/agent/bridge.go` — contract comments `:5-20`, `ResolveBoardToken`/`RegisterRun` signatures `:108-119`; `AIWB_BRIDGE_RUN` documented as a non-secret bridge run handle; board-token-in-`AIWB_MCP_CONFIG` documented; argv stays clean.
- Extension: **no changes needed** for the board-token header (`mcp.ts` already parses/forwards headers `:239-267,440-453`); it has no MCP-URL run-token logic. `bridgePresent` logic stays unchanged.

Tests (from research table):
- `main:internal/boardapi/boardapi_test.go` — delete `fakeRuns` `:68-76` and run-token tests `:233-360`; helpers move to the header endpoint.
- `main:internal/boardapi/mcp_probe_test.go` — config URL/path assertions `:233,414-415`; absence list that names `AIWB_BRIDGE_RUN` `:96-100,262-266,378-386`.
- `main:internal/pibridge/bridge_test.go` — delete `TestResolveBoardToken` `:202-226`; adapt `registerRun` helper `:103-110` and signatures; keep routing/abort/replace coverage.
- `main:internal/pibridge/concurrency_test.go` — routing/abort coverage must survive (identifiers/calls change).
- `main:internal/pi/pi_test.go` — `fakeRegistry` `:327-368`; `TestSpawnBoardChatMCPConfig` `:166-209` (invert the "no board token in env" assertion: board token now allowed only inside `AIWB_MCP_CONFIG`; argv stays clean); `TestSpawnPlainChatNoMCPConfig` `:247-262`; `TestCloseDeregistersAndAbortPushes` `:370-390`.
- `main:internal/pi/args_test.go` — exact JSON `:123-173` becomes fixed URL + headers; leak assertion `:141-145` becomes contract-aware.
- `main:internal/pi/fake_test.go` — env recording `:53-71,253-270` if var semantics change.
- `main:internal/pi/e2e_test.go` — resolver recording/assertions `:177-197,199-222,282-283,464-479` obsolete; subagent board-access scenario `:656-694` stays valid with header config; `boardAccess()` `:382-387`.
- `main:internal/pi/e2e_perm_test.go` — extra test server needs headers support in the seam `:185-189`.
- `main:internal/pi/notice_test.go` — `run=run-abc` `:11-42` if log changes.
- `main:internal/pibridge/extension_boot_test.go` — env fixtures `:816-820,893-896`; URL assertions `:809,872`; standalone env absence `:419-425`.
- Extension TS tests: `permissions.test.ts` (`run:` deps `:87`, frames `:146,164,192,275,292`), `protocol.test.ts` (`run:"r"` frames `:69,79,114,141-151,161`; abort test `:127-157` must survive), `subagent.test.ts` (`run-1` activity `:319,361-367`; child env inheritance `:700-729` must stay green), `mcp-wiring.test.ts`/`mcp.test.ts` survive.
- Docs: `main:README.md:16-21,27-30` (old contract), plus `plans/unified-mcp-endpoint.md` itself.

## Unresolved / risks to note in the plan

- Board token now enters Pi's env (inside `AIWB_MCP_CONFIG`) and is inherited by subagents — owner-accepted trade-off; security note required; leak tests/invariants inverted. Argv must remain clean.
- Whether user-Stop still reliably kills extension-owned subagent trees without `AbortRun` was not verified; keeping the bridge handle avoids the question.
- Same-chat respawn races rely on per-run replacement semantics (`bridge.go:206-222`); keep the handle keyed per run (not per chat) to preserve stale-process no-op behavior.
