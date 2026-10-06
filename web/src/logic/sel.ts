// What is selected: a board or a run (never both), and a chat: one of the board's or the run's
// chats (shown in the panel), or a plain chat alone. DOM-free; store.ts keeps it in localStorage
// "aiwb.sel" and Sidebar.tsx select() changes it.
import type { ChatView } from "../types.ts";

export type Sel = { board: string | null; run: string | null; chat: string | null }; // board id, run id, chat id

export const NO_SEL: Sel = { board: null, run: null, chat: null };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The selection saved as JSON. An older save has no run; a board wins over a run; anything
 *  unreadable is no selection. */
export function parseSel(saved: string | null): Sel {
  try {
    const v = JSON.parse(saved ?? "");
    if (v && typeof v === "object") {
      const board = str(v.board);
      return { board, run: board ? null : str(v.run), chat: str(v.chat) };
    }
  } catch {}
  return NO_SEL;
}

/** Where a chat opens: on its board, on its run, or alone. */
export const selOf = (c: Pick<ChatView, "id" | "board" | "run">): Sel =>
  ({ board: c.board || null, run: c.board ? null : c.run || null, chat: c.id });

type Known = {
  boards: Record<string, unknown>;
  runs: Record<string, unknown>;
  chats: Record<string, Pick<ChatView, "board" | "run" | "role">>;
};

/** sel with what no longer exists dropped: a board or run that is gone, and a chat that is gone,
 *  is a run's own agent, or does not belong to the board or run selected with it. */
export function validSel(sel: Sel, s: Known): Sel {
  const board = sel.board && s.boards[sel.board] ? sel.board : null;
  const run = !board && sel.run && s.runs[sel.run] ? sel.run : null;
  const c = sel.chat ? s.chats[sel.chat] : undefined;
  const ok = !!c && !c.role && (c.board || null) === board && (c.board ? true : (c.run || null) === run);
  return { board, run, chat: ok ? sel.chat : null };
}
