// ⌘N: the shortcut, and where the chat it makes goes: the place the user is in. DOM-free.

import type { Board, ChatView, Group } from "../types.ts";
import { serverOfKey, ungroupedOn } from "./keys.ts";
import type { Sel } from "./sel.ts";

export type Where = { group: string } | { board: string };

const isMac = (platform: string) => /Mac|iPhone|iPad/.test(platform);

/** ⌘N on macOS, Ctrl+N elsewhere, with nothing else held. platform: navigator.platform. Ctrl+N is not taken on macOS: there
 *  it moves the caret a line down in a text field. */
export const isNewChatKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }, platform: string) =>
  e.code === "KeyN" && !e.shiftKey && !e.altKey && (isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/**
 * Where a new chat goes for what is selected: on the board of the selected chat, else in that
 * chat's group (a chat in no group: the ungrouped area of the chat's own server); with no chat,
 * on the open board; with nothing, ungrouped on this computer. The chat is asked
 * first: a board chat used without its board still gets its neighbour on that board. A chat the
 * store does not hold (chats: the store's, by key) counts as none. Where the chat is made decides
 * the server it lives on: the place's key names it.
 */
export function newChatWhere(sel: Sel, chats: Record<string, Pick<ChatView, "group" | "board">>): Where {
  const c = sel.chat ? chats[sel.chat] : undefined;
  if (c?.board) return { board: c.board };
  if (sel.board) return { board: sel.board };
  return { group: c?.group || ungroupedOn(c ? serverOfKey(sel.chat) : undefined) };
}

/** What ⌘N reads of the store. */
export type NewChatStore = {
  sel: Sel;
  chats: Record<string, Pick<ChatView, "group" | "board">>;
  groups: Pick<Group, "id" | "archived">[];
  boards: Record<string, Pick<Board, "archived">>;
  /** Whether a thing takes a call now (logic/sections.ts reachable): a section's does while its server is connected and has it. */
  reachable(key: string): boolean;
};

/**
 * The place ⌘N makes its chat in, or null where that place offers none: the shortcut does what
 * the "+ Chat" button of the place does, and nothing where there is no such button. No chat on an
 * archived board or group, on a board that the store does not hold, and nothing in a
 * section whose server is not connected or no longer has the place: there is nothing to make it from.
 * groups: every group the page knows, this computer's and the sections'.
 */
export function newChatPlace(s: NewChatStore): Where | null {
  const w = newChatWhere(s.sel, s.chats);
  if ("board" in w) {
    const b = s.boards[w.board];
    return b && !b.archived && s.reachable(w.board) ? w : null;
  }
  if (!s.reachable(w.group)) return null;
  return s.groups.find((g) => g.id === w.group)?.archived ? null : w;
}
