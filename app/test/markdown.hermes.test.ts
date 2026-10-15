// The self-test of the Markdown on another engine (src/dev/markdownselftest.ts) gives, here on Node, what it gave on Hermes when it
// was last run there: test/fixtures/markdown-selftest.json holds those lines, written by `WRITE=1 node --test …` on Node and
// checked equal to the lines Hermes printed (plans/rn-rewrite/s5-markdown-hermes.md). A change of the parser, the lowering or the
// highlighter that changes a line fails here until the file is written again, and the Hermes run is repeated.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { selfTest } from "../src/dev/markdownselftest.ts";

const file = fileURLToPath(new URL("./fixtures/markdown-selftest.json", import.meta.url));

test("the self-test's lines are the ones recorded", () => {
  const lines = selfTest();
  if (process.env.WRITE === "1") fs.writeFileSync(file, JSON.stringify(lines, null, 1) + "\n");
  const recorded = JSON.parse(fs.readFileSync(file, "utf8")) as string[];
  assert.equal(lines.length, recorded.length);
  lines.forEach((l, i) => assert.equal(l, recorded[i], `line ${i}`));
});
