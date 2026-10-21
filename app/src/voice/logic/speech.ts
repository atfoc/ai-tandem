// The cleaner: the Markdown of a message turned into the words to say (architecture VC-25). Line and block based, and the same for
// a whole message (`speechText`) and for a stream (`sentences.ts` feeds the same `BlockReader` with the text as it grows).
//
// A message is read as units. A paragraph, a heading and a list item are text units (a paragraph runs over its soft line
// breaks); a table row and a line of code are whole units. The reader decides what a line is as soon as its first characters
// say so, but only when a longer line could not change that: while a line holds nothing but characters that may be part of a
// marker (`-`, `1.`, `#`, `|`, a backtick, …) it waits for the next one. That is what makes a text read in any cuts come out as
// the text read whole.
//
// No React, no react-native, no ports: it runs under `node --test`.
import { parseRef, REF_SRC } from "@aiwb/core/logic/refs.ts";

/** What a unit is: a paragraph (also a quote), a heading, a list item, a table row, a line of code. */
export type UnitKind = "p" | "h" | "li" | "row" | "code";

/** How far ahead a construct looks for its closer (a code span, a link, a tag). Past it the opener is plain text. */
export const LOOKAHEAD = 400;
/** The same for a reference tag, whose detail lists the selected elements. */
export const REF_LOOKAHEAD = 8000;

// ---- the block reader

/** Where the reader's units go. `text` may come in pieces (the unit is open until `end`); `whole` is a complete one-line unit. */
export type BlockSink = {
  text(kind: "p" | "h" | "li", piece: string): void;
  end(): void;
  whole(kind: "row" | "code", line: string): void;
};

type Cls =
  | { k: "blank" }
  | { k: "fence"; ch: string; len: number }
  | { k: "hr" }
  | { k: "sep" }
  | { k: "row" }
  | { k: "ind" }
  | { k: "h" | "li" | "p"; pre: number };

/** Characters a block marker is made of: a line holding only these (and spaces) is not decided until it has more. */
const MARKER_ONLY = /^[\s>#\-*+_=|~`\d.)[!<:]*$/;
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const indentOf = (s: string) => {
  let n = 0;
  for (const c of s) { if (c === " ") n++; else if (c === "\t") n += 4; else break; }
  return n;
};

export class BlockReader {
  private sink: BlockSink;
  private line = "";        // the current line so far (a part of it, until its newline)
  private cls: Cls | null = null;   // what the current line is, once decided
  private pre = 0;          // the length of the line's marker, which is not text
  private fed = 0;          // how much of the line's text the sink has had
  private open = false;     // a paragraph is open (a heading or an item ends with its line)
  private fence: { ch: string; len: number } | null = null;
  private prevBlank = true;
  private prevCode = false;
  private inList = false;

  constructor(sink: BlockSink) { this.sink = sink; }

  push(s: string): void {
    let at = 0;
    for (;;) {
      const nl = s.indexOf("\n", at);
      if (nl < 0) break;
      this.line += s.slice(at, nl);
      this.complete();
      at = nl + 1;
    }
    this.line += s.slice(at);
    this.partial();
  }

  /** The end of the text: the line in progress is a whole line, and an open paragraph ends. */
  finish(): void {
    if (this.line || this.cls) this.complete();
    this.endOpen();
  }

  private endOpen() {
    if (this.open) { this.open = false; this.sink.end(); }
  }

  private classify(complete: boolean): Cls | null {
    let rest = this.line;
    let pre = 0;
    for (let m: RegExpExecArray | null; (m = /^ {0,3}> ?/.exec(rest)); ) { pre += m[0].length; rest = rest.slice(m[0].length); }
    if (!complete) {
      if (MARKER_ONLY.test(rest)) return null;
      if (/^\s*(?:`{3,}|~{3,})/.test(rest)) return null; // a fence is judged by its whole line
    }
    if (rest.trim() === "") return { k: "blank" };
    const indent = indentOf(rest);
    const f = FENCE.exec(rest);
    if (f && (indent < 4 || this.inList) && !(f[2][0] === "`" && f[3].includes("`"))) return { k: "fence", ch: f[2][0], len: f[2].length };
    if (/^ {0,3}(?:([-*_])(?:\s*\1){2,}|=+)\s*$/.test(rest)) return { k: "hr" };
    if (rest.includes("|") && SEPARATOR.test(rest)) return { k: "sep" };
    const h = /^ {0,3}#{1,6}(?:[ \t]+|$)/.exec(rest);
    if (h) return { k: "h", pre: pre + h[0].length };
    if (/^\s*\|/.test(rest)) return { k: "row" };
    const li = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?: +|$)/.exec(rest);
    if (li && (indent < 4 || this.inList)) return { k: "li", pre: pre + li[0].length };
    if (indent >= 4 && (this.prevBlank || this.prevCode) && !this.inList) return { k: "ind" };
    return { k: "p", pre: pre + (/^\s*/.exec(rest)![0].length) };
  }

  /** The line's first characters are in: decide what it is, and open or close units for it. */
  private decide(c: Cls) {
    this.cls = c;
    this.fed = 0;
    this.pre = "pre" in c ? c.pre : 0;
    if (c.k === "p") return;
    this.endOpen();
    if (c.k === "h" || c.k === "li") this.open = true;
    else if (c.k === "fence") this.fence = { ch: c.ch, len: c.len };
  }

  private feed(final: boolean) {
    const c = this.cls;
    if (!c || (c.k !== "p" && c.k !== "h" && c.k !== "li")) return;
    const text = this.line.slice(this.pre + this.fed);
    this.fed += text.length;
    if (c.k === "p") this.open = true;
    if (text) this.sink.text(c.k, text);
    if (!final) return;
    if (c.k === "p") this.sink.text("p", " ");
    else this.endOpen();
  }

  private partial() {
    if (this.fence) return;
    if (!this.cls) {
      const c = this.line ? this.classify(false) : null;
      if (c) this.decide(c);
    }
    this.feed(false);
  }

  private complete() {
    const line = this.line;
    if (this.fence) {
      this.completeFenced(line);
      this.line = "";
      this.cls = null;
      return;
    }
    if (!this.cls) this.decide(this.classify(true)!);
    this.feed(true);
    const c = this.cls!;
    if (c.k === "row") { this.sink.whole("row", line.trim()); this.prevBlank = false; }
    else if (c.k === "ind") this.sink.whole("code", line.replace(/^(?: {4}|\t)/, "").trimEnd());
    this.prevBlank = c.k === "blank";
    this.prevCode = c.k === "ind";
    if (c.k === "li") this.inList = true;
    else if (c.k === "h" || c.k === "hr" || c.k === "row" || (c.k === "p" && indentOf(line) < 2)) this.inList = false;
    this.line = "";
    this.cls = null;
  }

  private completeFenced(line: string) {
    const t = line.trim();
    const f = this.fence!;
    if (new RegExp(`^${f.ch === "`" ? "`" : "~"}{${f.len},}$`).test(t)) { this.fence = null; this.prevBlank = false; return; }
    if (t) this.sink.whole("code", line.trimEnd());
  }
}

// ---- the inline cleaner

/**
 * The code span that opens at `i`: where it ends and what it holds, `null` when it does not close within `LOOKAHEAD` (the
 * backticks are plain text then), or `"wait"` when more text could still decide it (`final` is off). Shared by the cleaner and the
 * splitter, so both read the same spans.
 */
export function codeSpanAt(s: string, i: number, final = true): { end: number; from: number; to: number } | "wait" | null {
  let L = 1;
  while (s[i + L] === "`") L++;
  if (!final && i + L >= s.length) return "wait";
  const limit = Math.min(s.length, i + LOOKAHEAD);
  for (let j = i + L; j < limit; ) {
    if (s[j] !== "`") { j++; continue; }
    let r = 1;
    while (s[j + r] === "`") r++;
    if (!final && j + r >= s.length) return "wait";
    if (r === L) return { end: j + r, from: i + L, to: j };
    j += r;
  }
  return !final && s.length < i + LOOKAHEAD ? "wait" : null;
}

const PLACE = "\u0000";

/** Emphasis, strike and stray markers out of a text that holds no code spans (they are placeholders by now). */
function dropMarks(s: string): string {
  s = s.replace(/(\*{1,3})(?=\S)(.+?)(?<=\S)\1/g, "$2");
  s = s.replace(/(?<![\w])(_{1,3})(?=\S)(.+?)(?<=\S)\1(?![\w])/g, "$2");
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1");
  // What is left is a mark whose other half was cut away (a sentence cut inside `**bold. text**`) or a lone star.
  s = s.replace(/\*{1,3}(?=\S)|(?<=\S)\*{1,3}/g, "").replace(/(?<![\w])_{2,}|_{2,}(?![\w])/g, "").replace(/~~/g, "");
  return s;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " " };

/** One unit's raw Markdown text as the words to say. Empty when there is nothing to say. */
export function cleanInline(raw: string, kind: "p" | "h" | "li" = "p"): string {
  let s = raw.replace(/\u0000/g, "").replace(/\s+/g, " ");
  if (kind === "li") s = s.replace(/^\s*\[[ xX]\]\s+/, "");
  if (kind === "h") s = s.replace(/\s+#+\s*$/, "");
  // Code spans and reference tags are said as they are: lift them out so nothing below touches them.
  const kept: string[] = [];
  const keep = (t: string) => { kept.push(t); return PLACE + (kept.length - 1) + PLACE; };
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] === "`") {
      const c = codeSpanAt(s, i);
      if (c && c !== "wait") {
        let body = s.slice(c.from, c.to);
        if (/^ .*\S.* $/.test(body)) body = body.slice(1, -1);
        out += keep(body);
        i = c.end;
        continue;
      }
      while (s[i] === "`") { out += "`"; i++; }
      continue;
    }
    out += s[i++];
  }
  s = out.replace(new RegExp(REF_SRC, "g"), (tag) => keep(parseRef(tag)?.label ?? ""));
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/!\[[^\]]*\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, " ");
  s = s.replace(/\[\^[^\]]*\]/g, "");
  s = s.replace(/\[((?:[^\][]|\[[^\]]*\])*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, "$1");
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, " ");
  s = s.replace(/(?:https?:\/\/|www\.)[^\s<>]+/g, (u) => /[.,;:!?)\]"'”’*_]+$/.exec(u)?.[0] ?? "");
  s = dropMarks(s);
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[Number(n)]);
  s = s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (e) => ENTITIES[e]);
  return s.replace(/\s+/g, " ").replace(/\s+([.,;:!?…]+)(?=\s|$)/g, "$1").replace(/\s+([)\]}])/g, "$1").trim();
}

/** A table row as one text: its cells, said one after the other. */
export function cleanRow(line: string): string {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => cleanInline(c)).filter(Boolean).join(", ");
}

/** The unit ends a sentence: a full stop is added to a heading, an item or a row that has none, so the voice pauses. */
export function addPeriod(s: string): string {
  if (!s) return s;
  const core = s.replace(/["'”’)\]}»*_~]+$/, "");
  return /[.!?…。！？:;,]$/.test(core) ? s : s + ".";
}

/** The words of one finished unit. */
export function cleanUnit(kind: UnitKind, raw: string): string {
  if (kind === "code") return raw.trim();
  const s = kind === "row" ? cleanRow(raw) : cleanInline(raw, kind);
  return kind === "p" ? s : addPeriod(s);
}

/**
 * A whole block or message as the words to say, one line per paragraph, heading, list item, table row (and line of code when
 * `skipCode` is off). Fenced and indented code is left out when `skipCode` is on.
 */
export function speechText(markdown: string, o: { skipCode: boolean }): string {
  const lines: string[] = [];
  let kind: "p" | "h" | "li" = "p";
  let acc = "";
  const add = (s: string) => { if (s) lines.push(s); };
  const reader = new BlockReader({
    text(k, piece) { kind = k; acc += piece; },
    end() { add(cleanUnit(kind, acc)); acc = ""; },
    whole(k, line) { if (k === "row" || !o.skipCode) add(cleanUnit(k, line)); },
  });
  reader.push(markdown);
  reader.finish();
  return lines.join("\n");
}
