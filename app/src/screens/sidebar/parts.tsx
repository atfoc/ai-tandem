// The small parts the sidebar's rows, heads and foot are made of: the caret, the tags, the status dot, the rename box, and the slot of
// the buttons that show under the pointer (the old page's sections.css and styles.css, `.side-*`).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefCallback } from "react";
import { Pressable, StyleSheet, TextInput, View, type PressableProps, type StyleProp, type ViewProps, type ViewStyle } from "react-native";

import { branchCount } from "@aiwb/core/logic/branches.ts";
import { getState } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { focusTid } from "../../platform/focus";
import { useStore } from "../../state/useStore.ts";
import { BranchIcon, Chevron } from "../../ui/icons.tsx";
import { SANS } from "../../ui/fonts.ts";
import { useEscLayer } from "../../ui/useEscLayer";
import { Text as BaseText, type TextProps } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useHovered } from "../../ui/useHovered";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { SIDE_IDS } from "../shell/nav.ts";
import { pressBlocked } from "./pressguard.ts";

/** The sidebar's text: not selectable (a double press that renames would select a word, and a selection makes the next press of
 *  react-native-web's Pressable a selection's end, not a press). The sidebar was `user-select: none` on the page. */
export function Text(props: TextProps) {
  return <BaseText selectable={false} {...props} />;
}

/** Calls `end` when the sidebar is hidden, by the control or by the key: the one signal is the store's `sideHidden` being true, and each
 *  owner of something open (a menu, the row in rename mode) follows it with this. It runs before the page is painted and before the
 *  focus moves to the rail: a rename box is gone, its text dropped as by Esc, before it can lose the focus, which would save the text. */
export function useSideHidden(end: () => void, open = false): boolean {
  const hidden = useStore((s) => s.sideHidden);
  const lastOpen = useRef(0);
  if (open) lastOpen.current = Date.now();
  useLayoutEffect(() => {
    if (!hidden) return;
    end();
    // (a menu that was open, or that a pick has just closed, had the focus in the layer it is drawn in, which is no part of the pane: the focus
    // goes to the control that shows the sidebar again)
    if (open || Date.now() - lastOpen.current < 500) focusTid(SIDE_IDS.show);
  }, [hidden]);
  return hidden; // (a menu is drawn open only while the sidebar is shown: in the very render that hides it, and not a frame later)
}

/** A press and, when it comes again within `ms`, also a double: a double click of the page. `single` is run on every press, as the
 *  first click of a double click is. */
export function useDoublePress(single: () => void, double: () => void, ms = 400): () => void {
  const last = useRef(0);
  return () => {
    if (pressBlocked()) return; // (the end of a drag is no press)
    const now = Date.now();
    const again = now - last.current < ms;
    last.current = again ? 0 : now;
    single();
    if (again) double();
  };
}

/** The tooltip of a row or a head (on web), the way a control has it. */
export function useTip(title: string | undefined) {
  return useControlRef(title);
}

export function Caret({ open, hidden }: { open: boolean; hidden?: boolean }) {
  const t = useTokens();
  return (
    <View style={[styles.caret, open && styles.caretOpen, hidden && styles.caretNone]}>
      <Chevron color={t.faint} />
    </View>
  );
}

export function ArchivedTag() {
  const t = useTokens();
  return <View {...tid("archived-tag")} style={[styles.tag, { borderColor: t.line2 }]}><Text size={10} tone="muted" style={styles.italic}>Archived</Text></View>;
}

export function DisabledTag() {
  const t = useTokens();
  return <View {...tid("archived-tag")} style={[styles.tag, { borderColor: t.line2 }]}><Text size={10} tone="muted" style={styles.italic}>Disabled</Text></View>;
}

export function DraftTag({ other }: { other?: boolean }) {
  const t = useTokens();
  const title = useControlRef(other ? "Unsent message on another branch" : "Unsent message");
  return <View {...tid("draft-tag")} ref={title} style={[styles.tag, { borderColor: t.accent, opacity: 0.8 }]}><Text size={10} tone="accent">Draft</Text></View>;
}

export function NewDot() {
  const t = useTokens();
  const title = useControlRef("New — made by an agent");
  return <View {...tid("new-dot")} ref={title} style={[styles.newDot, { backgroundColor: t.accent }]} />;
}

/** How many branches a chat has, on its row; nothing for a chat that was never split. */
export function BranchBadge({ chat }: { chat: ChatView }) {
  const t = useTokens();
  const n = branchCount(chat);
  const title = useControlRef(`${n} branches`);
  if (n <= 1) return null;
  return (
    <View {...tid("branch-badge")} ref={title} style={[styles.badge, { backgroundColor: t.accentSoft }]}>
      <BranchIcon size={10} color={t.accent} />
      <Text size={10.5} tone="accent" weight="600">{n}</Text>
    </View>
  );
}

/** The dot of a chat: the colour of what it is doing (`crow-dot`). Over the agent's glyph (corner), or in a group's head (inline). */
export function StatusDot({ state, inline }: { state: string; inline?: boolean }) {
  const t = useTokens();
  const colour = state === "thinking" || state === "writing" || state === "tool" ? t.ok
    : state === "approval" ? t.warn : state === "waiting" ? t.muted : state === "stopped" || state === "error" ? t.danger : state === "off" ? t.line2 : "transparent";
  return <View {...tid("crow-dot", { state })} style={[inline ? styles.dotInline : styles.dot, !inline && { borderColor: t.panel }, { backgroundColor: colour }]} />;
}

/** The buttons of a row that show under the pointer: with a mouse hidden until the row is under it (or a menu of theirs is open),
 *  with a finger always drawn. */
export function Hover({ shown, children }: { shown: boolean; children: ReactNode }) {
  const pointer = usePointer();
  const visible = shown || pointer === "touch";
  return <View style={[styles.hover, !visible && webStyle({ visibility: "hidden" })]}>{children}</View>;
}

/** A row or a head that knows when it is under the pointer (a mouse's: ui/useHovered), and draws its content for it. It is a View with no
 *  press of its own (the press is its content's), so that a menu opened from inside it, drawn in a layer of its own, makes no press
 *  on the row. */
export function Frame({ children, style, title, place, ...rest }: Omit<ViewProps, "children" | "style"> & {
  children: (hovered: boolean) => ReactNode; style?: (hovered: boolean) => StyleProp<ViewStyle>; title?: string; place?: RefCallback<any>;
}) {
  const tip = useTip(title);
  const [track, hovered] = useHovered();
  const ref = useCallback((el: unknown) => { tip?.(el); track?.(el); place?.(el); }, [tip, track, place]);
  return <View {...rest} ref={ref} style={style?.(hovered)}>{children(hovered)}</View>;
}

/** A row that is itself the press (the element with the testID `side-row` is what a check or a screen reader acts on) and knows when it is under
 *  the pointer. While it is in rename mode it is a plain View, so that the box inside it (whose keys and presses would be a press of the row: a
 *  space typed is one) is in no press. The menus drawn from inside it stand in `Still` (menus.tsx), so a press in them is no press of the row. */
export function PressFrame({ editing, onPress, label, title, style, children, ...rest }: Omit<PressableProps, "children" | "style" | "onPress"> & {
  editing: boolean; onPress: () => void; label: string; title?: string; style: (hovered: boolean) => StyleProp<ViewStyle>; children: (hovered: boolean) => ReactNode;
}) {
  const tip = useTip(title);
  const [track, hovered] = useHovered();
  const ref = useCallback((el: unknown) => { tip?.(el); track?.(el); }, [tip, track]);
  if (editing) return <View {...(rest as ViewProps)} ref={ref} style={style(hovered)}>{children(hovered)}</View>;
  return <Pressable {...rest} ref={ref} accessibilityRole="button" aria-label={label} style={style(hovered)} onPress={onPress}>{children(hovered)}</Pressable>;
}

/** The part of a row or a head that a press acts on: a Pressable, and while its row is in rename mode a plain View, so that the box inside
 *  it (whose keys and presses would reach a Pressable above it: a space typed is a press) is not in a press of the row. */
export function PressArea({ editing, onPress, label, expanded, style, children }: {
  editing: boolean; onPress: () => void; label: string; expanded?: boolean; style: StyleProp<ViewStyle>; children: ReactNode;
}) {
  if (editing) return <View style={style}>{children}</View>;
  return (
    <Pressable accessibilityRole="button" aria-label={label} aria-expanded={expanded} accessibilityState={expanded === undefined ? undefined : { expanded }} style={style} onPress={onPress}>
      {children}
    </Pressable>
  );
}

/** The box a name is renamed in (`.name-input`): the name selected, with the focus. Enter saves, Escape drops what was typed,
 *  leaving the box saves it, unless the sidebar is hidden by then, which drops it as Escape does; `onDone` is told the trimmed text once ("" for
 *  Escape). (Hiding ends the box from the Sidebar's useSideHidden, but an owner's effect runs first and may move the focus to the rail while the
 *  box is still mounted: a row whose menu's "Rename" opened it moments before.) */
export function InlineName({ value, onDone, small }: { value: string; onDone: (v: string) => void; small?: boolean }) {
  const t = useTokens();
  const [v, setV] = useState(value);
  const done = useRef(false);
  const finish = (val: string) => { if (done.current) return; done.current = true; onDone(val.trim()); };
  useEffect(() => () => { done.current = true; }, []);
  useEscLayer(true, () => finish("")); // (web: in the order of the overlays, so an overlay or the drawer opened before the box is not closed by its Esc)
  return (
    <TextInput {...tid("name-input")} value={v} onChangeText={setV} autoFocus selectTextOnFocus autoCapitalize="none" autoCorrect={false}
      accessibilityLabel="Name" onBlur={() => finish(getState().sideHidden ? "" : v)} onSubmitEditing={() => finish(v)}
      onKeyPress={(e) => { if (e.nativeEvent.key === "Escape") finish(""); }}
      style={[styles.input, small && styles.inputSmall, { color: t.text, backgroundColor: t.bg, borderColor: t.accent, boxShadow: `0 0 0 3px ${t.accentSoft}` } as object,
        webStyle({ outlineStyle: "none" })]} />
  );
}

/** A line of small print under or in a row (`.side-empty`, `.side-section-line`). */
export function Line({ children, style, ...rest }: { children: ReactNode; style?: StyleProp<ViewStyle> } & Record<string, unknown>) {
  return <Text size={11.5} tone="faint" style={style as object} {...rest}>{children}</Text>;
}

const styles = StyleSheet.create({
  caret: { width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  caretOpen: { transform: [{ rotate: "90deg" }] },
  caretNone: { opacity: 0 },
  tag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, flexShrink: 0, justifyContent: "center" },
  italic: { fontStyle: "italic", lineHeight: 12 },
  newDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  badge: { flexDirection: "row", alignItems: "center", gap: 3, borderRadius: 8, paddingHorizontal: 5, height: 16, flexShrink: 0 },
  dot: { position: "absolute", right: -2, bottom: -2, width: 8, height: 8, borderRadius: 4, borderWidth: 2 },
  dotInline: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  hover: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 },
  input: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 5, fontFamily: SANS, fontSize: 13, fontWeight: "500" },
  inputSmall: { fontSize: 12 },
});
