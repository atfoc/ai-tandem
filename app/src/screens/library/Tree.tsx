// The rows of the library popup's list (the old page's Library.tsx `treeRow`, `hitRow`; library.css `.lib-row`): the tree, set in by depth alone, and the flat list of
// what a search finds. A row is a press (it chooses the item, or lands a move by the keys), a twist (it closes and opens), a context menu (a right click, a long
// press) and, for a prompt or a group of a connected library, the start of a drag (a Pan gesture: a mouse starts it by moving 5 px, a finger after a long press).
import { memo, useMemo, useRef, type RefObject } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { NEW_ROW, type Chosen, type Hit, type TreeRow } from "@aiwb/core/logic/libraryview.ts";

import { dragPointer } from "../../platform/dragpointer";
import type { ScrollGuard } from "../../platform/dragscroll.types.ts";
import { Chevron, GroupIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { dragging, pressBlocked } from "../sidebar/pressguard.ts";
import type { LibDrag } from "./libdrag.ts";
import { OffMark, PromptIcon, PromptLine, ServerIcon } from "./parts.tsx";

/** A row's own space at the left edge; each level of depth adds the tree's step (a prompt at the top is at the edge, what is in a group beside that group's line). */
export const PAD = 4;
const TWIST = 14;

export type RowCtx = {
  step: number;
  /** The key of the chosen row, "" with none; the one the keys reach with Tab; the one the keyboard moved the focus to last (it shows a ring). */
  chosenAt: string;
  tab: string;
  ring: string;
  /** What is lit as a place: the row that heads it and the rows in it (null: nothing). */
  lit: { head: string; inside: ReadonlySet<string> } | null;
  /** The item that is on its way to another place (dimmed), and whether the move is by the keys (a press lands it). */
  moved: Chosen | null;
  keyMove: boolean;
  drag: LibDrag;
  guard: ScrollGuard;
  press(r: TreeRow): void;
  toggle(key: string): void;
  menu(key: string, at: { x: number; y: number } | null): void;
  focused(key: string): void;
  blurred(key: string): void;
  ref(key: string): (el: View | null) => void;
  laid(key: string, y: number, h: number): void;
};

const itemOf = (r: TreeRow): Chosen => ({ kind: r.kind, server: r.server, id: r.id });
const sameItem = (a: Chosen | null, b: Chosen) => !!a && a.kind === b.kind && a.server === b.server && a.id === b.id;

/** A press and, when it comes again within `ms`, also a double: a double click of the page. A drag's last press is none. */
function useDoublePress(single: () => void, double: () => void, ms = 400): () => void {
  const last = useRef(0);
  return () => {
    if (pressBlocked()) return;
    const now = Date.now(), again = now - last.current < ms;
    last.current = again ? 0 : now;
    single();
    if (again) double();
  };
}

/** The Pan gesture of a row that can be dragged: always on (a row that cannot be dragged starts none), as the sidebar's rows have it. */
function useRowGesture(enabled: boolean, item: Chosen, key: string, ctx: Pick<RowCtx, "drag" | "guard" | "menu">) {
  const pointer = usePointer(), { drag, guard } = ctx;
  const latest = useRef(item), allowed = useRef(enabled), mine = useRef(false), held = useRef(false), menu = useRef(ctx.menu);
  latest.current = item;
  allowed.current = enabled;
  menu.current = ctx.menu;
  return useMemo(() => {
    const pan = Gesture.Pan().runOnJS(true).shouldCancelWhenOutside(false)
      .onStart((e) => {
        if (!allowed.current) { held.current = true; return; } // (a row that cannot be dragged: a finger held on it is a long press, which opens its menu)
        mine.current = true;
        dragging(true);
        guard.hold(true);
        drag.start(latest.current, { x: e.absoluteX, y: e.absoluteY }, pointer === "touch");
      })
      .onUpdate((e) => { if (mine.current) drag.move(dragPointer.now() ?? { x: e.absoluteX, y: e.absoluteY }); })
      .onEnd((e, ok) => {
        if (mine.current && ok) void drag.end({ x: e.absoluteX, y: e.absoluteY });
        else if (held.current && ok) setTimeout(() => menu.current(key, null), 150); // (after the finger left: see `tap` of the popup)
      })
      .onFinalize((_e, ok) => {
        held.current = false;
        if (!mine.current) return;
        mine.current = false;
        if (!ok) drag.cancel();
        dragging(false);
        guard.hold(false);
      });
    return pointer === "touch" ? pan.activateAfterLongPress(300) : pan.minDistance(5);
  }, [pointer, drag, guard]);
}

const menuEvent = (ctx: RowCtx, key: string) => ({
  onContextMenu: (e: { preventDefault(): void; stopPropagation(): void; clientX?: number; clientY?: number }) => {
    e.preventDefault(); e.stopPropagation();
    ctx.drag.cancel();
    ctx.menu(key, e.clientX === undefined ? null : { x: e.clientX, y: e.clientY ?? 0 });
  },
});

/** The guides of a row: a line for each group it is in, running down the row's whole height so that the rows touch with no gap. */
function Guides({ depth, step }: { depth: number; step: number }) {
  const t = useTokens();
  return <>{Array.from({ length: depth }, (_, d) => <View key={d} {...tid("lib-guide")} pointerEvents="none" style={[styles.guide, { left: PAD + d * step + 7, backgroundColor: t.line }]} />)}</>;
}

function Icon({ kind }: { kind: TreeRow["kind"] }) {
  return <View style={styles.icon}>{kind === "server" ? <ServerIcon /> : kind === "group" ? <GroupIcon /> : <PromptIcon />}</View>;
}

export const TreeRowView = memo(function TreeRowView({ r, ctx, canDrag }: { r: TreeRow; ctx: RowCtx; canDrag: boolean }) {
  const t = useTokens();
  const item = itemOf(r), on = r.key === ctx.chosenAt, moved = sameItem(ctx.moved, item);
  const mark = ctx.lit?.head === r.key ? "drop" : ctx.lit?.inside.has(r.key) ? "drop-in" : "";
  const gesture = useRowGesture(canDrag, item, r.key, ctx);
  const tip = useControlRef(r.name);
  const press = useDoublePress(() => ctx.press(r), () => { if (r.open !== undefined && !ctx.keyMove) ctx.toggle(r.key); });
  const ref = ctx.ref(r.key);
  const both = (el: View | null) => { ref(el); (tip as unknown as (x: unknown) => void)?.(el); };
  return (
    <GestureDetector gesture={gesture} touchAction="pan-y">
      <Pressable ref={both} {...tid("lib-row", { key: r.key, kind: r.kind, depth: r.depth, drop: mark || undefined, moved: moved || undefined, off: r.off || undefined, fixed: !canDrag || undefined, ring: ctx.ring === r.key || undefined })}
        role="treeitem" aria-level={r.depth + 1} aria-expanded={r.open} aria-selected={on} accessibilityState={{ selected: on }} tabIndex={r.key === ctx.tab ? 0 : -1}
        onPress={press} onFocus={() => ctx.focused(r.key)} onBlur={() => ctx.blurred(r.key)} {...menuEvent(ctx, r.key) as object}
        onLayout={(e) => ctx.laid(r.key, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
          styles.row, { paddingLeft: PAD + r.depth * ctx.step },
          on && { backgroundColor: t.accentSoft },
          !on && hovered && { backgroundColor: t.hover2 },
          mark === "drop" && { backgroundColor: t.accentSoft, boxShadow: `inset 0 0 0 1px ${t.accent}` },
          mark === "drop-in" && { backgroundColor: t.accentSoft, borderRadius: 0 },
          ctx.ring === r.key && { boxShadow: `inset 0 0 0 2px ${t.accent}` },
          moved && styles.moved,
          webStyle({ cursor: "default", userSelect: "none", outlineStyle: "none" }),
        ]}>
        <Guides depth={r.depth} step={ctx.step} />
        {r.open !== undefined ? (
          <Pressable {...tid("lib-twist", { open: r.open })} role="button" aria-label={r.open ? "Close" : "Open"} focusable={false} tabIndex={-1} hitSlop={4} onPress={() => ctx.toggle(r.key)} style={styles.twist}>
            <View style={r.open ? styles.open : undefined}><Chevron color={t.muted} /></View>
          </Pressable>
        ) : null}
        <Icon kind={r.kind} />
        <Text {...tid("lib-name")} numberOfLines={1} selectable={false} weight={r.kind === "server" ? "600" : r.kind === "group" ? "500" : undefined} style={styles.name}>{r.name}</Text>
        {r.kind === "server" && r.off ? <OffMark /> : null}
        {r.kind === "server" ? <Text {...tid("lib-count")} size={11} tone="faint" selectable={false}>{r.count}</Text> : null}
      </Pressable>
    </GestureDetector>
  );
});

/** The row of an item that is being made, where it goes, with the name as it is typed. */
export function NewRowView({ r, ctx, rowRef }: { r: TreeRow; ctx: RowCtx; rowRef: (el: View | null) => void }) {
  const t = useTokens();
  const mark = ctx.lit?.head === r.key ? "drop" : ctx.lit?.inside.has(r.key) ? "drop-in" : "";
  return (
    <View ref={rowRef} {...tid("lib-row", { key: NEW_ROW, kind: r.kind, depth: r.depth, new: true })} role="treeitem" aria-level={r.depth + 1} aria-selected accessibilityState={{ selected: true }}
      onLayout={(e) => ctx.laid(NEW_ROW, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      style={[styles.row, { paddingLeft: PAD + r.depth * ctx.step, backgroundColor: t.accentSoft }, mark === "drop" && { boxShadow: `inset 0 0 0 1px ${t.accent}` }]}>
      <Guides depth={r.depth} step={ctx.step} />
      {r.kind === "group" ? <View style={styles.twist} /> : null}
      <Icon kind={r.kind} />
      <Text {...tid("lib-name")} numberOfLines={1} selectable={false} tone="muted" style={[styles.name, styles.italic]}>{r.name.trim() || `New ${r.kind}`}</Text>
    </View>
  );
}

/** A prompt a search found: its path and name; a press chooses it. */
export function HitRowView({ h, k, on, tab, ctx }: { h: Hit; k: string; on: boolean; tab: boolean; ctx: Pick<RowCtx, "ref" | "focused" | "blurred" | "laid"> & { choose(): void; menu(at: { x: number; y: number } | null): void } }) {
  const t = useTokens();
  return (
    <Pressable ref={ctx.ref(k)} {...tid("lib-row", { key: k, kind: "prompt", hit: true, off: h.off || undefined })} role="option" aria-selected={on} accessibilityState={{ selected: on }} tabIndex={tab ? 0 : -1}
      onPress={ctx.choose} onFocus={() => ctx.focused(k)} onBlur={() => ctx.blurred(k)}
      {...({ onContextMenu: (e: { preventDefault(): void; stopPropagation(): void; clientX?: number; clientY?: number }) => { e.preventDefault(); e.stopPropagation(); ctx.menu(e.clientX === undefined ? null : { x: e.clientX, y: e.clientY ?? 0 }); } } as object)}
      onLayout={(e) => ctx.laid(k, e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.row, { paddingLeft: 8 }, on ? { backgroundColor: t.accentSoft } : hovered ? { backgroundColor: t.hover2 } : null, webStyle({ cursor: "default", userSelect: "none", outlineStyle: "none" })]}>
      <PromptIcon />
      <PromptLine h={h} />
    </Pressable>
  );
}

export type { RefObject };

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 26, paddingVertical: 2, paddingRight: 6, borderRadius: 5, position: "relative" },
  moved: { opacity: 0.5 },
  guide: { position: "absolute", top: 0, bottom: 0, width: 1 },
  icon: { flexShrink: 0 },
  twist: { width: TWIST, height: 18, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  open: { transform: [{ rotate: "90deg" }] },
  name: { flex: 1, minWidth: 0 },
  italic: { fontStyle: "italic" },
});
