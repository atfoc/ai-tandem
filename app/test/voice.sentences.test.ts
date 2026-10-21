// The sentence splitter of voice (architecture VC-26): the rules one by one, and the fixtures of real-shaped replies, each fed whole,
// in twenty random cuts and one character at a time, which must give the sentences pinned beside the fixture.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { createSplitter } from "../src/voice/logic/sentences.ts";
import { speechText } from "../src/voice/logic/speech.ts";

/** The sentences of a text fed in the given pieces, then flushed. */
function split(pieces: string[], skipCode = true): string[] {
  const out: string[] = [];
  const sp = createSplitter({ skipCode, onSentence: (s) => out.push(s) });
  for (const p of pieces) sp.push(p);
  sp.flush();
  return out;
}
const whole = (md: string, skipCode = true) => split([md], skipCode);

/** A small seeded generator, so a failing cut can be run again. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
/** The text in `n` pieces, cut at random places. */
function cuts(md: string, n: number, next: () => number): string[] {
  const at = Array.from({ length: n }, () => Math.floor(next() * (md.length + 1))).sort((a, b) => a - b);
  const out: string[] = [];
  let from = 0;
  for (const a of at) { out.push(md.slice(from, a)); from = a; }
  out.push(md.slice(from));
  return out;
}

test("a sentence ends at . ! ? … and 。！？ followed by a blank, after closing quotes and brackets", () => {
  assert.deepEqual(whole("It works fine now. Does it really? Yes it does! Truly so… Done (really.) He said, “stop now.” Then left. これは最初の文です。これは次の文です！"), [
    "It works fine now.",
    "Does it really?",
    "Yes it does!",
    "Truly so… Done (really.)",
    "He said, “stop now.”",
    "Then left. これは最初の文です。",
    "これは次の文です！",
  ]);
  assert.deepEqual(whole("First sentence is here. Second sentence is here.\nThird, on a new line, is here."), [
    "First sentence is here.",
    "Second sentence is here.",
    "Third, on a new line, is here.",
  ]);
});

test("it does not cut after an abbreviation, inside a number, after an initial, in an address or on an ellipsis", () => {
  const one = (md: string) => assert.deepEqual(whole(md), [md.trim()], md);
  one("Use a tool, e.g. a hammer, for the job at hand today.");
  one("That is the idea, i.e. the whole point of the thing.");
  one("Ask Dr. Smith or Mrs. Jones or Mr. Lee or Ms. Wu or Prof. Ng.");
  one("It was fruit, nuts, etc. and then some more food besides.");
  one("Compare apples vs. oranges in the next table please.");
  one("See Fig. 3 and No. 4 of the manual for approx. five details.");
  one("The value is 3.14 and the version is v2.5 at 1.5x speed today.");
  one("The author is J. R. R. Tolkien and he wrote a long book.");
  one("Open index.ts and ./run.sh and src/a.b/c.d now, then stop.");
  one("Well... that was unexpected, but the plan still holds up fine.");
  assert.deepEqual(whole("Bring fruit, nuts, etc. Then we leave for the lake today."), ["Bring fruit, nuts, etc.", "Then we leave for the lake today."]);
  assert.deepEqual(whole("The long day ended... Then it began again, which was nicer to see."), ["The long day ended...", "Then it began again, which was nicer to see."]);
});

test("a fragment under 12 characters joins the next sentence; the flush says what is left", () => {
  assert.deepEqual(whole("Yes. That is exactly what I meant to say."), ["Yes. That is exactly what I meant to say."]);
  assert.deepEqual(whole("Hi. Yo. This is the real sentence here."), ["Hi. Yo. This is the real sentence here."]);
  assert.deepEqual(whole("A long first sentence is here. OK."), ["A long first sentence is here.", "OK."]);
  const out: string[] = [];
  const sp = createSplitter({ skipCode: true, onSentence: (s) => out.push(s) });
  sp.push("Okay. ");
  assert.deepEqual(out, []);
  sp.flush();
  assert.deepEqual(out, ["Okay."]);
  sp.push("Next item is a normal sentence. And more");
  assert.deepEqual(out, ["Okay.", "Next item is a normal sentence."]);
  sp.flush();
  assert.deepEqual(out, ["Okay.", "Next item is a normal sentence.", "And more"]);
});

test("a sentence over 300 characters is cut at the last ; : or , before 250, else at a space", () => {
  const clause = "and then another clause follows here";
  const withCommas = Array.from({ length: 12 }, () => clause).join(", ") + ".";
  const out = whole(withCommas);
  assert.ok(withCommas.length > 300 && out.length === 2, String(out.length));
  assert.ok(out[0].length <= 250 && out[0].endsWith(","), out[0]);
  assert.equal(out.join(" "), withCommas);
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + ".";
  const spaced = whole(words);
  assert.ok(spaced.length > 1 && spaced.every((s) => s.length <= 250), spaced.map((s) => s.length).join());
  assert.equal(spaced.join(" "), words);
  assert.equal(whole(`${"x".repeat(400)}.`).length, 1); // one word, however long, stays one
  const semi = `${"a".repeat(100)}; ${"b".repeat(100)}: ${"c".repeat(60)} ${"d".repeat(100)}.`;
  assert.deepEqual(whole(semi).map((s) => s.slice(-1)), [":", "."]);
});

test("each heading, list item, table row and paragraph is a sentence; a blank line ends one", () => {
  assert.deepEqual(whole("# A heading\n\nPara one is long enough\nover two lines.\n\nPara two is here, too.\n- first item is here\n- second item is here"), [
    "A heading. Para one is long enough over two lines.",
    "Para two is here, too.",
    "first item is here.",
    "second item is here.",
  ]);
  assert.deepEqual(whole("| name of the box | size of the box |\n|---|---|\n| small box here | ten pixels |"), ["name of the box, size of the box.", "small box here, ten pixels."]);
});

test("fenced code is tracked across pushes and skipped, or said line by line", () => {
  const md = "Before the code comes this.\n```js\nfooBar(1.5, 2.5);\n// not. a sentence\n```\nAfter the code comes that.\n";
  assert.deepEqual(split(["Before the code comes this.\n`", "``js\nfooBar(1.5, 2.5);\n// not. a se", "ntence\n``", "`\nAfter the code comes that.\n"]), [
    "Before the code comes this.",
    "After the code comes that.",
  ]);
  assert.deepEqual(whole(md, false), ["Before the code comes this.", "fooBar(1.5, 2.5);", "// not. a sentence", "After the code comes that."]);
  assert.deepEqual(whole("Text here is a sentence.\n```\nnever closed\nstill code. yes"), ["Text here is a sentence."]);
  assert.deepEqual(whole("```\nopen\n"), []);
});

test("a link, a code span or a tag that is still open holds the cut back", () => {
  const out: string[] = [];
  const sp = createSplitter({ skipCode: true, onSentence: (s) => out.push(s) });
  sp.push("A sentence before the link is here. See [the docs. Then");
  assert.deepEqual(out, ["A sentence before the link is here."]);
  sp.push(" more](https://exam");
  sp.push("ple.com/a.b) for details. Next");
  assert.deepEqual(out, ["A sentence before the link is here.", "See the docs. Then more for details."]);
  sp.push(" use `a. b");
  sp.push("` here. Done");
  sp.flush();
  assert.deepEqual(out.slice(2), ["Next use a. b here.", "Done"]);
  assert.deepEqual(whole("Tags like <span class=\"a. b\">span. text</span> are fine. And more words follow."), ["Tags like span.", "text are fine.", "And more words follow."]);
  assert.deepEqual(whole("Backticks ` without a closer end here. Then more text follows after."), ["Backticks ` without a closer end here.", "Then more text follows after."]);
  assert.deepEqual(whole("A lone [bracket here. Then more words follow after it."), ["A lone [bracket here.", "Then more words follow after it."]);
});

test("a reference of a user message is one piece, whatever its detail holds", () => {
  const md = 'Make <selection ids="a1" label="rectangle “API. v2”">rectangle id=a1 "API. v2" (10,20 160×70)</selection> wider. Then stop.';
  assert.deepEqual(whole(md), ["Make rectangle “API. v2” wider.", "Then stop."]);
  assert.deepEqual(split(Array.from(md)), ["Make rectangle “API. v2” wider.", "Then stop."]);
});

test("a reply split by emphasis has no marks left in either half", () => {
  assert.deepEqual(whole("**Note: this is bold. And this is too** but not this one."), ["Note: this is bold.", "And this is too but not this one."]);
});

test("the sentences are said as the cleaner says the text", () => {
  for (const name of fixtureNames()) {
    const md = readFileSync(new URL(`./fixtures/voice/${name}.md`, import.meta.url), "utf8");
    for (const skipCode of [true, false]) {
      const said = whole(md, skipCode).join(" ").replace(/\s+/g, " ");
      assert.equal(said, speechText(md, { skipCode }).replace(/\s+/g, " "), `${name} skipCode=${skipCode}`);
    }
  }
});

function fixtureNames(): string[] {
  return readdirSync(new URL("./fixtures/voice/", import.meta.url)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

test("there are at least eight fixtures, each with its sentences beside it", () => {
  const names = fixtureNames();
  assert.ok(names.length >= 8, names.join());
  for (const name of names) {
    const j = JSON.parse(readFileSync(new URL(`./fixtures/voice/${name}.json`, import.meta.url), "utf8"));
    assert.ok(Array.isArray(j.sentences) && j.sentences.length > 0, name);
  }
});

for (const name of fixtureNames()) {
  test(`fixture ${name}: whole, in twenty random cuts and one character at a time, the same sentences`, () => {
    const md = readFileSync(new URL(`./fixtures/voice/${name}.md`, import.meta.url), "utf8");
    const want = JSON.parse(readFileSync(new URL(`./fixtures/voice/${name}.json`, import.meta.url), "utf8")) as { sentences: string[]; sentencesWithCode?: string[] };
    for (const skipCode of [true, false]) {
      const expected = skipCode ? want.sentences : want.sentencesWithCode ?? want.sentences;
      assert.deepEqual(whole(md, skipCode), expected, `${name} whole, skipCode=${skipCode}`);
      const next = rng(7 + name.length);
      for (let round = 0; round < 20; round++) {
        const pieces = cuts(md, 1 + Math.floor(next() * 12), next);
        assert.deepEqual(split(pieces, skipCode), expected, `${name} round ${round}, skipCode=${skipCode}: ${JSON.stringify(pieces)}`);
      }
      assert.deepEqual(split(Array.from(md), skipCode), expected, `${name} one character at a time, skipCode=${skipCode}`);
    }
  });
}

test("a sentence is said as soon as it is complete, not when the reply ends", () => {
  const out: string[] = [];
  const sp = createSplitter({ skipCode: true, onSentence: (s) => out.push(s) });
  let said = 0;
  for (const word of "This is the first complete sentence. Here is the second complete sentence. And the third one is open".split(" ")) {
    sp.push(word + " ");
    said = Math.max(said, out.length);
  }
  assert.equal(said, 2);
  sp.flush();
  assert.equal(out.length, 3);
});

test("odd mixes of Markdown give the same sentences however they are cut", () => {
  const bits = ["Hello", " world", ". ", "! ", "? ", "...", "\n", "\n\n", "`", "```", "[a", "](", "http://x.y/z", ")", "<b>", "</b>", "<", ">", "- ", "1. ",
    "# ", "> ", "| a | b |", "|---|", "**", "_", "e.g. ", "Dr. ", "x.y", " ", "\\", "!", "[ ] ", '<point x="1" y="2"/>', "，", "。", "…", "~~~", "    "];
  const next = rng(1);
  for (let n = 0; n < 1500; n++) {
    const md = Array.from({ length: 5 + Math.floor(next() * 40) }, () => bits[Math.floor(next() * bits.length)]).join("");
    const want = whole(md, n % 2 === 0);
    assert.deepEqual(split(Array.from(md), n % 2 === 0), want, JSON.stringify(md));
    assert.deepEqual(split(cuts(md, 3, next), n % 2 === 0), want, JSON.stringify(md));
  }
});
