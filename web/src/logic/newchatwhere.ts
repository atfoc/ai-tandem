// ⌘N: the shortcut, and where the chat it makes goes: the place the user is in. DOM-free.

import { UNGROUPED, type Board, type ChatView, type Group, type RunView } from "../types.ts";
import { offersChatOn } from "./runserver.ts";
import type { Sel } from "./sel.ts";

export type Where = { group: string } | { board: string } | { run: string };

const isMac = (platform: string) => /Mac|iPhone|iPad/.test(platform);

/** ⌘N on macOS, Ctrl+N elsewhere, with nothing else held. platform: navigator.platform. Ctrl+N is not taken on macOS: there
 *  it moves the caret a line down in a text field. */
export const isNewChatKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }, platform: string) =>
  e.code === "KeyN" && !e.shiftKey && !e.altKey && (isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/**
 * Where a new chat goes for what is selected: on the board or the run of the selected chat, else
 * in that chat's group; with no chat, on the open board or run; with nothing, ungrouped. The chat
 * is asked first: a board chat used without its board still gets its neighbour on that board.
 * A chat the store does not hold (chats: the store's, by id) counts as none.
 */
export function newChatWhere(sel: Sel, chats: Record<string, Pick<ChatView, "group" | "board" | "run">>): Where {
  const c = sel.chat ? chats[sel.chat] : undefined;
  if (c?.board) return { board: c.board };
  if (c?.run) return { run: c.run };
  if (sel.board) return { board: sel.board };
  if (sel.run) return { run: sel.run };
  return { group: c?.group || UNGROUPED };
}

/** What ⌘N reads of the store. */
export type NewChatStore = {
  sel: Sel;
  chats: Record<string, Pick<ChatView, "group" | "board" | "run">>;
  groups: Pick<Group, "id" | "archived">[];
  boards: Record<string, Pick<Board, "server" | "gone" | "archived">>;
  runs: Record<string, Pick<RunView, "server" | "started" | "archived" | "gone">>;
};

/**
 * The place ⌘N makes its chat in, or null where that place offers none: the shortcut does what
 * the "+ Chat" button of the place does, and nothing where there is no such button. No chat on an
 * archived board, run or group, on a board or run that is gone from its server or that the store
 * does not hold, or on a draft of a run on another server (offersChatOn).
 */
export function newChatPlace(s: NewChatStore): Where | null {
  const w = newChatWhere(s.sel, s.chats);
  if ("board" in w) {
    const b = s.boards[w.board];
    return b && !b.archived && !(b.server && b.gone) ? w : null;
  }
  if ("run" in w) {
    const r = s.runs[w.run];
    return r && offersChatOn(r) && !r.gone ? w : null;
  }
  return s.groups.find((g) => g.id === w.group)?.archived ? null : w;
}
