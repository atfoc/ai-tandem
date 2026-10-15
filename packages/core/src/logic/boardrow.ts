// A board's sidebar row: the items of the row's menu, and where "Move to…" can put the board. A
// board of a section (a remote server of the server list) has the menu of a local board but for
// what makes no sense on another machine: its file cannot be shown in this computer's file
// manager. DOM-free.
import type { Board, Group } from "../types.ts";
import { inSection, isUngrouped, ungroupedOn, serverOfKey } from "./keys.ts";
import { groupPath } from "./tree.ts";

export type BoardMenuItem = "rename" | "move" | "reveal" | "archive" | "unarchive" | "delete";

/** The label of each item of the row's menu. */
export const BOARD_MENU_LABEL: Record<BoardMenuItem, string> = {
  rename: "Rename", move: "Move to…", reveal: "Reveal in Finder", archive: "Archive", unarchive: "Unarchive", delete: "Delete",
};

/** The items of a board's row menu, in order. A board of a section has no file to reveal here, and
 *  is moved between the groups of its own server from the menu. */
export function boardMenu(b: Board): BoardMenuItem[] {
  if (b.archived) return ["unarchive", "delete"];
  return inSection(b.id) ? ["rename", "move", "archive", "delete"] : ["rename", "reveal", "archive", "delete"];
}

/** The question before a board is deleted. busy: an agent works on it. name: the server's, "" for a board of this
 *  computer; a section's board is deleted on its server, for its owner and every client of it. */
export const boardDeleteBody = (busy: boolean, name = ""): string =>
  `${busy ? "An agent is working on this board. Stop it and delete? " : ""}${name ? `The board and all its chats are removed on ${name}, for everyone who uses that server.` : "The board file and all its chats are removed."} This can't be undone.`;

export const UNGROUPED_LABEL = "Ungrouped";

/** Where "Move to…" can put a board that is in the group current: the ungrouped area of its server
 *  first, then every group that is not archived, by its path; never where the board is already.
 *  groups: the groups of the board's own server, and of no other: a section is in no such list, and
 *  nothing is moved from one server to another. */
export function moveTargets(groups: Group[], current: string): { id: string; label: string }[] {
  const into = groups.filter((g) => !g.archived && g.id !== current).map((g) => ({ id: g.id, label: groupPath(groups, g.id).join(" / ") }));
  return isUngrouped(current) ? into : [{ id: ungroupedOn(serverOfKey(current)), label: UNGROUPED_LABEL }, ...into];
}
