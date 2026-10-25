// What the phone's pick bar says (ux-improvements B2, plans/ux-improvements/b2-design.md §6) while a chat of the board waits: the title,
// the sub-line and the one button, from what is waited for, the window's role for the board and the number of shapes selected. No React
// here, so Node loads it.
import type { BoardRole } from "@aiwb/core/logic/roles.ts";

import { EDIT_HERE, TAKING } from "./rolebar.ts";

export const PICK_TITLE = { point: "Tap a spot on the board", select: "Select items" } as const;
export const CANCEL = "Cancel";

export type PickButton =
  | { kind: "cancel"; label: string }
  | { kind: "add"; label: string; count: number; off: boolean }
  | { kind: "take"; label: string; off: false }
  | { kind: "taking"; label: string; off: true };

/** The bar: `kind` is what is waited for; `role` the window's role for the board (a reader gets Edit here, then Add (n)). `sub` is
 *  `for “<chat name>”`. */
export function pickBar(kind: "point" | "select", role: BoardRole | null | undefined, count: number, chatName: string): {
  kind: "point" | "select"; title: string; sub: string; button: PickButton;
} {
  const sub = `for “${chatName}”`;
  if (kind === "point") return { kind, title: PICK_TITLE.point, sub, button: { kind: "cancel", label: CANCEL } };
  if (role === "taking") return { kind, title: PICK_TITLE.select, sub, button: { kind: "taking", label: TAKING, off: true } };
  if (role !== "held") return { kind, title: PICK_TITLE.select, sub, button: { kind: "take", label: EDIT_HERE, off: false } };
  return { kind, title: PICK_TITLE.select, sub, button: { kind: "add", label: `Add (${count})`, count, off: count === 0 } };
}
