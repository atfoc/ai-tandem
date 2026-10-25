// A row with swipe actions (ux-improvements goal 3.3): a left swipe shows actions at the right end (Archive grey, Delete red), each
// 88 pt wide and the row's full height; a full swipe runs the action marked `full` (Archive only: Delete must be tapped). A right
// swipe shows the actions at the left end (Archived's Unarchive). Built on react-native-gesture-handler's Pan and RN's Animated, as
// the Sheet is (no reanimated in the app). The swipe never takes the platform's edge swipe (it starts past the left edge's 20 pt).
// On the wide layouts and the web's mouse a row has no swipe: its actions are in its menu, as today.
//
// Contract of package F1 (plans/ux-improvements/PLAN.md).
//
// The front moves with the finger (RN Animated); a release past half of the buttons' width, or a fling, settles open, else it springs
// closed. A full swipe (past 60 % of the row, when the side has a `full` action) runs that action: the front leaves, the action runs,
// the row closes. One row is open at a time (swipeopen.ts); while one is open a touch on any swipe row only closes it (the first tap
// closes, it does not reach the content). The pan is a finger's: on the web a mouse drag does nothing (the pointer type is read at
// its begin). The grey button is `muted` with the page's own `bg` as its label: white on `muted` is 5:1 in the light theme but 2.5:1 in
// the dark one, `bg` on `muted` is about 5:1 and 7:1.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, PointerType } from "react-native-gesture-handler";

import { Text } from "./Text.tsx";
import { clearOpen, closeOpen, closeOthers, nextRowId, setOpen, swiped, useOpenRow } from "./swipeopen.ts";
import { ACTION_WIDTH, actionsWidth, dragPosition, mayStart, restAt, settle, type Settle, type Sides } from "./swipelogic.ts";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

export type SwipeAction = {
  /** Stable: the button's dataSet `action`. */
  id: string;
  label: string;
  tone: "grey" | "danger" | "accent";
  onPress(): void;
  /** A full swipe runs it (at most one per side). */
  full?: boolean;
};

export type SwipeRowProps = {
  children: ReactNode;
  /** Shown by a left swipe, at the right end, in order. */
  right?: SwipeAction[];
  /** Shown by a right swipe, at the left end. */
  left?: SwipeAction[];
  testID?: string;
  data?: Record<string, string>;
};

/** The ids of the buttons a swipe shows, for the checks: `swipe-action` with dataSet `action`. */
export const SWIPE_ACTION_ID = TID.swipeAction;

const SETTLE_MS = 160;

export function SwipeRow({ children, right, left, testID = TID.swipeRow, data }: SwipeRowProps) {
  if (!right?.length && !left?.length) return <View {...tid(testID, data)}>{children}</View>;
  return <Swipeable right={right ?? []} left={left ?? []} testID={testID} data={data}>{children}</Swipeable>;
}

type Side = "right" | "left";

function Swipeable({ children, right, left, testID, data }: Required<Omit<SwipeRowProps, "data">> & { data?: Record<string, string> }) {
  const t = useTokens();
  const id = useRef(nextRowId()).current;
  const openId = useOpenRow();
  const x = useRef(new Animated.Value(0)).current;
  const at = useRef(0); // where the front is, in points
  const [revealed, setRevealed] = useState<Side | null>(null);
  const [rowWidth, setRowWidth] = useState(0);

  const sides: Sides = {
    rightWidth: actionsWidth(right.length), leftWidth: actionsWidth(left.length), rowWidth,
    rightFull: right.some((a) => a.full), leftFull: left.some((a) => a.full),
  };
  const live = useRef({ sides, right, left });
  live.current = { sides, right, left };

  useEffect(() => {
    const l = x.addListener(({ value }) => { at.current = value; });
    return () => { x.removeListener(l); clearOpen(id); };
  }, [x, id]);

  const native = Platform.OS !== "web";
  const moveTo = (to: number, done?: () => void) => {
    Animated.timing(x, { toValue: to, duration: SETTLE_MS, useNativeDriver: native }).start(({ finished }) => { if (finished) done?.(); });
  };
  const close = () => {
    clearOpen(id);
    moveTo(0, () => setRevealed(null));
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const run = (a: SwipeAction) => { a.onPress(); close(); };
  const runFull = (side: Side) => {
    const a = (side === "right" ? live.current.right : live.current.left).find((b) => b.full);
    if (!a) return close();
    moveTo(restAt(side === "right" ? "full-right" : "full-left", live.current.sides), () => { a.onPress(); close(); });
  };
  const apply = (to: Settle) => {
    if (to === "closed") return close();
    if (to === "full-right") return runFull("right");
    if (to === "full-left") return runFull("left");
    setOpen(id, () => closeRef.current());
    moveTo(restAt(to, live.current.sides));
  };

  const allowed = useRef(false);
  const base = useRef(0);
  const pan = Gesture.Pan().runOnJS(true).activeOffsetX([-10, 10]).failOffsetY([-10, 10])
    .onBegin((e) => {
      // A mouse does not swipe (the web); a finger inside the left edge is the platform's back swipe.
      allowed.current = e.pointerType !== PointerType.MOUSE && mayStart(e.absoluteX);
    })
    .onStart(() => {
      if (!allowed.current) return;
      swiped();
      x.stopAnimation();
      base.current = at.current;
      closeOthers(id);
    })
    .onUpdate((e) => {
      if (!allowed.current) return;
      const p = dragPosition(base.current, e.translationX, live.current.sides);
      x.setValue(p);
      setRevealed((r) => (p < 0 ? "right" : p > 0 ? "left" : r));
    })
    .onEnd((e) => {
      if (!allowed.current) return;
      allowed.current = false;
      swiped(); // (the content's press that may end this touch is no press: `swipePressBlocked`)
      apply(settle(at.current, e.velocityX, live.current.sides));
    });

  const shown = revealed === "left" ? left : right;
  const fullAction = shown.find((a) => a.full);
  const tone = (a: SwipeAction) => (a.tone === "danger" ? t.dangerFill : a.tone === "accent" ? t.accentFill : t.muted);
  const label = (a: SwipeAction) => (a.tone === "danger" ? t.onDanger : a.tone === "accent" ? t.onAccent : t.bg);
  const onLayout = (e: LayoutChangeEvent) => setRowWidth(e.nativeEvent.layout.width);
  const anyOpen = openId !== null;

  return (
    <View {...tid(testID, data)} onLayout={onLayout} style={styles.row}>
      {revealed ? (
        <View style={[StyleSheet.absoluteFill, styles.actions, { justifyContent: revealed === "right" ? "flex-end" : "flex-start", backgroundColor: fullAction ? tone(fullAction) : undefined }]}>
          {shown.map((a) => (
            <Pressable key={a.id} {...tid(TID.swipeAction, { action: a.id })} accessibilityRole="button" accessibilityLabel={a.label}
              onPress={() => run(a)} style={[styles.action, { backgroundColor: tone(a) }]}>
              <Text size={15} weight="600" style={{ color: label(a) }} numberOfLines={1}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <GestureDetector gesture={pan} touchAction="pan-y">
        <Animated.View {...tid(TID.swipeFront)} style={[{ backgroundColor: t.bg, transform: [{ translateX: x }] }]}
          accessibilityActions={[...right, ...left].map((a) => ({ name: a.id, label: a.label }))}
          onAccessibilityAction={(e) => { const a = [...live.current.right, ...live.current.left].find((b) => b.id === e.nativeEvent.actionName); if (a) run(a); }}>
          {children}
          {anyOpen ? <Pressable style={StyleSheet.absoluteFill} accessible={false} focusable={false} tabIndex={-1} onPress={closeOpen} /> : null}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { overflow: "hidden" },
  actions: { flexDirection: "row", alignItems: "stretch" },
  action: { width: ACTION_WIDTH, alignItems: "center", justifyContent: "center" },
});
