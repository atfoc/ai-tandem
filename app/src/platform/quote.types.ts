// The quote port (AD-64, package K5): what a platform does with quotes that is not the same everywhere. On web the browser's own selection
// in the thread is quoted (⌘L), and the passages of a draft's quotes are marked and shown with the CSS Custom Highlight API, over the DOM that
// React owns (the DOM is never changed). On native there is no selection in the thread: a long press opens the Quote sheet (screens/quotes),
// and a quote points at its message by scrolling to it and flashing it. The screens give the port what it needs of the app (`QuoteHost`).
import type { Reference } from "@aiwb/core/types.ts";

/** The text selected in a message as a quote, with where it is (the platform's own handle: web's live DOM range), or the sentence to say. */
export type Quoted = { ref: Reference; at: unknown } | { error: string };

/** What the port asks of the app. */
export type QuoteHost = {
  /** A message's displayed text (screens/markdown/displayed.ts), with the characters nothing draws marked: null for an item that is not a
   *  message of the chat's thread. */
  shown(chat: string, item: number): { text: string; sep: boolean[] } | null;
  /** Scrolls the chat's thread so that the message is near the middle of the window (the list is virtual: it may not be drawn yet). */
  bring(chat: string, item: number, animated: boolean): boolean;
  /** Flashes a message (where there is no DOM to highlight a span in). */
  flash(chat: string, item: number): void;
};

export type QuotePort = {
  configure(host: QuoteHost): void;
  /** The text selected in the chat's thread, as a quote of one message; null when nothing is selected there. Native has none. */
  selected(chat: string): Quoted | null;
  /** Where a quote is now in the thread (the platform's handle: web's DOM range), null when its message is not drawn or the platform has none. */
  anchor(chat: string, r: Reference): unknown | null;
  /** Keeps the draft's passages marked in the thread, and `extra` (the one being quoted) too; the function answered stops. */
  mark(chat: string, refs: () => Reference[], extra: () => unknown | null): () => void;
  /** A press on a marked passage (with nothing selected) tells which quote it is. */
  onMarkPress(chat: string, refs: () => Reference[], open: (q: Reference) => void): () => void;
  /** Drops the selection (the quote just taken shows as a mark instead). */
  clearSelection(): void;
  /** Shows where a quote was taken from: scrolls the thread to it and, with `highlight`, marks it for a moment. */
  show(chat: string, r: Reference, highlight?: boolean): void;
};
