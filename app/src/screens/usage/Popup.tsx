// What the usage popup holds (the old page's Composer.tsx UsagePopover, ContextSection, LimitRow): the chat's context as numbers and, split by category,
// what fills it ("Context"), then the agent's plan limits ("Plan usage limits", "Cursor usage", "Plan usage on <Server>"; Pi has none). Both are
// asked for when the popup opens and keep their last answer. The words are the old popover's.
import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View, type TextStyle } from "react-native";

import { agentMeta, agentName } from "@aiwb/core/agents.ts";
import { usageKey, usageTitleOn, type Where } from "@aiwb/core/logic/chatserver.ts";
import { isStale, limitTone, resetAt, resetIn, sortLimits, updatedAgo } from "@aiwb/core/logic/usage.ts";
import type { AgentKind, ChatView, UsageLimit } from "@aiwb/core/types.ts";

import { IconButton } from "../../ui/IconButton.tsx";
import { WarnIcon } from "../../ui/icons.tsx";
import { MenuSep } from "../../ui/Menu.tsx";
import { useOverlayKind } from "../../ui/overlaykind.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid, TID } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { SplitView } from "./Split.tsx";
import { useSplit, usePlan } from "./useUsage.ts";

const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };
/** The popup's width on the wide layouts (a sheet takes the screen's). */
export const POP_WIDTH = 300;

/** The ring's popup body: the context, then (for an agent that has a plan to show) the plan's limits. lines: contextLines of the meter. */
export function UsageBody({ c, lines, where }: { c: ChatView; lines: string[]; where: Where }) {
  const kind = useOverlayKind();
  const own = c.agent ? agentMeta(c.agent).usageTitle : undefined;
  const title = own && usageTitleOn(where, own);
  return (
    <View {...tid("usage-body")} style={kind === "sheet" ? styles.sheet : styles.wide}>
      <ContextSection key={c.id} c={c} lines={lines} />
      {c.agent && title ? (
        <>
          <MenuSep />
          <PlanSection key={usageKey(where.server, c.agent)} agent={c.agent} server={where.server} title={title} />
        </>
      ) : null}
    </View>
  );
}

/** The ↻ that asks anew; it turns while the answer is awaited. */
function Refresh({ title, loading, onPress, testID }: { title: string; loading: boolean; onPress: () => void; testID: string }) {
  return (
    <IconButton testID={testID} title={title} disabled={loading} onPress={onPress} style={styles.refresh}>
      {(colour) => <Spin on={loading}><Text size={13} style={{ color: colour }}>↻</Text></Spin>}
    </IconButton>
  );
}

function Spin({ on, children }: { on: boolean; children: React.ReactNode }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!on) { turn.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(turn, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: Platform.OS !== "web" }));
    loop.start();
    return () => loop.stop();
  }, [on, turn]);
  return <Animated.View {...tid("usage-spin", { on: on || undefined })} style={{ transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }}>{children}</Animated.View>;
}

/** A heading as a menu's (.menu-head), with a control at its end. */
function Head({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <View testID={TID.menuHead} style={styles.head} accessibilityRole="header">
      <Text size={11} weight="600" tone="muted" style={styles.caps}>{children}</Text>
      <View style={styles.grow} />
      {action}
    </View>
  );
}

const Err = ({ children }: { children: string }) => {
  const t = useTokens();
  return <View {...tid("usage-err")} style={styles.err}><WarnIcon color={t.warn} /><Text size={11.5} tone="warn" style={styles.errText}>{children}</Text></View>;
};
const Note = ({ children }: { children: string }) => <Text {...tid("usage-note")} size={12} tone="muted" style={styles.note}>{children}</Text>;

/** The context: the ring's numbers, then what fills it as the agent splits it, asked for on open. The server answers Claude's from chat.json while
 *  no message or turn has moved past it, else asks Claude; Cursor's it reads from its session store. */
function ContextSection({ c, lines }: { c: ChatView; lines: string[] }) {
  const { s, loading, err, load } = useSplit(c.id, !!c.locked);
  return (
    <View {...tid("usage-context")}>
      <Head action={c.locked ? <Refresh testID="ctx-refresh" title="Count again" loading={loading} onPress={() => void load(true)} /> : undefined}>Context</Head>
      <View {...tid("usage-ctx")} style={styles.ctx}>
        {(s ? lines.slice(0, 1) : lines).map((l, i) => <Text key={l} size={i ? 11.5 : 12} tone={i ? "muted" : "text"} style={styles.ctxLine}>{l}</Text>)}
      </View>
      {!s && loading ? <Note>Counting what fills it…</Note> : null}
      {s && c.agent ? <SplitView agent={c.agent} s={s} loading={loading} /> : null}
      {err ? <Err>{err}</Err> : null}
    </View>
  );
}

/** The agent's plan limits, fetched on open: Claude's come from `claude -p /usage`, Cursor's from `cursor-cost`. The plan is the one of the chat's
 *  server, which is asked. */
function PlanSection({ agent, server, title }: { agent: AgentKind; server: string; title: string }) {
  const { u, loading, err, now, load } = usePlan(agent, server, true);
  return (
    <View {...tid("usage-plan")}>
      <Head action={<Refresh testID="plan-refresh" title="Check again" loading={loading} onPress={() => void load(true)} />}>{title}</Head>
      {!u && loading ? <Note>Checking your plan…</Note> : null}
      {u && !u.plan ? <Note>{u.note || `${agentName(agent)} reported no plan limits.`}</Note> : null}
      {u?.plan ? sortLimits(u.limits).map((l) => <LimitRow key={l.kind + l.label} l={l} now={now} />) : null}
      {u?.plan && u.note ? <Err>{u.note}</Err> : null}
      {err ? <Err>{err}</Err> : null}
      {u ? (
        <Text {...tid("usage-foot", { stale: !loading && isStale(u.fetchedAt, now) || undefined })} size={10.5}
          tone={!loading && isStale(u.fetchedAt, now) ? "warn" : "faint"} style={styles.foot}>
          {loading ? "Updating…" : `Updated ${updatedAgo(u.fetchedAt, now)}`}
        </Text>
      ) : null}
    </View>
  );
}

/** A limit: its label, detail and percent, a bar of that width in a tone, and when it resets. */
function LimitRow({ l, now }: { l: UsageLimit; now: number }) {
  const t = useTokens();
  const tone = limitTone(l);
  const when = [resetIn(l.resetsAt, now), resetAt(l.resetsAt, now)].filter(Boolean).join(" · ");
  const ref = useControlRef(l.resetsAt ? new Date(l.resetsAt).toLocaleString() : undefined);
  const colour = tone === "danger" ? t.danger : tone === "warn" ? t.warn : t.accent;
  const pct = Math.min(100, Math.max(0, l.percent));
  return (
    <View {...tid("usage-row", { tone, kind: l.kind })} style={styles.limit}>
      <View style={styles.top}>
        <Text size={12} style={styles.limitLabel}>{l.label}</Text>
        <Text size={12} tone="muted" style={TABULAR}>
          {l.detail ? <Text size={12} tone="faint">{l.detail} · </Text> : null}{Math.round(l.percent)}%
        </Text>
      </View>
      <View style={[styles.bar, { backgroundColor: t.line2 }]}><View {...tid("usage-bar", { pct })} style={{ width: `${pct}%`, height: "100%", borderRadius: 3, backgroundColor: colour }} /></View>
      {when ? <View ref={ref}><Text {...tid("usage-reset")} size={11} tone="faint">Resets {when}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wide: { width: POP_WIDTH, maxWidth: "100%", paddingBottom: 2 },
  sheet: { alignSelf: "stretch", paddingBottom: 2 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6, paddingLeft: 8, paddingRight: 2, paddingBottom: 4 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  grow: { flex: 1 },
  refresh: { width: 22, height: 22 },
  ctx: { paddingHorizontal: 8, paddingBottom: 4 },
  ctxLine: {},
  note: { paddingVertical: 4, paddingHorizontal: 8 },
  err: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4, paddingHorizontal: 8 },
  errText: { flexShrink: 1 },
  foot: { paddingTop: 4, paddingHorizontal: 8 },
  limit: { paddingVertical: 5, paddingHorizontal: 8 },
  top: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  limitLabel: { flexShrink: 1 },
  bar: { height: 5, marginTop: 4, marginBottom: 3, borderRadius: 3, overflow: "hidden" },
});
