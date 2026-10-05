// The branch a chat shows, and the move chosen and not sent yet: which events and loads belong to
// the list on screen, what the composer holds when a move starts and when it is taken back, when
// a move is dropped, and what the banner above the composer says. conn.ts, fork/actions.ts and
// fork/Chrome.tsx act on these rules. DOM-free.

import { MAIN, type AgentKind, type Held, type Item, type PendingMove, type Reference, type Target, type TreeView } from "../types.ts";
import { hasDraft } from "./drafts.ts";
import { pointOK, sessionEnd } from "./forkpoints.ts";
import { nameOfBranch, preview, sharedCount, type ChatTree } from "./forktree.ts";
import { nameText, quoteKey } from "./quotes.ts";

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
 *  sending: the move's own Send is in flight. A busy chat keeps its move: the app starts a turn
 *  by itself when a subagent's result arrives, and the message is sent to the point after it. */
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

export type Banner =
  | { kind: "new"; after: string | null; stays: string | null; stops?: number; asks?: true }   // after: preview of the last message before the point; null = from the start
  | { kind: "end"; name: string; stays: string | null; stops?: number; asks?: true };          // stops: the running subagents of the branch left, when it has any; asks: an approval is waited for

/** What the banner says of a pending move on its branch's items. t: the chat's tree; current:
 *  the branch the chat is on, which the move leaves; running: how many subagents of that branch
 *  run, which the Send stops; asks: the chat waits for the user's approval, whose card the thread
 *  cut at the move's point does not show. */
export function bannerOf(t: ChatTree, move: Target, items: (Item | undefined)[], current: string, running = 0, asks = false): Banner {
  const end = !move.new && sessionEnd(items, move.at);
  const left = !end || current !== move.branch;
  const stays = left && t.view.branches.some((b) => b.id === current) ? nameOfBranch(t, current) : null;
  const stops = left && running > 0 ? { stops: running } : {};
  const waits = asks ? { asks: true as const } : {};
  if (end) return { kind: "end", name: nameOfBranch(t, move.branch), stays, ...stops, ...waits };
  let after: string | null = null;
  for (let i = Math.min(move.at, items.length) - 1; i >= 0 && after === null; i--) {
    const it = items[i];
    if (it?.kind === "user" || it?.kind === "text") after = preview(nameText(it), 44);
  }
  return { kind: "new", after, stays, ...stops, ...waits };
}

export function bannerText(b: Banner): string {
  const stays = b.stays ? ` “${b.stays}” stays in the tree.` : "";
  const stops = b.stops ? ` ${b.stays ? "Its" : "The"} ${b.stops === 1 ? "running subagent is" : `${b.stops} running subagents are`} stopped when you send.` : "";
  const asks = b.asks ? " The agent is waiting for your approval: Back shows it." : "";
  if (b.kind === "end") return `Now on “${b.name}”, where it ended.${stays}${stops}${asks}`;
  return `New branch ${b.after === null ? "from the start" : `after “${b.after}”`}: your message starts it.${stays}${stops}${asks}`;
}
