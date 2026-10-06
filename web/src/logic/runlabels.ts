// The run timeline's words: clock times, what a row and a turn bar say to a screen reader, and the
// lines of their tooltips. Also the timeline's input: the layout's run plus the few fields these
// words need. DOM-free. Every time is epoch milliseconds.
import { fmtDuration } from "./subagents.ts";
import {
  STATES, WRITE_OPS, addingTurn, declaredWait, lastAttempt, planUnchanged, rowTier, stoppedMs, taskState, waitEnd,
  type TLAttempt, type TLOp, type TLPhaseKind, type TLRun, type TLRunWait, type TLStop, type TLTask, type TLTurn,
} from "./runtimeline.ts";

// ---- the timeline's input: what the layout reads (runtimeline.ts) plus what is only shown.
// Named as the run's records are; any fuller record is assignable.

export interface TimelineAttempt extends TLAttempt {
  /** What the attempt's agents cost, in dollars; null or left out when they report none. */
  cost?: number | null;
}
export interface TimelineTask extends TLTask {
  title: string;
  /** "fix", "review", "verify", … */
  kind?: string | null;
  /** The task writes code: its result is merged. */
  writes?: boolean | null;
  attempts: TimelineAttempt[];
}
export interface TimelineOp extends TLOp {
  /** On set_notes and edit_notes: the version it wrote. */
  notesVersion?: number | null;
}
export interface TimelineTurn extends TLTurn {
  ops: TimelineOp[];
  cost?: number | null;
}
/** `chatOps`: the changes chats on the run made outside a turn (add_task, update_task, retry_task,
 *  cancel_task), each with the chat that made it. */
export interface TimelineRun extends TLRun { turns: TimelineTurn[]; tasks: TimelineTask[]; chatOps?: TimelineOp[] | null }

/** When a run that is not live ends on the timeline: where it ended or was halted, else the last
 *  moment anything in it has. */
export function runEnd(run: TLRun): number {
  const halted = (run.stops ?? []).find((s) => s.resumedAt == null)?.at;
  return run.endedAt ?? halted ?? lastMoment(run);
}
/** The last moment anything in the run has. A live run's "now" is never before it, whatever this
 *  machine's clock says: what the run already holds must not wait for the clock to be drawn. */
export function lastMoment(run: TLRun): number {
  let t = run.createdAt;
  for (const s of run.stops ?? []) t = Math.max(t, s.resumedAt ?? s.at);
  for (const tn of run.turns) { t = Math.max(t, tn.startedAt, tn.endedAt ?? 0); for (const p of tn.ops) t = Math.max(t, p.t); }
  for (const k of run.tasks) {
    t = Math.max(t, k.createdAt);
    for (const a of k.attempts) { t = Math.max(t, a.endedAt ?? 0); for (const p of a.phases) t = Math.max(t, p.t); }
  }
  return t;
}

// ---- clock times. `tz` is the minutes local time is ahead of UTC; left out, it is the
// browser's zone at that moment.

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The moment shifted so that its UTC fields read as local time. */
const local = (t: number, tz?: number) => new Date(t + (tz ?? -new Date(t).getTimezoneOffset()) * 60000);

/** "01:09" */
export function clockTime(t: number, tz?: number): string {
  const d = local(t, tz);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** A tick of the timeline's ruler: the clock time, and the day at midnight ("6 Oct"). */
export function tickText(t: number, tz?: number): string {
  const d = local(t, tz);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : clockTime(t, tz);
}
/** "5 Oct 2026, 01:09:42", for titles. */
export function dateTime(t: number, tz?: number): string {
  const d = local(t, tz);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// ---- what the run says about each task, beyond the task's own record

export interface TaskFacts {
  /** The tasks that depend on it, in creation order. */
  neededBy: string[];
  /** The turns that changed it (update_task), in order, each once. */
  changedTurns: number[];
  /** When chats changed it outside a turn (update_task), in order; left out when none did. */
  chatChanged?: number[];
}
/** Per task id. Made once per run record, so that a row's words cost no walk over the run. */
export function taskFacts(run: Pick<TimelineRun, "tasks" | "turns" | "chatOps">): Map<string, TaskFacts> {
  const facts = new Map<string, TaskFacts>(run.tasks.map((t) => [t.id, { neededBy: [], changedTurns: [] }]));
  for (const t of run.tasks) for (const d of t.dependsOn) facts.get(d)?.neededBy.push(t.id);
  for (const tn of run.turns) for (const p of tn.ops) {
    const f = p.op === "update_task" && !p.error && p.task ? facts.get(p.task) : undefined;
    if (f && !f.changedTurns.includes(tn.n)) f.changedTurns.push(tn.n);
  }
  for (const p of run.chatOps ?? []) {
    const f = p.op === "update_task" && !p.error && p.task ? facts.get(p.task) : undefined;
    if (f) (f.chatChanged ??= []).push(p.t);
  }
  return facts;
}
const NO_FACTS: TaskFacts = { neededBy: [], changedTurns: [] };

/** "T18–T23, T25": ids in the order given, three or more in a row as a range. */
export function idList(ids: readonly string[]): string {
  const split = (id: string) => { const m = /^(.*?)(\d+)$/.exec(id); return m ? { pre: m[1], n: Number(m[2]) } : null; };
  const out: string[] = [];
  for (let i = 0; i < ids.length;) {
    let j = i;
    for (let a = split(ids[i]); a && j + 1 < ids.length; j++) {
      const b = split(ids[j + 1]);
      if (!b || b.pre !== a.pre || b.n !== a.n + (j + 1 - i)) break;
    }
    if (j - i >= 2) out.push(`${ids[i]}–${ids[j]}`); else for (let k = i; k <= j; k++) out.push(ids[k]);
    i = j + 1;
  }
  return out.join(", ");
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const money = (cost: number | null | undefined) => (typeof cost === "number" ? `$${cost.toFixed(2)}` : "");

/** The state word of a task: the vocabulary's, or "paused" for one whose work a halted run interrupted. */
export const stateWord = (task: TLTask, paused = false): string => (paused ? "paused" : STATES[taskState(task)].word);

/** Why an open task waits, for a label: "starts when turn 14 ends", "starts when the chat's reply
 *  ends", "waiting on T30, T31", "blocked by T26", "ready, no free slot". Empty for a task that
 *  runs or has ended. */
export function waitSentence(task: TLTask): string {
  const a = lastAttempt(task), p = a?.phases[a.phases.length - 1];
  switch (taskState(task)) {
    case "held": {
      if (p?.chat && p.turn == null) return "starts when the chat's reply ends";
      const n = (p?.turn ?? a?.queuedTurn ?? task.addedTurn) || null;
      return n ? `starts when turn ${n} ends` : "starts when the orchestrator's turn ends";
    }
    case "deps": return `waiting on ${(p?.on ?? []).join(", ")}`;
    case "blocked": return `blocked by ${(p?.on ?? []).join(", ")}`;
    case "slot": return "ready, no free slot";
    default: return "";
  }
}

export interface LabelOpts {
  /** The task's work is interrupted: the run is halted. */
  paused?: boolean;
  tz?: number;
}

/**
 * Everything a task's row draws, as one sentence list for its aria-label:
 * "T21, Never re-make a fork, fix, writes code, done. Added in turn 5 at 00:09. Ran 01:00 to
 * 01:08. Depends on T02, T03. Needed by T22, T23."
 */
export function rowLabel(task: TimelineTask, facts: TaskFacts = NO_FACTS, o: LabelOpts = {}): string {
  const at = (t: number) => clockTime(t, o.tz);
  const wait = waitSentence(task);
  const state = taskState(task) === "held" ? `held, ${wait}` : wait || stateWord(task, o.paused);
  const tier = rowTier(task)?.tier;
  const out = [[task.id, task.title, task.kind, task.writes ? "writes code" : "", tier ? `${tier} tier` : "", state].filter(Boolean).join(", ") + "."];
  const turn = addingTurn(task);
  out.push(task.addedBy ? `Added from a chat at ${at(task.createdAt)}.` : turn ? `Added in turn ${turn} at ${at(task.createdAt)}.` : `Added at ${at(task.createdAt)}.`);
  if (facts.changedTurns.length) out.push(`Changed in turn ${facts.changedTurns.join(", ")}.`);
  if (facts.chatChanged?.length) out.push(`Changed from a chat at ${facts.chatChanged.map(at).join(", ")}.`);
  task.attempts.forEach((a, i) => {
    // With several attempts each sentence names its attempt and says how it ended.
    const n = task.attempts.length > 1 ? `Attempt ${a.n} ` : "";
    const say = (words: string) => n + (n ? words : words[0].toUpperCase() + words.slice(1));
    if (a.startedAt != null && a.endedAt != null) out.push(say(`ran ${at(a.startedAt)} to ${at(a.endedAt)}${n && a.outcome ? ", " + a.outcome : ""}.`));
    else if (a.startedAt != null) out.push(say(o.paused ? `ran from ${at(a.startedAt)}, continues on resume.` : `running since ${at(a.startedAt)}.`));
    else if (a.endedAt != null && a.outcome) out.push(say(`${a.outcome} at ${at(a.endedAt)}, never started.`));
    if (a.conflicts?.length) out.push(`Merge conflicts ${a.outcome ? "resolved" : "being resolved"} in ${plural(a.conflicts.length, "file")}.`);
  });
  if (task.dependsOn.length) out.push(`Depends on ${task.dependsOn.join(", ")}${wholeReports(task) ? `; ${wholeReports(task)}` : ""}.`);
  if (facts.neededBy.length) out.push(`Needed by ${facts.neededBy.join(", ")}.`);
  return out.join(" ");
}
/** "full reports of T02, T15": the dependencies whose reports the task's agent is given whole; empty for none. */
const wholeReports = (task: Pick<TLTask, "dependsOn" | "needsReport">): string => {
  const ids = (task.needsReport ?? []).filter((d) => task.dependsOn.includes(d));
  return ids.length ? `full reports of ${idList(ids)}` : "";
};
/** "T03, T05" for a wait for all of its tasks, "any of T07, T09" for a wait for any one. */
const waitWords = (wait: TLRunWait): string => (wait.mode === "any" ? "any of " : "") + idList(wait.tasks);

/** The successful task calls of a turn, by op, its calls that wrote the notes, and its refused calls. */
function callsOf(turn: TimelineTurn) {
  const by = (...ops: string[]) => turn.ops.filter((p) => ops.includes(p.op) && !p.error);
  return {
    added: by("add_task"), changed: by("update_task"), retried: by("retry_task"), cancelled: by("cancel_task"),
    notes: by("set_notes", "edit_notes"), finished: by("finish_run"), refused: turn.ops.filter((p) => p.error),
  };
}

/** A turn bar's aria-label: "Turn 5, 00:03 to 00:14, added 6 tasks, changed 1"; a turn that
 *  started before its wait was met says so and why ("started early: T05 failed"), and one that
 *  ended without a change of the plan "left the plan as it was". `live` tells a turn that is
 *  running from one a halted run left unfinished; `before` is the turn before it, for a turn whose
 *  record does not say what it waited for. */
export function turnLabel(turn: TimelineTurn, o: { live?: boolean; tz?: number; before?: TLTurn | null } = {}): string {
  const at = (t: number) => clockTime(t, o.tz), c = callsOf(turn), start = waitEnd(turn, o.before);
  const when = turn.endedAt != null ? `${at(turn.startedAt)} to ${at(turn.endedAt)}`
    : o.live === false ? `started ${at(turn.startedAt)}, not finished` : `running since ${at(turn.startedAt)}`;
  const did = [
    start.ended === "early" ? `started early${start.cause ? ": " + start.cause : ""}` : "",
    c.added.length ? `added ${plural(c.added.length, "task")}` : "", c.changed.length ? `changed ${c.changed.length}` : "",
    c.retried.length ? `retried ${c.retried.length}` : "", c.cancelled.length ? `cancelled ${c.cancelled.length}` : "",
    c.finished.length ? "finished the run" : "", c.refused.length ? plural(c.refused.length, "refused call") : "",
    turn.status === "failed" ? "failed" : turn.endedAt != null && planUnchanged(turn.ops) ? "left the plan as it was" : "",
  ];
  return [`Turn ${turn.n}`, when, ...did.filter(Boolean)].join(", ");
}

// ---- tooltips

/** A tooltip line: plain text, with the parts to stress as `{ b }`. */
export type TipLine = (string | { b: string })[];
export interface Tip { head: string; lines: TipLine[] }
/** A tooltip line as plain text. */
export const tipText = (line: TipLine): string => line.map((p) => (typeof p === "string" ? p : p.b)).join("");

/** The model and effort of each tier ("deep", "standard", "light"), as they are shown: "Opus 5.5", "Max". */
export type TierNames = Partial<Record<string, { model?: string | null; effort?: string | null }>>;
export interface TipOpts {
  /** The moment an open task or turn is measured up to. */
  now: number;
  /** A task's tooltip: what each tier runs on. Left out, an attempt names its tier alone. */
  tiers?: TierNames | null;
  /** A turn's tooltip: the turn before it, for a turn whose record does not say what it waited for. */
  before?: TLTurn | null;
  paused?: boolean;
  /** The run's stops: durations leave the stopped time out. */
  stops?: TLStop[] | null;
  /** False for a run that is not live: an unfinished turn is not "running". */
  live?: boolean;
  tz?: number;
}

/**
 * The tooltip of a task row:
 *   T15 · fix · deep · done
 *   <title>
 *   Added in turn 3 at 23:58, changed in turn 9, 10
 *   Waited 50m 00s: 9m 09s held, 35m 00s on T13, 6m 21s for a slot
 *   Ran 00:49 → 01:00 (10m 40s) · merged · $2.89 · deep tier (Opus 5.5 · Max)
 *   Depends on T02, T13 (full reports of T02) · needed by T21, T38
 * The head names the task's tier (its latest attempt's); each attempt that started names the tier
 * it ran at, with that tier's model and effort when `o.tiers` gives them.
 */
export function taskTip(task: TimelineTask, facts: TaskFacts = NO_FACTS, o: TipOpts): Tip {
  const at = (t: number) => clockTime(t, o.tz);
  const span = (from: number, to: number) => fmtDuration(Math.max(0, to - from - stoppedMs(o.stops, from, to)));
  const st = taskState(task), open = st !== "done" && st !== "failed" && st !== "cancelled";
  const lines: TipLine[] = [[task.title]];
  const turn = addingTurn(task);
  lines.push([...(task.addedBy ? ["Added from ", { b: "a chat" }, ` at ${at(task.createdAt)}`] : turn ? ["Added in ", { b: `turn ${turn}` }, ` at ${at(task.createdAt)}`] : [`Added at ${at(task.createdAt)}`]),
    facts.changedTurns.length ? `, changed in turn ${facts.changedTurns.join(", ")}` : "",
    facts.chatChanged?.length ? `, changed from a chat at ${facts.chatChanged.map(at).join(", ")}` : ""]);
  task.attempts.forEach((a, i) => {
    const last = i === task.attempts.length - 1, end = a.endedAt ?? o.now;
    // With several attempts each line names its attempt.
    const pre = task.attempts.length > 1 ? `Attempt ${a.n}: ` : "";
    const say = (words: string) => pre + (pre ? words[0].toLowerCase() + words.slice(1) : words);
    // How long it waited, by reason: each phase lasts until the next one or the attempt's end.
    const ms = new Map<TLPhaseKind, number>(), on = new Set<string>(), by = new Set<string>();
    a.phases.forEach((p, k) => {
      const to = Math.min(a.phases[k + 1]?.t ?? end, end);
      ms.set(p.k, (ms.get(p.k) ?? 0) + Math.max(0, to - p.t - stoppedMs(o.stops, p.t, to)));
      for (const d of p.on ?? []) (p.k === "blocked" ? by : on).add(d);
    });
    const waits = ([["held", "held"], ["deps", `on ${[...on].join(", ")}`], ["blocked", `blocked by ${[...by].join(", ")}`], ["slot", "for a slot"]] as const)
      .map(([k, words]) => ({ ms: ms.get(k) ?? 0, words })).filter((w) => w.ms >= 1000);
    if (last && waits.length) {
      const total = fmtDuration(waits.reduce((s, w) => s + w.ms, 0)), sofar = a.startedAt == null && open ? " so far" : "";
      lines.push(waits.length > 1 ? [say("Waited "), { b: total }, `${sofar}: ${waits.map((w) => `${fmtDuration(w.ms)} ${w.words}`).join(", ")}`]
        : [say("Waited "), { b: total }, ` ${waits[0].words}${sofar}`]);
    }
    const names = a.tier ? [o.tiers?.[a.tier]?.model, o.tiers?.[a.tier]?.effort].filter(Boolean).join(" · ") : "";
    const after = [a.outcome === "failed" ? "failed" : a.outcome === "cancelled" ? "cancelled" : "",
      a.mergedAt != null && a.outcome === "done" ? (a.conflicts?.length ? `merged, conflicts resolved in ${plural(a.conflicts.length, "file")}` : "merged") : "", money(a.cost),
      a.tier ? `${a.tier} tier${names ? ` (${names})` : ""}` : ""].filter(Boolean).map((s) => " · " + s).join("");
    if (a.startedAt != null && a.endedAt != null) lines.push([say("Ran "), { b: `${at(a.startedAt)} → ${at(a.endedAt)}` }, ` (${span(a.startedAt, a.endedAt)})${after}`]);
    else if (a.startedAt != null) lines.push([say(o.paused ? "Ran from " : "Running since "), { b: at(a.startedAt) }, ` (${span(a.startedAt, o.now)})${o.paused ? " · continues on resume" : ""}${a.activity && !o.paused ? " · " + a.activity : ""}${after}`]);
    else if (a.endedAt != null && a.outcome) lines.push([say(`${a.outcome[0].toUpperCase() + a.outcome.slice(1)} at `), { b: at(a.endedAt) }, ", never started"]);
  });
  // A held task says what it waits for (its row's text has only the short form): a turn's end, or
  // the end of a chat's reply.
  if (st === "held") { const w = waitSentence(task); lines.push([w[0].toUpperCase() + w.slice(1)]); }
  lines.push(["Depends on ", { b: idList(task.dependsOn) || "nothing" }, wholeReports(task) ? ` (${wholeReports(task)})` : "", " · needed by ", { b: idList(facts.neededBy) || "nothing" }]);
  return { head: [task.id, task.kind, rowTier(task)?.tier, stateWord(task, o.paused)].filter(Boolean).join(" · "), lines };
}

const WOKE: Record<string, string> = { task_done: " ✓", task_failed: " !", task_cancelled: " ✕" };
const REASON: Record<string, string> = { start: "Started by the goal", idle: "Nothing was running and nothing could start", resume: "The run was resumed" };

/**
 * The tooltip of a turn bar:
 *   Turn 5 · 00:03 → 00:14 (11m 23s)
 *   Waited for T03, T05
 *   + T18–T23 · ~ T11
 *   ≡ notes v6
 *   Then waits for any of T18, T19
 * The second line is the wait it started under: "Waited for T03, T05" when that wait was met (and
 * "Woken by T07 ✓" under a wait for any one), "Waited for T03, T05 · started early: T05 failed"
 * when it was not; with no wait, what woke it or why it started. The last line is the wait it
 * declared when it ended.
 */
export function turnTip(turn: TimelineTurn, o: TipOpts): Tip {
  const at = (t: number) => clockTime(t, o.tz), c = callsOf(turn);
  const end = turn.endedAt ?? o.now, took = fmtDuration(Math.max(0, end - turn.startedAt - stoppedMs(o.stops, turn.startedAt, end)));
  const when = turn.endedAt != null ? `${at(turn.startedAt)} → ${at(turn.endedAt)} (${took})`
    : o.live === false ? `started ${at(turn.startedAt)}, not finished` : `running since ${at(turn.startedAt)} (${took})`;
  const lines: TipLine[] = [];
  const woke = turn.wokenBy ?? [];
  // a chat's change is "a chat", as in the feed, whatever task it was about
  const by = [...new Set(woke.map((e) => (e.type === "chat_op" ? "a chat" : e.task ? e.task + (WOKE[e.type ?? ""] ?? "") : "")))].filter(Boolean);
  const start = waitEnd(turn, o.before);
  if (start.wait) {
    lines.push(["Waited for ", { b: waitWords(start.wait) }, start.ended === "early" ? ` · started early${start.cause ? ": " + start.cause : ""}` : ""]);
    if (start.ended === "met" && start.wait.mode === "any" && by.length) lines.push(["Woken by ", { b: by.join(", ") }]);
  } else if (by.length) lines.push(["Woken by ", { b: by.join(", ") }]);
  else if (turn.reason && REASON[turn.reason]) lines.push([REASON[turn.reason]]);
  const ids = (ops: TimelineOp[]) => idList(ops.map((p) => p.task ?? "").filter(Boolean));
  const did = [
    c.added.length ? `${WRITE_OPS.add_task} ${ids(c.added)}` : "", c.changed.length ? `${WRITE_OPS.update_task} ${ids(c.changed)}` : "",
    c.retried.length ? `${WRITE_OPS.retry_task} ${ids(c.retried)}` : "", c.cancelled.length ? `${WRITE_OPS.cancel_task} ${ids(c.cancelled)}` : "",
    c.finished.length ? `${WRITE_OPS.finish_run} finished the run` : "",
  ].filter(Boolean);
  lines.push(did.length ? [{ b: did.join(" · ") }] : [turn.endedAt != null ? "Left the plan as it was" : "No task was added or changed yet"]);
  if (c.notes.length) {
    const last = c.notes[c.notes.length - 1], v = last.notesVersion;
    lines.push([`${WRITE_OPS.set_notes} ${v != null ? `notes v${v}` : last.op === "edit_notes" ? "edited the notes" : "rewrote the notes"}`]);
  }
  for (const p of c.refused) lines.push([`⚠ ${p.op.replace(/_/g, " ")}${p.task ? " " + p.task : ""} was refused`]);
  const then = turn.endedAt != null ? declaredWait(turn) : null;
  if (then) lines.push(["Then waits for ", { b: waitWords(then) }]);
  if (typeof turn.cost === "number") lines.push([money(turn.cost)]);
  return { head: `Turn ${turn.n} · ${when}${turn.status === "failed" ? " · failed" : ""}`, lines };
}
