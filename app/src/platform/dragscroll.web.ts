// On web a finger that moves after a long press is a scroll of the list to the browser, unless a `touchmove` listener that is not passive calls
// preventDefault on its first move. The browser decides at the touch's start whether a listener can stop the scroll, so the listener stands on the
// list's box for as long as the list is drawn (it does nothing but while a drag is held), and the list lets a finger scroll it before the drag
// has begun (`touch-action: pan-y` on the rows, drag.tsx).
import type { ScrollGuard } from "./dragscroll.types.ts";

export type { ScrollGuard } from "./dragscroll.types.ts";

/** A guard of its own: the sidebar's list has the one below, a popup's list makes another (the guards do not share the list they stand on). */
export function makeScrollGuard(): ScrollGuard {
  let held = false, on: HTMLElement | null = null;
  const stop = (e: TouchEvent) => { if (held && e.cancelable) e.preventDefault(); };
  return {
    guard(el) {
      if (el === on) return;
      on?.removeEventListener("touchmove", stop);
      on = (el as HTMLElement | null)?.addEventListener ? (el as HTMLElement) : null;
      on?.addEventListener("touchmove", stop, { passive: false });
    },
    hold(now) { held = now; },
  };
}

export const scrollGuard: ScrollGuard = makeScrollGuard();
