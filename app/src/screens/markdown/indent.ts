// A user's message shows its indented lines as typed (the composer edits like code: Tab and Enter keep an indent). Markdown would
// drop that indent: a paragraph's continuation lines lose their leading white space, and a run of lines indented four columns is an
// indented code block. So a user's message is parsed with no indented code (`noIndentedCode`), and `keepIndent` puts the white space
// that started each line of a paragraph back into its text, from the source, before remark-breaks cuts the lines; doc.ts keeps it as an
// `indent` node and the drawing keeps it from collapsing. Lists and fenced code are parsed as before. Display only: the message's text
// is not changed. No React and no react-native here, so Node loads it.
import type { Nodes, Paragraph, PhrasingContent, Root } from "mdast";
import type { Processor } from "unified";

/** micromark without indented code: four columns of indent start no code block (and, as micromark then allows, any indent is allowed
 *  before a list's marker or a quote's). */
export function noIndentedCode(this: Processor) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push({ disable: { null: ["codeIndented"] } });
}

/** The containers whose children start at a column of their own: the column of their first child. */
const CONTAINERS = new Set(["listItem", "blockquote", "footnoteDefinition"]);

/** Puts back the white space that started each line of a paragraph (a remark transformer; it needs the parsed file's text). */
export function keepIndent() {
  return (tree: Root, file: { value?: unknown }) => {
    const source = String(file.value ?? "");
    const starts = [0, 0]; // starts[line]: the offset of the 1-based line
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    walk(tree, 0, source, starts);
  };
}

type Pos = { line: number; offset?: number };

function walk(node: Nodes, base: number, source: string, starts: number[]): void {
  if (node.type === "paragraph") { paragraph(node, base, source, starts); return; }
  if (!("children" in node)) return;
  const first = node.children[0]?.position?.start;
  const inner = CONTAINERS.has(node.type) && first?.offset !== undefined ? first.offset - starts[first.line] : base;
  for (const c of node.children as Nodes[]) walk(c, inner, source, starts);
}

/** The line `n` of the source, without its line ending. */
const lineOf = (source: string, starts: number[], n: number): string => {
  const end = n + 1 < starts.length ? starts[n + 1] - 1 : source.length;
  return source.slice(starts[n] ?? source.length, end).replace(/\r$/, "");
};

function paragraph(p: Paragraph, base: number, source: string, starts: number[]): void {
  /** The indent of line `n`, past the container's column; "" for a line whose start is no container's prefix (a lazy line). */
  const indentOf = (n: number): string => {
    const line = lineOf(source, starts, n);
    if (!/^[ \t>]*$/.test(line.slice(0, base))) return "";
    return /^[ \t]*/.exec(line.slice(base))![0];
  };
  /** The white space between the container's column and a node that starts a line. */
  const before = (at: Pos): string => {
    if (at.offset === undefined) return "";
    const line = lineOf(source, starts, at.line), col = at.offset - starts[at.line];
    const ws = line.slice(base, col);
    return col > base && /^[ \t]+$/.test(ws) && /^[ \t>]*$/.test(line.slice(0, base)) ? ws : "";
  };
  const start = p.position?.start;
  if (start) prepend(p.children, before(start));
  fix(p.children, indentOf, before, source);
}

/** The phrasing nodes with the indent put back after each line break in them. */
function fix(kids: PhrasingContent[], indentOf: (n: number) => string, before: (at: Pos) => string, source: string): void {
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i], pos = n.position;
    if (i && kids[i - 1].type === "break" && pos) {
      const ws = before(pos.start);
      if (ws) {
        if (n.type === "text") n.value = ws + n.value;
        else { kids.splice(i, 0, { type: "text", value: ws }); i++; }
      }
    }
    if (n.type === "text" && pos && pos.start.offset !== undefined && pos.end.offset !== undefined && n.value.includes("\n")) {
      // (only when the text's line breaks are the source's: a character reference such as &#10; is one in the text and none in the source)
      const breaks = (s: string) => s.split("\n").length - 1;
      if (breaks(n.value) === breaks(source.slice(pos.start.offset, pos.end.offset))) {
        let line = pos.start.line;
        n.value = n.value.replace(/\n/g, () => "\n" + indentOf(++line));
      }
    }
    if ("children" in n) fix(n.children as PhrasingContent[], indentOf, before, source);
  }
}

function prepend(kids: PhrasingContent[], ws: string): void {
  if (!ws) return;
  if (kids[0]?.type === "text") kids[0].value = ws + kids[0].value;
  else kids.unshift({ type: "text", value: ws });
}

/** The white space at the start of a text as spaces, a tab to the next stop of `width` columns (the native targets, where a tab's
 *  width cannot be set). */
export function expandIndent(ws: string, width: number): string {
  let out = "";
  for (const c of ws) out += c === "\t" ? " ".repeat(width - (out.length % width)) : c;
  return out;
}
