// Where the landscape controls sit (FloatingControls, package B1): 8 pt from each edge of the screen, and clear of what the notch, the
// rounded corners and the home indicator take. No React here, so Node loads it.
export const FLOAT_EDGE = 8;

/** The gap (pt) kept between the floating controls' bottom edge and Excalidraw's top bar. */
export const TOP_INSET_GAP = 8;

/** The `topInset` the view is sent for floating controls whose lowest edge is `bottom` pt from the top of the board: that and the gap, a whole
 *  number from 0 to 200 (the bridge's range); 0 for no controls (nothing measured, landscape ended). */
export function topInsetFor(bottom: number | null | undefined): number {
  if (bottom == null || !Number.isFinite(bottom) || bottom <= 0) return 0;
  return Math.min(200, Math.max(0, Math.ceil(bottom + TOP_INSET_GAP)));
}

type Insets = { top: number; right: number; bottom: number; left: number } | null | undefined;

/** The distance of the controls from each edge: the gap, or the safe area's inset where that is more. */
export function floatEdges(insets: Insets): { top: number; right: number; bottom: number; left: number } {
  const at = (n: number | undefined) => Math.max(FLOAT_EDGE, n ?? 0);
  return { top: at(insets?.top), right: at(insets?.right), bottom: at(insets?.bottom), left: at(insets?.left) };
}
