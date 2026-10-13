// The sidebar's one drop mark: where a drag would land, which group is being dragged, and which
// server what is dragged is on. DOM-free.
//
// One mark for the whole sidebar, and not a flag per zone: a drop that an inner zone handles, or a
// drag that ends with no word to the zone it was over, then leaves nothing lit behind.

export type DropMark = {
  zone: string | null;   // the zone the pointer is in: a group's key, or the key of a server's ungrouped area
  before: string | null; // the group whose header's upper half it is on: a dragged group goes before it
  group: string | null;  // the group being dragged, so that a target can refuse the group itself and its subgroups
  server: string | null; // the entry id of the server what is dragged is on ("local": this computer); null: no drag that began in this window
};

export const NO_MARK: DropMark = { zone: null, before: null, group: null, server: null };

export type DropEvent =
  | { type: "start"; group: string | null; server: string } // a drag began in the sidebar: of a group's header, or of a row (null), on that server
  | { type: "in"; zone: string }            // the zone takes what is dragged over it
  | { type: "before"; head: string }        // the upper half of a group's header takes the dragged group
  | { type: "out"; zone: string }           // the pointer left the zone
  | { type: "off"; head: string }           // the pointer left the header
  | { type: "nowhere" }                     // nothing takes the drag where the pointer is, or no drag is left
  | { type: "end" };                        // a drop, or the drag's end

/** The mark after an event. An event that changes nothing answers the mark it was given: a dragover comes all the
 *  time, and a new mark asks every selector of the page. At most one place is lit, a zone or a header. "nowhere"
 *  empties what is lit and keeps the dragged group, which only a start and an end change. */
export function dropMark(m: DropMark, e: DropEvent): DropMark {
  const to = (zone: string | null, before: string | null, group = m.group, server = m.server): DropMark =>
    (zone === m.zone && before === m.before && group === m.group && server === m.server ? m : { zone, before, group, server });
  switch (e.type) {
    case "start": return to(null, null, e.group, e.server);
    case "in": return to(e.zone, null);
    case "before": return to(null, e.head);
    case "out": return to(m.zone === e.zone ? null : m.zone, m.before);
    case "off": return to(m.zone, m.before === e.head ? null : m.before);
    case "nowhere": return to(null, null);
    case "end": return to(null, null, null, null);
  }
}

/** Whether a zone or a header of a server takes what is dragged: only what is on that same server. Nothing is moved
 *  from one section to another, or between a section and the local part: such a drop is not offered. A drag that did
 *  not begin in this window (server null: another window of the app) is judged when it is dropped, by what it carries. */
export const takesFrom = (m: Pick<DropMark, "server">, server: string): boolean => m.server === null || m.server === server;

/** What the window is listened to for besides the zones' own handlers, and what each event is to the mark.
 *
 *  A drop and a drag's end are heard in the bubble phase: a capture listener would empty the mark before the
 *  header's handler has read it, and a drop that a zone handled never comes this far (the handler stops it). A
 *  dragover that comes this far was taken by no zone: the pointer is outside them all, also when the dragleave that
 *  should have said so was lost with a node removed under the pointer.
 *
 *  A drag's end can be lost to the window: it is fired at the dragged node, and one removed meanwhile passes it on
 *  to nobody (the node itself hears it: SOURCE_END); a drag from another window of the app has no node here at all.
 *  So the first press, move of the pointer or key after it empties what is lit, and that alone: a browser sends none
 *  of the three during a drag, and one that came all the same must not make a dragged group refuse every target.
 *  They are heard in the capture phase, where a listener that stops a key cannot hide it. Never pointercancel,
 *  pointerout or pointerleave: a browser sends the first two right after dragstart, in every drag. */
export const WINDOW_EVENTS: readonly { type: string; capture: boolean; event: DropEvent }[] = [
  { type: "drop", capture: false, event: { type: "end" } },
  { type: "dragend", capture: false, event: { type: "end" } },
  { type: "dragover", capture: false, event: { type: "nowhere" } },
  { type: "pointerdown", capture: true, event: { type: "nowhere" } },
  { type: "pointermove", capture: true, event: { type: "nowhere" } },
  { type: "keydown", capture: true, event: { type: "nowhere" } },
];

/** What the dragged row or header itself is listened to for, from its dragstart on: the end of its drag. Once the
 *  element has left the page (its chat removed in mid-drag, its group mounted anew elsewhere) it alone is told, and
 *  the window hears nothing. */
export const SOURCE_END: { type: string; event: DropEvent } = { type: "dragend", event: { type: "end" } };
