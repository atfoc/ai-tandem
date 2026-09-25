// The <ui-context> block the app puts in front of every board-chat message.
// DOM-free: board.ts gathers the pieces from the store and the live canvas.

import { formatViewport } from "../format.ts";
import type { FmtViewport } from "../format.ts";

/** How a board is named to the agent everywhere: `name (id)`. */
export function boardRef(b: { name: string; id: string }): string {
  return `${b.name} (${b.id})`;
}

export function contextBlock(o: { board: string; referenced: string[]; selection: string[]; viewport: FmtViewport }): string {
  const lines = [`active_board: ${o.board}`];
  if (o.referenced.length) lines.push(`referenced_boards: ${o.referenced.join(", ")}`);
  if (o.selection.length) { lines.push(`selection (${o.selection.length}):`); for (const l of o.selection) lines.push("  " + l); }
  else lines.push("selection: none");
  lines.push(formatViewport(o.viewport));
  return `<ui-context>\n${lines.join("\n")}\n</ui-context>`;
}
