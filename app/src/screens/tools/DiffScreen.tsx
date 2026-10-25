// The full diff (ux-improvements goal 3.5, package T2): "Show full diff" under a step of the thread pushes this screen. It is a content
// screen and draws its own bar: the file's name, its folder under it, Wrap and Copy. Under the bar a summary ("+5 −2 · 2 changes") with
// the position among the changes and the two jumps. Then every line of the change, with the old and the new line number at the left, the
// text in mono; a long run of unchanged lines is one row ("⋯ 41 unchanged lines") that a tap opens in place. What the rows are is decided
// by core's logic/fulldiff.ts.
//
// Wrap off: the lines keep their shape and the text scrolls sideways beside the numbers, which stay where they are. Every row has a fixed
// height then, so the rows of the numbers and the rows of the text line up without measuring, and the heads and folds, which span the
// screen, are drawn over both columns at the place their height gives. Wrap on: a line wraps, a row is as high as its text, and the
// numbers are part of each row; there is no sideways scroll.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { expand, changeStarts, fullDiff, unifiedDiff, type FullDiff, type Line, type Seg } from "@aiwb/core/logic/fulldiff.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { listsOf, serverOf } from "@aiwb/core/logic/serverlists.ts";
import { subKey } from "@aiwb/core/logic/subagents.ts";
import { changeOf, resultText, shownPath, type Where } from "@aiwb/core/logic/toolcard.ts";
import { shownView } from "@aiwb/core/state/store.ts";

import { copyText } from "../../platform/clipboard";
import { useStore } from "../../state/useStore.ts";
import { ContentBar } from "../../ui/Bars.tsx";
import { MONO } from "../../ui/fonts.ts";
import { DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { alpha } from "../chat/colour.ts";
import { useSubThread } from "../subagents/hooks.ts";
import { NavBack } from "../shell/BackButton.tsx";
import type { DiffParams } from "./diff.ts";
import { T2_TID } from "./ids.ts";

const CODE = 13;
const CHAR = CODE * 0.6; // a mono character's width, by which the number columns are sized
const ROW = 22;
const HEAD = 32;
const FOLD = PHONE.target;
const SIGN = 16;
const SUMMARY = 40;
/** The gap kept above a change that a jump scrolls to. */
const LEAD = 6;

type Entry =
  | { k: "head"; text: string; y: number }
  | { k: "fold"; id: string; count: number; y: number }
  | { k: "line"; line: Line; y: number; change?: number };

const height = (e: Entry) => (e.k === "head" ? HEAD : e.k === "fold" ? FOLD : ROW);
const digits = (n: number) => String(n).length;

/** The rows to draw: each edit's head (when it has one) and its segments, the folds in `open` opened. `changes` counts the changes. */
function entriesOf(diff: FullDiff, open: ReadonlySet<string>): { entries: Entry[]; changes: number } {
  const entries: Entry[] = [];
  let y = 0, changes = 0;
  const push = (e: Entry) => { entries.push(e); y += height(e); };
  for (const edit of diff.edits) {
    if (edit.head) push({ k: "head", text: edit.head, y });
    const segs: Seg[] = expand(edit, open);
    const starts = new Set(changeStarts(segs));
    segs.forEach((s, i) => {
      if (s.seg === "fold") push({ k: "fold", id: s.id, count: s.lines.length, y });
      else push({ k: "line", line: s.line, y, change: starts.has(i) ? changes++ : undefined });
    });
  }
  return { entries, changes };
}

/** The widest line number a diff shows, which sizes the number columns (a fold's lines are counted: it may be opened). */
function widest(diff: FullDiff): number {
  let n = 1;
  for (const e of diff.edits) for (const s of e.segs) for (const l of s.seg === "fold" ? s.lines : [s.line]) n = Math.max(n, l.a ?? 0, l.b ?? 0);
  return n;
}

export function DiffScreen({ params }: { params: DiffParams }) {
  const { chat, branch, tool, sub, file } = params;
  const t = useTokens();
  const insets = useContext(SafeAreaInsetsContext);
  const item = useStore((s) => {
    const key = branchKey(chat, branch);
    return s.items[sub ? subKey(key, sub) : key]?.items.find((i) => i.toolId === tool);
  });
  useSubThread(chat, sub ?? "", !!sub && !item);
  const home = useStore((s) => { const c = shownView(s, chat); return c ? listsOf(s, serverOf(c))?.home : undefined; });
  const cwd = useStore((s) => shownView(s, chat)?.cwd);
  const where = useMemo<Where>(() => ({ cwd, home }), [cwd, home]);
  const change = useMemo(() => (item ? changeOf(item) : null), [item]);
  const result = item ? resultText(item) : undefined;
  const diff = useMemo(() => (change ? fullDiff(change, result) : null), [change, result]);
  const shown = change ? shownPath(change.path, where) : "";
  const folder = shown.includes("/") ? shown.slice(0, shown.lastIndexOf("/")) : "";

  const [wrap, setWrap] = useState(false);
  const copy = () => {
    if (!diff || !change) return;
    copyText(unifiedDiff(diff, shown, change.kind)).then(() => showToast({ text: "Copied" }), () => showToast({ text: "Could not copy the change" }));
  };
  const button = (testID: string, label: string, name: string, onPress: () => void, on?: boolean) => (
    <Pressable testID={testID} dataSet={on === undefined ? undefined : { on }} accessibilityRole="button" aria-pressed={on} accessibilityLabel={name} onPress={onPress}
      style={{ minWidth: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" }}>
      <View style={[{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: on === undefined ? "transparent" : on ? t.accent : t.line }, on ? { backgroundColor: alpha(t.accent, 0.14) } : null]}>
        <RNText selectable={false} style={{ fontSize: TYPE.control, color: t.accent }}>{label}</RNText>
      </View>
    </Pressable>
  );
  const bar = (
    <ContentBar back={<NavBack />} title={file} sub={folder || undefined}
      actions={diff ? <>{button(T2_TID.diffWrap, "Wrap", wrap ? "Wrap lines, on" : "Wrap lines", () => setWrap((w) => !w), wrap)}{button(T2_TID.diffCopy, "Copy", "Copy the change", copy)}</> : undefined} />
  );
  return (
    <View {...tid(T2_TID.diffScreen, { tool })} style={{ flex: 1, minHeight: 0, backgroundColor: t.bg }}>
      {bar}
      {diff ? <Body diff={diff} wrap={wrap} bottom={Math.max(PHONE.margin, insets?.bottom ?? 0)} />
        : <Text tone="muted" size={TYPE.control} style={{ padding: PHONE.margin }}>This change is no longer in the chat.</Text>}
    </View>
  );
}

function Body({ diff, wrap, bottom }: { diff: FullDiff; wrap: boolean; bottom: number }) {
  const t = useTokens();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const { entries, changes } = useMemo(() => entriesOf(diff, open), [diff, open]);
  const numberW = digits(widest(diff)) * CHAR + 10;
  const gutterW = 2 * numberW + 1;
  const [width, setWidth] = useState(0);

  // where each change starts, in the scroll's content: the rows' own place without wrap, what each row measured with it
  const ys = useRef<number[]>([]);
  const view = useRef({ h: 0, content: 0 });
  const scroll = useRef<ScrollView>(null);
  ys.current.length = changes;
  if (!wrap) for (const e of entries) if (e.k === "line" && e.change !== undefined) ys.current[e.change] = e.y;
  const [at, setAt] = useState(0);
  // the change a jump asked for, which the position shows until the finger takes the scroll
  const [asked, setAsked] = useState<number | null>(null);
  const position = Math.min(asked ?? at, Math.max(0, changes - 1));

  const follow = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    view.current = { h: layoutMeasurement.height, content: contentSize.height };
    const end = contentOffset.y + layoutMeasurement.height >= contentSize.height - 2;
    let n = 0;
    ys.current.forEach((y, i) => { if (y <= contentOffset.y + LEAD + 2) n = i; });
    setAt(end && contentOffset.y > 0 ? Math.max(0, ys.current.length - 1) : n);
  }, []);
  useEffect(() => { setAsked(null); }, [wrap]);
  const jump = (to: number) => {
    if (to < 0 || to >= changes) return;
    setAsked(to);
    scroll.current?.scrollTo({ y: Math.max(0, (ys.current[to] ?? 0) - LEAD), animated: true });
  };
  const openFold = (id: string) => setOpen((o) => new Set(o).add(id));

  const tint = (l: Line) => (l.kind === "add" ? alpha(t.ok, 0.15) : l.kind === "del" ? alpha(t.danger, 0.13) : undefined);
  const tone = (l: Line) => (l.kind === "add" ? t.ok : l.kind === "del" ? t.danger : t.muted);
  const code = { fontFamily: MONO, fontSize: CODE, lineHeight: ROW, color: t.text } as const;
  const num = (l: Line, which: "a" | "b") => {
    const n = l[which];
    return (
      <RNText selectable={false} style={{ width: numberW, paddingRight: 6, textAlign: "right", fontFamily: MONO, fontSize: CODE, lineHeight: ROW, fontVariant: ["tabular-nums"], color: l.kind === "same" ? t.faint : n === undefined ? t.faint : tone(l) }}>
        {n ?? ""}
      </RNText>
    );
  };
  const nums = (l: Line, grow?: boolean) => (
    <View style={{ width: gutterW, flexDirection: "row", flexGrow: grow ? 1 : 0, backgroundColor: tint(l) ?? t.panel, borderRightWidth: 1, borderRightColor: t.line }}>{num(l, "a")}{num(l, "b")}</View>
  );
  const sign = (l: Line) => <RNText selectable={false} style={{ width: SIGN, textAlign: "center", fontFamily: MONO, fontSize: CODE, lineHeight: ROW, color: tone(l) }}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</RNText>;
  const text = (l: Line) => l.text.replace(/\t/g, "    ");

  const head = (e: Extract<Entry, { k: "head" }>, style?: object) => (
    <View key={`h${e.y}`} style={[{ height: HEAD, justifyContent: "center", paddingHorizontal: PHONE.margin, backgroundColor: t.panel, borderBottomWidth: 1, borderBottomColor: t.line }, style]}>
      <Text size={TYPE.secondary} weight="600" tone="muted" numberOfLines={1}>{e.text}</Text>
    </View>
  );
  const fold = (e: Extract<Entry, { k: "fold" }>, style?: object) => (
    <Pressable {...tid(T2_TID.diffFold, { count: e.count })} key={e.id} accessibilityRole="button" accessibilityLabel={`Show ${e.count} unchanged ${e.count === 1 ? "line" : "lines"}`}
      onPress={() => openFold(e.id)}
      style={[{ height: FOLD, alignItems: "center", justifyContent: "center", backgroundColor: t.panel, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.line }, style]}>
      <Text size={TYPE.secondary} tone="muted" selectable={false}>⋯ {e.count} unchanged {e.count === 1 ? "line" : "lines"}</Text>
    </Pressable>
  );
  const banner = (e: Entry) => {
    const style = { position: "absolute" as const, left: 0, right: 0, top: e.y };
    return e.k === "head" ? head(e, style) : e.k === "fold" ? fold(e, style) : null;
  };

  const blank = (e: Entry) => <View key={e.k === "fold" ? e.id : e.y} style={{ height: height(e) }} />;
  const sideways = (
    <View style={{ position: "relative" }}>
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: gutterW }}>
          {entries.map((e) => (e.k === "line" ? <View key={e.y} style={{ height: ROW }}>{nums(e.line)}</View> : <View key={e.k === "fold" ? e.id : e.y} style={{ height: height(e), backgroundColor: t.panel }} />))}
        </View>
        <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
          <View style={{ minWidth: Math.max(0, width - gutterW) }}>
            {entries.map((e) => (e.k === "line"
              ? <View key={e.y} style={{ height: ROW, flexDirection: "row", paddingRight: PHONE.margin, backgroundColor: tint(e.line) }}>{sign(e.line)}<RNText selectable={false} style={code}>{text(e.line)}</RNText></View>
              : blank(e)))}
          </View>
        </ScrollView>
      </View>
      {entries.map(banner)}
    </View>
  );
  const wrapped = (
    <View>
      {entries.map((e) => {
        if (e.k === "head") return head(e);
        if (e.k === "fold") return fold(e);
        const l = e.line;
        return (
          <View key={e.y} {...tid("diff-row", { kind: l.kind })} onLayout={e.change === undefined ? undefined : (ev) => { ys.current[e.change!] = ev.nativeEvent.layout.y; }}
            style={{ flexDirection: "row", minHeight: ROW, backgroundColor: tint(l) }}>
            <View style={{ alignSelf: "stretch" }}>{nums(l, true)}</View>
            {sign(l)}
            <RNText selectable={false} style={[code, { flex: 1, minWidth: 0, paddingRight: PHONE.margin }]}>{text(l)}</RNText>
          </View>
        );
      })}
    </View>
  );

  const single = changes === 0;
  return (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View {...tid(T2_TID.diffSummary, { changes })} accessibilityLabel={`${diff.added} added, ${diff.removed} removed, ${changes} ${changes === 1 ? "change" : "changes"}`}
        style={{ height: SUMMARY, flexDirection: "row", alignItems: "center", paddingLeft: PHONE.margin, paddingRight: PHONE.margin / 2, backgroundColor: t.panel, borderBottomWidth: 1, borderBottomColor: t.line }}>
        <Text size={TYPE.secondary} weight="500" style={{ color: t.ok }}>+{diff.added}</Text>
        <Text size={TYPE.secondary} weight="500" style={{ color: t.danger, marginLeft: 8 }}>−{diff.removed}</Text>
        <Text size={TYPE.secondary} tone="muted" style={{ marginLeft: 8, flex: 1 }} numberOfLines={1}>· {changes} {changes === 1 ? "change" : "changes"}</Text>
        {single ? null : (
          <>
            <Text {...tid(T2_TID.diffPos, { at: position + 1, of: changes })} size={TYPE.secondary} tone="muted" style={{ fontVariant: ["tabular-nums"] }}>{position + 1} of {changes}</Text>
            <Jump testID={T2_TID.diffPrev} label="Previous change" turn="-90deg" disabled={position <= 0} onPress={() => jump(position - 1)} />
            <Jump testID={T2_TID.diffNext} label="Next change" turn="90deg" disabled={position >= changes - 1} onPress={() => jump(position + 1)} />
          </>
        )}
      </View>
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: bottom }} scrollEventThrottle={16}
        onScroll={follow} onScrollBeginDrag={() => setAsked(null)}
        onLayout={(e) => { view.current.h = e.nativeEvent.layout.height; }}>
        {wrap ? wrapped : sideways}
      </ScrollView>
    </View>
  );
}

/** One of the two jumps: a chevron turned up or down in a 44 pt target. */
function Jump({ testID, label, turn, disabled, onPress }: { testID: string; label: string; turn: string; disabled: boolean; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      style={{ width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.35 : 1 }}>
      <View style={{ transform: [{ rotate: turn }] }}><DisclosureChevron size={16} color={t.accent} /></View>
    </Pressable>
  );
}
