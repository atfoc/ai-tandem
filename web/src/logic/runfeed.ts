// What a run's detail says in words: one sentence per call of a run tool, and what the dock's
// views say about a turn (why it started, what it waits for), an attempt's phases, an agent's
// launches and tokens, a merge's rounds, a task's history and a version of the notes. DOM-free.
// Every time is epoch ms.
import type { Attempt, CatalogModel, ModelChoice, Op, RunAgent, RunDetail, RunEvent, Stop, TokenCount, Turn } from "../types.ts";
import { WRITE_OPS, declaredWait, planUnchanged, stoppedMs, taskState, waitEnd } from "./runtimeline.ts";
import { effortLabel } from "./labels.ts";
import { clockTime } from "./runlabels.ts";
import { money } from "./runview.ts";
import { fmtDuration } from "./subagents.ts";

// ---- one call of a run tool, as a sentence

/** A part of a sentence: plain text, a task's id (a view makes it a link), or a name that is
 *  set apart (a section of the notes). */
export type OpPart = string | { task: string } | { em: string };
/** A call as a line: its glyph, who made it or how it went (`tone`: the orchestrator, a chat, a
 *  refused call, a read), the sentence in parts, and what follows it after " · " (a reason, the
 *  refusal, the notes version). */
export interface OpLine { glyph: string; tone: "orch" | "chat" | "warn" | "muted"; parts: OpPart[]; note?: string }

const GLYPHS = new Map<string, string>([...Object.entries(WRITE_OPS), ["edit_notes", WRITE_OPS.set_notes]]); // an edit of the notes is a write of them
const CHANGED: Record<string, string> = { title: "title", brief: "brief", kind: "kind", writes: "whether it writes code", depends_on: "dependencies", tier: "tier", tier_reason: "reason for the tier", needs_report: "full reports" };
const words = (op: string) => op.replace(/_/g, " ");
const ids = (list: string[]): OpPart[] => list.flatMap((id, i): OpPart[] => (i ? [", ", { task: id }] : [{ task: id }]));

/** "all of " or "any of " before the tasks of a wait; nothing before a single one. */
const modeOf = (w: { tasks: string[]; mode?: "all" | "any" }): string => (w.tasks.length > 1 ? (w.mode === "any" ? "any of " : "all of ") : "");

/** What the call did, without who did it; `notes`: the version of the notes it wrote. `self`: said
 *  in the task's own history, where the task is "it" and its title is known: "added it at deep ←
 *  T03", "changed: brief (rev 2), dependencies (now T02)". */
function did(op: Op, self = false): { parts: OpPart[]; note?: string; notes?: number } {
  const tier = op.tier ? ` at ${op.tier}` : "";
  const notes = op.notesVersion != null ? { notes: op.notesVersion } : {};
  const task: OpPart[] = self ? [] : op.task ? [" ", { task: op.task }] : [];
  if (op.error) return { parts: [words(op.op), ...task, " was refused"], note: op.error };
  if (self) {
    const list = (l: string[]): OpPart[] => (l.length ? [" (now ", ...ids(l), ")"] : [" (now none)"]);
    const now = (c: string): OpPart[] => (c === "depends_on" && op.dependsOn ? list(op.dependsOn) : c === "needs_report" ? list(op.needsReport ?? [])
      : c === "tier" && op.tier ? [` (now ${op.tier})`] : c === "brief" && op.briefRev != null ? [` (rev ${op.briefRev})`] : []);
    if (op.op === "add_task") return { parts: ["added it" + tier, ...(op.dependsOn?.length ? [" ← ", ...ids(op.dependsOn)] : [])], note: op.tierReason };
    if (op.op === "update_task") return { parts: ["changed", ...(op.changed?.length ? [": ", ...op.changed.flatMap((c, i): OpPart[] => [i ? ", " : "", CHANGED[c] ?? c, ...now(c)])] : [])] };
    if (op.op === "get_task") return { parts: ["looked at it"] };
  }
  switch (op.op) {
    case "add_task": return { parts: ["added", ...task, tier, op.title ? (tier ? ": " : " ") + op.title : "", ...(op.dependsOn?.length ? [" ← ", ...ids(op.dependsOn)] : [])], note: op.tierReason };
    case "update_task": return { parts: ["changed", ...task, op.changed?.length ? ": " + op.changed.map((c) => CHANGED[c] ?? c).join(", ") : ""] };
    case "retry_task": return { parts: ["retried", ...task, tier, op.attempt ? ` (attempt ${op.attempt})` : ""], note: op.reason };
    case "cancel_task": return { parts: ["cancelled", ...task], note: op.reason };
    case "set_notes": return { parts: ["rewrote the notes"], ...notes };
    case "edit_notes": return { parts: ["edited notes", ...(op.heading ? [" § ", { em: sectionName(op.heading) }] : [])], ...notes };
    case "wait_for": return { parts: [op.tasks?.length ? `waits for ${modeOf({ tasks: op.tasks, mode: op.mode })}` : "waits for nothing", ...ids(op.tasks ?? [])] };
    case "finish_run": return { parts: [`finished the run: ${op.outcome === "achieved" ? "achieved" : op.outcome === "not_achieved" ? "not achieved" : op.outcome ?? "done"}`] };
    case "tell_orchestrator": return { parts: ["told the orchestrator"], note: op.text };
    case "get_run": return { parts: ["looked at the run"] };
    case "get_task": return { parts: ["looked at", ...(task.length ? task : [" a task"])] };
    case "get_agent": return { parts: [`looked at agent ${op.agent ?? ""}`.trimEnd()] };
    case "get_notes": return { parts: ["looked at the notes"] };
    default: return { parts: [words(op.op), ...task] };
  }
}

/** A chat's call that was refused, after "a chat's": "retry of T01 was refused". */
const NOUN: Record<string, string> = { add_task: "new task", update_task: "change of", retry_task: "retry of", cancel_task: "cancel of", set_notes: "notes", edit_notes: "notes edit", wait_for: "wait", finish_run: "finish", tell_orchestrator: "message" };
const refusedOf = (op: Op): OpPart[] => [NOUN[op.op] ?? words(op.op), ...(op.task ? [" ", { task: op.task }] : []), " was refused"];

/** A section of the notes as it is named: its heading without the marks of one ("## Plan"). */
export const sectionName = (heading: string): string => heading.replace(/^#+\s*/, "").trim();

/** A call of a run tool as a line: "added T18 at deep: <title> ← T03 · <why that tier>", "changed
 *  T11: dependencies", "retried T41 at deep (attempt 2) · <reason>", "cancelled T29 · <reason>",
 *  "edited notes § Decisions → v12", "rewrote the notes → v13", "waits for all of T18, T19",
 *  "finished the run: achieved", "finish run was refused · <message>". A call a chat made outside
 *  a turn (it has `chat`) reads "a chat added T18 …", and one that was refused "a chat's retry of
 *  T01 was refused". */
export function opLine(op: Op): OpLine {
  const d = did(op), write = GLYPHS.get(op.op);
  const parts = [...(op.chat ? (op.error ? ["a chat's ", ...refusedOf(op)] : ["a chat ", ...d.parts]) : d.parts), ...(d.notes != null ? [` → v${d.notes}`] : [])].filter((p) => p !== "");
  return {
    glyph: op.error ? "⚠" : write ?? (op.op === "tell_orchestrator" ? "→" : "·"),
    tone: op.error ? "warn" : op.chat ? "chat" : write ? "orch" : "muted",
    parts, ...(d.note ? { note: d.note } : {}),
  };
}

/** The same as one string. */
export function opSentence(op: Op): string {
  const l = opLine(op);
  return l.parts.map((p) => (typeof p === "string" ? p : "task" in p ? p.task : p.em)).join("") + (l.note ? " · " + l.note : "");
}

/** Whether the call changed the run or was refused: what a turn's list of calls shows one by one
 *  (reads are folded). */
export const isWrite = (op: Op): boolean => !!op.error || GLYPHS.has(op.op) || op.op === "tell_orchestrator";

// ---- what a halted run interrupted

/** The tasks a halted run interrupted: they continue on resume. */
export const interrupted = (d: RunDetail): string[] =>
  d.tasks.filter((t) => { const s = taskState(t); return s === "setup" || s === "work" || s === "merge"; }).map((t) => t.id);

// ---- when an open thing is measured

/** Whether the run's clock runs. A run that is not live can still hold records that look live (a
 *  turn with status running, a task in its work phase): nothing of it ticks or reads as live. */
export const runLive = (d: Pick<RunDetail, "status">): boolean => d.status === "running" || d.status === "stopping";

/** The moment the run's open turns and attempts are measured up to: `now` while it is live, else
 *  where it was halted (its open stop) or where it ended. */
export function measuredAt(d: Pick<RunDetail, "status" | "stops" | "endedAt">, now: number): number {
  if (runLive(d)) return now;
  return (d.stops ?? []).findLast((s) => s.resumedAt == null)?.at ?? d.endedAt ?? now;
}

/** How long the run worked between two moments: the stopped time is left out. */
export const workedMs = (stops: Stop[] | null | undefined, from: number, to: number): number => Math.max(0, to - from - stoppedMs(stops, from, to));

// ---- an attempt's phases, in one line

/**
 * Where an attempt's time went: "held 2m 00s · waited 35m 00s on T13 · 6m 21s for a slot · setup 4s
 * · work 10m 40s · merge 2s". Each kind once, in the order it first came, its phases summed; a wait
 * under a second is left out. An open attempt is measured up to `now`, or up to the run's open stop
 * when `stops` has one (a halted run); the time the run was stopped is left out.
 */
export function phaseLine(a: Pick<Attempt, "phases" | "endedAt">, now: number, stops?: Stop[] | null): string {
  const halted = (stops ?? []).findLast((s) => s.resumedAt == null)?.at;
  const end = a.endedAt ?? Math.min(now, halted ?? now);
  const sums = new Map<string, { ms: number; on: string[] }>();
  (a.phases ?? []).forEach((p, i) => {
    const to = Math.min(a.phases[i + 1]?.t ?? end, end);
    const s = sums.get(p.k) ?? { ms: 0, on: [] };
    s.ms += workedMs(stops, p.t, Math.max(p.t, to));
    for (const id of p.on ?? []) if (!s.on.includes(id)) s.on.push(id);
    sums.set(p.k, s);
  });
  const out: string[] = [];
  for (const [k, s] of sums) {
    const d = fmtDuration(s.ms), on = s.on.join(", ");
    if (k === "setup" || k === "work" || k === "merge") out.push(`${k} ${d}`);
    else if (s.ms < 1000) continue;
    else if (k === "held") out.push(`held ${d}`);
    else if (k === "deps") out.push(`waited ${d}${on ? ` on ${on}` : ""}`);
    else if (k === "blocked") out.push(`blocked ${d}${on ? ` by ${on}` : ""}`);
    else if (k === "slot") out.push(`${d} for a slot`);
  }
  return out.join(" · ");
}

// ---- an agent's launches

/** The error of a launch whose session could not be resumed: the next launch starts over. It is
 *  no failure of the agent's and is not counted as a restart. */
const NO_SESSION = "no session";

/** What a launch after the first one is. restart: the launch before it failed (`k`: which restart
 *  this is; `why`: that failure); continued: the launch before it was stopped with the run (or the
 *  app quit) and this one went on after the resume; fresh: the launch before it could not resume
 *  the agent's session, so this one started over. */
export interface LaunchNote { n: number; t: number; kind: "restart" | "continued" | "fresh"; k?: number; why?: string }

/** One note per launch of the agent after its first. */
export function launchNotes(a: Pick<RunAgent, "launches">): LaunchNote[] {
  const out: LaunchNote[] = [];
  let k = 0;
  (a.launches ?? []).forEach((l, i, all) => {
    if (i === 0) return;
    const before = all[i - 1].error;
    if (!before) out.push({ n: l.n, t: l.startedAt, kind: "continued" });
    else if (before === NO_SESSION) out.push({ n: l.n, t: l.startedAt, kind: "fresh" });
    else out.push({ n: l.n, t: l.startedAt, kind: "restart", k: ++k, why: before });
  });
  return out;
}

/** A launch note in words: "restarted (1 of 2)" (`retries`: the run's agentRetries), "continued
 *  after the run was resumed", "started over: its session could not be resumed". */
export function launchWords(n: LaunchNote, retries?: number): string {
  if (n.kind === "continued") return "continued after the run was resumed";
  if (n.kind === "fresh") return "started over: its session could not be resumed";
  return `restarted (${n.k}${retries ? ` of ${retries}` : ""})`;
}

// ---- a merge's rounds

const roundOf = (a: Pick<RunAgent, "name">): number => Number(/-r(\d+)$/.exec(a.name)?.[1] ?? 1);

/** The merge agents of an attempt, one per merge round, in round order ("T03-merge",
 *  "T03-merge-r2", "T03-merge-r3"). The attempt's own record names only the latest one (`latest`:
 *  its id, counted in even when its record says less). */
export function mergeAgents(d: Pick<RunDetail, "agents">, task: string, attempt: number, latest?: string): RunAgent[] {
  return Object.values(d.agents ?? {})
    .filter((a) => a.id === latest || (a.role === "merge" && a.task === task && a.attempt === attempt))
    .sort((a, b) => roundOf(a) - roundOf(b) || a.startedAt - b.startedAt);
}

// ---- a turn in words

const chips = (list: string[]): FeedPart[] => list.flatMap((id, i): FeedPart[] => (i ? [" ", { task: id }] : [{ task: id }]));

/** The events that started a turn, in words: "T05 failed", "T03, T04 finished", "a chat changed
 *  the run", joined by ", ". */
function wokeCause(events: RunEvent[] | null | undefined): FeedPart[] {
  const woke = events ?? [];
  const of = (type: string, word: string): FeedPart[] => {
    const list = [...new Set(woke.filter((e) => e.type === type && e.task).map((e) => e.task!))];
    return list.length ? [...list.flatMap((id, i): FeedPart[] => (i ? [", ", { task: id }] : [{ task: id }])), " " + word] : [];
  };
  const groups = [of("task_failed", "failed"), of("task_done", "finished"), woke.some((e) => e.type === "chat_op") ? ["a chat changed the run"] : []].filter((g) => g.length);
  return groups.flatMap((g, i): FeedPart[] => (i ? [", ", ...g] : g));
}

/**
 * Why a turn started, in one sentence: "The goal"; "Resumed"; "Waited for all of T03 T05: met at
 * 17:06" (the time is a part); "Waited for any of T03 T05: started early, T05 failed" (the cause as
 * the timeline says it: a failed task, "a chat changed the run", "nothing was left running"); "No
 * wait declared: T03 finished"; "Nothing was running and nothing could start". The wait is the
 * turn's own record of it, else what the turn before it, `prev`, declared (the timeline's rule).
 */
export function turnStart(turn: Pick<Turn, "reason" | "idle" | "wait" | "waitMet" | "wokenBy" | "startedAt">, prev?: Pick<Turn, "ops"> | null): FeedPart[] {
  if (turn.reason === "start") return ["The goal"];
  if (turn.reason === "resume") return ["Resumed"];
  // (the events as the timeline takes them: a task's id, "" for a chat's)
  const w = waitEnd({ ...turn, wokenBy: (turn.wokenBy ?? []).map((e) => ({ task: e.task ?? "", type: e.type })) }, prev);
  if (w.wait) {
    const head: FeedPart[] = [`Waited for ${modeOf(w.wait)}`, ...chips(w.wait.tasks)];
    return w.ended === "met" ? [...head, ": met at ", { at: turn.startedAt }] : [...head, `: started early${w.cause ? ", " + w.cause : ""}`];
  }
  if (turn.reason === "idle" || (turn.idle && !(turn.wokenBy ?? []).length)) return ["Nothing was running and nothing could start"];
  const cause = wokeCause(turn.wokenBy);
  return cause.length ? ["No wait declared: ", ...cause] : ["No wait declared"];
}

/** What a turn left behind when it ended: "finished the run" (a finish_run call that was not
 *  refused), else "waits for all of T18 T19" (its last wait_for call that was not refused); null
 *  when neither. */
export function turnThen(turn: Pick<Turn, "ops">): FeedPart[] | null {
  const ops = turn.ops ?? [];
  if (ops.some((p) => p.op === "finish_run" && !p.error)) return ["finished the run"];
  const wait = declaredWait({ ops });
  return wait ? [`waits for ${modeOf(wait)}`, ...chips(wait.tasks)] : null;
}

/** What stands beside the title of a turn that ended without changing the plan (no call that was
 *  not refused added, changed, cancelled or retried a task, or finished the run): "left the plan
 *  as it was · $0.42", the cost left out when it is not known. Null for any other turn. */
export function turnKept(turn: Pick<Turn, "status" | "ops">, cost: number | null | undefined): string | null {
  if (turn.status !== "done" || !planUnchanged(turn.ops ?? [])) return null;
  return "left the plan as it was" + (typeof cost === "number" ? " · " + money(cost) : "");
}

/** What a turn read, each thing once, in the order it first read it: "T03, T05, the run, the
 *  notes, agent T03-work" as parts (after "looked at "). Empty when it read nothing. */
export function turnReads(turn: Pick<Turn, "ops">): OpPart[] {
  const seen = new Set<string>(), out: OpPart[] = [];
  for (const op of turn.ops ?? []) {
    if (isWrite(op) || op.op === "wait_for") continue; // a wait is no read
    const what: OpPart = op.op === "get_task" && op.task ? { task: op.task } : op.op === "get_run" ? "the run" : op.op === "get_notes" ? "the notes" : op.op === "get_agent" ? `agent ${op.agent ?? ""}`.trimEnd() : words(op.op);
    const key = typeof what === "string" ? what : "task " + what.task;
    if (seen.has(key)) continue;
    seen.add(key);
    if (out.length) out.push(", ");
    out.push(what);
  }
  return out;
}

// ---- lines the dock's views draw

/** A part of a line: plain text, or something a view draws its own way: a task, a turn, a chat on
 *  the run (its name when the client knows the chat, else "a chat"), a notes version ("v6"), a
 *  name that is set apart, a moment (a clock time). */
export type FeedPart = string | { task: string } | { turn: number } | { chat: string } | { notes: number } | { em: string } | { at: number };

/** A line's parts as plain text: a chat reads "a chat", a moment as its clock time (`tz`: minutes
 *  east of UTC, else the local zone). */
export const partsText = (parts: FeedPart[], tz?: number): string =>
  parts.map((p) => (typeof p === "string" ? p : "task" in p ? p.task : "turn" in p ? `Turn ${p.turn}` : "chat" in p ? "a chat" : "notes" in p ? `v${p.notes}` : "em" in p ? p.em : clockTime(p.at, tz))).join("");

/** A call of a run tool as a line of a turn's list: as opLine, with the chat that made it and the
 *  notes version it wrote ("→ v12") as parts a view can link. */
export function callLine(op: Op): { glyph: string; tone: OpLine["tone"]; parts: FeedPart[]; note?: string } {
  const l = opLine(op), d = did(op);
  const parts: FeedPart[] = (op.chat ? (op.error ? [{ chat: op.chat }, "'s ", ...refusedOf(op)] : [{ chat: op.chat }, " ", ...d.parts]) : [...d.parts]).filter((p) => p !== "");
  if (d.notes != null) parts.push(" → ", { notes: d.notes });
  return { glyph: l.glyph, tone: l.tone, parts, ...(d.note ? { note: d.note } : {}) };
}

// ---- a task's history

/** One call on a task: who made it (a turn, or a chat outside a turn) and what it did, said
 *  without the task's id ("changed: brief (rev 2)", "retried (attempt 2)", "looked at it"). */
export interface HistoryRow { key: string; t: number; turn: number | null; chat: string | null; glyph: string; tone: OpLine["tone"]; parts: FeedPart[]; note?: string }

/** Every call on the task, by the orchestrator in its turns and by chats on the run, oldest
 *  first; refused calls and reads included. */
export function taskHistory(d: Pick<RunDetail, "turns" | "chatOps">, task: string): HistoryRow[] {
  const out: HistoryRow[] = [];
  const row = (op: Op, key: string, turn: number | null) => {
    const l = opLine(op), s = did(op, true);
    out.push({ key, t: op.t, turn, chat: op.chat ?? null, glyph: l.glyph, tone: op.error ? "warn" : op.chat ? "chat" : l.tone, parts: s.parts.filter((p) => p !== ""), ...(s.note ? { note: s.note } : {}) });
  };
  for (const tn of d.turns ?? []) for (const op of tn.ops ?? []) if (op.task === task) row(op, `t${tn.n}.${op.i}`, tn.n);
  for (const op of d.chatOps ?? []) if (op.task === task) row(op, `c${op.i}`, null);
  return out.map((r, i) => ({ r, i })).sort((a, b) => a.r.t - b.r.t || a.i - b.i).map((x) => x.r);
}

// ---- a version of the notes

/** What made a version of the notes: an edit of one section or a rewrite of the whole, and who
 *  made it (a turn, or a chat outside a turn). */
export interface NotesChange { kind: "edit" | "rewrite"; heading?: string; turn?: number; chat?: string }

/** The set_notes or edit_notes call that wrote version `v`, looked for in the turns' calls and in
 *  the chats'; null when the run records none. */
export function notesChange(d: Pick<RunDetail, "turns" | "chatOps">, v: number): NotesChange | null {
  const made = (op: Op) => (op.op === "set_notes" || op.op === "edit_notes") && !op.error && op.notesVersion === v;
  const say = (op: Op, who: { turn?: number; chat?: string }): NotesChange =>
    ({ kind: op.op === "edit_notes" ? "edit" : "rewrite", ...(op.op === "edit_notes" && op.heading ? { heading: sectionName(op.heading) } : {}), ...who });
  for (const tn of d.turns ?? []) for (const op of tn.ops ?? []) if (made(op)) return say(op, { turn: tn.n });
  for (const op of d.chatOps ?? []) if (made(op)) return say(op, op.chat ? { chat: op.chat } : {});
  return null;
}

/** The line of a version of the notes: "v12 · turn 9 edited § Decisions", "v13 · turn 10 rewrote
 *  the notes", "v5 · a chat rewrote the notes"; without the call that made it, "v3 · written in
 *  turn 4" from the version's own record. */
export function notesLine(n: { v: number; turn?: number; chat?: string }, change: NotesChange | null): FeedPart[] {
  if (!change) return [`v${n.v} · written`, ...(n.chat ? [" from ", { chat: n.chat }] : n.turn != null ? [` in turn ${n.turn}`] : [])];
  const turn = change.turn ?? n.turn, chat = change.chat ?? n.chat;
  const who: FeedPart[] = chat ? [{ chat }, " "] : turn != null ? [`turn ${turn} `] : [];
  const what: FeedPart[] = change.kind === "rewrite" ? [who.length ? "rewrote the notes" : "the notes were rewritten"]
    : change.heading ? [who.length ? "edited § " : "edit of § ", { em: change.heading }] : [who.length ? "edited a section" : "a section was edited"];
  return [`v${n.v} · `, ...who, ...what];
}

// ---- what an agent ran on and used

/** A model and effort in the catalogue's words: "Opus 5.5 · Max"; a model it does not know shows
 *  its id, one with no effort only the model. */
export function choiceLabel(c: Partial<ModelChoice> | null | undefined, models: readonly CatalogModel[] = []): string {
  if (!c?.model) return "";
  const m = models.find((x) => x.id === c.model), effort = effortLabel(c.effort, m);
  return (m?.label ?? c.model) + (effort ? " · " + effort : "");
}

/** A count of tokens: "950", "400k", "1.4M". */
export function fmtTokens(n: number): string {
  const v = Math.max(0, Math.round(n));
  if (v < 1000) return String(v);
  if (v < 999_500) return `${Math.round(v / 1000)}k`;
  return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

/** What an agent used: "in 41k · out 18k · cache 2.1M read / 160k written · peak 96k". The tokens
 *  are left out when the agent kind reports none, the peak when it is not known; "" for neither. */
export function tokenLine(a: { tokens?: TokenCount | null; peakContext?: number }): string {
  const t = a.tokens, f = fmtTokens;
  return [...(t ? [`in ${f(t.in)}`, `out ${f(t.out)}`, `cache ${f(t.cacheRead)} read / ${f(t.cacheWrite)} written`] : []), ...(a.peakContext ? [`peak ${f(a.peakContext)}`] : [])].join(" · ");
}

// ---- a file of an attempt's changes

/** A renamed file, from the path git's numstat prints: "old.ts => new.ts", or with the shared
 *  part outside braces, "web/src/{conn.ts => connection.ts}". Null for a path that is no rename. */
export function renameOf(path: string): { from: string; to: string } | null {
  const braces = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(path);
  const tidy = (p: string) => p.replace(/\/{2,}/g, "/");
  if (braces) return { from: tidy(braces[1] + braces[2] + braces[4]), to: tidy(braces[1] + braces[3] + braces[4]) };
  const plain = /^(.+) => (.+)$/.exec(path);
  return plain ? { from: plain[1], to: plain[2] } : null;
}
