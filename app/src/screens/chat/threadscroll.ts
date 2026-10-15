// Where a chat's thread can be scrolled to a message from outside the list (K5: "Show where this is from" of a quote card, a quote of the
// composer's list). The list is virtual (StickyList): the message may not be drawn, so the list itself is asked to bring its row near the
// middle of the window. The thread registers its handle while it is drawn; a short thread (nothing to scroll) registers none.
export type ThreadScroller = {
  /** Brings the message at `index` of the thread to the middle of the window. false: it is not a row of the list. */
  toItem(index: number, animated: boolean): boolean;
};

const scrollers = new Map<string, ThreadScroller>();

/** Registers a thread's scroller (chat: its key); the function answered takes it away again. */
export function registerThreadScroller(chat: string, s: ThreadScroller): () => void {
  scrollers.set(chat, s);
  return () => { if (scrollers.get(chat) === s) scrollers.delete(chat); };
}

/** The scroller of a chat's thread now, if it is drawn and scrolls. */
export const threadScroller = (chat: string): ThreadScroller | undefined => scrollers.get(chat);
