// The drag handle on a pane's right edge that resizes it (today's Resizer.tsx): the sidebar, or a board's chat panel.
// A Pan gesture (AD-70): a mouse starts it at once, a finger on tablet too; a double click (double tap) gives the pane its
// default width. It draws nothing on the phone layout (AD-72: no resizer there). The widths themselves are the store's
// (`aiwb.widths`); this primitive reports them: `onResize(width, false)` on each step, `onResize(width, true)` at the
// end of a drag and on a reset, which is when the caller saves. The pane cannot grow past `room`: its own width plus
// what is left of the page right of it, less MIN_STAGE (the caller knows the page).
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { clampWidth, PANES, type Pane } from "@aiwb/core/logic/layout.ts";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { webStyle } from "./webstyle.ts";
import { useLayout } from "./useLayout.ts";

export type ResizerProps = {
  pane: Pane;
  /** The pane's width now. */
  width: number;
  /** The most the pane may be wide (default: no limit but the pane's own maximum). */
  room?: number;
  onResize(width: number, final: boolean): void;
};

export const RESIZER_TITLE = "Drag to resize, double-click to reset";

export function Resizer({ pane, width, room = Infinity, onResize }: ResizerProps) {
  const layout = useLayout();
  const { tokens: t } = useTheme();
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);
  // what the gesture's callbacks read: the latest props, and where the drag began
  const now = useRef({ width, room, onResize, pane });
  now.current = { width, room, onResize, pane };
  const start = useRef<{ x: number; w: number; room: number; last: number } | null>(null);
  const webX = useRef<number | null>(null); // web: where the pointer is, by the window's own events (the gesture's last move may not come)

  // (the gesture handler drops the pointer's last move when it comes in the frame of the release or leaves the thin handle first)
  useEffect(() => {
    if (!active || Platform.OS !== "web") return;
    const move = (e: PointerEvent) => { webX.current = e.clientX; };
    window.addEventListener("pointermove", move, true);
    return () => { window.removeEventListener("pointermove", move, true); webX.current = null; };
  }, [active]);

  // while dragging, the whole page shows the resize cursor and selects nothing (today's `body.resizing`)
  useEffect(() => {
    if (!active || Platform.OS !== "web") return;
    const body = document.body.style, was = { cursor: body.cursor, select: body.userSelect };
    body.cursor = "col-resize";
    body.userSelect = "none";
    return () => { body.cursor = was.cursor; body.userSelect = was.select; };
  }, [active]);

  const drag = Gesture.Pan().runOnJS(true).minDistance(1)
    .onBegin((e) => { const n = now.current; start.current = { x: e.absoluteX, w: n.width, room: n.room, last: n.width }; setActive(true); })
    .onUpdate((e) => {
      const s = start.current;
      if (!s) return;
      // (from the pointer's own position, not `translationX`: that one starts where the pan activated, which lags behind)
      const w = clampWidth(now.current.pane, s.w + e.absoluteX - s.x, s.room);
      if (w !== s.last) { s.last = w; now.current.onResize(w, false); }
    })
    .onEnd((e) => {
      // (the pointer's last position is the width: a move and the release that follows at once come as one event)
      const s = start.current;
      if (!s) return;
      const w = clampWidth(now.current.pane, s.w + (webX.current ?? e.absoluteX) - s.x, s.room);
      if (w !== s.last) { s.last = w; now.current.onResize(w, false); }
    })
    .onFinalize(() => {
      const s = start.current;
      start.current = null;
      setActive(false);
      if (s) now.current.onResize(s.last, true);
    });
  const reset = Gesture.Tap().runOnJS(true).numberOfTaps(2)
    .onEnd((_e, ok) => { if (ok) now.current.onResize(PANES[now.current.pane].def, true); });
  const gesture = Gesture.Exclusive(reset, drag);

  if (layout === "phone") return null;
  const { min, max } = PANES[pane];
  return (
    <GestureDetector gesture={gesture}>
      <Pressable testID={TID.resizer} accessibilityRole={"separator" as never} accessible
        aria-orientation="vertical" aria-valuenow={Math.round(width)} aria-valuemin={min} aria-valuemax={max}
        aria-label={RESIZER_TITLE}
        dataSet={{ pane, active }}
        focusable={false}
        onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        style={[styles.hit, webStyle({ cursor: "col-resize", touchAction: "none" })]}>
        <View pointerEvents="none" style={[styles.line, { backgroundColor: t.accent, opacity: active ? 1 : hovered ? 0.45 : 0 }]} />
      </Pressable>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: { position: "absolute", top: 0, bottom: 0, right: -4, width: 8, zIndex: 30 },
  line: { position: "absolute", top: 0, bottom: 0, left: 3, width: 2 },
});
