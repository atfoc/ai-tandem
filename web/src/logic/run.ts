// A run as the sidebar and the page shell see it, from its light view (RunView): whether it works,
// what its row says, and whether its goal can be sent. DOM-free. What the follow view shows of a
// run (turns, tasks, the timeline) is not here.
import { TIERS, type ChatView, type RunSettings, type RunStatus, type RunTiers, type RunView } from "../types.ts";
import { isWorking } from "./status.ts";
import { deliveryWord } from "./rundelivery.ts";

type Lived = Pick<RunView, "status" | "archived">;
type Counted = Pick<RunView, "counts">;
type RunChat = Pick<ChatView, "id" | "created" | "run" | "role" | "archived" | "status" | "subsRunning" | "subsOwed" | "working">;

/** The goal was not sent yet: the stage shows the goal composer. */
export const isDraft = (r: Pick<RunView, "started">): boolean => !r.started;

/** The run has agents at work or is about to start some: archiving, deleting and a restart stop it. */
export const runWorking = (r: Lived): boolean => !r.archived && (r.status === "running" || r.status === "stopping");

/** How many runs a restart interrupts. */
export const runningRuns = (runs: Iterable<Lived>): number => {
  let n = 0;
  for (const r of runs) if (runWorking(r)) n++;
  return n;
};

/** The run's tasks, cancelled ones left out. */
export const runTaskTotal = (r: Counted): number => {
  const c = r.counts;
  return c.held + c.deps + c.blocked + c.slot + c.setup + c.work + c.merge + c.done + c.failed;
};

/** The tasks that are done. */
export const runTasksDone = (r: Counted): number => r.counts.done;

/** The tasks that hold a slot now: in setup, at work or merging. */
export const runBusy = (r: Counted): number => r.counts.setup + r.counts.work + r.counts.merge;

/** Newest first; the id breaks ties. */
const newestFirst = (a: { created: string; id: string }, b: { created: string; id: string }) =>
  a.created < b.created ? 1 : a.created > b.created ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** The chats the user made on a run, newest first; the run's own agents are never among them. */
export function runChats<C extends RunChat>(chats: Record<string, C>, runId: string, showArchived: boolean): C[] {
  return Object.values(chats).filter((c) => c.run === runId && !c.role && (showArchived || !c.archived)).sort(newestFirst);
}

/** The user's chats on a run that work (logic/status.ts isWorking), archived ones left out: the
 *  ones a run's archive and delete confirmations warn about. */
export function workingRunChats<C extends RunChat>(chats: Record<string, C>, runId: string): C[] {
  return runChats(chats, runId, false).filter((c) => isWorking(c));
}

/** The run works, or an agent works in one of the user's chats on it. */
export const workingOnRun = (r: Lived & Pick<RunView, "id">, chats: Record<string, RunChat>): boolean =>
  runWorking(r) || workingRunChats(chats, r.id).length > 0;

const WORDS: Record<RunStatus, string> = {
  draft: "Not started", running: "Running", stopping: "Stopping…", stopped: "Stopped",
  stalled: "Stalled", error: "Error", completed: "Completed", gave_up: "Gave up",
};

/** The status in a word. */
export const runWord = (r: Pick<RunView, "status">): string => WORDS[r.status] ?? r.status;

/** The dot on a run's sidebar icon, as a name of the chat rows' vocabulary (.crow-dot.st-*); null
 *  for none. */
export function runDot(r: Pick<RunView, "status">): "thinking" | "waiting" | "approval" | "error" | null {
  switch (r.status) {
    case "running": case "stopping": return "thinking";
    case "stopped": return "waiting";
    case "stalled": return "approval"; // amber, as on the run's page: it waits for the user
    case "error": case "gave_up": return "error";
    default: return null;
  }
}

const tasks = (n: number) => `${n} task${n === 1 ? "" : "s"}`;
const STALLED: Record<string, string> = { turns: "turn limit", cost: "cost limit", idle: "idle turns" };

/** A run row's second line in the sidebar. A finished run whose result waits for the person says
 *  so ("Completed · not applied") in place of its task count. */
export function runRowLine(r: Pick<RunView, "status" | "turns" | "counts" | "reason" | "stalledBy" | "delivery">): string {
  const total = runTaskTotal(r), waits = deliveryWord(r.delivery);
  const ended = (word: string) => (waits ? `${word} · ${waits}` : total ? `${word} · ${tasks(total)}` : word);
  switch (r.status) {
    case "running":
      if (!r.turns) return "Starting…";
      return total ? `Turn ${r.turns} · ${runTasksDone(r)} of ${tasks(total)} done` : `Turn ${r.turns}`;
    case "stalled": { const by = r.stalledBy && STALLED[r.stalledBy]; return by ? `Stalled: ${by}` : "Stalled"; }
    case "error": return r.reason ? `Error: ${r.reason}` : "Error";
    case "completed": return ended("Completed");
    case "gave_up": return ended("Gave up");
    default: return runWord(r);
  }
}

/** Why the goal cannot be sent now, as the disabled Send button's title; "" when it can. text is
 *  the composer's value. */
export function startBlock(r: Pick<RunView, "cwd" | "folderMissing" | "blocked">, text: string): string {
  if (!r.cwd || r.folderMissing) return "Pick a folder that exists first";
  if (r.blocked) return r.blocked;
  if (!text.trim()) return "Type a goal first";
  return "";
}

/** The limits chip of the goal composer: "4 parallel · 60 turns", and " · $20" with a cost limit. */
export function limitsLabel(s: Pick<RunSettings, "maxParallel" | "maxTurns" | "maxCost">): string {
  const cost = s.maxCost > 0 ? ` · $${Number.isInteger(s.maxCost) ? s.maxCost : s.maxCost.toFixed(2)}` : "";
  return `${s.maxParallel} parallel · ${s.maxTurns} turn${s.maxTurns === 1 ? "" : "s"}${cost}`;
}

/** The Models chip of the goal composer: the tiers' model labels, deep first, joined by " · ";
 *  one label when all three tiers have the same model. labelOf is the catalogue's short label of
 *  a model id; a model it does not know shows its id, a tier with no model "none". */
export function tiersLabel(tiers: RunTiers, labelOf: (model: string) => string | undefined = () => undefined): string {
  const labels = TIERS.map((k) => { const m = tiers[k]?.model; return m ? labelOf(m) || m : "none"; });
  return TIERS.every((k) => tiers[k]?.model === tiers.deep?.model) ? labels[0] : labels.join(" · ");
}
