// The branch a chat shows, and the move chosen and not sent yet: which events and loads belong to
// the list on screen, what the composer holds when a move starts and when it is taken back, when
// a move is dropped, and what the banner above the composer says. conn.ts, fork/actions.ts and
// fork/Chrome.tsx act on these rules. DOM-free.

import { MAIN, type AgentKind, type Held, type Item, type PendingMove, type Reference, type Target, type TreeView } from "../types.ts";
import { pointOK, sessionEnd } from "./forkpoints.ts";
import { nameOfBranch, preview, sharedCount, type ChatTree } from "./forktree.ts";

/** Whether an event of evBranch belongs to the list shown (a missing branch is "main"). */
export function appliesTo(shown: string, evBranch: string | undefined): boolean {
  return (evBranch || MAIN) === shown;
}

/** One load per key at a time, the newest wins: begin returns a ticket; current tells whether it is still the newest. */
export class Loads {
  private newest = new Map<string, number>();

  begin(key: string): number {
    const ticket = (this.newest.get(key) ?? 0) + 1;
    this.newest.set(key, ticket);
    return ticket;
  }

  current(key: string, ticket: number): boolean {
    return this.newest.get(key) === ticket;
  }
}

/** The quotes that still name the same message below a count. */
export function quotesBefore(refs: Reference[], count: number): Reference[] {
  return refs.filter((r) => r.item < count);
}

/** The count below which an index names the same message in `branch` cut at `at` and in `other`:
 *  the smaller of the point and what the two branches share. Without a tree that has both, the
 *  point when they are the same branch, else 0. */
export function quoteLimit(view: TreeView | undefined, at: number, branch: string, other: string): number {
  if (branch === other) return at;
  const has = (id: string) => !!view?.branches.some((b) => b.id === id);
  return view && has(branch) && has(other) ? Math.min(at, sharedCount(view, branch, other)) : 0;
}

/** Whether a pending move is still possible on its branch's items. */
export function moveValid(agent: AgentKind, items: (Item | undefined)[], move: Target): boolean {
  return (!move.new && sessionEnd(items, move.at)) || pointOK(agent, items, move.at);
}

/** Whether a pending move is dropped (as Back) after the chat's view or the shown list changed.
 *  sending: the move's own Send is in flight. */
export function moveDropped(p: { busy: boolean; valid: boolean; sending: boolean }): boolean {
  return !p.sending && (p.busy || !p.valid);
}

/** What the composer holds after Back, or after the move was dropped. limit: the count below
 *  which an index names the same message in the branch returned to. */
export function afterBack(move: PendingMove, now: Held, limit: number): Held {
  if (now.text === (move.put?.text ?? move.held.text)) return move.held;
  return { text: now.text, mentions: now.mentions, references: quotesBefore(now.references, limit) };
}

export type Banner =
  | { kind: "new"; after: string | null; stays: string | null }   // after: preview of the last message before the point; null = from the start
  | { kind: "end"; name: string; stays: string | null };

/** What the banner says of a pending move on its branch's items. t: the chat's tree; current:
 *  the branch the chat is on, which the move leaves. */
export function bannerOf(t: ChatTree, move: Target, items: (Item | undefined)[], current: string): Banner {
  const end = !move.new && sessionEnd(items, move.at);
  const left = !end || current !== move.branch;
  const stays = left && t.view.branches.some((b) => b.id === current) ? nameOfBranch(t, current) : null;
  if (end) return { kind: "end", name: nameOfBranch(t, move.branch), stays };
  let after: string | null = null;
  for (let i = Math.min(move.at, items.length) - 1; i >= 0 && after === null; i--) {
    const it = items[i];
    if (it?.kind === "user" || it?.kind === "text") after = preview(it.text ?? "", 44);
  }
  return { kind: "new", after, stays };
}

export function bannerText(b: Banner): string {
  const stays = b.stays ? ` “${b.stays}” stays in the tree.` : "";
  if (b.kind === "end") return `Now on “${b.name}”, where it ended.${stays}`;
  return `New branch ${b.after === null ? "from the start" : `after “${b.after}”`}: your message starts it.${stays}`;
}
