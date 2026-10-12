// Which controls of a chat composer's toolbar stay in it for the room its row has, and which go
// into the "more" popup. DOM-free: the toolbar (Composer.tsx) measures the row and each control,
// and draws every control once, where this says.

/** The controls that can leave the toolbar for the popup. Send and Stop never leave, and the
 *  context meter stays as its ring. */
export type Control = "server" | "agent" | "folder" | "model" | "effort" | "subagents";

/** Left to right in the toolbar, and top to bottom in the popup. model is the model picker, or
 *  what stands in its place: the fixed "model · effort" chip, "Loading models…". */
export const CONTROLS: Control[] = ["server", "agent", "folder", "model", "effort", "subagents"];

/** The order of leaving as room runs out, after the meter's text. Agent and model stay longest:
 *  they say whom the user talks to. The Subagents chip is the first to go: a setting made once,
 *  and the one control the toolbar did not always have, so the others are in the row wherever
 *  they were without it. */
export const LEAVING: Control[] = ["subagents", "server", "effort", "folder", "model", "agent"];

/** What decides the width a control of the toolbar asks for: its kind, what it says, whether it is
 *  a fixed chip or a choice, whether a lock stands with it, and what else is drawn in it (a glyph).
 *  The toolbar keeps a control's width under this, so a chip is measured once, whichever composer
 *  shows it. */
export const widthKey = (kind: string, label = "", o: { fixed?: boolean; lock?: boolean; mark?: string } = {}): string =>
  [kind, o.fixed ? "fixed" : "choice", o.lock ? "lock" : "", o.mark ?? "", label].join("|");

/** A toolbar's row. A width is what the control asks for, in px; one that is not known yet (the
 *  control was never measured with this label) is left out. */
export interface Row {
  /** The row's own width: its controls, the gaps between them and its spacer share it. */
  room: number;
  /** Between two children of the row. */
  gap: number;
  /** The controls the chat has, each with its width; a folder's is with its lock and the gap between the two.
   *  optional: the control only tells what a reader can do without (the fixed Subagents chip of a chat on the default
   *  settings): it costs the others nothing. */
  controls: { id: Control; w?: number; optional?: boolean }[];
  /** The context meter with its text, and cut to its ring (the error meter: to its icon). */
  meter: { full?: number; ring?: number };
  /** The "more" chip. */
  more?: number;
  /** What stands after the spacer and never leaves: Stop while the agent works, and Send. */
  fixed: (number | undefined)[];
  /** The controls the open "more" popup holds; null while it is closed. */
  held: Control[] | null;
  /** A control of the toolbar whose list is open and stays open through a pick (Subagents). */
  pinned?: Control;
}

/** Where each control is drawn. toolbar and popup are in the order of CONTROLS; more: the "more"
 *  chip is shown; meter: the context meter has its text, or its ring alone. An optional control
 *  can be in neither: it is not drawn. */
export interface Fit { toolbar: Control[]; popup: Control[]; more: boolean; meter: "full" | "ring" }

const sum = (ws: (number | undefined)[]) => ws.reduce<number>((n, w) => n + (w ?? 0), 0);

/** The px a row needs on one line with its controls placed as f says: each child's width and a gap
 *  between two of them, the spacer among them at no width. A width that is not known counts nothing. */
export function needs(r: Row, f: Fit): number {
  const chips = r.controls.filter((c) => f.toolbar.includes(c.id)).map((c) => c.w);
  const children = chips.length + (f.more ? 1 : 0) + 2 + r.fixed.length; // (the meter and the spacer)
  return sum(chips) + (f.more ? r.more ?? 0 : 0) + (f.meter === "full" ? r.meter.full ?? 0 : r.meter.ring ?? 0) + sum(r.fixed) + r.gap * (children - 1);
}

/** Places the row's controls. With all of them in the toolbar and the meter's text shown when that
 *  fits; else the text goes, then one control after the other in the order of LEAVING, the "more"
 *  chip coming with the first, until the rest fits. The last step is the "more" chip, the ring,
 *  Stop and Send, whatever the room.
 *  A control with no width stays where it is, which is the toolbar: it is measured there, and
 *  placed with the next call.
 *  While the popup is open (held) nothing it holds returns to the toolbar, however wide the row,
 *  and one with no width stays in it (a pick has changed its label there); a control of the
 *  toolbar still leaves for it, and one the chat has got since is placed as any other. So the
 *  toolbar fits its row at every moment, and returns are for the call after the popup closed.
 *  A pinned control is the last to leave, whatever its place in LEAVING: a pick in its open list
 *  can make its chip wider, and a control that changes place loses its list.
 *  An optional control is placed after the others, where they leave it room: in the toolbar when
 *  every control is there with the meter's text and it fits beside them; in the popup when the
 *  popup holds another; else nowhere. It never brings the "more" chip, sends a control to the
 *  popup or takes the meter's text. (One with no width is in the toolbar like any other, to be
 *  measured.) */
export function fit(r: Row): Fit {
  const all = CONTROLS.filter((id) => r.controls.some((c) => c.id === id));
  const known = (id: Control) => r.controls.find((c) => c.id === id)?.w !== undefined;
  const extra = all.filter((id) => known(id) && r.controls.find((c) => c.id === id)!.optional);
  const f = place(r, all.filter((id) => !extra.includes(id)), known);
  if (!extra.length) return f;
  if (f.popup.length) return { ...f, popup: all.filter((id) => f.popup.includes(id) || extra.includes(id)) };
  const beside: Fit = { ...f, toolbar: all.filter((id) => f.toolbar.includes(id) || extra.includes(id)) };
  return f.meter === "full" && needs(r, beside) <= r.room + 1e-6 ? beside : f;
}

/** fit for the controls has, the row's that are not optional. */
function place(r: Row, has: Control[], known: (id: Control) => boolean): Fit {
  const held = (r.held ?? []).filter((id) => has.includes(id));
  const leaves = LEAVING.filter((id) => has.includes(id) && !held.includes(id) && known(id));
  const leaving = [...leaves.filter((id) => id !== r.pinned), ...leaves.filter((id) => id === r.pinned)];
  const step = (n: number, meter: Fit["meter"]): Fit => {
    const popup = has.filter((id) => held.includes(id) || leaving.slice(0, n).includes(id));
    return { toolbar: has.filter((id) => !popup.includes(id)), popup, more: popup.length > 0, meter };
  };
  // The meter's text is the first to go: it shows only with every control in the toolbar.
  const steps = [...(held.length ? [] : [step(0, "full")]), ...leaving.map((_, n) => step(n, "ring")), step(leaving.length, "ring")];
  return steps.find((f) => needs(r, f) <= r.room + 1e-6) ?? steps[steps.length - 1];
}
