// What the usage popup asks the server for and keeps (the old page's Composer.tsx UsagePopover and ContextSection): the agent's plan limits of the chat's
// server, and the chat's context split by category. Each keeps its last answer (meter.ts) so that the popup opens with numbers, and asks again
// on open.
import { useEffect, useRef, useState } from "react";

import { api, ApiError } from "@aiwb/core/api.ts";
import { usageKey } from "@aiwb/core/logic/chatserver.ts";
import { shownBranch, shownKey } from "@aiwb/core/state/store.ts";
import type { AgentKind, ContextSplit, PlanUsage } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { lastSplit, lastUsage } from "./meter.ts";

export type Plan = { u: PlanUsage | null; loading: boolean; err: string; now: number; load: (fresh: boolean) => Promise<void> };

/** The plan limits of an agent on a server (`ask`: this agent has some to ask for; Pi has none and nothing is asked). Asked once on open, and
 *  again for "Check again" (`fresh`); `now` moves every 30 s so that "Updated 3m ago" and "Resets in…" follow. */
export function usePlan(agent: AgentKind, server: string, ask: boolean): Plan {
  const key = usageKey(server, agent);
  const [u, setU] = useState<PlanUsage | null>(lastUsage[key] ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try { const r = await api.usage(agent, fresh, server); lastUsage[key] = r; setU(r); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setLoading(false); setNow(Date.now()); }
  };
  useEffect(() => {
    if (!ask) return;
    void load(false);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return { u, loading, err, now, load };
}

export type Split = { s: ContextSplit | null; loading: boolean; err: string; load: (fresh: boolean) => Promise<void> };

/** The context split of the branch a chat shows: the last one kept, then the server's (when the chat has started: a 409 says it has not and is
 *  no error). An answer that comes after the branch changed is kept for its branch and not shown. */
export function useSplit(chat: string, started: boolean): Split {
  const branch = useStore((st) => shownBranch(st, chat)), key = useStore((st) => shownKey(st, chat));
  const [s, setS] = useState<ContextSplit | null>(() => lastSplit[key] ?? null);
  const on = useRef(branch); // the branch now, for an answer that comes after it changed
  on.current = branch;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try {
      const r = await api.contextSplit(chat, branch, fresh);
      lastSplit[key] = r;
      if (on.current !== branch) return;
      setS(r);
    } catch (e: any) { if (!(e instanceof ApiError && e.status === 409)) setErr(e?.message ?? String(e)); } // 409: not started
    finally { setLoading(false); }
  };
  useEffect(() => { setS(lastSplit[key] ?? null); if (started) void load(false); }, [branch]);
  return { s, loading, err, load };
}
