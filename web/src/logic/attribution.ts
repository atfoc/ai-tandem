// Who edited the board: the agent, and the branch of the chat it runs on once the chat has more
// than one ("last write wins, attributed by branch"). DOM-free.

import { agentShortName } from "../agents.ts";
import { buildTree, nameOfBranch } from "./forktree.ts";
import type { TreeView } from "../types.ts";

/** The label of an agent's edit: the agent's short name, and the branch's name when one is given. */
export function editLabel(agent: string, branchName?: string): string {
  const short = agentShortName(agent);
  return branchName ? `${short} · ${branchName}` : short;
}

/**
 * The name to show for the branch a board tool call came from; undefined when there is none to
 * show: the chat has one branch, its tree is not loaded, or the tree does not list the branch yet
 * (one being created) or has nothing of its own for it to be named by.
 */
export function branchNameFor(view: TreeView | undefined, branch: string | undefined): string | undefined {
  if (!view || !branch || view.branches.length < 2) return undefined;
  if (!view.branches.find((b) => b.id === branch)?.items.length) return undefined;
  return nameOfBranch(buildTree(view), branch);
}
