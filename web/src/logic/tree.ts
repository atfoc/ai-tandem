// The sidebar tree: groups with their subgroups, boards and plain chats, and the
// loose (ungrouped) area. DOM-free; Sidebar.tsx renders it.

import type { Board, ChatView, Group } from "../types.ts";
import { UNGROUPED } from "../types.ts";

export type GroupTree = { group: Group; boards: Board[]; chats: ChatView[]; children: GroupTree[] };

export type Tree = {
  loose: { boards: Board[]; chats: ChatView[] };
  groups: GroupTree[];
};

const shown = (x: { archived?: boolean }, showArchived: boolean) => showArchived || !x.archived;

/** Boards by name (id breaks ties, since names are not unique). */
const byName = (a: Board, b: Board) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Chats newest first. */
const newestFirst = (a: ChatView, b: ChatView) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

/** The group and the groups above it, innermost first. Stops at a missing parent (and a cycle). */
function chain(groups: Group[], id: string): Group[] {
  const out: Group[] = [];
  for (let g = groups.find((x) => x.id === id); g && !out.includes(g); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) {
    out.push(g);
  }
  return out;
}

/**
 * A group shows when it and every group above it show. A group whose parent is gone sits at the
 * top level; the contents of a group that doesn't show fall into loose.
 */
export function buildTree(
  s: { groups: Group[]; boards: Record<string, Board>; chats: Record<string, ChatView> },
  showArchived: boolean,
): Tree {
  const groups = s.groups.filter((g) => chain(s.groups, g.id).every((x) => shown(x, showArchived)));
  const known = new Set(groups.map((g) => g.id));
  const parentOf = (g: Group) => (g.parent && known.has(g.parent) ? g.parent : "");
  const boards = Object.values(s.boards).filter((b) => shown(b, showArchived)).sort(byName);
  const chats = Object.values(s.chats).filter((c) => !c.board && shown(c, showArchived)).sort(newestFirst);
  const chatGroup = (c: ChatView) => c.group ?? "";
  const node = (group: Group): GroupTree => ({
    group,
    boards: boards.filter((b) => b.group === group.id),
    chats: chats.filter((c) => chatGroup(c) === group.id),
    children: groups.filter((g) => parentOf(g) === group.id).map(node),
  });
  return {
    loose: {
      boards: boards.filter((b) => !known.has(b.group)),
      chats: chats.filter((c) => !known.has(chatGroup(c))),
    },
    groups: groups.filter((g) => parentOf(g) === "").map(node),
  };
}

/** A node's boards and plain chats, its subgroups' included. */
export function contents(n: GroupTree): { boards: Board[]; chats: ChatView[] } {
  const inner = n.children.map(contents);
  return {
    boards: [...n.boards, ...inner.flatMap((x) => x.boards)],
    chats: [...n.chats, ...inner.flatMap((x) => x.chats)],
  };
}

/** The group and every group nested in it, at any depth. */
export function subtree(groups: Group[], id: string): Set<string> {
  const out = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of groups) {
      if (!out.has(g.id) && g.parent && out.has(g.parent)) { out.add(g.id); grew = true; }
    }
  }
  return out;
}

/** The names from the top-level group down to the group; empty for ungrouped or an unknown group. */
export function groupPath(groups: Group[], id: string): string[] {
  return id === UNGROUPED ? [] : chain(groups, id).map((g) => g.name).reverse();
}

/** A board's own chats, newest first. */
export function boardChats(chats: Record<string, ChatView>, board: string, showArchived: boolean): ChatView[] {
  return Object.values(chats).filter((c) => c.board === board && shown(c, showArchived)).sort(newestFirst);
}
