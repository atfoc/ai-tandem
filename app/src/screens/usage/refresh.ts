import { agentMeta } from "@aiwb/core/agents.ts";
import { usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import type { ListsState } from "@aiwb/core/logic/serverlists.ts";
import { isWorking, inTurn } from "@aiwb/core/logic/status.ts";
import { usageCheckAt } from "@aiwb/core/logic/usage.ts";
import { checkPlanUsage, forgetPlanUsage, planUsagePending, subscribePlanUsage } from "@aiwb/core/state/planusage.ts";
import { getState, subscribe, type State } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER, type AgentKind } from "@aiwb/core/types.ts";

import { isForeground, watchForeground } from "./foreground";
import { planOverviewOpen, subscribePlanOverview } from "./overviewOpen.ts";

export const canReportUsage = (agent: AgentKind) => !!agentMeta(agent).usageTitle;

type Target = { id: string; agents: AgentKind[] };

export function usageTargets(s: ListsState): Target[] {
  const ids = [LOCAL_SERVER, ...(s.servers ?? []).filter((server) => server.id !== LOCAL_SERVER).map((server) => server.id)];
  return ids.flatMap((id) => {
    const agents = usableAgents(s, id);
    return agents.length && (id === LOCAL_SERVER || agents.some(canReportUsage)) ? [{ id, agents }] : [];
  });
}

type Schedule = { last?: number; asked?: string; turns: Set<string>; ended: boolean };
const schedules = new Map<string, Schedule>();

function turnsOn(s: State, server: string): Set<string> {
  const turns = new Set<string>();
  const tracked = new Set<string>();
  for (const [key, branch] of Object.entries(s.states)) {
    if (serverOfKey(branch.chat) !== server) continue;
    tracked.add(branch.chat);
    if (inTurn(branch.status) && !s.chats[branch.chat]?.fresh) turns.add(key);
  }
  for (const [key, chat] of Object.entries(s.chats)) {
    if (serverOfKey(key) === server && !tracked.has(key) && inTurn(chat.status) && !chat.fresh) turns.add(key);
  }
  return turns;
}

function ask(target: Target, fresh: boolean, now = Date.now()) {
  if (!isForeground() || planUsagePending(target.id)) return;
  const schedule = schedules.get(target.id) ?? { turns: new Set<string>(), ended: false };
  schedules.set(target.id, schedule);
  schedule.last = now;
  schedule.asked = target.agents.join(",");
  schedule.ended = false;
  void checkPlanUsage(target.id, target.agents, fresh);
}

export function checkAllPlans(fresh: boolean) {
  for (const target of usageTargets(getState())) ask(target, fresh);
}

export function watchPlanUsage(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;
  const queue = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      if (!scheduled) return;
      scheduled = false;
      update();
    });
  };
  const update = () => {
    clearTimeout(timer);
    const s = getState(), targets = usageTargets(s);
    for (const id of schedules.keys()) {
      if (!targets.some((target) => target.id === id)) {
        schedules.delete(id);
        forgetPlanUsage(id);
      }
    }
    const now = Date.now(), foreground = isForeground();
    let due = Infinity;
    for (const target of targets) {
      if (!target.agents.some(canReportUsage) || (target.id !== LOCAL_SERVER && !planOverviewOpen())) continue;
      const schedule = schedules.get(target.id) ?? { turns: new Set<string>(), ended: false };
      schedules.set(target.id, schedule);
      const turns = turnsOn(s, target.id);
      if ([...schedule.turns].some((key) => !turns.has(key))) schedule.ended = true;
      schedule.turns = turns;
      if (planUsagePending(target.id)) continue;
      const working = turns.size > 0 || Object.values(s.chats).some((c) => serverOfKey(c.id) === target.id && isWorking(c));
      const changed = schedule.asked !== target.agents.join(",");
      const at = usageCheckAt({ foreground, working, turnEnded: schedule.ended || changed, last: schedule.last });
      if (at <= now) ask(target, false, now);
      else due = Math.min(due, at);
    }
    if (Number.isFinite(due)) timer = setTimeout(queue, Math.max(0, due - now));
  };
  let previous = getState();
  const stateChanged = () => {
    const next = getState();
    if (next.chats !== previous.chats || next.states !== previous.states || next.usable !== previous.usable ||
      next.lists !== previous.lists || next.servers !== previous.servers || next.sections !== previous.sections ||
      next.connected !== previous.connected) queue();
    previous = next;
  };
  const cleanups = [subscribe(stateChanged), subscribePlanUsage(queue), watchForeground(queue), subscribePlanOverview(queue)];
  update();
  return () => {
    scheduled = false;
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
  };
}
