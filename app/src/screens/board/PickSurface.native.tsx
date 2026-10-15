// The pick surface on the phone and the tablet: a Tap of the gesture handler on the box the board's web view is drawn in. The layer over it
// takes no touch, so the page has every one (a pan, a pinch) and the tap is heard by the box, not by what lies on top. A tap that moved
// more than a few points is none (the recognizer's own `maxDistance`), and neither is one of two fingers.
import { useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { TAP_SLOP } from "./taps.ts";
import type { PickSurfaceProps } from "./PickSurface.types.ts";

export function PickSurface({ on, onTap, children }: PickSurfaceProps) {
  const latest = useRef(onTap);
  latest.current = onTap;
  const tap = useMemo(
    () => Gesture.Tap().runOnJS(true).enabled(on).maxDistance(TAP_SLOP).maxDuration(2000).onEnd((e, ok) => { if (ok) latest.current({ x: e.x, y: e.y }); }),
    [on],
  );
  return <GestureDetector gesture={tap}><View collapsable={false} style={styles.fill}>{children}</View></GestureDetector>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
