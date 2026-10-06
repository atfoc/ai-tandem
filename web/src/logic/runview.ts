// The run view's own state and numbers: what is selected and what the dock shows, the transcript
// in the side panel, the order Esc walks back, the dock's height, the meters' values and the texts
// of stop and resume. DOM-free.
// (What a run's row and bar say is logic/run.ts; the timeline's maths is logic/runzoom.ts.)
import type { RunAgent, RunCounts, RunView, RunWait, Stop } from "../types.ts";
import { TASK_STATES } from "../types.ts";
import { runBusy } from "./run.ts";
import { STATES, taskState, type TLTask } from "./runtimeline.ts";
import { clockTime } from "./runlabels.ts";

// ---- the view's state

/** What is selected: a task or a turn. */
export type RunSel = { task: string } | { turn: number } | null;
/** The dock's tabs: four of the run, and one for the selection. */
export type RunTab = "goal" | "notes" | "usage" | "result";
export type DockTab = RunTab | "entity";
/** closed: the tab bar alone; max: over the timeline. */
export type DockState = "closed" | "open" | "max";
/** The tabs of a task in the dock. */
export type TaskTab = "report" | "brief" | "attempts" | "changes" | "history";

export interface ViewState {
  sel: RunSel;
  tab: DockTab;
  /** The run tab to go back to when the entity tab closes. */
  back: RunTab;
  dock: DockState;
  /** The tab the selected task shows: kept while its agents' transcripts are opened and left. */
  taskTab: TaskTab;
}

/** How a run's view opens: a finished run on its result, any other with the dock closed (the
 *  timeline tells a live run's story; the dock is opened by a selection or a tab). */
export const openingView = (status: RunView["status"]): ViewState => {
  const done = status === "completed" || status === "gave_up";
  return { sel: null, tab: done ? "result" : "goal", back: done ? "result" : "goal", dock: done ? "open" : "closed", taskTab: "report" };
};

const shown = (s: DockState): DockState => (s === "closed" ? "open" : s);

/** A task or a turn was selected: its tab, in an open dock. */
export const selectIn = (v: ViewState, sel: NonNullable<RunSel>): ViewState =>
  ({ ...v, sel, tab: "entity", dock: shown(v.dock), taskTab: sameSel(v.sel, sel) ? v.taskTab : "report" });

const sameSel = (a: RunSel, b: RunSel): boolean => a != null && b != null && ("task" in a ? "task" in b && a.task === b.task : "turn" in b && a.turn === b.turn);

/** A tab of the selected task was clicked. */
export const taskTabIn = (v: ViewState, taskTab: TaskTab): ViewState => (v.taskTab === taskTab ? v : { ...v, taskTab });

/** The selection was cleared (the entity tab's ×, a click on empty chart): back to the run's tab. */
export const clearIn = (v: ViewState): ViewState =>
  (v.sel == null ? v : { ...v, sel: null, tab: v.tab === "entity" ? v.back : v.tab, taskTab: "report" });

/** A tab was clicked: it shows, in an open dock. */
export const tabIn = (v: ViewState, tab: DockTab): ViewState =>
  (tab === "entity" && v.sel == null ? v : { ...v, tab, back: tab === "entity" ? v.back : tab, dock: shown(v.dock) });

/** The dock's own buttons. */
export const dockIn = (v: ViewState, dock: DockState): ViewState => ({ ...v, dock });

/** One press of Esc in a run's view (the app's subagent drawer takes its own before): the
 *  transcript in the side panel, then a dock that fills the stage, then the selection, then the
 *  dock. "transcript": the panel's transcript closes and the view stays as it is; null: there is
 *  nothing to step back from. */
export function escIn(v: ViewState, transcript = false): ViewState | "transcript" | null {
  if (transcript) return "transcript";
  if (v.dock === "max") return { ...v, dock: "open" };
  if (v.sel != null) return clearIn(v);
  if (v.dock === "open") return { ...v, dock: "closed" };
  return null;
}

// ---- the side panel: a chat on the run, or the transcript of one of the run's own agents

/** The agent whose transcript the panel beside a run shows (State.runAgent). */
export type RunAgentRef = { run: string; agent: string };
/** The part of the app's state a transcript opens and closes in. */
export type PanelState<D extends { chat: string } = { chat: string; sub: string }> = { runAgent: RunAgentRef | null; subDrawer: D | null };

/** An agent's transcript opens in the panel beside its run, over the chat that shows there. A
 *  subagent drawer of anything else closes. */
export const showAgentIn = <D extends { chat: string }>(s: PanelState<D>, run: string, agent: string): PanelState<D> =>
  (s.runAgent?.run === run && s.runAgent.agent === agent ? s
    : { runAgent: { run, agent }, subDrawer: s.subDrawer?.chat === agent ? s.subDrawer : null });

/** The transcript closes (its ×, Esc, the way back to the chat), with its subagent's drawer. */
export const hideAgentIn = <D extends { chat: string }>(s: PanelState<D>): PanelState<D> =>
  (s.runAgent == null ? s : { runAgent: null, subDrawer: s.subDrawer?.chat === s.runAgent.agent ? null : s.subDrawer });

/** What the panel beside a run shows: an agent's transcript (back: the chat it lies over, which
 *  its foot leads back to; null without one), a chat of the run, or nothing. `chat`: the selected
 *  chat when it is one of this run's; `panel`: the chat panel is not hidden (⌘J). A transcript
 *  shows whether or not the chat panel is hidden. */
export type RunPane = { agent: string; back: string | null } | { chat: string } | null;
export function runPane(run: string, s: { runAgent: RunAgentRef | null; chat: string | null; panel: boolean }): RunPane {
  const chat = s.chat != null && s.panel ? s.chat : null;
  if (s.runAgent?.run === run) return { agent: s.runAgent.agent, back: chat };
  return chat != null ? { chat } : null;
}

/** What the run calls an agent's part, for its transcript's title: "T11 · work agent · attempt 2",
 *  "T02 · merge agent", "Turn 7 · orchestrator". */
export function agentTitle(a: Pick<RunAgent, "name" | "role" | "task" | "attempt" | "turn">): string {
  if (a.role === "orchestrator") return a.turn != null ? `Turn ${a.turn} · orchestrator` : `${a.name} · orchestrator`;
  const who = a.task ?? a.name;
  if (a.role === "merge") return `${who} · merge agent${(a.attempt ?? 1) > 1 ? ` · attempt ${a.attempt}` : ""}`;
  return `${who} · work agent${a.attempt != null ? ` · attempt ${a.attempt}` : ""}`;
}

/** How the run says an agent ended; nothing while it runs (its transcript's header then says what it is doing). */
export const AGENT_ENDED: Record<string, string> = { done: "Done", failed: "Failed", cancelled: "Cancelled", interrupted: "Paused" };

/** How long an agent ran, up to `now` while it runs. An agent a halt interrupted has no end of its own: its last launch has. */
export const agentMs = (a: Pick<RunAgent, "status" | "startedAt" | "endedAt" | "launches">, now: number): number =>
  Math.max(0, (a.endedAt ?? (a.status === "running" ? now : a.launches?.at(-1)?.endedAt ?? a.startedAt)) - a.startedAt);

/** A number of tokens in short: "96k", "1.4M", "800". */
export function tokensShort(n: number): string {
  if (n >= 999_500) return `${(n / 1e6).toFixed(n >= 9_950_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

// ---- the dock's height

export const DOCK_MIN = 140;
/** What the dock leaves of the area it shares with the timeline: its header and a few rows. */
export const DOCK_LEAVES = 132;
/** The open dock's height in an area `area` px high: what the user set (null: 46% of the area),
 *  at least DOCK_MIN and at most the area less DOCK_LEAVES. */
export function dockHeight(want: number | null | undefined, area: number): number {
  const max = Math.max(DOCK_MIN, area - DOCK_LEAVES);
  return Math.round(Math.max(DOCK_MIN, Math.min(want ?? area * 0.46, max)));
}

// ---- meters

/** A run's working time at `now`: it ticks while the run is running or stopping. */
export const workingMs = (r: Pick<RunView, "status" | "activeMs" | "asOf">, now: number): number =>
  r.activeMs + (r.status === "running" || r.status === "stopping" ? Math.max(0, now - r.asOf) : 0);

/** How long the run was stopped in all, an open stop up to `now`. */
export const stoppedTotal = (stops: Stop[] | null | undefined, now: number): number =>
  (stops ?? []).reduce((ms, s) => ms + Math.max(0, (s.resumedAt ?? now) - s.at), 0);

/** "$117.62" */
export const money = (usd: number): string => `$${usd.toFixed(2)}`;
/** A limit in dollars as the user set it: "$200", "$12.50". */
export const moneyLimit = (usd: number): string => `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;

/** A meter's tone by how much of its limit is used: warn from 80%, danger at 100%. */
export const meterTone = (used: number, limit: number): "ok" | "warn" | "danger" =>
  (limit > 0 && used >= limit ? "danger" : limit > 0 && used >= limit * 0.8 ? "warn" : "ok");

/** The slots that are busy, for the slots meter: none while the run is not live. */
export const busySlots = (r: Pick<RunView, "status" | "counts">): number => (r.status === "running" || r.status === "stopping" ? runBusy(r) : 0);

/** The run's task counts for its meters: counted from the detail's tasks when the detail is
 *  loaded, so the meters change in the same frame as the timeline drawn from it (the run's own
 *  counts come at most once a second); the run's own without a detail. */
export function taskCounts(tasks: readonly TLTask[] | null | undefined, fallback: RunCounts): RunCounts {
  if (!tasks) return fallback;
  const out = Object.fromEntries(TASK_STATES.map((k) => [k, 0])) as RunCounts;
  for (const t of tasks) out[taskState(t)]++;
  return out;
}

/** The tasks by state, for the tasks meter's title: "23 done · 4 working · 1 merging · 3 ready · …". */
export function countsTitle(counts: RunCounts): string {
  const words: Record<string, string> = { slot: "ready, no free slot", deps: "waiting on dependencies" };
  return TASK_STATES.filter((k) => counts[k] > 0).sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((k) => `${counts[k]} ${words[k] ?? STATES[k].word}`).join(" · ") || "No tasks yet";
}
const order: string[] = ["done", "work", "merge", "setup", "slot", "deps", "held", "blocked", "failed", "cancelled"];

/** A moment for a banner: the clock time, with the day when that is not today. */
export function whenText(t: number, now: number, tz?: number): string {
  const day = (x: number) => Math.floor((x + (tz ?? -new Date(x).getTimezoneOffset()) * 60000) / 86400000);
  if (day(t) === day(now)) return clockTime(t, tz);
  const d = new Date(t + (tz ?? -new Date(t).getTimezoneOffset()) * 60000);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}, ${clockTime(t, tz)}`;
}

// ---- the bar's status

/** What a running run is at, after its status word in the bar: the turn that runs, else what the
 *  orchestrator waits for ("waiting for T11, T23"; at most three ids, then "+n"), else that it
 *  waits for tasks, and before the first turn that it starts. `d` is the run's detail when it is
 *  loaded: a run that has its result and is still running is finishing (the result is being
 *  applied), and of the wait's tasks those that ended are left out (all are named when none is
 *  open), as the timeline does. */
export function runDoing(
  r: Pick<RunView, "turnRunning" | "turns"> & { wait?: Pick<RunWait, "tasks" | "mode"> | null },
  d?: { result?: unknown; tasks: TLTask[] } | null,
): string {
  if (r.turnRunning) return `turn ${r.turnRunning} deciding`;
  if (d?.result) return "finishing…";
  const all = r.wait?.tasks ?? [];
  const open = d ? all.filter((id) => { const t = d.tasks.find((x) => x.id === id); return !t || !ENDED.has(taskState(t)); }) : all;
  const ids = open.length ? open : all;
  if (ids.length) return `waiting for ${r.wait!.mode === "any" && ids.length > 1 ? "any of " : ""}${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ` +${ids.length - 3}` : ""}`;
  return r.turns ? "waiting for tasks" : "starting";
}

const ENDED = new Set<string>(["done", "failed", "cancelled"]);

// ---- stop and resume

/** How many agents a stop interrupts: the tasks that hold a slot, and the orchestrator's turn. */
export const agentsAtWork = (r: Pick<RunView, "counts" | "turnRunning">): number => runBusy(r) + (r.turnRunning ? 1 : 0);

/** The confirmation of Stop. */
export function stopConfirm(r: Pick<RunView, "counts" | "turnRunning">): { title: string; body: string } {
  const n = agentsAtWork(r);
  const body = n === 0 ? "No agent is working right now. The run does nothing more until you resume it."
    : n === 1 ? "1 agent is working. It is interrupted and continues where it stopped when you resume."
    : `${n} agents are working. They are interrupted and continue where they stopped when you resume.`;
  return { title: "Stop this run?", body };
}

/** The limit a resume has to raise, with the value offered: a run stalled by its turn limit gets
 *  20 more turns (at most 500), one stalled by its cost limit half as much again, rounded up to a
 *  whole dollar. Null when the run resumes as it is (stopped, an error, stalled by idle turns). */
export type Raise = { key: "maxTurns"; value: number; unit: "turns"; was: number } | { key: "maxCost"; value: number; unit: "dollars"; was: number };
export function resumeRaise(r: Pick<RunView, "status" | "stalledBy" | "settings">): Raise | null {
  if (r.status !== "stalled") return null;
  if (r.stalledBy === "turns") return { key: "maxTurns", value: Math.min(500, r.settings.maxTurns + 20), unit: "turns", was: r.settings.maxTurns };
  if (r.stalledBy === "cost") return { key: "maxCost", value: Math.ceil(r.settings.maxCost * 1.5), unit: "dollars", was: r.settings.maxCost };
  return null;
}

/** What the limit field holds, as the value to send; null when it is no number. */
export function raiseValue(key: Raise["key"], typed: string): number | null {
  const n = Number(typed.trim().replace(/^\$/, ""));
  if (!typed.trim() || !Number.isFinite(n)) return null;
  return key === "maxTurns" ? Math.round(n) : Math.round(n * 100) / 100;
}

/** Whether Resume shows for a status. */
export const canResume = (status: RunView["status"]): boolean => status === "stopped" || status === "stalled" || status === "error";

/** The words of a stalled run's limit: "the limit of 60 orchestrator turns". */
export function stalledWords(r: Pick<RunView, "stalledBy" | "settings">): string {
  if (r.stalledBy === "turns") return `the limit of ${r.settings.maxTurns} orchestrator turn${r.settings.maxTurns === 1 ? "" : "s"}`;
  if (r.stalledBy === "cost") return `the cost limit of ${moneyLimit(r.settings.maxCost)}`;
  if (r.stalledBy === "idle") return `${r.settings.maxIdleTurns} idle turn${r.settings.maxIdleTurns === 1 ? "" : "s"} in a row`;
  return "a limit";
}
