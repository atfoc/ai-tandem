// What a chat is doing, read from its view: its current branch's status and the two counts the
// server derives from that branch's subagents (subsRunning, subsOwed), and the chat's count of
// working branches; and from the records of its branches. DOM-free.
import type { BranchState, ChatView, Status } from "../types.ts";

type Doing = Pick<ChatView, "status" | "subsRunning" | "subsOwed">;

/** The agent is in a turn or waits for the user's approval: the chat takes no message. */
export const isBusy = (s: Status | undefined) => s === "thinking" || s === "writing" || s === "tool" || s === "approval";

/** The agent process of a fork that has had no message of its own is being started (again, on the
 *  model picked): for such a fork a busy status is never a turn, and a stop does nothing. */
export const starting = (c: Pick<ChatView, "status" | "fresh">): boolean => !!c.fresh && isBusy(c.status);

/** Some branch of the chat is in a turn or waits for approval. `working` counts those branches; it
 *  is absent when 0 and from an older server, and then the current branch's status tells. */
export const chatBusy = (c: Pick<ChatView, "status" | "working">): boolean => (c.working ?? 0) > 0 || isBusy(c.status);

/** One branch has work that a stop ends: its agent is busy, or the subagents it spawned still run
 *  while it waits for them. Results not sent yet do not count: they are kept, and go to the agent
 *  with the next message. */
const branchWorking = (b: Pick<Doing, "status" | "subsRunning">): boolean => isBusy(b.status) || (b.subsRunning ?? 0) > 0;

/** The branches a restart or a stop must reach, from a chat's records: the busy ones, and the idle
 *  ones whose subagents run (those are not in the chat's `working`). */
export const workingBranches = (states: readonly BranchState[]): BranchState[] => states.filter(branchWorking);

/** A chat's records by its id (statesOfChat over the store). */
export type StatesOf = (chat: string) => readonly Pick<BranchState, "status" | "subsRunning">[];

/** The chat has work that a restart, or archiving or deleting its board, ends: a branch's agent is
 *  busy, or subagents run on a branch. The subagents are read from the chat's records when they are
 *  given, and from the view (its current branch) too. */
export const isWorking = (c: Doing & Pick<ChatView, "working">, states?: ReturnType<StatesOf>): boolean =>
  chatBusy(c) || (c.subsRunning ?? 0) > 0 || !!states?.some(branchWorking);

/** The chats working on a board, archived ones left out: the ones the board's archive and delete
 *  confirmations warn about and stop. `statesOf` gives a chat's records, to count every branch. */
export function workingOn<C extends Doing & Pick<ChatView, "board" | "archived" | "working"> & { id?: string }>(chats: Iterable<C>, board: string, statesOf?: StatesOf): C[] {
  return [...chats].filter((c) => c.board === board && !c.archived && isWorking(c, c.id !== undefined ? statesOf?.(c.id) : undefined));
}

/** What the composer does in the state of the branch shown, from that branch's own status and
 *  subagents only: the chat's `working` (other branches) does not block it or show Stop. With a
 *  pending move the branch shown is the move's source, cut at its point.
 *  stop: the Stop control shows; for an idle chat whose subagents run, it stops them.
 *  blocked: no message can be sent, because the agent is busy; an idle chat takes one while its
 *  subagents run. A message that starts a new branch (o.newBranch: a move is pending) does not go
 *  to the busy branch: it is blocked only when the agent kind cannot branch from a source whose
 *  turn runs (o.liveFork false).
 *  esc: Esc stops, only while the agent is busy.
 *  While the agent of a fork without a message starts (starting), there is nothing to stop and no
 *  message is taken: no Stop, no Esc, blocked. A chat with no agent (agent "") takes none either,
 *  and has nothing to stop. */
export function composerControls(c: Doing & Pick<ChatView, "fresh"> & Partial<Pick<ChatView, "agent">>, o?: { newBranch: boolean; liveFork: boolean }): { stop: boolean; blocked: boolean; esc: boolean } {
  if (starting(c) || c.agent === "") return { stop: false, blocked: true, esc: false };
  const busy = isBusy(c.status);
  return { stop: branchWorking(c), blocked: o?.newBranch ? busy && !o.liveFork : busy, esc: busy };
}

/** What a chat's header says after its agent and folder: "Archived", "Disabled" for a chat of the
 *  old board connection (legacy), else status, the chat's status line. A chat with no agent
 *  (agent "") takes no message and runs nothing, so it has no status: "" leaves the header's
 *  "No agent" to say it. Neither has an unstarted chat whose server is not connected (off). */
export const headStatus = (c: Pick<ChatView, "agent" | "archived">, legacy: boolean, status: string, off = false): string =>
  c.archived ? "Archived" : legacy ? "Disabled" : c.agent === "" || off ? "" : status;

/** The title of the composer's Send: why no message is taken when blocked (composerControls), with
 *  noAgent the reason of a chat with no agent. */
export const sendTitle = (c: Pick<ChatView, "status" | "fresh"> & Partial<Pick<ChatView, "agent">>, blocked: boolean, noAgent: string): string =>
  !blocked ? "Send (Enter)" : c.agent === "" ? noAgent : starting(c) ? "The agent is starting" : "The agent is working";

/** A Send was refused: whether the chat is read again. 409: the branch the message goes to is busy
 *  by now. 429 `cap` (too many turns run), 409 `window` (the model chosen cannot take the
 *  conversation), and 409 `agent_missing` and `no_agent` (the server lacks the chat's agent, or the
 *  chat has none) are no stale state: the message stays in the box. */
const NOT_STALE = ["cap", "window", "agent_missing", "no_agent"];
export const refreshAfterRefusal = (status: number, code?: string): boolean => status === 409 && !NOT_STALE.includes(code ?? "");

/** "<Name> is not connected." / "No longer on <Name>": what the page says of a chat on another
 *  server (an entry of the server list) that cannot be reached, or that the server no longer has. */
export const notConnected = (name: string): string => `${name} is not connected`;
export const noLongerOn = (name: string): string => `No longer on ${name}`;

/** A sidebar row of a chat on another server: line and dot are those of a local chat (rowLine and
 *  dotState, labels.ts), so working, approval, finished and archived show the same.
 *  line: the server's name follows it; a chat its server no longer has (gone) says that alone.
 *  dot: "off" (grey) while the server is not connected or the chat is gone, whatever it did last.
 *  off, gone: the row's classes. title: the row's own title, "" for the usual one.
 *  A chat with no server (this computer's) is given back as it is. */
export function remoteRow<D extends string>(c: Pick<ChatView, "server" | "gone">, name: string, connected: boolean, line: string, dot: D):
  { line: string; dot: D | "off"; off: boolean; gone: boolean; title: string } {
  if (!c.server) return { line, dot, off: false, gone: false, title: "" };
  if (c.gone) return { line: noLongerOn(name), dot: "off", off: false, gone: true, title: noLongerOn(name) };
  const sub = line ? `${line} · ${name}` : name;
  return connected ? { line: sub, dot, off: false, gone: false, title: "" } : { line: sub, dot: "off", off: true, gone: false, title: notConnected(name) };
}
