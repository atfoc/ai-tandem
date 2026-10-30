// The Markdown of a message (screens/markdown, AD-75): what is shown for each kind of text (the tree to draw), the block memo of a
// growing answer, the code colours and the space between blocks. The displayed text, which quotes count in, is held to the page's DOM
// by markdown.displayed.test.ts; the split into blocks, the chips' and mentions' slots by core's test/markdown.test.ts.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { pointRef, selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { THEME_TOKENS } from "../src/ui/tokens.ts";
import { safeUrl, trimLines, type Block, type Inline } from "../src/screens/markdown/doc.ts";
import { forget, blocksOf, prepare, stats } from "../src/screens/markdown/parse.ts";
import { messageText } from "../src/screens/markdown/displayed.ts";
import { expandIndent } from "../src/screens/markdown/indent.ts";
import { highlightRuns, MAX_HIGHLIGHTED, type SyntaxTone } from "../src/screens/markdown/highlight.ts";
import { marginsOf, spaced } from "../src/screens/markdown/layout.ts";

beforeEach(() => { forget(); stats.parses = 0; stats.renders = 0; });

const docOf = (text: string, user = false) => blocksOf(text).flatMap((b) => prepare(b, user).kids).filter((b) => b.k !== "nl");
/** The inline nodes of the first paragraph of a text. */
const inlinesOf = (text: string, user = false): Inline[] => {
  const p = docOf(text, user).find((b): b is Extract<Block, { k: "p" }> => b.k === "p");
  assert.ok(p, `no paragraph in ${JSON.stringify(text)}`);
  return p.kids;
};

test("raw HTML is shown as text, never as an element (B-MD-02)", () => {
  assert.deepEqual(inlinesOf("a <b>bold</b> c"), [{ k: "text", v: "a " }, { k: "text", v: "<b>" }, { k: "text", v: "bold" }, { k: "text", v: "</b>" }, { k: "text", v: " c" }]);
  const block = docOf("<div onclick=\"x()\">\nhi\n</div>");
  assert.deepEqual(block, [{ k: "p", kids: [{ k: "text", v: "<div onclick=\"x()\">\nhi\n</div>" }] }]);
});

test("a link with an unsafe protocol is dropped, one with no address is plain text (B-MD-02, 03)", () => {
  assert.deepEqual(inlinesOf("[bad](javascript:alert(1)) and [data](data:text/html,x) and [vb](VBSCRIPT:x)"),
    [{ k: "text", v: "bad" }, { k: "text", v: " and " }, { k: "text", v: "data" }, { k: "text", v: " and " }, { k: "text", v: "vb" }]);
  assert.deepEqual(inlinesOf("[none]()"), [{ k: "text", v: "none" }]);
  assert.deepEqual(inlinesOf("[ok](https://x.org/a?b=c) [rel](/p/q) [mail](mailto:a@b.c) [frag](#x) [q](?a=b:c)").filter((n) => n.k === "link").map((n) => n.k === "link" && n.href),
    ["https://x.org/a?b=c", "/p/q", "mailto:a@b.c", "#x", "?a=b:c"]);
});

test("safeUrl is react-markdown's default urlTransform", () => {
  for (const ok of ["http://a", "HTTPS://a", "irc://a", "ircs://a", "mailto:a@b", "xmpp:a@b", "/a:b", "a/b:c", "?a:b", "#a:b", "relative", ""]) assert.equal(safeUrl(ok), ok, ok);
  for (const bad of ["javascript:x", "data:x", "file:///x", "tel:1", "ftp://a", " javascript:x"]) assert.equal(safeUrl(bad), "", bad);
});

test("an image is a link showing its alt text, else its address; nothing is fetched (B-MD-04)", () => {
  assert.deepEqual(inlinesOf("![alt](https://x.org/i.png)"), [{ k: "link", href: "https://x.org/i.png", kids: [{ k: "text", v: "alt" }] }]);
  assert.deepEqual(inlinesOf("![](https://x.org/i.png)"), [{ k: "link", href: "https://x.org/i.png", kids: [{ k: "text", v: "https://x.org/i.png" }] }]);
  assert.deepEqual(inlinesOf("![alt](javascript:x)"), [{ k: "text", v: "alt" }]);
  assert.deepEqual(inlinesOf("a ![](javascript:x) b"), [{ k: "text", v: "a " }, { k: "text", v: " b" }]);
});

test("a fence's language is the first word of its info; the code ends with the line break the page's <pre> has", () => {
  assert.deepEqual(docOf("```ts title=\"x\"\nlet a;\n```"), [{ k: "code", lang: "ts", text: "let a;\n" }]);
  assert.deepEqual(docOf("```\n```"), [{ k: "code", lang: "", text: "" }]);
});

test("a reference tag is a chip with the punctuation after it, a mention only in a user's message (B-MD-08, 10)", () => {
  const sel = serializeRef(selectionRef([{ id: "r1", type: "rectangle", label: "API", x: 0, y: 0, width: 5, height: 5 }])!);
  const pt = serializeRef(pointRef(5, 7));
  const kids = inlinesOf(`see ${sel}, and ${pt}. then @Plan`);
  assert.deepEqual(kids.map((n) => n.k), ["text", "chip", "text", "chip", "text"]);
  const [, a, , b] = kids as Extract<Inline, { k: "chip" }>[];
  assert.deepEqual([a.ref.kind, a.after, b.ref.kind, b.after], ["selection", ",", "point", "."]);
  assert.equal(kids.some((n) => n.k === "mention"), false);
  const user = inlinesOf(`${sel} @Plan, and me@x.org`, true);
  assert.deepEqual(user.filter((n) => n.k === "mention").map((n) => n.k === "mention" && n.raw), ["@Plan"]);
});

test("inside code and links a reference tag and an @name stay as typed text (B-MD-09)", () => {
  const sel = serializeRef(selectionRef([{ id: "r1", type: "rectangle", label: "API", x: 0, y: 0, width: 5, height: 5 }])!);
  const kids = inlinesOf(`\`${sel}\` and [${sel} @Plan](https://x.org)`, true);
  assert.deepEqual(kids[0], { k: "code", v: sel });
  const link = kids.find((n) => n.k === "link") as Extract<Inline, { k: "link" }>;
  assert.deepEqual(link.kids, [{ k: "text", v: `${sel} @Plan` }]);
  const fence = docOf("```\n" + sel + " @Plan\n```", true)[0] as Extract<Block, { k: "code" }>;
  assert.equal(fence.text, `${sel} @Plan\n`);
});

test("a user's single line breaks are kept, an answer's are not", () => {
  assert.deepEqual(inlinesOf("a\nb", true).map((n) => n.k), ["text", "br", "text"]);
  assert.deepEqual(inlinesOf("a\nb").map((n) => n.k), ["text"]);
});

/** A user's message as lines: each paragraph line's indent (or "") and its text; a list item as "• " and its text. */
function linesOf(text: string): string[] {
  const out: string[] = [];
  const flat = (kids: Inline[]): string => kids.map((n) => (n.k === "text" || n.k === "indent" || n.k === "code" ? n.v : n.k === "br" ? "\n" : "kids" in n ? flat(n.kids) : "")).join("");
  const walk = (b: Block, bullet = "") => {
    if (b.k === "p") flat(b.kids).split("\n").forEach((l: string, i: number) => out.push((i ? "" : bullet) + l));
    else if (b.k === "li") b.kids.filter((k) => k.k !== "nl").forEach((k, i) => walk(k, i ? "" : "• "));
    else if (b.k === "code") out.push("```" + b.text);
    else if (b.k === "quote" || b.k === "list" || b.k === "group") b.kids.forEach((k) => walk(k));
  };
  docOf(text, true).forEach((b) => walk(b));
  return out;
}

test("a user's indented lines keep their indent as typed; lists and fences are drawn as before (an answer's are not)", () => {
  assert.deepEqual(linesOf("a:\n\tone\n\ttwo\n- three\n- four"), ["a:", "\tone", "\ttwo", "• three", "• four"]);
  assert.deepEqual(linesOf("if x:\n    y = 1\n    z = 2"), ["if x:", "    y = 1", "    z = 2"]);
  assert.deepEqual(linesOf("steps:\n  - one\n    - nested"), ["steps:", "• one", "• nested"]);
  // a run of indented lines is no code block, its first line's indent kept too
  assert.deepEqual(linesOf("    y = 1\n    z = 2"), ["    y = 1", "    z = 2"]);
  assert.deepEqual(linesOf("a\n\n\tb\n\t\tc"), ["a", "\tb", "\t\tc"]);
  // the indent is past the container's own column: a list item's continuation, a quote's lines; a lazy line has none
  assert.deepEqual(linesOf("- one\n  more\n    deeper"), ["• one", "more", "  deeper"]);
  assert.deepEqual(linesOf("> q\n>   r"), ["q", "  r"]);
  assert.deepEqual(linesOf("- one\nlazy"), ["• one", "lazy"]);
  // a line that starts with an inline: its indent stands before it
  assert.deepEqual(linesOf("x\n  `code` and *em*"), ["x", "  code and em"]);
  // fenced code is as it was
  assert.deepEqual(linesOf("```\n\tcode\n```"), ["```\tcode\n"]);
  // an indent is its own node, and the displayed text (quotes) has it
  assert.deepEqual(inlinesOf("a\n\tb", true), [{ k: "text", v: "a" }, { k: "br" }, { k: "indent", v: "\t" }, { k: "text", v: "b" }]);
  assert.equal(messageText("if x:\n    y = 1", true), "if x:\n    y = 1");
  // an answer is drawn as before
  assert.deepEqual(docOf("    y = 1\n    z = 2").map((b) => b.k), ["code"]);
  assert.deepEqual(inlinesOf("if x:\n    y = 1"), [{ k: "text", v: "if x:\ny = 1" }]);
});

test("expandIndent draws an indent's tabs as spaces to the next tab stop", () => {
  assert.equal(expandIndent("\t", 4), "    ");
  assert.equal(expandIndent("  \t", 4), "    ");
  assert.equal(expandIndent("\t \t", 2), "    ");
  assert.equal(expandIndent("\t", 8), " ".repeat(8));
  assert.equal(expandIndent("   ", 4), "   ");
});

test("trimLines drops the white space at the ends of lines, not of the text", () => {
  assert.equal(trimLines("  a  \n  b  \n  c  "), "  a\nb\nc  ");
  assert.equal(trimLines("a\t\r\n\tb"), "a\r\nb");
});

test("a task list item has its box, then a space, then its text", () => {
  const list = docOf("- [x] done\n- [ ] open")[0] as Extract<Block, { k: "list" }>;
  assert.equal(list.task, true);
  const items = list.kids.filter((b) => b.k === "li") as Extract<Block, { k: "li" }>[];
  const p = items[0].kids.find((b) => b.k === "p") as Extract<Block, { k: "p" }>;
  assert.deepEqual(p.kids, [{ k: "check", checked: true }, { k: "text", v: " " }, { k: "text", v: "done" }]);
});

test("footnotes are collected at the end, with a back link", () => {
  const blocks = docOf("Text[^a] and[^a].\n\n[^a]: The note.");
  const group = blocks[blocks.length - 1] as Extract<Block, { k: "group" }>;
  assert.equal(group.k, "group");
  const text = JSON.stringify(group);
  assert.ok(text.includes("Footnotes") && text.includes("The note.") && text.includes("↩"));
});

// ---- the block memo (B-MD-11, goal 4.8)

const ANSWER = "The build is slow.\n\nThe fix has steps:\n\n- check\n- copy\n\nIn code:\n\n```js\nlet a = 1;\n\nlet b = 2;\n```\n\nThat is all.";

test("a block is parsed once, the same tree comes back for the same text", () => {
  const a = prepare("# One\n\ntext".split("\n\n")[0]);
  assert.equal(prepare("# One"), a);
  assert.equal(stats.parses, 1);
  assert.notEqual(prepare("# One", true), a, "a user's text is parsed with its own plugins");
  assert.equal(stats.parses, 2);
});

test("while an answer grows only its last block is parsed again", () => {
  let chunks = 0;
  const trees: object[][] = [];
  for (let n = 3; n <= ANSWER.length + 2; n += 3) {
    chunks++;
    trees.push(blocksOf(ANSWER.slice(0, n), n < ANSWER.length).map((b) => prepare(b)));
  }
  // the blocks above the last of each step are the very objects of the step before (a memoized component is not drawn again)
  for (let i = 1; i < trees.length; i++) {
    const was = trees[i - 1], now = trees[i];
    for (let j = 0; j < was.length - 1; j++) if (now[j] !== was[j]) assert.fail(`step ${i}: block ${j} of ${now.length} was parsed again`);
  }
  // one parse for each text the last block had, and one more for a block that a chunk ends and starts the next with
  const blocks = blocksOf(ANSWER).length;
  assert.ok(stats.parses <= chunks + blocks, `${stats.parses} parses for ${chunks} chunks and ${blocks} blocks`);
  // parsing every block at every step is what this prevents
  const naive = Array.from({ length: chunks }, (_, i) => blocksOf(ANSWER.slice(0, (i + 1) * 3)).length).reduce((a, b) => a + b, 0);
  assert.ok(stats.parses < naive * 0.6, `${stats.parses} parses, against ${naive} when every block is parsed at every step`);
});

test("a reference tag that is still being written is not drawn while it streams", () => {
  assert.deepEqual(blocksOf("Look at <selection ids=\"a1\" lab", true), ["Look at "]);
  assert.deepEqual(blocksOf("Look at <selection ids=\"a1\" lab", false), ["Look at <selection ids=\"a1\" lab"]);
});

test("the kept trees are bounded", () => {
  for (let i = 0; i < 1000; i++) prepare(`block ${i}`);
  assert.equal(stats.parses, 1000);
  prepare("block 999");
  assert.equal(stats.parses, 1000, "a recent block is kept");
  prepare("block 0");
  assert.equal(stats.parses, 1001, "an old one has gone");
});

// ---- code (B-MD-05)

const known = ["bash", "sh", "shell", "zsh", "css", "diff", "patch", "go", "golang", "javascript", "js", "jsx", "mjs", "json", "markdown", "md", "python", "py", "rust", "rs", "sql", "typescript", "ts", "tsx", "xml", "html", "svg", "yaml", "yml"];

test("a fence that names a known language (or its alias) is coloured; an unknown one, or none, is plain", () => {
  for (const l of known) assert.ok(highlightRuns(l, "x") !== null, l);
  for (const l of ["", "nosuch", "text", "plaintext", "cpp", "java"]) assert.equal(highlightRuns(l, "x"), null, l);
});

test("a language is coloured with the page's rules: keyword, string, number, comment (faint, italic), title, type", () => {
  const tones = (lang: string, code: string) => Object.fromEntries(highlightRuns(lang, code)!.filter((r) => r.tone).map((r) => [r.v, r.tone]));
  assert.deepEqual(tones("js", "const a = \"s\"; // c\nlet n = 42;"), { const: "synKeyword", '"s"': "synString", "// c": "faint", let: "synKeyword", "42": "synNumber" });
  assert.equal(highlightRuns("js", "// c")![0].italic, true);
  assert.equal(tones("ts", "class Foo extends Bar {}").Foo, "synType");
  assert.equal(tones("js", "function foo() {}").foo, "synTitle");
  assert.equal(tones("json", '{"a": 1}')['"a"'], "synAttr");
  assert.equal(tones("diff", "-gone\n+added")["-gone"], "danger");
  assert.equal(tones("diff", "-gone\n+added")["+added"], "synString");
});

test("the runs hold the code, exactly", () => {
  const code = "import x from \"y\";\nconst a = `t ${1 + 2}`;\n\n\tif (a) { return 1 }\n";
  assert.equal(highlightRuns("ts", code)!.map((r) => r.v).join(""), code);
  const sh = "echo \"hi\"   # c\nls -la | grep 'x'\n";
  assert.equal(highlightRuns("sh", sh)!.map((r) => r.v).join(""), sh);
});

test("code too long to colour is shown plain", () => {
  assert.equal(highlightRuns("js", "x".repeat(MAX_HIGHLIGHTED + 1)), null);
});

test("every token a code colour names is a token of the theme, in light and dark", () => {
  const names: SyntaxTone[] = ["faint", "synKeyword", "synString", "synNumber", "synTitle", "synType", "synAttr", "muted", "danger"];
  for (const theme of Object.values(THEME_TOKENS)) for (const n of names) assert.match(theme[n], /^#[0-9a-f]{6}$/i, n);
});

// ---- the space between blocks (styles.css `.md …`, collapsed as CSS does)

test("the space between two blocks is the larger of the margins, as CSS collapses them", () => {
  const gaps = (text: string) => spaced(docOf(text)).map((s) => s.gap);
  assert.deepEqual(gaps("a\n\nb"), [0, 0.6]);
  assert.deepEqual(gaps("a\n\n# h\n\nb"), [0, 1, 0.4]);
  assert.deepEqual(gaps("# h\n\n# i"), [0, 1]);
  assert.deepEqual(marginsOf({ k: "hr" }), [1, 1]);
  assert.deepEqual(marginsOf({ k: "p", kids: [], tight: true }, "li"), [0, 0]);
  assert.deepEqual(marginsOf({ k: "p", kids: [] }, "li"), [0, 0.3]);
});
