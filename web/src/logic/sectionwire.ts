// A section's things between the wire and the page. The local server hands on a remote server's
// tree, events and answers with that server's own ids, and names the server apart: the entry id
// is a path segment or an event's top-level `server`. The page keys everything by both
// (logic/keys.ts), so what comes in gets its keys here, in one place, before it enters the store;
// what goes out gets that server's own ids back (the `…Out` functions, which api.ts uses for a
// body). For this computer (no server, or LOCAL_SERVER) every function gives back what it was
// given. DOM-free.
import { LOCAL_SERVER, type Attempt, type Board, type BranchState, type ChatView, type Draft, type Group, type NotesVersion, type Op, type RunAgent, type RunDetail,
  type RunEvent, type RunPatch, type RunView, type SectionTree, type Task, type TaskBrief, type Turn } from "../types.ts";
import { keyOn, ownId, serverOfKey } from "./keys.ts";
import { normRun } from "./runnorm.ts";

type Server = string | null | undefined;

const local = (server: Server): boolean => !server || server === LOCAL_SERVER;
/** An id that may be absent or "": only one that is there gets a key. */
const opt = <T extends string | undefined>(server: Server, id: T): T => (id ? keyOn(server, id) as T : id);

// ---- in: the page's keys

/** A draft: the boards picked in it (`mentions`) are that server's. */
export function draftIn<D extends Draft | null | undefined>(server: Server, d: D): D {
  if (local(server) || !d?.mentions?.length) return d;
  return { ...d, mentions: d.mentions.map((m) => ({ ...m, id: keyOn(server, m.id) })) };
}

/** A group of a section: `collapsed` is that server's own matter and is dropped (the page keeps its own, in the browser). */
export function groupIn(server: Server, g: Group): Group {
  if (local(server)) return g;
  const { collapsed: _, ...rest } = g;
  return { ...rest, id: keyOn(server, g.id), ...(g.parent ? { parent: keyOn(server, g.parent) } : {}) };
}

export const boardIn = (server: Server, b: Board): Board =>
  (local(server) ? b : { ...b, id: keyOn(server, b.id), group: keyOn(server, b.group) });

export function chatIn(server: Server, c: ChatView): ChatView {
  if (local(server)) return c;
  const out: ChatView = { ...c, id: keyOn(server, c.id) };
  if (c.group) out.group = keyOn(server, c.group);
  if (c.board) out.board = keyOn(server, c.board);
  if (c.run) out.run = keyOn(server, c.run);
  if (c.forkedFrom) out.forkedFrom = keyOn(server, c.forkedFrom);
  if (c.draft) out.draft = draftIn(server, c.draft);
  return out;
}

export function stateIn(server: Server, st: BranchState): BranchState {
  if (local(server)) return st;
  return { ...st, chat: keyOn(server, st.chat), ...(st.draft ? { draft: draftIn(server, st.draft) } : {}) };
}

export function runIn(server: Server, r: RunView): RunView {
  if (local(server)) return r;
  return { ...r, id: keyOn(server, r.id), ...(r.group ? { group: keyOn(server, r.group) } : {}), ...(r.draft ? { draft: draftIn(server, r.draft) } : {}) };
}

/** A section's tree with the page's keys. A list the server left out or sent as null is empty. The defaults are
 *  kept as they came: nothing on the page reads them by group. */
export function treeIn(server: string, t: SectionTree) {
  return {
    groups: (t.groups ?? []).map((g) => groupIn(server, g)),
    boards: (t.boards ?? []).map((b) => boardIn(server, b)),
    chats: (t.chats ?? []).map((c) => chatIn(server, c)),
    states: (t.states ?? []).filter((st) => st?.chat).map((st) => stateIn(server, st)),
    runs: (t.runs ?? []).map((r) => runIn(server, normRun(r))), // made whole first: a run always has a group
    defaults: t.defaults ?? { groups: {} },
  };
}

// A run's detail names chats by id: its own agents' (the transcripts), and the user's chats on the run that
// changed it.

const eventIn = (server: Server) => (e: RunEvent): RunEvent => (e.chat ? { ...e, chat: keyOn(server, e.chat) } : e);
const opIn = (server: Server) => (o: Op): Op => (o.chat ? { ...o, chat: keyOn(server, o.chat) } : o);
const noteIn = (server: Server) => <N extends NotesVersion>(n: N): N => (n.chat ? { ...n, chat: keyOn(server, n.chat) } : n);

const turnIn = (server: Server) => (t: Turn): Turn =>
  ({ ...t, agent: opt(server, t.agent), wokenBy: (t.wokenBy ?? []).map(eventIn(server)), learned: (t.learned ?? []).map(eventIn(server)), ops: (t.ops ?? []).map(opIn(server)) });

const attemptIn = (server: Server) => (a: Attempt): Attempt => {
  const out: Attempt = { ...a, phases: (a.phases ?? []).map((p) => (p.chat ? { ...p, chat: keyOn(server, p.chat) } : p)), agents: {} };
  if (a.queuedBy) out.queuedBy = keyOn(server, a.queuedBy);
  if (a.cancel?.chat) out.cancel = { ...a.cancel, chat: keyOn(server, a.cancel.chat) };
  if (a.agents?.work) out.agents.work = keyOn(server, a.agents.work);
  if (a.agents?.merge) out.agents.merge = keyOn(server, a.agents.merge);
  return out;
};

const taskIn = (server: Server) => (t: Task): Task => ({
  ...t, ...(t.addedBy ? { addedBy: keyOn(server, t.addedBy) } : {}),
  briefs: (t.briefs ?? []).map((b) => (b.chat ? { ...b, chat: keyOn(server, b.chat) } : b)),
  attempts: (t.attempts ?? []).map(attemptIn(server)),
});

/** A map by agent chat id, with its records' own ids when they have one. */
function agentsIn<A extends { id?: string }>(server: Server, m: Record<string, A>): Record<string, A> {
  return Object.fromEntries(Object.entries(m).map(([id, a]) => [keyOn(server, id), a && typeof a === "object" && a.id ? { ...a, id: keyOn(server, a.id) } : a]));
}

/** A run's detail (GET …/detail), after logic/runnorm.ts made it whole. */
export function detailIn(server: Server, d: RunDetail): RunDetail {
  if (local(server)) return d;
  return { ...d, run: opt(server, d.run), turns: d.turns.map(turnIn(server)), tasks: d.tasks.map(taskIn(server)), chatOps: d.chatOps.map(opIn(server)),
    agents: agentsIn<RunAgent>(server, d.agents), notes: d.notes.map(noteIn(server)) };
}

/** A `run_detail` patch, after logic/runnorm.ts made it whole: only what it names. */
export function patchIn(server: Server, p: RunPatch): RunPatch {
  if (local(server)) return p;
  const out: RunPatch = { ...p };
  if (p.turns) out.turns = p.turns.map(turnIn(server));
  if (p.tasks) out.tasks = p.tasks.map(taskIn(server));
  if (p.chatOps) out.chatOps = p.chatOps.map(opIn(server));
  if (p.agents) out.agents = agentsIn<RunAgent>(server, p.agents);
  if (p.notes) out.notes = p.notes.map(noteIn(server));
  return out;
}

/** The agents of a `run_activity` event, by their chat's key. */
export const activityIn = <A extends object>(server: Server, agents: Record<string, A>): Record<string, A> =>
  (local(server) ? agents : agentsIn(server, agents));

/** A task's brief and a version of the notes name the chat that wrote them. */
export const briefIn = (server: Server, b: TaskBrief): TaskBrief => (local(server) || !b.chat ? b : { ...b, chat: keyOn(server, b.chat) });
export const notesIn = <N extends NotesVersion>(server: Server, n: N): N => (local(server) ? n : noteIn(server)(n));

/** The call of a board tool (an `rpc` event's params): the calling chat, its board and the board the call is for. The
 *  arguments are the agent's own and stay: what they name of a board is elements. */
export function toolCallIn<C extends { chat?: string; board?: string; target?: string }>(server: Server, call: C): C {
  if (local(server) || !call || typeof call !== "object") return call;
  return { ...call, chat: opt(server, call.chat), board: opt(server, call.board), target: opt(server, call.target) };
}

// ---- out: the server's own ids

/** A draft as its server takes it: the boards picked in it by their own ids. server: the entry id of the server the
 *  draft is saved on. A board of another server is left out of the picks: its id means nothing there, or names
 *  another board (the text keeps its "@name", which that server reads by name as any typed one). */
export function draftOut(server: Server, d: Draft): Draft {
  if (!d.mentions?.length) return d;
  const on = server || LOCAL_SERVER, own = d.mentions.filter((m) => serverOfKey(m.id) === on);
  const { mentions: _, ...rest } = d;
  return own.length ? { ...rest, mentions: own.map((m) => ({ ...m, id: ownId(m.id) })) } : rest;
}
