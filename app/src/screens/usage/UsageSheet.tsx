// The phone's "Context and usage" sheet (ux-improvements goal 3.5; package T3, chunk 2): what the composer's meter and Chat info's Context row open on
// the phone, instead of the meter's popover. One sheet, always mounted (the shell's `Overlays` slot), shown while `useUsageOpen()` names a chat. The
// chat's context as one big share of its window, the stacked bar and a legend of what fills it, how it was counted, then the agent's plan limits with
// their reset times, amber from 80 %. It asks for the same two things as the popover (`useSplit`, `usePlan`) and keeps their last answers.
import { useState } from "react";
import { Pressable, StyleSheet, View, type TextStyle } from "react-native";

import { agentMeta, agentName } from "@aiwb/core/agents.ts";
import { usageKey, usageTitleOn, type Where } from "@aiwb/core/logic/chatserver.ts";
import { width } from "@aiwb/core/logic/ctxsplit.ts";
import { isStale, resetAt, resetIn, sortLimits, updatedAgo } from "@aiwb/core/logic/usage.ts";
import { chatTitle, shownView, threadOf } from "@aiwb/core/state/store.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import type { AgentKind, ChatView, ContextSplit, UsageLimit } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { Chevron, WarnIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useWhere } from "../chat/hooks.ts";
import { USAGE_TID } from "./ids.ts";
import { contextLines, contextOf } from "./meter.ts";
import { Spin } from "./Popup.tsx";
import { closeUsage, useUsageOpen } from "./open.ts";
import { bigNumber, countLine, hasMore, legend, phoneTone, type LegendRow } from "./phone.ts";
import { fillOf } from "./Split.tsx";
import { useSplit, usePlan } from "./useUsage.ts";

const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

/** The sheet, always mounted: it shows itself while the store names a chat that is still there. */
export function UsageSheet() {
  const chat = useUsageOpen();
  const c = useStore((s) => (chat ? shownView(s, chat) : undefined));
  if (!chat || !c) return null;
  return <Open key={chat} chat={chat} c={c} />;
}

function Open({ chat, c }: { chat: string; c: ChatView }) {
  const items = useStore((s) => threadOf(s, chat)?.items);
  const cat = useStore((s) => catalogFor(s, serverOf(c), c.agent));
  const where = useWhere(c);
  const { used, win, error } = contextOf(c, cat);
  const own = c.agent ? agentMeta(c.agent).usageTitle : undefined;
  const title = own && usageTitleOn(where, own);
  // The head is aligned to the start, as drawn, which SheetHead does only with a `leading` item: an empty one that takes no room.
  const lead = <View style={{ marginRight: -12 }} />;
  return (
    <Sheet open onClose={closeUsage} label="Context and usage" testID={USAGE_TID.sheet}
      head={<SheetHead title="Context and usage" sub={[chatTitle(c, items), c.agent ? agentName(c.agent) : ""].filter(Boolean).join(" · ")} leading={lead} />}>
      <View {...tid("usage-body", { chat })} style={styles.body}>
        <ContextSection key={c.id} c={c} used={used} win={win} error={error} />
        {c.agent && title ? <PlanSection key={usageKey(where.server, c.agent)} agent={c.agent} where={where} title={title} /> : null}
      </View>
    </Sheet>
  );
}

/** A heading of the sheet (17 pt, semibold) with its 44 pt ↻ at the end. */
function Heading({ children, refresh }: { children: string; refresh?: React.ReactNode }) {
  return (
    <View style={styles.heading}>
      <Text size={TYPE.control} weight="600" accessibilityRole="header" style={styles.grow}>{children}</Text>
      {refresh}
    </View>
  );
}

function Refresh({ testID, title, loading, onPress }: { testID: string; title: string; loading: boolean; onPress: () => void }) {
  return (
    <IconButton testID={testID} title={title} size="touch" disabled={loading} onPress={onPress} style={styles.refresh}>
      {(colour) => <Spin on={loading}><Text size={20} style={{ color: colour }}>↻</Text></Spin>}
    </IconButton>
  );
}

const Note = ({ children, id = "usage-note" }: { children: string; id?: string }) => <Text {...tid(id)} size={TYPE.secondary} tone="muted" style={styles.note}>{children}</Text>;

const Err = ({ children }: { children: string }) => {
  const t = useTokens();
  return <View {...tid("usage-err")} style={styles.err}><WarnIcon color={t.warn} /><Text size={TYPE.secondary} style={[styles.grow, { color: t.warnText }]}>{children}</Text></View>;
};

/** The context: the big share, the bar and legend once the split is there, how it was counted. */
function ContextSection({ c, used, win, error }: { c: ChatView; used: number; win: number; error?: string }) {
  const { s, loading, err, load } = useSplit(c.id, !!c.locked);
  const agent = c.agent as AgentKind;
  return (
    <View {...tid("usage-context")}>
      <Heading refresh={c.locked ? <Refresh testID="ctx-refresh" title="Count again" loading={loading} onPress={() => void load(true)} /> : undefined}>Context</Heading>
      <View {...tid("usage-ctx")} style={styles.pad}>
        {error ? <Err>{error}</Err> : null}
        {used || s ? <Big used={used} win={win} s={s} /> : contextLines({ used, win }).map((l) => <Note key={l}>{l}</Note>)}
      </View>
      {!s && loading ? <Note>Counting what fills it…</Note> : null}
      {s && agent ? <Split agent={agent} s={s} loading={loading} /> : null}
      {err ? <Err>{err}</Err> : null}
    </View>
  );
}

function Big({ used, win, s }: { used: number; win: number; s: ContextSplit | null }) {
  const { pct, words } = bigNumber(used, win, s);
  return (
    <View style={styles.big}>
      <Text {...tid(USAGE_TID.big)} size={TYPE.largeTitle} weight="600" style={TABULAR}>{pct}</Text>
      <Text {...tid(USAGE_TID.bigWords)} size={TYPE.body} tone="muted" style={styles.grow}>{words}</Text>
    </View>
  );
}

function Split({ agent, s, loading }: { agent: AgentKind; s: ContextSplit; loading: boolean }) {
  const t = useTokens();
  const { used, free, deferred, win } = legend(agent, s);
  return (
    <View style={styles.pad}>
      <View {...tid(USAGE_TID.splitBar)} role="img" aria-label={[...used, ...(free ? [free] : [])].map((r) => `${r.label} ${r.share}`).join(", ")} style={[styles.stack, { backgroundColor: t.line }]}>
        {used.map((r) => <View key={r.id} {...tid(USAGE_TID.splitSeg, { cat: r.id, slot: r.slot })} style={[styles.seg, { flexBasis: `${width(r.tokens, win)}%` }, fill(r, t)]} />)}
      </View>
      <View>
        {used.map((r, i) => <Legend key={r.id} r={r} first={i === 0} />)}
        {free ? <Legend r={free} first={!used.length} /> : null}
      </View>
      {deferred.length ? (
        <>
          <Text size={TYPE.secondary} tone="muted" style={styles.sub}>Listed, loaded when used</Text>
          {deferred.map((r, i) => <Legend key={r.id} r={r} first={i === 0} />)}
        </>
      ) : null}
      {s.facts?.length ? (
        <View style={styles.facts}>
          {s.facts.map((f) => (
            <View key={f.label} style={styles.fact}>
              <Text size={TYPE.secondary} tone="muted">{f.label}</Text>
              <Text size={TYPE.secondary} style={[styles.grow, styles.factValue]}>{f.value}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text {...tid(USAGE_TID.counted)} size={TYPE.secondary} tone="muted" style={styles.counted}>{countLine(agent, s, loading)}</Text>
    </View>
  );
}

/** The swatch's fill: the bar's colour of the row's slot (free space the line's, the buffer hatched). */
const fill = (r: LegendRow, t: ReturnType<typeof useTokens>) => fillOf({ cat: { id: r.id, label: r.label, tokens: r.tokens, kind: r.kind }, slot: r.slot }, t);

/** A legend row of 38 pt: swatch, label, tokens and share. With parts or items (Claude's Messages, a skill list…) it has a chevron and a tap opens them. */
function Legend({ r, first, depth = 0 }: { r: LegendRow; first: boolean; depth?: number }) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const more = hasMore(r);
  const ref = useControlRef(undefined);
  const body = (
    <>
      <View style={[styles.sw, r.kind === "deferred" && { borderWidth: 1, borderStyle: "dashed", borderColor: t.faint }, fill(r, t)]} />
      <Text size={TYPE.body} tone={r.kind === "deferred" ? "muted" : "text"} numberOfLines={1} style={styles.label}>{r.label}</Text>
      {more ? <View style={[styles.chev, open && { transform: [{ rotate: "90deg" }] }]}><Chevron size={12} color={t.faint} /></View> : null}
      <View style={styles.grow} />
      <Text size={TYPE.body} style={[styles.num, TABULAR]}>{r.words}</Text>
      <Text size={TYPE.body} tone="muted" style={[styles.pct, TABULAR]}>{r.share}</Text>
    </>
  );
  const row = [styles.row, { paddingLeft: depth * 20, borderTopColor: t.line, borderTopWidth: first && !depth ? 0 : StyleSheet.hairlineWidth }];
  const data = tid(USAGE_TID.legend, { cat: r.id, on: open || undefined });
  return (
    <>
      {more
        ? <Pressable ref={ref} {...data} role="button" aria-expanded={open} accessibilityLabel={`${r.label}, ${r.words} tokens, ${r.share}`} onPress={() => setOpen(!open)} style={row}>{body}</Pressable>
        : <View {...data} style={row}>{body}</View>}
      {open && r.parts.map((p) => <Legend key={p.id} r={p} first={false} depth={depth + 1} />)}
      {open && r.items.map((it, i) => (
        <View key={i} {...tid(USAGE_TID.legendItem)} style={[styles.item, { paddingLeft: 22 + depth * 20 }]}>
          <Text size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.label}>{it.name}{it.note ? ` · ${it.note}` : ""}</Text>
          <Text size={TYPE.secondary} tone="muted" style={[styles.num, TABULAR]}>{it.words}</Text>
        </View>
      ))}
    </>
  );
}

/** The agent's plan limits, fetched on open (the popover's PlanSection). */
function PlanSection({ agent, where, title }: { agent: AgentKind; where: Where; title: string }) {
  const t = useTokens();
  const { u, loading, err, now, load } = usePlan(agent, where.server, true);
  const stale = !loading && !!u && isStale(u.fetchedAt, now);
  return (
    <View {...tid("usage-plan")} style={[styles.plan, { borderTopColor: t.line }]}>
      <Heading refresh={<Refresh testID="plan-refresh" title="Check again" loading={loading} onPress={() => void load(true)} />}>{title}</Heading>
      {!u && loading ? <Note>Checking your plan…</Note> : null}
      {u && !u.plan ? <Note>{u.note || `${agentName(agent)} reported no plan limits.`}</Note> : null}
      {u?.plan ? sortLimits(u.limits).map((l) => <LimitRow key={l.kind + l.label} l={l} now={now} />) : null}
      {u?.plan && u.note ? <Err>{u.note}</Err> : null}
      {err ? <Err>{err}</Err> : null}
      {u ? (
        <Text {...tid("usage-foot", { stale: stale || undefined })} size={TYPE.secondary} tone={stale ? "warn" : "muted"} style={[styles.pad, stale && { color: t.warnText }, styles.foot]}>
          {loading ? "Updating…" : `Updated ${updatedAgo(u.fetchedAt, now)}`}
        </Text>
      ) : null}
    </View>
  );
}

/** A limit: label and percent, an 8 pt bar in its tone (amber from 80 %), and when it resets. */
function LimitRow({ l, now }: { l: UsageLimit; now: number }) {
  const t = useTokens();
  const tone = phoneTone(l);
  const when = [resetIn(l.resetsAt, now), resetAt(l.resetsAt, now)].filter(Boolean).join(" · ");
  const ref = useControlRef(l.resetsAt ? new Date(l.resetsAt).toLocaleString() : undefined);
  const colour = tone === "danger" ? t.danger : tone === "warn" ? t.warn : t.accent;
  const words = tone === "danger" ? t.danger : tone === "warn" ? t.warnText : t.muted;
  const pct = Math.min(100, Math.max(0, l.percent));
  return (
    <View {...tid("usage-row", { tone, kind: l.kind })} style={styles.limit}>
      <View style={styles.top}>
        <Text size={TYPE.body} style={styles.label}>{l.label}</Text>
        <Text size={TYPE.body} style={[TABULAR, { color: words }]}>
          {l.detail ? <Text size={TYPE.secondary} tone="muted">{l.detail} · </Text> : null}{Math.round(l.percent)}%
        </Text>
      </View>
      <View style={[styles.bar, { backgroundColor: t.line2 }]}><View {...tid("usage-bar", { pct })} style={{ width: `${pct}%`, height: "100%", backgroundColor: colour }} /></View>
      {when ? <View ref={ref}><Text {...tid("usage-reset")} size={TYPE.secondary} tone="muted">Resets {when}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignSelf: "stretch", paddingHorizontal: PHONE.margin - 8, paddingBottom: 8 },
  grow: { flex: 1, minWidth: 0 },
  pad: {},
  heading: { flexDirection: "row", alignItems: "center", minHeight: PHONE.target, paddingTop: 8 },
  refresh: { marginRight: -12 },
  note: { paddingBottom: 6 },
  err: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6 },
  big: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  stack: { flexDirection: "row", gap: 2, height: 8, marginTop: 10, marginBottom: 6, borderRadius: 4, overflow: "hidden" },
  seg: { flexGrow: 0, flexShrink: 0, minWidth: 3, height: "100%" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 38 },
  sw: { width: 12, height: 12, borderRadius: 3 },
  label: { flexShrink: 1, minWidth: 0 },
  chev: { width: 14, alignItems: "center" },
  num: { textAlign: "right" },
  pct: { width: 52, textAlign: "right" },
  item: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 28, paddingRight: 62 },
  sub: { paddingTop: 10, paddingBottom: 2 },
  facts: { paddingTop: 10, gap: 2 },
  fact: { flexDirection: "row", gap: 12 },
  factValue: { textAlign: "right" },
  counted: { paddingTop: 8 },
  plan: { marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  limit: { paddingTop: 6, paddingBottom: 10 },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 },
  bar: { height: 8, marginTop: 6, marginBottom: 6, borderRadius: 4, overflow: "hidden" },
  foot: { paddingTop: 2 },
});
