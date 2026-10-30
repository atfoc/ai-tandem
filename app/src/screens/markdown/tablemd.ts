// A table written back as GFM Markdown, for the viewer's Copy (ux-improvements goal 3.5): the alignment row, a `|` in a cell escaped,
// and the inline content of a cell (code, emphasis, links) as the Markdown it was read from. Pure: no React Native.
import type { Block, Cell, Inline } from "./doc.ts";

type Table = Extract<Block, { k: "table" }>;

/** A run of text with what Markdown would read as markup escaped (an underscore inside a word is plain, and stays so). */
const plain = (v: string): string =>
  v.replace(/[\\`*[\]|~<_]/g, (m, at: number) => (m === "_" && /[a-z0-9]/i.test(v[at - 1] ?? "") && /[a-z0-9]/i.test(v[at + 1] ?? "") ? m : `\\${m}`));

/** Inline code: a fence one backtick longer than the longest run inside, padded when the text starts or ends with a backtick. */
function code(v: string): string {
  const run = Math.max(0, ...(v.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(run + 1);
  const pad = v.startsWith("`") || v.endsWith("`") ? " " : "";
  return `${fence}${pad}${v.replace(/\|/g, "\\|")}${pad}${fence}`;
}

/** The inline nodes of a cell as Markdown on one line. */
export function inlineMarkdown(kids: Inline[]): string {
  return kids.map((n): string => {
    switch (n.k) {
      case "text": case "indent": return plain(n.v.replace(/\s+/g, " "));
      case "br": return "<br>";
      case "code": return code(n.v);
      case "em": return `*${inlineMarkdown(n.kids)}*`;
      case "strong": return `**${inlineMarkdown(n.kids)}**`;
      case "del": return `~~${inlineMarkdown(n.kids)}~~`;
      case "sup": return `<sup>${inlineMarkdown(n.kids)}</sup>`;
      case "link": return n.href.startsWith("#") ? inlineMarkdown(n.kids) : `[${inlineMarkdown(n.kids)}](${n.href.replace(/[()\s]/g, encodeURIComponent)})`;
      case "chip": return n.tag + n.after;
      case "mention": return n.raw;
      case "check": return n.checked ? "[x] " : "[ ] ";
    }
  }).join("");
}

const cellMarkdown = (c: Cell | undefined): string => (c ? inlineMarkdown(c.kids).trim() : "");

const rule = (align: string | null): string => (align === "left" ? ":---" : align === "right" ? "---:" : align === "center" ? ":---:" : "---");

/** The table as GFM Markdown: the header row, the alignment row, the body rows. A table without a header gets an empty one (GFM has no other). */
export function tableMarkdown(block: Table): string {
  const columns = block.align.length || block.head.length || Math.max(0, ...block.rows.map((r) => r.length));
  const line = (cells: (Cell | undefined)[]) => `| ${Array.from({ length: columns }, (_, i) => cellMarkdown(cells[i])).join(" | ")} |`;
  return [
    line(block.head),
    `| ${Array.from({ length: columns }, (_, i) => rule(block.align[i] ?? null)).join(" | ")} |`,
    ...block.rows.map(line),
  ].join("\n");
}

/** "4 columns, 3 rows" (the viewer's bar): singular for one, the header row not counted. */
export function tableSize(block: Table): string {
  const columns = block.align.length || block.head.length;
  const rows = block.rows.length;
  return `${columns} column${columns === 1 ? "" : "s"}, ${rows} row${rows === 1 ? "" : "s"}`;
}
