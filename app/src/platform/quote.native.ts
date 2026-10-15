// The quote port on native (AD-64): the thread has no selection to quote and no DOM to mark, so a quote is taken in the Quote sheet that a
// long press opens (screens/quotes), the draft's passages are marked in that sheet and the count's list, and a quote points at its message by
// scrolling the thread to it and flashing the message.
import type { Reference } from "@aiwb/core/types.ts";

import type { QuoteHost, QuotePort } from "./quote.types.ts";

export type { QuoteHost, QuotePort, Quoted } from "./quote.types.ts";

let host: QuoteHost | null = null;

export const quotePort: QuotePort = {
  configure(h) { host = h; },
  selected: () => null,
  clearSelection: () => {},
  anchor: () => null,
  mark: () => () => {},
  onMarkPress: () => () => {},
  show(chat: string, r: Reference) {
    host?.bring(chat, r.item, true);
    host?.flash(chat, r.item);
  },
};
