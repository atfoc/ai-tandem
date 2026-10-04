// Quote references (⌘L on text selected in a message): finding a quote again in a message's
// displayed text, how a quote is previewed, and a draft's quotes. DOM-free; quoteDom.ts measures
// the text.
//
// The displayed text is the text nodes of a message, in order, with nothing between blocks. A
// selection's own text (the quote) has line breaks between blocks, so quotes are compared with
// whitespace left out.

import type { Item, Reference } from "../types.ts";

export type Span = { start: number; end: number };

/** How a quote was found: at its stored position, by searching the message, or not at all (the
 *  whole message stands for it). */
export type Found = Span & { how: "exact" | "search" | "message" };

/** s without whitespace, and for each of its characters the index it had in s. */
function squash(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) continue;
    text += s[i];
    at.push(i);
  }
  return { text, at };
}

/** Where r's quote is in a message's displayed text: its stored position when the characters
 *  there still match, else the first place the quote appears, else the whole message. */
export function findQuote(displayed: string, r: Pick<Reference, "quote" | "start" | "end">): Found {
  const q = squash(r.quote).text;
  const whole: Found = { start: 0, end: displayed.length, how: "message" };
  if (!q) return whole;
  if (r.start >= 0 && r.end <= displayed.length && r.start < r.end && squash(displayed.slice(r.start, r.end)).text === q) {
    return { start: r.start, end: r.end, how: "exact" };
  }
  const d = squash(displayed);
  const i = d.text.indexOf(q);
  if (i < 0) return whole;
  return { start: d.at[i], end: d.at[i + q.length - 1] + 1, how: "search" };
}

/** Whether an item of the chat's thread can be quoted: the user's messages, and the agent's
 *  replies once finished. undefined for everything else, which is never quotable. */
export const quotable = (it: Pick<Item, "kind" | "done">): boolean | undefined =>
  it.kind === "user" ? true : it.kind === "text" ? !!it.done : undefined;

/** A quote as one line, cut to max characters. */
export function preview(quote: string, max = 80): string {
  const one = quote.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1).trimEnd() + "…" : one;
}

/** A quote's identity in a draft: its message and its position there. */
export const quoteKey = (r: Pick<Reference, "item" | "start" | "end">) => `${r.item}:${r.start}:${r.end}`;

/** r with the comment c, or with none when c is blank. */
export function withComment(r: Reference, c: string): Reference {
  const { comment: _, ...rest } = r;
  return c.trim() ? { ...rest, comment: c } : rest;
}

/** A draft's quotes as they are sent: comments trimmed, blank ones left out. */
export const toSend = (qs: Reference[]) => qs.map((q) => withComment(q, q.comment?.trim() ?? ""));
