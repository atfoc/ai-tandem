// The Quote sheet that a long press on a message opens (package K5): which message it is open for. The sheet itself is `QuoteSheet`
// in the shell's `Overlays` slot; the long press (hold.ts) and the composer's list open it through here.
export type PickTarget = { chat: string; index: number } | null;

let now: PickTarget = null;
const listeners = new Set<() => void>();

const set = (t: PickTarget) => { now = t; for (const l of listeners) l(); };

// The finger that held the message is still down when the sheet opens, and a browser may follow its lifting with a click on whatever is
// under it: the dimmed page. For a moment after the sheet opens and after the finger lifts a press on the dimmed page closes nothing.
const GRACE_MS = 500;
let grace = 0;
export const holdEnded = (): void => { grace = Date.now() + GRACE_MS; };
export const inGrace = (): boolean => Date.now() < grace;

/** Opens the sheet for the message at `index` of the chat's thread. */
export function openPick(chat: string, index: number): void {
  holdEnded();
  set({ chat, index });
}
export const closePick = (): void => set(null);
export const pickNow = (): PickTarget => now;
export function subscribePick(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
