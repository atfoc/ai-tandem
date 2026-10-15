import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBlocks, stashRefs, unstash, slotText, rehypeSlots, trimPartialRef } from "../src/logic/markdown.ts";

test("blocks split at blank lines", () => {
  assert.deepEqual(splitBlocks("# Title\n\nOne\ntwo\n\n\n- a\n- b\n"), ["# Title", "One\ntwo", "- a\n- b\n"]);
  assert.deepEqual(splitBlocks(""), []);
  assert.deepEqual(splitBlocks("\n\n  \n"), []);
});

test("fenced code keeps its blank lines", () => {
  const code = "```go\nfunc a() {}\n\nfunc b() {}\n```";
  assert.deepEqual(splitBlocks(`Before\n\n${code}\n\nAfter`), ["Before", code, "After"]);
  const tilde = "~~~\n```\n\nstill code\n~~~";
  assert.deepEqual(splitBlocks(`${tilde}\n\nout`), [tilde, "out"]);
  // a closing fence must be at least as long as the opening one
  const long = "````\n```\n\nin\n````";
  assert.deepEqual(splitBlocks(long), [long]);
});

test("an unclosed fence (still streaming) runs to the end", () => {
  assert.deepEqual(splitBlocks("Look:\n\n```ts\nconst a = 1;\n\nconst b"), ["Look:", "```ts\nconst a = 1;\n\nconst b"]);
});

test("indented lines after a blank line stay with their list item", () => {
  const list = "1. one\n\n   more of one\n\n   ```sh\n   ls\n   ```\n2. two";
  assert.deepEqual(splitBlocks(`${list}\n\nafter`), [list, "after"]);
});

test("reference definitions keep the message whole", () => {
  const t = "See [the docs][d].\n\n[d]: https://example.com";
  assert.deepEqual(splitBlocks(t), [t]);
});

test("the blocks are the text's own lines", () => {
  const t = "a\n\n```\nx\n\ny\n```\n\n> q\n> r\n\n| a | b |\n|---|---|\n| 1 | 2 |";
  assert.equal(splitBlocks(t).join("\n\n"), t);
});

const SEL = `<selection ids="a1" label="rectangle “API”">rectangle id=a1 "API" (10,20 160×70)</selection>`;
const PT = `<point x="120" y="-40"/>`;

test("reference tags are stashed and restored", () => {
  const s = stashRefs(`Move ${SEL} to ${PT} **now**`);
  assert.deepEqual(s.refs, [SEL, PT]);
  assert.equal(s.text, "Move 0 to 1 **now**");
  assert.equal(unstash(s.text, s.refs), `Move ${SEL} to ${PT} **now**`);
  // not a reference: left as text
  assert.deepEqual(stashRefs(`<point x="a" y="1"/>`).refs, []);
});

test("slots: chips where the tags were, mentions only when asked", () => {
  const { text, refs } = stashRefs(`Put ${PT} on @plan, mail a@b.co`);
  const plain = slotText(text, refs, false);
  assert.deepEqual(plain, [
    { type: "text", value: "Put " },
    { type: "element", tagName: "span", properties: { dataRef: PT }, children: [] },
    { type: "text", value: " on @plan, mail a@b.co" },
  ]);
  const withMentions = slotText(text, refs, true);
  assert.deepEqual(withMentions.slice(2), [
    { type: "text", value: " on " },
    { type: "element", tagName: "span", properties: { dataMention: "@plan" }, children: [{ type: "text", value: "@plan" }] },
    { type: "text", value: ", mail a@b.co" },
  ]);
});

test("rehypeSlots walks the tree and leaves code and links as text", () => {
  const { text, refs } = stashRefs(`${PT} @plan`);
  const tree = {
    type: "root",
    children: [
      { type: "element", tagName: "p", children: [{ type: "text", value: text }] },
      { type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", children: [{ type: "text", value: text }] }] },
      { type: "element", tagName: "a", children: [{ type: "text", value: "@plan" }] },
    ],
  };
  rehypeSlots({ refs, mentions: true })()(tree as any);
  const [p, pre, a] = tree.children as any[];
  assert.deepEqual(p.children.map((c: any) => c.properties ?? c.value), [{ dataRef: PT }, " ", { dataMention: "@plan" }]);
  assert.deepEqual(pre.children[0].children, [{ type: "text", value: `${PT} @plan` }]);
  assert.deepEqual(a.children, [{ type: "text", value: "@plan" }]);
});

test("punctuation right after a chip stays with it", () => {
  const { text, refs } = stashRefs(`near ${PT}, then ${SEL}.`);
  assert.deepEqual(slotText(text, refs, false), [
    { type: "text", value: "near " },
    { type: "element", tagName: "span", properties: { dataRef: PT }, children: [{ type: "text", value: "," }] },
    { type: "text", value: " then " },
    { type: "element", tagName: "span", properties: { dataRef: SEL }, children: [{ type: "text", value: "." }] },
  ]);
});

test("a reference tag still being streamed is held back", () => {
  assert.equal(trimPartialRef("near <sel"), "near ");
  assert.equal(trimPartialRef(`near <selection ids="a1" label="x">rect id=a1 (1,2`), "near ");
  assert.equal(trimPartialRef(`near <point x="1" y`), "near ");
  assert.equal(trimPartialRef(`near <point x="1" y="2">near: rect</poi`), "near ");
  assert.equal(trimPartialRef(`near ${PT}`), `near ${PT}`);
  assert.equal(trimPartialRef(`near ${SEL}`), `near ${SEL}`);
  assert.equal(trimPartialRef("a < b and <div"), "a < b and <div");
  assert.equal(trimPartialRef("x <"), "x ");
  assert.equal(trimPartialRef("x <b>bold"), "x <b>bold");
});
