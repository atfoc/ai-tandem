// The streaming sentence splitter (architecture VC-26): the Markdown of a reply, as it is written, cut into the sentences to say.
//
// The block reader of speech.ts sorts the text into paragraphs, headings, items, rows and code; here a text unit is cut where a
// sentence ends, and every sentence goes through the cleaner. A decision is made only when the text so far settles it, never
// earlier, so a reply fed in any cuts gives the sentences of the reply fed whole: a construct that is still open (a link, a code
// span, a tag, an abbreviation waiting for the word after it) holds the cut back until it is closed or the unit ends.
//
// No React, no react-native, no ports: it runs under `node --test`.
import { REF_SRC } from "@aiwb/core/logic/refs.ts";
import { addPeriod, BlockReader, cleanInline, cleanUnit, codeSpanAt, LOOKAHEAD, REF_LOOKAHEAD, type BlockSink } from "./speech.ts";

/** A fragment shorter than this joins the sentence after it. */
const MIN_SENTENCE = 12;
/** A sentence longer than this is cut, at the last `;`, `:` or `, ` before `CUT_BEFORE`, else at a space. */
const MAX_SENTENCE = 300;
const CUT_BEFORE = 250;

const TERMINATORS = ".!?…。！？";
const CLOSERS = "\"'”’)]}»*_~";
/** Titles and the like (`St.` is a saint far more often than a street): a full stop after them never ends a sentence. */
const NEVER_ENDS = new Set(["e.g", "i.e", "vs", "mr", "mrs", "ms", "dr", "prof", "st"]);
/** A full stop after these ends a sentence only when the word after it does not start in lower case (a number counts for `no`, `fig`). */
const LOWER_FOLLOWS = new Set(["etc", "no", "fig", "approx"]);
const NUMBER_FOLLOWS = new Set(["no", "fig", "approx"]);

const isSpace = (c: string) => /\s/.test(c);
const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();

/** The word (or `e.g`) that ends at the full stop at `i`, within the sentence that starts at `start`. */
function wordBefore(s: string, i: number, start: number): string {
  let a = i;
  while (a > start && !isSpace(s[a - 1]) && !"([{\"'“‘<>".includes(s[a - 1])) a--;
  return s.slice(a, i);
}

/** Where the `[…](…)` or `![…](…)` that starts at `i` ends; `i + 1` (past the bracket) when it is not a link; `"wait"` when more text could decide it. */
function linkEnd(s: string, i: number, final: boolean): number | "wait" {
  const n = s.length;
  const b = s[i] === "!" ? i + 1 : i;
  const plain = b + 1;
  const open = (from: number) => !final && n < from + LOOKAHEAD;
  let p = -1;
  for (let j = b, depth = 0; j < Math.min(n, i + LOOKAHEAD); j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) { p = j; break; }
  }
  if (p < 0) return open(i) ? "wait" : plain;
  if (p + 1 >= n) return final ? plain : "wait";
  if (s[p + 1] === "(") {
    for (let j = p + 2, depth = 1; j < Math.min(n, p + 2 + LOOKAHEAD); j++) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")" && --depth === 0) return j + 1;
    }
    return open(p + 2) ? "wait" : plain;
  }
  if (s[p + 1] === "[") {
    const q = s.indexOf("]", p + 2);
    if (q >= 0 && q < p + 2 + LOOKAHEAD) return q + 1;
    return open(p + 2) ? "wait" : plain;
  }
  return plain;
}

const REF_AT = new RegExp(`^(?:${REF_SRC})`);

/** Where the tag, comment or reference that starts at `i` (a `<`) ends; `i + 1` when it is not one; `"wait"` when more text could decide it. */
function tagEnd(s: string, i: number, final: boolean): number | "wait" {
  const n = s.length;
  const head = s.slice(i, i + 11);
  if (/^<(?:selection|point)[\s/>]/.test(head)) {
    const m = REF_AT.exec(s.slice(i, i + REF_LOOKAHEAD));
    if (m) return i + m[0].length;
    return !final && n < i + REF_LOOKAHEAD ? "wait" : i + 1;
  }
  if (!final && n - i < 11 && ("<selection ".startsWith(head) || "<point ".startsWith(head))) return "wait";
  if (n - i === 1) return final ? i + 1 : "wait";
  if (!/[A-Za-z!/]/.test(s[i + 1])) return i + 1;
  const m = /^<(?:!--[\s\S]*?-->|\/?[A-Za-z][^<>]*>)/.exec(s.slice(i, i + LOOKAHEAD));
  if (m) return i + m[0].length;
  const rest = s.slice(i + 1);
  const unclosed = s.startsWith("<!--", i) ? !rest.includes("-->") : !/[<>]/.test(rest);
  return !final && n - i < LOOKAHEAD && unclosed ? "wait" : i + 1;
}

/**
 * Where the sentences of a text unit end: the offsets just past each sentence and the blanks after it. With `final` off the last
 * sentence is not among them unless its end is certain; with `final` on, the end of the text ends the last one.
 */
export function scan(s: string, final: boolean): number[] {
  const n = s.length;
  const cuts: number[] = [];
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      const r = codeSpanAt(s, i, final);
      if (r === "wait") return cuts;
      if (r) { i = r.end; continue; }
      while (s[i] === "`") i++;
      continue;
    }
    if (c === "[" || (c === "!" && s[i + 1] === "[")) {
      const r = linkEnd(s, i, final);
      if (r === "wait") return cuts;
      i = r;
      continue;
    }
    if (c === "<") {
      const r = tagEnd(s, i, final);
      if (r === "wait") return cuts;
      i = r;
      continue;
    }
    if (!TERMINATORS.includes(c)) { i++; continue; }

    let j = i;
    while (j < n && TERMINATORS.includes(s[j])) j++;
    if (j >= n && !final) return cuts;
    const run = s.slice(i, j);
    while (j < n && CLOSERS.includes(s[j])) j++;
    if (j >= n && !final) return cuts;
    const wide = /[。！？]/.test(run);
    if (j < n && !isSpace(s[j]) && !wide) { i = j; continue; } // inside a token: 3.14, index.ts, a URL
    let k = j;
    while (k < n && isSpace(s[k])) k++;

    let needNext = false;
    let digitOk = false;
    if (run === ".") {
      const raw = wordBefore(s, i, start);
      const w = raw.toLowerCase();
      if (NEVER_ENDS.has(w) || /^[A-Z]$/.test(raw)) { i = j; continue; }
      if (LOWER_FOLLOWS.has(w)) { needNext = true; digitOk = NUMBER_FOLLOWS.has(w); }
    } else if (run.includes("…") || /\.{2,}/.test(run)) needNext = true;
    if (needNext) {
      if (k >= n && !final) return cuts;
      if (k < n && (isLower(s[k]) || (digitOk && /\d/.test(s[k])))) { i = j; continue; }
    }
    cuts.push(k);
    start = k;
    i = k;
  }
  if (final && start < n) cuts.push(n);
  return cuts;
}

/** A sentence over `MAX_SENTENCE` characters, cut into pieces that are not. */
function cutLong(s: string): string[] {
  const out: string[] = [];
  while (s.length > MAX_SENTENCE) {
    const head = s.slice(0, CUT_BEFORE);
    let at = Math.max(head.lastIndexOf(";"), head.lastIndexOf(":"), head.lastIndexOf(", ")) + 1;
    if (at <= 0) at = head.lastIndexOf(" ");
    if (at <= 0) at = s.indexOf(" ", CUT_BEFORE);
    if (at <= 0) break; // one word, however long
    out.push(s.slice(0, at).trim());
    s = s.slice(at).trim();
  }
  out.push(s);
  return out;
}

export function createSplitter(o: { skipCode: boolean; onSentence(s: string): void }): {
  /** The new text of a reply, in order. */
  push(markdown: string): void;
  /** The end of the item: the rest is a sentence. */
  flush(): void;
} {
  let pending = ""; // a fragment too short to be said alone, waiting for the sentence after it

  const say = (text: string) => {
    text = text.trim();
    if (!text) return;
    if (pending) { text = pending + " " + text; pending = ""; }
    const pieces = cutLong(text);
    for (let k = 0; k < pieces.length - 1; k++) o.onSentence(pieces[k]);
    const last = pieces[pieces.length - 1];
    if (last.length < MIN_SENTENCE) pending = last;
    else o.onSentence(last);
  };

  let kind: "p" | "h" | "li" = "p";
  let acc = "";
  /** Say the sentences of the open unit that are settled; with `final`, all of them. */
  const unit = (final: boolean) => {
    const cuts = scan(acc, final);
    let from = 0;
    cuts.forEach((cut, idx) => {
      const s = cleanInline(acc.slice(from, cut), kind);
      say(final && idx === cuts.length - 1 && kind !== "p" ? addPeriod(s) : s);
      from = cut;
    });
    acc = acc.slice(from);
  };

  const sink: BlockSink = {
    text(k, piece) { kind = k; acc += piece; unit(false); },
    end() { unit(true); acc = ""; },
    whole(k, line) { if (k === "row" || !o.skipCode) say(cleanUnit(k, line)); },
  };
  let reader = new BlockReader(sink);

  return {
    push(markdown) { reader.push(markdown); },
    flush() {
      reader.finish();
      reader = new BlockReader(sink);
      const rest = pending;
      pending = "";
      if (rest) o.onSentence(rest);
    },
  };
}
