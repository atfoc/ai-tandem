// The web's useKeyboardAvoid: nothing to do. The browser moves the page for its own keyboard, and the layouts of the web build stay as they are.
// See useKeyboardAvoid.ts.
import { useRef } from "react";
import type { ScrollView, View } from "react-native";

import type { KeyboardAvoid } from "./keyboardavoid.types.ts";

const NONE = {} as KeyboardAvoid["scrollProps"];

export function useKeyboardAvoid(): KeyboardAvoid {
  return { rootRef: useRef<View>(null), inset: 0, scrollRef: useRef<ScrollView>(null), scrollProps: NONE };
}
