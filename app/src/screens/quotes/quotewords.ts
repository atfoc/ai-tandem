// The words of the phone's Quote sheet and of Select text, its other mode (ux-improvements goal 3.5): the title for the message and the mode,
// and which buttons the mode has. Pure, so a test can read the choice without drawing the sheet.
import { agentShortName } from "@aiwb/core/agents.ts";

import type { PickMode } from "./sheetstore.ts";

/** "Select text"; "Quote from your message" for the person's own; else "Quote from Claude's reply" (the agent's short name). */
export function quoteTitle(mode: PickMode, own: boolean, agent?: string): string {
  if (mode === "select") return "Select text";
  if (own) return "Quote from your message";
  return `Quote from ${agent ? agentShortName(agent) : "the agent"}'s reply`;
}

export const PICK_HINT = "Drag the handles to pick the words.";

/** The two buttons of a mode: the one that needs words selected, then the one for the whole message. */
export const pickButtons = (mode: PickMode) =>
  mode === "select"
    ? { selection: "Copy selection", whole: "Copy all" }
    : { selection: "Quote selection", whole: "Whole message" };

/** Select text works whatever keeps a quote; a quote is blocked by its reason. */
export const pickBlocked = (mode: PickMode, why: string): boolean => mode !== "select" && !!why;
