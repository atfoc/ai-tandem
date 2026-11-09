// Per-agent display metadata: the name, colour slot and glyph each agent kind draws in.
// Everything that shows an agent goes through here, so a new kind gets its own look instead of
// silently falling through to Claude. An unknown kind falls back to its raw string and a neutral
// slot (no DOM, no React: board.ts and tests use this too).
//
// A Claude account's kind ("claude:<id>") draws as Claude does, under the account's own name. The names come from the
// servers' lists of accounts: the store feeds them here (setAliasNames) whenever a list arrives, before it tells its
// subscribers, so whatever draws again after that reads the new name. A kind the registry lacks (a removed account,
// or a list that has not arrived yet) is "Claude account".

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

/** The names of the Claude accounts, by kind ("claude:<id>"): every server's, fed by the store. */
let aliasNames: Record<string, string> = {};

/** The name a Claude account's kind draws under when the registry has none for it. */
export const UNNAMED_ACCOUNT = "Claude account";

/** Replaces the names of the Claude accounts (by kind, "claude:<id>") with names: the store calls it after every list. */
export function setAliasNames(names: Record<string, string>) { aliasNames = { ...names }; }

/** An agent's display metadata. A Claude account's kind is drawn as Claude, under the account's name. An unknown
 *  kind uses its raw string (never another agent's name) and the neutral "unknown" slot. */
export function agentMeta(kind: AgentKind | string): AgentMeta {
  switch (kind) {
    case "claude": return AGENTS.claude;
    case "cursor": return AGENTS.cursor;
    case "pi": return AGENTS.pi;
    default: {
      if (isAliasKind(kind)) { const name = aliasNames[String(kind)] || UNNAMED_ACCOUNT; return { name, short: name, cls: "claude", glyph: "claude", usageTitle: "Plan usage limits" }; }
      return { name: String(kind), short: String(kind), cls: "unknown", glyph: "unknown", usageTitle: "Plan usage limits" };
    }
  }
}

/** The agent's name as the user sees it. */
export const agentName = (kind: AgentKind | string) => agentMeta(kind).name;

/** A short agent name for tight spots (presence pill, flash tags). */
export const agentShortName = (kind: AgentKind | string) => agentMeta(kind).short;

/** The agent's colour slot, for `agent-${agentClass(kind)}` and `.glyph.<class>`. */
export const agentClass = (kind: AgentKind | string) => agentMeta(kind).cls;

/** The start of a Claude account's agent kind (model.AliasPrefix). */
export const ALIAS_PREFIX = "claude:";

const ALIAS_ID = /^a_[0-9a-z]{8}$/;

/** The agent kind of the Claude account id (model.AliasKind). */
export const aliasKind = (id: string): AgentKind => `claude:${id}`;

/** The account id of a Claude account's kind, "" for every other kind (Claude Code's own included) (model.AliasID). */
export function aliasIdOf(kind: AgentKind | string): string {
  const s = String(kind);
  if (!s.startsWith(ALIAS_PREFIX)) return "";
  const id = s.slice(ALIAS_PREFIX.length);
  return ALIAS_ID.test(id) ? id : "";
}

/** Whether kind is a Claude account's (not Claude Code's own) (model.IsAlias). */
export const isAliasKind = (kind: AgentKind | string): boolean => aliasIdOf(kind) !== "";

/** Whether kind is Claude Code: the computer's own or a Claude account (model.IsClaude). */
export const isClaudeKind = (kind: AgentKind | string): boolean => kind === "claude" || isAliasKind(kind);

/** The kind whose way of working kind has: "claude" for every Claude account, kind itself otherwise (model.AgentKind.Family). */
export const agentFamily = (kind: AgentKind | string): string => (isAliasKind(kind) ? "claude" : String(kind));
