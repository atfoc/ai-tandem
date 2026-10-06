// A run's detail as the server sends it (types.ts RunDetail) → what the timeline draws
// (runlabels.ts TimelineRun). DOM-free. The timeline validates nothing, so this is where a list
// the server left out becomes an empty one.
import type { Attempt, Op, RunDetail, Task, Turn } from "../types.ts";
import type { TimelineOp, TimelineRun, TimelineTask, TimelineTurn } from "./runlabels.ts";

const list = <T>(v: T[] | null | undefined): T[] => v ?? [];
const EMPTY: never[] = [];

// A record of the detail keeps its identity from one event to the next unless the event names it
// (rundetail.ts applyRunPatch), and so does what is made from it here: the timeline renders again
// only the rows whose task changed.
const turns = new WeakMap<Turn, TimelineTurn>();
const tasks = new WeakMap<Task, { activity: string | undefined; out: TimelineTask }>();
const runs = new WeakMap<RunDetail, TimelineRun>();

/** A turn: of the events that woke it only those that name a task, as the timeline reads them. */
function turnInput(t: Turn): TimelineTurn {
  let out = turns.get(t);
  if (!out) {
    const wokenBy = list(t.wokenBy).flatMap((e) => (e.task || e.type === "chat_op" ? [{ task: e.task ?? "", type: e.type }] : []));
    const wait = t.wait && { ...t.wait, tasks: list(t.wait.tasks) };
    turns.set(t, out = { ...t, ops: list(t.ops), wokenBy, ...(wait ? { wait } : {}) });
  }
  return out;
}

/** An attempt whose lists are lists; itself when they are. */
const whole = (a: Attempt): Attempt => (a.phases ? a : { ...a, phases: EMPTY });

/** A task: its open attempt says what its agent does right now (the merge agent while it merges,
 *  else the work agent). */
function taskInput(d: RunDetail, t: Task): TimelineTask {
  const attempts = list(t.attempts), a = attempts[attempts.length - 1];
  const open = a && a.endedAt == null;
  const activity = open ? (d.agents[a.agents?.merge ?? ""]?.activity ?? d.agents[a.agents?.work ?? ""]?.activity) || undefined : undefined;
  const had = tasks.get(t);
  if (had && had.activity === activity) return had.out;
  let out: TimelineTask = t;
  if (!t.dependsOn || !t.needsReport || !t.attempts || attempts.some((x) => !x.phases)) { const made: Task = { ...t, dependsOn: list(t.dependsOn), needsReport: list(t.needsReport), attempts: attempts.map(whole) }; out = made; }
  if (activity) out = { ...out, attempts: [...out.attempts.slice(0, -1), { ...out.attempts[out.attempts.length - 1], activity }] };
  tasks.set(t, { activity, out });
  return out;
}

/**
 * The timeline's input for a run's detail. The run starts where its goal was sent (`startedAt`).
 * The same detail object gives the same object back; a new one (every `run_detail` and
 * `run_activity` event makes one) gives a new run in which the turns and tasks that did not
 * change are the objects they were.
 */
export function timelineInput(detail: RunDetail): TimelineRun {
  let out = runs.get(detail);
  if (!out) {
    out = {
      status: detail.status, createdAt: detail.startedAt, endedAt: detail.endedAt, stops: list(detail.stops),
      turns: list(detail.turns).map(turnInput),
      tasks: list(detail.tasks).map((t) => taskInput(detail, t)),
      chatOps: list<Op>(detail.chatOps) satisfies TimelineOp[],
      git: !!detail.git, finishing: !!detail.result,
    };
    runs.set(detail, out);
  }
  return out;
}
