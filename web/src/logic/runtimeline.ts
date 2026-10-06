// The run timeline's layout: a run's turns and tasks in, rows / bars / marks / connector paths in
// px out. DOM-free. Every time is epoch milliseconds. x grows to the right from the left edge of
// the chart area (the label column is not part of it); y grows down from the top of the first row
// (the sticky header with the ruler and the orchestrator lane is not part of it).
import { fmtDuration } from "./subagents.ts";

/** The sizes of the timeline, in px. */
export const K = {
  ROW: 22,        // A task row.
  RULER: 20,      // The time ruler.
  LANE: 30,       // The orchestrator lane: the turn bar (14) on top, what the turn did (12) under it.
  TURN_BAR: 14,
  BAR: 10,        // An attempt bar.
  LINE: 2,        // A waiting line.
  MIN_BAR: 3,     // An attempt bar is never narrower.
  MIN_SEG: 2,     // A merge is drawn inside the bar only from this width.
  MERGE_CAP: 3,   // A merge too short to draw still shows as a cap this wide on a bar of 9 px or more.
  PAD_L: 10, PAD_R: 16,
  FUTURE: 150,    // The room right of "now" in a live run, where each open row writes its reason: 28% of
  FUTURE_MIN: 96, // the chart width, at most FUTURE and at least FUTURE_MIN.
  GAP_W: 28,      // A stop → resume break, whatever its length.
  NUM_W: 7,       // Per digit of a turn number inside its bar.
  WAIT_MIN: 4,    // A wait between two turns is drawn from this width.
  WAIT_CH: 6.2,   // Per character of the ids written on a wait.
  WAIT_PAD: 10,   // The room those ids leave free on the line.
  TICK_MIN: 64,   // The minimum px between ruler labels.
};

// ---- the input: only the fields the layout reads, so any fuller run record is assignable.
// An optional field may be left out, undefined or null ("not yet").

export type TLRunStatus = "draft" | "running" | "stopping" | "stopped" | "stalled" | "error" | "completed" | "gave_up";
export type TLTurnStatus = "running" | "done" | "failed";
export type TLPhaseKind = "held" | "deps" | "blocked" | "slot" | "setup" | "work" | "merge";
export type TLOutcome = "done" | "failed" | "cancelled";
/** What a task is doing: the kind of its last phase, or how its last attempt ended. */
export type TLTaskState = TLPhaseKind | TLOutcome;

/** A stop of the run; it is open (the run is halted there) until `resumedAt` is set. */
export interface TLStop { at: number; resumedAt?: number | null; reason?: string | null }
/** The tasks the orchestrator waits for before its next turn: all of them, or any one. */
export interface TLRunWait { tasks: string[]; mode: "all" | "any" }
/** One call of a run tool, by the orchestrator in a turn or by a chat outside one (TLRun.chatOps):
 *  `op` is add_task, update_task, retry_task, cancel_task, set_notes, edit_notes, wait_for,
 *  finish_run or a read (get_run, get_task, get_agent); `i` is its index in the turn (or in
 *  chatOps); a refused call has `error` set; `chat` is the chat that made it. `tier` is the tier a
 *  retry_task (add_task, update_task) gave the task and `attempt` the attempt a retry_task queued;
 *  `tasks` and `mode` are what a wait_for waits for. */
export interface TLOp {
  op: string; t: number; i: number; task?: string | null; error?: string | null; chat?: string | null;
  tier?: string | null; attempt?: number | null; tasks?: string[] | null; mode?: "all" | "any" | null;
}
export interface TLTurn {
  n: number; startedAt: number; endedAt?: number | null; status: TLTurnStatus;
  ops: TLOp[];
  /** The events that started the turn: the task of each, and its `type` (task_done, task_failed,
   *  or chat_op: a chat's change, whatever task it was about). */
  wokenBy?: { task: string; type?: string | null }[] | null;
  /** Why it started: "start", "wait", "events", "idle" or "resume". */
  reason?: string | null;
  /** The wait it started under, and whether that wait was met when it started. */
  wait?: TLRunWait | null; waitMet?: boolean | null;
}
/** A period of an attempt, lasting until the next phase or the attempt's end. `on` is what a
 *  deps or blocked phase waits on, `turn` the turn a held phase waits for, or `chat` the chat whose
 *  reply it waits for. */
export interface TLPhase { k: TLPhaseKind; t: number; on?: string[] | null; turn?: number | null; chat?: string | null }
export interface TLAttempt {
  n: number; queuedTurn: number; phases: TLPhase[];
  startedAt?: number | null; endedAt?: number | null; outcome?: TLOutcome | null;
  mergedAt?: number | null; conflicts?: string[] | null;
  /** The last action of its running agent. */
  activity?: string | null;
  /** The tier it runs on: "deep", "standard" or "light". */
  tier?: string | null;
}
/** `addedTurn` is left out, null or 0 for a task that no turn added. A task a chat added has
 *  `addedBy` (the chat): no turn added it, whatever `addedTurn` says (the latest turn then).
 *  `needsReport` are the dependencies whose reports its agent is given whole; `tier` is its tier;
 *  `writes` is set for a task that writes code. */
export interface TLTask {
  id: string; addedTurn?: number | null; addedBy?: string | null; createdAt: number; dependsOn: string[]; attempts: TLAttempt[];
  needsReport?: string[] | null; tier?: string | null; writes?: boolean | null;
}
/** A run: its tasks in creation order, its turns in order, and the changes chats made outside a
 *  turn (`chatOps`: add_task, update_task, retry_task, cancel_task), in time order. `wait` is what
 *  the orchestrator waits for now (the run view's); left out, the wait its latest turn declared.
 *  `git` is false for a run in a folder without git, where one writing task works at a time;
 *  `finishing` is set once the run has its result (finish_run was accepted) and, while it is still
 *  running, is being applied. */
export interface TLRun {
  status: TLRunStatus; createdAt: number; endedAt?: number | null;
  stops?: TLStop[] | null; turns: TLTurn[]; tasks: TLTask[];
  chatOps?: TLOp[] | null;
  wait?: TLRunWait | null;
  git?: boolean | null; finishing?: boolean | null;
}

// ---- the output

export interface TLAnchor { t: number; x: number }
/** A stop → resume break on the axis. */
export interface TLGap { x1: number; x2: number; from: number; to: number; open: boolean; reason?: string }
/** The horizontal scale: a piecewise-linear map between time and x. */
export interface TLAxis {
  anchors: TLAnchor[];
  x(t: number): number;
  t(x: number): number;
  t0: number; t1: number; x0: number; x1: number;
  /** px per minute of working time. */
  ppm: number;
  /** The room right of "now" (0 when the run is not live). */
  future: number;
  /** The content's width: the viewport's, or more at a fixed zoom. */
  width: number;
  gaps: TLGap[];
}
export interface TLTick { t: number; x: number; step: number }
export interface TLTurnBar {
  n: number; x1: number; x2: number; status: TLTurnStatus;
  /** Where the turn's number goes: inside the bar, right after it, or nowhere. */
  num: "in" | "after" | "none";
  /** What shows under the bar: the `summary` text ("+3 ~ ⚠"), or nothing (it has none, or the next
   *  turn leaves it no room). */
  opsMode: "summary" | "none";
  summary: string;
  /** It ended and left the plan as it was (planUnchanged): its bar is hollow. */
  idle: boolean;
  /** It started before the wait it started under was met, and why: "T05 failed", "a chat changed
   *  the run", "nothing was left running", "resumed"; null when nothing says why. */
  early: boolean; earlyCause: string | null;
}
/** The wait between a finished turn (`after`) and the next one, or now (`open`): a line on the
 *  orchestrator lane from x1 to x2. `tasks` and `mode` are what the orchestrator waited for (no
 *  tasks: it declared no wait); `ended` says how a closed wait with tasks ended (null: open, or no
 *  tasks). `label` is what to write on the line ("T07 T09", "any: T07 T09 T11 +2"), null when it
 *  has no tasks or no room; `numW` is the room the number of the turn before takes at the line's
 *  start (0 when it is not written there): the label is centred in what is left. */
export interface TLLaneWait {
  after: number; x1: number; x2: number; open: boolean;
  mode: "all" | "any"; tasks: string[]; ended: "met" | "early" | null;
  label: string | null; numW: number;
}
/** The text right of "now" on the orchestrator lane of a live run: what the orchestrator waits
 *  for ("waits for T11 and T23"; `turn` and `since` null), or the turn that runs ("turn 14 ·
 *  deciding", with `since` its start and `stopped` as in TLTail). `laneTailSentence` makes the words. */
export interface TLLaneTail { x: number; text: string; turn: number | null; since: number | null; stopped?: number }
/** A waiting line of a row. "queued": held until its turn ends, or ready with no free slot. */
export interface TLWait {
  k: "queued" | "deps" | "blocked"; x1: number; x2: number; attempt: number;
  on?: string[]; from: number; to: number; open: boolean;
}
/** A part of an attempt bar; setting up is part of the work. */
export interface TLPart { k: "work" | "merge"; x1: number; x2: number; attempt: number; from: number; to: number; open: boolean }
/** An attempt bar. `paused`: it is open and the run is not live. `pauses`: the stop breaks it runs
 *  across. `mergeCap`: it merged, but its merge part is too short to draw. */
export interface TLBar {
  k: "bar"; x1: number; x2: number; attempt: number; outcome: TLOutcome | null; open: boolean; paused: boolean;
  parts: TLPart[]; mergeCap: boolean; conflicts: number; pauses: { x1: number; x2: number }[];
}
export type TLSeg = TLWait | TLBar;
/** The short word of a tier, as a row writes it. */
export type TLTierWord = "deep" | "std" | "light";
/** A glyph on a row: ◆ added, ~ changed, ↻ retried (by `turn`; left out: a chat did it outside a
 *  turn), or how an attempt ended (✓ ! ✕, or ‖ paused). `tier` is on a retry that changed the
 *  task's tier: the new one, written after the glyph. */
export interface TLMark {
  kind: "add" | "update" | "retry" | "end"; glyph: string; x: number;
  turn?: number; attempt?: number; outcome?: TLOutcome | "paused";
  tier?: TLTierWord; conflicts?: number; final?: boolean;
}
/** How a dependency stands: done, not finished yet, or failed / cancelled. */
export type TLNeedTone = "done" | "open" | "warn";
/** The needs cell of a row: the ids to write (all of up to three dependencies; of more, the first
 *  two), how many are left out (`more`, written "+n") and the worst tone among those, and the title. */
export interface TLNeeds { ids: { id: string; tone: TLNeedTone }[]; more: number; moreTone: TLNeedTone | null; title: string }
/** The tier of a row: that of its latest attempt, the word a row writes for it, whether an
 *  earlier attempt ran at another tier, and the title ("deep (attempt 1 ran at standard)"). */
export interface TLRowTier { tier: string; word: TLTierWord; mixed: boolean; title: string }
/** Why an open row waits, or what it does. */
export type TLTailReason =
  | { k: "held"; turn: number | null; chat?: boolean }
  | { k: "deps" | "blocked"; on: string[] }
  | { k: "slot"; writer?: boolean }
  | { k: "setup" | "work" }
  | { k: "merge"; conflicts: boolean };
/** The text right of "now" on an open row of a live run, as parts: no elapsed time is baked in, so
 *  it stays the same from one second to the next. `since` is the moment the elapsed time counts
 *  from, null for the sentences that show none (held, waiting on, blocked by); `stopped` is how
 *  long the run was stopped since then (left out when it never was), which the elapsed time leaves
 *  out; `activity` is the working agent's last action. `tailSentence` makes the words. */
export interface TLTail { x: number; tone: "live" | "muted" | "warn"; reason: TLTailReason; since: number | null; stopped?: number; activity?: string }
export interface TLRow {
  id: string;
  /** The turn that added it (null: no turn did), and whether it is the first shown row of its
   *  group: a run of consecutive shown rows added by the same turn. */
  turn: number | null; first: boolean;
  y: number; h: number; state: TLTaskState;
  segs: TLSeg[]; marks: TLMark[];
  /** Where its last mark ends. */
  endX: number;
  paused: boolean; tail: TLTail | null;
  /** What it depends on (null: nothing), and its tier (null: the record names none). */
  needs: TLNeeds | null; tier: TLRowTier | null;
  /** The orchestrator waits for it right now: an open row of the run's current wait. */
  awaited: boolean;
  /** With a task selected: its relation to it, and whether it is outside its chain. */
  sel?: boolean; rel?: "sel" | "dep" | "dependent" | "up" | "down" | null;
  /** With a task or a turn selected. */
  dim?: boolean;
  /** With a turn selected: the glyphs of what it did to the task; `waited`: the turn started under
   *  a wait for it (tag "waited for"); `woke`: its event started the turn, early or with no wait
   *  (tag "woke it"). A row is never both. */
  touched?: string | null; woke?: boolean; waited?: boolean;
}
export type TLEdgeKind = "release" | "waited" | "lineage" | "pending" | "blocked";
/** A connector from a dependency (`from`) to its dependent (`to`). */
export interface TLEdge {
  from: string; to: string; kind: TLEdgeKind; level: "base" | "direct" | "far";
  points: [number, number][]; dot: [number, number] | null; arrow?: [number, number];
}
/** The rows from y1 to y2 that turn `turn` added, and the turn's bar from x1 to x2. */
export interface TLGroup { turn: number; y1: number; y2: number; x1: number; x2: number }
/** Everything a component needs to draw the timeline. */
export interface Layout {
  axis: TLAxis; ticks: TLTick[]; turns: TLTurnBar[]; rows: TLRow[]; edges: TLEdge[];
  /** Each run of consecutive shown rows that one turn added, over that turn's time. */
  groups: TLGroup[];
  /** The waits between the turns, and after the latest one of a live run. */
  waits: TLLaneWait[];
  /** What the lane says right of now; null when the run is not live, is stopping with no turn
   *  running, or has no turn yet. */
  laneTail: TLLaneTail | null;
  /** With a turn selected: the first shown row it added (to scroll into view), else null. */
  selFirst: string | null;
  /** The end line of a run that is not live. */
  end: { x: number; status: TLRunStatus } | null;
  /** The now line of a live run. */
  nowX: number | null;
  width: number; height: number;
}
export interface TLChain { up: Set<string>; down: Set<string>; directUp: Set<string>; directDown: Set<string> }

export interface TLAxisOpts {
  /** px of the chart viewport (the timeline's width without the label column). */
  width: number;
  /** px per minute; null is fit: the whole run fills `width`. */
  ppm?: number | null;
  now: number;
}
/** What to lay out: the scale, the row filter and the selection. */
export interface TLOpts extends TLAxisOpts {
  /** The row filter. */
  only?: ReadonlySet<string> | null;
  selTask?: string | null; selTurn?: number | null;
  /** "auto" draws the whole chain of the selected task, and with no selection only the connectors
   *  that explain timing. */
  deps?: "auto" | "off";
  /** Minutes local time is ahead of UTC, for round clock ticks. */
  tzOffsetMin?: number;
}

const FINAL = new Set<TLTaskState>(["done", "failed", "cancelled"]);
/** The glyph of each call of the orchestrator that changes the run. */
export const WRITE_OPS = { add_task: "+", update_task: "~", retry_task: "↻", cancel_task: "✕", set_notes: "≡", finish_run: "⚑" };
const GLYPHS = new Map<string, string>(Object.entries(WRITE_OPS));
const writeGlyph = (op: string) => GLYPHS.get(op);

/** A live run's clock runs: the timeline has a now line and open rows grow. */
export const isLive = (run: Pick<TLRun, "status">): boolean => run.status === "running" || run.status === "stopping";
/** A task's current attempt; undefined only for a task that has none yet. */
export const lastAttempt = (task: Pick<TLTask, "attempts">): TLAttempt | undefined => task.attempts[task.attempts.length - 1];

/** The turn that added a task; null for one no turn added (a chat did, or nothing says). */
export const addingTurn = (task: Pick<TLTask, "addedTurn" | "addedBy">): number | null => (task.addedBy ? null : task.addedTurn || null);

/** What a task is doing: the kind of its last phase, or how its last attempt ended. */
export function taskState(task: TLTask): TLTaskState {
  const a = lastAttempt(task);
  if (a?.outcome) return a.outcome;
  return a?.phases.length ? a.phases[a.phases.length - 1].k : "held";
}

// ---- what the orchestrator did and waits for

const PLAN_OPS = new Set(["add_task", "update_task", "cancel_task", "retry_task", "finish_run"]);
/** A turn with these calls left the plan as it was: none of them that was not refused added,
 *  changed, cancelled or retried a task, or finished the run. */
export const planUnchanged = (ops: readonly Pick<TLOp, "op" | "error">[]): boolean => !ops.some((p) => !p.error && PLAN_OPS.has(p.op));

/** The wait a turn declared: its last wait_for call that was not refused. Null when it has none
 *  (or one that names no task). */
export function declaredWait(turn: Pick<TLTurn, "ops">): TLRunWait | null {
  for (let i = turn.ops.length - 1; i >= 0; i--) {
    const p = turn.ops[i];
    if (p.op === "wait_for" && !p.error) return p.tasks?.length ? { tasks: p.tasks, mode: p.mode === "any" ? "any" : "all" } : null;
  }
  return null;
}

/** How the wait a turn started under ended: `wait` is that wait (the turn's own record of it, else
 *  what the turn before it, `prev`, declared; null: none), `ended` "met" or "early" (null without a
 *  wait), and `cause` what started an early turn (null when nothing says). */
export interface TLWaitEnd { wait: TLRunWait | null; ended: "met" | "early" | null; cause: string | null }
export function waitEnd(turn: Pick<TLTurn, "wait" | "waitMet" | "reason" | "wokenBy">, prev?: Pick<TLTurn, "ops"> | null): TLWaitEnd {
  const wait = turn.wait?.tasks?.length ? { tasks: turn.wait.tasks, mode: turn.wait.mode } : prev ? declaredWait(prev) : null;
  if (!wait) return { wait: null, ended: null, cause: null };
  return turn.waitMet ? { wait, ended: "met", cause: null } : { wait, ended: "early", cause: earlyCause(turn) };
}
/** What started a turn before its wait was met: "T05 failed", "a chat changed the run", "nothing
 *  was left running", "resumed"; "T03 finished" for an event that is neither; null when nothing says. */
function earlyCause(turn: Pick<TLTurn, "reason" | "wokenBy">): string | null {
  if (turn.reason === "idle") return "nothing was left running";
  if (turn.reason === "resume") return "resumed";
  const woke = turn.wokenBy ?? [];
  const ids = (type: string) => [...new Set(woke.filter((e) => e.type === type && e.task).map((e) => e.task))].join(", ");
  if (ids("task_failed")) return `${ids("task_failed")} failed`;
  if (woke.some((e) => e.type === "chat_op")) return "a chat changed the run";
  return ids("task_done") ? `${ids("task_done")} finished` : null;
}

/** What is written on a wait's line: "T07 T09" for all of them, "any: T07 T09" for any one; at
 *  most three ids, then "+n". */
export function waitLabel(wait: TLRunWait): string {
  const ids = wait.tasks.slice(0, 3), more = wait.tasks.length - ids.length;
  return (wait.mode === "any" ? "any: " : "") + ids.join(" ") + (more > 0 ? ` +${more}` : "");
}
/** What the lane says right of now while no turn runs: "waits for T11 and T23", "waits for any of
 *  T07, T09", or "next turn when a task ends" with no declared wait. At most three ids, then "+n".
 *  (A run that has its result says "finishing…" instead.) */
export function waitText(wait: TLRunWait | null | undefined): string {
  if (!wait?.tasks.length) return "next turn when a task ends";
  const ids = wait.tasks.slice(0, 3), more = wait.tasks.length - ids.length, rest = more > 0 ? ` +${more}` : "";
  if (wait.mode === "any") return `waits for any of ${ids.join(", ")}${rest}`;
  return `waits for ${more > 0 || ids.length < 2 ? ids.join(", ") : ids.slice(0, -1).join(", ") + " and " + ids[ids.length - 1]}${rest}`;
}
/** The lane tail's sentence at `now`: its text, and for a running turn how long it has run
 *  ("turn 14 · deciding 3m 10s"), the time the run was stopped left out. */
export const laneTailSentence = (tail: Pick<TLLaneTail, "text" | "since" | "stopped">, now: number): string =>
  (tail.since == null ? tail.text : `${tail.text} ${fmtDuration(Math.max(0, now - tail.since - (tail.stopped ?? 0)))}`);

// ---- what a row says in its label

const TIER_WORDS: Record<string, TLTierWord> = { deep: "deep", standard: "std", light: "light" };
/** The word a row writes for a tier: "deep", "std" or "light"; undefined for anything else. */
export const tierWord = (tier: string | null | undefined): TLTierWord | undefined => (tier ? TIER_WORDS[tier] : undefined);

/** The tier of a task's row: its latest attempt's (else the task's own), and what its earlier
 *  attempts ran at when that differs. Null for a task whose record names no tier. */
export function rowTier(task: Pick<TLTask, "tier" | "attempts">): TLRowTier | null {
  const tier = lastAttempt(task)?.tier ?? task.tier, word = tierWord(tier);
  if (!tier || !word) return null;
  const other = new Map<string, number[]>(); // Another tier → the attempts that ran at it.
  for (const a of task.attempts.slice(0, -1)) if (a.tier && a.tier !== tier) other.set(a.tier, [...(other.get(a.tier) ?? []), a.n]);
  const ran = [...other].map(([t, ns]) => `attempt${ns.length > 1 ? "s" : ""} ${ns.join(", ")} ran at ${t}`);
  return { tier, word, mixed: ran.length > 0, title: ran.length ? `${tier} (${ran.join(", ")})` : tier };
}

const TONE_RANK: Record<TLNeedTone, number> = { done: 0, open: 1, warn: 2 };
/** The needs cell of a task's row; null for a task that depends on nothing. `by` is the run's tasks
 *  by id (a dependency the run does not have reads as not finished). */
export function needsOf(task: Pick<TLTask, "dependsOn" | "needsReport">, by: ReadonlyMap<string, TLTask>): TLNeeds | null {
  const deps = task.dependsOn;
  if (!deps.length) return null;
  const tone = (id: string): TLNeedTone => {
    const d = by.get(id), st = d ? taskState(d) : null;
    return st === "done" ? "done" : st === "failed" || st === "cancelled" ? "warn" : "open";
  };
  // Three ids fit the cell while they are short ("T03 T18 T21"); of longer ones ("T201") two, then "+1".
  const shown = deps.slice(0, deps.length > 3 || deps.join("").length > 10 ? 2 : 3), rest = deps.slice(shown.length).map(tone);
  const whole = (task.needsReport ?? []).filter((d) => deps.includes(d));
  return {
    ids: shown.map((id) => ({ id, tone: tone(id) })), more: rest.length,
    moreTone: rest.length ? rest.reduce((a, b) => (TONE_RANK[b] > TONE_RANK[a] ? b : a)) : null,
    title: `Needs ${deps.join(", ")}${whole.length ? ` · full reports of ${whole.join(", ")}` : ""}`,
  };
}

// ---- the axis

/**
 * Builds the horizontal scale: linear in time at `ppm` px per minute, with each stop → resume
 * interval as one break of GAP_W. Outside the anchors the map continues with the slope of the
 * nearest segment. A live run ends at `now` and leaves room right of it; any other run ends where
 * it ended or was halted.
 */
export function buildAxis(run: TLRun, { width, ppm = null, now }: TLAxisOpts): TLAxis {
  const live = isLive(run);
  const future = live ? Math.round(Math.max(K.FUTURE_MIN, Math.min(K.FUTURE, width * 0.28))) : 0;
  const halted = (run.stops ?? []).find((s) => !s.resumedAt)?.at;
  const t0 = run.createdAt, t1 = Math.max(live ? now : (run.endedAt ?? halted ?? now), t0 + 1000);
  const stops = (run.stops ?? []).map((s) => ({ a: Math.max(t0, s.at), b: Math.min(t1, s.resumedAt ?? t1), reason: s.reason ?? undefined, open: !s.resumedAt }))
    .filter((s) => s.b > s.a);
  const stopAt = (t: number) => stops.findIndex((s) => t >= s.a && t < s.b);
  const cuts = new Set([t0, t1]);
  for (const s of stops) { cuts.add(s.a); cuts.add(s.b); }
  const ts = [...cuts].filter((t) => t >= t0 && t <= t1).sort((a, b) => a - b);

  // Elementary intervals, each with the block it belongs to: working time, or one of the stops.
  const parts: { a: number; b: number; block: string }[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i], b = ts[i + 1], k = stopAt((a + b) / 2);
    parts.push({ a, b, block: k >= 0 ? "stop:" + k : "run" });
  }
  const active = new Map<string, number>(); // Block → its total duration.
  for (const p of parts) active.set(p.block, (active.get(p.block) ?? 0) + (p.b - p.a));
  let scale: number;
  if (ppm != null) scale = ppm;
  else {
    const room = Math.max(60, width - K.PAD_L - K.PAD_R - future - stops.length * K.GAP_W);
    scale = room / (Math.max(1, active.get("run") ?? 1) / 60000);
  }
  const widthOf = (p: { a: number; b: number; block: string }) =>
    p.block === "run" ? ((p.b - p.a) / 60000) * scale : K.GAP_W * ((p.b - p.a) / active.get(p.block)!);
  const anchors: TLAnchor[] = [{ t: t0, x: K.PAD_L }];
  for (const p of parts) anchors.push({ t: p.b, x: anchors[anchors.length - 1].x + widthOf(p) });
  const seg = (v: number, key: keyof TLAnchor) => { // The segment that holds v, by binary search; the first or last one outside.
    let lo = 0, hi = anchors.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (anchors[m][key] <= v) lo = m; else hi = m - 1; }
    return lo;
  };
  const lerp = (v: number, a: TLAnchor, b: TLAnchor, ka: keyof TLAnchor, kb: keyof TLAnchor) =>
    (b[ka] === a[ka] ? a[kb] : a[kb] + ((v - a[ka]) / (b[ka] - a[ka])) * (b[kb] - a[kb]));
  const x = (t: number) => { const i = seg(t, "t"); return lerp(t, anchors[i], anchors[i + 1], "t", "x"); };
  const t = (px: number) => { const i = seg(px, "x"); return lerp(px, anchors[i], anchors[i + 1], "x", "t"); };
  const x1 = anchors[anchors.length - 1].x;
  return {
    anchors, x, t, t0, t1, x0: K.PAD_L, x1, ppm: scale,
    // (less a hair: a rounding error of the sum must not make the content a pixel wider than its viewport)
    future, width: Math.max(width, Math.ceil(x1 + K.PAD_R + future - 1e-6)),
    gaps: stops.map((s) => ({ x1: x(s.a), x2: x(s.b), from: s.a, to: s.b, open: s.open, reason: s.reason })),
  };
}

const STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
/** Ruler labels: round clock times (in the zone `tzOffsetMin` minutes ahead of UTC), at least
 *  TICK_MIN px apart at the step chosen, none inside a break or under a break's label (the pill
 *  "stopped 6h 00m", about 104 px wide and centred on the break; a tick's label is written right
 *  of its tick). */
export function timeTicks(axis: TLAxis, tzOffsetMin = 0): TLTick[] {
  const step = (STEPS_MIN.find((m) => m * axis.ppm >= K.TICK_MIN) ?? 1440) * 60000;
  const off = tzOffsetMin * 60000, out: TLTick[] = [];
  for (let t = Math.ceil((axis.t0 + off) / step) * step - off; t <= axis.t1; t += step) {
    if (axis.gaps.some((g) => t > g.from && t < g.to)) continue;
    const px = axis.x(t);
    if (axis.gaps.some((g) => px > (g.x1 + g.x2) / 2 - 96 && px < (g.x1 + g.x2) / 2 + 56)) continue;
    if (!out.length || px - out[out.length - 1].x >= K.TICK_MIN * 0.75) out.push({ t, x: px, step });
  }
  return out;
}

// ---- the ruler's pause labels

export interface TLGapLabel { gap: TLGap; x: number; text: string | null }
/** The label of each stop break in the ruler, centred on the break: "app closed 10m 00s", and
 *  where that would run into the label before it the bare duration ("5m 00s"), then its first
 *  part ("5m"); when even that has no room the label before it is shortened the same way, and
 *  only a label no shortening makes room for is left out (null). Widths are estimated: 10 px
 *  text in a pill with 14 px of padding and border ("app closed 10m 00s" is 111 px, "5m" 29). */
export function gapLabels(gaps: readonly TLGap[]): TLGapLabel[] {
  const width = (text: string) => text.length * 5.6 + 16, SPACE = 4;
  const forms = (g: TLGap) => { const d = fmtDuration(g.to - g.from); return [...new Set([`${g.reason === "app_quit" ? "app closed" : "stopped"} ${d}`, d, d.split(" ")[0]])]; };
  const out: (TLGapLabel & { forms: string[]; i: number })[] = [];
  let prev: (typeof out)[number] | null = null;
  for (const gap of gaps) {
    const x = (gap.x1 + gap.x2) / 2, f = forms(gap), cur = { gap, x, text: null as string | null, forms: f, i: -1 };
    const fits = (mine: string, theirs: string | null) => !prev || theirs == null || x - width(mine) / 2 >= prev.x + width(theirs) / 2 + SPACE;
    let i = f.findIndex((text) => fits(text, prev?.text ?? null));
    if (i < 0 && prev) { // the shortest form beside a shorter form of the label before it
      const j = prev.forms.findIndex((text, k) => k > prev!.i && fits(f[f.length - 1], text));
      if (j >= 0) { prev.i = j; prev.text = prev.forms[j]; i = f.length - 1; }
    }
    if (i >= 0) { cur.i = i; cur.text = f[i]; prev = cur; }
    out.push(cur);
  }
  return out.map(({ gap, x, text }) => ({ gap, x, text }));
}

// ---- dependencies

/** Everything the task needs (up) and everything that needs it (down), direct and through others. */
export function chainOf(run: Pick<TLRun, "tasks">, id: string): TLChain {
  const by = new Map(run.tasks.map((t) => [t.id, t]));
  const walk = (start: string, next: (id: string) => string[]) => {
    const seen = new Set<string>(), todo = [start];
    while (todo.length) for (const n of next(todo.pop()!)) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    return seen;
  };
  const needs = (x: string) => by.get(x)?.dependsOn ?? [];
  const neededBy = (x: string) => run.tasks.filter((t) => t.dependsOn.includes(x)).map((t) => t.id);
  return { up: walk(id, needs), down: walk(id, neededBy), directUp: new Set(needs(id)), directDown: new Set(neededBy(id)) };
}

/** Where the rows the task has direct edges to lie from its own row, of the rows that are listed:
 *  "above", "below", or null when there are none or they are on both sides. */
export function relatedSide(run: Pick<TLRun, "tasks">, rows: ReadonlyMap<string, Pick<TLRow, "y">>, id: string): "above" | "below" | null {
  const own = rows.get(id);
  if (!own) return null;
  const c = chainOf(run, id);
  let above = false, below = false;
  for (const o of [...c.directUp, ...c.directDown]) { const r = rows.get(o); if (r && r.y < own.y) above = true; else if (r && r.y > own.y) below = true; }
  return above === below ? null : above ? "above" : "below";
}

/** How one dependency relates to the timing of the task that has it:
 *  release — the task waited on it and it was the last to finish; waited — the task waited on it;
 *  lineage — it was done before the task was added (an input, never a wait);
 *  pending — not finished yet; blocked — it failed or was cancelled. */
export function edgeKind(task: TLTask, dep: TLTask): TLEdgeKind {
  const st = taskState(dep);
  if (st === "failed" || st === "cancelled") return "blocked";
  if (st !== "done") return "pending";
  const waits = (lastAttempt(task)?.phases ?? []).filter((p) => p.k === "deps");
  if (!waits.some((p) => p.on?.includes(dep.id))) return "lineage";
  const last = waits[waits.length - 1].on ?? [];
  return last.length === 1 && last[0] === dep.id ? "release" : "waited";
}

// ---- the layout

/**
 * Lays the whole timeline out: the axis and its ticks, one bar per turn on the orchestrator lane
 * with the waits between them and what the lane says right of now, one row per task (in creation
 * order, grouped by the turn that added it, filtered by `only`) with the block of each group, the
 * rows a selected task or turn leaves bright, and the connectors.
 */
export function layoutTimeline(run: TLRun, opts: TLOpts): Layout {
  const o = { ppm: null, only: null, selTask: null, selTurn: null, deps: "auto", ...opts };
  const axis = buildAxis(run, o);
  const X = axis.x, live = isLive(run), now = axis.t1;
  const by = new Map(run.tasks.map((t) => [t.id, t]));
  const turnBy = new Map(run.turns.map((t) => [t.n, t]));

  // The orchestrator lane.
  const shownTurns = run.turns.filter((t) => t.startedAt <= now);
  const bars = shownTurns.map((t, i) => {
    const x1 = X(t.startedAt), x2 = Math.max(x1 + K.MIN_BAR, X(Math.min(t.endedAt ?? now, now)));
    const shown = t.ops.filter((p) => p.t <= now);
    // (the server halts a run on an error before it ends the turn that failed: the halt is "now", the turn's end a moment later)
    const status: TLTurnStatus = t.status === "failed" ? "failed" : t.endedAt && t.endedAt <= now ? t.status : "running";
    const start = waitEnd(t, shownTurns[i - 1]);
    return { n: t.n, x1, x2, status, summary: opsSummary(shown), idle: status === "done" && planUnchanged(shown), early: start.ended === "early", earlyCause: start.cause, start };
  });
  const turns = bars.map(({ start: _start, ...t }, i): TLTurnBar => {
    const nextX = bars[i + 1]?.x1 ?? Infinity;
    // What it did, as one text under the bar, when the next turn leaves it the room.
    const opsMode = t.summary && t.summary.length * 6 <= nextX - t.x1 - 4 ? "summary" : "none";
    // Its number: inside the bar when it fits, else right after it when the next turn leaves room.
    const numW = String(t.n).length * K.NUM_W;
    const num = t.x2 - t.x1 >= numW + 6 ? "in" : nextX - t.x2 >= numW + 6 ? "after" : "none";
    return { ...t, opsMode, num };
  });

  // The waits: one per gap between a turn that ended and the next one, or now in a live run. What
  // the orchestrator waited for is what the next turn says it started under, else what the turn
  // declared; for the gap that is open, what the run says it waits for now.
  const lastBar = turns[turns.length - 1], lastTurn = shownTurns[shownTurns.length - 1];
  const between = live && lastBar?.status === "done"; // No turn runs: the orchestrator is between two turns.
  const declared = lastTurn ? declaredWait(lastTurn) : null;
  const current: TLRunWait | null = between ? (run.wait?.tasks?.length ? { tasks: run.wait.tasks, mode: run.wait.mode } : declared) : null;
  const waits: TLLaneWait[] = [];
  turns.forEach((b, i) => {
    const next = turns[i + 1];
    if (b.status === "running" || (!next && !live)) return;
    const x1 = b.x2, x2 = next ? next.x1 : X(now);
    if (x2 - x1 < K.WAIT_MIN) return;
    const end = next ? bars[i + 1].start : null, wait = next ? end!.wait : (current ?? declared);
    // The number written after a short bar takes its room on the line first.
    const numW = b.num === "after" ? String(b.n).length * K.NUM_W + 2 : 0;
    const text = wait ? waitLabel(wait) : "";
    waits.push({
      after: b.n, x1, x2, open: !next, mode: wait?.mode ?? "all", tasks: wait?.tasks ?? [], ended: end?.ended ?? null,
      label: text && text.length * K.WAIT_CH <= x2 - x1 - K.WAIT_PAD - numW ? text : null, numW,
    });
  });
  // Right of now: the turn that runs, or what the orchestrator waits for. Of the tasks of its wait
  // only those still open are named (and marked on their rows), all of them when none is.
  const isOpen = (id: string) => { const t = by.get(id); return !t || !FINAL.has(taskState(t)); };
  const awaited = new Set((current?.tasks ?? []).filter((id) => run.status === "running" && isOpen(id)));
  let laneTail: TLLaneTail | null = null;
  if (live && lastBar?.status === "running") {
    const stopped = stoppedMs((run.stops ?? []).filter((s) => s.resumedAt != null), lastTurn.startedAt, Infinity);
    laneTail = { x: X(now) + 16, text: `turn ${lastBar.n} · deciding`, turn: lastBar.n, since: lastTurn.startedAt, ...(stopped > 0 ? { stopped } : {}) };
  } else if (between && run.status === "running") {
    // (with its result the run has no next turn: the result is being applied to the folder)
    laneTail = { x: X(now) + 16, text: run.finishing ? "finishing…" : waitText(current && awaited.size ? { ...current, tasks: [...awaited] } : current), turn: null, since: null };
  }

  // Rows: the tasks in creation order, never moved. A group is a run of consecutive shown rows
  // added by the same turn; its first row carries the turn's number.
  const rows: TLRow[] = [], rowOf = new Map<string, TLRow>();
  let y = 0;
  for (const t of run.tasks) {
    if (o.only && !o.only.has(t.id)) continue;
    const n = addingTurn(t), prev = rows[rows.length - 1];
    const row: TLRow = {
      id: t.id, turn: n, first: !prev || prev.turn !== n, y, h: K.ROW, state: taskState(t), ...taskRow(run, t, axis, now, live),
      needs: needsOf(t, by), tier: rowTier(t), awaited: awaited.has(t.id),
    };
    rows.push(row); rowOf.set(t.id, row); y += K.ROW;
  }
  // Each group that a turn on the lane added, over that turn's time.
  const groups: TLGroup[] = [], barOf = new Map(turns.map((b) => [b.n, b]));
  for (const r of rows) {
    const b = r.turn != null ? barOf.get(r.turn) : undefined;
    if (!b) continue;
    if (r.first) groups.push({ turn: b.n, y1: r.y, y2: r.y + r.h, x1: b.x1, x2: b.x2 });
    else groups[groups.length - 1].y2 = r.y + r.h;
  }

  // The selection: which rows stay bright, and their tags.
  let chain: TLChain | null = null, selFirst: string | null = null;
  if (o.selTask && by.has(o.selTask)) {
    chain = chainOf(run, o.selTask);
    for (const r of rows) {
      r.sel = r.id === o.selTask;
      r.rel = r.sel ? "sel" : chain.directUp.has(r.id) ? "dep" : chain.directDown.has(r.id) ? "dependent" : chain.up.has(r.id) ? "up" : chain.down.has(r.id) ? "down" : null;
      r.dim = !r.rel;
    }
  } else if (o.selTurn != null && turnBy.has(o.selTurn)) {
    const touched = new Map<string, string>(); // Task → the glyphs of what the turn did to it.
    for (const p of turnBy.get(o.selTurn)?.ops ?? []) {
      const g = writeGlyph(p.op);
      if (p.task && g && !p.error) touched.set(p.task, (touched.get(p.task) ?? "") + g);
    }
    // The rows of the wait it started under are "waited for"; a row whose event started it is
    // "woke it", unless that event is the very thing the wait was for and met it.
    const tn = turnBy.get(o.selTurn)!, start = waitEnd(tn, run.turns[run.turns.indexOf(tn) - 1]);
    const waited = new Set(start.wait?.tasks ?? []), woke = new Set((tn.wokenBy ?? []).map((e) => e.task));
    for (const r of rows) {
      r.touched = touched.get(r.id) ?? null;
      r.woke = woke.has(r.id) && !(start.ended === "met" && waited.has(r.id));
      r.waited = waited.has(r.id) && !r.woke;
      r.dim = !r.touched && !r.woke && !r.waited;
    }
    selFirst = rows.find((r) => r.turn === o.selTurn)?.id ?? null;
  }

  // The connectors.
  const edges: TLEdge[] = [];
  if (o.deps !== "off") for (const t of run.tasks) for (const d of t.dependsOn) {
    const dep = by.get(d), rt = rowOf.get(t.id), rd = rowOf.get(d);
    if (!dep || !rt || !rd || rt === rd) continue;
    const kind = edgeKind(t, dep);
    let level: TLEdge["level"] | null = null;
    if (chain) {
      const inUp = chain.up.has(d) && (t.id === o.selTask || chain.up.has(t.id));
      const inDown = chain.down.has(t.id) && (d === o.selTask || chain.down.has(d));
      if (inUp || inDown) level = t.id === o.selTask || d === o.selTask ? "direct" : "far";
    } else if (kind === "release" || kind === "pending" || kind === "blocked") level = "base";
    if (level) edges.push({ from: d, to: t.id, kind, level, ...edgePath(dep, t, rd, rt, axis, now) });
  }

  return {
    axis, ticks: timeTicks(axis, o.tzOffsetMin ?? 0), turns, rows, edges, groups, waits, laneTail, selFirst,
    end: live ? null : { x: axis.x1, status: run.status }, nowX: live ? axis.x1 : null, width: axis.width, height: y,
  };
}

/**
 * The connectors of one task alone, for the row under the pointer: from each of its dependencies
 * and to each task that depends on it, where both rows are shown (`rows`: the layout's), all at
 * the level "direct". `axis` and `now` are the layout's (`now` is its axis.t1).
 */
export function directEdges(run: Pick<TLRun, "tasks">, rows: readonly TLRow[], axis: TLAxis, id: string, now: number): TLEdge[] {
  const by = new Map(run.tasks.map((t) => [t.id, t])), rowOf = new Map(rows.map((r) => [r.id, r]));
  const me = by.get(id), mine = rowOf.get(id), out: TLEdge[] = [];
  if (!me || !mine) return out;
  const edge = (dep: TLTask | undefined, task: TLTask) => {
    const rd = dep && rowOf.get(dep.id), rt = rowOf.get(task.id);
    if (dep && rd && rt && rd !== rt) out.push({ from: dep.id, to: task.id, kind: edgeKind(task, dep), level: "direct", ...edgePath(dep, task, rd, rt, axis, now) });
  };
  for (const d of new Set(me.dependsOn)) edge(by.get(d), me);
  for (const t of run.tasks) if (t.dependsOn.includes(id)) edge(me, t);
  return out;
}

/** "+3 ~ ⚠" for a turn: its successful task calls, and its refused ones. Notes are left out. */
export function opsSummary(ops: Pick<TLOp, "op" | "error">[]): string {
  const n: Record<string, number> = {};
  for (const p of ops) { const g = p.error ? "⚠" : writeGlyph(p.op); if (g) n[g] = (n[g] ?? 0) + 1; }
  return ["+", "~", "↻", "✕", "⚑", "⚠"].filter((g) => n[g]).map((g) => (n[g] > 1 || g === "+" ? g + n[g] : g)).join(" ");
}

/** One task's row: per attempt the waiting lines and the bar, the orchestrator's marks, the end
 *  caps, and for an open row of a live run the text written right of "now". */
function taskRow(run: TLRun, task: TLTask, axis: TLAxis, now: number, live: boolean): Pick<TLRow, "segs" | "marks" | "endX" | "paused" | "tail"> {
  const X = axis.x, segs: TLSeg[] = [], marks: TLMark[] = [];
  marks.push({ kind: "add", glyph: "◆", x: X(task.createdAt), turn: addingTurn(task) ?? undefined });
  // What the orchestrator did to the task in a turn, and what a chat did outside one: the same
  // glyphs (a chat's have no turn).
  const mark = (p: TLOp, turn?: number) => {
    if (p.task !== task.id || p.error || p.t > now) return;
    if (p.op === "update_task") marks.push({ kind: "update", glyph: WRITE_OPS.update_task, x: X(p.t), ...(turn != null ? { turn } : {}) });
    else if (p.op === "retry_task") {
      const tier = retryTier(task, p);
      marks.push({ kind: "retry", glyph: WRITE_OPS.retry_task, x: X(p.t), ...(turn != null ? { turn } : {}), ...(tier ? { tier } : {}) });
    }
  };
  for (const tn of run.turns) for (const p of tn.ops) mark(p, tn.n);
  for (const p of run.chatOps ?? []) mark(p);
  let endX = X(task.createdAt);
  task.attempts.forEach((a, ai) => {
    const lastA = ai === task.attempts.length - 1;
    const stop = a.endedAt ?? (lastA ? now : null);
    const ended = a.endedAt != null && a.endedAt <= now;
    const ph = a.phases.filter((p) => p.t <= now);
    let bar: TLBar | null = null, barFrom = Infinity;
    for (let i = 0; i < ph.length; i++) {
      const p = ph[i], from = p.t, to = Math.min(ph[i + 1]?.t ?? stop ?? p.t, now);
      const open = !a.endedAt && i === ph.length - 1;
      // A phase of no length is dropped, but not the one the task is in: begun at this very moment,
      // it is what the row is doing (a working bar of MIN_BAR, a waiting line yet to grow).
      if (to <= from && !(open && lastA)) continue;
      const s = { x1: X(from), x2: X(to), attempt: a.n, from, to, open };
      if (p.k === "held" || p.k === "slot") {
        // Held and "no slot" are one line: queued. Two in a row are one segment.
        const prev = segs[segs.length - 1];
        if (prev && prev.k === "queued" && prev.attempt === a.n && prev.to === from) { prev.x2 = s.x2; prev.to = to; prev.open = open; }
        else segs.push({ k: "queued", ...s });
        continue;
      }
      if (p.k === "deps" || p.k === "blocked") {
        segs.push({ k: p.k, ...s, on: p.on ?? undefined });
        continue;
      }
      if (!bar) {
        bar = { k: "bar", x1: s.x1, x2: s.x2, attempt: a.n, parts: [], outcome: a.outcome && ended ? a.outcome : null, open: s.open, paused: false, mergeCap: false, conflicts: 0, pauses: [] };
        barFrom = from;
      }
      // Setting up is part of the work: the bar has a work part and, once it merges, a merge part.
      const k = p.k === "merge" ? "merge" : "work", part = bar.parts[bar.parts.length - 1];
      if (part && part.k === k) { part.x2 = s.x2; part.to = to; part.open = open; }
      else bar.parts.push({ k, ...s });
      bar.x2 = s.x2; bar.open = s.open; bar.paused = s.open && !live;
    }
    if (bar) {
      if (bar.x2 - bar.x1 < K.MIN_BAR) bar.x2 = bar.x1 + K.MIN_BAR;
      const total = bar.x2 - bar.x1;
      bar.parts = bar.parts.filter((p) => p.k === "work" || p.x2 - p.x1 >= K.MIN_SEG);
      bar.mergeCap = !!a.mergedAt && a.mergedAt <= now && !bar.parts.some((p) => p.k === "merge") && total >= 9;
      bar.conflicts = a.conflicts?.length ?? 0;
      // The stops the bar runs across: those that began while the attempt ran.
      bar.pauses = axis.gaps.filter((g) => g.from >= barFrom && g.from < (a.endedAt ?? now)).map((g) => ({ x1: g.x1, x2: g.x2 }));
      segs.push(bar); endX = bar.x2;
    }
    if (a.outcome && ended) {
      const x = bar ? bar.x2 : X(a.endedAt!);
      marks.push({ kind: "end", outcome: a.outcome, glyph: a.outcome === "done" ? "✓" : a.outcome === "failed" ? "!" : "✕", x, attempt: a.n, conflicts: a.conflicts?.length ?? 0, final: lastA });
      endX = Math.max(endX, x);
    } else if (!bar && segs.length) endX = Math.max(endX, segs[segs.length - 1].x2);
  });
  const paused = segs.some((g) => g.k === "bar" && g.paused);
  const tail = live ? tailOf(task, run.stops, writerBusy(run, task)) : null;
  if (!live && paused && !FINAL.has(taskState(task))) marks.push({ kind: "end", outcome: "paused", glyph: "‖", x: endX });
  return { segs, marks, endX, paused, tail: tail && { x: X(now) + 16, ...tail } };
}

/** The tier a retry gave the task, when it is another than the attempt before ran at: the call's
 *  own tier (else that of the attempt it queued) against the tier of the attempt before that one.
 *  The attempt it queued is the one the call names, else the first one that began at or after it. */
function retryTier(task: TLTask, p: TLOp): TLTierWord | undefined {
  const i = p.attempt != null ? task.attempts.findIndex((a) => a.n === p.attempt) : task.attempts.findIndex((a, k) => k > 0 && (a.phases[0]?.t ?? Infinity) >= p.t);
  const before = task.attempts[i - 1]?.tier, tier = p.tier ?? task.attempts[i]?.tier;
  return i > 0 && before && tier && tier !== before ? tierWord(tier) : undefined;
}

/** The connector from a dependency's row to its dependent's: down (or up) from where the dependency
 *  ended, then along the dependent's row to where it was added when that is later. An unfinished
 *  dependency is tied to its dependent by a bracket just right of "now". */
function edgePath(dep: TLTask, task: TLTask, rd: TLRow, rt: TLRow, axis: TLAxis, now: number): Pick<TLEdge, "points" | "dot" | "arrow"> {
  const yd = rd.y + rd.h / 2, yt = rt.y + rt.h / 2, dir = yt > yd ? 1 : -1;
  if (!FINAL.has(taskState(dep))) { const x = axis.x(now); return { points: [[x + 3, yd], [x + 9, yd], [x + 9, yt], [x + 3, yt]], dot: null }; }
  const xe = rd.marks.filter((m) => m.kind === "end").pop()?.x ?? axis.x(lastAttempt(dep)?.endedAt ?? now);
  const xa = axis.x(task.createdAt), y0 = yd + dir * (K.BAR / 2 + 1);
  // (also when it ended a few px before: an elbow that short puts its arrowhead on its own trunk, which reads as "✕")
  if (xe >= xa - 10) return { points: [[xe, y0], [xe, yt]], dot: [xe, yt] };
  return { points: [[xe, y0], [xe, yt], [xa - 5, yt]], dot: null, arrow: [xa - 5, yt] };
}

// ---- words

/** How long the run was stopped between two moments: the part of [from, to] inside its
 *  stop → resume intervals (a stop that is still open lasts until `to`). */
export function stoppedMs(stops: TLStop[] | null | undefined, from: number, to: number): number {
  let ms = 0;
  for (const s of stops ?? []) ms += Math.max(0, Math.min(to, s.resumedAt ?? to) - Math.max(from, s.at));
  return ms;
}

/** In a run without git only one writing task works at a time: whether `task` writes and another
 *  writing task of the run is at work (setting up, working or merging). */
export const writerBusy = (run: Pick<TLRun, "git" | "tasks">, task: TLTask): boolean =>
  run.git === false && !!task.writes && run.tasks.some((t) => t !== task && t.writes && ["setup", "work", "merge"].includes(taskState(t)));

/** What the text after an open task's row says, without its position: why the task waits, or what
 *  it does and since when. Null for a task that is done, failed or cancelled. With the run's
 *  `stops`, the elapsed time leaves out the time the run was stopped since then. `writer` (see
 *  writerBusy): a ready task waits for the other writing task, not for a slot. */
export function tailOf(task: TLTask, stops?: TLStop[] | null, writer = false): Omit<TLTail, "x"> | null {
  const st = taskState(task);
  if (st === "done" || st === "failed" || st === "cancelled") return null;
  const a = lastAttempt(task), p = a?.phases[a.phases.length - 1];
  const from = p?.t ?? task.createdAt;
  // Only the stops that are over count: while one is open the run is not live and shows no tail.
  const timed = (since: number) => {
    const stopped = stoppedMs((stops ?? []).filter((s) => s.resumedAt != null), since, Infinity);
    return stopped > 0 ? { since, stopped } : { since };
  };
  switch (st) {
    case "held":
      if (p?.chat && p.turn == null) return { tone: "muted", reason: { k: st, turn: null, chat: true }, since: null };
      return { tone: "muted", reason: { k: st, turn: (p?.turn ?? a?.queuedTurn ?? task.addedTurn) || null }, since: null };
    case "deps": return { tone: "muted", reason: { k: st, on: p?.on ?? [] }, since: null };
    case "blocked": return { tone: "warn", reason: { k: st, on: p?.on ?? [] }, since: null };
    case "slot": return { tone: "muted", reason: writer ? { k: st, writer } : { k: st }, ...timed(from) };
    case "setup": return { tone: "live", reason: { k: st }, ...timed(from) };
    case "merge": return { tone: "live", reason: { k: st, conflicts: !!a?.conflicts?.length }, ...timed(from) };
    case "work": return { tone: "live", reason: { k: st }, ...timed(a?.startedAt ?? from), ...(a?.activity ? { activity: a.activity } : {}) };
  }
}

/** The sentence of a row's tail at `now`: "after turn 14" (a held task starts when that turn ends),
 *  "after the chat's reply", "waiting on T30, T31", "blocked by T26", "42m 00s · ready, no slot"
 *  ("42m 00s · ready, waits for the other writing task" in a run without git),
 *  "12s · setting up", "22m 00s · <last action>", "3m 00s · merging", "3m 00s · resolving
 *  conflicts". The room right of now is 96 to 150 px: the part that changes comes first, so that
 *  it is what stays when the sentence is cut. */
export function tailSentence(tail: Pick<TLTail, "reason" | "since" | "stopped" | "activity">, now: number): string {
  const r = tail.reason, since = fmtDuration(Math.max(0, now - (tail.since ?? now) - (tail.stopped ?? 0)));
  switch (r.k) {
    case "held": return r.chat ? "after the chat's reply" : r.turn ? `after turn ${r.turn}` : "after the orchestrator's turn";
    case "deps": return `waiting on ${r.on.join(", ")}`;
    case "blocked": return `blocked by ${r.on.join(", ")}`;
    case "slot": return `${since} · ready, ${r.writer ? "waits for the other writing task" : "no slot"}`;
    case "setup": return `${since} · setting up`;
    case "merge": return `${since} · ${r.conflicts ? "resolving conflicts" : "merging"}`;
    case "work": return since + (tail.activity ? " · " + tail.activity : "");
  }
}

/** One vocabulary for every place a task state shows: glyph, word, colour token. */
export const STATES: Record<TLTaskState, { glyph: string; word: string; tone: "faint" | "muted" | "warn" | "ok" | "danger"; says?: string; pulse?: boolean }> = {
  held: { glyph: "◌", word: "held", tone: "faint", says: "starts when its turn ends" },
  deps: { glyph: "○", word: "waiting", tone: "muted", says: "waiting on dependencies" },
  blocked: { glyph: "⊘", word: "blocked", tone: "warn", says: "a dependency failed or was cancelled" },
  slot: { glyph: "◎", word: "ready", tone: "muted", says: "ready, waiting for a free slot" },
  setup: { glyph: "●", word: "setting up", tone: "ok", pulse: true },
  work: { glyph: "●", word: "working", tone: "ok", pulse: true },
  merge: { glyph: "●", word: "merging", tone: "ok", pulse: true },
  done: { glyph: "✓", word: "done", tone: "ok" },
  failed: { glyph: "!", word: "failed", tone: "danger" },
  cancelled: { glyph: "✕", word: "cancelled", tone: "faint" },
};

// ---- the legend

/** What a legend entry shows before its words: a swatch the drawing makes from the timeline's own
 *  marks. `glyph` is the text of the samples that are text. */
export type TLLegendSample =
  | "turn" | "turn-idle" | "turn-early"        // a turn bar: filled, hollow, with the early edge
  | "add" | "marks" | "wait" | "await"         // the block and ◆ of an adding turn; ~ ↻ ✕; the dotted wait line; the awaited dot
  | "queued" | "deps" | "blocked"              // a row's waiting lines
  | "working" | "merged" | "failed" | "paused" // attempt bars
  | "release" | "warn";                        // the connector from a dependency; ⚠
export interface TLLegendItem { sample: TLLegendSample; glyph?: string; text: string }
/** The legend: two headed groups of lines, each line one or more entries (joined with " · "). */
export interface TLLegendGroup { head: string; lines: TLLegendItem[][] }
export const LEGEND: TLLegendGroup[] = [
  { head: "Orchestrator", lines: [
    [{ sample: "turn", text: "a turn" }, { sample: "turn-idle", text: "one that changed nothing" }],
    [{ sample: "turn-early", text: "one that started before its wait was met" }],
    [{ sample: "add", glyph: "◆", text: "the turn that added the task, and when" }],
    [{ sample: "marks", glyph: `${WRITE_OPS.update_task} ${WRITE_OPS.retry_task} ${WRITE_OPS.cancel_task}`, text: "it changed · retried · cancelled the task" }],
    [{ sample: "wait", text: "waiting for tasks" }, { sample: "await", text: "a task it waits for" }],
  ] },
  { head: "Tasks", lines: [
    [{ sample: "queued", text: "queued" }],
    [{ sample: "deps", text: "waiting on what it needs" }, { sample: "blocked", text: "blocked" }],
    [{ sample: "working", text: "working" }, { sample: "merged", text: "done, merged" }, { sample: "failed", text: "failed" }, { sample: "paused", glyph: "‖", text: "paused" }],
    [{ sample: "release", text: "the dependency whose end let it start" }],
    [{ sample: "warn", glyph: "⚠", text: "refused call · merge conflict" }],
  ] },
];
