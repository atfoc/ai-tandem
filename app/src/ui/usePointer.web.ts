// The pointer of the page (AD-70): "mouse" or "touch" from the `pointerType` of the last pointer event. One listener
// for the page, however many components read it; a pen counts as a mouse (it hovers); before any event: a mouse, unless
// the device's primary pointer is coarse (a phone or a tablet).
import { useSyncExternalStore } from "react";

export type Pointer = "mouse" | "touch";

let now: Pointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches ? "touch" : "mouse";
const listeners = new Set<() => void>();

function on(e: PointerEvent) {
  const next: Pointer = e.pointerType === "touch" ? "touch" : "mouse";
  if (next === now) return;
  now = next;
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener("pointerdown", on, true);
    window.addEventListener("pointermove", on, true);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("pointerdown", on, true);
      window.removeEventListener("pointermove", on, true);
    }
  };
}

export function usePointer(): Pointer {
  return useSyncExternalStore(subscribe, () => now, () => "mouse");
}
