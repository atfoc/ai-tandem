import { useEffect, useState, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";

import { agentName } from "@aiwb/core/agents.ts";
import { accountOf } from "@aiwb/core/logic/aliases.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { gaugeState, isStale, limitTone, tightestLimit, updatedAgo, usedWords, type AgentPlan } from "@aiwb/core/logic/usage.ts";
import { planUsageOf, planUsagePending, planUsageRevision, subscribePlanUsage } from "@aiwb/core/state/planusage.ts";
import { LOCAL_SERVER, type AgentKind } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { AgentGlyph } from "../../ui/icons.tsx";
import { Popover } from "../../ui/Popover.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { closePlanOverview, usePlanOverview } from "./overviewOpen.ts";
import { PlanLimits, resetWords, TABULAR } from "./PlanLimits.tsx";
import { canReportUsage, checkAllPlans, usageTargets, watchPlanUsage } from "./refresh.ts";

const TITLE = "Plan usage";

export function useUsageClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return Math.max(now, Date.now());
}

export function plansFor(id: string, agents: readonly AgentKind[]): AgentPlan[] {
  const plans = planUsageOf(id);
  return agents.map((agent) => plans[agent] ?? { agent });
}

export function PlanOverviewHost() {
  const open = usePlanOverview();
  const phone = usePhone();
  useEffect(watchPlanUsage, []);
  useEffect(() => { if (open) checkAllPlans(false); }, [open]);
  if (!open) return null;
  const props = { open: true, label: TITLE, onClose: closePlanOverview, testID: "plan-overview" };
  if (phone) {
    return <Sheet {...props} head={<SheetHead title={TITLE} right={{ label: "Done", onPress: closePlanOverview }} />}><OverviewBody phone /></Sheet>;
  }
  if (!open.anchor) {
    return <Dialog {...props} width={400}><OverviewBody /></Dialog>;
  }
  return <Popover {...props} anchor={open.anchor} up={open.up}><OverviewBody popover /></Popover>;
}

function OverviewBody({ phone, popover }: { phone?: boolean; popover?: boolean }) {
  const t = useTokens();
  const now = useUsageClock();
  const servers = useStore((s) => s.servers);
  const connected = useStore((s) => s.connected);
  const sections = useStore((s) => s.sections);
  const usable = useStore((s) => s.usable);
  const lists = useStore((s) => s.lists);
  const aliases = useStore((s) => s.aliases);
  useSyncExternalStore(subscribePlanUsage, planUsageRevision, planUsageRevision);
  const targets = usageTargets({ servers, connected, sections, usable, lists });
  const groups = targets.map(({ id, agents }) => ({ id, plans: plansFor(id, agents) })).filter(({ id, plans }) =>
    id === LOCAL_SERVER || gaugeState(plans.filter((plan) => canReportUsage(plan.agent))) !== "hidden",
  );
  let oldest: string | undefined;
  for (const { plans } of groups) {
    for (const { usage } of plans) {
      if (usage?.plan && usage.fetchedAt && (!oldest || Date.parse(usage.fetchedAt) < Date.parse(oldest))) oldest = usage.fetchedAt;
    }
  }
  const stale = !!oldest && isStale(oldest, now);
  const loading = targets.some(({ id }) => planUsagePending(id));
  return (
    <View style={[styles.body, popover && styles.popover]}>
      {!phone ? (
        <View style={styles.heading}>
          <Text size={15} weight="600" accessibilityRole="header" style={styles.grow}>{TITLE}</Text>
          <Button label="Done" size="sm" tone="ghost" onPress={closePlanOverview} />
        </View>
      ) : null}
      {!groups.length ? <Text tone="muted">No usable agents report plan limits.</Text> : null}
      {groups.map(({ id, plans }) => (
        <View key={id} {...tid("plan-usage-server", { server: id })} style={styles.group}>
          {id !== LOCAL_SERVER ? <Text size={13} weight="600" tone="muted" accessibilityRole="header">On {serverName({ servers }, id)}</Text> : null}
          {plans.map((plan) => <AgentSection key={plan.agent} plan={plan} now={now} phone={phone} name={accountOf(aliases[id], plan.agent)?.name ?? agentName(plan.agent)} />)}
        </View>
      ))}
      <View style={[styles.footer, { borderTopColor: t.line }]}>
        <Text {...tid("plan-overview-age", { stale: stale || undefined })} size={phone ? 13 : 12} tone={stale ? "warn" : "muted"} style={styles.grow}>
          {oldest ? `Updated ${updatedAgo(oldest, now)}${stale ? " · stale" : ""}` : loading ? "Checking…" : ""}
        </Text>
        <Button label="↻ Check again" accessibilityLabel="Check again" testID="plan-overview-refresh" size={phone ? "touch" : "sm"} disabled={loading || !targets.length}
          onPress={() => checkAllPlans(true)} />
      </View>
    </View>
  );
}

function AgentSection({ plan, now, name, phone }: { plan: AgentPlan; now: number; name: string; phone?: boolean }) {
  const t = useTokens();
  const tightest = tightestLimit([{ ...plan, error: undefined }])?.limit;
  const tone = tightest && limitTone(tightest);
  const when = tightest && resetWords(tightest, now);
  const size = phone ? 13 : 12;
  const warn = (text: string) => <Text size={size} style={{ color: t.warnText }}>{text}</Text>;
  return (
    <View {...tid("plan-usage-agent", { agent: plan.agent, loading: plan.loading || undefined })} style={[styles.agent, { borderColor: t.line }]}>
      <View style={styles.heading}>
        <AgentGlyph agent={plan.agent} />
        <Text weight="600" accessibilityRole="header" style={styles.grow}>{name}</Text>
        {tightest ? <Text weight="600" tone={tone === "ok" ? "text" : tone} style={TABULAR}>{usedWords(tightest.percent)}</Text> : null}
      </View>
      {when ? <Text size={size} tone="muted" style={styles.reset}>{when}</Text> : null}
      {plan.loading || (!plan.usage && !plan.error) ? <Text size={size} tone="muted">{plan.usage ? "Updating…" : "Checking…"}</Text> : null}
      {plan.error ? warn(plan.error) : null}
      <PlanLimits agent={plan.agent} usage={plan.usage} now={now} layout="overview" phone={phone}
        note={(text) => <Text size={size} tone="muted">{text}</Text>} warn={warn} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, gap: 12 },
  popover: { width: 376, maxWidth: "100%" },
  group: { gap: 8 },
  agent: { padding: 10, borderWidth: 1, borderRadius: 8, gap: 3 },
  heading: { flexDirection: "row", alignItems: "center", gap: 7 },
  grow: { flex: 1 },
  reset: { textAlign: "right" },
  footer: { borderTopWidth: 1, paddingTop: 9, flexDirection: "row", alignItems: "center", gap: 8 },
});
