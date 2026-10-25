// Width breakpoints (AD-72): three named layouts in one place. No React and no react-native here, so Node loads it;
// the hook that reads the window's size is in useLayout.ts.
export type Layout = "phone" | "tablet" | "desktop";

/** The first width (in points) of the tablet layout, and of the desktop layout. */
export const TABLET_FROM = 700;
export const DESKTOP_FROM = 1100;

/** The layout of a window `width` wide: a narrow browser window is the phone layout too. */
export function layoutOf(width: number): Layout {
  return width < TABLET_FROM ? "phone" : width < DESKTOP_FROM ? "tablet" : "desktop";
}

/** The layout of a window `width` by `height`. On a native device the shorter side decides whether it is a phone, so a phone held
 *  in landscape keeps the phone layout (PLAN.md, decision D4); a tablet is the layout of its width, as is every window of the web
 *  build and of Electron (a browser window is narrow on purpose). */
export function layoutOfWindow(width: number, height: number, native: boolean): Layout {
  return native && Math.min(width, height) < TABLET_FROM ? "phone" : layoutOf(width);
}
