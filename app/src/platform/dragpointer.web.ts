// On web the drag follows `pointermove` and `pointerup` at the window (captured, so nothing in the page can hide them), for the moves and the
// release the gesture handler's own events leave out. See dragpointer.types.ts.
import type { DragPointer, Point } from "./dragpointer.types.ts";

export type { DragPointer, Point } from "./dragpointer.types.ts";

let last: Point | null = null;

export const dragPointer: DragPointer = {
  follow(move) {
    last = null;
    // (a pointer event the page made up itself is no pointer: only the user agent's are heard)
    const at = (e: PointerEvent) => { if (e.isTrusted) last = { x: e.clientX, y: e.clientY }; };
    const onMove = (e: PointerEvent) => { if (!e.isTrusted) return; at(e); move(last!); };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", at, true);
    return () => { window.removeEventListener("pointermove", onMove, true); window.removeEventListener("pointerup", at, true); };
  },
  now: () => last,
  nextPress(f) {
    const once = () => f();
    window.addEventListener("pointerdown", once, { capture: true, once: true });
    return () => window.removeEventListener("pointerdown", once, { capture: true });
  },
};
