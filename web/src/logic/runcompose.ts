// What the goal composer (run/RunComposer.tsx) reads of a draft run by its server (this computer, or
// a section; logic/runserver.ts): the chip of its folder, the one line under the box, what is
// fixed while its server is not connected, and what a refused start leaves. DOM-free.
import { LOCAL_SERVER, type RunView } from "../types.ts";
import type { Where } from "./chatserver.ts";
import { goalLine, type GoalLine } from "./rungoal.ts";
import { folderOn, runOffLine } from "./runserver.ts";
import { notConnected } from "./status.ts";

/** Why the draft run's agent, folder, models and settings are fixed chips, or "": its server is
 *  not connected, and the run is shown as it was. */
export const runFixed = (w: Where): string => (w.connected ? "" : notConnected(w.name));

/** The chip above the goal box: the run's folder as its server's home shortens it, " on <Name>"
 *  for another server, and whether the view says it is a git repository. tilde shortens a path
 *  by the run's server. */
export function runFolderChip(w: Where, r: Pick<RunView, "cwd" | "folderMissing" | "git">, tilde: (path: string) => string = (p) => p): { text: string; git: boolean; missing: boolean; title: string } {
  return {
    text: folderOn(w, r.cwd ? tilde(r.cwd) : "") || "No folder",
    git: !!r.git && !r.folderMissing,
    missing: !!r.folderMissing,
    title: w.server === LOCAL_SERVER ? "The folder the run's agents work in" : `The folder on ${w.name} the run's agents work in`,
  };
}

/** The one line under the goal box, the first that applies: the start that just failed; a server
 *  that is not connected (nothing below can be changed then); else the line of the folder
 *  (goalLine), in which why the run's agent cannot run on another server (agentReason:
 *  runAgentReason, runserver.ts) stands for the view's `blocked`. */
export function runLine(w: Where, r: Pick<RunView, "cwd" | "folderMissing" | "blocked" | "git" | "dirty">, startError: string, tilde: (path: string) => string = (p) => p, agentReason = ""): GoalLine | null {
  if (startError) return { tone: "error", text: startError };
  if (!w.connected) return { tone: "error", text: runOffLine(w.name) };
  return goalLine(agentReason ? { ...r, blocked: agentReason } : r, "", tilde);
}

export const GOAL_TOO_LONG = "The goal is too long for the server to take.";

/** What a refused start leaves. text: the sentence to show; the goal's text always stays.
 *  reread: the run is read again (a 409: it started, was archived, or its folder changed). */
export function startFailure(e: unknown): { text: string; reread: boolean } {
  const a = e as { status?: unknown; said?: unknown; message?: unknown } | null | undefined;
  const text = a?.status === 413 && a.said === false ? GOAL_TOO_LONG // a body the server would not take, with no sentence of its own
    : (typeof a?.message === "string" && a.message) || String(e);
  return { text, reread: a?.status === 409 };
}

/** What a refused change of a draft run (a PATCH: agent, folder, models, settings) leaves: the
 *  server's sentence, shown where the change was made, and whether the run is read again (a 409:
 *  it started, is being started (`busy`), or what the page shows of it is old). */
export const changeFailure = startFailure;

// ---- the start's state, by run id (State.runStarts)

/** A draft run's start as the page holds it. starting: the start is on its way to the server.
 *  error: what the server said about the start, or about the change of the draft, that failed
 *  last; "" for none. It is kept by run and not in the composer, so a composer made again reads
 *  the same. */
export type RunStart = { starting: boolean; error: string };

type Starts = Record<string, RunStart>;

/** The starts with this run's changed (patch), or taken out (null, and when nothing is left to
 *  say of it); the map itself when nothing changes. */
export function withRunStart(starts: Starts, id: string, patch: Partial<RunStart> | null): Starts {
  const was = starts[id], next: RunStart = { starting: patch?.starting ?? was?.starting ?? false, error: patch?.error ?? was?.error ?? "" };
  if (!patch || (!next.starting && !next.error)) {
    if (!was) return starts;
    const { [id]: _, ...rest } = starts;
    return rest;
  }
  return was && was.starting === next.starting && was.error === next.error ? starts : { ...starts, [id]: next };
}

/** What the sentence of a failed start is about: the run's folder, what blocks it, and whether
 *  its server is connected. */
type RunFacts = Pick<RunView, "cwd" | "folderMissing" | "blocked">;
export type StartFacts = RunFacts & { connected: boolean };

/** Whether what the server said about a start is old: the run's folder or what blocks it changed,
 *  or its server is connected again. The line under the box then says what is the case now. */
export const startErrorOld = (was: StartFacts, now: StartFacts): boolean =>
  was.cwd !== now.cwd || !!was.folderMissing !== !!now.folderMissing || (was.blocked ?? "") !== (now.blocked ?? "") || (!was.connected && now.connected);

type StartsOf = { runs: Record<string, RunFacts>; connected(run: string): boolean };

/** The starts after the runs or the sections changed (store.ts setState): a run that is gone
 *  takes its start with it, and a sentence that is old (startErrorOld) goes; a start that is on
 *  its way stays, since its answer ends it. The map itself when nothing changes. */
export function keptRunStarts(starts: Starts, before: StartsOf, after: StartsOf): Starts {
  let out = starts;
  for (const id of Object.keys(starts)) {
    const was = before.runs[id], now = after.runs[id];
    if (!now) { out = withRunStart(out, id, null); continue; }
    if (!was || !starts[id].error) continue;
    if (startErrorOld({ ...was, connected: before.connected(id) }, { ...now, connected: after.connected(id) })) out = withRunStart(out, id, { error: "" });
  }
  return out;
}
