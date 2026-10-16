// The theme modes the bench compares (README.md here). A mode is the `theme` message the page gets (what the app would send) and,
// for the variants of the experiment, a bit of CSS and SVG that only the bench puts in the document, before the board loads and
// away after its runs. A new filter to measure is a new entry here. Which modes a run covers (the sets `experiment`, `replacement`
// and `all`) and how long it takes is modeset.mjs.
import { CANVAS_THEMES, canvasFilter, type CanvasTheme } from "@aiwb/core/logic/canvastheme.ts";
import { resolveTheme } from "@aiwb/core/logic/theme.ts";
import type { ThemeMsg } from "@aiwb/board-bridge/messages.ts";

export type Mode = { theme: ThemeMsg; css?: string; svg?: string; what: string };

/** Weight over Excalidraw's own rule (`.excalidraw.theme--dark canvas`) and over the page's (themeCss, two classes). */
const CANVAS = ":root .excalidraw.excalidraw.excalidraw canvas";
const MATRIX_ID = "aiwb-bench-matrix";
/** The blend layers the phone page puts over the canvases (Board.tsx). */
export const LAYER_SELECTOR = ".aiwb-canvas-layer";

/** The theme message the app sends for a canvas theme: the page's mode, the SVG filter's numbers (the page turns them into its
 *  stage and layers, phonetheme.ts) and no chrome (the chrome of a flavour is not modelled here: it is custom properties of
 *  Excalidraw's toolbar and panels, which a pan and a pinch do not repaint). */
const themeMsg = (t: CanvasTheme): ThemeMsg => ({ mode: resolveTheme(t, true), filter: canvasFilter(t), chrome: null });

/** Today's look, as the phone page drew it before the replacement: the SVG filter of the theme (feColorMatrix and the tables)
 *  through `filter: url(#id)` on the canvases, and the replacement's blend layers out of the page. The theme message is the same
 *  as the replacement's, so the page makes its stage and its layers and the bench takes them away: a rule over the page's own
 *  (`!important`) and `display: none` on the layers. */
const todayCss = (t: CanvasTheme) =>
  `${CANVAS} { filter: url(#${canvasFilter(t).id}) !important; }\n${LAYER_SELECTOR} { display: none !important; }`;

/** A hidden <svg> with a filter that holds only the feColorMatrix of the app's dark filter (as CanvasFilters.tsx writes it). */
function matrixSvg(): string {
  const f = canvasFilter("dark");
  return `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="0" height="0" style="position:absolute">` +
    `<defs><filter id="${MATRIX_ID}" color-interpolation-filters="sRGB" filterUnits="objectBoundingBox" x="0" y="0" width="1" height="1">` +
    `<feColorMatrix type="matrix" values="${f.matrix.join(" ")}"/></filter></defs></svg>`;
}

export const MODES: Record<string, Mode> = {
  light: {
    what: "plain light: no filter",
    theme: { mode: "light", filter: null, chrome: null },
  },
  "dark-css": {
    what: "the experiment: Excalidraw's own dark, CSS filter functions invert(93%) hue-rotate(180deg) on the canvases",
    theme: { mode: "dark", filter: null, chrome: null },
  },
  "dark-none": {
    what: "control: Excalidraw's dark with no filter on the canvases at all",
    theme: { mode: "dark", filter: null, chrome: null },
    css: `${CANVAS} { filter: none !important; }`,
  },
  "dark-matrix": {
    what: "informative: only the feColorMatrix of today's filter, through filter: url(#aiwb-bench-matrix)",
    theme: { mode: "dark", filter: null, chrome: null },
    svg: matrixSvg(),
    css: `${CANVAS} { filter: url(#${MATRIX_ID}) !important; }`,
  },
};

// A mode per canvas theme, two ways (the five themes of @aiwb/core, dark and the four flavours).
for (const t of CANVAS_THEMES) {
  MODES[t] = {
    what: `${t}, the replacement: the theme message the app sends -> the page's phone filter (CSS stage on the canvases + blend layers)`,
    theme: themeMsg(t),
  };
  MODES[`${t}-today`] = {
    what: `${t}, today: the same message, the page's own filter taken away: the SVG filter (matrix + tables) through filter: url(#${canvasFilter(t).id}), no blend layers`,
    theme: themeMsg(t),
    css: todayCss(t),
  };
}

export const MODE_NAMES = Object.keys(MODES);

const EXTRA = "aiwb-bench-extra";

/** Puts a mode's extras in the document (replacing any earlier ones). */
export function injectExtras(mode: Mode): void {
  removeExtras();
  if (mode.css) {
    const style = document.createElement("style");
    style.id = EXTRA + "-css";
    style.textContent = mode.css;
    document.head.appendChild(style);
  }
  if (mode.svg) {
    const holder = document.createElement("div");
    holder.id = EXTRA + "-svg";
    holder.setAttribute("aria-hidden", "true");
    holder.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    holder.innerHTML = mode.svg;
    document.body.appendChild(holder);
  }
}

export function removeExtras(): void {
  document.getElementById(EXTRA + "-css")?.remove();
  document.getElementById(EXTRA + "-svg")?.remove();
}
