// The Markdown of a message on an engine that is not Node's (package S5, AD-75: micromark uses Unicode property escapes in RegExp,
// which Hermes must run). `selfTest()` parses, lowers and colours the fixtures and answers a line for each, as JSON; the same lines
// from Node and from Hermes must be equal. Node: test/markdown.hermes.test.ts; Hermes: markdownselftest.hermes.ts, bundled by Metro,
// is run by a host of the engine's own runtime (plans/rn-rewrite/s5-markdown-hermes.md says how). No React and no react-native here.
import { highlightRuns } from "../screens/markdown/highlight.ts";
import { messageText } from "../screens/markdown/displayed.ts";
import { blocksOf, prepare } from "../screens/markdown/parse.ts";
import { CORPUS } from "./markdownfixtures.ts";

/** One code sample for each language the highlighter has, by the alias a fence would name. */
export const CODE: [string, string][] = [
  ["bash", "#!/bin/bash\nfor f in *.go; do echo \"$f\" | grep -v 'x' > /dev/null; done"],
  ["sh", "ls -la && cd /tmp || exit 1"],
  ["shell", "$ npm install\nadded 3 packages"],
  ["css", "a:hover > .b { color: #fff; margin: 0 auto; } @media (max-width: 600px) { .c { display: none } }"],
  ["diff", "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context"],
  ["go", "package main\n\nfunc main() {\n\tfmt.Println(\"hi\", 42) // c\n}"],
  ["js", "const f = async (a, ...b) => { await x?.y ?? `t${a}`; return /re+/g.test(a) };\nclass A extends B { static #p = 1 }"],
  ["json", "{ \"a\": [1, 2.5e3, true, null], \"b\": { \"c\": \"d\" } }"],
  ["markdown", "# Title\n\n- item with `code` and **strong**\n\n> quote [link](http://x)"],
  ["py", "import os\n\nclass A(B):\n    def f(self, x: int = 3) -> str:\n        return f\"{x}\"  # c"],
  ["rust", "fn main() { let v: Vec<i32> = vec![1, 2]; match v.len() { 0 => (), _ => println!(\"{}\", 'a') } }"],
  ["sql", "SELECT a, COUNT(*) FROM t WHERE b > 3 AND c LIKE 'x%' GROUP BY a ORDER BY 2 DESC;"],
  ["ts", "interface A<T> { x: T; y?: readonly string[] }\nexport function f<T extends A<number>>(a: T): Promise<void> { return a as unknown as Promise<void> }"],
  ["html", "<!doctype html>\n<div class=\"a\" id='b'>text &amp; <b>bold</b><!-- c --><script>let x = 1</script></div>"],
  ["yml", "a: 1\nb:\n  - x\n  - \"y\"\nc: |\n  text\n# comment"],
];

/** A line for each fixture and sample: the same on every engine. */
export function selfTest(): string[] {
  const lines: string[] = [];
  for (const [name, text] of CORPUS) {
    for (const user of [false, true]) {
      lines.push(JSON.stringify([name, user, messageText(text, user), blocksOf(text).map((b) => prepare(b, user))]));
    }
  }
  for (const [lang, code] of CODE) lines.push(JSON.stringify([lang, highlightRuns(lang, code)]));
  return lines;
}
