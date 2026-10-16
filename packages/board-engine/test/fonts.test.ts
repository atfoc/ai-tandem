import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_FONT, EMOJI_FONT, declare, faceFor, nativeFont, parseRanges, resetFaces, runsOf, setRegister, usableFaces } from "../src/fonts.ts";

// font "files" the register stand-in accepts: they only have to exist
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-fonts-"));
const url = (name: string): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "");
  return `url("${pathToFileURL(file).href}") format("woff2")`;
};

let registered: { file: string; alias: string }[] = [];
beforeEach(() => {
  resetFaces();
  registered = [];
  setRegister((file, alias) => (registered.push({ file, alias }), true));
});

test("parseRanges: U+20-7e,U+a1 is two ranges; a wildcard and no range are what CSS says", () => {
  assert.deepEqual(parseRanges("U+20-7e,U+a1"), [[0x20, 0x7e], [0xa1, 0xa1]]);
  assert.deepEqual(parseRanges("U+0-FF, U+131"), [[0, 0xff], [0x131, 0x131]]);
  assert.deepEqual(parseRanges("U+4??"), [[0x400, 0x4ff]]);
  assert.deepEqual(parseRanges(undefined), [[0, 0x10ffff]]);
});

test("usableFaces: Nunito declared at weight 500 only is used for a normal-weight string", () => {
  declare("Nunito", url("nunito-500.woff2"), { weight: "500", unicodeRange: "U+20-7e" });
  declare("Nunito", url("nunito-italic.woff2"), { weight: "400", style: "italic" });
  const pieces = usableFaces("Nunito");
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].weight, "500");
  assert.equal(faceFor("Nunito", 0x41), pieces[0]);
  // a family with a 400 face takes it over a 500 one
  declare("Both", url("both-500.woff2"), { weight: "500" });
  declare("Both", url("both-400.woff2"), { weight: "400" });
  assert.deepEqual(usableFaces("Both").map((f) => f.weight), ["400"]);
});

test("a family that is not shipped (Xiaolai) is dropped and a local: family is kept by name", () => {
  declare("Xiaolai", url("xiaolai.woff2"), { unicodeRange: "U+4e00-9fff" });
  declare("Helvetica", 'local("Helvetica Neue")');
  declare("Excalifont", url("excalifont.woff2"), { unicodeRange: "U+20-7e" });
  assert.deepEqual(usableFaces("Xiaolai"), []);
  assert.deepEqual(usableFaces("Helvetica"), []);
  const native = nativeFont("20px Excalifont, Xiaolai, Helvetica, Segoe UI Emoji");
  assert.ok(!native.includes("Xiaolai"), native);
  assert.match(native, /^20px aiwb-\d+-Excalifont, Helvetica, "Segoe UI Emoji", /);
  assert.ok(native.endsWith(DEFAULT_FONT.includes(" ") ? JSON.stringify(DEFAULT_FONT) : DEFAULT_FONT), native);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].file, path.join(dir, "excalifont.woff2"));
  // (a Xiaolai character goes to the default font: no face holds it)
  assert.equal(faceFor("Xiaolai", 0x4f60), null);
});

test("a file the canvas cannot register is left out of the font string", () => {
  setRegister(() => false);
  declare("Broken", url("broken.woff2"));
  assert.ok(!/aiwb-/.test(nativeFont("20px Broken")));
  const [run] = runsOf("20px Broken", "abc");
  assert.ok(!/aiwb-/.test(run.font));
});

test("runsOf: AŽ T is cut into faces by unicode-range and the space is a run of its own", () => {
  const latin = declare("Test", url("latin.woff2"), { unicodeRange: "U+20-7e" });
  const ext = declare("Test", url("ext.woff2"), { unicodeRange: "U+100-17f" });
  const runs = runsOf("20px Test", "AŽ T");
  assert.deepEqual(runs.map((r) => r.text), ["A", "Ž", " ", "T"]);
  assert.match(runs[0].font, new RegExp(`^20px ${latin.alias}, `));
  assert.match(runs[1].font, new RegExp(`^20px ${ext.alias}, `));
  assert.match(runs[2].font, new RegExp(`^20px ${latin.alias}, `));
  assert.match(runs[3].font, new RegExp(`^20px ${latin.alias}, `));
  // letters of one face stay one run
  assert.deepEqual(runsOf("20px Test", "ABC").map((r) => r.text), ["ABC"]);
  // pieces are registered when a character first needs them
  assert.deepEqual(registered.map((r) => r.alias).sort(), [ext.alias, latin.alias].sort());
});

test("runsOf: a CJK ideograph is a word of its own, as Blink shapes it", () => {
  declare("Test", url("latin.woff2"), { unicodeRange: "U+20-7e" });
  assert.deepEqual(runsOf("20px Test", "ab你好cd").map((r) => r.text), ["ab", "你", "好", "cd"]);
});

test("runsOf: of overlapping pieces the one declared last is checked first", () => {
  const first = declare("Test", url("first.woff2"), { unicodeRange: "U+20-7e" });
  const second = declare("Test", url("second.woff2"), { unicodeRange: "U+41-5a" });
  assert.equal(faceFor("Test", 0x41), second);
  assert.equal(faceFor("Test", 0x61), first);
  assert.deepEqual(runsOf("20px Test", "Aa").map((r) => r.text), ["A", "a"]);
});

test("runsOf: an emoji cluster with VS16 gets the emoji font, one with VS15 does not", () => {
  declare("Test", url("latin.woff2"), { unicodeRange: "U+20-7e" });
  const emoji = runsOf("20px Test", "❤️");
  assert.equal(emoji.length, 1);
  assert.ok(emoji[0].font.includes(JSON.stringify(EMOJI_FONT)), emoji[0].font);
  const text = runsOf("20px Test", "❤︎");
  assert.equal(text.length, 1);
  assert.ok(!text[0].font.includes(EMOJI_FONT), text[0].font);
  // a ZWJ sequence is one cluster, one run
  assert.equal(runsOf("20px Test", "\u{1f468}‍\u{1f469}‍\u{1f467}").length, 1);
});

test("runsOf: right-to-left text is one run for drawing and several for measuring", () => {
  declare("Test", url("latin.woff2"), { unicodeRange: "U+20-7e" });
  const text = "שלום עולם";
  assert.equal(runsOf("20px Test", text, { forDrawing: true }).length, 1);
  assert.deepEqual(runsOf("20px Test", text).map((r) => r.text), ["שלום", " ", "עולם"]);
  assert.equal(runsOf("20px Test", text, { forDrawing: true })[0].text, text);
});

test("runsOf: nothing to split is one run, and a string that is not a font is passed through", () => {
  assert.deepEqual(runsOf("20px Test", ""), [{ font: nativeFont("20px Test"), text: "" }]);
  assert.deepEqual(runsOf("bold", "abc"), [{ font: "bold", text: "abc" }]);
});
