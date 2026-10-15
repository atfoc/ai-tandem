// What useKeyboardAvoid gives an overlay (useKeyboardAvoid.ts, and the web's, which gives nothing to do).
import type { RefObject } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView, View } from "react-native";

export type KeyboardAvoid = {
  /** The overlay's full-window layer. */
  rootRef: RefObject<View | null>;
  /** How many points of the layer's bottom the keyboard covers. */
  inset: number;
  scrollRef: RefObject<ScrollView | null>;
  scrollProps: {
    onScroll(e: NativeSyntheticEvent<NativeScrollEvent>): void;
    onLayout(e: LayoutChangeEvent): void;
    scrollEventThrottle: number;
  };
};
