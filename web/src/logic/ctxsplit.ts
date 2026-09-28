// The context split in the composer ring's popover: its bar's segments, their order and colour
// slots, and the numbers beside them. DOM-free.

import type { AgentKind, ContextCategory, ContextItem } from "../types.ts";

/** Each known category in bar order, with its colour slot (--viz-1…8). The slots are fixed, so a
 * category keeps its colour whatever else the chat has. A category with no tokens is not drawn,
 * which puts its neighbours side by side; the order and slots were checked (dataviz
 * validate_palette.js, light and dark) for every pair that can meet that way. For that, Claude's
 * categories that may be missing (memory files, MCP tools, custom agents) each sit between two
 * that are always there, not in Claude's own order. */
const ORDER: Record<AgentKind, [string, number][]> = {
  claude: [["system_prompt", 1], ["memory_files", 4], ["system_tools", 5], ["mcp_tools", 6], ["skills", 7],
    ["custom_agents", 2], ["messages", 3]],
  cursor: [["system_prompt", 8], ["tools", 1], ["rules", 4], ["skills", 5], ["mcp", 6], ["subagents", 7],
    ["summarized_conversation", 2], ["conversation", 3]],
};

/** Claude's Messages parts, checked the same way. */
const PARTS: [string, number][] = [["tool_calls", 4], ["tool_results", 1], ["attachments", 2], ["assistant", 3],
  ["user", 7], ["redirected", 5], ["unattributed", 6]];

/** A drawn category. slot 0: an unknown category (a newer agent's), drawn neutral; the buffer is
 * drawn hatched. */
export type Segment = { cat: ContextCategory; slot: number };

function ordered(cats: ContextCategory[], order: [string, number][]): Segment[] {
  const known = new Map(order);
  const rank = new Map(order.map(([id], i) => [id, i]));
  return cats
    .filter((c) => c.tokens > 0)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (rank.get(a.c.id) ?? order.length + a.i) - (rank.get(b.c.id) ?? order.length + b.i))
    .map(({ c }) => ({ cat: c, slot: known.get(c.id) ?? 0 }));
}

/** The bar's segments: what is in the context, in bar order (unknown categories after the known
 * ones, in the agent's order), then the buffer kept free for compaction. Free space and deferred
 * tools are not segments; categories with no tokens are left out. */
export function segments(agent: AgentKind, cats: ContextCategory[]): Segment[] {
  return [
    ...ordered(cats.filter((c) => c.kind === "used"), ORDER[agent] ?? []),
    ...cats.filter((c) => c.kind === "buffer" && c.tokens > 0).map((cat) => ({ cat, slot: 0 })),
  ];
}

/** A category's parts as segments (Claude's Messages). */
export function partSegments(parts: ContextCategory[] | undefined): Segment[] {
  return ordered(parts ?? [], PARTS);
}

/** The free space: the agent's own "free" category, else what the window leaves. */
export function freeTokens(cats: ContextCategory[], window: number): number {
  const free = cats.find((c) => c.kind === "free");
  if (free) return free.tokens;
  const taken = cats.filter((c) => c.kind === "used" || c.kind === "buffer").reduce((n, c) => n + c.tokens, 0);
  return Math.max(0, window - taken);
}

/** Categories listed but not in the context (Claude's deferred tools: loaded when used). */
export function deferred(cats: ContextCategory[]): ContextCategory[] {
  return cats.filter((c) => c.kind === "deferred" && c.tokens > 0);
}

/** Items largest first; equal ones keep the agent's order. */
export function byTokens(items: ContextItem[] | undefined): ContextItem[] {
  return (items ?? []).map((it, i) => ({ it, i })).sort((a, b) => b.it.tokens - a.it.tokens || a.i - b.i).map((x) => x.it);
}

/** "0.2%", "14.3%", "81%", "<0.1%": a share of the window; "" without a window. */
export function share(tokens: number, window: number): string {
  if (!window) return "";
  const p = (tokens / window) * 100;
  if (tokens > 0 && p < 0.1) return "<0.1%";
  return p < 10 ? `${+p.toFixed(1)}%` : `${Math.round(p)}%`;
}

/** A segment's width in the bar, in percent of the window (at most 100). */
export function width(tokens: number, window: number): number {
  return window ? Math.min(100, (tokens / window) * 100) : 0;
}

export const tokensText = (n: number) => n.toLocaleString("en-US");
