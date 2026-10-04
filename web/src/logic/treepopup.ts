// The tree popup's own rules: its shortcut, what a row's right-click menu holds, which row it
// opens on, and what Esc does. The tree itself is logic/forktree.ts. DOM-free.

import { entryId, ownerOf, pathTo, rowActions, type ChatTree, type Row } from "./forktree.ts";

/** The shortcut's name, for titles. platform: navigator.platform. */
export const treeKeyName = (platform: string) => (/Mac|iPhone|iPad/.test(platform) ? "⌘⇧B" : "Ctrl+Shift+B");

/** ⌘⇧B / Ctrl+Shift+B. */
export const isTreeKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; code: string }) =>
  (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyB";

export type MenuItem =
  | { id: "branchEdit" | "forkEdit" | "fork"; label: string; at: number; disabled: boolean } // at: the point count
  | { id: "label"; label: string }
  | { id: "note"; label: string };

export const MID_TURN_NOTE = "Partway through a turn: branch from its last reply";

/**
 * A row's right-click menu. Your message: Branch and edit, Fork and edit, Label. A reply: Fork to
 * new chat, Label, and a note in place of Fork partway through a turn. While the agent is replying
 * (busy) the branch and fork items are there, disabled. Only Label is left in an archived or
 * legacy chat (readOnly) and at a point without an id; a reply still being written has none.
 */
export function menuItems(t: ChatTree, id: string, p: { busy: boolean; readOnly: boolean }): MenuItem[] {
  const e = t.entries[id];
  if (!e) return [];
  const a = rowActions(t, id, { busy: false, readOnly: p.readOnly }); // what it offers once the agent is done
  const out: MenuItem[] = [];
  if (e.item.kind === "user") {
    if (a.branchEdit !== null) out.push({ id: "branchEdit", label: "Branch and edit", at: a.branchEdit, disabled: p.busy });
    if (a.forkEdit !== null) out.push({ id: "forkEdit", label: "Fork and edit", at: a.forkEdit, disabled: p.busy });
  } else {
    if (a.fork !== null) out.push({ id: "fork", label: "Fork to new chat", at: a.fork, disabled: p.busy });
    if (a.midTurn) out.push({ id: "note", label: MID_TURN_NOTE });
  }
  if (e.item.kind === "user" || e.item.done) out.push({ id: "label", label: e.label ? "Relabel" : "Label" });
  return out;
}

/** The entry the popup opens on: the message it was opened at (index item of a branch's thread),
 *  else where the chat is. */
export function startEntry(t: ChatTree, focus?: { branch: string; item: number }): string | null {
  const id = focus ? entryId(ownerOf(t.view, focus.branch, focus.item), focus.item) : null;
  return id && t.entries[id] ? id : t.leaf;
}

/** The row shown as picked: the entry's own, else that of the nearest entry above it that has one. */
export function pickedRow(t: ChatTree, list: Row[], id: string | null): string | null {
  const ids = new Set(list.map((r) => r.id));
  return pathTo(t, id).reverse().find((x) => ids.has(x)) ?? null;
}

/** What Esc does in the open popup: it closes the menu, else clears the search, else closes the
 *  popup. "none": the key is another's (a dialog over the popup, the label field). */
export function escStep(p: { dialog: boolean; labeling: boolean; menu: boolean; query: string }): "none" | "menu" | "search" | "close" {
  if (p.dialog || p.labeling) return "none";
  if (p.menu) return "menu";
  return p.query ? "search" : "close";
}
