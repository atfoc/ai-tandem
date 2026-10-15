// The displayed text of a message (screens/markdown/displayed.ts) is what the old page's quoteDom.ts reads from the page's DOM today:
// the text nodes of the message's .md in order, without the code blocks' headers. The page's pipeline is run here as
// Markdown.tsx builds it (react-markdown with remark-gfm and, for a user, remark-breaks; the rehype plugin of core that makes
// chips and mentions; the page's components for code blocks, links, images and chips), rendered to HTML, and the text nodes
// of that HTML are taken as quoteDom's textNodes() takes them. They must equal messageText() for the fixtures of
// packages/core/test/quotes.test.ts (the blocks that give the text its test uses) and for a corpus of messages of every kind
// of block and inline the page draws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { parseRef, selectionRef, pointRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { rehypeSlots, splitBlocks, stashRefs, trimPartialRef } from "@aiwb/core/logic/markdown.ts";
import { findQuote } from "@aiwb/core/logic/quotes.ts";
import { messageText } from "../src/screens/markdown/displayed.ts";
import { CORPUS } from "../src/dev/markdownfixtures.ts";

const langOf = (node: any): string => {
  const cls = node?.children?.[0]?.properties?.className;
  const l = (Array.isArray(cls) ? cls : []).map(String).find((c: string) => c.startsWith("language-"));
  return l ? l.slice("language-".length) : "";
};

// Markdown.tsx's COMPONENTS, with the chip's and the mention's DOM as their text nodes make it (RefChip: the label; Mention: @name)
const COMPONENTS: Components = {
  pre: ({ node, children }) => h("div", { className: "md-code" }, h("div", { className: "md-code-head" }, h("span", null, langOf(node)), h("button", null, "Copy")), h("pre", null, children)),
  a: ({ node, href, children, ...p }) => (href ? h("a", { ...p, href }, children) : h("span", null, children)),
  img: ({ src, alt }) => (typeof src === "string" && src ? h("a", { href: src }, alt || src) : h("span", null, alt)),
  span: ({ node, ...p }) => {
    const d = p as Record<string, unknown>;
    if (typeof d["data-ref"] === "string") {
      const r = parseRef(d["data-ref"]);
      const chip = r ? h("button", { className: "ref-chip" }, r.label) : d["data-ref"];
      return p.children ? h("span", { className: "nowrap" }, chip, p.children as ReactNode) : chip;
    }
    if (typeof d["data-mention"] === "string") return h("span", null, d["data-mention"]);
    return h("span", p as object);
  },
};

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'" };

/** quoteDom.ts textNodes(): the text nodes of the message, those inside a code block's header left out. */
function textOfHtml(html: string): string {
  return html.replace(/<div class="md-code-head">.*?<\/div>/gs, "").replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#x27);/g, (m) => ENTITIES[m]);
}

/** The text the page's DOM shows of a message: its blocks one after the other (Markdown.tsx). */
function pageText(text: string, user = false, streaming = false): string {
  return splitBlocks(streaming ? trimPartialRef(text) : text).map((block) => {
    const s = stashRefs(block);
    const html = renderToStaticMarkup(h(ReactMarkdown, {
      remarkPlugins: user ? [remarkGfm, remarkBreaks] : [remarkGfm],
      rehypePlugins: [rehypeSlots({ refs: s.refs, mentions: user })],
      components: COMPONENTS,
      children: s.text,
    }));
    return textOfHtml(html);
  }).join("");
}

const same = (text: string, user = false) => assert.equal(messageText(text, user), pageText(text, user), JSON.stringify(text));

test("the fixtures of quotes.test.ts: a message of three blocks has its blocks' texts joined with nothing between", () => {
  const md = "# The plan\n\nOwn undo in the ShapeStore.\n\nRetry 3 times with backoff.";
  assert.equal(messageText(md), "The planOwn undo in the ShapeStore.Retry 3 times with backoff.");
  same(md);
  // the quotes of that test are found in it, at the positions it stores
  const text = messageText(md), start = text.indexOf("ShapeStore"), end = text.indexOf(" times");
  assert.deepEqual(findQuote(text, { quote: "ShapeStore", start, end: start + 10 }), { start, end: start + 10, how: "exact" });
  assert.equal(findQuote(text, { quote: "ShapeStore.\n\nRetry 3", start, end }).how, "exact");
  assert.equal(findQuote(text, { quote: "with backoff", start: 3, end: 15 }).how, "search");
});


for (const [name, md] of CORPUS) {
  test(`displayed text equals the page's DOM text: ${name}`, () => {
    same(md);
    same(md, true);
  });
}

test("displayed text equals the page's DOM text: reference tags and mentions", () => {
  const sel = serializeRef(selectionRef([{ id: "r1", type: "rectangle", label: "API", x: 0, y: 0, width: 5, height: 5 }])!);
  const point = serializeRef(pointRef(5, 7));
  for (const md of [
    `see ${sel}, and ${point}. Then ${sel}!`,
    `- ${sel}\n- ${point})`,
    `\`${sel}\` and [${sel}](https://x.y) and\n\n\`\`\`\n${sel}\n\`\`\``,
    `@board and @a-b. and me@example.com and \`@code\` and [@link](/x)`,
    `**${sel}** in strong`,
    `<${"selection"} not a tag`,
  ]) { same(md); same(md, true); }
});

test("displayed text equals the page's DOM text: a streaming message loses the reference tag being written", () => {
  for (const md of [`Look at <selection ids="a1" lab`, `Look at <selection ids="a1" label="x">y`, `Look at <poi`, `a <b`, `done <point x="1" y="2" label="(1, 2)"/>`]) {
    assert.equal(messageText(md, false, true), pageText(md, false, true), md);
  }
  assert.equal(messageText(`Look at <selection ids="a1" lab`, false, true), "Look at");
});
