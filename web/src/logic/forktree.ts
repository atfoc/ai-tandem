// PROTOTYPE ONLY (branch fork-chat-feature): a chat kept as a tree of entries, the way pi keeps a
// session. Every entry points at its parent; the leaf is where the chat is now, and the thread on
// screen is the path from the root to it. Going back to an earlier entry and sending from there
// starts another branch; nothing on the branch you left is lost. Branches start only between turns:
// at the end of a turn, or, for a message of yours taken back to be edited, at the end of the turn
// before it. DOM-free.
//
// Each branch runs in its own agent session. A session carries on while you add to the end of it;
// sending from an entry that already has children forks the entry's session at that entry
// (Claude: resume the session at that message with fork-session), and the new branch runs there.
// Branching at the end of a branch does the same, and the branch left keeps ending there (end): it
// stays a branch of its own, and going back to it carries on its session.

import type { Item } from "../types.ts";

export type Entry = {
  id: string;
  parent: string | null; // null: a root
  item: Item;            // a message, a reply or a tool call
  label?: string;        // a bookmark the user put on the entry
  end?: true;            // a branch ends here, though another goes on from it (branched off at its end)
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

/** The ends of all branches: entries without children, and those a branch still ends at. */
export const tips = (t: ChatTree): string[] => t.order.filter((id) => t.entries[id].end || !t.order.some((x) => t.entries[x].parent === id));

/** How many branches the chat has (1 while it has never forked, 0 while it is empty). */
export const branchCount = (t: ChatTree) => tips(t).length;

/** Whether the next message starts a new branch: the leaf already has children, and no branch ends there. */
export const atFork = (t: ChatTree) => childrenOf(t, t.leaf).length > 0 && !(t.leaf && t.entries[t.leaf].end);

/** The branches at the point an entry starts one: its siblings (itself included), after the entry
 *  before them when a branch ends there too; [] when the entry is the only way on. */
export function siblingsOf(t: ChatTree, id: string): string[] {
  const p = t.entries[id]?.parent ?? null;
  const kids = childrenOf(t, p);
  const all = p && t.entries[p].end ? [p, ...kids] : kids;
  return all.length > 1 ? all : [];
}

/** A reply or a tool call: part of the agent's turn (not your message). */
const inTurn = (e: Entry) => e.item.kind !== "user";

/** Whether an entry ends a turn: on every branch, what comes after it is your next message or
 *  nothing. */
export function endsTurn(t: ChatTree, id: string): boolean {
  const e = t.entries[id];
  return !!e && e.item.kind !== "user" && !childrenOf(t, id).some((c) => inTurn(t.entries[c]));
}

/** Whether a branch can start at an entry: the end of a turn, or a message of yours (from the end
 *  of the turn before it, with the message back as a draft). */
export const branchable = (t: ChatTree, id: string) => t.entries[id]?.item.kind === "user" || endsTurn(t, id);

const newId = (t: ChatTree, prefix: string, n: number) => {
  let i = n + 1;
  while (t.entries[prefix + i] || t.sessions[prefix + i]) i++;
  return prefix + i;
};

/**
 * Adds an entry after the leaf and moves the leaf to it. It carries on the parent's session when a
 * branch ends at the parent (it has no children, or is marked end; the mark goes, as the branch
 * goes on). Otherwise, or with branch, the parent's session is forked at the parent and the entry
 * starts the new session; branching at the end of a branch marks it end, so it stays one. Returns
 * the tree and the new entry's id.
 */
export function append(t: ChatTree, item: Item, now = Date.now(), branch = false): [ChatTree, string] {
  const parent = t.leaf ? t.entries[t.leaf] : null;
  const id = newId(t, "e", t.order.length);
  const entries = { ...t.entries };
  const sessions = { ...t.sessions };
  const kids = childrenOf(t, t.leaf).length;
  let session: string;
  if (parent && !branch && (!kids || parent.end)) {
    session = parent.session;
    if (parent.end) { const { end: _, ...rest } = parent; entries[parent.id] = rest; }
  } else {
    session = newId(t, "s", Object.keys(t.sessions).length);
    sessions[session] = parent ? { id: session, from: { session: parent.session, at: parent.id } } : { id: session };
    if (parent && !kids) entries[parent.id] = { ...parent, end: true };
  }
  entries[id] = { id, parent: parent?.id ?? null, item, session, at: now };
  return [{ entries, order: [...t.order, id], leaf: id, sessions }, id];
}

/** Replaces an entry's item (a reply as it streams in, a tool call when it ends). */
export function updateItem(t: ChatTree, id: string, item: Item): ChatTree {
  const e = t.entries[id];
  return e ? { ...t, entries: { ...t.entries, [id]: { ...e, item } } } : t;
}

/**
 * Moves to an entry, as picking it in the tree does. A message of yours is taken back: the leaf
 * goes to the end of the turn before it and its text comes back for the composer, to edit and send
 * as a new branch. The end of a turn becomes the leaf, with an empty composer. Anything else (a
 * reply or a tool call partway through a turn) is not a place to branch from: nothing moves.
 */
export function moveTo(t: ChatTree, id: string): { tree: ChatTree; draft?: string } {
  const e = t.entries[id];
  if (!e || !branchable(t, id)) return { tree: t };
  if (e.item.kind === "user") return { tree: { ...t, leaf: e.parent }, draft: e.item.text ?? "" };
  return { tree: { ...t, leaf: id } };
}

/** Where moveTo(id) puts the leaf. */
export const landing = (t: ChatTree, id: string): string | null =>
  t.entries[id]?.item.kind === "user" ? t.entries[id].parent : id;

export function setLabel(t: ChatTree, id: string, label: string): ChatTree {
  const e = t.entries[id];
  if (!e) return t;
  const { label: _, ...rest } = e;
  return { ...t, entries: { ...t.entries, [id]: label.trim() ? { ...rest, label: label.trim() } : rest } };
}

/**
 * A new chat holding the way to an entry, for "fork to a new chat" (pi's /fork). Like moveTo, a
 * message of yours is left out and comes back as the draft; the entry has to be branchable. The
 * copy runs in one new session, forked from the source's session at the last entry copied.
 */
export function forkOut(t: ChatTree, id: string, chat: string): { tree: ChatTree; draft?: string } {
  const to = landing(t, id);
  const ids = pathTo(t, to);
  const last = to ? t.entries[to] : undefined;
  const session: Session = { id: "s1", ...(last ? { from: { session: last.session, at: last.id, chat } } : {}) };
  const entries = Object.fromEntries(ids.map((x) => { const { end: _, ...e } = t.entries[x]; return [x, { ...e, session: "s1" }]; }));
  const draft = t.entries[id]?.item.kind === "user" ? t.entries[id].item.text ?? "" : undefined;
  return { tree: { entries, order: ids, leaf: to, sessions: { s1: session } }, draft };
}

// ---- names

const oneLine = (s: string, n = 60) => {
  const t = s.replace(/<[^>]+>/g, "").replace(/[#*`>_|]/g, " ").replace(/-{3,}/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** An entry in one line, for the tree and for crumbs. */
export function preview(e: Entry, n = 60): string {
  const it = e.item;
  if (it.kind === "tool") return `${it.name ?? "tool"} ${oneLine(JSON.stringify(it.input ?? {}), n)}`;
  return oneLine(it.text ?? "", n) || "(empty)";
}

/**
 * A branch's name, by the entry it ends at: the nearest label on the way to it since the last fork
 * (a label above that is shared with other branches), else your first message after that fork,
 * else "main" (a chat that never forked has one branch).
 */
export function branchName(t: ChatTree, end: string | null): string {
  const path = pathTo(t, end);
  let start = -1;
  for (let i = path.length - 1; i >= 0; i--) if (siblingsOf(t, path[i]).length) { start = i; break; }
  for (let i = path.length - 1; i >= Math.max(start, 0); i--) if (t.entries[path[i]].label) return t.entries[path[i]].label!;
  if (start < 0) return "main";
  const first = path.slice(start).map((id) => t.entries[id]).find((e) => e.item.kind === "user") ?? t.entries[path[start]];
  return preview(first, 40);
}

// ---- the tree view (the navigator)

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
  folded: number;      // entries hidden under this folded row (0: not folded)
  parentRow?: string;  // the row above it in the tree, for ← (entries the filter hides are skipped)
};

function shows(e: Entry, filter: Filter, query: string): boolean {
  const kind = e.item.kind;
  const byFilter = filter === "labeled" ? !!e.label : kind === "user" || kind === "text";
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
    const ways = under.length + (t.entries[id].end ? 1 : 0); // a branch ending here is one of the ways
    out.push({
      id, gutter, parentRow,
      onPath: path.has(id), isLeaf: t.leaf === id, isTip: !(kids.get(id) ?? []).length || !!t.entries[id].end,
      fork: ways > 1 ? ways : 0,
      folded: isFolded ? count(id) : 0,
    });
    return isFolded ? [] : under;
  };
  // split: a branch ends at the row above, so even a single way on is drawn as a branch off it
  const walk = (ids: string[], prefix: string, parentRow: string | undefined, split = false) => {
    if (ids.length === 1 && !split) {
      walk(emit(ids[0], prefix, parentRow), prefix, ids[0], !!t.entries[ids[0]].end);
      return;
    }
    ids.forEach((id, i) => {
      const last = i === ids.length - 1;
      walk(emit(id, prefix + (last ? "└─ " : "├─ "), parentRow), prefix + (last ? "   " : "│  "), id, !!t.entries[id].end);
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
