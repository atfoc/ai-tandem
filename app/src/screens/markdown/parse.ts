// Parsing a message's Markdown (AD-75): remark, as the page does today (react-markdown's remark half): CommonMark and GFM
// (tables, task lists, strikethrough, autolinks, footnotes) to mdast; in a user's message single line breaks are kept
// (remark-breaks) and so are its lines' indents (indent.ts). Raw HTML stays in the tree as `html` nodes, which doc.ts shows
// as text. No React and no react-native here, so Node loads it.
//
// A message is cut into top-level blocks (core splitBlocks) and each block is parsed on its own, once: `prepare` keeps the
// trees of the blocks it has seen (a bounded cache), so a growing answer parses only its last block again, and a
// thread that scrolls a message out and back in does not parse it again (goal 4.8).
import type { Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { splitBlocks, stashRefs, trimPartialRef } from "@aiwb/core/logic/markdown.ts";

import { lower, type Doc } from "./doc.ts";
import { keepIndent, noIndentedCode } from "./indent.ts";

const plain = unified().use(remarkParse).use(remarkGfm).freeze();
// (a user's indented lines are shown as typed: no indented code, and the indent of a paragraph's lines kept; indent.ts)
const user = unified().use(remarkParse).use(remarkGfm).use(noIndentedCode).use(keepIndent).use(remarkBreaks).freeze();

/** The mdast of a text (one block of a message, or any Markdown). */
export function parse(text: string, forUser = false): Root {
  const p = forUser ? user : plain;
  return p.runSync(p.parse(text), text) as Root;
}

/** The blocks a message is drawn in: a reference tag still being written at its end is left out while the agent streams. */
export const blocksOf = (text: string, streaming = false): string[] => splitBlocks(streaming ? trimPartialRef(text ?? "") : text ?? "");

/** Counts, for the tests and the gallery's readout: how many blocks were parsed, and how many block components rendered. */
export const stats = { parses: 0, renders: 0 };

const CACHE = 400;
const seen = new Map<string, Doc>();

/** The tree to draw for one block of a message (see blocksOf); the same object for the same text, while it is kept. */
export function prepare(block: string, forUser = false): Doc {
  const key = (forUser ? "u" : "a") + block;
  const hit = seen.get(key);
  if (hit) { seen.delete(key); seen.set(key, hit); return hit; }
  stats.parses++;
  const stashed = stashRefs(block);
  const doc = lower(parse(stashed.text, forUser), stashed.refs, forUser);
  seen.set(key, doc);
  if (seen.size > CACHE) seen.delete(seen.keys().next().value as string);
  return doc;
}

/** Forgets every kept tree (tests). */
export const forget = () => seen.clear();
