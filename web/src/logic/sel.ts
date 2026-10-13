// What is selected: a board, and a chat: one of the board's chats (shown in the panel), or a
// plain chat alone. DOM-free; store.ts keeps it in localStorage "aiwb.sel" and Sidebar.tsx
// select() changes it.
import type { ChatView } from "../types.ts";

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
