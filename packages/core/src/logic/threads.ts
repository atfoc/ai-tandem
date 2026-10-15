// The rules of the event layer (conn.ts, store.ts) for the threads and branch records the
// client keeps, DOM-free so they can be tested: how a thread takes item updates and a fetch's
// answer, what waits while a fetch runs, what goes with a removed chat, how a snapshot's
// records are keyed, and when the subagent drawer stays open.
import { branchKey, keyOfChat, type BranchKey } from "./branches.ts";
import type { BranchState, Item, Subagent } from "../types.ts";

/** A list of items (a branch's, or a subagent's) at the version the server gave it. */
export type Thread = { version: number; items: Item[] };
export type Update = { index: number; item: Item };

/** A thread after an event's updates. A thread that is not loaded stays so (it is fetched in
 *  full when wanted), and a version not above the thread's is dropped: both give back what was
 *  passed. Any higher version is applied, also past a gap: an event carries the items that
 *  changed, each at its index, and nothing is asked for again. */
export function applyUpdates(thread: Thread | undefined, version: number, updates: Update[]): Thread | undefined {
  if (!thread || version <= thread.version) return thread;
  const items = thread.items.slice();
  for (const u of updates) items[u.index] = u.item;
  return { version, items };
}

/** A thread after a fetch's answer: the answer, unless the thread kept is at its version or past
 *  it (events went on while the answer was on its way, or another fetch was faster). replace:
 *  the answer is taken whatever its version. */
export function afterAnswer(thread: Thread | undefined, got: Thread, replace = false): Thread {
  return thread && thread.version >= got.version && !replace ? thread : got;
}

/** What arrives for a thread while its fetch runs and waits for the answer: item updates and,
 *  for a branch's list, its subagents' states, both applied after the answer; and the branch's
 *  records, which are applied at once and only noted here. */
export type Queued = { version: number; updates: Update[] } | { sub: Subagent } | { state: BranchState };

/** Whether the record a list's answer brought is taken: not when a record of the branch arrived
 *  while the fetch ran. Events come in order and the answer on another connection, so the answer
 *  may be the older of the two, and nothing would correct it. */
export const answerStateTaken = (queued: readonly Queued[]): boolean => !queued.some((q) => "state" in q);

/** Whether the subagent drawer stays open when a chat shows the branch `shown`: one on another
 *  chat does, one on this chat only when its subagent is of that branch. */
export function drawerStays(drawer: { chat: string; branch: string } | null, chat: string, shown: string): boolean {
  return !drawer || drawer.chat !== chat || drawer.branch === shown;
}

/** A map by branch or subagent key without a chat's entries; the map itself when it has none. */
export function withoutChat<K extends string, V>(map: Record<K, V>, chat: string): Record<K, V> {
  const keys = Object.keys(map) as K[];
  const kept = keys.filter((k) => !keyOfChat(k, chat));
  if (kept.length === keys.length) return map;
  return Object.fromEntries(kept.map((k) => [k, map[k]])) as Record<K, V>;
}

/** A snapshot's branch records by their key; a later record of the same branch wins. */
export function statesByKey(list?: BranchState[] | null): Record<BranchKey, BranchState> {
  const out: Record<BranchKey, BranchState> = {};
  for (const st of list ?? []) if (st?.chat) out[branchKey(st.chat, st.branch)] = st;
  return out;
}
