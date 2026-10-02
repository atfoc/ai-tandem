# Review 3 — `plans/mcp-subagents.md`

Verdict: PASS

## Must-fix findings

None.

## Optional suggestions

1. “Existing agent display name” could be `agentName` (`"Claude Code"`) or `agentShortName` (`"Claude"`). Goal wording is Claude / Cursor / Pi; the header uses the long name. One word on which to reuse would keep a tight card from growing `"Claude Code"` by accident.

2. Web logic tests check kind on the linked path, not DOM chrome. The e2e line “linked card shows the sub’s agent” is what stops an implementer from persisting kind and skipping glyph / colour / name. Fine as written; that e2e line is the chrome gate.

## Goal coverage / feasibility / consistency / detail

**Goal coverage.** Spawn family on all chats; board tools board-only. Linked parent-thread card shows Claude vs Cursor vs Pi via existing glyph + colour + display name in shared row/drawer chrome; unlinked rows stay cards with no invented kind; no new icon set. Kind persisted/emitted; `subModelLabel` uses the sub’s kind.

**Feasibility.** Matches `subagent-card-ui.md`: no kind on `model.Subagent` / JSON today; extras dropped on rewrite so kind is a real field (D4); label today uses parent `chat.agent`; glyphs are inline `AgentGlyph`, not files. Plan reuses that language rather than adding assets.

**Consistency.** D4, D6, Phase 1/4, web/e2e/persistence tests, and (o) agree. All-chats / MCP matrix, steering, handshake-empty list, and no path tokens are unchanged. No leftover “UI only needs `isSubagentTool`”: name recognition is the row entry; identity is additive chrome on top.

**Detail.** High-level: what appears (glyph, colour, name), where (shared chrome, not row JSX only), what not to fake (unlinked). Names existing slots, not pixels, signatures, or schemas.
