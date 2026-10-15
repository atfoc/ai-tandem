// The flash of a message where a quote points (native, AD-64; the web build highlights the words in the DOM instead): a layer over the message
// that is at full strength for about 1.6 s and then fades over 1.2 s, in the accent (the page's yellow of the highlight: the colour differs in
// light and dark). Drawn by every message and empty until its own message is the one flashed.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Animated, Easing, Platform, StyleSheet } from "react-native";

import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { FADE_MS, flashNow, HOLD_MS, subscribeFlash } from "./flash.ts";

export function MessageFlash({ chat, index }: { chat: string; index: number }) {
  const now = useSyncExternalStore(subscribeFlash, flashNow);
  if (!now || now.chat !== chat || now.item !== index) return null;
  return <Layer key={now.token} />;
}

function Layer() {
  const { theme } = useTheme();
  const level = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const run = Animated.sequence([Animated.delay(HOLD_MS), Animated.timing(level, { toValue: 0, duration: FADE_MS, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" })]);
    run.start();
    return () => run.stop();
  }, [level]);
  const colour = theme === "dark" ? "rgba(255, 204, 0, 0.38)" : "rgba(255, 214, 10, 0.55)";
  return <Animated.View {...tid("flash")} pointerEvents="none" style={[StyleSheet.absoluteFill, styles.layer, { backgroundColor: colour, opacity: level }]} />;
}

const styles = StyleSheet.create({ layer: { borderRadius: 8 } });
