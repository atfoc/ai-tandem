// Hold Space on the web build and in the desktop window: the focus decides whether the page's Space is the pill's, and the release is heard on the window
// in the capture phase, as the keys port hears a key down.
import type { OnSpaceRelease, SpaceFocus, SpaceFocusNow } from "./holdkeys.types.ts";

export type { OnSpaceRelease, SpaceFocus, SpaceFocusNow } from "./holdkeys.types.ts";

const TEXT = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
// (a Space presses these: leave it to them)
const PRESSED = "button, a[href], summary, [role='button'], [role='menuitem'], [role='option'], [role='tab'], [role='switch'], [role='checkbox'], [role='radio'], [role='link']";

/** The boards' own containers: Excalidraw's, and the tldraw board's mount (packages/board-tl/src/web/entry.tsx, which wraps tldraw's
 *  `.tl-container`). The focus inside either gives Space to the board. */
export const BOARD = ".excalidraw, .aiwb-tl-root";

type Focused = { closest(selector: string): unknown } | null;

export const spaceFocus: SpaceFocusNow = () => {
  const el = document.activeElement;
  if (el === document.body || el === document.documentElement) return "take";
  return spaceFocusOf(el);
};

/** The decision for the focused element (`el.closest` is all it asks of it), so that Node tests it. */
export function spaceFocusOf(el: Focused): SpaceFocus {
  if (!el) return "take";
  if (el.closest(TEXT)) return null;
  if (el.closest("[data-testid='pill-orb'], [data-testid='pill-badge']")) return "take"; // (the orb pressed with the mouse keeps the focus: a Space is still the pill's)
  if (el.closest(PRESSED)) return null;
  // The board's canvas keeps its Space (hold and drag pans): panning must never open the microphone, a paid listening session the person did not
  // ask for (goal 4.9). Hold Space is the pill's once the focus is outside the canvas.
  if (el.closest(BOARD)) return null;
  return "take";
}

export const onSpaceRelease: OnSpaceRelease = (release, lost) => {
  const up = (e: KeyboardEvent) => { if (e.code === "Space") release(e); };
  window.addEventListener("keyup", up, true);
  window.addEventListener("blur", lost);
  return () => { window.removeEventListener("keyup", up, true); window.removeEventListener("blur", lost); };
};
