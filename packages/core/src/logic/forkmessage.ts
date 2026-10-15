// What a message of the thread draws for forking: its buttons, in the order shown, and the tree
// its branch marker is read from. The rules themselves are in forkpoints.ts and forktree.ts.
// DOM-free.

import type { AgentKind, TreeView } from "../types.ts";
import { sessionEnd, type Items, type MessageActions } from "./forkpoints.ts";
import { buildTree, withLive, type ChatTree } from "./forktree.ts";

/** A button of a message. at is the point count its action uses; Label has none. */
export type MessageButton = {
  id: "branchEdit" | "branch" | "forkEdit" | "fork" | "label";
  text: string;
  title: string;
  at?: number;
};

/** The buttons a message offers, in the order they are shown. labeled: the message has a label. */
export function messageButtons(a: MessageActions, items: Items, labeled: boolean): MessageButton[] {
  const out: MessageButton[] = [];
  if (a.branchEdit !== null) out.push({
    id: "branchEdit", at: a.branchEdit, text: "Branch and edit",
    title: "Start a new branch after the turn before this message, with the message back in the composer to edit",
  });
  if (a.branch !== null) out.push({
    id: "branch", at: a.branch, text: "Branch",
    title: sessionEnd(items, a.branch)
      ? "Carry on in a new branch; this one stays in the tree, ending here, to come back to"
      : "Continue from the end of this turn on a new branch",
  });
  if (a.forkEdit !== null) out.push({
    id: "forkEdit", at: a.forkEdit, text: "Fork and edit",
    title: "Copy the chat up to the turn before this message into a new chat, with the message as its draft",
  });
  if (a.fork !== null) out.push({ id: "fork", at: a.fork, text: "Fork to new", title: "Copy the chat up to here into a new chat" });
  if (a.label) out.push({ id: "label", text: labeled ? "Label ✓" : "Label", title: "Bookmark this entry in the tree" });
  return out;
}

/** view when it has the branch; undefined for a tree that is not loaded, or was loaded before
 *  the branch existed (it would be read as main). */
export function viewFor(view: TreeView | undefined, branch: string): TreeView | undefined {
  return view?.branches.some((b) => b.id === branch) ? view : undefined;
}

// The last tree built from each view: every message of a thread asks for the same one.
const built = new WeakMap<TreeView, { branch: string; agent: AgentKind; items: Items; tree: ChatTree }>();

/** The tree of a thread: view with the shown branch's own part rebuilt from its live items.
 *  Kept per view and item list. */
export function threadTree(view: TreeView, branch: string, agent: AgentKind, items: Items): ChatTree {
  const had = built.get(view);
  if (had && had.branch === branch && had.agent === agent && had.items === items) return had.tree;
  const tree = buildTree(withLive(view, branch, agent, items));
  built.set(view, { branch, agent, items, tree });
  return tree;
}
