// A board's sidebar row: the name of its server after the title, the items of the row's menu, and
// what a refused delete says. A board on another server (an entry of the server list) names it;
// a board of this computer is as it always was. DOM-free.
import { UNGROUPED, type Board, type Group } from "../types.ts";
import { serverConnected, serverName, type ListsState } from "./serverlists.ts";
import { noLongerOn, notConnected } from "./status.ts";
import { groupPath } from "./tree.ts";

/** What a board's row shows of its server.
 *  server: the server's name, after the title; null for a board of this computer.
 *  off: the server is not connected: the name is grey. gone: the board is no longer on its
 *  server: the row is grey. title: what the name says on hover, when it has something to say. */
export type BoardRowView = { server: string | null; off: boolean; gone: boolean; title?: string };

const LOCAL_ROW: BoardRowView = { server: null, off: false, gone: false };

export function boardRow(b: Board, s: ListsState): BoardRowView {
  if (!b.server) return LOCAL_ROW;
  const server = serverName(s, b.server);
  if (b.gone) return { server, off: false, gone: true, title: noLongerOn(server) };
  return serverConnected(s, b.server) ? { server, off: false, gone: false } : { server, off: true, gone: false, title: notConnected(server) };
}

export type BoardMenuItem = "rename" | "move" | "reveal" | "archive" | "unarchive" | "delete" | "remove";

/** The label of each item of the row's menu. */
export const BOARD_MENU_LABEL: Record<BoardMenuItem, string> = {
  rename: "Rename", move: "Move to…", reveal: "Reveal in Finder", archive: "Archive", unarchive: "Unarchive", delete: "Delete", remove: "Remove from this sidebar",
};

/** The items of a board's row menu, in order. A board on another server has no file to reveal
 *  and is moved between this computer's groups from the menu; one that is gone there can only be
 *  removed from this sidebar. */
export function boardMenu(b: Board): BoardMenuItem[] {
  if (b.server && b.gone) return ["remove"];
  if (b.archived) return ["unarchive", "delete"];
  return b.server ? ["rename", "move", "archive", "delete"] : ["rename", "reveal", "archive", "delete"];
}

export const UNGROUPED_LABEL = "Ungrouped";

/** Where "Move to…" can put a board that is in the group current: the ungrouped area first, then
 *  every group that is not archived, by its path; never where the board is already. */
export function moveTargets(groups: Group[], current: string): { id: string; label: string }[] {
  const into = groups.filter((g) => !g.archived && g.id !== current).map((g) => ({ id: g.id, label: groupPath(groups, g.id).join(" / ") }));
  return current === UNGROUPED ? into : [{ id: UNGROUPED, label: UNGROUPED_LABEL }, ...into];
}

/** What is said when a board's delete was refused because its server is not connected. */
export const boardDeleteRefused = (board: string, server: string): string => `“${board}” was not deleted: it is on ${server}, which is not connected.`;

/** Whether a call failed because the board's server is not connected (the 503 of an ApiError):
 *  nothing was sent there. */
export const isUnreachable = (e: unknown): boolean => e instanceof Error && (e as { status?: unknown }).status === 503;
