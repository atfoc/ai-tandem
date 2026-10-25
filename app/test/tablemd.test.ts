// A table written back as Markdown (screens/markdown/tablemd.ts), for the table viewer's Copy.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Block } from "../src/screens/markdown/doc.ts";
import { blocksOf, prepare } from "../src/screens/markdown/parse.ts";
import { tableMarkdown, tableSize } from "../src/screens/markdown/tablemd.ts";

const tableOf = (text: string): Extract<Block, { k: "table" }> => {
  const t = blocksOf(text).flatMap((b) => prepare(b, false).kids).find((b): b is Extract<Block, { k: "table" }> => b.k === "table");
  assert.ok(t, `no table in ${JSON.stringify(text)}`);
  return t;
};

test("a table is written with its alignment row", () => {
  const src = "| Option | Cents | Note |\n| :--- | ---: | :---: |\n| Boolean | 1 | ok |\n| Column | 22 | no |";
  assert.equal(tableMarkdown(tableOf(src)), src);
});

test("no alignment is written as plain dashes", () => {
  assert.equal(tableMarkdown(tableOf("a|b\n-|-\n1|2")), "| a | b |\n| --- | --- |\n| 1 | 2 |");
});

test("a pipe in a cell is escaped, in text and in code", () => {
  const out = tableMarkdown(tableOf("| a | b |\n| - | - |\n| x \\| y | `p\\|q` |"));
  assert.equal(out, "| a | b |\n| --- | --- |\n| x \\| y | `p\\|q` |");
  assert.equal(tableOf(out).rows[0].length, 2);
});

test("code, emphasis, strikethrough and links come back as Markdown", () => {
  const src = "| a | b | c |\n| --- | --- | --- |\n| `x` | *it* **bold** ~~gone~~ | [the docs](https://example.com/a) |";
  assert.equal(tableMarkdown(tableOf(src)), src);
});

test("code with a backtick in it gets a longer fence", () => {
  const out = tableMarkdown(tableOf("| a |\n| - |\n| ``a`b`` |"));
  assert.equal(out, "| a |\n| --- |\n| ``a`b`` |");
});

test("text that looks like markup is escaped and reads back the same", () => {
  const t = tableOf("| a |\n| - |\n| 2 \\* 3 and snake_case \\[x\\] |");
  const out = tableMarkdown(t);
  assert.equal(out, "| a |\n| --- |\n| 2 \\* 3 and snake_case \\[x\\] |");
  assert.deepEqual(tableOf(out).rows, t.rows);
});

test("an empty cell stays empty and a short row is padded", () => {
  assert.equal(tableMarkdown(tableOf("| a | b |\n| - | - |\n| | 2 |")), "| a | b |\n| --- | --- |\n|  | 2 |");
});

test("the size line counts columns and rows, singular for one", () => {
  assert.equal(tableSize(tableOf("| a | b | c | d |\n| - | - | - | - |\n| 1 | 2 | 3 | 4 |\n| 1 | 2 | 3 | 4 |\n| 1 | 2 | 3 | 4 |")), "4 columns, 3 rows");
  assert.equal(tableSize(tableOf("| a |\n| - |\n| 1 |")), "1 column, 1 row");
});
