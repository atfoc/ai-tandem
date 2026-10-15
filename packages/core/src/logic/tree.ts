// The sidebar tree: groups with their subgroups, boards and plain chats, and the
// loose (ungrouped) area. DOM-free; Sidebar.tsx renders it.

import type { Board, ChatView, Group } from "../types.ts";
import { LOCAL_SERVER } from "../types.ts";
import { isUngrouped, serverOfKey } from "./keys.ts";

export type GroupTree = { group: Group; boards: Board[]; chats: ChatView[]; children: GroupTree[] };

export type Tree = {
  loose: { boards: Board[]; chats: ChatView[] };
  groups: GroupTree[];
};

const shown = (x: { archived?: boolean }, showArchived: boolean) => showArchived || !x.archived;

/** Boards by name (id breaks ties, since names are not unique). */
const byName = (a: Board, b: Board) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Chats newest first (id breaks ties). */
const newestFirst = (a: { created: string; id: string }, b: { created: string; id: string }) =>
  a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The group and the groups above it, innermost first. Stops at a missing parent (and a cycle). */
function chain(groups: Group[], id: string): Group[] {
  const out: Group[] = [];
  for (let g = groups.find((x) => x.id === id); g && !out.includes(g); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) {
    out.push(g);
  }
  return out;
}

/**
 * The tree of one server: this computer's (the first section of the sidebar), or another's.
 * groups: that server's groups. boards, chats: the store's, of every server; only that
 * server's are in the tree (o.server: its entry id, this computer without one), and of those none
 * that is no longer on its server (o.gone: it is on screen, and has no row).
 *
 * A group shows when it and every group above it show. A group whose parent is gone sits at the
 * top level; the contents of a group that doesn't show fall into loose. A plain chat is one on
 * no board.
 */
export function buildTree(
  s: { groups: Group[]; boards: Record<string, Board>; chats: Record<string, ChatView> },
  showArchived: boolean,
  o: { server?: string; gone?: Record<string, true> } = {},
): Tree {
  const server = o.server ?? LOCAL_SERVER;
  const here = (x: { id: string }) => serverOfKey(x.id) === server && !o.gone?.[x.id];
  const groups = s.groups.filter((g) => chain(s.groups, g.id).every((x) => shown(x, showArchived)));
  const known = new Set(groups.map((g) => g.id));
  const parentOf = (g: Group) => (g.parent && known.has(g.parent) ? g.parent : "");
  const boards = Object.values(s.boards).filter((b) => here(b) && shown(b, showArchived)).sort(byName);
  const chats = Object.values(s.chats).filter((c) => here(c) && !c.board && shown(c, showArchived)).sort(newestFirst);
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

/** Whether a server has anything a tree of it could show, archived or not: a group, a board or a plain chat.
 *  A tree that is empty of a server that holds something shows nothing because all of it is archived. */
export function holdsAny(
  s: { groups: Group[]; boards: Record<string, Board>; chats: Record<string, ChatView> },
  o: { server?: string; gone?: Record<string, true> } = {},
): boolean {
  const server = o.server ?? LOCAL_SERVER;
  const here = (x: { id: string }) => serverOfKey(x.id) === server && !o.gone?.[x.id];
  return s.groups.length > 0 || Object.values(s.boards).some(here)
    || Object.values(s.chats).some((c) => here(c) && !c.board);
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

/** The names from the top-level group down to the group; empty for ungrouped or an unknown group. groups: the
 *  groups of the group's own server. */
export function groupPath(groups: Group[], id: string): string[] {
  return isUngrouped(id) ? [] : chain(groups, id).map((g) => g.name).reverse();
}

/** Whether a tree holds nothing that shows. */
export const treeEmpty = (t: Tree): boolean => !t.groups.length && !t.loose.boards.length && !t.loose.chats.length;

/** What a tree holds: its boards and plain chats, in the groups and outside them. */
export const treeCount = (t: Tree): number => {
  const all = t.groups.map(contents);
  return t.loose.boards.length + t.loose.chats.length + all.reduce((n, x) => n + x.boards.length + x.chats.length, 0);
};

/** A board's own chats, newest first. */
export function boardChats(chats: Record<string, ChatView>, board: string, showArchived: boolean): ChatView[] {
  return Object.values(chats).filter((c) => c.board === board && shown(c, showArchived)).sort(newestFirst);
}
