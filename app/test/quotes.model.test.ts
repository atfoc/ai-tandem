// What the quotes screens decide and no screen draws (screens/quotes/model.ts, bus.ts, sheetstore.ts; package K5): how a comment field is kept, the words of the
// count and the list, the reference a span of a message's displayed text makes, what keeps a message from being quoted.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { quoteKey } from "@aiwb/core/logic/quotes.ts";
import type { Reference } from "@aiwb/core/types.ts";
import { registerTaker, takerOf } from "../src/screens/quotes/bus.ts";
import { countTitle, countWord, listHint, referenceFor, whyNotQuotable, wholeReference, withFloat } from "../src/screens/quotes/model.ts";
import { holdEnded, inGrace, openPick, pickNow, closePick, subscribePick } from "../src/screens/quotes/sheetstore.ts";

const ref = (start: number, end: number, comment?: string): Reference => ({ quote: "q", item: 1, start, end, ...(comment === undefined ? {} : { comment }) });

describe("withFloat (C-QT-08)", () => {
  it("adds a new quote on Enter, even with no comment", () => {
    assert.deepEqual(withFloat([], { r: ref(0, 4), edit: false, text: "" }, true), [ref(0, 4)]);
    assert.deepEqual(withFloat([], { r: ref(0, 4), edit: false, text: "why" }, true), [ref(0, 4, "why")]);
  });
  it("adds a new quote elsewhere only with a comment", () => {
    assert.deepEqual(withFloat([], { r: ref(0, 4), edit: false, text: "  " }, false), []);
    assert.deepEqual(withFloat([], { r: ref(0, 4), edit: false, text: "kept" }, false), [ref(0, 4, "kept")]);
  });
  it("does not add a passage twice, and gives an edited quote its comment (a blank one takes it away)", () => {
    const have = [ref(0, 4, "old"), ref(10, 14)];
    assert.deepEqual(withFloat(have, { r: ref(0, 4), edit: false, text: "again" }, true), have);
    assert.deepEqual(withFloat(have, { r: ref(0, 4), edit: true, text: "new" }, false), [ref(0, 4, "new"), ref(10, 14)]);
    assert.deepEqual(withFloat(have, { r: ref(0, 4), edit: true, text: " " }, true), [ref(0, 4), ref(10, 14)]);
  });
});

describe("the words", () => {
  it("count: one passage, several; the hint says tap with a finger and click with a mouse", () => {
    assert.equal(countTitle(1), "1 quoted passage in this message");
    assert.equal(countTitle(3), "3 quoted passages in this message");
    assert.equal(countWord(1), "comment");
    assert.equal(countWord(2), "comments");
    assert.equal(listHint(true, false), "click one to edit it");
    assert.equal(listHint(false, false), "click one to show it");
    assert.equal(listHint(true, true), "tap one to edit it");
  });
  it("what keeps a message from being quoted (B-QS-04, B-QS-05)", () => {
    assert.equal(whyNotQuotable({ kind: "user" }), "");
    assert.equal(whyNotQuotable({ kind: "text", done: true }), "");
    assert.equal(whyNotQuotable({ kind: "text", done: false }), "Wait for the reply to finish, then quote it");
    assert.equal(whyNotQuotable({ kind: "tool" }), "Only a message's own words can be quoted.");
    assert.match(whyNotQuotable(undefined), /no longer there/);
  });
});

describe("referenceFor", () => {
  const shown = "Because of the font copy step.\none fast item\nTwo slow.";
  it("trims the white space a selection takes around its words, and the span with it", () => {
    const r = referenceFor(shown, 1, 29, 45)!; // ".\none fast item\n"
    assert.equal(r.quote, ".\none fast item");
    assert.equal(shown.slice(r.start, r.end), r.quote);
    const w = referenceFor(shown, 1, 14, 29)!; // " font copy step"
    assert.deepEqual([w.quote, w.start, w.end, w.item], ["font copy step", 15, 29, 1]);
  });
  it("takes a span the wrong way round, and none for white space only", () => {
    assert.equal(referenceFor(shown, 1, 29, 15)?.quote, "font copy step");
    assert.equal(referenceFor(shown, 1, 30, 31), null);
    assert.equal(referenceFor(shown, 1, 5, 5), null);
  });
  it("is the whole message for wholeReference, and none for an empty one", () => {
    const r = wholeReference(` ${shown}\n`, 4)!;
    assert.equal(r.quote, shown);
    assert.deepEqual([r.start, r.end, r.item], [1, 1 + shown.length, 4]);
    assert.equal(wholeReference("  ", 4), null);
  });
  it("makes a reference whose key is its message and position", () => {
    assert.equal(quoteKey(referenceFor(shown, 1, 15, 29)!), "1:15:29");
  });
});

describe("the composer that takes quotes (bus.ts)", () => {
  it("is the one registered last for a chat, and goes when it unregisters", () => {
    const a = { quote() {}, quotes: () => [] }, b = { quote() {}, quotes: () => [ref(1, 2)] };
    const offA = registerTaker("c1", a);
    assert.equal(takerOf("c1"), a);
    const offB = registerTaker("c1", b);
    offA(); // (the first went away after the second came: the second stays)
    assert.equal(takerOf("c1"), b);
    offB();
    assert.equal(takerOf("c1"), undefined);
  });
});

describe("the Quote sheet's store (sheetstore.ts)", () => {
  it("opens for a message, tells its listeners, closes; a press on the dimmed page is ignored for a moment after it opens", () => {
    let told = 0;
    const off = subscribePick(() => { told++; });
    openPick("c1", 3);
    assert.deepEqual(pickNow(), { chat: "c1", index: 3 });
    assert.equal(inGrace(), true);
    closePick();
    assert.equal(pickNow(), null);
    assert.equal(told, 2);
    off();
    holdEnded();
    assert.equal(inGrace(), true);
  });
});
