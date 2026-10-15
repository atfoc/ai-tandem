// How the board view shows a theme (the `theme` message, AD-50): Excalidraw's own light or dark, and the canvas filter of
// logic/canvastheme.ts laid over it. The board's colours stay the stored ones; the theme is a view. DOM-free.
import { CHROME_COLOUR, isChromeVar } from "@aiwb/board-bridge/chrome.ts";
import type { ChromeMsg } from "@aiwb/board-bridge/chrome.ts";
import type { CanvasFilterMsg } from "@aiwb/board-bridge/messages.ts";

/** The CSS that points Excalidraw's `--theme-filter` at the filter and puts it on the canvases (Excalidraw does that itself in
 *  its dark theme, where it is `invert(93%) hue-rotate(180deg)`; Latte is a light theme, whose canvases get it here). The
 *  rules are global because the container of Excalidraw's dialogs is a `.excalidraw` of its own, outside the canvas, and
 *  they have the weight of three classes, over Excalidraw's `.excalidraw.theme--dark`. No filter, no rules: plain light
 *  has none, and plain Excalidraw dark keeps its own. */
export function themeCss(filter: CanvasFilterMsg | null): string {
  if (!filter) return "";
  return [
    `:root .excalidraw.excalidraw { --theme-filter: url(#${filter.id}); }`,
    `:root .excalidraw.excalidraw canvas { filter: var(--theme-filter); }`,
  ].join("\n");
}

/** Excalidraw's own island shadow with a ring of the app's line in place of its edge: the islands are on Base like the ground,
 *  so its shadow has no edge to show (the same in light and dark). */
const SHADOW_ISLAND = "0 0 0 1px var(--aiwb-line), 0px 0px .9310142993927002px 0px rgba(0, 0, 0, .17), 0px 0px 3.1270833015441895px 0px rgba(0, 0, 0, .08), 0px 7px 14px 0px rgba(0, 0, 0, .05)";

/** The CSS that gives Excalidraw's chrome (toolbar, panels, menus, dialogs) the colours of a flavour: the custom properties
 *  of the map, set where Excalidraw sets its own, and the few rules that a custom property cannot express (the old page's source/
 *  flavours-canvas.css is the old page's, from which this is made). The rules are global like `themeCss`'s, and have the
 *  weight of three classes, over Excalidraw's `.excalidraw.theme--dark`. Only the allowed names and colours are written,
 *  whatever the map holds. No map, no rules: the chrome is Excalidraw's own. */
export function chromeCss(chrome: ChromeMsg | null | undefined): string {
  if (!chrome) return "";
  const decls = Object.entries(chrome)
    .filter(([name, value]) => isChromeVar(name) && typeof value === "string" && CHROME_COLOUR.test(value))
    .map(([name, value]) => `${name}: ${value};`);
  if (decls.length === 0) return "";
  const root = ":root .excalidraw.excalidraw";
  return [
    `${root} { ${decls.join(" ")} --shadow-island: ${SHADOW_ISLAND}; }`,
    // the zoom, undo, library, menu and help buttons are islands of their own, with a ring of --color-surface-lowest in place of --shadow-island: the same ring
    `${root} :where(.zoom-actions, .undo-redo-buttons, .sidebar-trigger, .main-menu-trigger, .help-icon):not(:active) { box-shadow: 0 0 0 1px var(--aiwb-line); }`,
    // a shortcut in a menu is the menu's text at half strength, which is under the floor on Latte's Base: it is faint text
    `${root} .dropdown-menu .dropdown-menu-item__shortcut { opacity: 1; color: var(--aiwb-faint); }`,
    // the same in the canvas's context menu, where the item under the pointer is a fill with its own text
    `${root} .context-menu-item .context-menu-item__shortcut { opacity: 1; color: var(--aiwb-faint); }`,
    `${root} .context-menu-item:hover .context-menu-item__shortcut { color: inherit; }`,
  ].join("\n");
}

/** The numbers of an SVG filter as attribute text: the matrix values, and the table of one channel. */
export const matrixValues = (f: CanvasFilterMsg) => f.matrix.join(" ");
export const tableValues = (table: number[]) => table.join(" ");
