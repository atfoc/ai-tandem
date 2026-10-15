// The `tree` event applied to a chat's kept tree: each part the event has replaces that part.
import type { TreeBranchView, TreeLabel, TreeView } from "../types.ts";

/** branch: one branch's own part, as the tree's fetch would give it now; labels: all labels of
 *  the chat; current: the branch last sent to. */
export type TreePatch = { branch?: TreeBranchView; labels?: TreeLabel[]; current?: string };

/** The tree with the patch's parts put in: the branch replaces the one of its id, and is appended
 *  when the tree has none (the order is the one of creation). A new object; the input is not changed. */
export function patchTree(view: TreeView, p: TreePatch): TreeView {
  const b = p.branch;
  const branches = !b ? view.branches
    : view.branches.some((x) => x.id === b.id) ? view.branches.map((x) => (x.id === b.id ? b : x))
    : [...view.branches, b];
  return { current: p.current ?? view.current, branches, labels: p.labels ?? view.labels };
}
