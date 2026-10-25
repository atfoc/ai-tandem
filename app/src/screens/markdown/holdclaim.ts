// A long press inside a message that something in it took for itself (a link's hold opens the link sheet): the message's own long
// press (the message sheet, screens/quotes/hold.ts) does not open as well. The inner hold fires first (its delay is shorter) and claims
// it; the message's hold, firing a moment later, asks and stands down.
const CLAIM_MS = 1000;
let claimed = 0;

/** The hold that just fired is this part's: the message's hold that follows does nothing. */
export function claimHold(): void {
  claimed = Date.now();
}

/** Whether a part of the message took the hold that is ending now. */
export const holdClaimed = (): boolean => Date.now() - claimed < CLAIM_MS;
