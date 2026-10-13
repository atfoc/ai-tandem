// A run by the server it is on (this computer, or a section: a remote server of the server list;
// logic/serverlists.ts): what stops a draft's start and what its composer says, the view and the
// delete dialog of a section's run, and the rules of what is read again when a section's tree
// arrives and of the unfollow of a run that is dropped. DOM-free.
import { LOCAL_SERVER, type AgentKind, type ChatView, type RunView } from "../types.ts";
import { CHOOSE_AGENT } from "./agentlist.ts";
import { agentChoiceOn, type Where } from "./chatserver.ts";
import { serverOfKey } from "./keys.ts";
import { NOT_FOUND, stateSaid, type DeleteAsk, type Remote, type RemoteView } from "./remoteview.ts";
import { runWorking, startBlock } from "./run.ts";
import { serverConnected, serverName, serverOf, withThreadError, type ListsState, type ThreadError } from "./serverlists.ts";
import type { ServerState } from "./servers.ts";
import { notConnected } from "./status.ts";

const remote = (w: Where) => w.server !== LOCAL_SERVER;

/** A run's server as its views read it: the entry id, its name, and whether it takes a call now. */
export const runWhere = (s: ListsState, r: { id?: string }): Where => {
  const server = serverOf(r);
  return { server, name: serverName(s, server), connected: serverConnected(s, server) };
};

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

/** The line of a draft run whose server is not connected: it is shown as it was, and takes no change and no start. */
export const runOffLine = (name: string): string => `${notConnected(name)}: nothing can be changed or started until it is back.`;

/** A run's folder as its head says it: another server's names the server. */
export const folderOn = (w: Where, folder: string): string => (remote(w) && folder ? `${folder} on ${w.name}` : folder);

export const runGoneText = (name: string): string => `This run is no longer on ${name}.`;
export const runUnreachableText = (name: string): string => `${notConnected(name)}. This run shows again when it is back.`;
/** The warning over a run that is on screen while its server is not connected. */
export const runAwayText = (name: string): string => `${notConnected(name)}. This run is shown as it was when the connection ended.`;

const NONE: RemoteView = { kind: "none" };

/** What a section's run shows where its detail is (as remoteView for a chat's thread).
 *  none: the detail as usual (always for a run of this computer, and while a load runs).
 *  unreachable: no detail is kept while the server is not connected.
 *  gone: no detail is kept and the run is no longer there.
 *  failed: no detail is kept and its load failed for another reason: the server's sentence.
 *  bar: the detail kept stays on screen, read-only, under a warning, which says the entry's state too. */
export function runRemoteView(at: Remote, name: string, state: ServerState | undefined, hasDetail: boolean, err?: ThreadError): RemoteView {
  if (!at.remote) return NONE;
  const gone = !!at.gone || err?.code === NOT_FOUND;
  if (hasDetail) return gone ? { kind: "bar", text: runGoneText(name), gone: true } : at.connected ? NONE : { kind: "bar", text: runAwayText(name), gone: false, state: stateSaid(state) };
  if (gone) return { kind: "gone", text: runGoneText(name) };
  if (!at.connected) return { kind: "unreachable", text: runUnreachableText(name), state: stateSaid(state) };
  return err ? { kind: "failed", text: err.message } : NONE;
}

type Deleted = Partial<Pick<RunView, "started" | "status" | "archived">>;

/** The dialog the row's Delete opens. title: the run's name; name: its server's, "" for a run of this
 *  computer; folder: its folder as the user reads it (~/…), which a section's run names with the
 *  server. A run that has not started changed nothing there, so the sentence about the folder is
 *  left out. A section's run is deleted on its server, for its owner and every client of it. */
export function runDeleteAsk(r: Deleted, title: string, name = "", folder = ""): DeleteAsk {
  const working = r.status && runWorking({ status: r.status, archived: r.archived }) ? "This run is working: its agents are stopped. " : "";
  const stays = r.started && folder ? ` What its agents changed in ${name ? `${folder} on ${name}` : folder} stays.` : "";
  const there = name ? ` on ${name}, for everyone who uses that server` : "";
  return { title: `Delete ${title}?`, body: `${working}The run's tasks, reports, notes, agent transcripts and chats are removed${there}.${stays} This can't be undone.` };
}

/** Whether "+" (a chat on the run) is offered: not for an archived run. */
export const offersChatOn = (r: Pick<RunView, "archived">): boolean => !r.archived;

// ---- what is read again when a section's tree arrives (conn.ts)

type BackState = {
  runs: Record<string, { started?: string }>;
  runDetail: Record<string, unknown>;
  runErrors?: Record<string, unknown>;
  agents: Record<string, Pick<ChatView, "run">>;
  runAgent?: { run: string; agent: string } | null;
  sel: { run: string | null };
};

/** A section's tree arrived: the server is connected, for the first time or again, and the local
 *  server ended this page's follows of its runs and of their agents' chats with the connection, so
 *  what is kept of them is no longer kept current.
 *  runs: the runs of that server that have a detail, a load error or a fetch that runs
 *    (`fetching`, conn.ts), each of which is dropped.
 *  agents: the agents' chats of that server's runs that are kept (State.agents, and the one the
 *    panel shows), each of which is forgotten and, when it is still held, read again.
 *  load: the run on screen when it is a started one of that server, whose detail is read again. */
export function runSectionBack(s: BackState, server: string, fetching: Iterable<string> = []): { runs: string[]; agents: string[]; load: string | null } {
  const on = (id: string) => !!s.runs[id] && serverOfKey(id) === server;
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
