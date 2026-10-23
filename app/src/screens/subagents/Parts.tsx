// The pieces a subagent's row and the drawer's header share (the old page's Subagents.tsx SubMark, SubName, SubStats): the mark of its state, its
// name with the agent's glyph, and its stats. The ring of its context is S9's `SubMeter` (B-US-12).
import { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from "react-native";

import { agentShortName } from "@aiwb/core/agents.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { fmtDuration, subBadge, subDurationMs, subModelLabel, subToolCount } from "@aiwb/core/logic/subagents.ts";
import type { Item, SubStatus, Subagent } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { agentColours } from "../chat/colour.ts";
import { SubMeter } from "../usage/index.ts";

/** The mark of a subagent's state: a pulsing dot while it runs, ✓ done, ! failed, ■ stopped, and the ring that stands still, in the danger colour,
 *  when it is paused. waiting: it runs and waits for the subagents it started (subWaiting): a ring that stands still, not the dot of one at work
 *  (B-SA-04). */
export function SubMark({ status, waiting = false }: { status: SubStatus; waiting?: boolean }) {
  const t = useTokens();
  return (
    <View {...tid("sub-mark", { status, waiting })} style={styles.mark}>
      {status === "paused"
        ? <View style={[styles.dot, { borderWidth: 1.5, borderColor: t.danger }]} />
        : status === "running"
        ? (waiting ? <View style={[styles.dot, { borderWidth: 1.5, borderColor: t.muted }]} /> : <Pulse colour={t.ok} />)
        : <Text size={12} weight="700" style={{ color: status === "completed" ? t.ok : status === "failed" ? t.danger : t.muted }}>{status === "completed" ? "✓" : status === "failed" ? "!" : "■"}</Text>}
    </View>
  );
}

/** The dot of a subagent at work: it breathes (the page's `pulse`, 1 s). On web a CSS animation (the browser does it, and the document stays
 *  still for a check that waits for it); on native an Animated loop on the native driver. */
const BREATH = { animationKeyframes: [{ "0%": { opacity: 1 }, "50%": { opacity: 0.35 }, "100%": { opacity: 1 } }], animationDuration: "1s", animationIterationCount: "infinite" } as unknown as ViewStyle;

function Pulse({ colour }: { colour: string }) {
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (Platform.OS === "web") return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(o, { toValue: 0.35, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(o, { toValue: 1, duration: 500, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [o]);
  return <Animated.View {...tid("sub-dot")} style={[styles.dot, { backgroundColor: colour }, Platform.OS === "web" ? BREATH : { opacity: o }]} />;
}

/** The agent's glyph and short name, the description (or "Subagent"), the type as a badge unless it is a default one, and the "background" tag. */
export function SubName({ sa, size = 12 }: { sa: Subagent; size?: number }) {
  const t = useTokens();
  const badge = subBadge(sa.type);
  return (
    <View {...tid("sub-name")} style={styles.name}>
      {sa.kind ? (
        <View {...tid("sub-agent")} style={styles.agent}>
          <AgentGlyph agent={sa.kind} size={11} />
          <Text size={size} weight="600" style={{ color: agentColours(t, sa.kind).fg }}>{agentShortName(sa.kind)}</Text>
        </View>
      ) : null}
      <Text {...tid("sub-desc")} size={size} weight="600" numberOfLines={1} style={styles.desc}>{sa.description || "Subagent"}</Text>
      {badge ? <Text {...tid("sub-type")} size={9.5} weight="600" style={[styles.badge, { color: t.accent, borderColor: t.accent }]}>{badge}</Text> : null}
      {sa.background ? <Text {...tid("sub-bg")} size={9.5} weight="600" style={[styles.badge, { color: t.muted, borderColor: t.muted }]}>background</Text> : null}
    </View>
  );
}

/** "model · effort", the number of tool calls, the run time (live while it runs) and the ring of its context. server: the entry id of the
 *  server of the subagent's chat, whose catalog names its model. wrap: where the room is narrow the stats go on to another line (the drawer's
 *  header, a row whose stats are under its line) instead of past the edge. */
export function SubStats({ sa, items, now, server, wrap = false }: { sa: Subagent; items?: Item[]; now: number; server: string; wrap?: boolean }) {
  const cat = useStore((s) => catalogFor(s, server, sa.kind ?? ""));
  const m = subModelLabel(sa.model, sa.kind, cat, sa.effort);
  const tools = subToolCount(sa, items);
  const ms = subDurationMs(sa, now);
  return (
    <View {...tid("sub-stats")} style={wrap ? styles.statsWrap : styles.stats}>
      {m ? <Text {...tid("sub-model")} size={11} tone="muted">{m.model}{m.effort ? ` · ${m.effort}` : ""}</Text> : null}
      {tools > 0 ? <Text {...tid("sub-tools")} size={11} tone="muted">{tools} tool{tools > 1 ? "s" : ""}</Text> : null}
      {ms !== null ? <Text {...tid("sub-time")} size={11} tone="muted" style={styles.num}>{fmtDuration(ms)}</Text> : null}
      <SubMeter sa={sa} />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { width: 14, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flexDirection: "row", alignItems: "center", columnGap: 6, minWidth: 0 },
  agent: { flexDirection: "row", alignItems: "center", columnGap: 3, flexShrink: 0 },
  desc: { flexShrink: 1, minWidth: 0 },
  badge: { flexShrink: 0, borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, lineHeight: 14 },
  stats: { flexDirection: "row", alignItems: "center", columnGap: 8, flexShrink: 0 },
  statsWrap: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 8, rowGap: 2, flexShrink: 1, minWidth: 0 },
  num: { fontVariant: ["tabular-nums"] },
});
