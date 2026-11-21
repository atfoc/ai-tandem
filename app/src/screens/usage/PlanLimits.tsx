import { StyleSheet, View, type TextStyle } from "react-native";

import { agentName } from "@aiwb/core/agents.ts";
import { limitTone, resetAt, resetIn, sortLimits, usedShare, usedWords } from "@aiwb/core/logic/usage.ts";
import type { AgentKind, PlanUsage, UsageLimit } from "@aiwb/core/types.ts";

import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { phoneTone } from "./phone.ts";

export function resetWords(limit: UsageLimit, now: number): string {
  const when = [resetIn(limit.resetsAt, now), resetAt(limit.resetsAt, now)].filter(Boolean).join(" · ");
  return when ? `Resets ${when}` : "";
}

export const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

type Layout = "compact" | "phone" | "overview";

export function PlanLimits({ agent, usage, now, layout, phone, note, warn }: {
  agent: AgentKind; usage?: PlanUsage | null; now: number; layout: Layout; phone?: boolean;
  note: (text: string) => React.ReactNode; warn: (text: string) => React.ReactNode;
}) {
  if (!usage) return null;
  if (!usage.plan) return note(usage.note || `${agentName(agent)} reported no plan limits.`);
  return (
    <>
      {sortLimits(usage.limits ?? []).map((limit) => <LimitRow key={limit.kind + limit.label} limit={limit} now={now} layout={layout} touch={phone} />)}
      {usage.note ? warn(usage.note) : null}
    </>
  );
}

function LimitRow({ limit, now, layout, touch }: { limit: UsageLimit; now: number; layout: Layout; touch?: boolean }) {
  const t = useTokens();
  const phone = layout === "phone";
  const compact = layout === "compact";
  const tone = phone ? phoneTone(limit) : limitTone(limit);
  const when = resetWords(limit, now);
  const ref = useControlRef(when && limit.resetsAt ? new Date(limit.resetsAt).toLocaleString() : undefined);
  const fill = tone === "danger" ? t.danger : tone === "warn" ? t.warn : t.accent;
  const words = tone === "danger" ? t.danger : tone === "warn" ? t.warnText : t.muted;
  const pct = usedShare(limit.percent);
  const size = phone || touch ? TYPE.body : 12;
  return (
    <View {...tid(layout === "overview" ? "plan-usage-limit" : "usage-row", { tone, kind: limit.kind })} style={phone ? styles.phone : compact ? styles.compact : styles.overview}>
      <View style={[styles.top, phone && styles.phoneTop]}>
        <Text size={size} style={styles.label}>{limit.label}</Text>
        <Text size={size} style={[TABULAR, layout === "overview" && styles.overviewWords, { color: compact ? t.muted : words }]}>
          {limit.detail ? <Text size={phone || touch ? TYPE.secondary : 12} tone={compact ? "faint" : "muted"}>{limit.detail} · </Text> : null}
          {layout === "overview" ? usedWords(pct) : `${Math.round(pct)}%`}
        </Text>
      </View>
      <View style={[styles.bar, phone && styles.phoneBar, { backgroundColor: t.line2 }]}>
        <View {...tid("usage-bar", { pct })} style={{ width: `${pct}%`, height: "100%", backgroundColor: fill, borderRadius: phone ? undefined : 3 }} />
      </View>
      {when ? <View ref={ref}><Text {...tid("usage-reset")} size={phone || touch ? TYPE.secondary : 11} tone={compact ? "faint" : "muted"}>{when}</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  compact: { paddingVertical: 5, paddingHorizontal: 8 },
  phone: { paddingTop: 6, paddingBottom: 10 },
  overview: { paddingVertical: 5 },
  top: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  phoneTop: { alignItems: "baseline", gap: 10 },
  label: { flexShrink: 1 },
  overviewWords: { flexShrink: 1, textAlign: "right" },
  bar: { height: 5, marginTop: 4, marginBottom: 3, borderRadius: 3, overflow: "hidden" },
  phoneBar: { height: 8, marginTop: 6, marginBottom: 6, borderRadius: 4 },
});
