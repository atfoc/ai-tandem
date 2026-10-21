// The cleaner of voice (architecture VC-25): each row of its table, code skipped or said, the user message's references, and the
// fixtures of real-shaped replies read whole. The sentences they split into are pinned by voice.sentences.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pointRef, selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { speechText } from "../src/voice/logic/speech.ts";

const say = (md: string, skipCode = true) => speechText(md, { skipCode });

test("headings, paragraphs and quotes are their words, a heading its own sentence", () => {
  assert.equal(say("# Plan\n\nWe start now."), "Plan.\nWe start now.");
  assert.equal(say("## Plan ##"), "Plan.");
  assert.equal(say("> It never freed it.\n> Not once."), "It never freed it. Not once.");
  assert.equal(say("one line\nwrapped over two\n\nnext"), "one line wrapped over two\nnext");
});

test("list items and task boxes are a sentence each, the markers dropped", () => {
  assert.equal(say("- red\n* green\n+ blue"), "red.\ngreen.\nblue.");
  assert.equal(say("1. first\n2) second"), "first.\nsecond.");
  assert.equal(say("- [ ] open\n- [x] closed"), "open.\nclosed.");
  assert.equal(say("- Do this.\n  - nested"), "Do this.\nnested.");
  assert.equal(say("1.5x faster\n\n2024-01-05: noted"), "1.5x faster\n2024-01-05: noted");
});

test("emphasis marks go and the words stay; inline code is said as its words", () => {
  assert.equal(say("a **bold** and *slanted* and __under__ and _soft_ and ~~gone~~ word"), "a bold and slanted and under and soft and gone word");
  assert.equal(say("***both*** here"), "both here");
  assert.equal(say("call `foo.bar()` now, or ``a ` b`` too"), "call foo.bar() now, or a ` b too");
  assert.equal(say("keep snake_case_names and 2 * 3 as they are"), "keep snake_case_names and 2 * 3 as they are");
  assert.equal(say("**Note. This** matters"), "Note. This matters");
  assert.equal(say("`**not bold**` stays"), "**not bold** stays");
});

test("fenced and indented code is skipped, or said line by line with its symbols", () => {
  const md = "Run this:\n\n```sh\nnpm run build -- --watch\n\nls | wc -l\n```\n\nThen:\n\n    cd ../app\n\nDone.";
  assert.equal(say(md), "Run this:\nThen:\nDone.");
  assert.equal(say(md, false), "Run this:\nnpm run build -- --watch\nls | wc -l\nThen:\ncd ../app\nDone.");
  assert.equal(say("~~~\na ```\n~~~\nafter"), "after");
  assert.equal(say("```\nnever closed\nstill code"), "");
  assert.equal(say("```js\ncode\n``` \nafter"), "after");
  assert.equal(say("````\n```\ninner\n```\n````\nafter"), "after");
  assert.equal(say("- item\n\n  ```\n  code\n  ```\n- next"), "item.\nnext.");
});

test("links say their text, a bare address or an image says nothing", () => {
  assert.equal(say("see [the docs](https://example.com/a_b) now"), "see the docs now");
  assert.equal(say("see [the docs][1] and [**bold** link](<x> \"title\")"), "see the docs and bold link");
  assert.equal(say("go to <https://example.com/x> or https://example.com/y?a=1&b=2."), "go to or.");
  assert.equal(say("(see https://example.com/z)"), "(see)");
  assert.equal(say("before ![a diagram](d.png) after"), "before after");
  assert.equal(say("a [bracket] stays, a footnote[^2] goes"), "a [bracket] stays, a footnote goes");
  assert.equal(say("paths src/app.ts and ./run.sh stay"), "paths src/app.ts and ./run.sh stay");
});

test("a table says each row, its cells joined by commas; the separator row is dropped", () => {
  assert.equal(say("| a | b |\n|---|:-:|\n| 1 | **2** |\n| [x](u) | `y` |"), "a, b.\n1, 2.\nx, y.");
  assert.equal(say("| only |\n| --- |"), "only.");
  assert.equal(say("|  |  |"), "");
});

test("HTML tags go and their text stays; comments, rules and footnote marks are dropped", () => {
  assert.equal(say("a <b>bold</b> move<br/>now"), "a bold move now");
  assert.equal(say("<div>\nhello\n</div>"), "hello");
  assert.equal(say("x <!-- hidden --> y"), "x y");
  assert.equal(say("above\n\n---\n\nbelow\n\n***\n\n___"), "above\nbelow");
  assert.equal(say("5 &lt; 6 &amp; 7 &gt; 6"), "5 < 6 & 7 > 6");
  assert.equal(say("Array<string> in `Array<string>`"), "Array in Array<string>");
});

test("a user message's references say their label", () => {
  const sel = serializeRef(selectionRef([
    { id: "a1", type: "rectangle", x: 10, y: 20, width: 160, height: 70, label: "API" },
    { id: "b2", type: "rectangle", x: 200, y: 20, width: 160, height: 70 },
  ] as never)!);
  const pt = serializeRef(pointRef(120, -40));
  assert.equal(say(`Make ${sel} wider, then look at ${pt} again.`), "Make 2 rectangles wider, then look at (120, -40) again.");
  assert.equal(say(`<selection ids="x" label="oval “A. B”">oval id=x "A. B"</selection> is round`), "oval “A. B” is round");
});

test("nothing to say is the empty string", () => {
  assert.equal(say(""), "");
  assert.equal(say("   \n\n  \n"), "");
  assert.equal(say("![only an image](a.png)"), "");
  assert.equal(say("- \n-\n"), "");
});

test("every fixture, read whole, has words and no markup left", () => {
  for (const name of fixtures()) {
    const text = say(readFileSync(new URL(`./fixtures/voice/${name}.md`, import.meta.url), "utf8"));
    assert.ok(text.length > 0, name);
    assert.doesNotMatch(text, /\*\*|\]\(|<\/?[a-z]+[ >]|^#|^\||```|!\[/m, name);
  }
});

import { readdirSync, readFileSync } from "node:fs";
function fixtures(): string[] {
  return readdirSync(new URL("./fixtures/voice/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}
