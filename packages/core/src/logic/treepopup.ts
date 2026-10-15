// The tree popup's own rules: its shortcut, what a row's right-click menu holds, which row it
// opens on, and what Esc does. The tree itself is logic/forktree.ts. DOM-free.

import { MAIN, type BranchState, type Catalog } from "../types.ts";
import { entryId, ownerOf, pathTo, rowActions, tipOf, type ChatTree, type Row } from "./forktree.ts";
import { effortLabel } from "./labels.ts";
import { isBusy } from "./status.ts";

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
 * new chat, Label, and a note in place of Fork partway through a turn. busy holds the ids of the
 * branches whose turn is running (see rowActions): the only item it disables is Fork to new chat
 * at the end of a busy branch, which is there again once the branch is done. Only Label is left
 * in an archived or legacy chat (readOnly) and at a point without an id; a reply still being
 * written has none.
 */
export function menuItems(t: ChatTree, id: string, p: { busy: ReadonlySet<string>; readOnly: boolean }): MenuItem[] {
  const e = t.entries[id];
  if (!e) return [];
  const a = rowActions(t, id, p);
  const out: MenuItem[] = [];
  if (e.item.kind === "user") {
    if (a.branchEdit !== null) out.push({ id: "branchEdit", label: "Branch and edit", at: a.branchEdit, disabled: false });
    if (a.forkEdit !== null) out.push({ id: "forkEdit", label: "Fork and edit", at: a.forkEdit, disabled: false });
  } else {
    const done = a.fork ?? rowActions(t, id, { busy: NO_BRANCH, readOnly: p.readOnly }).fork; // what it offers once the branch is done
    if (done !== null) out.push({ id: "fork", label: "Fork to new chat", at: done, disabled: a.fork === null });
    if (a.midTurn) out.push({ id: "note", label: MID_TURN_NOTE });
  }
  if (e.item.kind === "user" || e.item.done) out.push({ id: "label", label: e.label ? "Relabel" : "Label" });
  return out;
}

const NO_BRANCH: ReadonlySet<string> = new Set();

/** The ids of the branches whose turn is running, from a chat's records. */
export const busyBranches = (states: readonly Pick<BranchState, "branch" | "status">[]): ReadonlySet<string> =>
  new Set(states.filter((st) => isBusy(st.status)).map((st) => st.branch));

export type RowMark = "approval" | "running" | "subs" | "error" | "stopped";

/** The mark on the row a branch ends at, from the branch's record: it waits for your approval, its
 *  agent is in a turn, it is idle while its subagents run, it cannot start or ended in an error,
 *  or its turn was cut by a restart or a crash. The first that holds, in that order; null: none. */
export function branchMark(st: Pick<BranchState, "status" | "subsRunning"> | undefined): RowMark | null {
  if (!st) return null;
  if (st.status === "approval") return "approval";
  if (isBusy(st.status)) return "running";
  if ((st.subsRunning ?? 0) > 0) return "subs";
  return st.status === "error" ? "error" : st.status === "stopped" ? "stopped" : null;
}

/** A row with this mark has Stop: the branch has work that a stop ends (as the composer's Stop). */
export const stoppable = (mark: RowMark | null): boolean => mark === "approval" || mark === "running" || mark === "subs";

const MARK_ORDER: RowMark[] = ["approval", "running", "subs", "error", "stopped"];

export type MarkOf = { mark: RowMark; branch: string; subs: number; error?: string }; // subs: the branch's running subagents

/** The marks of a tree's rows, by entry id: each branch of the view marks the entry it ends at.
 *  Where several branches end at one entry, the first in the order of branchMark wins. list: the
 *  rows shown (a filter or a search hides some): a branch whose end has no row marks the last row
 *  above it that is its own (of the branch its end belongs to), and nothing when it has none. */
export function rowMarks(t: ChatTree, states: readonly Pick<BranchState, "branch" | "status" | "subsRunning" | "error">[], list?: readonly Pick<Row, "id">[]): Record<string, MarkOf> {
  const out: Record<string, MarkOf> = {};
  const ids = list && new Set(list.map((r) => r.id));
  for (const st of states) {
    const mark = branchMark(st);
    if (!mark || !t.view.branches.some((b) => b.id === st.branch)) continue; // tipOf reads an unknown branch as main
    const end = tipOf(t, st.branch);
    const own = end ? t.entries[end]?.branch : undefined;
    const tip = !end || !ids || ids.has(end) ? end : pathTo(t, end).reverse().find((x) => ids.has(x) && t.entries[x]?.branch === own) ?? null;
    if (!tip || (out[tip] && MARK_ORDER.indexOf(out[tip].mark) <= MARK_ORDER.indexOf(mark))) continue;
    out[tip] = { mark, branch: st.branch, subs: st.subsRunning ?? 0 };
    if (mark === "error" && st.error) out[tip].error = st.error;
  }
  return out;
}

/** The model notes of a tree's rows, by entry id: a branch that runs on another model or effort
 *  than the branch it split from says so on its first own entry, as "<model>[ · <effort>]" with
 *  the catalog's names (the ids without them). Nothing for main, for a branch without entries of
 *  its own, and where either record is not known. */
export function modelNotes(t: ChatTree, states: readonly Pick<BranchState, "branch" | "model" | "effort">[], cat?: Catalog): Record<string, string> {
  const out: Record<string, string> = {};
  const of = (branch: string) => states.find((st) => st.branch === branch);
  for (const b of t.view.branches) {
    const st = of(b.id), from = of(b.from ?? MAIN);
    if (b.id === MAIN || !b.items.length || !st || !from) continue;
    if (st.model === from.model && (st.effort ?? "") === (from.effort ?? "")) continue;
    const model = cat?.models.find((m) => m.id === st.model);
    const effort = effortLabel(st.effort, model);
    out[entryId(b.id, b.items[0].i)] = (model?.label ?? st.model) + (effort ? ` · ${effort}` : "");
  }
  return out;
}

/** The entry the popup opens on: the message it was opened at (index item of a branch's thread),
 *  else where the chat is. */
export function startEntry(t: ChatTree, focus?: { branch: string; item: number }): string | null {
  const id = focus ? entryId(ownerOf(t.view, focus.branch, focus.item), focus.item) : null;
  return id && t.entries[id] ? id : t.leaf;
}

/** The row shown as picked: the entry's own, else that of the nearest entry above it that has one.
 *  A fork link's row is picked by its own id. */
export function pickedRow(t: ChatTree, list: Row[], id: string | null): string | null {
  const ids = new Set(list.map((r) => r.id));
  if (id !== null && ids.has(id)) return id;
  return pathTo(t, id).reverse().find((x) => ids.has(x)) ?? null;
}

/** What Esc does in the open popup: it closes the menu, else clears the search, else closes the
 *  popup. "none": the key is another's (a dialog over the popup, the label field). */
export function escStep(p: { dialog: boolean; labeling: boolean; menu: boolean; query: string }): "none" | "menu" | "search" | "close" {
  if (p.dialog || p.labeling) return "none";
  if (p.menu) return "menu";
  return p.query ? "search" : "close";
}
