// The web's useHovered: pointerenter and pointerleave on the element (they do not bubble, and a child of it does not end the hover).
// A touch pointer is no hover. See useHovered.ts.
import { useCallback, useRef, useState, type RefCallback } from "react";

export function useHovered(): [RefCallback<any> | undefined, boolean] {
  const [hovered, set] = useState(false);
  const off = useRef<(() => void) | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    off.current?.();
    off.current = null;
    if (!el?.addEventListener) return;
    const enter = (e: PointerEvent) => { if (e.pointerType !== "touch") set(true); };
    const leave = (e: PointerEvent) => { if (e.pointerType !== "touch") set(false); };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    off.current = () => { el.removeEventListener("pointerenter", enter); el.removeEventListener("pointerleave", leave); };
  }, []);
  return [ref, hovered];
}
