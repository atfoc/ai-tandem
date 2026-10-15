// A chat's two subagent settings: depth (the deepest level a subagent of the chat may be at; a
// subagent the chat's agent started is at level 1) and cap (the most subagents of the chat running
// at the same time). What the composer's Subagents chip and its popover show, and when they can be
// changed. DOM-free.
import type { ChatView } from "../types.ts";
import { agentOpen } from "./agentlist.ts";

export type SubSettings = { depth: number; cap: number };

/** What a chat has whose view names none of the settings (a chat made before them, an older server). */
export const DEFAULT_SUB_DEPTH = 1;
export const DEFAULT_SUB_CAP = 100;

/** What the popover offers. Depth 0 is Off. */
export const SUB_DEPTHS: readonly number[] = [0, 1, 2, 3];
export const SUB_CAPS: readonly number[] = [5, 10, 25, 50, 100];

/** A chat's settings from its view. Off is a field of its own there (subOff), so that a view with
 *  none of the three reads as the defaults. */
export const subSettings = (c: Pick<ChatView, "subOff" | "subDepth" | "subCap">): SubSettings =>
  ({ depth: c.subOff ? 0 : c.subDepth || DEFAULT_SUB_DEPTH, cap: c.subCap || DEFAULT_SUB_CAP });

/** A change of the settings as PATCH /api/chats/{id} takes it: subDepth 0 to 3 (0 = Off), subCap
 *  1 to 100; what is absent stays. */
export type SubChange = { subDepth?: number; subCap?: number };

export const depthLabel = (depth: number): string => (depth <= 0 ? "Off" : depth === 1 ? "1 level" : `${depth} levels`);

/** What a depth means, for the title of its row. */
export function depthNote(depth: number): string {
  if (depth <= 0) return "The agent gets no subagent tools";
  if (depth === 1) return "The agent can start subagents; they cannot start their own";
  return `Subagents can start subagents of their own, down to level ${depth}`;
}

/** The chip's label: always the depth, and the cap when it is not the default. With depth Off no
 *  subagent runs, so the cap is left out. */
export const subChipLabel = (s: SubSettings): string =>
  s.depth <= 0 || s.cap === DEFAULT_SUB_CAP ? depthLabel(s.depth) : `${depthLabel(s.depth)} · ${s.cap} at once`;

/** Both settings in words, for the chip's title: the label leaves the default cap out. */
export const subSummary = (s: SubSettings): string =>
  s.depth <= 0 ? "Off: the agent gets no subagent tools" : `${depthLabel(s.depth)}, at most ${s.cap} running at once`;

/** One row of a section of the popover; on: it is the chat's current value. */
export type SubOption = { value: number; label: string; on: boolean };

/** The values offered with the current one among them, in rising order: a chat can have a value
 *  the popover does not offer (an API client may set any cap from 1 to 100). */
const withCurrent = (offered: readonly number[], current: number): number[] =>
  offered.includes(current) ? [...offered] : [...offered, current].sort((a, b) => a - b);

export const depthOptions = (s: SubSettings): SubOption[] =>
  withCurrent(SUB_DEPTHS, s.depth).map((value) => ({ value, label: depthLabel(value), on: value === s.depth }));

export const capOptions = (s: SubSettings): SubOption[] =>
  withCurrent(SUB_CAPS, s.cap).map((value) => ({ value, label: String(value), on: value === s.cap }));

/** Whether the "Running at once" section takes no pick: with depth Off nothing runs. */
export const capOff = (s: SubSettings): boolean => s.depth <= 0;

/** The change a pick of a row makes; null for the current value, which saves nothing. */
export function subChange(s: SubSettings, section: "depth" | "cap", value: number): SubChange | null {
  if (section === "depth") return value === s.depth ? null : { subDepth: value };
  return value === s.cap || capOff(s) ? null : { subCap: value };
}

/** Why a chat's settings cannot be changed, as the fixed chip's title says it. */
export const SUB_FIXED = {
  started: "fixed once the chat has started",
  copy: "a branch and a fork keep the settings of the chat they came from",
} as const;

/** What the toolbar shows of the settings: a chip that opens the popover ("open") on a new chat,
 *  a fixed one with the reason on a started chat, a branch and a fork (also a fork without a
 *  message of its own, whose model and effort are still open, and while a move to a new branch is
 *  pending). The server is the authority: it refuses the change where the chip is fixed. */
export type SubChip = { kind: "open" } | { kind: "fixed"; why: string };

export function subChip(c: Parameters<typeof agentOpen>[0], move: boolean): SubChip {
  if (move || c.forkedFrom || c.branch) return { kind: "fixed", why: SUB_FIXED.copy };
  if (c.locked) return { kind: "fixed", why: SUB_FIXED.started };
  if (!agentOpen(c)) return { kind: "fixed", why: SUB_FIXED.copy }; // (whatever else closes a chat's first choices)
  return { kind: "open" };
}

/** The chip's title: the settings in words, then when they can be changed or why they cannot. */
export const subChipTitle = (s: SubSettings, hint: string): string => `Subagents — ${subSummary(s)} — ${hint}`;

/** A pick of the popover: configure sends the change, and the chat it answers with goes to take
 *  (the store), so the popover marks the new value at once. */
export async function pickSubs(configure: (p: SubChange) => Promise<{ chat?: ChatView }>, change: SubChange, take: (c: ChatView) => void): Promise<void> {
  const r = await configure(change);
  if (r.chat) take(r.chat);
}
