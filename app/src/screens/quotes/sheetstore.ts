// The Quote sheet that a long press on a message opens (package K5): which message it is open for. The sheet itself is `QuoteSheet`
// in the shell's `Overlays` slot; the long press (hold.ts) and the composer's list open it through here.
/** `mode`: "quote" (the Quote sheet) or "select" (the same text to select and copy: the message sheet's Select text). */
export type PickMode = "quote" | "select";
export type PickTarget = { chat: string; index: number; mode?: PickMode } | null;

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
export function openPick(chat: string, index: number, mode: PickMode = "quote"): void {
  holdEnded();
  set({ chat, index, mode });
}
export const closePick = (): void => set(null);
export const pickNow = (): PickTarget => now;
export function subscribePick(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
