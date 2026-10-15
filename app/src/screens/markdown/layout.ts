// The space around blocks, from styles.css `.md …`: a block has a margin above and under it in em (of the text's size); the
// space between two blocks is the larger of the two, as CSS collapses them. No React and no react-native here.
import type { Block } from "./doc.ts";

export type Margins = [top: number, bottom: number];

/** Margins of a block in em, in a block of kind `inside` ("li" for a list item's content). */
export function marginsOf(b: Block, inside: "root" | "li" | "quote" | "group" = "root"): Margins {
  switch (b.k) {
    case "h": return [1, 0.4];
    case "hr": return [1, 1];
    case "p": return inside === "li" ? [0, b.tight ? 0 : 0.3] : [0, 0.6];
    case "list": return inside === "li" ? [0.15, 0.2] : [0, 0.6];
    case "li": return [0.15, 0.15];
    default: return [0, 0.6];
  }
}

/** The blocks to draw of a list of children (without the "\n" nodes), each with the em of space above it. */
export function spaced(kids: Block[], inside: "root" | "li" | "quote" | "group" = "root"): { block: Block; gap: number }[] {
  const out: { block: Block; gap: number }[] = [];
  let prev: Block | null = null;
  for (const b of kids) {
    if (b.k === "nl") continue;
    out.push({ block: b, gap: prev ? Math.max(marginsOf(prev, inside)[1], marginsOf(b, inside)[0]) : 0 });
    prev = b;
  }
  return out;
}
