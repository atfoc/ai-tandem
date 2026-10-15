// Keeps what has the focus in a sheet or a dialog above the on-screen keyboard (iOS and Android; the web's keyboard is the browser's, see
// useKeyboardAvoid.web.ts). The overlay's full-window layer is `rootRef`; `inset` is how many points of its bottom the keyboard covers, which the
// overlay leaves free (its surface sits above the keyboard and takes the height that is left). Measured against the layer itself, not taken
// from the keyboard's height alone: an Android window that the system already resizes for the keyboard is not covered twice. The overlay's
// scroll view gets `scrollProps` and `scrollRef`: when the keyboard comes or goes, and when another box takes the focus, the box that has
// it is scrolled into view (iOS does not do that for a scroll view; Android does, and this agrees with it).
import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, Keyboard, LayoutAnimation, Platform, TextInput, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView, type View } from "react-native";

import type { KeyboardAvoid } from "./keyboardavoid.types.ts";

const MARGIN = 12;
/** Room left under the box that has the focus, so what follows it (its hint, the next box, a check box) shows too. */
const ROOM_BELOW = 56;

export function useKeyboardAvoid(): KeyboardAvoid {
  const rootRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const [inset, setInset] = useState(0);
  const top = useRef(0); // the scroll offset, and the height of the part of the scroll view that shows
  const viewport = useRef(0);

  const reveal = useCallback(() => {
    const input = TextInput.State.currentlyFocusedInput?.();
    const scroll = scrollRef.current;
    const inner = (scroll as unknown as { getInnerViewRef?(): unknown } | null)?.getInnerViewRef?.(); // (it is there, but not in the types)
    if (!input || !inner || !viewport.current) return;
    input.measureLayout(inner as never, (_x, y, _w, h) => {
      const lo = top.current + MARGIN, hi = top.current + viewport.current - ROOM_BELOW;
      if (y < lo) scroll?.scrollTo({ y: Math.max(0, y - MARGIN), animated: false });
      else if (y + h > hi) scroll?.scrollTo({ y: y + h - viewport.current + ROOM_BELOW, animated: false });
    }, () => {});
  }, []);

  useEffect(() => {
    const ios = Platform.OS === "ios";
    const settle = () => { setTimeout(reveal, 50); setTimeout(reveal, 300); };
    const covered = (screenY: number, duration?: number) => {
      const node = rootRef.current;
      if (!node) return;
      node.measureInWindow((_x, y, _w, h) => {
        const next = Math.max(0, Math.round(y + h - screenY));
        if (ios && duration) LayoutAnimation.configureNext(LayoutAnimation.create(duration, "keyboard", "opacity"));
        setInset(next);
        settle();
      });
    };
    const subs = [
      Keyboard.addListener(ios ? "keyboardWillChangeFrame" : "keyboardDidShow", (e) => {
        const c = e.endCoordinates;
        // iOS: an undocked or floating keyboard (iPad) is not at the bottom edge and covers none of it.
        const docked = !ios || c.screenY + c.height >= Dimensions.get("screen").height - 1;
        covered(docked ? c.screenY : Number.MAX_SAFE_INTEGER, e.duration);
      }),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", (e) => {
        if (ios && e.duration) LayoutAnimation.configureNext(LayoutAnimation.create(e.duration, "keyboard", "opacity"));
        setInset(0);
        settle();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [reveal]);

  const scrollProps = {
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { top.current = e.nativeEvent.contentOffset.y; },
    onLayout: (e: LayoutChangeEvent) => { viewport.current = e.nativeEvent.layout.height; if (inset > 0) reveal(); },
    scrollEventThrottle: 16,
  };
  return { rootRef, inset, scrollRef, scrollProps };
}
