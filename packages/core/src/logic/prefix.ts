// The shared prefix: the part of a branch's or a fork's thread that is a copy of where it came
// from. Nothing in it is live in this copy. DOM-free.
import { MAIN, type Item, type Subagent, type TreeView } from "../types.ts";

/** The item count of the shown thread that is shared with where it came from. Main: the count a
 *  fork was made with (0 for a chat that is no fork, or one forked before the count was kept).
 *  Another branch: its `at` in the tree, also in a forked chat; 0 while the tree or the branch is
 *  not known. */
export function prefixEnd(tree: TreeView | undefined, branch: string, forkedAt?: number): number {
  if (!branch || branch === MAIN) return Math.max(0, forkedAt ?? 0);
  return Math.max(0, tree?.branches.find((b) => b.id === branch)?.at ?? 0);
}

/** Where the mark of the prefix's end is drawn in a thread shown with len items: before item
 *  `end`, which is after the last one when the thread has nothing of its own yet. null: no mark
 *  (no prefix, or the thread is shown cut inside it). */
export const prefixMark = (end: number, len: number): number | null => (end > 0 && len >= end ? end : null);

/** The mark's text: main's prefix is a fork's, another branch's is shared with its source. */
export const prefixText = (branch: string): string =>
  !branch || branch === MAIN ? "Copied from the chat this was forked from up to here" : "Shared with the branch this started from up to here";

/** Whether an item of the thread lies in the prefix. */
export const inPrefix = (index: number | undefined, end: number): boolean => index !== undefined && index < end;

/** Whether a subagent was started in the prefix: the tool call that started it, or the one that
 *  started the outermost subagent it is nested in, lies there. items is the chat's thread. */
export function subInPrefix(sa: Subagent | undefined, subs: Record<string, Subagent> | undefined, items: readonly (Item | null | undefined)[] | undefined, end: number): boolean {
  if (!sa || end <= 0) return false;
  let top = sa;
  for (let n = 0; top.parent && subs?.[top.parent] && n < 32; n++) top = subs[top.parent]; // n: a guard against a loop in the records
  if (!top.tool) return false;
  const i = (items ?? []).findIndex((it) => it?.kind === "tool" && it.toolId === top.tool);
  return i >= 0 && i < end;
}
