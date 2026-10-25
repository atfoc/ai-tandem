// The phone's chrome of the board (the `phone` message, B1): Excalidraw's mobile footer made one band across the view, and
// where a board opens (`load`'s `open`). DOM-free; Board.tsx lays the CSS over Excalidraw, endpoint.ts applies the view.
import { CHROME_COLOUR } from "@aiwb/board-bridge/chrome.ts";
import { BAND_HEIGHT, type PhoneChromeMsg } from "@aiwb/board-bridge/messages.ts";

/** The class the wrapper carries while the phone's chrome is set: the rules below hold under it alone. */
export const PHONE_CLASS = "aiwb-phone";
/** The class of the menu's danger item (Clear the board…). */
export const DANGER_CLASS = "aiwb-menu-danger";
/** The margin (px) of the fit the menu's "Fit the whole board" makes. */
export const MENU_FIT = 16;

/** Excalidraw's zoom limits (`MIN_ZOOM`). */
const MIN_ZOOM = 0.1;
/** The gap (px) between the band and the menu's dropdown above it. */
const MENU_GAP = 8;

/** The CSS of the phone's chrome. Excalidraw's mobile footer is `.App-bottom-bar` (the whole view, bottom aligned, with margins
 *  of its own as inline styles) > an island > the panel of the selected shape (`.App-mobile-menu`, only when its button is
 *  pressed) and `footer.App-toolbar` (`.App-toolbar-content`: the menu, the colours, duplicate, delete, undo and redo). The
 *  footer becomes the band: BAND_HEIGHT px (the hairline included) flush with the bottom and both sides, the ground and the line
 *  of the message, no radius and no shadow, its content centred and kept `inset` px from the right end. The panel stays above it,
 *  and the menu's dropdown opens above it. Only the colours of the message are written, and only if they are colours;
 *  no message, no rules. */
export function phoneCss(chrome: PhoneChromeMsg | null | undefined): string {
  if (!chrome || !CHROME_COLOUR.test(chrome.band) || !CHROME_COLOUR.test(chrome.line)) return "";
  const inset = Number.isFinite(chrome.inset) ? Math.min(Math.max(Math.round(chrome.inset), 0), 400) : 0;
  const root = `.${PHONE_CLASS} .excalidraw.excalidraw`;
  return [
    `${root} .App-bottom-bar { margin: 0 !important; padding: 0; }`,
    `${root} .App-bottom-bar > .Island { border-radius: 0; box-shadow: none; }`,
    `${root} .App-bottom-bar .App-toolbar { box-sizing: border-box; height: ${BAND_HEIGHT}px; display: flex; align-items: center; padding: 0 ${inset}px 0 0; background: ${chrome.band}; border-top: 1px solid ${chrome.line}; }`,
    `${root} .App-bottom-bar .App-toolbar-content { box-sizing: border-box; flex: 1; min-width: 0; padding: 0 8px; }`,
    `${root} .App-bottom-bar .App-mobile-menu { margin-bottom: 0; border-top: 1px solid ${chrome.line}; }`,
    `${root} .App-toolbar-content .dropdown-menu--mobile { left: 8px; width: calc(100% - 16px); bottom: ${BAND_HEIGHT + MENU_GAP}px; }`,
    `${root} .dropdown-menu .dropdown-menu-item-base.${DANGER_CLASS} { color: var(--color-danger); }`,
  ].join("\n");
}

/** The custom property on the board's wrapper that holds the top inset (px, with its unit). */
export const TOP_INSET_VAR = "--aiwb-top-inset";

/** The CSS of the top inset (the `topInset` message: the app's floating controls lie along the top edge in landscape): Excalidraw's top
 *  layer (`.FixedSideContainer_side_top`: the toolbar, the top-right buttons) starts that far lower. It holds for the page's canvas as it
 *  is: only the container moves (the canvas, so the drawing, does not). Nothing for 0 (Excalidraw's own rules). */
export function topInsetCss(px: number | undefined): string {
  if (!px || !Number.isFinite(px) || px <= 0) return "";
  return `.aiwb-board .excalidraw.excalidraw .FixedSideContainer_side_top { top: calc(var(--editor-container-padding) + var(${TOP_INSET_VAR})); }`;
}

export type Box = { x: number; y: number; width: number; height: number };
export type View = { scrollX: number; scrollY: number; zoom: number };

/** The scroll and zoom that fit `bounds` (scene coordinates) into the visible rect of a view `width` x `height` px: the view less
 *  `top` px above and `bottom` px below, `margin` px kept free on each side. The zoom is at most 1 (a small board stays at
 *  100 % and is centred), at least Excalidraw's own least, and rounded down so the box is never over the margin. A point on
 *  the screen is `(scene + scroll) * zoom`, as Excalidraw draws it. */
export function fitView(bounds: Box, view: { width: number; height: number }, top: number, bottom: number, margin: number): View {
  const room = { width: Math.max(view.width - 2 * margin, 1), height: Math.max(view.height - top - bottom - 2 * margin, 1) };
  const wanted = Math.min(1, room.width / bounds.width, room.height / bounds.height); // (a side of 0 is Infinity: no limit)
  const zoom = Math.max(Math.floor(wanted * 1e6) / 1e6, MIN_ZOOM);
  const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  return { scrollX: view.width / 2 / zoom - centre.x, scrollY: (top + (view.height - top - bottom) / 2) / zoom - centre.y, zoom };
}
