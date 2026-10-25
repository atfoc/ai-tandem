// What Home's search finds and lists (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §6): matching a query in the names of
// one server's boards, chats and groups, the sections with their sub-lines, the bold part of a name, and the recently opened list. No React and no
// react-native here, so Node loads it (test/h2-search.test.ts); Search.tsx only draws what it says.
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import { buildTree, type GroupTree } from "@aiwb/core/logic/tree.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { countsOf, type PlaceInput, type RowKind } from "./model.ts";

export type Scope = "all" | "boards" | "chats";
export const SCOPES: readonly { scope: Scope; label: string }[] = [{ scope: "all", label: "All" }, { scope: "boards", label: "Boards" }, { scope: "chats", label: "Chats" }];

/** A name cut at the first match of the query: `match` is "" when the name does not hold it (a recently opened row). */
export type NameParts = { before: string; match: string; after: string };

export type Hit = {
  kind: RowKind;
  key: string;
  server: string;
  name: string;
  parts: NameParts;
  /** "Studio Mac › Checkout service", "Studio Mac › on Checkout flow", "Studio Mac · 8 items", or "● Attic · Offline" for a faded hit. */
  sub: string;
  agent?: string;
  /** The keys of the groups from the outermost down to the thing's own place; for a group, itself last (what `setHomePlace` takes). */
  groups: string[];
  /** The board a chat is on. */
  board: string | null;
  stale: boolean;
};

export type Results = { boards: Hit[]; chats: Hit[]; groups: Hit[] };

export const resultCount = (r: Results): number => r.boards.length + r.chats.length + r.groups.length;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The name cut at the first match of `q` (case-insensitive substring); `match` is "" when it holds none or `q` is empty. */
export function splitName(name: string, q: string): NameParts {
  const word = q.trim(), m = word ? new RegExp(escapeRe(word), "i").exec(name) : null;
  return m ? { before: name.slice(0, m.index), match: m[0], after: name.slice(m.index + m[0].length) } : { before: name, match: "", after: "" };
}

/** What a faded hit says instead of its place: "● Attic · Offline". */
export const staleSub = (serverName: string, word: string): string => `● ${serverName} · ${word}`;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

type Placed = { groups: string[]; names: string[] };
type Index = {
  groups: { node: GroupTree; at: Placed }[];
  boards: { id: string; name: string; at: Placed }[];
  /** Plain chats and the chats on boards; `board` is the board's name for the latter. */
  chats: { chat: ChatView; at: Placed; board?: string }[];
};

const NOWHERE: Placed = { groups: [], names: [] };

/** Every group, board and chat the server's tree shows (archived ones, and what is no longer on the server, are left out, as Home does). */
function indexOf(input: PlaceInput, server: string): Index {
  const tree = buildTree(input, false, { server, gone: input.gone });
  const out: Index = { groups: [], boards: [], chats: [] };
  const names = new Map<string, { name: string; at: Placed }>();
  const board = (b: { id: string; name: string }, at: Placed) => { out.boards.push({ id: b.id, name: b.name, at }); names.set(b.id, { name: b.name, at }); };
  const walk = (nodes: GroupTree[], above: Placed) => {
    for (const n of nodes) {
      out.groups.push({ node: n, at: above });
      const at = { groups: [...above.groups, n.group.id], names: [...above.names, n.group.name] };
      n.boards.forEach((b) => board(b, at));
      n.chats.forEach((c) => out.chats.push({ chat: c, at }));
      walk(n.children, at);
    }
  };
  tree.loose.boards.forEach((b) => board(b, NOWHERE));
  tree.loose.chats.forEach((c) => out.chats.push({ chat: c, at: NOWHERE }));
  walk(tree.groups, NOWHERE);
  for (const c of Object.values(input.chats)) {
    const b = c.board ? names.get(c.board) : undefined;
    if (b && !c.archived && !input.gone?.[c.id]) out.chats.push({ chat: c, at: b.at, board: b.name });
  }
  out.chats.sort((a, b) => newestFirst(a.chat, b.chat));
  return out;
}

const newestFirst = (a: ChatView, b: ChatView) => (a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export type Where = { server: string; serverName: string; /** The word of a server that is away ("Offline"): its hits are faded. */ staleWord?: string };

const place = (w: Where, names: readonly string[]) => [w.serverName, ...names].join(" › ");

function make(w: Where, kind: RowKind, key: string, name: string, q: string, sub: string, at: Placed, extra: Partial<Hit> = {}): Hit {
  const stale = w.staleWord !== undefined;
  return { kind, key, server: w.server, name, parts: splitName(name, q), sub: stale ? staleSub(w.serverName, w.staleWord!) : sub, groups: at.groups, board: null, stale, ...extra };
}

const titleOf = (input: PlaceInput) => input.titleOf ?? ((c: ChatView) => chatTitle(c));

/** Boards, chats and groups of the server whose name holds `q` (trimmed, case-insensitive); nothing for an empty query. Names that start with
 *  the query come first, then the tree's own order (boards by name, chats newest first, groups as the tree has them). The scope's "boards"
 *  and "chats" leave the other kinds out; "all" has the three. */
export function searchPlace(input: PlaceInput, w: Where, query: string, scope: Scope = "all"): Results {
  const q = query.trim(), none: Results = { boards: [], chats: [], groups: [] };
  if (!q) return none;
  const ix = indexOf(input, w.server), name = titleOf(input), re = new RegExp(escapeRe(q), "i");
  const hits = <T>(xs: T[], nameOf: (x: T) => string, build: (x: T, n: string) => Hit): Hit[] =>
    xs.map((x) => ({ x, n: nameOf(x) })).filter((e) => re.test(e.n)).sort((a, b) => rank(a.n) - rank(b.n)).map((e) => build(e.x, e.n));
  const rank = (n: string) => (n.search(re) === 0 ? 0 : 1);
  return {
    boards: scope === "chats" ? [] : hits(ix.boards, (b) => b.name, (b, n) => make(w, "board", b.id, n, q, place(w, b.at.names), b.at)),
    chats: scope === "boards" ? [] : hits(ix.chats, (c) => name(c.chat), (c, n) => make(w, "chat", c.chat.id, n, q,
      c.board !== undefined ? `${w.serverName} › on ${c.board}` : place(w, c.at.names), c.at, { agent: c.chat.agent, board: c.chat.board ?? null })),
    groups: scope !== "all" ? [] : hits(ix.groups, (g) => g.node.group.name, (g, n) => make(w, "group", g.node.group.id, n, q,
      `${place(w, g.at.names)} · ${itemsText(g.node)}`, { groups: [...g.at.groups, g.node.group.id], names: [] })),
  };
}

const itemsText = (n: GroupTree): string => {
  const c = countsOf(n), total = c.boards + c.groups + c.chats;
  return total === 0 ? "Empty" : plural(total, "item");
};

/** What was opened last (recent.ts, newest first) that this server still has, as hits with their place as sub-line ("Studio Mac › Checkout flow":
 *  a chat on a board names the board); at most `limit`. */
export function recentlyOpened(input: PlaceInput, w: Where, opened: readonly { key: string; kind: "board" | "chat" }[], limit = 5): Hit[] {
  const ix = indexOf(input, w.server), name = titleOf(input), out: Hit[] = [];
  for (const o of opened) {
    if (out.length >= limit) break;
    if (o.kind === "board") {
      const b = ix.boards.find((x) => x.id === o.key);
      if (b) out.push(make(w, "board", b.id, b.name, "", place(w, b.at.names), b.at));
    } else {
      const c = ix.chats.find((x) => x.chat.id === o.key);
      if (c) out.push(make(w, "chat", c.chat.id, name(c.chat), "", place(w, c.board !== undefined ? [c.board] : c.at.names), c.at, { agent: c.chat.agent, board: c.chat.board ?? null }));
    }
  }
  return out;
}
