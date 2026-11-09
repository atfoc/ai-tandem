// The hanging indent of the native box: the rules of aiwb-indent's contract (src/AiwbIndent.ts), which the Swift and the Kotlin
// mirror, and the controller of the field (platform/chipinput/hang.ts) over the module's fake: when it attaches, re-applies,
// detaches, which heights it passes on, and that nothing happens after dispose or without the module.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hangWidth, indentColumns, MAX_INDENT_SHARE, paragraphs, tabInterval } from "../modules/aiwb-indent/src/AiwbIndent.ts";
import { createFakeAiwbIndent } from "../modules/aiwb-indent/src/fake.ts";
import { clampHeight, hangOver } from "../src/platform/chipinput/hang.ts";

test("indentColumns: spaces one column each, a tab to the next stop, the run ends at any other character", () => {
  assert.equal(indentColumns("", 4), 0);
  assert.equal(indentColumns("abc", 4), 0);
  assert.equal(indentColumns("   x", 4), 3);
  for (const w of [2, 4, 8]) {
    assert.equal(indentColumns("\tx", w), w);
    assert.equal(indentColumns("\t\tx", w), 2 * w);
  }
  assert.equal(indentColumns("  \tx", 4), 4, "a tab after two spaces ends at the next stop");
  assert.equal(indentColumns("  \tx", 2), 4, "two spaces fill a stop of 2: the tab is a whole one");
  assert.equal(indentColumns(" \t x", 8), 9);
  assert.equal(indentColumns("  \u00a0 x", 4), 2, "a no-break space (a chip's padding) ends the indent");
  assert.equal(indentColumns("  - item", 4), 2, "a list's \"- \" is not indent");
  assert.equal(indentColumns(" \t ", 4), 5, "a line of nothing but spaces and tabs is all indent");
});

test("paragraphs: one per line with its \"\\n\", none for the empty line after a final \"\\n\", the tab anywhere in the line", () => {
  assert.deepEqual(paragraphs("", 4), []);
  assert.deepEqual(paragraphs("ab", 4), [{ start: 0, end: 2, columns: 0, hasTab: false }]);
  assert.deepEqual(paragraphs("a\n\tb\n  c\td", 4), [
    { start: 0, end: 2, columns: 0, hasTab: false },
    { start: 2, end: 5, columns: 4, hasTab: true },
    { start: 5, end: 10, columns: 2, hasTab: true },
  ]);
  assert.deepEqual(paragraphs("x\n", 4), [{ start: 0, end: 2, columns: 0, hasTab: false }]);
  assert.deepEqual(paragraphs("\n\n", 2), [{ start: 0, end: 1, columns: 0, hasTab: false }, { start: 1, end: 2, columns: 0, hasTab: false }]);
});

test("hangWidth: columns times the space, at most half the text's width; no cap while the width is not known", () => {
  assert.equal(MAX_INDENT_SHARE, 0.5);
  assert.equal(hangWidth(4, 5, 200), 20);
  assert.equal(hangWidth(40, 5, 200), 100, "capped at half of 200");
  assert.equal(hangWidth(40, 5, 0), 200);
  assert.equal(hangWidth(40, 5, -1), 200);
  assert.equal(hangWidth(0, 5, 200), 0);
  assert.equal(tabInterval(4, 7.5), 30);
  assert.equal(tabInterval(2, 10), 20);
});

test("clampHeight keeps the drawn height between the variant's minimum and maximum", () => {
  assert.equal(clampHeight(50, 60, 120), 60);
  assert.equal(clampHeight(90, 60, 120), 90);
  assert.equal(clampHeight(156, 60, 120), 120);
});

/** A controller over a fresh fake, with what it passed to onHeight. */
function setup() {
  const fake = createFakeAiwbIndent();
  const heights: (number | null)[] = [];
  const hang = hangOver(fake.module)((h) => heights.push(h));
  return { fake, heights, hang };
}

test("the attach waits for a mounted view: a layout before the view is there asks, the next layout asks again", async () => {
  const { fake, hang } = setup();
  assert.equal(fake.listening(), 1, "subscribed once at creation");
  hang.width(4);
  await fake.settle();
  assert.deepEqual(fake.calls(), [], "no tag yet: no call");
  hang.layout(7);
  await fake.settle();
  assert.deepEqual(fake.calls(), [[7, 4]]);
  assert.equal(fake.indents().size, 0, "not mounted: nothing drawn, and no retry on its own");
  fake.mount(7);
  hang.layout(7);
  await fake.settle();
  assert.deepEqual(fake.calls(), [[7, 4], [7, 4]]);
  assert.deepEqual([...fake.indents()], [[7, 4]]);
  hang.layout(7);
  await fake.settle();
  assert.equal(fake.calls().length, 2, "applied as wanted: a later layout asks nothing");
});

test("no width asked: nothing is called", async () => {
  const { fake, hang } = setup();
  fake.mount(1);
  hang.layout(1);
  hang.width(0);
  await fake.settle();
  assert.deepEqual(fake.calls(), []);
});

test("a change of width is applied again; width 0 takes the indent off and gives the box back to React Native at once", async () => {
  const { fake, heights, hang } = setup();
  fake.mount(3);
  hang.width(2);
  hang.layout(3);
  await fake.settle();
  hang.width(8);
  await fake.settle();
  assert.deepEqual([...fake.indents()], [[3, 8]]);
  fake.emit({ tag: 3, height: 80 });
  hang.width(0);
  assert.deepEqual(heights, [80, null], "null at once, before the module answered");
  await fake.settle();
  assert.deepEqual(fake.calls(), [[3, 2], [3, 8], [3, 0]]);
  assert.equal(fake.indents().size, 0);
  assert.deepEqual(heights, [80, null, null], "and again when the module took it off");
});

test("heights pass only for the applied view with a width; one that came before the answer is given at the answer; others are dropped", async () => {
  const { fake, heights, hang } = setup();
  fake.mount(5);
  hang.width(4);
  hang.layout(5);
  fake.emit({ tag: 5, height: 40 }); // asked, not answered yet
  await fake.settle();
  fake.emit({ tag: 6, height: 41 }); // another box
  fake.emit({ tag: 5, height: 42 });
  assert.deepEqual(heights, [40, 42]);
  hang.width(0);
  fake.emit({ tag: 5, height: 43 }); // taken off, not answered yet
  await fake.settle();
  fake.emit({ tag: 5, height: 44 });
  assert.deepEqual(heights, [40, 42, null, null]);
});

test("a new tag is a new view: the indent is put on it, and the old one's heights no longer count", async () => {
  const { fake, heights, hang } = setup();
  fake.mount(1);
  hang.width(4);
  hang.layout(1);
  await fake.settle();
  fake.unmount(1);
  fake.mount(2);
  hang.layout(2);
  await fake.settle();
  assert.deepEqual(fake.calls(), [[1, 4], [2, 4]]);
  fake.emit({ tag: 1, height: 10 });
  fake.emit({ tag: 2, height: 20 });
  assert.deepEqual(heights, [20]);
});

test("one call in flight at a time, and the latest wish wins", async () => {
  const { fake, hang } = setup();
  fake.mount(9);
  hang.layout(9);
  hang.width(2);
  hang.width(4);
  hang.width(8);
  assert.deepEqual(fake.calls(), [[9, 2]], "the others wait for the answer");
  await fake.settle();
  assert.deepEqual(fake.calls(), [[9, 2], [9, 8]], "then only the last one");
  assert.deepEqual([...fake.indents()], [[9, 8]]);
  hang.width(4);
  hang.width(8);
  await fake.settle();
  assert.deepEqual(fake.calls(), [[9, 2], [9, 8], [9, 4], [9, 8]], "4 was on its way when 8 was wished again: after its answer, 8 is asked");
  assert.deepEqual([...fake.indents()], [[9, 8]]);
});

test("dispose takes the indent off, unsubscribes, and silences later answers and events", async () => {
  const { fake, heights, hang } = setup();
  fake.mount(4);
  hang.width(4);
  hang.layout(4);
  await fake.settle();
  hang.dispose();
  assert.equal(fake.listening(), 0);
  await fake.settle();
  assert.deepEqual(fake.calls(), [[4, 4], [4, 0]]);
  assert.equal(fake.indents().size, 0);
  hang.width(8);
  hang.layout(4);
  fake.emit({ tag: 4, height: 30 });
  await fake.settle();
  assert.equal(fake.calls().length, 2, "nothing after dispose");
  assert.deepEqual(heights, []);
  hang.dispose(); // twice is harmless
});

test("dispose while a call is on its way: no height comes, and the indent it put on is taken off", async () => {
  const { fake, heights, hang } = setup();
  fake.mount(4);
  hang.width(4);
  hang.layout(4);
  hang.dispose();
  await fake.settle();
  assert.deepEqual(fake.calls(), [[4, 4], [4, 0]]);
  assert.equal(fake.indents().size, 0);
  assert.deepEqual(heights, []);
});

test("without the module (a build made before it) nothing is called and nothing fails", () => {
  const heights: (number | null)[] = [];
  const hang = hangOver(null)((h) => heights.push(h));
  hang.width(4);
  hang.layout(1);
  hang.width(0);
  hang.dispose();
  assert.deepEqual(heights, [null], "width 0 still gives the box back to React Native's size (which it never left)");
});
