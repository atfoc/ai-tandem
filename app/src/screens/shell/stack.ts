// What the window shows, and the stack of screens the phone derives from it (AD-71). Pure: no React, no react-native, so Node
// loads it. The wide layouts draw `shellView` as one split view; the phone draws `stackOf` as a stack of screens, and a back sets the
// store (`select` with the chat or the board cleared) rather than the stack.
import type { Sel } from "@aiwb/core/logic/sel.ts";

/** What the store holds of what is on screen. */
export type StackState = {
  sel: Sel;
  boards: Record<string, { id: string }>;
  chats: Record<string, { id: string; board?: string | null }>;
  subDrawer?: { chat: string } | null;
};

/** The view the selection gives (today's `Grouped`): a board (with one of its chats, when that chat is of the board), a plain chat,
 *  or Home. A selection of a thing the store does not hold is Home; so is a board's chat with no board selected. */
export type ShellView =
  | { kind: "board"; board: string; chat: string | null }
  | { kind: "chat"; chat: string }
  | { kind: "home" };

export function shellView(s: StackState): ShellView {
  const board = s.sel.board ? s.boards[s.sel.board] : undefined;
  const chat = s.sel.chat ? s.chats[s.sel.chat] : undefined;
  if (board) return { kind: "board", board: board.id, chat: chat && chat.board === board.id ? chat.id : null };
  if (chat && !chat.board) return { kind: "chat", chat: chat.id };
  return { kind: "home" };
}

/** The screens of the phone's stack, bottom first. The sidebar is the first screen; a board is pushed over it and a board's chat
 *  over its board (so the board stays mounted beneath, AD-52); a plain chat is pushed over the sidebar; the subagent drawer is
 *  pushed over the chat it belongs to. */
export type Route = "side" | "board" | "chat" | "drawer";

export function stackOf(s: StackState): Route[] {
  const v = shellView(s);
  const routes: Route[] = ["side"];
  if (v.kind === "board") routes.push("board");
  if (v.kind === "board" && v.chat) routes.push("chat");
  if (v.kind === "chat") routes.push("chat");
  const onScreen = v.kind === "board" ? v.chat : v.kind === "chat" ? v.chat : null;
  if (onScreen && s.subDrawer?.chat === onScreen) routes.push("drawer");
  return routes;
}

/** What a back from the top of `routes` sets: the store's selection with that screen gone, or the drawer closed. */
export function backFrom(routes: readonly Route[], sel: Sel): { sel: Sel } | { closeDrawer: true } | null {
  const top = routes[routes.length - 1];
  if (top === "drawer") return { closeDrawer: true };
  if (top === "chat") return { sel: routes.includes("board") ? { board: sel.board, chat: null } : { board: null, chat: null } };
  if (top === "board") return { sel: { board: null, chat: null } };
  return null;
}

/** The selection the routes the navigator ended with stand for, when it is not what the store has (a swipe back): the routes the
 *  navigator has are a prefix of the store's, and the store goes to that prefix. Anything else is left to the store. */
export function selForRoutes(routes: readonly Route[], have: readonly Route[], sel: Sel): { sel: Sel } | { closeDrawer: true } | null {
  if (routes.length >= have.length || routes.length < 1) return null;
  if (!routes.every((r, i) => have[i] === r)) return null;
  return backFrom(have.slice(0, routes.length + 1), sel);
}

/** Whether two lists of routes are the same. */
export const sameRoutes = (a: readonly Route[], b: readonly Route[]): boolean => a.length === b.length && a.every((r, i) => b[i] === r);
