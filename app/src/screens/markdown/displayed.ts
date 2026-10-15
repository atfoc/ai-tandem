// The displayed text of a message (AD-75, AD-64): the text a quote counts in. It is the text nodes of the message in order, as
// the page's DOM has them today (the old page's quoteDom.ts reads that): a code block's header is no part of it, a chip is its label,
// a mention its @name, and the "\n" nodes the page has between blocks and around the items of a list or a quote are in it. So a
// quote's stored position means the same on every target. No React and no react-native here, so Node loads it.
import type { Root } from "mdast";

import { lower, type Block, type Doc, type Inline } from "./doc.ts";
import { blocksOf, prepare } from "./parse.ts";

/** The testIDs of what is drawn as text but is no part of the displayed text: a code block's header and a list's markers (the page's
 *  `::marker` is no text node either). A platform that reads the drawn text (web's quote, AD-64) skips what is inside them. */
export const NOT_DISPLAYED = ["md-code-head", "md-marker"] as const;

function inlineText(n: Inline): string {
  switch (n.k) {
    case "text": case "code": return n.v;
    case "br": return "\n";
    case "chip": return n.ref.label + n.after;
    case "mention": return n.raw;
    case "check": return "";
    default: return n.kids.map(inlineText).join("");
  }
}

/** The pieces of a block's displayed text in order; `sep` marks the "\n" nodes the page has between blocks and around the items of a list or a quote. */
function pieces(b: Block, put: (text: string, sep: boolean) => void): void {
  switch (b.k) {
    case "p": case "h": put(b.kids.map(inlineText).join(""), false); break;
    case "code": put(b.text, false); break;
    case "nl": put("\n", true); break;
    case "hr": break;
    case "table": put([b.head, ...b.rows].map((r) => r.map((c) => c.kids.map(inlineText).join("")).join("")).join(""), false); break;
    default: for (const k of b.kids) pieces(k, put);
  }
}

/** The displayed text of a tree to draw. `separators: false` leaves out the "\n" nodes the page has between blocks and around the
 *  items of a list or a quote: what remains is what the drawing has as text (a platform that measures what it drew, where the
 *  separators are not drawn, aligns its offsets with it). */
export const displayedTextOf = (doc: Doc, separators = true): string => {
  let out = "";
  for (const b of doc.kids) pieces(b, (text, sep) => { if (separators || !sep) out += text; });
  return out;
};

/** The displayed text of the mdast of one block (parse.ts parse); refs and mentions as for doc.ts lower. */
export const displayedText = (tree: Root, refs: string[] = [], mentions = false): string => displayedTextOf(lower(tree, refs, mentions));

/** The displayed text of a whole message: its blocks' texts one after the other, with nothing between them. */
export function messageText(text: string, forUser = false, streaming = false, separators = true): string {
  return blocksOf(text, streaming).map((b) => displayedTextOf(prepare(b, forUser), separators)).join("");
}

/** A message's displayed text with the separators marked: `sep[i]` is true when `text[i]` is one of the "\n" nodes the page has between
 *  blocks, which no drawing has as text. A platform that reads what it drew (web's quote, screens/quotes) counts the offsets it finds in
 *  the drawn characters and turns them into offsets in `text` with this, so a stored position means the same on every target. */
export function shownText(text: string, forUser = false): { text: string; sep: boolean[] } {
  let out = "";
  const sep: boolean[] = [];
  for (const b of blocksOf(text, false)) {
    for (const k of prepare(b, forUser).kids) {
      pieces(k, (t, s) => { out += t; for (let i = 0; i < t.length; i++) sep.push(s); });
    }
  }
  return { text: out, sep };
}
