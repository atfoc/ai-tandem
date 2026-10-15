// The DOM-free half of the thread's Markdown (ChatView.tsx renders it with
// react-markdown):
//
// - splitBlocks cuts a message into top-level blocks, so a streaming message
//   only re-parses its last block; the ones before it keep their text and are
//   not rendered again.
// - stashRefs swaps each reference tag (logic/refs.ts) for a placeholder that
//   Markdown leaves alone, and rehypeSlots turns the placeholders, and a user's
//   @mentions, into slots the renderer draws as chips and mention links.

import { REF_SRC, parseRef } from "./refs.ts";

const FENCE = /^\s*(`{3,}|~{3,})/;
// [label]: url and [^note]: text are read from anywhere in the message: never split then.
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:/m;

/**
 * The message's top-level blocks, split at blank lines. A blank line splits only
 * outside a fenced code block and when the next line is not indented (an
 * indented line continues a list item or an indented code block).
 */
export function splitBlocks(text: string): string[] {
  if (DEFINITION.test(text)) return text.trim() ? [text] : [];
  const lines = text.split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  let fence = "";
  let blank = false;
  const flush = () => { if (cur.some((l) => l.trim())) out.push(cur.join("\n")); cur = []; };
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (fence) {
      cur.push(l);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !l.trim().slice(f[1].length).trim()) fence = "";
      continue;
    }
    if (!l.trim()) { blank = true; cur.push(l); continue; }
    if (blank && !/^\s/.test(l)) {
      while (cur.length && !cur[cur.length - 1].trim()) cur.pop();
      flush();
    }
    blank = false;
    cur.push(l);
    if (f) fence = f[1];
  }
  flush();
  return out;
}

// Private-use characters: never typed, and plain text to Markdown.
const OPEN = "", CLOSE = "";
const SLOT_RE = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const REF_RE = new RegExp(REF_SRC, "g");

/** The text with every reference tag replaced by a placeholder, and the tags in order. */
export function stashRefs(text: string): { text: string; refs: string[] } {
  const refs: string[] = [];
  const out = text.replace(REF_RE, (tag) => {
    if (!parseRef(tag)) return tag;
    refs.push(tag);
    return `${OPEN}${refs.length - 1}${CLOSE}`;
  });
  return { text: out, refs };
}

/** The text with its placeholders back as the tags (code shows them as typed). */
export const unstash = (text: string, refs: string[]) => text.replace(SLOT_RE, (m, i) => refs[Number(i)] ?? m);

/**
 * The text without a reference tag still being written at its end (while the
 * agent streams, `<selection ids="a1" lab…` would show as raw text until it closes).
 */
export function trimPartialRef(text: string): string {
  const m = /<([a-z]*)(\s[^<>]*(>[^<]*(<\/[a-z]*)?)?)?$/.exec(text);
  if (!m || parseRef(text.slice(m.index))) return text;
  const name = m[1], more = m[2] !== undefined;
  const partial = more ? name === "selection" || name === "point" : ["selection", "point"].some((t) => t.startsWith(name));
  return partial ? text.slice(0, m.index) : text;
}

// Just enough of hast (the HTML syntax tree react-markdown renders) for this file.
type HNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HNode[] };

const MENTION = /@[\w.\-]+/g;
const SKIP = new Set(["code", "pre", "a"]);

/**
 * A text's pieces: plain text, a reference slot (`data-ref` = the tag, holding the
 * punctuation right after it) or a mention slot (`data-mention` = @name).
 */
export function slotText(value: string, refs: string[], mentions: boolean): HNode[] {
  const out: HNode[] = [];
  const text = (s: string) => {
    if (!mentions) { if (s) out.push({ type: "text", value: s }); return; }
    let at = 0;
    for (const m of s.matchAll(MENTION)) {
      // an @ inside a word (an e-mail) is not a mention
      if (m.index! > 0 && /[\w.\-]/.test(s[m.index! - 1])) continue;
      if (m.index! > at) out.push({ type: "text", value: s.slice(at, m.index) });
      out.push({ type: "element", tagName: "span", properties: { dataMention: m[0] }, children: [{ type: "text", value: m[0] }] });
      at = m.index! + m[0].length;
    }
    if (at < s.length) out.push({ type: "text", value: s.slice(at) });
  };
  let at = 0;
  for (const m of value.matchAll(SLOT_RE)) {
    const tag = refs[Number(m[1])];
    if (tag === undefined) continue;
    text(value.slice(at, m.index));
    at = m.index! + m[0].length;
    // punctuation right after the chip goes with it, so a line never starts with it
    const p = /^[.,;:!?)]+/.exec(value.slice(at))?.[0] ?? "";
    out.push({ type: "element", tagName: "span", properties: { dataRef: tag }, children: p ? [{ type: "text", value: p }] : [] });
    at += p.length;
  }
  text(value.slice(at));
  return out;
}

/**
 * A rehype plugin: the placeholders from stashRefs become reference slots, and
 * with `mentions` each @name becomes a mention slot. Inside code and links the
 * tags come back as text and mentions stay text.
 */
export function rehypeSlots(opts: { refs: string[]; mentions?: boolean }) {
  const walk = (n: HNode, skip: boolean) => {
    if (!n.children) return;
    const kids: HNode[] = [];
    for (const c of n.children) {
      if (c.type === "text" && typeof c.value === "string") {
        if (skip) kids.push({ ...c, value: unstash(c.value, opts.refs) });
        else kids.push(...slotText(c.value, opts.refs, !!opts.mentions));
        continue;
      }
      walk(c, skip || (c.type === "element" && SKIP.has(c.tagName ?? "")));
      kids.push(c);
    }
    n.children = kids;
  };
  return () => (tree: HNode) => { walk(tree, false); };
}
