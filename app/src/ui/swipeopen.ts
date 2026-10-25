// Which swipe row is open (ux-improvements goal 3.3): at most one. Opening a row closes the one that was open; a row subscribes to
// know whether any is open, so that a tap on it then only closes (SwipeRow.tsx).
import { useSyncExternalStore } from "react";

type Open = { id: number; close(): void };

let open: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };

let ids = 0;
/** A new row's identity. */
export const nextRowId = () => ++ids;

/** `id` is open now: the row that was open is closed. */
export function setOpen(id: number, close: () => void) {
  const was = open;
  open = { id, close };
  if (was && was.id !== id) was.close();
  emit();
}

/** `id` has closed (or gone); it only clears the record when `id` is still the open one. */
export function clearOpen(id: number) {
  if (open?.id !== id) return;
  open = null;
  emit();
}

/** Closes the open row, if any. */
export function closeOpen() {
  open?.close();
}

/** Closes the open row unless it is `id`: the start of another row's swipe. */
export function closeOthers(id: number) {
  if (open && open.id !== id) open.close();
}

/** How long after a swipe moved a row a press of its content is still the end of that swipe. */
export const SWIPE_PRESS_MS = 400;
let movedAt = -Infinity;

/** A swipe moved a row (its pan started, or ended). A finger's move cancels the content's press as the pan takes over, but a touch
 *  whose move comes at once and is lifted right after (a synthesized one: Maestro's, an assistive tool's) can still end in that press. */
export function swiped(now = Date.now()) {
  movedAt = now;
}

/** Whether a press of a row's content is the end of a swipe, and so no press (the row's own `onPress` asks, as the drag's guard). */
export const swipePressBlocked = (now = Date.now()): boolean => now - movedAt < SWIPE_PRESS_MS;

/** How long a row's press waits before it asks: the pan's start may come after the press when the move came at once (the first swipe on a
 *  screen just drawn, while the JS thread is busy). Under a frame and a half: not felt. */
export const SWIPE_SETTLE_MS = 60;

/** Runs a row's press unless it turns out to be the end of a swipe. */
export function pressUnlessSwiped(press: () => void, wait = SWIPE_SETTLE_MS): void {
  setTimeout(() => { if (!swipePressBlocked()) press(); }, wait);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** The open row's id, or null. */
export const useOpenRow = () => useSyncExternalStore(subscribe, () => open?.id ?? null, () => null);
