// How the Quote sheet, which a long press on a message opens from the thread, reaches the composer of the same chat (package K5): the
// composer's `useQuotes` registers what it can do for its chat while it is drawn, as the board's selection reaches it through
// `registerInserter` (K3). One composer takes quotes for a chat at a time: the composer of the branch the chat is on.
import type { Reference } from "@aiwb/core/types.ts";

export type Taker = {
  /** Starts a quote of the passage: its comment field opens (the composer's float). */
  quote(r: Reference, at?: unknown): void;
  /** The draft's quotes now. */
  quotes(): Reference[];
};

const takers = new Map<string, Taker>();

/** Registers the composer of a chat as the one that takes its quotes; the function answered takes it away again. */
export function registerTaker(chat: string, t: Taker): () => void {
  takers.set(chat, t);
  return () => { if (takers.get(chat) === t) takers.delete(chat); };
}

/** The composer that takes quotes for a chat, if one is drawn. */
export const takerOf = (chat: string): Taker | undefined => takers.get(chat);
