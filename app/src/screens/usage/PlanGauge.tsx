import { useEffect, useRef, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { agentMeta } from "@aiwb/core/agents.ts";
import { accountOf } from "@aiwb/core/logic/aliases.ts";
import { usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { gaugeState, isStale, limitTone, resetIn, tightestLimit, updatedAgo, usedShare, usedWords } from "@aiwb/core/logic/usage.ts";
import { planUsageOf, subscribePlanUsage } from "@aiwb/core/state/planusage.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { WarnIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { closeAnchoredPlanOverview, openPlanOverview, usePlanOverview } from "./overviewOpen.ts";
import { TABULAR } from "./PlanLimits.tsx";
import { plansFor, useUsageClock } from "./PlanOverview.tsx";
import { canReportUsage } from "./refresh.ts";

const localPlans = () => planUsageOf(LOCAL_SERVER);

export function PlanGauge() {
  const t = useTokens();
  const anchor = useRef<View>(null);
  const overview = usePlanOverview();
  const hidden = useStore((s) => s.sideHidden);
  const agents = useStore((s) => usableAgents(s));
  const aliases = useStore((s) => s.aliases[LOCAL_SERVER]);
  useSyncExternalStore(subscribePlanUsage, localPlans, localPlans);
  const now = useUsageClock();
  const plans = plansFor(LOCAL_SERVER, agents.filter(canReportUsage));
  const state = gaugeState(plans);
  const tightest = tightestLimit(plans);
  const meta = tightest ? agentMeta(tightest.agent) : undefined;
  const alias = tightest && accountOf(aliases, tightest.agent)?.name;
  const tone = tightest ? limitTone(tightest.limit) : state === "failed" ? "warn" : "ok";
  const colour = tone === "warn" ? t.warnText : tone === "danger" ? t.danger : t.text;
  const stale = !!tightest && isStale(tightest.fetchedAt, now);
  let label = state === "failed" ? "Plan usage check failed for every agent" : "Plan usage";
  if (tightest) {
    const reset = resetIn(tightest.limit.resetsAt, now);
    label = `${alias ?? meta?.name}, ${tightest.limit.label}: ${usedWords(tightest.limit.percent)}`;
    if (reset) label += `, resets ${reset}`;
    if (stale) label += `, stale, updated ${updatedAgo(tightest.fetchedAt, now)}`;
  }
  const tip = useControlRef(label);
  useEffect(() => () => closeAnchoredPlanOverview(anchor), []);
  useEffect(() => { if (hidden) closeAnchoredPlanOverview(anchor); }, [hidden]);
  if (hidden || (state === "hidden" && overview?.anchor !== anchor)) return null;
  return (
    <View ref={anchor} collapsable={false} style={styles.anchor}>
      {state !== "hidden" ? <Pressable {...tid("plan-gauge", { tone, state, stale: stale || undefined })} ref={tip} accessibilityRole="button" accessibilityLabel={label}
        aria-haspopup="dialog" accessibilityState={{ expanded: overview?.anchor === anchor }}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.button, { borderColor: t.line, backgroundColor: pressed || hovered ? t.panel : t.bg }, webStyle({ cursor: "pointer" })]}
        onPress={() => openPlanOverview(anchor, true)}>
        {state === "failed" ? <WarnIcon color={t.warn} /> : (
          <View style={[styles.track, { backgroundColor: t.line2 }]}>
            {tightest ? <View style={{ width: `${usedShare(tightest.limit.percent)}%`, height: "100%", backgroundColor: tone === "ok" ? t.accent : colour }} /> : null}
          </View>
        )}
        {tightest ? <Text size={11} numberOfLines={1} style={[TABULAR, styles.words, { color: colour }]}>{alias ?? meta?.short} {usedWords(tightest.limit.percent)}</Text> : null}
      </Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: { maxWidth: "100%", flexShrink: 1 },
  button: { minWidth: 28, height: 26, paddingHorizontal: 6, borderWidth: 1, borderRadius: 7, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
  track: { width: 14, height: 5, borderRadius: 3, overflow: "hidden" },
  words: { flexShrink: 1 },
});
