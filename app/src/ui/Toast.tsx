// The one toast (ux-improvements goal 3.1.3): a short line at the bottom, above the composer or the home indicator, that lasts about
// 5 seconds, with at most one action: "Archived “Fix the flaky cart test”" with Undo, "Back online", "Studio added · its chats are
// in your list", "Another window is editing" with Edit here. A new toast replaces the one shown. `ToastHost` is drawn once, by the
// shell (Shell.tsx); a screen calls `showToast` and draws no toast of its own. A screen with a bar at its bottom (the composer) calls
// `useToastLift` with the bar's height, so that the toast sits above it.
//
// Contract of package F1 (plans/ux-improvements/PLAN.md). The store, the timer and the lifts are in toaststore.ts (React-free).
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { PHONE, TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";
import { getToast, getToastLift, hideToast, setToastLift, showToast, subscribeToast, type Shown, type ToastSpec } from "./toaststore.ts";

export { hideToast, showToast, type ToastSpec };

/** Asks for the toast to sit `px` points higher while the calling screen is shown (the height of its bottom bar); null asks for nothing.
 *  The screen that asked last wins; unmounting takes the ask back. */
export function useToastLift(px: number | null): void {
  const key = useRef({}).current;
  useEffect(() => { setToastLift(key, px); }, [key, px]);
  useEffect(() => () => setToastLift(key, null), [key]);
}

const FADE_MS = 180;
/** Points the toast rises while it fades in. */
const RISE = 12;
/** The toast's width on a wide window. */
const MAX_WIDTH = 560;
/** The gap between the toast and the home indicator, or the bar a screen asked for. */
const GAP = 8;

export function ToastHost() {
  const t = useTokens();
  const insets = useContext(SafeAreaInsetsContext);
  const s = useSyncExternalStore(subscribeToast, getToast);
  const lift = useSyncExternalStore(subscribeToast, getToastLift);
  const shown = useRef<Shown | null>(null); // what is drawn, which is the last toast while it fades out
  const fade = useRef(new Animated.Value(0)).current; // 0 gone, 1 risen
  const [, redraw] = useState(0);

  useEffect(() => {
    const native = Platform.OS !== "web";
    if (s) {
      if (!shown.current) fade.setValue(0);
      shown.current = s;
      if (native) AccessibilityInfo.announceForAccessibility(s.text);
      Animated.timing(fade, { toValue: 1, duration: FADE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
    } else if (shown.current) {
      Animated.timing(fade, { toValue: 0, duration: FADE_MS, easing: Easing.in(Easing.cubic), useNativeDriver: native }).start(({ finished }) => {
        if (!finished) return;
        shown.current = null;
        redraw((n) => n + 1);
      });
    }
  }, [s, fade]);

  const view = s ?? shown.current;
  if (!view) return null;
  const leaving = !s;
  return (
    <View pointerEvents="box-none" style={[styles.layer, { bottom: (insets?.bottom ?? 0) + GAP + lift }]}>
      <Animated.View
        {...tid(TID.toast, view.kind ? { kind: view.kind } : undefined)}
        pointerEvents={leaving ? "none" : "auto"}
        accessibilityLiveRegion="polite"
        {...(Platform.OS === "web" ? ({ role: "status", "aria-live": "polite" } as object) : null)}
        style={[styles.toast, { backgroundColor: t.text, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [RISE, 0] }) }] }]}>
        <Text {...tid(TID.toastText)} size={TYPE.secondary + 2} numberOfLines={2} style={[styles.text, { color: t.bg }]}>{view.text}</Text>
        {view.action ? <ToastAction action={view.action} /> : null}
      </Animated.View>
    </View>
  );
}

function ToastAction({ action }: { action: NonNullable<ToastSpec["action"]> }) {
  const t = useTokens();
  return (
    <Pressable {...tid(TID.toastAction)} accessibilityRole="button" accessibilityLabel={action.label} style={styles.action}
      onPress={() => { hideToast(); action.run(); }}>
      <Text size={TYPE.control} weight="600" style={{ color: t.accentSoft }}>{action.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  toast: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: PHONE.margin, maxWidth: MAX_WIDTH, paddingLeft: 16, paddingRight: 4, borderRadius: 12, minHeight: PHONE.target + 4 },
  text: { flexShrink: 1, paddingVertical: 8 },
  action: { minHeight: PHONE.target, minWidth: PHONE.target, justifyContent: "center", alignItems: "center", paddingHorizontal: 10 },
});
