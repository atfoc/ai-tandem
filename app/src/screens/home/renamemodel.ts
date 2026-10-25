// What the Rename sheet says (package H2, plans/ux-improvements/h2-design.md §2): its title, the name the field opens with, and the sub-line
// under the title ("Checkout service › Payments · Studio Mac"). No React and no react-native here, so Node loads it (test/h2-rename.test.ts).
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { chatTitle } from "@aiwb/core/logic/labels.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { groupsOn, type State } from "@aiwb/core/state/store.ts";
import type { Item } from "@aiwb/core/types.ts";

import { pathOf } from "./model.ts";

export type RenameKind = "chat" | "board" | "group";

export const RENAME_TITLE: Record<RenameKind, string> = { chat: "Rename chat", board: "Rename whiteboard", group: "Rename group" };

/** The words of the sheet for one item. */
export type RenameTarget = { title: string; name: string; sub: string };

type Input = Pick<State, "groups" | "sections" | "boards" | "chats" | "servers">;

/** The place of an item, then its server: the places joined " › " (outermost first), " · ", the server's name. An item in no place has
 *  the server's name alone. */
export function renameSub(places: readonly string[], server: string): string {
  return [places.join(" › "), server].filter(Boolean).join(" · ");
}

/** What the sheet shows for an item, or null when the item is not (any more) in the store. The place is the names of the groups the item is
 *  in (a group's own name is not part of its place); a chat on a board names the board instead. `items` are the chat's messages (its title
 *  may come from the first one). */
export function renameTarget(s: Input, kind: RenameKind, key: string, items?: Item[]): RenameTarget | null {
  const server = serverOfKey(key), where = serverName(s, server), groups = groupsOn(s, server);
  const names = (keys: readonly string[]) => keys.map((k) => groups.find((g) => g.id === k)?.name ?? "").filter(Boolean);
  const path = pathOf(s, kind, key);
  if (kind === "group") {
    const g = groups.find((x) => x.id === key);
    return g ? { title: RENAME_TITLE.group, name: g.name, sub: renameSub(names(path.groups.slice(0, -1)), where) } : null;
  }
  if (kind === "board") {
    const b = s.boards[key];
    return b ? { title: RENAME_TITLE.board, name: b.name, sub: renameSub(names(path.groups), where) } : null;
  }
  const c = s.chats[key];
  if (!c) return null;
  const board = c.board ? s.boards[c.board]?.name : undefined;
  return { title: RENAME_TITLE.chat, name: chatTitle(c, items), sub: renameSub(board ? [board] : names(path.groups), where) };
}

/** Whether Save is on: a name that is not empty once trimmed and is not the one the item has. */
export const canSaveName = (typed: string, current: string): boolean => typed.trim() !== "" && typed.trim() !== current;
