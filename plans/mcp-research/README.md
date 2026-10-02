# Research evidence and review trail — unified MCP endpoint plan

These files support `plans/unified-mcp-endpoint.md`, the plan to move all coding agents (Claude
Code, Cursor, pi) to one MCP endpoint at exactly `http://localhost:6006/mcp` with the per-chat
credential in an HTTP header, and to remove Cursor's curl command endpoint and pi's run-token
MCP credential.

## Contents

| File | What it is |
| --- | --- |
| `facts-digest.md` | Synthesis of four read-only research jobs on the repo: current board-access architecture, why Cursor used commands, pi integration on `main`, and feasibility constraints. File:line pointers are relative to worktree HEAD `ea03c97` and local `main` `669487f`. |
| `experiment-6006.md` | Live experiment on this machine (Cursor CLI `2026.09.28-64d2043`, Claude Code 2.1.284, Node 24/26). Proves the org allowlist matches the URL exactly (query/path/host variants are blocked), headers are forwarded, ACP requires a `headers` array, `localhost` reaches a 127.0.0.1 listener, and Claude supports HTTP MCP headers. |
| `run-token-removal.md` | Read-only research on every use of pi's run token on `main`: the MCP-credential role (to be deleted) and the UDS-bridge identity role (retained as a non-secret handle), the removal blast radius, and the rejected chat-id bridge re-key. |
| `review-1.md` | Independent review that returned MUST_FIX: the shared board-access change in P2 would have silently broken pi before its P4 migration. Drove the P2–P4 bundling fix. |
| `review-2.md` | Independent re-review after that fix. PASS; optional suggestions recorded. |
| `review-3.md` | Independent review after the owner decided pi uses the board token like Claude/Cursor (run-token credential removed). PASS; optional suggestions recorded. |

## Process trail

1. Reconnaissance and four read-only research jobs (architecture, Cursor MCP capabilities,
   6006 feasibility, pi on `main`).
2. Live feasibility experiment on this machine (the decisive exact-match allowlist result).
3. Plan assembled into `plans/unified-mcp-endpoint.md` (P0–P5).
4. Review 1 → MUST_FIX (P2/P4 ordering) → fix: the shared board-access value and every consumer
   (Claude and pi) land atomically in P2.
5. Review 2 → PASS.
6. Owner decisions recorded: remove both legacy routes outright; fail startup when 6006 is taken;
   hidden test-only port override; admin reconfirmation; pi contract update after merging `main`;
   no UI warning for v1; `AIWB_E2E_SKIP_CURSOR_MCP` for Cursor-MCP steps.
7. Owner changed the pi credential model: use the board token in `AIWB_MCP_CONFIG` like
   Claude/Cursor; delete the run-token credential mapping (`RunResolver`, `ResolveBoardToken`,
   `/mcp/<runToken>` rewrite). A non-secret run handle stays for the UDS bridge
   (permission/notice routing, subagent abort, lifecycle).
8. Review 3 → PASS; optional suggestions recorded.

## Open question

Only one remains (plan §11): tokens never expire today — confirm token expiry/rotation stays out
of scope for this work.

## Notes

- Reviews 1–2 were written while the artifacts lived in `/tmp/aiwb-mcp-research/`; their
  /tmp-path mentions are historical. The copies in this folder are identical.
- No source, test or other files were modified while producing these artifacts; the plan and
  this folder are the only additions (currently untracked in git).
- The plan reflects owner decisions made in conversation; all are recorded in its §11.
- After the P0 fast-forward to `main`, the HEAD-relative line numbers in these artifacts and in
  the plan shift (the plan documents this).
