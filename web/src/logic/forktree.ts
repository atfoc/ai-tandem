// PROTOTYPE ONLY (branch fork-chat-feature): a chat kept as a tree of entries, the way pi keeps a
// session. Every entry points at its parent; the leaf is where the chat is now, and the thread on
// screen is the path from the root to it. Going back to an earlier entry and sending from there
// starts another branch; nothing on the branch you left is lost. DOM-free.
//
// Each branch runs in its own agent session. A session carries on while you add to the end of it;
// sending from an entry that already has children forks the entry's session at that entry
// (Claude: resume the session at that message with fork-session), and the new branch runs there.

import type { Item } from "../types.ts";

export type Entry = {
  id: string;
  parent: string | null; // null: a root
  item: Item;            // a message, a reply, a tool call, or (with summary) a branch summary
  summary?: { left: number; from: string }; // a summary of the branch left: how many entries, and its end
  label?: string;        // a bookmark the user put on the entry
  session: string;       // the agent session the entry belongs to
  at: number;            // made at, unix ms
};

/** An agent session. from: the session and entry it was forked at; chat is set when that was another chat. */
export type Session = { id: string; from?: { session: string; at: string; chat?: string } };

export type ChatTree = {
  entries: Record<string, Entry>;
  order: string[];       // ids in the order they were made; children are listed in this order
  leaf: string | null;   // where the chat is now; null before the first message
  sessions: Record<string, Session>;
};

export const emptyTree = (): ChatTree => ({ entries: {}, order: [], leaf: null, sessions: {} });

/** The children of an entry (or the roots, for null), oldest first. */
export function childrenOf(t: ChatTree, id: string | null): string[] {
  return t.order.filter((x) => t.entries[x].parent === id);
}

/** The ids from the root down to id, id included. */
export function pathTo(t: ChatTree, id: string | null): string[] {
  const out: string[] = [];
  for (let e = id ? t.entries[id] : undefined; e; e = e.parent ? t.entries[e.parent] : undefined) out.push(e.id);
  return out.reverse();
}

/** The thread on screen: the entries from the root to the leaf. */
export const thread = (t: ChatTree): Entry[] => pathTo(t, t.leaf).map((id) => t.entries[id]);

/** The ends of all branches: entries without children. */
export const tips = (t: ChatTree): string[] => t.order.filter((id) => !t.order.some((x) => t.entries[x].parent === id));

/** How many branches the chat has (1 while it has never forked, 0 while it is empty). */
export const branchCount = (t: ChatTree) => tips(t).length;

/** Whether the next message starts a new branch: the leaf already has children. */
export const atFork = (t: ChatTree) => childrenOf(t, t.leaf).length > 0;

/** The branch point an entry starts a branch at: its siblings (itself included), when it has any. */
export function siblingsOf(t: ChatTree, id: string): string[] {
  const kids = childrenOf(t, t.entries[id]?.parent ?? null);
  return kids.length > 1 ? kids : [];
}

const newId = (t: ChatTree, prefix: string, n: number) => {
  let i = n + 1;
  while (t.entries[prefix + i] || t.sessions[prefix + i]) i++;
  return prefix + i;
};

/**
 * Adds an entry after the leaf and moves the leaf to it. It carries on the parent's session,
 * unless the parent already has children: then the parent's session is forked at the parent and
 * the entry starts the new session. Returns the tree and the new entry's id.
 */
export function append(t: ChatTree, item: Item, extra: Partial<Pick<Entry, "summary" | "label">> = {}, now = Date.now()): [ChatTree, string] {
  const parent = t.leaf ? t.entries[t.leaf] : null;
  const id = newId(t, "e", t.order.length);
  const sessions = { ...t.sessions };
  let session: string;
  const forking = childrenOf(t, t.leaf).length > 0;
  if (parent && !forking) session = parent.session;
  else {
    session = newId(t, "s", Object.keys(t.sessions).length);
    sessions[session] = parent ? { id: session, from: { session: parent.session, at: parent.id } } : { id: session };
  }
  const e: Entry = { id, parent: parent?.id ?? null, item, session, at: now, ...extra };
  return [{ entries: { ...t.entries, [id]: e }, order: [...t.order, id], leaf: id, sessions }, id];
}

/** Replaces an entry's item (a reply as it streams in, a tool call when it ends). */
export function updateItem(t: ChatTree, id: string, item: Item): ChatTree {
  const e = t.entries[id];
  return e ? { ...t, entries: { ...t.entries, [id]: { ...e, item } } } : t;
}

/**
 * Moves to an entry, as picking it in the tree does. A message of yours is taken back: the leaf
 * goes to the entry before it and its text comes back for the composer, to edit and send as a new
 * branch. Anything else becomes the leaf, with an empty composer.
 */
export function moveTo(t: ChatTree, id: string): { tree: ChatTree; draft?: string } {
  const e = t.entries[id];
  if (!e) return { tree: t };
  if (e.item.kind === "user") return { tree: { ...t, leaf: e.parent }, draft: e.item.text ?? "" };
  return { tree: { ...t, leaf: id } };
}

/** Where moveTo(id) puts the leaf. */
export const landing = (t: ChatTree, id: string): string | null =>
  t.entries[id]?.item.kind === "user" ? t.entries[id].parent : id;

/** The entries of the branch being left when the leaf goes from `from` to `to`: those on the way to
 *  `from` that are not on the way to `to`. */
export function leaving(t: ChatTree, from: string | null, to: string | null): string[] {
  const keep = new Set(pathTo(t, to));
  return pathTo(t, from).filter((id) => !keep.has(id));
}

export function setLabel(t: ChatTree, id: string, label: string): ChatTree {
  const e = t.entries[id];
  if (!e) return t;
  const { label: _, ...rest } = e;
  return { ...t, entries: { ...t.entries, [id]: label.trim() ? { ...rest, label: label.trim() } : rest } };
}

/**
 * A new chat holding the way to an entry, for "fork to a new chat" (pi's /fork). Like moveTo, a
 * message of yours is left out and comes back as the draft. The copy runs in one new session,
 * forked from the source's session at the last entry copied.
 */
export function forkOut(t: ChatTree, id: string, chat: string): { tree: ChatTree; draft?: string } {
  const to = landing(t, id);
  const ids = pathTo(t, to);
  const last = to ? t.entries[to] : undefined;
  const session: Session = { id: "s1", ...(last ? { from: { session: last.session, at: last.id, chat } } : {}) };
  const entries = Object.fromEntries(ids.map((x) => [x, { ...t.entries[x], session: "s1" }]));
  const draft = t.entries[id]?.item.kind === "user" ? t.entries[id].item.text ?? "" : undefined;
  return { tree: { entries, order: ids, leaf: to, sessions: { s1: session } }, draft };
}

/** Removes an entry that has no children (a summary made for a move that was then undone). */
export function dropTip(t: ChatTree, id: string): ChatTree {
  if (!t.entries[id] || childrenOf(t, id).length) return t;
  const { [id]: _, ...entries } = t.entries;
  return { ...t, entries, order: t.order.filter((x) => x !== id), leaf: t.leaf === id ? t.entries[id].parent : t.leaf };
}

// ---- names

const oneLine = (s: string, n = 60) => {
  const t = s.replace(/<[^>]+>/g, "").replace(/[#*`>_|]/g, " ").replace(/-{3,}/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** An entry in one line, for the tree and for crumbs. */
export function preview(e: Entry, n = 60): string {
  const it = e.item;
  if (e.summary) return `Summary of a branch left (${e.summary.left} entries)`;
  if (it.kind === "tool") return `${it.name ?? "tool"} ${oneLine(JSON.stringify(it.input ?? {}), n)}`;
  return oneLine(it.text ?? "", n) || "(empty)";
}

/**
 * A branch's name, by the entry it ends at: the nearest label on the way to it, else your first
 * message after the last fork on the way, else "main" (a chat that never forked has one branch).
 */
export function branchName(t: ChatTree, end: string | null): string {
  const path = pathTo(t, end);
  for (let i = path.length - 1; i >= 0; i--) if (t.entries[path[i]].label) return t.entries[path[i]].label!;
  let start = -1;
  for (let i = path.length - 1; i >= 0; i--) if (siblingsOf(t, path[i]).length) { start = i; break; }
  if (start < 0) return "main";
  const first = path.slice(start).map((id) => t.entries[id]).find((e) => e.item.kind === "user") ?? t.entries[path[start]];
  return preview(first, 40);
}

// ---- the tree view (the navigator)

export type Filter = "default" | "user" | "labeled" | "all";
export const FILTERS: { id: Filter; label: string }[] = [
  { id: "default", label: "Messages" },
  { id: "user", label: "Yours" },
  { id: "labeled", label: "Labeled" },
  { id: "all", label: "All" },
];

export type Row = {
  id: string;
  gutter: string;      // the tree lines in front of the row: "│  ├─ "
  onPath: boolean;     // on the way to the leaf
  isLeaf: boolean;     // where the chat is now
  isTip: boolean;      // the end of a branch
  fork: number;        // branches that start right under this row (0: none)
  folded: number;      // entries hidden under this folded row (0: not folded)
  parentRow?: string;  // the row above it in the tree, for ← (entries the filter hides are skipped)
};

function shows(e: Entry, filter: Filter, query: string): boolean {
  const kind = e.summary ? "summary" : e.item.kind;
  const byFilter = filter === "all" ? true
    : filter === "user" ? kind === "user"
    : filter === "labeled" ? !!e.label
    : kind === "user" || kind === "text" || kind === "summary";
  if (!byFilter) return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return (e.item.text ?? "").toLowerCase().includes(q) || (e.label ?? "").toLowerCase().includes(q) || preview(e, 400).toLowerCase().includes(q);
}

/**
 * The tree as rows. Entries the filter hides are skipped: their children hang from the nearest
 * entry shown above them. A run without forks stays at one depth; where it forks, each branch is
 * drawn under a ├─ or └─, and folding an entry hides everything under it.
 */
export function rows(t: ChatTree, opts: { filter: Filter; query?: string; folded?: Set<string> }): Row[] {
  const query = (opts.query ?? "").trim();
  const folded = opts.folded ?? new Set<string>();
  const kids = new Map<string | null, string[]>();
  for (const id of t.order) {
    const p = t.entries[id].parent;
    kids.set(p, [...(kids.get(p) ?? []), id]);
  }
  // the nearest entries shown under id
  const shown = (id: string | null): string[] =>
    (kids.get(id) ?? []).flatMap((k) => (shows(t.entries[k], opts.filter, query) ? [k] : shown(k)));
  const count = (id: string): number => (kids.get(id) ?? []).reduce((n, k) => n + 1 + count(k), 0);
  const path = new Set(pathTo(t, t.leaf));
  const out: Row[] = [];
  const emit = (id: string, gutter: string, parentRow: string | undefined) => {
    const under = shown(id);
    const isFolded = folded.has(id) && under.length > 0;
    out.push({
      id, gutter, parentRow,
      onPath: path.has(id), isLeaf: t.leaf === id, isTip: !(kids.get(id) ?? []).length,
      fork: under.length > 1 ? under.length : 0,
      folded: isFolded ? count(id) : 0,
    });
    return isFolded ? [] : under;
  };
  const walk = (ids: string[], prefix: string, parentRow: string | undefined) => {
    if (ids.length === 1) {
      walk(emit(ids[0], prefix, parentRow), prefix, ids[0]);
      return;
    }
    ids.forEach((id, i) => {
      const last = i === ids.length - 1;
      walk(emit(id, prefix + (last ? "└─ " : "├─ "), parentRow), prefix + (last ? "   " : "│  "), id);
    });
  };
  walk(shown(null), "", undefined);
  return out;
}

/** "session s3, forked from s1 at e7", for the navigator's details. */
export function sessionText(t: ChatTree, id: string): string {
  const s = t.sessions[t.entries[id]?.session];
  if (!s) return "";
  if (!s.from) return `agent session ${s.id}`;
  return `agent session ${s.id}, forked from ${s.from.chat ? "the source chat's " : ""}${s.from.session} after ${s.from.at}`;
}
