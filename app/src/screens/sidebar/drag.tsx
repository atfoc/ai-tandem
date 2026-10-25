// The sidebar's drag and drop on the screen (package S2, AD-70): a Pan gesture on every row and group header that can be dragged, the places
// that take a drop (a group's box, a server's ungrouped area, a group's header) measured when they are asked about, and the drop mark of
// logic/dropmark.ts that the zones and headers draw from. The old page's HTML drag events became one gesture:
//   a mouse starts the drag by moving 5 px with the button down; a finger starts it after a long press (300 ms), held still;
//   the point of the pointer is looked up in the places on every move (drophit.ts), the one mark is told what it found (dragsession.ts);
//   a release moves what is dragged where the mark was; Escape, the system's cancel and the dragged row going away end the drag with no move.
// `Zone` and the group header of rows.tsx draw the mark; this file only registers their places.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefCallback } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { Gesture } from "react-native-gesture-handler";

import { isUngrouped, sameServer, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { scrollGuard } from "../../platform/dragscroll";
import { dragPointer } from "../../platform/dragpointer";
import { onKey } from "../../platform/keys";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { canTakeGroup, groupsOf, markDrop, moveGroup, moveTo } from "./actions.ts";
import { takesOn, type Places, type Rect } from "./drophit.ts";
import { createDrag, type Dragged } from "./dragsession.ts";
import { dragging } from "./pressguard.ts";

// ---------------------------------------------------------------- the places

type Measurable = { measureInWindow?: (done: (x: number, y: number, width: number, height: number) => void) => void };
const zones = new Map<string, { group: string; el: Measurable }>(), heads = new Map<string, { group: string; el: Measurable }>();
let clip: Measurable | null = null;
let scroller: ((dy: number) => void) | null = null;

/** The way the sidebar's list is scrolled by a drag held near its edge (set by the sidebar while it is drawn). */
export function setScroller(f: ((dy: number) => void) | null): void { scroller = f; }

/** The box the places are seen through, when it is not the sidebar's (Home's and a group screen's list set theirs while they are the screen on top). */
export function setClip(el: Measurable | null): void { clip = el; }

/** The ref of a place that takes a drop: a group's (or a server's ungrouped area's) box, or a group's header. */
export function usePlace(kind: "zone" | "head", group: string): RefCallback<any> {
  const book = kind === "zone" ? zones : heads;
  return useCallback((el: Measurable | null) => { if (el) book.set(group, { group, el }); else book.delete(group); }, [book, group]);
}

/** The ref of the part of the tree that is on screen: a place scrolled out of it takes nothing. */
export const clipRef: RefCallback<any> = (el: Measurable | null) => { clip = el; scrollGuard.guard(el); };

/** A rectangle in the window; a view that is gone, or that never answers, has none (a measure that never comes back would stop the drag). */
const rectOf = (el: Measurable): Promise<Rect | null> => new Promise((done) => {
  if (!el.measureInWindow) return done(null);
  const late = setTimeout(() => done(null), 500);
  el.measureInWindow((x, y, width, height) => { clearTimeout(late); done(width || height ? { x, y, width, height } : null); });
});

async function measure(): Promise<Places> {
  const all = async (book: typeof zones) => (await Promise.all([...book.values()].map(async (p) => ({ group: p.group, rect: await rectOf(p.el) })))).filter((p): p is { group: string; rect: Rect } => !!p.rect);
  const [c, z, h] = await Promise.all([clip ? rectOf(clip) : null, all(zones), all(heads)]);
  return { clip: c, zones: z, heads: h };
}

// ---------------------------------------------------------------- the session

export const drag = createDrag({
  measure,
  mark: () => getState().dropAt,
  tell: markDrop,
  rules: { takes: takesOn(serverOfKey), canTakeGroup },
  drop: (d, target) => {
    if (d.kind === "row") {
      if (target.type === "in") moveTo(d.key, target.zone);
    } else if (target.type === "in") {
      if (sameServer(d.id, target.zone)) moveGroup(d.id, isUngrouped(target.zone) ? "" : target.zone);
    } else {
      moveGroup(d.id, groupsOf(target.head).find((g) => g.id === target.head)?.parent ?? "", target.head);
    }
  },
  keys: onKey,
  pointer: dragPointer,
  scroll: (dy) => scroller?.(dy),
  every: (f, ms) => { const id = setInterval(f, ms); return () => clearInterval(id); },
});

/** Whether a drag is going on (the sidebar holds its scroll still, on the platforms that need it). */
export const useDragActive = (): boolean => useSyncExternalStore(drag.source.subscribe, () => drag.source.get() !== null);

/** Whether this row or header is the one being dragged ("board:<key>", "chat:<key>", "group:<key>"). */
export const useIsDragged = (key: string): boolean => useSyncExternalStore(drag.source.subscribe, () => drag.source.get() === key);

/** On the platforms where the system's gesture arbitration does not keep a list still under a dragging finger, the sidebar's scroll view is
 *  switched off while a drag lasts (on web it would take the scrollbar away and move the places). */
export const LOCK_SCROLL = Platform.OS !== "web";

// ---------------------------------------------------------------- the gesture

/** A finger that holds first (the phone's Home: ux-improvements goal 3.3). With `holdMs` a finger's Pan activates after that long (`onHold`: the
 *  haptic); the drag starts only once the finger has moved `moveFirst` points from where it was held; a release before that is `onHoldRelease`
 *  (the row's sheet) and starts no drag. A mouse has no hold: the gesture is off (the row's own long press stays). Without options the gesture is
 *  the sidebar's (a finger held 300 ms drags at once, a mouse moves 5 px). */
export type HoldOpts = { holdMs?: number; moveFirst?: number; onHold?(): void; onHoldRelease?(): void };

const holdSet = new Set<() => void>();
let holding = false;
const setHolding = (on: boolean): void => { if (on !== holding) { holding = on; for (const f of [...holdSet]) f(); } };

/** Whether a finger is held on a row (before or after the drag started) or a drag goes on: the lists that scroll hold still. */
export const scrollLocked = {
  subscribe: (f: () => void): (() => void) => { holdSet.add(f); const off = drag.source.subscribe(f); return () => { holdSet.delete(f); off(); }; },
  get: (): boolean => holding || drag.active,
};
export const useScrollLocked = (): boolean => useSyncExternalStore(scrollLocked.subscribe, scrollLocked.get);

/** Runs `f` once the click that follows a finger's release has passed (on the web a sheet that opens on the release would be pressed through: the
 *  click lands on its backdrop and closes it); at once on the native platforms, which make no click, and after 400 ms where none comes. */
function afterRelease(f: () => void): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return f();
  let done = false;
  const run = () => { if (done) return; done = true; clearTimeout(late); window.removeEventListener("click", run, true); f(); };
  const late = setTimeout(run, 400);
  window.addEventListener("click", run, true);
}

/** The Pan gesture of a row or header, or an off one when it cannot be dragged (a row in rename mode, an archived or nested row). `make` says
 *  what is dragged; it is read when the drag starts. A drag removed with its row (the thing deleted meanwhile) ends with no move. */
export function useDragGesture(enabled: boolean, make: () => Dragged, opts?: HoldOpts) {
  const pointer = usePointer();
  const latest = useRef(make), allowed = useRef(enabled);
  latest.current = make;
  allowed.current = enabled;
  const mine = useRef(false);
  const hold = useRef<{ from: Point; started: boolean } | null>(null), hopts = useRef(opts);
  hopts.current = opts;
  const release = () => { mine.current = false; hold.current = null; setHolding(false); dragging(false); scrollGuard.hold(false); };
  useEffect(() => () => { if (mine.current) { if (hold.current?.started !== false) drag.cancel(); release(); } }, []);
  return useMemo(() => {
    // (always on: switching a gesture off and on makes the detector update its handler again, and the web detector then updates one it has
    // dropped; a row that cannot be dragged now starts none)
    const held = !!opts?.holdMs;
    const pan = Gesture.Pan().runOnJS(true).shouldCancelWhenOutside(false)
      .onStart((e) => {
        if (!allowed.current) return;
        mine.current = true;
        dragging(true);
        scrollGuard.hold(true);
        if (held) { hold.current = { from: { x: e.absoluteX, y: e.absoluteY }, started: false }; setHolding(true); hopts.current?.onHold?.(); return; }
        drag.start(latest.current(), { x: e.absoluteX, y: e.absoluteY });
      })
      .onUpdate((e) => {
        if (!mine.current) return;
        const h = hold.current, at = { x: e.absoluteX, y: e.absoluteY };
        if (h && !h.started) {
          if (Math.hypot(at.x - h.from.x, at.y - h.from.y) < (hopts.current?.moveFirst ?? 10)) return;
          h.started = true;
          drag.start(latest.current(), at);
          return;
        }
        drag.move(dragPointer.now() ?? at);
      })
      .onEnd((e, ok) => {
        if (!mine.current || !ok) return;
        if (hold.current && !hold.current.started) { afterRelease(() => hopts.current?.onHoldRelease?.()); return; }
        void drag.end({ x: e.absoluteX, y: e.absoluteY });
      })
      .onFinalize((_e, ok) => {
        if (!mine.current) return;
        const started = hold.current ? hold.current.started : true;
        release();
        if (!ok && started) drag.cancel();
      });
    // (a mouse drags at once, past a few pixels, so a click that moves a little is still a click; a finger is held first, and moving earlier is a scroll)
    if (pointer === "touch") return pan.activateAfterLongPress(opts?.holdMs ?? 300);
    return held ? pan.enabled(false) : pan.minDistance(5);
  }, [pointer, !!opts?.holdMs]);
}

// ---------------------------------------------------------------- the label

/** The name of what is dragged, under the pointer (a finger hides the row it holds). It is drawn in the sidebar, over everything in it. */
export function DragGhost() {
  const t = useTokens();
  const view = useSyncExternalStore(drag.view.subscribe, drag.view.get);
  const [origin, setOrigin] = useState<Point | null>(null);
  const box = useRef<View>(null);
  const on = !!view;
  useEffect(() => {
    if (!on) { setOrigin(null); return; }
    (box.current as Measurable | null)?.measureInWindow?.((x, y) => setOrigin({ x, y }));
  }, [on]);
  if (!view || !origin) return <View ref={box} pointerEvents="none" collapsable={false} style={styles.layer} />;
  return (
    <View ref={box} pointerEvents="none" collapsable={false} style={styles.layer}>
      <View {...tid("drag-ghost", { kind: view.kind })} pointerEvents="none"
        style={[styles.ghost, { left: view.at.x - origin.x + 12, top: view.at.y - origin.y + 8, backgroundColor: t.panel, borderColor: t.accent },
          webStyle({ boxShadow: `0 2px 8px ${t.line}` })]}>
        <Text numberOfLines={1} size={12.5} weight="500" selectable={false}>{view.title}</Text>
      </View>
    </View>
  );
}
type Point = { x: number; y: number };

const styles = StyleSheet.create({
  layer: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 50 },
  ghost: { position: "absolute", maxWidth: 220, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 7, borderWidth: 1, opacity: 0.92 },
});
