// Where a quote points, shown on a platform that draws no DOM to highlight (native, AD-64): the message flashes. The store holds the message
// and a token that changes with every flash; `MessageFlash` of each message reads it. About 1.6 s at full strength, then fading over 1.2 s
// (the page's HOLD and FADE).
export const HOLD_MS = 1600, FADE_MS = 1200;

export type Flash = { chat: string; item: number; token: number } | null;

let now: Flash = null;
let n = 0;
const listeners = new Set<() => void>();

export function flashMessage(chat: string, item: number): void {
  now = { chat, item, token: ++n };
  for (const l of listeners) l();
}
export const flashNow = (): Flash => now;
export function subscribeFlash(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
