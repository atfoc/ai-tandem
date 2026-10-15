// The widths of the window's parts on the wide layouts (AD-72; today's `.app` flex row and the Resizer's room), in one pure place
// so a test can hold them: the sidebar pane (or the rail that stands in for it), a board's chat panel, and the stage with what is
// left. DOM-free.
import { MIN_STAGE, PANES, clampWidth, type Widths } from "@aiwb/core/logic/layout.ts";

/** The rail a hidden sidebar leaves (`.side-rail`: 40 px). */
export const RAIL = 40;

/** Below this width a tablet cannot hold the sidebar, the chat panel and the stage at their least, side by side: the sidebar then
 *  starts hidden, and when it is shown it lies over the stage (AD-72). */
export const OVERLAY_BELOW = PANES.side.min + PANES.panel.min + MIN_STAGE;

/** Below this width the three at their default widths do not fit: the saved widths are fitted to the window (the stage keeps its
 *  least, and a pane keeps its own least). From here up the saved widths are used as they are, as the page does today: the user
 *  chose them, and the resizer already stops a drag at the room the window leaves. */
export const FITS_AT = PANES.side.def + PANES.panel.def + MIN_STAGE;

type Kind = "phone" | "tablet" | "desktop";

/** Whether the sidebar lies over the stage rather than beside it: a tablet window narrower than the three at their least. */
export const sideOverlays = (layout: Kind, width: number): boolean => layout === "tablet" && width < OVERLAY_BELOW;

/** Whether a sidebar that was never hidden or shown by the user starts hidden: where it would lie over the stage. */
export const startsHidden = (layout: Kind, width: number, saved: string | null): boolean => saved === null && sideOverlays(layout, width);

export type Layout = {
  /** The sidebar pane's width (beside the stage, or over it when `overlay`). */
  side: number;
  /** The chat panel's width; 0 when it is not drawn. */
  panel: number;
  /** The most each pane may be wide now: the Resizer's room (the stage keeps MIN_STAGE). */
  roomSide: number;
  roomPanel: number;
  /** What the window leaves the stage. */
  stage: number;
  /** The rail is drawn: the sidebar is hidden, or it lies over the stage. */
  rail: boolean;
  /** The pane is drawn beside the stage (shown, and not over it). */
  beside: boolean;
};

/** The widths of the parts in a window `win` wide. `widths` are the saved ones, kept to each pane's least and most. */
export function layoutWidths(win: number, widths: Widths, o: { sideHidden: boolean; panel: boolean; overlay: boolean }): Layout {
  const beside = !o.sideHidden && !o.overlay;
  const rail = !beside;
  const left = rail ? RAIL : 0;
  const squeeze = win < FITS_AT;
  const fit = (room: number) => (squeeze ? room : Infinity);
  const side = clampWidth("side", widths.side, fit(win - (o.panel ? PANES.panel.min : 0) - MIN_STAGE - (o.overlay ? RAIL : 0)));
  const roomPanel = Math.max(0, win - left - (beside ? side : 0) - MIN_STAGE);
  const panel = o.panel ? clampWidth("panel", widths.panel, fit(roomPanel)) : 0;
  const roomSide = Math.max(0, win - panel - MIN_STAGE);
  return { side, panel, roomSide, roomPanel, stage: Math.max(0, win - left - (beside ? side : 0) - panel), rail, beside };
}
