// A message's Markdown as a tree to draw (AD-75): mdast (remark, parse.ts) lowered the way the page's react-markdown
// does it (mdast-util-to-hast, then the page's components), so that what is shown, and the text the quotes count in
// (displayed.ts), are the same as today's. No React and no react-native here, so Node loads it.
//
// What the page does and this does the same:
//   - raw HTML is text, never run (`html` nodes are their source as text);
//   - a link or an image with an unsafe protocol is dropped (react-markdown's urlTransform); a link with no address is
//     its text; an image is a link showing its alt text, else its address, and nothing is fetched;
//   - reference tags (core logic/markdown.ts stashRefs) are chips where they stand, and in a user's message an @name is
//     a mention; inside code and links both stay text (core slotText);
//   - the "\n" text nodes mdast-util-to-hast puts between blocks, and around the items of a list or a quote, are kept as
//     `nl` blocks: they are part of the text a quote counts in, and the drawing skips them.
import type { Definition, FootnoteDefinition, PhrasingContent, Root, RootContent, TableCell } from "mdast";
import { normalizeUri } from "micromark-util-sanitize-uri";

import { parseRef, type Ref } from "@aiwb/core/logic/refs.ts";
import { slotText, unstash } from "@aiwb/core/logic/markdown.ts";

export type Inline =
  | { k: "text"; v: string }
  | { k: "br" }
  | { k: "em" | "strong" | "del" | "sup"; kids: Inline[] }
  | { k: "code"; v: string }
  /** href is a safe address, or "#…" (a footnote, which opens nothing). */
  | { k: "link"; href: string; kids: Inline[] }
  /** A reference tag where it stands; `after` is the punctuation right after it, which goes with it. */
  | { k: "chip"; tag: string; ref: Ref; after: string }
  | { k: "mention"; raw: string }
  | { k: "check"; checked: boolean };

export type Cell = { kids: Inline[] };

export type Block =
  /** tight: a paragraph of a tight list item (no space under it of its own). */
  | { k: "p"; kids: Inline[]; tight?: boolean }
  | { k: "h"; depth: number; kids: Inline[] }
  | { k: "hr" }
  | { k: "quote"; kids: Block[] }
  | { k: "list"; ordered: boolean; start: number; task: boolean; kids: Block[] }
  | { k: "li"; task: boolean; kids: Block[] }
  /** text is the code with the "\n" that ends it (as the page's <pre> has), "" for no code. */
  | { k: "code"; lang: string; text: string }
  | { k: "table"; align: (string | null)[]; head: Cell[]; rows: Cell[][] }
  /** The footnotes at the end of a message. */
  | { k: "group"; kids: Block[] }
  | { k: "nl" };

export type Doc = { kids: Block[] };

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/** react-markdown's defaultUrlTransform: an address that is relative or has a safe protocol, else "". */
export function safeUrl(value: string): string {
  const colon = value.indexOf(":"), question = value.indexOf("?"), number = value.indexOf("#"), slash = value.indexOf("/");
  if (colon === -1 || (slash !== -1 && colon > slash) || (question !== -1 && colon > question) || (number !== -1 && colon > number)
    || SAFE_PROTOCOL.test(value.slice(0, colon))) return value;
  return "";
}

const urlOf = (url: string | null | undefined) => safeUrl(normalizeUri(url ?? ""));

/** trim-lines: the spaces and tabs at the ends of each line of a text go (not its first line's start, nor its last line's end). */
export function trimLines(value: string): string {
  const lines = value.split(/(\r?\n|\r)/);
  return lines.map((l, i) => {
    if (i % 2) return l;
    const last = i === lines.length - 1;
    let a = 0, b = l.length;
    if (i > 0) while (a < b && (l[a] === " " || l[a] === "\t")) a++;
    if (!last) while (b > a && (l[b - 1] === " " || l[b - 1] === "\t")) b--;
    return l.slice(a, b);
  }).join("");
}

type Ctx = {
  refs: string[];
  mentions: boolean;
  definitions: Map<string, Definition>;
  footnotes: Map<string, FootnoteDefinition>;
  /** The footnotes referred to, in order of their first reference, and how many references each has. */
  order: string[];
  counts: Map<string, number>;
};

const NL: Block = { k: "nl" };
const id = (identifier: string) => String(identifier).toUpperCase();

/** mdast-util-to-hast's state.wrap: "\n" between the nodes, and around them when `loose`. */
function wrap(blocks: Block[], loose = false): Block[] {
  const out: Block[] = loose ? [NL] : [];
  blocks.forEach((b, i) => { if (i) out.push(NL); out.push(b); });
  if (loose && blocks.length) out.push(NL);
  return out;
}

/** The text of a text node as pieces: plain text, chips and mentions (core slotText), or, inside code and links, the text
 *  with its tags back. */
function textPieces(value: string, ctx: Ctx, skip: boolean): Inline[] {
  const v = trimLines(value);
  if (skip) return v ? [{ k: "text", v: unstash(v, ctx.refs) }] : [];
  const out: Inline[] = [];
  for (const n of slotText(v, ctx.refs, ctx.mentions)) {
    const props = n.properties ?? {};
    if (typeof props.dataRef === "string") {
      const ref = parseRef(props.dataRef);
      const after = (n.children ?? []).map((c) => c.value ?? "").join("");
      if (ref) out.push({ k: "chip", tag: props.dataRef, ref, after });
      else out.push({ k: "text", v: props.dataRef + after });
    } else if (typeof props.dataMention === "string") out.push({ k: "mention", raw: props.dataMention });
    else if (n.value) out.push({ k: "text", v: n.value });
  }
  return out;
}

const spaceStart = (s: string) => s.replace(/^[ \t]+/, "");

/** An inline without the white space at the start of its text (or of the text it starts with). */
function trimHead(n: Inline): Inline {
  if (n.k === "text") return { k: "text", v: spaceStart(n.v) };
  if ((n.k === "em" || n.k === "strong" || n.k === "del" || n.k === "link") && n.kids[0]?.k === "text") return { ...n, kids: [trimHead(n.kids[0]), ...n.kids.slice(1)] };
  if (n.k === "code") return { k: "code", v: spaceStart(n.v) };
  return n;
}

/** The inline content of a node. */
function inlines(nodes: PhrasingContent[], ctx: Ctx, skip: boolean): Inline[] {
  const out: Inline[] = [];
  nodes.forEach((n, i) => {
    const got = inline(n, ctx, skip);
    // after a hard break the next text loses its leading white space
    if (i && nodes[i - 1].type === "break" && got.length) got[0] = trimHead(got[0]);
    out.push(...got);
  });
  return out;
}

function inline(n: PhrasingContent, ctx: Ctx, skip: boolean): Inline[] {
  switch (n.type) {
    case "text": return textPieces(n.value, ctx, skip);
    case "break": return [{ k: "br" }];
    case "emphasis": return [{ k: "em", kids: inlines(n.children, ctx, skip) }];
    case "strong": return [{ k: "strong", kids: inlines(n.children, ctx, skip) }];
    case "delete": return [{ k: "del", kids: inlines(n.children, ctx, skip) }];
    case "inlineCode": return [{ k: "code", v: unstash(n.value.replace(/\r?\n|\r/g, " "), ctx.refs) }];
    case "link": return link(urlOf(n.url), inlines(n.children, ctx, true));
    case "image": return image(urlOf(n.url), n.alt);
    case "linkReference": {
      const def = ctx.definitions.get(id(n.identifier));
      if (def) return link(urlOf(def.url), inlines(n.children, ctx, true));
      return revert(n.referenceType, n.label ?? n.identifier, inlines(n.children, ctx, skip), "[");
    }
    case "imageReference": {
      const def = ctx.definitions.get(id(n.identifier));
      if (def) return image(urlOf(def.url), n.alt);
      const suffix = n.referenceType === "collapsed" ? "][]" : n.referenceType === "full" ? `][${n.label || n.identifier}]` : "]";
      return [{ k: "text", v: `![${n.alt ?? ""}${suffix}` }];
    }
    case "footnoteReference": {
      const key = id(n.identifier);
      let counter = ctx.order.indexOf(key) + 1;
      if (!counter) { ctx.order.push(key); counter = ctx.order.length; }
      ctx.counts.set(key, (ctx.counts.get(key) ?? 0) + 1);
      return [{ k: "sup", kids: [{ k: "link", href: "#" + normalizeUri(key.toLowerCase()), kids: [{ k: "text", v: String(counter) }] }] }];
    }
    case "html": return n.value ? [{ k: "text", v: unstash(n.value, ctx.refs) }] : [];
    default: return [];
  }
}

const link = (href: string, kids: Inline[]): Inline[] => (href ? [{ k: "link", href, kids }] : kids);

/** The page's `img` component: a link showing the alt text, else the address; with no address, the alt text. */
function image(src: string, alt: string | null | undefined): Inline[] {
  if (src) return [{ k: "link", href: src, kids: [{ k: "text", v: alt || src }] }];
  return alt ? [{ k: "text", v: alt }] : [];
}

/** A reference to a definition there is none of is its source as text: `[label]`, `[label][]`, `[label][ref]`. */
function revert(type: string, label: string, kids: Inline[], open: string): Inline[] {
  const suffix = type === "collapsed" ? "][]" : type === "full" ? `][${label}]` : "]";
  return [{ k: "text", v: open }, ...kids, { k: "text", v: suffix }];
}

const listLoose = (node: { spread?: boolean | null; children: { spread?: boolean | null; children: unknown[] }[] }) =>
  !!node.spread || node.children.some((c) => (c.spread === null || c.spread === undefined ? c.children.length > 1 : c.spread));

function cells(row: { children: TableCell[] }, length: number, ctx: Ctx): Cell[] {
  return Array.from({ length }, (_, i) => ({ kids: row.children[i] ? inlines(row.children[i].children as PhrasingContent[], ctx, false) : [] }));
}

/** The blocks of the nodes, with nothing between them (the caller wraps). */
function blocks(nodes: RootContent[], ctx: Ctx, parent?: { loose: boolean }): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case "paragraph": out.push({ k: "p", kids: inlines(n.children, ctx, false), tight: parent ? !parent.loose : undefined }); break;
      case "heading": out.push({ k: "h", depth: n.depth, kids: inlines(n.children, ctx, false) }); break;
      case "thematicBreak": out.push({ k: "hr" }); break;
      case "blockquote": out.push({ k: "quote", kids: wrap(blocks(n.children, ctx), true) }); break;
      case "code": out.push({ k: "code", lang: n.lang ? n.lang.split(/\s+/)[0] : "", text: n.value ? unstash(n.value, ctx.refs) + "\n" : "" }); break;
      case "html": out.push({ k: "p", kids: n.value ? [{ k: "text", v: unstash(n.value, ctx.refs) }] : [] }); break;
      case "list": {
        const loose = listLoose(n);
        const items = n.children.map((li): Block => {
          const kids = blocks(li.children, ctx, { loose });
          if (typeof li.checked === "boolean") {
            // the checkbox goes into the first paragraph, with a space after it when the paragraph holds anything
            let head = kids[0];
            if (!head || head.k !== "p") { head = { k: "p", kids: [], tight: !loose }; kids.unshift(head); }
            head.kids = [{ k: "check", checked: li.checked }, ...(head.kids.length ? [{ k: "text", v: " " } as Inline] : []), ...head.kids];
          }
          const flow: Block[] = [];
          kids.forEach((c, i) => {
            // an "\n" before every child, except a tight list's first paragraph; a last "\n" after any child but a tight paragraph
            if (loose || i !== 0 || c.k !== "p") flow.push(NL);
            flow.push(c);
          });
          const tail = kids[kids.length - 1];
          if (tail && (loose || tail.k !== "p")) flow.push(NL);
          return { k: "li", task: typeof li.checked === "boolean", kids: flow };
        });
        out.push({ k: "list", ordered: !!n.ordered, start: typeof n.start === "number" ? n.start : 1, task: items.some((i) => i.k === "li" && i.task), kids: wrap(items, true) });
        break;
      }
      case "table": {
        const length = n.align?.length ?? n.children[0]?.children.length ?? 0;
        const [head, ...rows] = n.children;
        out.push({ k: "table", align: n.align ?? [], head: head ? cells(head, length, ctx) : [], rows: rows.map((r) => cells(r, length, ctx)) });
        break;
      }
      case "definition":
      case "footnoteDefinition":
      case "yaml":
        break;
      default: break;
    }
  }
  return out;
}

function collect(nodes: RootContent[], defs: Map<string, Definition>, notes: Map<string, FootnoteDefinition>) {
  for (const n of nodes) {
    if (n.type === "definition") { if (!defs.has(id(n.identifier))) defs.set(id(n.identifier), n); continue; }
    if (n.type === "footnoteDefinition") { if (!notes.has(id(n.identifier))) notes.set(id(n.identifier), n); }
    if ("children" in n && Array.isArray(n.children)) collect(n.children as RootContent[], defs, notes);
  }
}

/** The footnotes the message refers to, as the page draws them: a "Footnotes" heading, and the notes in a numbered list,
 *  each ending with a back link "↩". */
function footer(ctx: Ctx): Block | null {
  const items: Block[] = [];
  for (const key of ctx.order) {
    const def = ctx.footnotes.get(key);
    if (!def) continue;
    const content = blocks(def.children, ctx);
    const back: Inline[] = [];
    for (let i = 1; i <= (ctx.counts.get(key) ?? 0); i++) {
      if (back.length) back.push({ k: "text", v: " " });
      back.push({ k: "link", href: "#" + normalizeUri(key.toLowerCase()), kids: [{ k: "text", v: "↩" }, ...(i > 1 ? [{ k: "sup", kids: [{ k: "text", v: String(i) }] } as Inline] : [])] });
    }
    const tail = content[content.length - 1];
    if (tail && tail.k === "p") { const last = tail.kids[tail.kids.length - 1]; if (last?.k === "text") last.v += " "; else tail.kids.push({ k: "text", v: " " }); tail.kids.push(...back); }
    else content.push({ k: "p", kids: back });
    items.push({ k: "li", task: false, kids: wrap(content, true) });
  }
  if (!items.length) return null;
  return { k: "group", kids: [{ k: "h", depth: 2, kids: [{ k: "text", v: "Footnotes" }] }, NL, { k: "list", ordered: true, start: 1, task: false, kids: wrap(items, true) }, NL] };
}

/** The tree to draw for a parsed block of a message. refs: its stashed reference tags (stashRefs), mentions: whether an @name
 *  is a mention (a user's message). */
export function lower(root: Root, refs: string[] = [], mentions = false): Doc {
  const definitions = new Map<string, Definition>(), footnotes = new Map<string, FootnoteDefinition>();
  collect(root.children, definitions, footnotes);
  const ctx: Ctx = { refs, mentions, definitions, footnotes, order: [], counts: new Map() };
  const kids = wrap(blocks(root.children, ctx));
  const notes = footer(ctx);
  if (notes) kids.push(NL, notes);
  return { kids };
}
