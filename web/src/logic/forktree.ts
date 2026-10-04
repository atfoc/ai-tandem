// A chat as a tree of entries, built from the tree the server sends (GET /api/chats/{id}/tree).
// An entry is a message of yours or a reply; every entry points at its parent. A branch's own
// entries hang one from the other, and the first of them from the branch it split from. The leaf
// is where the chat is, and the thread on screen is the path from the root to it. The server owns
// the tree: this is the read side only. DOM-free.

import { MAIN, type AgentKind, type Target, type TreeBranchView, type TreeItem, type TreeView } from "../types.ts";
import { toTreeItems, type Items } from "./forkpoints.ts";

export type Entry = {
  id: string;
  branch: string;        // the branch that owns the item
  item: TreeItem;        // a message or a reply
  parent: string | null; // null: a root
  label?: string;        // a bookmark the user put on the entry
  end?: true;            // a branch ends here, though another goes on from it (branched off at its end)
};

export type ChatTree = {
  view: TreeView;
  entries: Record<string, Entry>;
  order: string[];       // main's entries, then each branch's; children are listed in this order
  leaf: string | null;   // where the chat is; null at the start, before any message
};

export const entryId = (branch: string, i: number) => `${branch}:${i}`;

// ---- branches

const NO_MAIN: TreeBranchView = { id: MAIN, at: 0, len: 0, items: [] };

/** A branch of the view. One the view does not have is read as main. */
function branchOf(view: TreeView, id: string): TreeBranchView {
  return view.branches.find((b) => b.id === id) ?? view.branches.find((b) => b.id === MAIN) ?? NO_MAIN;
}

/** A branch and the branches it came from, up to main, each with the item count below which the
 *  starting branch's items are that branch's (no limit for the starting branch itself). */
function chain(view: TreeView, id: string): { b: TreeBranchView; upTo: number }[] {
  let b = branchOf(view, id);
  const out = [{ b, upTo: Infinity }];
  const seen = new Set([b.id]);
  let upTo = Infinity;
  while (b.id !== MAIN) {
    upTo = Math.min(upTo, b.at);
    b = branchOf(view, b.from ?? MAIN);
    if (seen.has(b.id)) break; // a record that loops: stop there
    seen.add(b.id);
    out.push({ b, upTo });
  }
  return out;
}

/** The last entry on a branch's path with an index below count; null when there is none. */
function lastBelow(view: TreeView, branch: string, count: number): string | null {
  for (const { b, upTo } of chain(view, branch)) {
    const n = Math.min(count, upTo);
    for (let k = b.items.length - 1; k >= 0; k--) if (b.items[k].i < n) return entryId(b.id, b.items[k].i);
  }
  return null;
}

/** The branch that owns index i of a branch's thread: the one whose own part holds it. */
export function ownerOf(view: TreeView, branch: string, i: number): string {
  for (const { b } of chain(view, branch)) if (b.id === MAIN || i >= b.at) return b.id;
  return MAIN;
}

/** How many leading items two branches share. */
export function sharedCount(view: TreeView, a: string, b: string): number {
  const ca = chain(view, a), cb = chain(view, b);
  if (ca[0].b.id === cb[0].b.id) return ca[0].b.len;
  ca[0].upTo = ca[0].b.len;
  cb[0].upTo = cb[0].b.len;
  let n = 0;
  for (const x of ca) for (const y of cb) if (x.b.id === y.b.id) n = Math.max(n, Math.min(x.upTo, y.upTo));
  return n;
}

/** The label on index i of a branch's thread. */
export function labelAt(view: TreeView | undefined, branch: string, i: number): string | undefined {
  if (!view) return undefined;
  const owner = ownerOf(view, branch, i);
  return view.labels.find((l) => l.branch === owner && l.item === i)?.text || undefined;
}

/** view with one branch's own part rebuilt from its live items (the shown branch). */
export function withLive(view: TreeView, branch: string, agent: AgentKind, items: Items): TreeView {
  if (!view.branches.some((b) => b.id === branch)) return view;
  return {
    ...view,
    branches: view.branches.map((b) => (b.id === branch ? { ...b, items: toTreeItems(agent, items, b.at), len: items.length } : b)),
  };
}

// ---- the tree

/** The tree. leaf is where the chat is: the end of view.current, or, with at (a pending move),
 *  the last entry of at.branch before at.count. */
export function buildTree(view: TreeView, at?: { branch: string; count: number }): ChatTree {
  const entries: Record<string, Entry> = {};
  const order: string[] = [];
  const isMain = (b: TreeBranchView) => b.id === MAIN;
  for (const b of [...view.branches.filter(isMain), ...view.branches.filter((x) => !isMain(x))]) {
    let parent = isMain(b) ? null : lastBelow(view, b.from ?? MAIN, b.at);
    for (const item of b.items) {
      const id = entryId(b.id, item.i);
      if (entries[id]) continue;
      entries[id] = { id, branch: b.id, item, parent };
      order.push(id);
      parent = id;
    }
  }
  for (const l of view.labels) {
    const e = entries[entryId(l.branch, l.item)];
    if (e && l.text) e.label = l.text;
  }
  const leaf = at ? lastBelow(view, at.branch, at.count) : lastBelow(view, view.current, Infinity);
  const t: ChatTree = { view, entries, order, leaf };
  for (const b of view.branches) {
    const tip = tipOf(t, b.id);
    if (tip && under(t, tip).some((c) => entries[c].branch !== b.id)) entries[tip].end = true;
  }
  return t;
}

// Every entry's children (the roots under null), kept per tree: a tree is not changed once built.
const kids = new WeakMap<ChatTree, Map<string | null, string[]>>();

function under(t: ChatTree, id: string | null): string[] {
  let m = kids.get(t);
  if (!m) {
    m = new Map();
    for (const x of t.order) {
      const p = t.entries[x].parent;
      const list = m.get(p);
      if (list) list.push(x);
      else m.set(p, [x]);
    }
    kids.set(t, m);
  }
  return m.get(id) ?? [];
}

/** The children of an entry (or the roots, for null): the way the entry's branch goes on first. */
export function childrenOf(t: ChatTree, id: string | null): string[] {
  return [...under(t, id)];
}

/** The ids from the root down to id, id included. */
export function pathTo(t: ChatTree, id: string | null): string[] {
  const out: string[] = [];
  for (let e = id ? t.entries[id] : undefined; e; e = e.parent ? t.entries[e.parent] : undefined) out.push(e.id);
  return out.reverse();
}

/** The ends of all branches: entries without children, and those a branch still ends at. */
export const tips = (t: ChatTree): string[] => t.order.filter((id) => t.entries[id].end || !under(t, id).length);

/** The branches at the point an entry starts one: its siblings (itself included), after the entry
 *  before them when a branch ends there too; [] when the entry is the only way on. */
export function siblingsOf(t: ChatTree, id: string): string[] {
  const p = t.entries[id]?.parent ?? null;
  const all = p && t.entries[p].end ? [p, ...under(t, p)] : under(t, p);
  return all.length > 1 ? [...all] : [];
}

/** The last entry on a branch's path; null when it has none. */
export function tipOf(t: ChatTree, branch: string): string | null {
  return lastBelow(t.view, branch, Infinity);
}

/** The branch that ends at an entry, if one does. */
export function tipBranch(t: ChatTree, id: string): string | null {
  const e = t.entries[id];
  if (!e) return null;
  if (tipOf(t, e.branch) === id) return e.branch;
  return t.view.branches.find((b) => tipOf(t, b.id) === id)?.id ?? null;
}

/** "Branch n of m" for the message at index i of a branch's thread; null where the thread passes no split. */
export function markerAt(t: ChatTree, branch: string, i: number): { n: number; m: number } | null {
  const id = entryId(ownerOf(t.view, branch, i), i);
  const sibs = siblingsOf(t, id);
  return sibs.length > 0 && t.entries[id] ? { n: sibs.indexOf(id) + 1, m: sibs.length } : null;
}

// ---- names

const oneLine = (s: string, n: number) => {
  const t = s.replace(/<[^>]+>/g, "").replace(/[#*`>_|]/g, " ").replace(/-{3,}/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** A message in one line, for the tree and for the banner. */
export function preview(text: string, n = 60): string {
  return oneLine(text, n) || "(empty)";
}

/**
 * A branch's name, by the entry it ends at: the nearest label on the way to it since the last
 * split (a label above that is shared with other branches), else your first message after that
 * split, else "main" (a chat that never split has one branch).
 */
export function branchName(t: ChatTree, end: string | null): string {
  const path = pathTo(t, end);
  let start = -1;
  for (let i = path.length - 1; i >= 0; i--) if (siblingsOf(t, path[i]).length) { start = i; break; }
  for (let i = path.length - 1; i >= Math.max(start, 0); i--) if (t.entries[path[i]].label) return t.entries[path[i]].label!;
  if (start < 0) return MAIN;
  const first = path.slice(start).map((id) => t.entries[id]).find((e) => e.item.kind === "user") ?? t.entries[path[start]];
  return preview(first.item.text, 40);
}

export const nameOfBranch = (t: ChatTree, branch: string) => branchName(t, tipOf(t, branch));

// ---- the tree view (the popup)

export type Filter = "default" | "labeled";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "default", label: "Messages" },
  { id: "labeled", label: "Labeled" },
];

export type Row = {
  id: string;
  gutter: string;      // the tree lines in front of the row: "│  ├─ "
  onPath: boolean;     // on the way to the leaf
  isLeaf: boolean;     // where the chat is now
  isTip: boolean;      // the end of a branch
  fork: number;        // branches that start right under this row (0: none)
};

function shows(e: Entry, filter: Filter, query: string): boolean {
  if (filter === "labeled" && !e.label) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return e.item.text.toLowerCase().includes(q) || (e.label ?? "").toLowerCase().includes(q);
}

/**
 * The tree as rows. Entries the filter hides are skipped: their children hang from the nearest
 * entry shown above them. A run without splits stays at one depth; where it splits, each branch is
 * drawn under a ├─ or └─.
 */
export function rows(t: ChatTree, opts: { filter: Filter; query?: string }): Row[] {
  const query = (opts.query ?? "").trim();
  // the nearest entries shown under id
  const shown = (id: string | null): string[] => {
    const out: string[] = [];
    const todo = [...under(t, id)].reverse();
    while (todo.length) {
      const k = todo.pop()!;
      if (shows(t.entries[k], opts.filter, query)) out.push(k);
      else todo.push(...[...under(t, k)].reverse());
    }
    return out;
  };
  // split: a branch ends at the row above, so even a single way on is drawn as a branch off it
  type Todo = { id: string; gutter: string; prefix: string };
  const fan = (ids: string[], prefix: string, split: boolean): Todo[] =>
    ids.length === 1 && !split
      ? [{ id: ids[0], gutter: prefix, prefix }]
      : ids.map((id, i) => {
          const last = i === ids.length - 1;
          return { id, gutter: prefix + (last ? "└─ " : "├─ "), prefix: prefix + (last ? "   " : "│  ") };
        });
  const path = new Set(pathTo(t, t.leaf));
  const out: Row[] = [];
  const todo = fan(shown(null), "", false).reverse();
  while (todo.length) {
    const { id, gutter, prefix } = todo.pop()!;
    const e = t.entries[id];
    const next = shown(id);
    const ways = next.length + (e.end ? 1 : 0); // a branch ending here is one of the ways
    out.push({
      id, gutter,
      onPath: path.has(id), isLeaf: t.leaf === id, isTip: !under(t, id).length || !!e.end,
      fork: ways > 1 ? ways : 0,
    });
    todo.push(...fan(next, prefix, !!e.end).reverse());
  }
  return out;
}

/** What a row of the tree popup offers. */
export type RowActions = {
  open: { target: Target; edit?: number } | null;   // double-click; null: nothing moves
  branchEdit: number | null;                        // Branch and edit (your message)
  forkEdit: number | null;                          // Fork and edit
  fork: number | null;                              // Fork to new chat
  midTurn: boolean;                                 // a reply partway through a turn
};

/** The actions of an entry. A number is the point count the action uses. While the agent is
 *  replying (busy) and in an archived or legacy chat (readOnly) nothing moves. Double-click on the
 *  end of a branch goes there, to carry the branch on, whatever the entry is. */
export function rowActions(t: ChatTree, id: string, p: { busy: boolean; readOnly: boolean }): RowActions {
  const out: RowActions = { open: null, branchEdit: null, forkEdit: null, fork: null, midTurn: false };
  const e = t.entries[id];
  if (!e) return out;
  const it = e.item;
  const own = branchOf(t.view, e.branch);
  const last = own.items[own.items.length - 1]?.i === it.i; // the last entry of its branch's own part
  out.midTurn = it.kind === "text" && !it.end && !last;
  if (p.busy || p.readOnly) return out;
  const before = it.kind === "user" && it.before !== undefined && it.ok ? it.before : null;
  const end = it.kind === "text" && it.end && it.ok ? it.end : null;
  if (it.kind === "user") out.branchEdit = out.forkEdit = before;
  else out.fork = end ?? (last && it.done ? own.len : null);
  const tip = tipBranch(t, id);
  if (tip !== null) out.open = { target: { branch: tip, at: branchOf(t.view, tip).len, new: false } };
  else if (before !== null) out.open = { target: { branch: e.branch, at: before, new: true }, edit: it.i };
  else if (end !== null) out.open = { target: { branch: e.branch, at: end, new: false } };
  return out;
}
