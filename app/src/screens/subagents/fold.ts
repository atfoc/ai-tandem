// What an ended subagent's fold may hide (ux-improvements goal 3.5): its steps fold to one row, but a request that can still be answered
// stands outside the fold, so the person never has to open it to find the card that waits for them. DOM-free.
import { pendingPerms } from "@aiwb/core/logic/permwords.ts";
import type { Item } from "@aiwb/core/types.ts";

/** The places in `items` of the requests that wait for an answer and are shown even while the steps are folded: none when the screen is
 *  read-only (its requests are closed and cannot be answered, so they stay in the fold). */
export function foldedWaiting(items: readonly (Item | null | undefined)[] | undefined, readOnly: boolean): number[] {
  if (!items || readOnly) return [];
  return pendingPerms(items, 0).map((p) => p.index);
}
