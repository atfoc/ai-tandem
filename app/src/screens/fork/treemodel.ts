// What the tree popup says and decides apart from the rows (logic/forktree.ts and logic/treepopup.ts are the rules): the words of its foot
// for each state and pointer (B-TR-18, B-TR-21), the texts of the marks on a row (B-TR-11), and when a press opens a row (B-TR-08). No React
// here, so Node loads it.
import type { MarkOf } from "@aiwb/core/logic/treepopup.ts";

/** How a row opens: a mouse needs two presses on it within this many milliseconds (the double click), a finger one press on the row that is
 *  already picked (a double tap). */
export const DOUBLE_MS = 400;

/** Whether a press on `row` opens it: `last` is the row pressed before and when; `picked` the row that is picked now. */
export function opensOn(pointer: "mouse" | "touch", row: string, p: { picked: string | null; last: { row: string; at: number } | null; now: number }): boolean {
  if (pointer === "touch") return p.picked === row;
  return !!p.last && p.last.row === row && p.now - p.last.at <= DOUBLE_MS;
}

/** The foot's line. off: why the chat takes no call now (the tree is only to be read: the reason alone); readOnly: an archived or disabled chat
 *  (only Label); held: why opening is held now, which the foot says with how to fork or label. */
export function footText(p: { pointer: "mouse" | "touch"; off: string; readOnly: boolean; held: string }): { text: string; held: boolean } {
  const touch = p.pointer === "touch";
  if (p.off) return { text: p.off, held: true };
  if (p.readOnly) return { text: touch ? "Press and hold a message to label it." : "Right-click a message to label it.", held: false };
  if (p.held) return { text: `${p.held}. ${touch ? "Press and hold to fork or label." : "Right-click to fork or label."}`, held: true };
  return {
    text: touch
      ? "Tap a message twice to open the chat there; what you send next branches off. Press and hold to fork or label."
      : "Double-click a message to open the chat there; what you send next branches off. Right-click to fork or label.",
    held: false,
  };
}

/** The word on a branch's row and its tooltip (B-TR-11). */
export function markText(m: MarkOf): { text: string; title?: string } {
  switch (m.mark) {
    case "approval": return { text: "needs approval", title: "This branch needs your approval" };
    case "running": return { text: "working", title: "This branch is working" };
    case "subs": return { text: `${m.subs} ${m.subs === 1 ? "subagent" : "subagents"} running`, title: "This branch waits for its subagents" };
    case "error": return { text: "error", title: m.error };
    case "stopped": return { text: "stopped", title: "This branch's turn was cut short when the app stopped" };
  }
}

/** The tooltip of Stop on a marked row. */
export const stopTitle = (m: MarkOf): string => (m.mark === "subs" ? "Stop this branch's subagents" : "Stop this branch");

/** Why "Fork to new chat" at the end of a branch that works is off (the one item a busy branch disables). */
export const BUSY_FORK = "This branch is still working: fork from one of its finished turns, or wait for it";

/** The tree lines in front of a row, from its gutter ("│  ├─ "): a cell of three characters a level, and how each is drawn. */
export type GutterCell = "pipe" | "tee" | "elbow" | "blank";
export function gutterCells(g: string): GutterCell[] {
  return (g.match(/.{3}/g) ?? []).map((c) => (c[0] === "│" ? "pipe" : c[0] === "├" ? "tee" : c[0] === "└" ? "elbow" : "blank"));
}

/** The head's second part: "<chat title> · N branches · M forks". */
export function headSub(title: string, branches: number, forks: number): string {
  return `${title} · ${branches} ${branches === 1 ? "branch" : "branches"}${forks > 0 ? ` · ${forks} ${forks === 1 ? "fork" : "forks"}` : ""}`;
}
