// The pieces a subagent's row and the drawer's header share (the old page's Subagents.tsx SubMark, SubName, SubStats): the mark of its state, its
// name with the agent's glyph, and its stats. The ring of its context is S9's `SubMeter` (B-US-12).
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Animated, Easing, Platform, StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

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
import { SubMeter, ringOf } from "../usage/index.ts";
import { T2_TID } from "../tools/ids.ts";

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

/** The phone's 28 pt mark of a subagent's state (ux T2): ✓ on a soft green disc, a grey ring while it waits, a pulsing green dot on a soft disc
 *  while it works, ! on a soft red disc, ■ grey. The soft fills are the state's colour at low alpha so the dark theme and the flavours follow. */
export function PhoneSubMark({ status, waiting = false }: { status: SubStatus; waiting?: boolean }) {
  const t = useTokens();
  const work = status === "running" && !waiting;
  const fill = status === "completed" ? `${t.ok}26` : work ? `${t.ok}26` : status === "failed" ? t.dangerSoft : t.hover2;
  return (
    <View {...tid("sub-mark", { status, waiting })} style={[phoneStyles.phoneMark, { backgroundColor: fill }]}>
      {work ? <PhoneDot colour={t.ok} />
        : status === "running" ? <View style={[phoneStyles.phoneRing, { borderColor: t.muted }]} />
        : <Text size={14} weight="700" style={{ color: status === "completed" ? t.ok : status === "failed" ? t.danger : t.muted }}>{status === "completed" ? "✓" : status === "failed" ? "!" : "■"}</Text>}
    </View>
  );
}

/** The pills of the phone's subagent screen (goal 3.5): "model · effort", the tool calls, the run time (live while it runs) and the share of
 *  its context used, each in a bordered rounded pill at 13 pt; they wrap onto a second row where the screen is narrow. */
export function SubPills({ sa, items, now, server }: { sa: Subagent; items?: Item[]; now: number; server: string }) {
  const t = useTokens();
  const cat = useStore((s) => catalogFor(s, server, sa.kind ?? ""));
  const m = subModelLabel(sa.model, sa.kind, cat, sa.effort);
  const tools = subToolCount(sa, items);
  const ms = subDurationMs(sa, now);
  const used = sa.tokens ?? 0, win = sa.window ?? 0;
  const { pct, tone } = ringOf(used, win);
  const stroke = tone === "danger" ? t.danger : tone === "warn" ? t.warn : t.accent;
  const pill = (id: string, children: ReactNode, key: string) => (
    <View key={key} {...tid(id)} style={[pillStyles.pill, { borderColor: t.line2 }]}>{children}</View>
  );
  const word = (text: string, extra?: object) => <Text size={13} tone="muted" numberOfLines={1} style={extra}>{text}</Text>;
  return (
    <View {...tid(T2_TID.subPills)} style={pillStyles.pills}>
      {m ? pill("sub-model", <Text size={13} weight="600" numberOfLines={1}>{m.model}{m.effort ? ` · ${m.effort}` : ""}</Text>, "m") : null}
      {tools > 0 ? pill("sub-tools", word(`${tools} tool${tools > 1 ? "s" : ""}`), "t") : null}
      {ms !== null ? pill("sub-time", word(fmtDuration(ms), pillStyles.num), "d") : null}
      {used > 0 && win > 0 ? pill("ctx-meter", (
        <>
          <Svg width={13} height={13} viewBox="0 0 16 16">
            <Circle cx={8} cy={8} r={6} fill="none" stroke={t.line2} strokeWidth={2.4} />
            <Circle cx={8} cy={8} r={6} fill="none" stroke={stroke} strokeWidth={2.4} strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 6 * pct} ${2 * Math.PI * 6}`} rotation={-90} origin="8, 8" />
          </Svg>
          {word(`${Math.round(pct * 100)}% context`, pillStyles.num)}
        </>
      ), "c") : null}
    </View>
  );
}

function PhoneDot({ colour }: { colour: string }) {
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
  return <Animated.View {...tid("sub-dot")} style={[phoneStyles.phoneDot, { backgroundColor: colour }, Platform.OS === "web" ? BREATH : { opacity: o }]} />;
}

const phoneStyles = StyleSheet.create({
  phoneMark: { width: 28, height: 28, borderRadius: 14, flexShrink: 0, alignItems: "center", justifyContent: "center" },
  phoneDot: { width: 10, height: 10, borderRadius: 5 },
  phoneRing: { width: 10, height: 10, borderRadius: 5, borderWidth: 2 },
});

const pillStyles = StyleSheet.create({
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8, minWidth: 0 },
  pill: { flexDirection: "row", alignItems: "center", columnGap: 6, minHeight: 30, paddingHorizontal: 10, borderWidth: 1, borderRadius: 15, maxWidth: "100%" },
  num: { fontVariant: ["tabular-nums"] },
});
