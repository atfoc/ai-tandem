// What the phone's Home and a group's screen list (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §2, §3): the
// three lists of a place (groups, boards, chats) as rows with their sub-lines, dots and counts, the place line under a large title, the
// server entries Home chooses from, and where a thing sits (the seam of the browser checks). No React and no react-native here, so Node
// loads it (test/home.test.ts); the screens (HomeRow.tsx, HomeList.tsx) only draw what it says.
import { isUngrouped, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import { listsOf, type ListsState } from "@aiwb/core/logic/serverlists.ts";
import { sidebarEntries } from "@aiwb/core/logic/sections.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { chatWord, needsYou, type WordTone } from "@aiwb/core/logic/statewords.ts";
import { boardChats, buildTree, contents, type GroupTree } from "@aiwb/core/logic/tree.ts";
import { groupsOn, type State } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER, type AgentKind, type Board, type Catalog, type ChatView, type Group } from "@aiwb/core/types.ts";

import { subline } from "../sidebar/subline.ts";

/** What of the store a place's lists are made from: the groups of the server, the store's boards and chats (of every server; the tree takes
 *  the server's own), the things that are no longer on their server, and the catalogs of the server (the models' names). Plain data, so
 *  Home keeps a copy of it per server (lastsync.ts) and a test builds it by hand. */
export type PlaceInput = {
  groups: Group[];
  boards: Record<string, Board>;
  chats: Record<string, ChatView>;
  gone?: Record<string, true>;
  catalogs?: Partial<Record<AgentKind, Catalog | null>>;
  /** A chat's name when it has none of its own (the sidebar names it by its first message); the chat's `chatTitle` by default. */
  titleOf?: (c: ChatView) => string;
};

/** The input of one server, from the store (this computer's own fields, or the section's). */
export function placeInput(s: Pick<State, "groups" | "sections" | "boards" | "chats" | "gone"> & ListsState, server: string): PlaceInput {
  return { groups: groupsOn(s, server), boards: s.boards, chats: s.chats, gone: s.gone, catalogs: listsOf(s, server)?.catalogs };
}

export type RowKind = "group" | "board" | "chat";
export type RowAttention = { kind: "none" } | { kind: "dot" } | { kind: "count"; n: number };

/** One row of Home or a group screen. `key` is the thing's key (logic/keys.ts), `server` its entry id. */
export type RowItem = {
  kind: RowKind;
  key: string;
  server: string;
  name: string;
  sub: string;
  /** The tone of a chat's state word; absent for a settings line (muted). */
  subTone?: WordTone;
  attention: RowAttention;
  /** A chat's agent, for its glyph. */
  agent?: string;
};

export type PlaceLists = { groups: RowItem[]; boards: RowItem[]; chats: RowItem[] };

export type Counts = { boards: number; groups: number; chats: number };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The non-zero parts of a count, in the order given: "4 boards · 2 groups · 3 chats". "" when nothing is in it. */
export function countsText(c: Counts, order: readonly (keyof Counts)[] = ["boards", "groups", "chats"]): string {
  const word = { boards: "board", groups: "group", chats: "chat" } as const;
  return order.filter((k) => c[k] > 0).map((k) => plural(c[k], word[k])).join(" · ");
}

/** A group row's sub-line: what is directly in it (boards · groups · chats), "Empty" when nothing is. */
export const groupSub = (c: Counts): string => countsText(c) || "Empty";

/** The sub-line of a board row: "Whiteboard · 2 chats", "Whiteboard · 1 chat", "Whiteboard · no chats yet" (no edited time: D5). */
export const boardSub = (chats: number): string => `Whiteboard · ${chats === 0 ? "no chats yet" : plural(chats, "chat")}`;

/** The line under a group screen's large title: the full place, server first, then what is directly in the group, "Empty" left out:
 *  "Studio Mac › Checkout service · 1 group · 2 boards · 1 chat". Groups come before boards here, as the mockup (10b, 10c) has them. */
export function placeLine(serverName: string, ancestorNames: readonly string[], counts: Counts): string {
  const place = [serverName, ...ancestorNames].join(" › "), tail = countsText(counts, ["groups", "boards", "chats"]);
  return tail ? `${place} · ${tail}` : place;
}

/** The counts of what is directly in a group node (its plain chats; a board's chats are the board's). */
export const countsOf = (n: GroupTree): Counts => ({ boards: n.boards.length, groups: n.children.length, chats: n.chats.length });

/** The rows of a place: `group` null is the server's top level (its top groups, loose boards, loose chats), else that group's. Archived things
 *  are not listed (Settings › Archived's); sorted as `buildTree`. Empty lists for a group the tree does not have. */
export function placeLists(input: PlaceInput, server: string, group: string | null): PlaceLists {
  const tree = buildTree(input, false, { server, gone: input.gone });
  const node = group === null ? null : findNode(tree.groups, group);
  if (group !== null && !node) return { groups: [], boards: [], chats: [] };
  const groups = node ? node.children : tree.groups, boards = node ? node.boards : tree.loose.boards, chats = node ? node.chats : tree.loose.chats;
  const attention = (n: number): RowAttention => (n > 0 ? { kind: "count", n } : { kind: "none" });
  const titleOf = input.titleOf ?? ((c: ChatView) => chatTitle(c));
  return {
    groups: groups.map((g): RowItem => {
      const inside = contents(g);
      const asking = inside.chats.concat(inside.boards.flatMap((b) => boardChats(input.chats, b.id, false))).filter(needsYou).length;
      return { kind: "group", key: g.group.id, server, name: g.group.name, sub: groupSub(countsOf(g)), attention: attention(asking) };
    }),
    boards: boards.map((b): RowItem => {
      const own = boardChats(input.chats, b.id, false);
      return { kind: "board", key: b.id, server, name: b.name, sub: boardSub(own.length), attention: own.some(needsYou) ? { kind: "dot" } : { kind: "none" } };
    }),
    chats: chats.map((c): RowItem => {
      const w = chatWord(c);
      const sub = w ? { sub: w.text, subTone: w.tone } : { sub: subline(c, c.agent ? input.catalogs?.[c.agent] ?? undefined : undefined) };
      return { kind: "chat", key: c.id, server, name: titleOf(c), ...sub, attention: needsYou(c) ? { kind: "dot" } : { kind: "none" }, agent: c.agent };
    }),
  };
}

/** A group's node of the server's tree and the names of the groups above it (outermost first), for a group screen's title and place line;
 *  none for a group the tree does not have. Archived things are not in it, as in `placeLists`. */
export function groupNode(input: PlaceInput, server: string, key: string): { node: GroupTree; ancestors: string[] } | undefined {
  const walk = (nodes: GroupTree[], above: string[]): { node: GroupTree; ancestors: string[] } | undefined => {
    for (const n of nodes) {
      if (n.group.id === key) return { node: n, ancestors: above };
      const inner = walk(n.children, [...above, n.group.name]);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(buildTree(input, false, { server, gone: input.gone }).groups, []);
}

function findNode(nodes: GroupTree[], id: string): GroupTree | undefined {
  for (const n of nodes) {
    if (n.group.id === id) return n;
    const inner = findNode(n.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/** The servers Home chooses from: the sidebar's entries, without this computer where the app has none of its own (`hasLocal`, platform/thiscomputer.ts). */
export const homeEntries = (servers: readonly ServerView[], hasLocal: boolean): ServerView[] =>
  sidebarEntries(servers).filter((v) => hasLocal || (!v.local && v.id !== LOCAL_SERVER));

/** The server Home shows: the saved one when it is an entry, else the first entry, else none (the first run). */
export const chosenServer = (entries: readonly { id: string }[], placeServer: string | null): string | null =>
  entries.find((v) => v.id === placeServer)?.id ?? entries[0]?.id ?? null;

/** Where a thing sits: its server, the keys of the groups it is in (outermost first; for a group, itself last), and the board a chat is
 *  on (null for anything else). */
export type Path = { server: string; groups: string[]; board: string | null };

/** The keys from the top-level group down to `id`; empty for ungrouped, for none, and for a group the server does not have. Stops at a cycle. */
function chainKeys(groups: readonly Group[], id: string | undefined): string[] {
  if (!id || isUngrouped(id)) return [];
  const out: string[] = [];
  for (let g = groups.find((x) => x.id === id); g && !out.includes(g.id); g = g.parent ? groups.find((x) => x.id === g!.parent) : undefined) out.unshift(g.id);
  return out;
}

export function pathOf(s: Pick<State, "groups" | "sections" | "boards" | "chats">, kind: RowKind, key: string): Path {
  const server = serverOfKey(key), groups = groupsOn(s, server);
  if (kind === "group") return { server, groups: chainKeys(groups, key), board: null };
  if (kind === "board") return { server, groups: chainKeys(groups, s.boards[key]?.group), board: null };
  const c = s.chats[key];
  if (c?.board) return { server, groups: chainKeys(groups, s.boards[c.board]?.group), board: c.board };
  return { server, groups: chainKeys(groups, c?.group), board: null };
}
