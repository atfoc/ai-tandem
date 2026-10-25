// The phone's subagents in the thread (ux improvements T2): one card per call, its rows two lines high with a 28 pt mark, a nested subagent hung
// under its parent, and the row of a report. The wide layouts keep Row.tsx's one-line rows; Row.tsx draws these where `usePhone()`.
import { Pressable, StyleSheet, View } from "react-native";

import { fmtDurationShort, subagentOf, subChildren, subDurationMs, subLine, subRunCounts, subStatus, subWaiting } from "@aiwb/core/logic/subagents.ts";
import { boardNames, inTurn, subsOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item, Subagent } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { T2_TID } from "../tools/ids.ts";
import type { GroupProps } from "../chat/parts.tsx";
import { openSub, useNow, useSubThread } from "./hooks.ts";
import { PhoneSubMark } from "./Parts.tsx";

/** How many levels of nested rows are drawn under a row (the same guard as Row.tsx's). */
const MAX_NESTED_ROWS = 8;

/** The indent of a nested row: the mark's width and the gap to the task, so its mark sits under the parent's task. Past this many levels the
 *  rows stop moving right, for the width the text needs. */
const INDENT = 38;
const MAX_INDENT_LEVELS = 4;
const EDGE = 12;
const MARK = 28;
/** How far under the parent's mark its row ends: half the row's height less the mark's half. */
const ELBOW_UP = (PHONE.listRow - MARK) / 2;

/** The card of a run of calls that started subagents: the head says how many subagents there are and how many work, and the rows are the
 *  subagents the calls started, each with the ones it started under it. */
export function SubagentCard({ chat, items }: GroupProps) {
  const t = useTokens();
  const subs = useStore((s) => subsOf(s, chat.id));
  const busy = inTurn(chat.status);
  const roots = items.map((x) => ({ it: x.item, sa: subagentOf(x.item, subs, busy) }));
  const { count, running, background } = subRunCounts(subs, roots.map((r) => r.sa));
  return (
    <View {...tid(T2_TID.subCard, { count, running })} style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
      <View {...tid(T2_TID.subCardHead)} style={[styles.head, { borderBottomColor: t.line }]}>
        <Text size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.headText}>{count} subagent{count === 1 ? "" : "s"}{background ? " · in the background" : ""}</Text>
        {running ? <Text size={TYPE.secondary} weight="600" tone="accent">{running} running</Text> : null}
      </View>
      {roots.map((r, n) => <Branch key={r.sa.id || r.it.toolId || n} it={r.it} sa={r.sa} chat={chat} level={0} divided={n > 0} />)}
    </View>
  );
}

/** A subagent drawn on its own on the phone (its call is in a subagent's thread, where nothing is folded): the same row in a card of one. */
export function PhoneSubCard({ it, sa, chat }: { it: Item; sa: Subagent; chat: ChatView }) {
  const t = useTokens();
  return (
    <View {...tid(T2_TID.subCard, { count: 1, running: sa.status === "running" ? 1 : 0 })} style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Branch it={it} sa={sa} chat={chat} level={0} divided={false} />
    </View>
  );
}

/** A subagent's row with the rows of the ones it started under it, each hung from its parent's mark by a thin guide line: an elbow into its own
 *  mark, and a line on down to the next sibling when there is one. first, last: its place among the ones its parent started. */
function Branch({ it, sa, chat, level, divided, first = true, last = true }: { it: Item; sa: Subagent; chat: ChatView; level: number; divided: boolean; first?: boolean; last?: boolean }) {
  const t = useTokens();
  const subs = useStore((s) => subsOf(s, chat.id));
  const started = level < MAX_NESTED_ROWS ? subChildren(subs, sa.id) : [];
  const shown = Math.min(level, MAX_INDENT_LEVELS);
  const left = EDGE + INDENT * shown;
  // the parent's mark (its centre, one level up) is where the guide comes from
  const parentCentre = EDGE + INDENT * (shown - 1) + MARK / 2;
  const guided = level > 0 && level <= MAX_INDENT_LEVELS;
  return (
    <View style={divided ? [styles.divided, { borderTopColor: t.line }] : undefined}>
      {guided ? <View pointerEvents="none" style={[styles.elbow, { left: parentCentre, width: left - parentCentre, top: first ? -ELBOW_UP : 0, height: (first ? ELBOW_UP : 0) + PHONE.listRow / 2, borderColor: t.line2 }]} /> : null}
      {guided && !last ? <View pointerEvents="none" style={[styles.through, { left: parentCentre, top: PHONE.listRow / 2, borderColor: t.line2 }]} /> : null}
      <PhoneRow it={it} sa={sa} chat={chat} left={left} />
      {started.map((x, n) => <Branch key={x.id} it={{ kind: "tool", toolId: x.tool }} sa={{ ...x, status: subStatus(x) }} chat={chat} level={level + 1} divided={false} first={n === 0} last={n === started.length - 1} />)}
    </View>
  );
}

/** One subagent's row: the mark, the task and how it went (the detail that was on the wide row moves to the subagent's screen). A press opens the
 *  subagent; on the phone it is a screen of the stack, so a press never closes it. */
function PhoneRow({ it, sa, chat, left }: { it: Item; sa: Subagent; chat: ChatView; left: number }) {
  const t = useTokens();
  const subs = useStore((s) => subsOf(s, chat.id));
  const waiting = subWaiting(sa);
  const items = useSubThread(chat.id, sa.id, sa.status === "running" && !waiting);
  const now = useNow(sa.status === "running");
  const on = useStore((s) => !!sa.id && s.subDrawer?.chat === chat.id && s.subDrawer.sub === sa.id);
  const line = subLine(it, sa, items, boardNames(chat.id), subs);
  const ms = sa.status === "running" ? subDurationMs(sa, now) : null;
  // a run's time follows what it is doing, but the line of a failed or stopped one stays as it is
  const text = sa.status === "running" && !sa.notCarried
    ? (waiting ? `${line.text}${ms !== null ? ` · ${fmtDurationShort(ms)}` : ""}` : `Running${ms !== null ? ` · ${fmtDurationShort(ms)}` : ""} · ${line.text}`)
    : line.text;
  const name = sa.description || "Subagent";
  return (
    <Pressable {...tid("sub-row", { status: sa.status, waiting, on, sub: sa.id })} role="button" accessibilityLabel={name} onPress={() => { if (sa.id) openSub(chat.id, sa.id); }}
      style={({ pressed }: { pressed: boolean }) => [styles.row, { paddingLeft: left, backgroundColor: pressed ? t.hover : "transparent" }, webStyle({ cursor: "pointer", userSelect: "none" })]}>
      <PhoneSubMark status={sa.status} waiting={waiting} />
      <View style={styles.main}>
        <Text {...tid("sub-desc")} size={TYPE.control - 2} weight="600" numberOfLines={1}>{name}</Text>
        <Text {...tid("sub-line", { tone: line.tone })} size={TYPE.secondary} numberOfLines={1} style={{ color: line.tone === "live" ? t.ok : line.tone === "error" ? t.danger : t.muted }}>{text}</Text>
      </View>
      <DisclosureChevron color={t.muted} />
    </Pressable>
  );
}

/** The 48 pt row of a subagent's report: a small accent tile, "Report from" over the subagent's name, a chevron. error: the line of a failed one,
 *  or of one that was not carried over, in red or muted where "Report from" is. */
export function PhoneSubReport({ sid, chat, name, line, on, open }: { sid: string; chat: ChatView; name: string; line: { text: string; tone: "muted" | "error" } | null; on: boolean; open(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(T2_TID.subReport, { tone: line?.tone ?? "muted", on, sub: sid })} role="button" accessibilityLabel={`Report from ${name}`} onPress={open}
      style={({ pressed }: { pressed: boolean }) => [styles.report, { backgroundColor: pressed ? t.hover : t.panel, borderColor: t.line }, webStyle({ cursor: "pointer", userSelect: "none" })]}>
      <View style={[styles.tile, { backgroundColor: t.accentSoft }]}><View style={[styles.tileGlyph, { backgroundColor: t.accent }]} /></View>
      <View style={styles.main}>
        <Text size={TYPE.secondary} numberOfLines={1} style={{ color: line?.tone === "error" ? t.danger : t.muted }}>Report from{line ? ` · ${line.text}` : ""}</Text>
        <Text size={TYPE.control - 2} weight="600" numberOfLines={1}>{name}</Text>
      </View>
      <DisclosureChevron color={t.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, minWidth: 0, alignSelf: "stretch", overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", columnGap: 8, paddingHorizontal: 14, paddingVertical: 9, borderBottomWidth: 1 },
  headText: { flexShrink: 1, minWidth: 0 },
  divided: { borderTopWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", columnGap: 12, minHeight: PHONE.listRow, paddingVertical: 8, paddingRight: 12 },
  main: { flex: 1, minWidth: 0 },
  // the elbow runs from the parent's mark (the parent's row ends this far under it) to the middle of this mark
  elbow: { position: "absolute", borderLeftWidth: 1, borderBottomWidth: 1, borderBottomLeftRadius: 10 },
  through: { position: "absolute", bottom: 0, borderLeftWidth: 1 },
  report: { flexDirection: "row", alignItems: "center", columnGap: 12, minHeight: 48, paddingVertical: 6, paddingHorizontal: 12, borderWidth: 1, borderRadius: 12, minWidth: 0, alignSelf: "stretch" },
  tile: { width: MARK, height: MARK, borderRadius: 8, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  tileGlyph: { width: 11, height: 8, borderRadius: 2 },
});
