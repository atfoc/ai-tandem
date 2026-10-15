// Lifts a bottom bar above the soft keyboard (AD-62). AD-62 names react-native-keyboard-controller's KeyboardStickyView; that library is a
// native module that needs react-native-reanimated, and it has not been added to the app (package K3 could not build or run it: a native
// dependency is the orchestrator's decision). Until it is, this lifts by the keyboard's height with React Native's own Keyboard events:
// iOS follows `keyboardWillChangeFrame`, Android `keyboardDidShow` / `keyboardDidHide`. The library replaces this file and nothing else.
// [not verified on a device]
import { useEffect, useState, type ReactNode } from "react";
import { Keyboard, Platform, View } from "react-native";

export function KeyboardLift({ children }: { children: ReactNode }) {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const move = (e: { endCoordinates: { height: number; screenY: number } }) => setLift(Math.max(0, e.endCoordinates.height));
    const subs = ios
      ? [Keyboard.addListener("keyboardWillChangeFrame", move), Keyboard.addListener("keyboardWillHide", () => setLift(0))]
      : [Keyboard.addListener("keyboardDidShow", move), Keyboard.addListener("keyboardDidHide", () => setLift(0))];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return <View style={{ paddingBottom: lift }}>{children}</View>;
}
