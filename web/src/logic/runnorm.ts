// What the server sends about a run, made whole before it enters the store: a list the server
// left out or sent as null (a Go nil slice) is an empty list, a number it left out is 0, a state
// this client does not know is not drawn. DOM-free. The views validate nothing: this is the one
// place where the wire's shape is trusted no further than it must be.
import type { Attempt, AttemptChanges, AttemptReport, ModelChoice, NotesVersion, Op, Phase, RunAgent, RunCounts, RunDelivery, RunDetail, RunGoal, RunNotes, RunPatch, RunSettings,
  RunTiers, RunView, RunWait, Task, TaskBrief, Tier, TokenCount, Turn } from "../types.ts";

const arr = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);
/** A list of records: an entry that is no record is left out. */
const recs = <T>(v: T[] | null | undefined): T[] => arr(v).filter((x) => x != null && typeof x === "object");
const num = (v: unknown, or = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : or);
const str = (v: unknown, or = ""): string => (typeof v === "string" ? v : or);
const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

const PHASES = new Set<string>(["held", "deps", "blocked", "slot", "setup", "work", "merge"]);
const OUTCOMES = new Set<string>(["done", "failed", "cancelled"]);
export const SETTINGS: RunSettings = { maxParallel: 8, maxTurns: 60, maxCost: 0, wake: "declared", maxIdleTurns: 3, agentTimeoutSec: 10800, agentRetries: 2 };
const COUNTS: RunCounts = { held: 0, deps: 0, blocked: 0, slot: 0, setup: 0, work: 0, merge: 0, done: 0, failed: 0, cancelled: 0 };

const TIER_NAMES = new Set<string>(["deep", "standard", "light"]);
/** A tier this client does not know (or none: a record of before tiers) is the middle one. */
const tier = (v: unknown): Tier => (typeof v === "string" && TIER_NAMES.has(v) ? (v as Tier) : "standard");
const choice = (c: ModelChoice | null | undefined): ModelChoice => ({ ...c, model: str(c?.model) });
/** A run's tiers: all three keys, each with a model ("" when the server named none). */
export const normTiers = (t: Partial<RunTiers> | null | undefined): RunTiers => ({ deep: choice(t?.deep), standard: choice(t?.standard), light: choice(t?.light) });
/** A wait: its tasks are a list; one that is null or absent is no wait. */
const normWait = (w: RunWait | null | undefined): RunWait | undefined =>
  (w && typeof w === "object" ? { tasks: arr(w.tasks), mode: w.mode === "any" ? "any" : "all", turn: num(w.turn) } : undefined);
const normTokens = (t: TokenCount | null | undefined): TokenCount | null =>
  (t && typeof t === "object" ? { in: num(t.in), out: num(t.out), cacheRead: num(t.cacheRead), cacheWrite: num(t.cacheWrite) } : null);
/** A delivery: `files` stays absent when it is empty. */
export const normDelivery = (d: RunDelivery): RunDelivery => ({ ...d, state: str(d?.state, "none") as RunDelivery["state"], files: Array.isArray(d?.files) && d.files.length ? d.files : undefined });

/** A run's light record. A started run always has `started` (the views ask it whether the run is a draft). */
export function normRun(r: RunView): RunView {
  const status = str(r.status, r.started ? "stopped" : "draft") as RunView["status"];
  return {
    ...r, status, name: str(r.name), cwd: str(r.cwd), tiers: normTiers(r.tiers), tierDefaults: r.tierDefaults ? normTiers(r.tierDefaults) : undefined,
    wait: normWait(r.wait), delivery: opt(r.delivery), group: str(r.group, "__ungrouped__"),
    settings: { ...SETTINGS, ...(r.settings ?? {}) }, counts: { ...COUNTS, ...(r.counts ?? {}) },
    started: r.started ?? (status === "draft" ? undefined : str(r.created, new Date(num(r.asOf)).toISOString())),
    activeMs: num(r.activeMs), asOf: num(r.asOf), turns: num(r.turns), idleStreak: num(r.idleStreak), attention: num(r.attention),
    cost: typeof r.cost === "number" ? r.cost : null, draft: opt(r.draft),
  };
}

const normOp = (o: Op, t: number): Op => ({ ...o, op: str(o.op) as Op["op"], t: num(o.t, t), dependsOn: opt(o.dependsOn), changed: opt(o.changed),
  needsReport: opt(o.needsReport), tasks: opt(o.tasks) });

function normTurn(t: Turn, at: number): Turn {
  const startedAt = num(t.startedAt, at);
  return { ...t, startedAt, wait: normWait(t.wait), wokenBy: recs(t.wokenBy), learned: recs(t.learned), ops: recs(t.ops).map((o) => normOp(o, startedAt)), cost: typeof t.cost === "number" ? t.cost : null };
}

function normAttempt(a: Attempt, n: number, at: number): Attempt {
  const queuedAt = num(a.queuedAt, at);
  const phases = recs(a.phases).filter((p: Phase) => PHASES.has(p.k) && typeof p.t === "number").map((p) => (p.on === null ? { ...p, on: undefined } : p));
  // an outcome this client does not know: the attempt ended, and not well
  const outcome = a.outcome == null ? undefined : OUTCOMES.has(a.outcome) ? a.outcome : "failed";
  return { ...a, n: num(a.n, n), tier: tier(a.tier), queuedTurn: num(a.queuedTurn), queuedAt, phases, outcome, agents: a.agents ?? {}, cost: typeof a.cost === "number" ? a.cost : null,
    conflicts: opt(a.conflicts), result: opt(a.result), cancel: opt(a.cancel) };
}

function normTask(t: Task, at: number): Task {
  const createdAt = num(t.createdAt, at), briefs = recs(t.briefs);
  let attempts = recs(t.attempts).map((a, i) => normAttempt(a, i + 1, createdAt));
  // the contract says "at least one": a task with none is drawn as held
  if (!attempts.length) attempts = [{ n: 1, tier: tier(t.tier), queuedTurn: num(t.addedTurn), queuedAt: createdAt, phases: [], agents: {}, cost: null }];
  return { ...t, title: str(t.title), kind: str(t.kind), writes: !!t.writes, dependsOn: arr(t.dependsOn), needsReport: arr(t.needsReport), tier: tier(t.tier), tierReason: str(t.tierReason), addedTurn: num(t.addedTurn), createdAt, changedTurns: arr(t.changedTurns),
    briefs: briefs.map((b) => ({ ...b, size: num(b.size) })), briefRev: num(t.briefRev, briefs[briefs.length - 1]?.rev ?? 1), attempts };
}

const normAgent = (a: RunAgent, id: string, at: number): RunAgent =>
  ({ ...a, id: str(a.id, id), name: str(a.name, id), startedAt: num(a.startedAt, at), launches: recs(a.launches), cost: typeof a.cost === "number" ? a.cost : null,
    tier: tier(a.tier), model: str(a.model), tokens: normTokens(a.tokens) });

const normNote = (n: NotesVersion): NotesVersion => ({ ...n, size: num(n.size) });

const agentsOf = (m: Record<string, RunAgent> | null | undefined, at: number): Record<string, RunAgent> =>
  Object.fromEntries(Object.entries(m ?? {}).filter(([, a]) => a).map(([id, a]) => [id, normAgent(a, id, at)]));

/** The earliest moment a detail names: where a run with no `startedAt` starts. */
function firstTime(d: Partial<RunDetail>): number {
  let t = Infinity;
  for (const x of recs(d.turns)) if (typeof x?.startedAt === "number") t = Math.min(t, x.startedAt);
  for (const x of recs(d.tasks)) if (typeof x?.createdAt === "number") t = Math.min(t, x.createdAt);
  return Number.isFinite(t) ? t : 0;
}

/** GET /api/runs/{id}/detail */
export function normDetail(d: RunDetail): RunDetail {
  const startedAt = num(d.startedAt, firstTime(d));
  return {
    ...d, version: num(d.version), status: str(d.status, "stopped") as RunDetail["status"], startedAt, endedAt: opt(d.endedAt), goalSize: num(d.goalSize), git: opt(d.git), result: opt(d.result), delivery: d.delivery ? normDelivery(d.delivery) : undefined,
    stops: recs(d.stops), turns: recs(d.turns).map((t) => normTurn(t, startedAt)), tasks: recs(d.tasks).map((t) => normTask(t, startedAt)),
    chatOps: recs(d.chatOps).map((o) => normOp(o, startedAt)), agents: agentsOf(d.agents, startedAt), notes: recs(d.notes).map(normNote),
  };
}

/** A `run_detail` patch: what it names is made whole; a field that is null or absent names nothing
 *  (a patch never removes, so a nil list is "no change", also for `stops`, `git`, `result` and `delivery`). */
export function normPatch(p: RunPatch | null | undefined, at = 0): RunPatch {
  const out: RunPatch = {};
  if (!p) return out;
  if (typeof p.status === "string" && p.status) out.status = p.status;
  if (typeof p.startedAt === "number") out.startedAt = p.startedAt;
  if (typeof p.endedAt === "number") out.endedAt = p.endedAt;
  if (typeof p.goalSize === "number") out.goalSize = p.goalSize;
  if (p.git) out.git = p.git;
  if (p.result) out.result = p.result;
  if (p.delivery) out.delivery = normDelivery(p.delivery);
  if (Array.isArray(p.stops)) out.stops = recs(p.stops);
  if (Array.isArray(p.turns)) out.turns = recs(p.turns).map((t) => normTurn(t, at));
  if (Array.isArray(p.tasks)) out.tasks = recs(p.tasks).map((t) => normTask(t, at));
  if (Array.isArray(p.chatOps)) out.chatOps = recs(p.chatOps).map((o) => normOp(o, at));
  if (Array.isArray(p.notes)) out.notes = recs(p.notes).map(normNote);
  if (p.agents) out.agents = agentsOf(p.agents, at);
  return out;
}

// ---- the texts loaded on demand

export const normChanges = (c: AttemptChanges): AttemptChanges =>
  ({ ...c, branch: str(c.branch), base: str(c.base), head: str(c.head), files: recs(c.files), commits: recs(c.commits), add: num(c.add), del: num(c.del), conflicts: opt(c.conflicts) });
export const normReport = (r: AttemptReport): AttemptReport => ({ ...r, summary: str(r.summary), report: str(r.report) });
export const normBrief = (b: TaskBrief): TaskBrief => ({ ...b, text: str(b.text), size: num(b.size) });
export const normGoal = (g: RunGoal): RunGoal => ({ text: str(g?.text) });
export const normNotes = (n: RunNotes): RunNotes => ({ ...n, text: str(n.text), size: num(n.size) });
