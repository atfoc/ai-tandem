// @name in a message's text, as the message is drawn: a name that is a board of the chat's server becomes a link
// to that board (screens/markdown/Inline.tsx). DOM-free. Board names are not unique: a name gives every board with it;
// archived boards are never named.

import type { Board } from "../types.ts";

/** A mention's name without trailing punctuation or the old `.excalidraw` suffix. */
export function cleanName(raw: string): string {
  return raw.replace(/[.,;:!?)]+$/, "").replace(/\.excalidraw$/, "");
}

/** The non-archived boards named `name`, sorted by id for a stable order. */
export function resolveName(name: string, boards: Record<string, Board>): Board[] {
  const n = cleanName(name);
  return Object.values(boards).filter((b) => !b.archived && b.name === n).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
