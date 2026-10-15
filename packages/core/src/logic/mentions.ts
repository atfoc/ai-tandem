// @name mentions in a board chat's message. DOM-free: used by Composer (the
// @ picker and the context chip) and by board.ts buildContext.
//
// Board names are not unique, so a mention resolves to board ids:
// - a mention picked from the @ list remembers its board's id;
// - a typed @name gives every board with that name;
// - archived boards are never mentioned.

import type { Board, Group } from "../types.ts";
import { groupPath } from "./tree.ts";

/** A mention picked from the @ list: the name inserted into the text, and its board. */
export type Picked = { name: string; id: string };

/** Any `@word` in a message, as the prototype matched it. */
export const MENTION_RE = /@([\w.\-]+)/g;

/** A mention's name without trailing punctuation or the old `.excalidraw` suffix. */
export function cleanName(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/, "").replace(/\.excalidraw$/, "");
}

/** The names mentioned in a message, cleaned, in order, without duplicates. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const n = cleanName(m[1]);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The mention being typed at the caret, if any: its query and where its `@` is. */
export function openMention(beforeCaret: string): { q: string; at: number } | null {
  const m = /(^|\s)@([\w.\-]*)$/.exec(beforeCaret);
  return m ? { q: m[2], at: beforeCaret.length - m[2].length - 1 } : null;
}

const live = (boards: Record<string, Board>) => Object.values(boards).filter((b) => !b.archived);

/** The non-archived boards named `name` (typed mention), sorted by id for a stable order. */
export function resolveName(name: string, boards: Record<string, Board>): Board[] {
  const n = cleanName(name);
  return live(boards).filter((b) => b.name === n).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The boards a message refers to, without duplicates. Picked mentions still
 * present in the text (`@<name>`) resolve by their id; every other typed @name
 * resolves by name to all boards that carry it.
 */
export function resolveMentions(text: string, boards: Record<string, Board>, picked: Picked[] = []): Board[] {
  const out: Board[] = [];
  const add = (b: Board | undefined) => { if (b && !b.archived && !out.some((o) => o.id === b.id)) out.push(b); };
  const pickedNames = new Set<string>();
  for (const p of picked) {
    if (!text.includes("@" + p.name)) continue;
    pickedNames.add(p.name);
    add(boards[p.id]);
  }
  for (const n of parseMentions(text)) {
    if (pickedNames.has(n)) continue;
    for (const b of resolveName(n, boards)) add(b);
  }
  return out;
}

/** The @ list: non-archived boards whose name contains the query, with their group's path ("A / B"). */
export function mentionOptions(
  q: string, boards: Record<string, Board>, groups: Group[], limit = 6,
): { board: Board; group: string }[] {
  const ql = q.toLowerCase();
  return live(boards)
    .filter((b) => b.name.toLowerCase().includes(ql))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((board) => ({ board, group: groupPath(groups, board.group).join(" / ") }));
}
