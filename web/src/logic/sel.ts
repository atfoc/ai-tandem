// What is selected: a board, and a chat: one of the board's chats (shown in the panel), or a
// plain chat alone. DOM-free; store.ts keeps it in localStorage "aiwb.sel" and Sidebar.tsx
// select() changes it.
import type { ChatView } from "../types.ts";
import { serverOfKey } from "./keys.ts";

export type Sel = { board: string | null; chat: string | null }; // board id, chat id

export const NO_SEL: Sel = { board: null, chat: null };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The selection saved as JSON; anything unreadable is no selection. */
export function parseSel(saved: string | null): Sel {
  try {
    const v = JSON.parse(saved ?? "");
    if (v && typeof v === "object") return { board: str(v.board), chat: str(v.chat) };
  } catch {}
  return NO_SEL;
}

/** Where a chat opens: on its board, or alone. */
export const selOf = (c: Pick<ChatView, "id" | "board">): Sel => ({ board: c.board || null, chat: c.id });

type Known = {
  boards: Record<string, unknown>;
  chats: Record<string, Pick<ChatView, "board">>;
};

/** sel with what no longer exists dropped: a board that is gone, and a chat that is gone or does
 *  not belong to the board selected with it. */
export function validSel(sel: Sel, s: Known): Sel {
  const board = sel.board && s.boards[sel.board] ? sel.board : null;
  const c = sel.chat ? s.chats[sel.chat] : undefined;
  const ok = !!c && (c.board || null) === board;
  return { board, chat: ok ? sel.chat : null };
}

/** sel with what no longer exists dropped, for the things of one server (an entry id) alone: a board or a chat of another
 *  server stays as it is, for that server's own tree to judge when it comes. */
export function validSelOn(sel: Sel, server: string, s: Known): Sel {
  const mine = (id: string | null) => !!id && serverOfKey(id) === server;
  if (!mine(sel.board) && !mine(sel.chat)) return sel;
  const board = mine(sel.board) ? (s.boards[sel.board!] ? sel.board : null) : sel.board;
  let chat = sel.chat;
  if (mine(chat)) { const c = s.chats[chat!]; chat = c && (c.board || null) === board ? chat : null; }
  return board === sel.board && chat === sel.chat ? sel : { board, chat };
}
