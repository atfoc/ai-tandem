// The ring a keyboard's focus leaves on a control, on the web (the old page's styles.css: `.side-hide:focus-visible, .side-show:focus-visible`,
// `.menu-item:focus-visible`, `.tchip:focus-visible`, `.more-insert:focus-visible`): 2 px in the theme's accent, inside the control where it
// is a row of a list or a square button at the window's edge, one point outside a chip, two outside a slider's track (the touch area, a little round) and one outside its − and + buttons. A mouse's press leaves none (`:focus-visible`).
// react-native-web has no focus-visible style, so a rule of a sheet draws it, from the variable `--focus-ring` that the theme sets. Native has
// its own focus (the platform's) and does not call this.

const SHEET_ID = "aiwb-focus-ring";

export const FOCUS_RING_CSS = [
  `[data-testid="side-show"]:focus-visible, [data-testid="side-hide"]:focus-visible, [data-testid="menu-item"]:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }`,
  `[data-testid="tchip"]:focus-visible, [data-testid="more-insert"]:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }`,
  `[role="slider"]:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 0; border-radius: 6px; }`,
  `[data-slider="step"]:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 1px; }`,
].join("\n");

/** Web: the sheet is in the document, and the ring is in `accent`. */
export function setFocusRing(accent: string) {
  const root = document.documentElement;
  root.style.setProperty("--focus-ring", accent);
  if (document.getElementById(SHEET_ID)) return;
  const sheet = document.createElement("style");
  sheet.id = SHEET_ID;
  sheet.textContent = FOCUS_RING_CSS;
  document.head.append(sheet);
}
