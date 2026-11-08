// The navigation that tldraw gives through options alone (goal 3.1, 7.3; spike-ui.md has the table).
import type { TLCameraOptions, TldrawOptions } from "tldraw";

/** Zoom limits about 10%–400% (the first and last steps are the limits); the wheel pans, Ctrl/⌘ + wheel and a trackpad
 *  pinch (which the browser sends as a wheel with ctrlKey) zoom around the pointer. */
export const CAMERA: Partial<TLCameraOptions> = {
  wheelBehavior: "pan",
  zoomSteps: [0.1, 0.25, 0.5, 1, 2, 4],
  panSpeed: 1,
  zoomSpeed: 1,
  isLocked: false,
};

export const OPTIONS: Partial<TldrawOptions> = {
  // a double-click on empty canvas makes a sticky (src/nav/select.ts), not tldraw's text
  createTextOnCanvasDoubleClick: false,
  // Space + drag pans over anything (tldraw's own); the middle button always pans (tldraw's own, no option)
  spacebarPanning: true,
  // the right button stays for a context menu of ours later
  rightClickPanning: false,
  maxPages: 1,
};
