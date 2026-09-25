// The <ui-context> block the app puts in front of every board-chat message.
// DOM-free: board.ts gathers the pieces from the store.
//
// It names the chat's board and the boards the user @-mentioned, nothing else:
// the selection and points on the board are sent only when the user puts them
// in the message (⌘L, ⌘⇧L; see refs.ts).

/** How a board is named to the agent everywhere: `name (id)`. */
export function boardRef(b: { name: string; id: string }): string {
  return `${b.name} (${b.id})`;
}

export function contextBlock(o: { board: string; referenced: string[] }): string {
  const lines = [`active_board: ${o.board}`];
  if (o.referenced.length) lines.push(`referenced_boards: ${o.referenced.join(", ")}`);
  return `<ui-context>\n${lines.join("\n")}\n</ui-context>`;
}
