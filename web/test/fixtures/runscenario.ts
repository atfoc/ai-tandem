// Test only: makes the states the sample run (run-qa.json) does not contain. Nothing in web/src
// may import this.
//   freeze(run, t)   — the run as it was at time t, as if live
//   synthesize(run)  — adds a failed-then-retried task, a cancelled task, a merge with conflicts,
//                      a refused call and a stop → resume gap of six hours to the finished 53-task run
//   failNow(run, …)  — in a frozen run: one task has just failed and its dependent is blocked
import type { TLAttempt, TLRun, TLTask, TLTurn } from "../../src/logic/runtimeline.ts";

// The run of the fixture: what the layout reads, plus what these helpers and the tests read.
export interface ScAttempt extends TLAttempt { queuedAt: number; error?: string | null }
export interface ScTask extends TLTask { title: string; kind: string; writes: boolean; attempts: ScAttempt[] }
export interface ScTurn extends TLTurn { wokenBy: { task: string }[] }
export interface ScRun extends TLRun {
  turns: ScTurn[]; tasks: ScTask[];
  limits?: Record<string, number | string>;
  /** Set by freeze: the moment the run was cut at, to pass as `now`. */
  frozenAt?: number;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const ACTIVITY = ["Bash: go test ./internal/chats/ -run TestFork", "Read web/src/Composer.tsx", "Edit internal/agents/pi/adapter.go", "Bash: node --test test/forktree.test.ts", "Grep \"pendingMove\" web/src", "Subagent: Explore the fork tree code"];

/** The run as it was at time `t`, as if live. With `activity`, every attempt that was running
 *  gets a made-up last action. */
export function freeze(run0: ScRun, t: number, activity = false): ScRun {
  const run = clone(run0);
  run.status = "running"; run.endedAt = null; run.frozenAt = t;
  run.turns = run.turns.filter((x) => x.startedAt <= t);
  for (const x of run.turns) {
    if (x.endedAt != null && x.endedAt > t) { x.endedAt = null; x.status = "running"; x.ops = x.ops.filter((p) => p.t <= t); }
  }
  run.tasks = run.tasks.filter((x) => x.createdAt <= t);
  const have = new Set(run.tasks.map((x) => x.id));
  let k = 0;
  for (const x of run.tasks) {
    x.dependsOn = x.dependsOn.filter((d) => have.has(d));
    x.attempts = x.attempts.filter((a) => a.queuedAt <= t);
    for (const a of x.attempts) {
      a.phases = a.phases.filter((p) => p.t <= t);
      for (const p of a.phases) if (p.on) p.on = p.on.filter((d) => have.has(d));
      if (a.endedAt == null || a.endedAt > t) {
        a.endedAt = null; a.outcome = null; a.mergedAt = null;
        if (a.startedAt != null && a.startedAt > t) a.startedAt = null;
        else if (activity && a.startedAt != null) a.activity = ACTIVITY[k++ % ACTIVITY.length];
      }
    }
  }
  return run;
}

/** In a frozen run: task `failId` failed at `at`, and `blockedId` is blocked by it from then on. */
export function failNow(run: ScRun, failId: string, at: number, blockedId?: string): ScRun {
  const f = run.tasks.find((x) => x.id === failId)!, b = run.tasks.find((x) => x.id === blockedId);
  const a = f.attempts[f.attempts.length - 1];
  a.endedAt = at; a.outcome = "failed"; a.error = "its agent reported that it could not do the task";
  if (b) {
    const b1 = b.attempts[0];
    b1.phases = b1.phases.filter((p) => p.t < at);
    b1.phases.push({ k: "blocked", t: at, on: [failId] });
    b1.startedAt = null; b1.endedAt = null; b1.outcome = null;
    if (!b.dependsOn.includes(failId)) b.dependsOn.push(failId);
  }
  return run;
}

/** The finished 53-task run with a retry, a cancel, a conflict merge, a refused call and a stop. */
export function synthesize(run0: ScRun): ScRun {
  const run = clone(run0);
  const T = (id: string) => run.tasks.find((x) => x.id === id)!;
  const turn = (n: number) => run.turns.find((x) => x.n === n)!;
  const at = (sec: number) => run.createdAt + sec * 1000;

  // 1. T41 (a 40-minute review): attempt 1 fails after 13 minutes; turn 24 retries it; attempt 2 is the rest.
  {
    const t = T("T41"), a1 = t.attempts[0], a2 = clone(a1);
    const fail = at(9700), retry = at(10000), t24 = turn(24), go = t24.endedAt!;
    a1.phases = a1.phases.filter((p) => p.t < fail); a1.endedAt = fail; a1.outcome = "failed";
    a1.error = "agent T41-work failed: no result after 3 attempts (timeout)";
    a2.n = 2; a2.queuedTurn = 24; a2.queuedAt = retry; a2.startedAt = go;
    a2.phases = [{ k: "held", t: retry, turn: 24 }, { k: "setup", t: go }, { k: "work", t: go + 3000 }];
    t.attempts.push(a2);
    t24.ops.push({ op: "retry_task", task: "T41", i: t24.ops.length, t: retry });
    t24.ops.sort((x, y) => x.t - y.t);
    t24.wokenBy.push({ task: "T41" });
  }
  // 2. T29 (nobody depends on it): cancelled while pending, in turn 9.
  {
    const a = T("T29").attempts[0], t9 = turn(9), when = at(4400);
    a.phases = a.phases.filter((p) => p.t < when); a.endedAt = when; a.outcome = "cancelled"; a.startedAt = null; a.mergedAt = null;
    t9.ops.push({ op: "cancel_task", task: "T29", i: t9.ops.length, t: when }); t9.ops.sort((x, y) => x.t - y.t);
  }
  // 3. T36: its merge conflicted; a merge agent took four minutes.
  {
    const a = T("T36").attempts[0], m = at(8870);
    a.conflicts = ["web/src/Composer.tsx", "web/src/fork/actions.ts"];
    a.phases = a.phases.filter((p) => p.k !== "merge"); a.phases.push({ k: "merge", t: m });
  }
  // 4. A refused call, so the lane shows one: turn 16 tried to finish while tasks were open.
  {
    const t16 = turn(16);
    t16.ops.push({ op: "finish_run", error: "the run cannot finish while tasks are pending or running: T30, T34, T35", i: t16.ops.length, t: t16.endedAt! - 20000 });
  }
  // 5. The run was stopped at +3h27m for six hours, with T47 running: every later time moves on.
  {
    const s = at(12400), gap = 6 * 3600 * 1000;
    const shift = (v: unknown) => (typeof v === "number" && v > s && v > 1e12 ? v + gap : v);
    const walk = (o: Record<string, unknown>) => {
      for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === "object") walk(v as Record<string, unknown>); else o[k] = shift(v); }
    };
    walk(run.turns as unknown as Record<string, unknown>); walk(run.tasks as unknown as Record<string, unknown>);
    if (run.endedAt != null && run.endedAt > s) run.endedAt += gap;
    run.stops = [{ at: s, resumedAt: s + gap, reason: "user" }];
  }
  return run;
}
