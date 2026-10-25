// What a screen of the phone needs for a row of its list to be dragged after the hold (ux-improvements goal 3.3, h2-design.md §7): the
// box its list is seen through (a group row scrolled out of it takes no drop), the list's scroll kept by its own events so that a finger held
// near the edge scrolls it, the list held still while a finger is held on a row or a drag goes on, and whether this screen is the one on top
// (the screens under it stay drawn on the web, and their group rows must not take a drop). The label under the finger is `DragGhost` of
// sidebar/drag.tsx, drawn by the screen over everything in it.
import { useEffect, useMemo, useRef } from "react";
import { ScrollView, View } from "react-native";

import { makeScrollGuard } from "../../platform/dragscroll";
import { useEntryKey } from "../shell/phone/entry.ts";
import { useStack } from "../shell/useShellView.ts";
import { LOCK_SCROLL, scrollLocked, setClip, setScroller, useScrollLocked } from "../sidebar/drag.tsx";

/** Whether the screen this is drawn in is the top of the phone's stack (a screen with no entry is the only one). */
export function useIsTopScreen(): boolean {
  const key = useEntryKey(), stack = useStack();
  return key === null || stack[stack.length - 1]?.key === key;
}

export function useDragScreen() {
  const top = useIsTopScreen(), locked = useScrollLocked();
  const box = useRef<View>(null), list = useRef<ScrollView>(null);
  const at = useRef({ y: 0, content: 0, view: 0 });
  const guard = useMemo(makeScrollGuard, []);
  useEffect(() => {
    guard.guard(box.current);
    const off = scrollLocked.subscribe(() => guard.hold(scrollLocked.get()));
    return () => { off(); guard.hold(false); guard.guard(null); };
  }, [guard]);
  useEffect(() => {
    if (!top) return;
    setClip(box.current as never);
    setScroller((dy) => {
      const s = at.current, y = Math.max(0, Math.min(Math.max(0, s.content - s.view), s.y + dy));
      if (y === s.y) return;
      s.y = y;
      list.current?.scrollTo({ y, animated: false });
    });
    return () => { setClip(null); setScroller(null); };
  }, [top]);
  return {
    top,
    box,
    scroll: {
      ref: list,
      scrollEventThrottle: 16,
      scrollEnabled: !(LOCK_SCROLL && locked),
      onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => { at.current.y = e.nativeEvent.contentOffset.y; },
      onContentSizeChange: (_w: number, h: number) => { at.current.content = h; },
      onLayout: (e: { nativeEvent: { layout: { height: number } } }) => { at.current.view = e.nativeEvent.layout.height; },
    },
  };
}
