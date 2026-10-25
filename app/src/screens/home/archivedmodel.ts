// What Settings › Archived lists for one server (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §0 H2-7, §5):
// the archived groups, boards and chats that do not come back with something else (an archived group or board of the same `archiveOp`),
// each under the name of the group it is in. No React and no react-native here, so Node loads it (test/h2-archived.test.ts); Archived.tsx
// only draws what it says. The rows are Home's (model.ts RowItem), with no time and no archive date on them (H2-2).
import { isUngrouped, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import type { Board, ChatView, Group } from "@aiwb/core/types.ts";

import { subline } from "../sidebar/subline.ts";
import { boardSub, groupSub, type PlaceInput, type RowItem } from "./model.ts";

/** One head of the list and the rows under it. `group` is the key of the group the rows are in ("" for none: the first section, with no
 *  head); `heading` is its path, outermost first, joined " › " in upper case ("" for none). */
export type ArchivedSection = { group: string; heading: string; items: RowItem[] };

/** The groups from the top level down to `id`, outermost first; stops at a missing parent and at a cycle. */
function chainOf(groups: readonly Group[], id: string | undefined): Group[] {
  const out: Group[] = [];
  for (let g = id && !isUngrouped(id) ? groups.find((x) => x.id === id) : undefined; g && !out.includes(g); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) out.unshift(g);
  return out;
}

/** The order the groups come in a tree: a group, then what is nested in it; top-level groups in the order of the list. */
function treeOrder(groups: readonly Group[]): Map<string, number> {
  const known = new Set(groups.map((g) => g.id)), order = new Map<string, number>();
  const walk = (parent: string): void => {
    for (const g of groups) {
      if ((g.parent && known.has(g.parent) ? g.parent : "") !== parent || order.has(g.id)) continue;
      order.set(g.id, order.size);
      walk(g.id);
    }
  };
  walk("");
  groups.forEach((g) => { if (!order.has(g.id)) order.set(g.id, order.size); }); // (a cycle is not reached from the top)
  return order;
}

/** The archived things of one server, in sections: ungrouped first, then the groups in tree order. Within a section groups come first, then
 *  boards by name, then chats newest first, as Home's lists do. `server` is the entry id; things that are `gone` are not listed. */
export function archivedSections(input: PlaceInput, server: string): ArchivedSection[] {
  const here = (id: string) => serverOfKey(id) === server && !input.gone?.[id];
  const groups = input.groups, boards = Object.values(input.boards).filter((b) => here(b.id)), chats = Object.values(input.chats).filter((c) => here(c.id));
  const group = (id: string | undefined) => groups.find((g) => g.id === id);
  const boardOf = (id: string | undefined) => (id ? input.boards[id] : undefined);

  /** Whether something archived in operation `op` that sits in group `id` comes back with a group above it that was archived in the same one. */
  const underGroup = (op: string | undefined, id: string | undefined): boolean => !!op && chainOf(groups, id).some((g) => g.archived && g.archiveOp === op);
  const placeOfChat = (c: ChatView): string | undefined => (c.board ? boardOf(c.board)?.group : c.group);
  const covered = {
    group: (g: Group) => underGroup(g.archiveOp, g.parent),
    board: (b: Board) => underGroup(b.archiveOp, b.group),
    chat: (c: ChatView) => {
      const b = boardOf(c.board);
      return !!c.archiveOp && ((!!b && b.archived === true && b.archiveOp === c.archiveOp) || underGroup(c.archiveOp, placeOfChat(c)));
    },
  };

  /** The groups an item is in that are not archived themselves: an archived one is a row of its own, not a head. */
  const headPath = (id: string | undefined, self?: Group): Group[] => chainOf(groups, id).filter((g) => g !== self && !g.archived);

  type Entry = { place: Group[]; item: RowItem };
  const entries: Entry[] = [];
  const sorted = <T,>(xs: T[], cmp: (a: T, b: T) => number) => xs.slice().sort(cmp);

  for (const g of groups) {
    if (!g.archived || !here(g.id) || covered.group(g)) continue;
    const op = g.archiveOp, mine = (x: { archived?: boolean; archiveOp?: string }) => !!op && x.archived === true && x.archiveOp === op;
    const inGroup = (id: string | undefined) => id === g.id;
    const counts = {
      groups: groups.filter((x) => x.parent === g.id && mine(x)).length,
      boards: boards.filter((b) => inGroup(b.group) && mine(b)).length,
      chats: chats.filter((c) => !c.board && inGroup(c.group) && mine(c)).length,
    };
    entries.push({ place: headPath(g.parent), item: { kind: "group", key: g.id, server, name: g.name, sub: groupSub(counts), attention: { kind: "none" } } });
  }
  for (const b of sorted(boards, (x, y) => x.name.localeCompare(y.name) || (x.id < y.id ? -1 : 1))) {
    if (!b.archived || covered.board(b)) continue;
    const own = chats.filter((c) => c.board === b.id).length;
    entries.push({ place: headPath(b.group), item: { kind: "board", key: b.id, server, name: b.name, sub: boardSub(own), attention: { kind: "none" } } });
  }
  const titleOf = input.titleOf ?? ((c: ChatView) => chatTitle(c));
  for (const c of sorted(chats, (x, y) => (x.created < y.created ? 1 : x.created > y.created ? -1 : x.id < y.id ? -1 : 1))) {
    if (!c.archived || covered.chat(c)) continue;
    const sub = subline(c, c.agent ? input.catalogs?.[c.agent] ?? undefined : undefined);
    entries.push({ place: headPath(placeOfChat(c)), item: { kind: "chat", key: c.id, server, name: titleOf(c), sub, attention: { kind: "none" }, agent: c.agent } });
  }

  const order = treeOrder(groups), sections = new Map<string, ArchivedSection>(), at = new Map<string, number>();
  for (const { place, item } of entries) {
    const last = place[place.length - 1], key = last?.id ?? "";
    let s = sections.get(key);
    if (!s) {
      s = { group: key, heading: place.map((g) => g.name).join(" › ").toUpperCase(), items: [] };
      sections.set(key, s);
      at.set(key, last ? order.get(last.id) ?? Infinity : -1);
    }
    s.items.push(item);
  }
  return [...sections.values()].sort((a, b) => at.get(a.group)! - at.get(b.group)!);
}

/** How many rows a server lists. */
export const archivedCount = (sections: readonly ArchivedSection[]): number => sections.reduce((n, s) => n + s.items.length, 0);

/** The words under a server whose tree the page does not hold. */
export const ARCHIVED_AWAY = "Its archived chats show when it is connected.";
export const ARCHIVED_NONE = "Nothing is archived.";
export const ARCHIVED_FOOT = "Archived chats are read-only. Unarchive one to continue it.";
