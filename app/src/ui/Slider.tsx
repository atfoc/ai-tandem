// A slider (small-improvements goal 3.4): a track and a handle that pick a whole number of steps between two ends, by a drag (finger or
// mouse), a tap on the track, the keyboard and a screen reader's adjust gesture, with − and + beside the track for one step. One component
// serves the delay before send (Settings > Voice) and the max chats (the Subagents popover and sheet). Design: plans/small-improvements/sliders.md.
//
// The drag and the tap are react-native-gesture-handler's Pan and Tap (as Sheet, SwipeRow and Resizer use them; no new dependency, goal 4.8),
// raced: a press that moves less than 10 points is a tap, one that goes 4 points sideways is a drag, one that goes 10 up or down is neither and
// scrolls whatever the slider is in. The arithmetic is sliderlogic.ts (Node tests it). The slider wraps itself in a GestureHandlerRootView: the
// Popover and the Dialog are drawn in a Modal that has no root of its own, and on native a gesture inside a Modal needs one.
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";

import { IconButton } from "./IconButton.tsx";
import { PHONE, TYPE } from "./metrics.ts";
import { fractionOf, keyStep, nudge, shouldCommit, valueAt } from "./sliderlogic.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { tid } from "./tid.ts";
import { usePointer } from "./usePointer";
import { useSliderKeys } from "./useSliderKeys";
import { webStyle } from "./webstyle.ts";

export type SliderProps = {
  /** The saved value (controlled). Shown whenever no drag is in progress. A value off the steps or out of the ends is shown as it is
   *  (the handle held to the ends); the first move snaps it. */
  value: number;
  min: number;
  max: number;
  /** One step: a drag snaps to it, an arrow key, −/+ and the adjust gesture move by it. */
  step: number;
  /** Page Up / Page Down; default 10 steps. */
  bigStep?: number;
  /** Its name, for a screen reader (the row's label). */
  label: string;
  /** The value in words: the number beside the track, the ends' labels, aria-valuetext / accessibilityValue.text. */
  format(v: number): string;
  /** A change the person made: once at the release of a drag, once per tap, key, −/+ press and adjust action. Never while the handle
   *  moves, never for the value it already has. */
  onCommit(v: number): void;
  /** While a drag moves the handle: each new value (live), before the one onCommit at the release. Optional. */
  onChange?(v: number): void;
  /** Greyed, cannot be moved or focused for a change; −/+ disabled. */
  disabled?: boolean;
  /** A small tick on the track at this value (the default), if it is strictly between the ends. */
  mark?: number;
  /** "touch": the phone's sizes (a 44 pt tall target, 44 pt −/+); "sm": the wide layouts' (a 28 px row, 24 px −/+). Default: "touch" when the
   *  pointer is a finger (usePointer: always on native, so an iPad's popover gets the 44 pt target too), else "sm". */
  size?: "sm" | "touch";
  /** false: ArrowUp/ArrowDown are not the slider's (they bubble, so a menu moves the focus); default true. */
  verticalKeys?: boolean;
  /** The root's testID; the parts are `<testID>-track` (role slider, the focusable one), `-handle`, `-value`, `-min`, `-max`, `-minus`,
   *  `-plus`, `-mark`. The root's dataSet: `value` (the shown value, live while dragging), `disabled`, `dragging`. */
  testID: string;
  /** The root's own style (its place in the row it is in); the slider fills the width it is given. */
  style?: StyleProp<ViewStyle>;
};

/** The sizes of the two looks: the row the track sits in, the −/+ squares and their glyph, the handle, the type of the value and of the ends'
 *  labels (the phone's never under `TYPE.secondary`). */
const LOOK = {
  sm: { row: 28, button: 24, glyph: 10, thick: 1.5, handle: 14, text: 13, ends: 11 },
  touch: { row: PHONE.target, button: PHONE.target, glyph: 14, thick: 2, handle: 24, text: TYPE.secondary, ends: TYPE.secondary },
} as const;

const TRACK = 4; // the track's thickness, in points
const MARK = { width: 2, height: 8 };
const TAP_SLOP = 10; // a press that moves less than this is a tap (the app's DRAG_SLOP)
const DRAG_START = 4; // sideways points after which a press is a drag
const SCROLL_START = 10; // up or down points after which it is the page's scroll
const GAP = 4; // between the track and the buttons and the value

export function Slider({ value, min, max, step, bigStep, label, format, onCommit, onChange, disabled, mark, size, verticalKeys, testID, style }: SliderProps) {
  const t = useTokens();
  const pointer = usePointer();
  const look = LOOK[size ?? (pointer === "touch" ? "touch" : "sm")];
  const r = look.handle / 2; // the handle's radius: the track area reaches this far past each end so the handle is never cut off
  const off = !!disabled;

  const [live, setLive] = useState<number | null>(null); // the value under the handle while a drag moves it (null: the saved value)
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(0); // the touch area's width
  const shown = live ?? value;
  const frac = fractionOf(shown, min, max);

  // what the gesture's callbacks and the keys read: the latest props, and the drag in progress
  const now = useRef({ value, min, max, step, bigStep, verticalKeys, off, width, r, onCommit, onChange });
  now.current = { value, min, max, step, bigStep, verticalKeys, off, width, r, onCommit, onChange };
  const drag = useRef({ left: 0, last: null as number | null, committed: false });
  const webX = useRef<number | null>(null); // web: where the pointer is, by the window's own events (the gesture's last move may not come)

  // (the gesture handler drops the pointer's last move when it comes in the frame of the release or leaves the touch area first)
  useEffect(() => {
    if (!dragging || Platform.OS !== "web") return;
    const move = (e: PointerEvent) => { webX.current = e.clientX; };
    window.addEventListener("pointermove", move, true);
    return () => { window.removeEventListener("pointermove", move, true); webX.current = null; };
  }, [dragging]);

  const commit = (v: number) => {
    const n = now.current;
    if (!n.off && shouldCommit(v, n.value)) n.onCommit(v);
  };
  const range = () => ({ min: now.current.min, max: now.current.max, step: now.current.step });
  /** The value for a point `x` along the touch area: its inner track starts one radius in and is as wide as the area less two. */
  const valueFor = (x: number) => {
    const n = now.current;
    return valueAt(x - n.r, n.width - 2 * n.r, n.min, n.max, n.step);
  };
  /** Where the pointer is along the touch area: the window's own position on the web while a drag is on, else the event's. */
  const along = (e: { x: number }) => (webX.current !== null ? webX.current - drag.current.left : e.x);
  const follow = (v: number) => {
    if (v === drag.current.last) return;
    drag.current.last = v;
    setLive(v);
    now.current.onChange?.(v);
  };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan().runOnJS(true).enabled(!off).activeOffsetX([-DRAG_START, DRAG_START]).failOffsetY([-SCROLL_START, SCROLL_START])
      .onBegin((e) => { drag.current = { left: e.absoluteX - e.x, last: now.current.value, committed: false }; })
      .onStart((e) => { setDragging(true); follow(valueFor(e.x)); })
      // (from the pointer's own position on the track, not `translationX`: that one starts where the pan activated, which lags behind)
      .onUpdate((e) => follow(valueFor(along(e))))
      .onEnd((e, ok) => {
        if (!ok) return;
        const v = valueFor(along(e));
        follow(v);
        drag.current.committed = true;
        commit(v);
      })
      .onFinalize(() => {
        // (a gesture the system took, or one that failed after it began, commits nothing and the handle goes back to the saved value)
        const d = drag.current;
        if (!d.committed && d.last !== null && d.last !== now.current.value) now.current.onChange?.(now.current.value);
        d.last = null;
        setLive(null);
        setDragging(false);
      });
    const tap = Gesture.Tap().runOnJS(true).enabled(!off).maxDistance(TAP_SLOP).maxDuration(5000) // (a slow press is still a tap)
      .onEnd((e, ok) => { if (ok) commit(valueFor(e.x)); });
    return Gesture.Race(pan, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [off]);

  const nudgeBy = (dir: 1 | -1) => commit(nudge(now.current.value, dir, range()));

  const keys = useSliderKeys(({ key, alt, ctrl, meta }) => {
    const n = now.current;
    if (n.off || alt || ctrl || meta) return false;
    const v = keyStep(key, n.value, { ...range(), bigStep: n.bigStep, verticalKeys: n.verticalKeys });
    if (v === null) return false;
    commit(v);
    return true;
  });

  const text = format(shown);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const markAt = mark !== undefined && mark > min && mark < max ? fractionOf(mark, min, max) : null;
  const valueWidth = Math.ceil(Math.max(format(min).length, format(max).length) * look.text * 0.62); // (room for the widest value, so the track does not move)

  return (
    <View {...tid(testID, { value: shown, disabled: off, dragging })} style={[styles.root, off && styles.off, style]}>
      <View style={styles.row}>
        <View style={{ height: look.row, justifyContent: "center", marginRight: GAP }}>
          <Step testID={`${testID}-minus`} plus={false} label={`Decrease ${label}`} look={look} slider={off} disabled={off || shown <= min} onPress={() => nudgeBy(-1)} />
        </View>
        <View style={styles.main}>
          <GestureHandlerRootView style={{ height: look.row }}>
            <GestureDetector gesture={gesture} touchAction="pan-y">
              <View ref={keys} {...tid(`${testID}-track`)} onLayout={onLayout}
                role="slider" accessible accessibilityLabel={label} aria-label={label}
                accessibilityValue={{ min, max, now: shown, text }}
                aria-valuemin={min} aria-valuemax={max} aria-valuenow={shown} aria-valuetext={text}
                accessibilityState={{ disabled: off }} aria-disabled={off}
                accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
                onAccessibilityAction={(e) => {
                  const a = e.nativeEvent.actionName;
                  if (a === "increment") nudgeBy(1); else if (a === "decrement") nudgeBy(-1);
                }}
                focusable={!off} tabIndex={off ? -1 : 0}
                style={[styles.area, { height: look.row, paddingHorizontal: r }, webStyle({ cursor: off ? "default" : "pointer" })]}>
                <View pointerEvents="none" style={[styles.bar, { backgroundColor: t.line2 }]}>
                  <View style={[styles.fill, { width: `${frac * 100}%`, backgroundColor: t.accentFill }]} />
                  {markAt !== null ? (
                    <View {...tid(`${testID}-mark`)} style={{ position: "absolute", left: `${markAt * 100}%`, marginLeft: -MARK.width / 2, top: (TRACK - MARK.height) / 2, width: MARK.width, height: MARK.height, backgroundColor: t.faint }} />
                  ) : null}
                  <View {...tid(`${testID}-handle`)}
                    style={{ position: "absolute", left: `${frac * 100}%`, marginLeft: -r, top: TRACK / 2 - r, width: look.handle, height: look.handle, borderRadius: r, borderWidth: 1, borderColor: t.line2, backgroundColor: t.knob, boxShadow: t.shadowSm }} />
                </View>
              </View>
            </GestureDetector>
          </GestureHandlerRootView>
          <View style={[styles.ends, { paddingHorizontal: r }]}>
            <Text {...tid(`${testID}-min`)} tone="muted" size={look.ends}>{format(min)}</Text>
            <Text {...tid(`${testID}-max`)} tone="muted" size={look.ends}>{format(max)}</Text>
          </View>
        </View>
        <View style={{ height: look.row, justifyContent: "center", marginLeft: GAP }}>
          <Step testID={`${testID}-plus`} plus label={`Increase ${label}`} look={look} slider={off} disabled={off || shown >= max} onPress={() => nudgeBy(1)} />
        </View>
        <View style={{ height: look.row, justifyContent: "center", marginLeft: GAP, minWidth: valueWidth }}>
          <Text {...tid(`${testID}-value`)} weight="500" size={look.text} style={styles.value}>{text}</Text>
        </View>
      </View>
    </View>
  );
}

/** The − or + beside the track: an icon button (the app's) that moves the value one step. `slider`: the slider as a whole is greyed, which
 *  greys this too, so the button's own greying does not come on top of it. */
function Step({ testID, plus, label, look, slider, disabled, onPress }: {
  testID: string; plus: boolean; label: string; look: (typeof LOOK)[keyof typeof LOOK]; slider: boolean; disabled: boolean; onPress(): void;
}) {
  return (
    <IconButton {...tid(testID, { slider: "step" })} title={label} size={look.button === PHONE.target ? "touch" : "sm"} disabled={disabled} onPress={onPress}
      style={[{ width: look.button, height: look.button }, slider && styles.whole]}>
      {(color) => (
        <View style={{ width: look.glyph, height: look.glyph, alignItems: "center", justifyContent: "center" }}>
          <View style={{ position: "absolute", width: look.glyph, height: look.thick, borderRadius: look.thick / 2, backgroundColor: color }} />
          {plus ? <View style={{ position: "absolute", width: look.thick, height: look.glyph, borderRadius: look.thick / 2, backgroundColor: color }} /> : null}
        </View>
      )}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  root: { alignSelf: "stretch" },
  off: { opacity: 0.5 },
  whole: { opacity: 1 },
  row: { flexDirection: "row", alignItems: "flex-start" },
  main: { flex: 1, minWidth: 0 },
  area: { justifyContent: "center" },
  bar: { height: TRACK, borderRadius: TRACK / 2 },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: TRACK / 2 },
  ends: { flexDirection: "row", justifyContent: "space-between", marginTop: 3 }, // (clear of the focus ring around the track)
  value: { textAlign: "right", fontVariant: ["tabular-nums"] },
});
