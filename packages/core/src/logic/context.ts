// The <ui-context> block the app puts in front of every board-chat message.
// DOM-free: board.ts gathers the pieces from the store.
//
// It names the chat's board, nothing else:
// the selection and points on the board are sent only when the user puts them
// in the message (⌘L, ⌘⇧L; see refs.ts).

import { ownId } from "./keys.ts";

/** How a board is named to the agent everywhere: `name (id)`, the id being the board's own on its server (b.id is
 *  the page's key of it). */
export function boardRef(b: { name: string; id: string }): string {
  return `${b.name} (${ownId(b.id)})`;
}

export function contextBlock(o: { board: string }): string {
  return `<ui-context>\nactive_board: ${o.board}\n</ui-context>`;
}
