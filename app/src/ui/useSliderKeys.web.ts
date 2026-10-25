// The `keydown` of the element a slider draws as its track: `on` says whether the key is the slider's (and moves it); if so the event is
// `preventDefault`-ed (an arrow does not scroll the page) and stops here. The listener is the element's own, not a React `onKeyDown`: React hears
// a key at the root, after every listener of the elements around the slider, and a popover's `useMenuKeys` would already have moved the
// menu's focus with the same ArrowDown / Home / End. A key that is not the slider's goes on up as it was.
import { useCallback, useRef, type RefCallback } from "react";

import type { KeyPress } from "./sliderlogic.ts";

export function useSliderKeys(on: (press: KeyPress) => boolean): RefCallback<any> | undefined {
  const now = useRef(on);
  now.current = on;
  const off = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    off.current?.();
    off.current = null;
    if (!el?.addEventListener) return;
    const key = (e: KeyboardEvent) => {
      if (!now.current({ key: e.key, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey })) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("keydown", key);
    off.current = () => el.removeEventListener("keydown", key);
  }, []);
}
