// The sticky's shrink-to-fit (src/sticky/fit.ts) against a fake measure: a monospace layout with greedy word wrapping
// (each character 0.6 em wide, lines 1.25 em high), so every expectation can be worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRange, fitFontSize, FUZZ, type MeasureAt, type MeasuredText } from "../src/sticky/fit.ts";

const CHAR = 0.6;
const LINE = 1.25;

/** Greedy wrap of `text` at `maxWidth` with words never broken; returns the measured size and the widest word. */
function mono(text: string): MeasureAt {
  return (fontSize, maxWidth) => {
    const cw = CHAR * fontSize;
    let lines = 0;
    let widest = 0;
    let longestWord = 0;
    for (const para of text.split("\n")) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = 0;
      lines++;
      for (const word of words) {
        const ww = word.length * cw;
        longestWord = Math.max(longestWord, ww);
        const next = line === 0 ? ww : line + cw + ww;
        if (line > 0 && next > maxWidth) {
          widest = Math.max(widest, line);
          lines++;
          line = ww;
        } else line = next;
      }
      widest = Math.max(widest, line);
    }
    const m: MeasuredText = { w: Math.min(widest, maxWidth), h: lines * LINE * fontSize, scrollWidth: Math.max(widest, longestWord) };
    return m;
  };
}

const box = { w: 200, h: 200, padding: 16 };
const inner = box.w - box.padding * 2;

function fitsAt(text: string, size: number, b = box) {
  const m = mono(text)(size, b.w - b.padding * 2);
  return m.h <= b.h - b.padding * 2 + FUZZ && Math.max(m.w, m.scrollWidth ?? 0) <= b.w - b.padding * 2 + FUZZ;
}

test("a short text gets the largest automatic size", () => {
  const r = fitFontSize({ ...box }, mono("Idea"));
  assert.equal(r.fontSize, autoRange(200).max);
  assert.equal(r.overflows, false);
  assert.equal(r.measured, 1);
});

test("a long text shrinks, and the answer is the largest size that fits", () => {
  const text = "The quick brown fox jumps over the lazy dog and keeps running across the whole field until the sun goes down";
  const r = fitFontSize({ ...box }, mono(text));
  assert.ok(r.fontSize < autoRange(200).max, `shrunk: ${r.fontSize}`);
  assert.ok(fitsAt(text, r.fontSize), "fits at the answer");
  assert.ok(!fitsAt(text, r.fontSize + 1), "does not fit one step up");
  assert.equal(r.overflows, false);
});

test("the note keeps its size: the answer never needs more than the box", () => {
  for (let n = 1; n <= 400; n += 13) {
    const text = Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const r = fitFontSize({ ...box }, mono(text));
    if (!r.overflows) assert.ok(fitsAt(text, r.fontSize), `n=${n} size=${r.fontSize}`);
  }
});

test("more text never gets a larger font", () => {
  let last = Infinity;
  let text = "";
  for (let i = 0; i < 120; i++) {
    text += (i ? " " : "") + "word";
    const r = fitFontSize({ ...box }, mono(text));
    assert.ok(r.fontSize <= last, `i=${i}: ${r.fontSize} > ${last}`);
    last = r.fontSize;
  }
});

test("a long word is fitted by width, not broken", () => {
  const word = "Supercalifragilisticexpialidocious"; // 34 characters
  const r = fitFontSize({ ...box }, mono(word));
  assert.equal(r.fontSize, Math.floor(inner / (word.length * CHAR)));
});

test("resizing refits: a bigger note gets a larger (or equal) size, a smaller one a smaller size", () => {
  const text = "Ship the prototype by Friday and write down what we learned";
  const small = fitFontSize({ w: 120, h: 120, padding: 16 }, mono(text)).fontSize;
  const mid = fitFontSize({ ...box }, mono(text)).fontSize;
  const big = fitFontSize({ w: 400, h: 400, padding: 16 }, mono(text)).fontSize;
  assert.ok(small < mid && mid < big, `${small} < ${mid} < ${big}`);
});

test("too much text overflows at the minimum and says so", () => {
  const text = "x ".repeat(5000);
  const r = fitFontSize({ ...box }, mono(text));
  assert.equal(r.fontSize, autoRange(200).min);
  assert.equal(r.overflows, true);
});

test("a fixed size is kept, with whether it overflows", () => {
  assert.deepEqual(fitFontSize({ ...box, fixed: 24 }, mono("Idea")), { fontSize: 24, overflows: false, measured: 1 });
  const long = fitFontSize({ ...box, fixed: 40 }, mono("one two three four five six seven eight nine ten"));
  assert.equal(long.fontSize, 40);
  assert.equal(long.overflows, true);
});

test("an empty note measures nothing", () => {
  assert.deepEqual(fitFontSize({ ...box, empty: true }, () => assert.fail("measured")), { fontSize: autoRange(200).max, overflows: false, measured: 0 });
  assert.equal(fitFontSize({ ...box, empty: true, fixed: 20 }, () => assert.fail("measured")).fontSize, 20);
});

test("the search is logarithmic", () => {
  const r = fitFontSize({ ...box, min: 6, max: 48 }, mono("a b c d e f g h i j k l m n o p q r s t u v w x y z ".repeat(6)));
  assert.ok(r.measured <= 2 + Math.ceil(Math.log2(48 - 6)), `measured ${r.measured}`);
});

test("a step makes the answer a multiple of it", () => {
  const text = "The quick brown fox jumps over the lazy dog and keeps running";
  const r = fitFontSize({ ...box, step: 2 }, mono(text));
  assert.equal(r.fontSize % 2, 0);
  assert.ok(fitsAt(text, r.fontSize) && !fitsAt(text, r.fontSize + 2));
});

test("multi-line text counts its lines", () => {
  const r = fitFontSize({ ...box }, mono("a\nb\nc\nd\ne\nf"));
  // six lines at 1.25 em in 168 px: 168 / 7.5 = 22.4
  assert.equal(r.fontSize, 22);
});
