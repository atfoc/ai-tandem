// When the app saw a permission request answered (ux T2: the folded card's time). The server keeps no time for an answer, so the time
// is the app's own record: the first moment it saw a request decided that it had seen pending, whether the answer was given here or
// elsewhere while the chat was open. A request that was already decided when the app first saw it has no time, and the card shows none.
// A request is named by the chat, who asked (a subagent's sid, or none) and its id: the id alone repeats between the chat and its subagents.
import type { Item } from "@aiwb/core/types.ts";

const pending = new Set<string>();
const answered = new Map<string, number>();

const keyOf = (chat: string, item: Item): string => `${chat}\u0000${item.subagent ?? ""}\u0000${item.requestId ?? ""}`;

/** Notes what the app sees of a request now: pending is remembered; a decided one that was seen pending gets its time, once. */
export function observePerm(chat: string, item: Item, now: number = Date.now()): void {
  if (item.kind !== "perm" || !item.requestId) return;
  const key = keyOf(chat, item);
  if (!item.decided) { pending.add(key); return; }
  if (pending.has(key) && !answered.has(key)) answered.set(key, now);
}

/** The time the app saw the request answered (epoch ms), or undefined when it did not see it pending. */
export function answeredAt(chat: string, item: Item): number | undefined {
  return answered.get(keyOf(chat, item));
}
