// What the goal composer (run/RunComposer.tsx) reads of a draft run by its server (an entry of the
// server list; logic/runserver.ts): the chip of its folder, the one line under the box, what is
// fixed while its start got no answer, and what a refused start leaves. DOM-free.
import { LOCAL_SERVER, type ChatView, type RunView } from "../types.ts";
import type { Where } from "./chatserver.ts";
import { goalLine, type GoalLine } from "./rungoal.ts";
import { folderOn, runOffLine, runUnconfirmedLine } from "./runserver.ts";
import { serverConnected, serverOf } from "./serverlists.ts";
import type { ServerView } from "./servers.ts";

/** Why agent, folder, models and settings of a draft run cannot be changed; the server's choice
 *  has its own sentence (RUN_START_UNCONFIRMED). */
export const RUN_FIXED_UNCONFIRMED = "The start may have arrived: this cannot be changed until that is known";

/** Why the draft run's agent, folder, models and settings are fixed chips, or "": its start got
 *  no answer. The server is the authority (it answers 409 start_unconfirmed). */
export const runFixed = (r: Pick<RunView, "start">): string => (r.start === "unconfirmed" ? RUN_FIXED_UNCONFIRMED : "");

/** Whether the draft run has chats of the user (not its own agents'): its server is fixed then. */
export const runHasChats = (chats: Record<string, Pick<ChatView, "run" | "role">>, run: string): boolean =>
  Object.values(chats).some((c) => c.run === run && !c.role);

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
 *  that is not connected (nothing below is known then); a start that got no answer; else the
 *  line of the folder (goalLine), in which why the run's agent cannot run on another server
 *  (agentReason: runAgentReason, runserver.ts) stands for the view's `blocked`. */
export function runLine(w: Where, r: Pick<RunView, "cwd" | "folderMissing" | "blocked" | "git" | "dirty" | "start">, startError: string, tilde: (path: string) => string = (p) => p, agentReason = ""): GoalLine | null {
  if (startError) return { tone: "error", text: startError };
  if (!w.connected) return { tone: "error", text: runOffLine(w.name) };
  if (r.start === "unconfirmed") return { tone: "note", text: runUnconfirmedLine(w.name) };
  return goalLine(agentReason ? { ...r, blocked: agentReason } : r, "", tilde);
}

/** The code of a start the server answered after the run had started with the goal of an earlier
 *  start that got no answer: the text of this one was not sent. */
export const GOAL_KEPT = "goal_kept";
export const GOAL_TOO_LONG = "The goal is too long for the server to take.";

/** What a refused start leaves. text: the sentence to show; the goal's text always stays.
 *  reread: the run is read again (a 409: it started, was archived, or its folder changed).
 *  kept: the run has started with an earlier goal, so the composer goes away: the sentence and
 *  the typed text are shown apart from it. */
export function startFailure(e: unknown): { text: string; reread: boolean; kept: boolean } {
  const a = e as { status?: unknown; said?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const text = a?.status === 413 && a.said === false ? GOAL_TOO_LONG // a body the server would not take, with no sentence of its own
    : (typeof a?.message === "string" && a.message) || String(e);
  return { text, reread: a?.status === 409, kept: a?.code === GOAL_KEPT };
}

/** What a refused change of a draft run (a PATCH: server, agent, folder, models, settings) leaves:
 *  the server's sentence, shown where the change was made, and whether the run is read again (a
 *  409: it started, is being started (`busy`), or what the page shows of it is old). */
export function changeFailure(e: unknown): { text: string; reread: boolean } {
  const { text, reread } = startFailure(e);
  return { text, reread };
}

// ---- the start's state, by run id (State.runStarts)

/** A draft run's start as the page holds it. starting: the start is on its way to the server.
 *  error: what the server said about the start, or about the change of the draft, that failed
 *  last; "" for none. It is kept by run id and not in the composer, which is made again when the
 *  draft gets a new id mid-start (a `run` event with `was`). */
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

/** `run` with `was`: the start's state moves to the new id with the selection and the unsaved goal. */
export function movedRunStart(starts: Starts, was: string, id: string): Starts {
  if (!was || was === id || !starts[was]) return starts;
  const { [was]: start, ...rest } = starts;
  return { ...rest, [id]: start };
}

/** What the sentence of a failed start is about: the run's folder, what blocks it, its server,
 *  its start mark, and whether that server is connected. */
type RunFacts = Pick<RunView, "cwd" | "folderMissing" | "blocked" | "server" | "start">;
export type StartFacts = RunFacts & { connected: boolean };

/** Whether what the server said about a start is old: the run's folder, what blocks it, its
 *  server or its start mark changed (a start that got no answer is known now, either way), or its
 *  server is connected again. The line under the box then says what is the case now. Not the mark
 *  becoming "unconfirmed": it then says what the sentence of that start says (the server sets it
 *  as it answers the start, and the event of it can come after the answer). */
export const startErrorOld = (was: StartFacts, now: StartFacts): boolean =>
  was.cwd !== now.cwd || !!was.folderMissing !== !!now.folderMissing || (was.blocked ?? "") !== (now.blocked ?? "")
  || serverOf(was) !== serverOf(now) || ((was.start ?? "") !== (now.start ?? "") && now.start !== "unconfirmed") || (!was.connected && now.connected);

type StartsOf = { runs: Record<string, RunFacts>; servers?: ServerView[] };

/** The starts after the runs or the server list changed (store.ts setState): a run that is gone
 *  takes its start with it, and a sentence that is old (startErrorOld) goes; a start that is on
 *  its way stays, since its answer ends it. A run that is new under its id (a draft's new id,
 *  whose start was moved to it) keeps what it has. The map itself when nothing changes. */
export function keptRunStarts(starts: Starts, before: StartsOf, after: StartsOf): Starts {
  let out = starts;
  for (const id of Object.keys(starts)) {
    const was = before.runs[id], now = after.runs[id];
    if (!now) { out = withRunStart(out, id, null); continue; }
    if (!was || !starts[id].error) continue;
    const facts = (s: StartsOf, r: RunFacts): StartFacts => ({ ...r, connected: serverConnected(s, serverOf(r)) });
    if (startErrorOld(facts(before, was), facts(after, now))) out = withRunStart(out, id, { error: "" });
  }
  return out;
}
