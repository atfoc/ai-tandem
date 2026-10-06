// A run's detail on the client: how `run_detail` and `run_activity` events change it, and what
// happens to the events that arrive while the detail is being fetched. DOM-free.
import type { RunDetail, RunPatch, RunDetailEvent, RunActivityEvent, RunAgent } from "../types.ts";
import { Loads } from "./branchview.ts";

/** A detail with nothing in it yet: what a run has right after its start is recorded. */
export const emptyDetail = (run: string, startedAt = 0): RunDetail => ({
  run, version: 0, status: "running", startedAt, goalSize: 0,
  stops: [], turns: [], tasks: [], chatOps: [], agents: {}, notes: [],
});

/** Puts `recs` into `list` by key: a record whose key the list has replaces that one in place, a
 *  new one goes where its key sorts (`order`), or to the end when the list has no order. Returns
 *  `list` itself when `recs` is empty. */
function upsert<T, K>(list: T[], recs: T[] | undefined, key: (x: T) => K, order?: (a: K, b: K) => number): T[] {
  if (!recs || !recs.length) return list;
  const out = list.slice();
  const at = new Map<K, number>(out.map((x, i) => [key(x), i]));
  let added = false;
  for (const r of recs) {
    const k = key(r), i = at.get(k);
    if (i !== undefined) out[i] = r;
    else { at.set(k, out.length); out.push(r); added = true; }
  }
  if (added && order) out.sort((a, b) => order(key(a), key(b)));
  return out;
}

const byNumber = (a: number, b: number) => a - b;

/**
 * Applies a `run_detail` patch. Scalars and `git` / `result` / `delivery` replace; `stops` is the whole list;
 * `turns` (by n), `tasks` (by id), `chatOps` (by i) and `notes` (by v) replace the record with the
 * same key or add it; `agents` are merged by id. Nothing is removed. The detail given is not
 * changed, and what the patch does not name keeps its identity, record by record. `version` is
 * not touched: applyRunEvent sets it.
 */
export function applyRunPatch(d: RunDetail, p: RunPatch): RunDetail {
  const next: RunDetail = { ...d };
  if (p.status !== undefined) next.status = p.status;
  if (p.startedAt !== undefined) next.startedAt = p.startedAt;
  if (p.endedAt !== undefined) next.endedAt = p.endedAt;
  if (p.goalSize !== undefined) next.goalSize = p.goalSize;
  if (p.git !== undefined) next.git = p.git;
  if (p.result !== undefined) next.result = p.result;
  if (p.delivery !== undefined) next.delivery = p.delivery;
  // A patch cannot remove a field: a run that goes on has no delivery until it halts again.
  else if ((p.status === "running" || p.status === "stopping") && next.delivery) delete next.delivery;
  if (p.stops !== undefined) next.stops = p.stops;
  next.turns = upsert(d.turns, p.turns, (t) => t.n, byNumber);
  next.tasks = upsert(d.tasks, p.tasks, (t) => t.id); // new tasks arrive in creation order
  next.chatOps = upsert(d.chatOps, p.chatOps, (o) => o.i, byNumber);
  next.notes = upsert(d.notes, p.notes, (n) => n.v, byNumber);
  if (p.agents && Object.keys(p.agents).length) next.agents = { ...d.agents, ...p.agents };
  return next;
}

/**
 * Applies a `run_detail` event to the detail the client holds.
 *   "stale": the event is not newer than the detail (it was already in the fetched detail): ignore it.
 *   "gap":   an event between is missing: the detail must be fetched again (there is no replay).
 * Otherwise the new detail, at the event's version.
 */
export function applyRunEvent(d: RunDetail, ev: Pick<RunDetailEvent, "version" | "patch">): RunDetail | "stale" | "gap" {
  if (ev.version <= d.version) return "stale";
  if (ev.version !== d.version + 1) return "gap";
  return { ...applyRunPatch(d, ev.patch), version: ev.version };
}

/** Applies a `run_activity` event: the values named are set on the agents the detail has; an agent
 *  it does not have is skipped (its record arrives with a `run_detail` event). */
export function applyRunActivity(d: RunDetail, agents: RunActivityEvent["agents"]): RunDetail {
  let out: Record<string, RunAgent> | null = null;
  for (const [id, a] of Object.entries(agents)) {
    const cur = d.agents[id];
    if (!cur) continue;
    const next: RunAgent = { ...cur };
    if (a.activity !== undefined) next.activity = a.activity;
    if (a.tools !== undefined) next.tools = a.tools;
    if (a.cost !== undefined) next.cost = a.cost;
    if (a.peakContext !== undefined) next.peakContext = a.peakContext;
    (out ??= { ...d.agents })[id] = next;
  }
  return out ? { ...d, agents: out } : d;
}

// ---- fetching: conn.ts loadRun keeps one of these

/** What a run sends about its detail: a versioned `run_detail` change or the unversioned live
 *  values of `run_activity`. */
export type RunFeedEvent = Pick<RunDetailEvent, "version" | "patch"> | Pick<RunActivityEvent, "agents">;

/** `ev` on the detail held: the new detail (`d` itself when nothing changed), or "gap". */
function feed(d: RunDetail, ev: RunFeedEvent): RunDetail | "gap" {
  if ("agents" in ev) return applyRunActivity(d, ev.agents);
  const r = applyRunEvent(d, ev);
  return r === "stale" ? d : r;
}

/**
 * The fetches of run details and the events that arrive meanwhile. One fetch per run counts, the
 * newest (begin); while it runs the run's events are queued (event), and its answer gets them
 * applied in order by the rule of applyRunEvent (end). Activity is queued with them, so the last
 * thing that arrived is what shows.
 */
export class RunLoads {
  private loads = new Loads();
  private queued = new Map<string, RunFeedEvent[]>();

  /** Starts a fetch of a run's detail: its events are queued from here. Returns the ticket for end. */
  begin(run: string): number {
    this.queued.set(run, []);
    return this.loads.begin(run);
  }

  /** Whether a fetch of the run's detail runs. */
  fetching(run: string): boolean { return this.queued.has(run); }

  /**
   * An event of a run, with the detail held (undefined: none).
   *   "queued":  a fetch runs; the event waits for its answer.
   *   "ignored": there is no detail to change.
   *   "gap":     an event between is missing: the caller drops the detail and fetches it again.
   * Otherwise the detail to hold: `cur` itself when the event changed nothing.
   */
  event(run: string, cur: RunDetail | undefined, ev: RunFeedEvent): RunDetail | "queued" | "ignored" | "gap" {
    const q = this.queued.get(run);
    if (q) { q.push(ev); return "queued"; }
    return cur ? feed(cur, ev) : "ignored";
  }

  /**
   * A fetch answered (fetched undefined: it failed).
   *   "superseded": a newer fetch, or drop, took the run over: the answer is discarded.
   *   "failed":     no detail; what was queued is dropped.
   *   "gap":        the queue starts past the answer: the caller fetches again.
   * Otherwise the detail to hold: the answer with what was queued applied.
   */
  end(run: string, ticket: number, fetched: RunDetail | undefined): RunDetail | "superseded" | "failed" | "gap" {
    if (!this.loads.current(run, ticket)) return "superseded";
    const q = this.queued.get(run) ?? [];
    this.queued.delete(run);
    if (!fetched) return "failed";
    let d = fetched;
    for (const ev of q) {
      const r = feed(d, ev);
      if (r === "gap") return "gap";
      d = r;
    }
    return d;
  }

  /** Forgets a run: a fetch that runs is discarded when it answers, and nothing is queued. */
  drop(run: string): void {
    this.loads.begin(run);
    this.queued.delete(run);
  }

  /** Forgets every run (a snapshot replaced the state). */
  reset(): void {
    for (const run of [...this.queued.keys()]) this.drop(run);
  }
}
