// The sidebar tree: groups with their boards and plain chats, and the loose
// (ungrouped) area. DOM-free; Sidebar.tsx renders it.

import type { Board, ChatView, Group } from "../types.ts";

export type Tree = {
  loose: { boards: Board[]; chats: ChatView[] };
  groups: { group: Group; boards: Board[]; chats: ChatView[] }[];
};

const shown = (x: { archived?: boolean }, showArchived: boolean) => showArchived || !x.archived;

/** Boards by name (id breaks ties, since names are not unique). */
const byName = (a: Board, b: Board) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Chats newest first. */
const newestFirst = (a: ChatView, b: ChatView) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0);

export function buildTree(
  s: { groups: Group[]; boards: Record<string, Board>; chats: Record<string, ChatView> },
  showArchived: boolean,
): Tree {
  const groups = s.groups.filter((g) => shown(g, showArchived));
  const known = new Set(groups.map((g) => g.id));
  const boards = Object.values(s.boards).filter((b) => shown(b, showArchived)).sort(byName);
  const chats = Object.values(s.chats).filter((c) => !c.board && shown(c, showArchived)).sort(newestFirst);
  const chatGroup = (c: ChatView) => c.group ?? "";
  return {
    loose: {
      boards: boards.filter((b) => !known.has(b.group)),
      chats: chats.filter((c) => !known.has(chatGroup(c))),
    },
    groups: groups.map((group) => ({
      group,
      boards: boards.filter((b) => b.group === group.id),
      chats: chats.filter((c) => chatGroup(c) === group.id),
    })),
  };
}

/** A board's own chats, newest first. */
export function boardChats(chats: Record<string, ChatView>, board: string, showArchived: boolean): ChatView[] {
  return Object.values(chats).filter((c) => c.board === board && shown(c, showArchived)).sort(newestFirst);
}
