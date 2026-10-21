// Which controls of a chat composer's toolbar stay in it for the room its row has, and which go
// into the "more" popup. DOM-free: the toolbar (Composer.tsx) measures the row and each control,
// and draws every control once, where this says.

/** The controls that can leave the toolbar for the popup. Send and Stop never leave, and the
 *  context meter stays as its ring. */
export type Control = "server" | "agent" | "folder" | "model" | "effort" | "subagents";

/** Left to right in the toolbar, and top to bottom in the popup. model is the model picker, or
 *  what stands in its place: the fixed "model · effort" chip, "Loading models…". */
export const CONTROLS: Control[] = ["server", "agent", "folder", "model", "effort", "subagents"];

/** The order of leaving as room runs out. The agent stays longest: it says whom the user talks to.
 *  The Subagents chip is the first to go: a setting made once, and the one control the toolbar
 *  did not always have, so the others are in the row wherever they were without it. */
export const LEAVING: Control[] = ["subagents", "server", "effort", "folder", "model", "agent"];

/** The meter's text goes just before this control: after every other, since it tells how much of
 *  the context the chat has used; and before the agent, which stays longest. */
export const TEXT_BEFORE: Control = "agent";

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
 *  fits; else one control after the other leaves in the order of LEAVING, the "more" chip coming
 *  with the first, and the meter's text goes just before TEXT_BEFORE (last, where the chat has no
 *  such control), until the rest fits. The last step is the "more" chip, the ring, Stop and Send,
 *  whatever the room.
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

/** Where the way to the insert popup is drawn: "row", its button after the spacer, before Stop and Send; "more", an
 *  entry of the "more" popup; "", nowhere: the popup is then opened by its key alone. */
export type InsertPlace = "row" | "more" | "";

/** fit, and where the way to the insert popup is (r.fixed is without its button). The button is drawn where the row
 *  has room left for it: placed with the button, every control is where it is without it, the meter says what it
 *  says without it, and all of it fits. So the button takes nothing from them, no control goes to the popup for it
 *  and the meter keeps its text. Only an optional control gives way to it, which tells what a reader can do without.
 *  Where the row has no room left, the "more" popup has the entry when the row has that chip anyway (a control is in
 *  it): the entry costs the row nothing. A row that is whole and leaves the button no room has neither.
 *  w: the button's width; one that is not known yet counts nothing, so the button is drawn, to be measured.
 *  held: the open "more" popup has the entry. As a control it holds, the entry does not return to the row while the
 *  popup is open, however wide the row. */
export function fitWithInsert(r: Row, w?: number, held = false): { fit: Fit; insert: InsertPlace } {
  const with_: Row = { ...r, fixed: [w, ...r.fixed] }, plain = fit(r), beside = fit(with_);
  const spare = r.controls.filter((c) => c.optional).map((c) => c.id);
  const firm = (f: Fit) => [f.meter, ...f.toolbar.filter((id) => !spare.includes(id)), "", ...f.popup.filter((id) => !spare.includes(id))].join();
  if (!(held && plain.more) && firm(beside) === firm(plain) && needs(with_, beside) <= r.room + 1e-6) return { fit: beside, insert: "row" };
  return { fit: plain, insert: plain.more ? "more" : "" };
}

/** Where the voice pair (Dictate and Speech mode, drawn as one child of the row) is: "row", after the spacer and the
 *  insert button, before the attach button; "more", two entries of the "more" popup. */
export type VoicePlace = "row" | "more";

/** fitWithInsert, and where the voice pair is. The pair stays in the row beside the attach button as long as the row can
 *  hold it: the controls leave for the popup, and the meter's text goes, before the pair does (the row is fitted with the
 *  pair as one of what never leaves). Only where the row cannot hold it even at the last step (every control in the popup,
 *  the meter cut to its ring) is the pair in the "more" popup, as two entries, and brings the chip if the row had none (the
 *  row is then fitted with the chip, which can send controls to the popup in turn). The insert button gives way first: it
 *  is placed in what the pair leaves, and where the pair is in the popup the button's entry is in it too.
 *  w: the widths of the button and of the pair as a whole; one that is not known yet counts nothing, so it is drawn, to be
 *  measured. held: the open "more" popup has the button's entry, or the pair's; each stays in it however wide the row,
 *  as a control does. fitWithInsert is this without a pair. */
export function fitWithTail(r: Row, w: { insert?: number; voice?: number }, held: { insert: boolean; voice: boolean }):
  { fit: Fit; insert: InsertPlace; voice: VoicePlace } {
  const plain = fit(r), pinned: Row = { ...r, fixed: [w.voice, ...r.fixed] };
  if (!(held.voice && plain.more) && needs(pinned, fit(pinned)) <= r.room + 1e-6) {
    const rest = fitWithInsert(pinned, w.insert, held.insert);
    return { fit: rest.fit, insert: rest.insert, voice: "row" };
  }
  if (plain.more) return { fit: sparedToPopup(r, plain), insert: "more", voice: "more" };
  // The row has no chip and no room for the pair: the chip comes with it, and takes the room it needs.
  const chip = fit({ ...r, fixed: [r.more, ...r.fixed] });
  return { fit: sparedToPopup(r, { ...chip, more: true }), insert: "more", voice: "more" };
}

/** Where the "more" chip is there anyway (the pair is in its popup), an optional control that has no room in the toolbar goes to the popup, which
 *  costs the row nothing: a choice is never left out of both (fit leaves one out only where there is no popup to put it in). */
function sparedToPopup(r: Row, f: Fit): Fit {
  const left = r.controls.filter((c) => c.optional && c.w !== undefined && !f.toolbar.includes(c.id) && !f.popup.includes(c.id)).map((c) => c.id);
  return left.length ? { ...f, popup: CONTROLS.filter((id) => f.popup.includes(id) || left.includes(id)) } : f;
}

/** fit for the controls has, the row's that are not optional. */
function place(r: Row, has: Control[], known: (id: Control) => boolean): Fit {
  const held = (r.held ?? []).filter((id) => has.includes(id));
  const leaves = LEAVING.filter((id) => has.includes(id) && !held.includes(id) && known(id));
  const leaving = [...leaves.filter((id) => id !== r.pinned), ...leaves.filter((id) => id === r.pinned)];
  // What goes, in order: the controls, and the meter's text ("text") just before TEXT_BEFORE.
  const at = leaving.includes(TEXT_BEFORE) ? leaving.indexOf(TEXT_BEFORE) : leaving.length;
  const order = [...leaving.slice(0, at), "text" as const, ...leaving.slice(at)];
  const step = (n: number): Fit => {
    const gone = order.slice(0, n);
    const popup = has.filter((id) => held.includes(id) || gone.includes(id));
    return { toolbar: has.filter((id) => !popup.includes(id)), popup, more: popup.length > 0, meter: gone.includes("text") ? "ring" : "full" };
  };
  const steps = [...order.map((_, n) => step(n)), step(order.length)];
  return steps.find((f) => needs(r, f) <= r.room + 1e-6) ?? steps[steps.length - 1];
}
