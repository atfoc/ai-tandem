// A drag that ends where the pointer was pressed ends in a press of the row too (a mouse released over the row it left, a finger lifted
// after a long press): the page's HTML drag never made a click. The rows' presses ask this before they act. The click that follows a release
// comes before the next press begins, so the guard ends there (or after 400 ms, where there is no such event).
import { dragPointer } from "../../platform/dragpointer";

let until = 0, off: (() => void) | null = null;

/** A drag began (no press is taken until it ends) or ended (none is taken for the click that follows the release). */
export function dragging(on: boolean): void {
  off?.();
  off = null;
  if (on) { until = Infinity; return; }
  until = Date.now() + 400;
  off = dragPointer.nextPress(() => { until = 0; off = null; });
}

/** Whether a press is the end of a drag, and so no press. */
export const pressBlocked = (): boolean => Date.now() < until;
