// What the bar over a board's canvas says (D19), from this window's role for the board and who writes it (the follow's answer and
// the `writer` events; "" is both nobody and not known yet, and says no more than "View only."). No React here, so Node loads it.
import type { BoardRole } from "@aiwb/core/logic/roles.ts";
import type { Writer } from "@aiwb/core/types.ts";

export const EDIT_HERE = "Edit here";
export const EDITING = "Editing";
export const TAKING = "Taking over…";

export type RoleBarKind = "view" | "lost" | "taking" | "held";

/** The bar's kind and text. held: only a small mark (no text, no button). taking: a spinner, no button. The rest: the text and the
 *  button. A window that lost the board is told another window took it, unless an agent has it by now. */
export function roleBar(role: BoardRole | null | undefined, writer: Writer): { kind: RoleBarKind; text: string } {
  if (role === "held") return { kind: "held", text: EDITING };
  if (role === "taking") return { kind: "taking", text: TAKING };
  if (role === "lost" && writer !== "headless") return { kind: "lost", text: "Another window took over this board. View only." };
  const who = writer === "window" ? " Another window is editing this board." : writer === "headless" ? " An agent is editing this board." : "";
  return { kind: "view", text: "View only." + who };
}
