// Per-agent display metadata: the name, colour slot and glyph each agent kind draws in.
// Everything that shows an agent goes through here, so a new kind gets its own look instead of
// silently falling through to Claude. An unknown kind falls back to its raw string and a neutral
// slot (no DOM, no React: board.ts and tests use this too).

import type { AgentKind } from "./types.ts";

/** A glyph key; each has a matching .glyph.<key> rule. "unknown" is the neutral fallback. */
export type GlyphKind = "claude" | "cursor" | "pi" | "unknown";

export type AgentMeta = {
  /** The name the user sees. */
  name: string;
  /** A short name for tight spots (presence pill, flash tags). */
  short: string;
  /** The CSS slot: .agent-<cls> and .glyph.<cls>. */
  cls: string;
  /** Which glyph AgentGlyph draws. */
  glyph: GlyphKind;
  /** The usage popover's heading; none for an agent with no plan usage to ask for. */
  usageTitle?: string;
};

const AGENTS: Record<string, AgentMeta> = {
  claude: { name: "Claude Code", short: "Claude", cls: "claude", glyph: "claude", usageTitle: "Plan usage limits" },
  cursor: { name: "Cursor", short: "Cursor", cls: "cursor", glyph: "cursor", usageTitle: "Cursor usage" },
  pi: { name: "Pi", short: "Pi", cls: "pi", glyph: "pi" },
};

/** An agent's display metadata. An unknown kind uses its raw string (never another agent's name)
 *  and the neutral "unknown" slot. */
export function agentMeta(kind: AgentKind | string): AgentMeta {
  switch (kind) {
    case "claude": return AGENTS.claude;
    case "cursor": return AGENTS.cursor;
    case "pi": return AGENTS.pi;
    default: return { name: String(kind), short: String(kind), cls: "unknown", glyph: "unknown", usageTitle: "Plan usage limits" };
  }
}

/** The agent's name as the user sees it. */
export const agentName = (kind: AgentKind | string) => agentMeta(kind).name;

/** A short agent name for tight spots (presence pill, flash tags). */
export const agentShortName = (kind: AgentKind | string) => agentMeta(kind).short;

/** The agent's colour slot, for `agent-${agentClass(kind)}` and `.glyph.<class>`. */
export const agentClass = (kind: AgentKind | string) => agentMeta(kind).cls;
