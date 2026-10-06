// The branch a chat shows, and the move chosen and not sent yet: which load of a thread is the
// one kept, what the composer holds when a move starts and when it is taken back, when
// a move is dropped, and what the banner above the composer says. conn.ts, fork/actions.ts and
// fork/Chrome.tsx act on these rules. DOM-free.

import { type AgentKind, type Held, type Item, type PendingMove, type Reference, type Target, type TreeView } from "../types.ts";
import { hasDraft } from "./drafts.ts";
import { pointOK, sessionEnd } from "./forkpoints.ts";
import { nameOfBranch, preview, sharedCount, type ChatTree } from "./forktree.ts";
import { nameText, quoteKey } from "./quotes.ts";

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

/** Whether a pending move is still possible on its branch's items. running: the branch's turn
 *  runs; a new branch then starts only at a finished boundary, and only when the agent kind can
 *  branch from a running source (pointOK), and the end of the branch takes no message. */
export function moveValid(agent: AgentKind, items: (Item | undefined)[], move: Target, running = false): boolean {
  return (!move.new && !running && sessionEnd(items, move.at)) || pointOK(agent, items, move.at, running);
}

/** Whether a pending move is dropped (as Back) after the chat's view or the shown list changed.
 *  sending: the move's own Send is in flight. A busy source keeps its move: its list only grows
 *  past the point, which stays a finished boundary, and the message starts its own branch there
 *  while the source's turn (the user's, or one the app started for a subagent's result) goes on. */
export function moveDropped(p: { archived: boolean; valid: boolean; sending: boolean }): boolean {
  return !p.sending && (p.archived || !p.valid);
}

/** What the composer holds after Back, or after the move was dropped: what it held before the
 *  move when its text is as the move left it, with the quotes added meanwhile; else what was
 *  typed. A move that put nothing left the composer its own draft: what was typed gets back the
 *  quotes the moves hid, a quote whose comment was edited meanwhile keeps the edit, and a quote
 *  that was removed meanwhile stays removed (one the moves hid was not removed).
 *  limit: the count below which an index names the same message in the branch returned to. */
export function afterBack(move: PendingMove, now: Held, limit: number): Held {
  const same = (a: Reference) => (b: Reference) => quoteKey(a) === quoteKey(b);
  const below = quotesBefore(now.references, limit);
  // What the moves took out of the composer, without what it has again. A move that does not say: the quotes past the limit.
  const hid = (move.put ? [] : move.hid ?? move.held.references.filter((r) => r.item >= limit)).filter((h) => !below.some(same(h)));
  if (now.text !== (move.put?.text ?? move.held.text)) return { text: now.text, mentions: now.mentions, references: [...below, ...hid] };
  const had = new Set([...(move.put ?? move.held).references, ...move.held.references].map(quoteKey));
  const added = [...below, ...hid].filter((r) => !had.has(quoteKey(r)));
  const mine = move.put ? move.held.references : move.held.references.flatMap((h) => {
    const r = below.find(same(h));
    return r ? [r.comment !== h.comment ? r : h] : hid.some(same(h)) || now.references.some(same(h)) ? [h] : []; // in neither: the user removed it
  });
  const whole = mine.length === move.held.references.length && mine.every((r, i) => r === move.held.references[i]);
  return added.length || !whole ? { ...move.held, references: [...mine, ...added] } : move.held;
}

/** What an empty composer gets back after a sent move that had put a message into it (Branch and
 *  edit): the draft it held before, which the Send did not use. null: nothing to give back.
 *  limit: the count below which an index names the same message in the branch sent to. */
export function afterSent(move: PendingMove, now: Held, limit: number): Held | null {
  if (!move.put || now.text.trim() || now.references.length) return null;
  const h = { ...move.held, references: quotesBefore(move.held.references, limit) };
  return hasDraft(h) ? h : null;
}

/** after: preview of the last message before the point, null = from the start. stays: the name
 *  of the branch the chat is on, which the new branch leaves as it is. asks: the branch cut at the
 *  point waits for the user's approval. */
export type Banner = { kind: "new"; after: string | null; stays: string | null; asks?: true };

/** What the banner says of a pending move on its branch's items. t: the chat's tree; from: the
 *  branch the chat is on, which stays as it is (the move stops nothing on it); asks: the branch
 *  cut at the move's point waits for the user's approval, whose card the cut thread does not show. */
export function bannerOf(t: ChatTree, move: Target, items: (Item | undefined)[], from: string, asks = false): Banner {
  const stays = t.view.branches.some((b) => b.id === from) ? nameOfBranch(t, from) : null;
  let after: string | null = null;
  for (let i = Math.min(move.at, items.length) - 1; i >= 0 && after === null; i--) {
    const it = items[i];
    if (it?.kind === "user" || it?.kind === "text") after = preview(nameText(it), 44);
  }
  return { kind: "new", after, stays, ...(asks ? { asks: true as const } : {}) };
}

export function bannerText(b: Banner): string {
  const stays = b.stays ? ` “${b.stays}” stays in the tree.` : "";
  const asks = b.asks ? " The agent is waiting for your approval: Back shows it." : "";
  return `New branch ${b.after === null ? "from the start" : `after “${b.after}”`}: your message starts it.${stays}${asks}`;
}
