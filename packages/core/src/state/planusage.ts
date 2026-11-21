import { api } from "../api.ts";
import type { AgentKind, PlanUsageResult } from "../types.ts";
import type { AgentPlan } from "../logic/usage.ts";

type ServerPlans = Partial<Record<AgentKind, AgentPlan>>;
const empty: ServerPlans = {};
const plans = new Map<string, ServerPlans>();
const listeners = new Set<() => void>();
let revision = 0;
export const planUsageRevision = () => revision;

function notify() {
  revision++;
  for (const f of listeners) f();
}

const pending = new Map<string, { id: string; abort: AbortController }>();

export function subscribePlanUsage(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

export const planUsageOf = (server: string): ServerPlans => plans.get(server) ?? empty;

function put(server: string, next: ServerPlans) {
  plans.set(server, next);
  notify();
}

export function forgetPlanUsage(server: string) {
  pending.get(server)?.abort.abort();
  pending.delete(server);
  if (plans.delete(server)) notify();
}

function accept(next: ServerPlans, result: PlanUsageResult, passive = false) {
  const prior = next[result.agent];
  next[result.agent] = {
    agent: result.agent,
    usage: result.usage ?? prior?.usage,
    loading: passive && prior?.loading,
    error: result.error,
  };
}

export function planUsageEvent(server: string, request: string | undefined, result: PlanUsageResult) {
  if (request ? pending.get(server)?.id !== request : !result.usage?.plan) return;
  const current = planUsageOf(server);
  const prior = current[result.agent];
  const older = prior?.usage && result.usage && Date.parse(prior.usage.fetchedAt) > Date.parse(result.usage.fetchedAt);
  if (older && !request) return;
  const next = { ...current };
  accept(next, older ? { ...result, usage: prior.usage } : result, !request);
  put(server, next);
}

/** Shared across all three entry points and the foreground refresh in this window. */
export async function checkPlanUsage(server: string, agents: AgentKind[], fresh: boolean): Promise<void> {
  if (pending.has(server)) return;
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const abort = new AbortController();
  const request = { id, abort };
  pending.set(server, request);
  const starting = { ...planUsageOf(server) };
  for (const agent of agents) starting[agent] = { ...starting[agent], agent, loading: true };
  put(server, starting);
  try {
    const results = await api.usageOverview(server, fresh, id, abort.signal);
    if (pending.get(server) !== request) return;
    const next = { ...planUsageOf(server) };
    const received = new Set<AgentKind>();
    for (const result of results) {
      received.add(result.agent);
      // A streamed result may already have landed, followed by a newer passive update.
      if (next[result.agent]?.loading || !next[result.agent]) accept(next, result);
    }
    for (const agent of agents) {
      if (!received.has(agent) && next[agent]?.loading) accept(next, { agent, error: "The server no longer offers this agent." });
    }
    put(server, next);
  } catch (error) {
    if (pending.get(server) !== request) return;
    const next = { ...planUsageOf(server) };
    for (const agent of agents) {
      if (next[agent]?.loading) accept(next, { agent, error: error instanceof Error ? error.message : String(error) });
    }
    put(server, next);
  } finally {
    if (pending.get(server) === request) {
      pending.delete(server);
      notify();
    }
  }
}

export const planUsagePending = (server: string): boolean => pending.has(server);
