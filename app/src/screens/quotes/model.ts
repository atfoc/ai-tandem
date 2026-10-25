// What the quotes screens decide and no screen needs to draw (package K5): what the comment field holds and how it is kept, the words of the
// count and of the list, the reference a span of a message's displayed text makes. No React and no react-native here, so Node loads it.
// The logic of a quote itself (finding it again, previewing it, its key) is @aiwb/core's logic/quotes.ts.
import { agentName } from "@aiwb/core/agents.ts";
import { quoteKey, quotable, withComment } from "@aiwb/core/logic/quotes.ts";
import type { Item, Reference } from "@aiwb/core/types.ts";

/** The comment field's state: a new quote, or one in the draft (`edit`), with the comment being typed. */
export type Editing = { r: Reference; edit: boolean; text: string };

/** `qs` with what the field holds: a new quote is added (always on Enter, else only with a comment), an edited one gets its comment. */
export function withFloat(qs: Reference[], f: Pick<Editing, "r" | "edit" | "text">, enter: boolean): Reference[] {
  const k = quoteKey(f.r);
  if (f.edit) return qs.map((q) => (quoteKey(q) === k ? withComment(q, f.text) : q));
  return (enter || f.text.trim()) && !qs.some((q) => quoteKey(q) === k) ? [...qs, withComment(f.r, f.text)] : qs;
}

/** The count's words: "❝ 2 comments" with the word, "❝ 2" without it (a narrow composer). */
export const countTitle = (n: number): string => `${n} quoted passage${n === 1 ? "" : "s"} in this message`;
export const countWord = (n: number): string => `comment${n === 1 ? "" : "s"}`;

/** The phone's chip: "1 quote", "2 quotes". */
export const chipWord = (n: number): string => `${n} quote${n === 1 ? "" : "s"}`;

/** The phone sheet's sub-line under "Quoted in this message". */
export const sheetSub = (n: number): string => `${n} passage${n === 1 ? "" : "s"} from this chat`;

/** Where a quote is from, in one line for the phone sheet: the agent and which of its replies ("Claude Code · the last reply", "Claude Code · 2 replies up":
 *  the replies counted from the end of the thread, the last one first), "Your message" for one of the person's own, and a plain sentence for an item the thread no
 *  longer has. `items` is the thread's list, `agent` the chat's agent kind ("" when it has none). */
export function quoteSource(items: readonly Pick<Item, "kind">[] | undefined, agent: string, r: Pick<Reference, "item">): string {
  const it = items?.[r.item];
  if (!it) return "No longer in this chat";
  if (it.kind === "user") return "Your message";
  const name = agent ? agentName(agent) : "The agent";
  let up = 0;
  for (let i = r.item; i < items!.length; i++) if (items![i].kind === "text") up++;
  return `${name} · ${up <= 1 ? "the last reply" : `${up} replies up`}`;
}

/** The list's head hint: what a press on a quote does. */
export const listHint = (canEdit: boolean, touch: boolean): string => `${touch ? "tap" : "click"} one to ${canEdit ? "edit" : "show"} it`;

/** The composer below this width draws the count without its word (the page's container query). */
export const NARROW_COUNT = 440;

/** The sentence that says why an item of the thread takes no quote, "" for one that does (B-QS-04, B-QS-05). */
export function whyNotQuotable(item: Pick<Item, "kind" | "done"> | undefined): string {
  if (!item) return "This message is no longer there.";
  const q = quotable(item);
  if (q === undefined) return "Only a message's own words can be quoted.";
  return q ? "" : "Wait for the reply to finish, then quote it";
}

/** The reference for the span `[start, end)` of a message's displayed text: the words as the span has them, trimmed, and the span of those
 *  (a selection often takes the white space around the words). null for a span with no words. */
export function referenceFor(shown: string, item: number, start: number, end: number): Reference | null {
  let a = Math.max(0, Math.min(start, end)), b = Math.min(shown.length, Math.max(start, end));
  while (a < b && /\s/.test(shown[a])) a++;
  while (b > a && /\s/.test(shown[b - 1])) b--;
  if (a >= b) return null;
  return { quote: shown.slice(a, b), item, start: a, end: b };
}

/** The whole message as one quote (the sheet's "Quote whole message"). */
export const wholeReference = (shown: string, item: number): Reference | null => referenceFor(shown, item, 0, shown.length);

/** How long a sentence in the sheet's place of its buttons stays up: the composer's note is 2.5 s. */
export const NOTE_MS = 2500;
