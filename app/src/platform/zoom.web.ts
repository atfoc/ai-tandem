// The screen's zoom on web (the toolbar's kept widths are of one zoom, AD-62): window.devicePixelRatio, read live, and a hook that draws
// again when it changes. A change of the browser's zoom is told by a media query on the resolution (once, and then asked again for the new
// one): it fires in the frame that has the new layout, before it is painted, which `useWindowDimensions` (a resize listener, then a state
// change a task later) does not.
import { useSyncExternalStore } from "react";

export const zoom = (): number => window.devicePixelRatio;

function subscribe(onChange: () => void): () => void {
  let query: MediaQueryList;
  const changed = () => { onChange(); watch(); };
  const watch = () => { query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); query.addEventListener("change", changed, { once: true }); };
  watch();
  return () => query.removeEventListener("change", changed);
}

export function useZoom(): number {
  return useSyncExternalStore(subscribe, zoom, () => 1);
}
