// The point rules: where in a branch's items a new branch or a fork may start, and what a message
// in the thread offers. A point is an item count: the items before it are kept. The server has the
// same rules in internal/chats/points.go. items is one branch's item list; an index may hold
// nothing (a hole). DOM-free.

import type { AgentKind, Item, TreeItem } from "../types.ts";
import { nameText } from "./quotes.ts";

export type Items = (Item | undefined)[];

/** The point right after the end mark of the turn whose last reply is the text item at i: nothing
 *  but notes and holes may lie between the two. 0 = the item is not its turn's last reply. */
export function turnEnd(items: Items, i: number): number {
  const it = items[i];
  if (it?.kind !== "text" || !it.done) return 0;
  for (let j = i + 1; j < items.length; j++) {
    const kind = items[j]?.kind;
    if (kind === undefined || kind === "note") continue;
    return kind === "end" ? j + 1 : 0;
  }
  return 0;
}

/** The point that drops the user item at u and all after it: right after the last end mark before
 *  it, or 0 when nothing was said before it. null when a reply or a tool call lies between that
 *  mark and u (a turn that ended without a mark), and when u is no user item. */
export function cutBefore(items: Items, u: number): number | null {
  if (items[u]?.kind !== "user") return null;
  for (let m = u - 1; m >= 0; m--) {
    const kind = items[m]?.kind;
    if (kind === "end") return m + 1;
    if (kind === "text" || kind === "tool") return null;
  }
  return 0;
}

const said = (it: Item | undefined) => it?.kind === "user" || it?.kind === "text" || it?.kind === "tool" || it?.kind === "end";

/** Whether nothing was said in the session past count: no user, text, tool or end item at an
 *  index >= count. */
export function sessionEnd(items: Items, count: number): boolean {
  for (let i = Math.max(count, 0); i < items.length; i++) if (said(items[i])) return false;
  return true;
}

/** The index of the first end mark at an index >= count; -1 = none. */
function markFrom(items: Items, count: number): number {
  for (let i = Math.max(count, 0); i < items.length; i++) if (items[i]?.kind === "end") return i;
  return -1;
}

/** Whether a new branch or a fork may start at count by the id rules alone; busy, archived and
 *  legacy are the caller's to check. The start of the chat needs the id on the first end mark,
 *  every other point the id on the mark right before it. */
export function pointOK(agent: AgentKind, items: Items, count: number): boolean {
  if (!Number.isInteger(count) || count < 0 || count > items.length) return false;
  if (count === 0) {
    const first = markFrom(items, 0);
    return first >= 0 && !!items[first]!.point;
  }
  const before = items[count - 1];
  if (before?.kind !== "end" || !before.point) return false;
  if (agent !== "pi" || sessionEnd(items, count)) return true;
  // pi forks the end of a turn with the id on the next turn's mark, so that mark must close the
  // turn that starts at count. After a turn cut without a mark the next mark is a later turn's,
  // and a fork with its id would take in the cut turn. So exactly one turn lies between count
  // and the mark: one message of the human's with no reply or tool call ahead of it (the rows of
  // the subagent results it carries are), or none, which is a turn the app started to deliver
  // subagent results. The app starts one only on a live process, so never after a cut turn, and
  // its message is a user message to pi like any other: the mark carries its id. A mark that
  // repeats the id before count is no new turn.
  const m = markFrom(items, count);
  if (m < 0 || !items[m]!.point) return false;
  let users = 0;
  let early = false; // a reply or a tool call ahead of the first message
  for (let i = count; i < m; i++) {
    const kind = items[i]?.kind;
    if (kind === "user") users++;
    else if (kind === "text" || kind === "tool") early ||= users === 0;
  }
  if (users === 0) return items[m]!.point !== before.point;
  return users === 1 && !early;
}

/** The user and text items at index >= from as the server's tree route would send them. */
export function toTreeItems(agent: AgentKind, items: Items, from = 0): TreeItem[] {
  const out: TreeItem[] = [];
  for (let i = Math.max(from, 0); i < items.length; i++) {
    const it = items[i];
    if (it?.kind === "user") {
      const before = cutBefore(items, i);
      const row: TreeItem = { i, kind: "user", text: nameText(it) };
      if (before !== null) row.before = before;
      if (before !== null && pointOK(agent, items, before)) row.ok = true;
      out.push(row);
    } else if (it?.kind === "text") {
      const end = turnEnd(items, i);
      const row: TreeItem = { i, kind: "text", text: it.text ?? "" };
      if (it.done) row.done = true;
      if (end > 0) row.end = end;
      if (end > 0 && pointOK(agent, items, end)) row.ok = true;
      out.push(row);
    }
  }
  return out;
}

/** What a message in the thread offers. A number is the point count the action uses. */
export type MessageActions = {
  label: boolean;               // Label
  branch: number | null;        // Branch (the end of a turn)
  fork: number | null;          // Fork to new
  branchEdit: number | null;    // Branch and edit (your message)
  forkEdit: number | null;      // Fork and edit
  midTurn: boolean;             // a reply partway through a turn
};

/** The actions of the item at index. While the agent is replying (busy) and in an archived or
 *  legacy chat (readOnly) only Label is left. A turn's last reply offers Branch and Fork to new
 *  when its point has an id; the branch's last reply offers Fork to new whatever the marks. */
export function messageActions(p: { agent: AgentKind; items: Items; index: number; busy: boolean; readOnly: boolean }): MessageActions {
  const { agent, items, index } = p;
  const it = items[index];
  const out: MessageActions = { label: false, branch: null, fork: null, branchEdit: null, forkEdit: null, midTurn: false };
  if (it?.kind !== "user" && !(it?.kind === "text" && it.done)) return out;
  out.label = true;
  if (p.busy || p.readOnly) return out;
  if (it.kind === "user") {
    const c = cutBefore(items, index);
    if (c !== null && pointOK(agent, items, c)) out.branchEdit = out.forkEdit = c;
    return out;
  }
  const e = turnEnd(items, index);
  const last = !items.slice(index + 1).some((x) => x?.kind === "user" || x?.kind === "text" || x?.kind === "tool");
  if (e > 0 && pointOK(agent, items, e)) out.branch = out.fork = e;
  else if (last) out.fork = items.length;
  out.midTurn = e === 0 && !last;
  return out;
}
