// Where a drag would land: the pure part of the sidebar's drag and drop (AD-70). The page's HTML drag events told each zone and each header
// what was over it; a pointer gesture has only a point in the window, so the places are measured (their rectangles, in window
// coordinates) and the point is looked up in them. The answer is the event the one drop mark takes (logic/dropmark.ts), with the rules of
// the old page's handlers: the innermost zone under the pointer alone is lit; the upper half of a group's header takes a dragged group
// before that group; a place that refuses what is dragged lights nothing, and the zone around it does not light in its place.
import type { DropEvent, DropMark } from "@aiwb/core/logic/dropmark.ts";
import { takesFrom } from "@aiwb/core/logic/dropmark.ts";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** The places of the sidebar as they are on screen now. clip: what of the tree is visible (the places outside it, scrolled away, take
 *  nothing); zones: each group's whole box and each server's ungrouped area, by the group's key (the area's key); heads: each group's header. */
export type Places = {
  clip: Rect | null;
  zones: { group: string; rect: Rect }[];
  heads: { group: string; rect: Rect }[];
};

/** What the rules of the drop say: whether a zone or header of the server `of` takes what is dragged, and whether a dragged group may
 *  go into (or before) a group. */
export type Rules = {
  takes: (m: Pick<DropMark, "server">, group: string) => boolean;
  canTakeGroup: (target: string, into: boolean) => boolean;
};

export const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
const area = (r: Rect): number => r.width * r.height;

/** The drop mark's event for a pointer at `at`. `mark` is the mark now (what is dragged: its group, its server). */
export function dropEventAt(at: Point, places: Places, mark: Pick<DropMark, "group" | "server">, rules: Rules): DropEvent {
  if (places.clip && !inside(places.clip, at)) return { type: "nowhere" };
  // a group's header: its upper half takes a dragged group before it, unless that is refused (then the zone around, below)
  if (mark.group) {
    const head = places.heads.find((h) => inside(h.rect, at));
    if (head && at.y < head.rect.y + head.rect.height / 2 && rules.takes(mark, head.group) && rules.canTakeGroup(head.group, false)) return { type: "before", head: head.group };
  }
  // the innermost zone: the smallest box that holds the point (a group's box holds its subgroups')
  let zone: { group: string; rect: Rect } | null = null;
  for (const z of places.zones) if (inside(z.rect, at) && (!zone || area(z.rect) < area(zone.rect))) zone = z;
  if (!zone) return { type: "nowhere" };
  if (!rules.takes(mark, zone.group) || (mark.group && !rules.canTakeGroup(zone.group, true))) return { type: "nowhere" };
  return { type: "in", zone: zone.group };
}

/** `takesFrom` of the drop mark, by the server a group's key names (the page's rule: only what is on that same server). */
export const takesOn = (serverOfKey: (key: string) => string) => (m: Pick<DropMark, "server">, group: string): boolean => takesFrom(m, serverOfKey(group));

/** How the list scrolls under a drag held near its edge: the speed in pixels a tick, negative up, positive down, 0 away from the edges. It
 *  grows from 1 at the edge zone's inner line to 14 at the edge; nothing outside the list's box. */
export const EDGE = 36;
export function edgeSpeed(at: Point, clip: Rect | null, edge = EDGE): number {
  if (!clip || at.x < clip.x || at.x >= clip.x + clip.width) return 0;
  const top = at.y - clip.y, bottom = clip.y + clip.height - at.y;
  if (top >= 0 && top < edge) return -Math.max(1, Math.round((14 * (edge - top)) / edge));
  if (bottom > 0 && bottom <= edge) return Math.max(1, Math.round((14 * (edge - bottom)) / edge));
  return 0;
}
