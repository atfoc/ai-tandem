// A run by the server it is on (an entry of the server list; logic/serverlists.ts): the draft
// run's server choice, what stops its start and what its composer says, the view and the delete
// dialog of a run on another server, and the rules of the events about such a run (`run` with
// `was`, `server_back`, the unfollow of a run that is dropped). DOM-free.
import { LOCAL_SERVER, type AgentKind, type ChatView, type RunView } from "../types.ts";
import { CHOOSE_AGENT } from "./agentlist.ts";
import { agentChoiceOn, type Where } from "./chatserver.ts";
import { REMOVE_ONLY, type DeleteAsk, type RemoteView } from "./remoteview.ts";
import { runWorking, startBlock } from "./run.ts";
import { serverConnected, serverName, serverOf, serverOptions, withThreadError, type ListsState, type ServerOption, type ThreadError } from "./serverlists.ts";
import { stateLabel, type ServerState, type ServerView } from "./servers.ts";
import { notConnected } from "./status.ts";

const remote = (w: Where) => w.server !== LOCAL_SERVER;

/** A run's server as its views read it: the entry id, its name, and whether it is connected. */
export const runWhere = (s: ListsState, r: { server?: string }): Where => {
  const server = serverOf(r);
  return { server, name: serverName(s, server), connected: serverConnected(s, server) };
};

export const RUN_START_UNCONFIRMED = "The start may have arrived: the server cannot be changed until that is known";
export const RUN_HAS_CHATS = "This run has chats on this computer";

/** A draft run's server choice: the options of a chat's (serverChoice). fixed: why the run's
 *  server cannot be changed, or "": its start got no answer, or it has chats, which are where
 *  the run is. The server is the authority (it answers 409). */
export function runServerChoice(servers: ServerView[], r: Pick<RunView, "start">, hasChats: boolean): { options: ServerOption[]; fixed: string } {
  return { options: serverOptions(servers), fixed: r.start === "unconfirmed" ? RUN_START_UNCONFIRMED : hasChats ? RUN_HAS_CHATS : "" };
}

/** Why a draft run on another server has no agent that can run it, in that server's name: the
 *  agent choice's reason (that server has none, or lacks the run's). "" when the agent can run,
 *  for a run of this computer, and while the server is not connected (the line says that). The
 *  view's `blocked` says the same of "this server", which on this page reads as this computer: so
 *  this comes before it (runStartBlock, runLine). usable: that server's agents. */
export const runAgentReason = (w: Where, usable: AgentKind[], r: Pick<RunView, "agent">): string =>
  (remote(w) && w.connected ? agentChoiceOn(w, usable, r.agent).reason : "");

/** Why the goal cannot be sent now, as the disabled Send's title; "" when it can. A server that
 *  is not connected comes first: the folder and the agents of the run are not known then. Then
 *  the folder, why the run's agent cannot run on another server (agentReason: runAgentReason) and
 *  what the server says blocks the run (startBlock), a run with no agent, and last a goal that
 *  is still to be typed. */
export function runStartBlock(w: Where, r: Pick<RunView, "cwd" | "folderMissing" | "blocked" | "agent">, text: string, agentReason = ""): string {
  if (!w.connected) return notConnected(w.name);
  const b = { ...r, blocked: agentReason || r.blocked };
  return startBlock(b, "-") || (r.agent ? "" : CHOOSE_AGENT_RUN) || startBlock(b, text);
}
const CHOOSE_AGENT_RUN = CHOOSE_AGENT.replace("to send a message", "first");

/** The line of a draft run whose server is not connected. */
export const runOffLine = (name: string): string => `${notConnected(name)}: its folders and agents are not known.`;

/** The line of a draft run whose start got no answer. */
export const runUnconfirmedLine = (name: string): string =>
  `${name} did not answer: it is not known whether the run started. Start again: it starts only once.`;

/** A run's folder as its head says it: another server's names the server. */
export const folderOn = (w: Where, folder: string): string => (remote(w) && folder ? `${folder} on ${w.name}` : folder);

/** The code of a call the remote server answered "no such run" to. */
const GONE_THERE = "gone_there";

export const runGoneText = (name: string): string => `This run is no longer on ${name}.`;
export const runUnreachableText = (name: string): string => `${notConnected(name)}. This run shows again when it is back.`;
export const runStaysText = (name: string): string => `Removing it from this sidebar leaves the run on ${name}.`;

const NONE: RemoteView = { kind: "none" };

/** What a run on another server shows where its detail is (as remoteView for a chat's thread).
 *  none: the detail as usual (always for a run of this computer, and while a load runs).
 *  unreachable: no detail is kept and its load failed while the server is not connected.
 *  gone: no detail is kept and the run is no longer there.
 *  failed: no detail is kept and its load failed for another reason: the server's sentence.
 *  bar: the detail kept stays on screen, with a bar. */
export function runRemoteView(r: Pick<RunView, "server" | "gone">, name: string, state: ServerState | undefined, hasDetail: boolean, err?: ThreadError): RemoteView {
  if (!r.server) return NONE;
  const connected = state === "connected";
  const gone = !!r.gone || err?.code === GONE_THERE;
  if (hasDetail) return gone ? { kind: "bar", text: runGoneText(name), gone: true } : connected ? NONE : { kind: "bar", text: `${notConnected(name)}.`, gone: false };
  if (gone) return { kind: "gone", text: runGoneText(name) };
  if (!err) return NONE;
  return connected ? { kind: "failed", text: err.message } : { kind: "unreachable", text: runUnreachableText(name), state: state ? stateLabel(state) : "" };
}

type Deleted = Pick<RunView, "server" | "gone"> & Partial<Pick<RunView, "started" | "status" | "archived">>;

type Refusal = { status?: unknown; code?: unknown } | null | undefined;
/** A delete that was sent and got no answer (504): the run may be deleted there all the same. */
const noAnswer = (err: unknown): boolean => (err as Refusal)?.status === 504 || (err as Refusal)?.code === "no_answer";
/** A delete that was not sent (503): the server is not connected. */
const notSent = (err: unknown): boolean => (err as Refusal)?.status === 503 || (err as Refusal)?.code === "server_unreachable";

export const RUN_DELETE_UNKNOWN = "It is not known whether the run was deleted.";

/** Whether "Remove from this sidebar only" is offered for a run: it is on another server and is
 *  gone, or its delete was answered 503 (nothing was sent) or 504 (no answer came) and its server
 *  is not connected: while it is, the local server refuses to remove the record alone (409
 *  `server_connected`). Never for a run of this computer, and not after another refusal (a 409).
 *  connected: the run's server is, when the refusal came. */
export function runOffersLocalOnly(r: Pick<RunView, "server" | "gone">, err?: unknown, connected = false): boolean {
  if (!r.server) return false;
  if (r.gone) return true;
  return (notSent(err) || noAnswer(err)) && !connected;
}

/** The dialog the row's Delete (or, for a gone run, "Remove from this sidebar") opens. title: the
 *  run's name; name: its server's; folder: its folder as the user reads it (~/…), which a run on
 *  another server names with the server. A run that has not started changed nothing there, so
 *  the sentence about the folder is left out. */
export function runDeleteAsk(r: Deleted, title: string, name: string, folder = ""): DeleteAsk {
  if (runOffersLocalOnly(r)) return { title: `Remove ${title} from this sidebar?`, body: runGoneText(name), action: REMOVE_ONLY, local: true };
  const working = r.status && runWorking({ status: r.status, archived: r.archived }) ? "This run is working: its agents are stopped. " : "";
  const stays = r.started && folder ? ` What its agents changed in ${r.server ? `${folder} on ${name}` : folder} stays.` : "";
  const there = r.server ? ` on ${name}` : "";
  return { title: `Delete ${title}?`, body: `${working}The run's tasks, reports, notes, agent transcripts and chats are removed${there}.${stays} This can't be undone.`, action: "Delete", local: false };
}

/** The dialog that follows a refused delete. After a 503 (nothing was sent) and a server that is
 *  not connected: the offer of this sidebar only, with the server's sentence and one saying the
 *  run stays there. After a 504 (no answer came) the run may be deleted there all the same: the
 *  dialog says that it is not known, and offers this sidebar only when the server is not connected
 *  (connected: the run's server is, now); while it is, the same Delete can be tried again. null
 *  when the refusal offers nothing (a 409, as `busy` while the run is being started: the dialog
 *  then shows the server's sentence, as for any error). */
export function runDeleteRefused(r: Pick<RunView, "server" | "gone">, title: string, name: string, err: unknown, connected: boolean): DeleteAsk | null {
  if (r.gone || !r.server || !(notSent(err) || noAnswer(err))) return null;
  const said = err instanceof Error && err.message ? err.message : `${notConnected(name)}.`;
  const what = noAnswer(err) ? RUN_DELETE_UNKNOWN : "The run was not deleted.";
  if (!runOffersLocalOnly(r, err, connected)) return noAnswer(err) ? { title: `Delete ${title}?`, body: `${said} ${what}`, action: "Delete", local: false } : null;
  return { title: `Remove ${title} from this sidebar?`, body: `${said} ${what} ${runStaysText(name)}`, action: REMOVE_ONLY, local: true };
}

/** Whether "+" (a chat on the run) is offered: not for an archived run, and not for a draft on
 *  another server, whose chats would be where the run is not yet. */
export const offersChatOn = (r: Pick<RunView, "server" | "started" | "archived">): boolean =>
  !r.archived && !(serverOf(r) !== LOCAL_SERVER && !r.started);

// ---- the events about a run (conn.ts, store.ts)

/** The selection after a `run` event with `was`: a draft that got a new id stays the run on screen. */
export const movedSel = <S extends { run: string | null }>(sel: S, was: string, id: string): S =>
  (was && id && sel.run === was ? { ...sel, run: id } : sel);

/** The id a run has now: `moves` has, for a draft that got a new id, the old id with the new one.
 *  An id that never moved is itself. */
export function movedId(moves: ReadonlyMap<string, string>, id: string): string {
  let now = id;
  for (let n = 0; n <= moves.size && moves.has(now); n++) now = moves.get(now)!; // (never round a ring)
  return now;
}

type BackState = {
  runs: Record<string, { server?: string; started?: string }>;
  runDetail: Record<string, unknown>;
  runErrors?: Record<string, unknown>;
  agents: Record<string, Pick<ChatView, "run">>;
  runAgent?: { run: string; agent: string } | null;
  sel: { run: string | null };
};

/** `server_back`: a server is connected again; the local server ended this page's follows of its
 *  runs and of their agents' chats, so what is kept of them is no longer kept current.
 *  runs: the runs of that server that have a detail, a load error or a fetch that runs
 *    (`fetching`, conn.ts), each of which is dropped.
 *  agents: the agents' chats of that server's runs that are kept (State.agents, and the one the
 *    panel shows), each of which is forgotten and, when it is still held, read again.
 *  load: the run on screen when it is a started one of that server, whose detail is read again. */
export function runServerBack(s: BackState, server: string, fetching: Iterable<string> = []): { runs: string[]; agents: string[]; load: string | null } {
  const on = (id: string) => !!s.runs[id] && serverOf(s.runs[id]) === server;
  const kept = new Set([...Object.keys(s.runDetail), ...Object.keys(s.runErrors ?? {}), ...fetching]);
  const runs = Object.keys(s.runs).filter((id) => on(id) && kept.has(id));
  const agents = Object.keys(s.agents).filter((id) => on(s.agents[id].run ?? ""));
  if (s.runAgent && on(s.runAgent.run) && !agents.includes(s.runAgent.agent)) agents.push(s.runAgent.agent);
  const sel = s.sel.run;
  return { runs, agents, load: sel && on(sel) && s.runs[sel].started ? sel : null };
}

/** The load errors by run id with this run's set, or with null cleared (State.runErrors). */
export const withRunError = (errors: Record<string, ThreadError>, run: string, e: ThreadError | null): Record<string, ThreadError> =>
  withThreadError(errors, run, e);

/** The unfollows that are under way, by id. The server ends a follow when the unfollow arrives,
 *  and a read of the same item starts one: a read that is made while an unfollow is under way
 *  waits for it (wait), or the unfollow, arriving after the read, would end the follow the read
 *  started. */
export class Unfollows {
  private under = new Map<string, Promise<void>>();

  /** Tells the server, at once; a failure counts as an answer. */
  start(id: string, call: () => Promise<unknown>): void {
    let sent: Promise<unknown>;
    try { sent = Promise.resolve(call()); } catch { sent = Promise.resolve(); }
    const done: Promise<void> = sent.then(() => {}, () => {}).then(() => { if (this.under.get(id) === done) this.under.delete(id); });
    this.under.set(id, done);
  }

  /** The unfollow of id that is under way (the last one started), or undefined. */
  wait(id: string): Promise<void> | undefined { return this.under.get(id); }
}
