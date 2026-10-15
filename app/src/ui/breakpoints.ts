// Width breakpoints (AD-72): three named layouts in one place. No React and no react-native here, so Node loads it;
// the hook that reads the window's width is in useLayout.ts.
export type Layout = "phone" | "tablet" | "desktop";

/** The first width (in points) of the tablet layout, and of the desktop layout. */
export const TABLET_FROM = 700;
export const DESKTOP_FROM = 1100;

/** The layout of a window `width` wide: a narrow browser window is the phone layout too. */
export function layoutOf(width: number): Layout {
  return width < TABLET_FROM ? "phone" : width < DESKTOP_FROM ? "tablet" : "desktop";
}
