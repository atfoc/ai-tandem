// Lifts a bottom bar above the soft keyboard (AD-62). AD-62 names react-native-keyboard-controller's KeyboardStickyView; that library is a
// native module that needs react-native-reanimated, and it has not been added to the app (package K3 could not build or run it: a native
// dependency is the orchestrator's decision). Until it is, this lifts by the keyboard's height with React Native's own Keyboard events:
// iOS follows `keyboardWillChangeFrame`, Android `keyboardDidShow` / `keyboardDidHide`. The library replaces this file and nothing else.
// [not verified on a device]
//
// `gap` (the phone's composer, ux-improvements goal 3.6): the bar sits exactly `gap` points above the keys while they are up, with no safe-area
// gap under it. The lift is then what the keyboard covers of the bar's own bottom edge (measured in the window, as ui/useKeyboardAvoid.ts does),
// not the keyboard's height: that height includes the home indicator's area on iOS, which the shell's safe area has already left free under
// the bar. `inside` is the bottom padding the children already have, which counts towards the gap. Without `gap` the lift is the keyboard's
// height, as it always was (the tablet's composer).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Platform, View } from "react-native";

export function KeyboardLift({ children, gap, inside = 0 }: { children: ReactNode; gap?: number; inside?: number }) {
  const [lift, setLift] = useState(0);
  const root = useRef<View>(null);
  const exact = gap !== undefined;
  const move = useCallback((e: { endCoordinates: { height: number; screenY: number } }) => {
    const { height, screenY } = e.endCoordinates;
    const node = root.current;
    if (!exact || !node) { setLift(Math.max(0, height)); return; }
    // (the bar's bottom edge does not move with the padding this adds: the padding grows the bar upwards)
    node.measureInWindow((_x, y, _w, h) => {
      const covered = Math.round(y + h - screenY); // (none: a floating keyboard, or a window the system resized)
      setLift(covered > 0 ? Math.max(0, covered + gap - inside) : 0); // (the bar's own padding counts towards the gap; never a negative margin: it would move the edge measured here)
    });
  }, [exact, gap, inside]);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const subs = ios
      ? [Keyboard.addListener("keyboardWillChangeFrame", move), Keyboard.addListener("keyboardWillHide", () => setLift(0))]
      : [Keyboard.addListener("keyboardDidShow", move), Keyboard.addListener("keyboardDidHide", () => setLift(0))];
    return () => subs.forEach((s) => s.remove());
  }, [move]);
  return <View ref={root} collapsable={false} style={{ paddingBottom: lift }}>{children}</View>;
}

/** Whether the soft keyboard is up (the phone's chip row hides while it is: ux-improvements goal 3.6; the composer's key row of Indent and
 *  Outdent shows while it is). It starts from whether the keyboard is up now: Android sends no keyboardDidShow for a keyboard that was
 *  already up when the hook mounted (a composer drawn anew while typing). [not verified on a device] */
export function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const subs = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () => setUp(true)),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () => setUp(false)),
    ];
    setUp(Keyboard.isVisible()); // (what changed between the first render and the listeners)
    return () => subs.forEach((s) => s.remove());
  }, []);
  return up;
}
