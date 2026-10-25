// The kit gallery's section "Toast" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// The readout `kit-toast-last` says "undo" after the Undo action ran. The lift case draws a fake bottom bar of 120 points at the bottom
// of the window that asks for the toast to sit above it. The gallery's ScrollView is a transformed box on the web, which would carry a
// `fixed` bar with its content: so the bar is drawn by `BarHost`, which the gallery mounts beside the ToastHost, outside the ScrollView.
import { useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { PHONE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { hideToast, showToast, useToastLift } from "../../ui/Toast.tsx";
import { useTheme } from "../../ui/theme.tsx";

const BAR = 120;

let barOn = false;
const barListeners = new Set<() => void>();
const setBar = (on: boolean) => { barOn = on; barListeners.forEach((l) => l()); };
const subscribeBar = (l: () => void) => { barListeners.add(l); return () => { barListeners.delete(l); }; };

/** The fake bottom bar while the lift case is on; mounted by the gallery next to the ToastHost. */
export function BarHost() {
  return useSyncExternalStore(subscribeBar, () => barOn) ? <FakeBar /> : null;
}

function FakeBar() {
  const { tokens: t } = useTheme();
  useToastLift(BAR);
  return (
    <View testID="kit-toast-bar" pointerEvents="none" style={[styles.bar, { backgroundColor: t.panel, borderColor: t.line2 }]}>
      <Text tone="muted">A bar of the screen (the composer)</Text>
    </View>
  );
}

export function Section() {
  const [last, setLast] = useState("");
  const bar = useSyncExternalStore(subscribeBar, () => barOn);
  return (
    <View style={styles.cases}>
      <View style={styles.row}>
        <Button label="Toast with Undo" testID="kit-open-toast-undo" size="touch"
          onPress={() => showToast({ text: "Archived “Fix the flaky cart test”", kind: "archived", action: { label: "Undo", run: () => setLast("undo") } })} />
        <Button label="Plain toast" testID="kit-open-toast-plain" size="touch" onPress={() => showToast({ text: "Back online", kind: "back-online" })} />
        <Button label="Short toast" testID="kit-open-toast-short" size="touch" onPress={() => showToast({ text: "Short toast", kind: "short", ms: 1500 })} />
        <Button label={bar ? "Hide the bar" : "Toast above a bar"} testID="kit-open-toast-lift" size="touch" onPress={() => setBar(!bar)} />
        <Button label="Hide toast" testID="kit-hide-toast" size="touch" onPress={() => hideToast()} />
      </View>
      <Text testID="kit-toast-last" tone="muted">{last}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cases: { gap: PHONE.margin / 2 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  bar: { ...(Platform.OS === "web" ? ({ position: "fixed" } as object) : { position: "absolute" }), left: 0, right: 0, bottom: 0, height: BAR, borderTopWidth: 1, alignItems: "center", justifyContent: "center" },
});
