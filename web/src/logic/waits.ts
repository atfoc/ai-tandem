// What is on its way in a chat's fork flows: a message that starts a new branch, the first message
// of a fork, a branch being opened or loaded, a fork being made, a fork's agent starting again on
// another model. The waits are kept per chat in the store (State.waits), so that every part of the
// page shows the same thing. Decided here: how a wait begins, goes on and ends, what the thread
// draws for it, and which controls it holds, in which words. fork/actions.ts and conn.ts tell of
// the calls; the components only draw. DOM-free.

import type { Item, Reference } from "../types.ts";
import { sendingLine } from "./chatserver.ts";

/** A message on its way, with what the thread shows of it: its text and quotes.
 *  kind "branch": a message that starts a new branch, from Send until the new branch's list is here.
 *    sending: its POST runs. unnamed: the POST was answered without the branch's name (an older
 *    server), and the chat's view will name it; `before` is the chat's current branch before the
 *    Send. loading: the branch is known (`to`) and its list is being fetched; `kept` is the history
 *    drawn until it is here.
 *  kind "first": the first message of a fork that has had none of its own, whose agent may have to
 *    be started before it is taken. sending: its POST runs. taken: it was answered, and the thread
 *    of its branch does not have the message yet.
 *  branch: the branch whose thread is on screen while it is sent (a move's source, the fork's own);
 *  at: the count of that thread's items the message comes after. */
export type SendWait = {
  id: number; kind: "branch" | "first"; phase: "sending" | "unnamed" | "loading" | "taken";
  text: string; references: Reference[]; branch: string; at: number;
  before?: string; to?: string; kept?: readonly Item[];
};
/** A branch whose list is fetched before the chat shows it or a point of it (a move from the tree). */
export type OpenWait = { id: number; branch: string };
/** A fork of the chat that is being made. */
export type ForkWait = { id: number };
/** A model or effort picked on a fork without a message of its own: its agent is started again on
 *  that choice, on the fork's branch. label: what the page calls the choice, by the catalog's names. */
export type PickWait = { id: number; branch: string; model: string; effort?: string; label: string };

/** What is on its way in one chat. Each kind is one wait at most; loads: the branches whose list
 *  is being fetched. */
export type ChatWaits = { send?: SendWait; open?: OpenWait; fork?: ForkWait; pick?: PickWait; loads?: readonly string[] };
export type Waits = Record<string, ChatWaits>;
export type WaitKind = "send" | "open" | "fork" | "pick";

// ---- how a wait begins, goes on and ends. Each gives the same object when nothing changed.

const put = (all: Waits, chat: string, w: ChatWaits): Waits => {
  if (Object.keys(w).length) return { ...all, [chat]: w };
  if (!(chat in all)) return all;
  const { [chat]: _, ...rest } = all;
  return rest;
};

/** A wait begins, in the place of one of its kind that the chat had: that one's call has no wait
 *  to end any more. */
export function begun<K extends WaitKind>(all: Waits, chat: string, kind: K, w: NonNullable<ChatWaits[K]>): Waits {
  return { ...all, [chat]: { ...all[chat], [kind]: w } };
}

/** A wait ends: the one with this id, which the call that began it holds. A call that ends later
 *  than the wait of its kind that came after it ends nothing, and neither does the end of a call
 *  of another kind or another chat. */
export function ended(all: Waits, chat: string, kind: WaitKind, id: number): Waits {
  const w = all[chat];
  if (w?.[kind]?.id !== id) return all;
  const { [kind]: _, ...rest } = w;
  return put(all, chat, rest);
}

/** A chat's message on its way goes on: next gives what it is from now, or null when it has ended.
 *  Nothing happens to another one than the one with this id. */
export function stepped(all: Waits, chat: string, id: number, next: (w: SendWait) => SendWait | null): Waits {
  const w = all[chat]?.send;
  if (w?.id !== id) return all;
  const now = next(w);
  return now ? begun(all, chat, "send", now) : ended(all, chat, "send", id);
}

/** A branch send was answered without the branch's name: it goes on until the chat's view names
 *  another current branch than before. */
export const unnamed = (before: string) => (w: SendWait): SendWait => ({ ...w, phase: "unnamed", before });

/** A branch send's branch is known. items: the list of the branch the thread showed (the move's
 *  source), when it is kept: the part before the point stays on screen until the new branch's own
 *  list is here. */
export const loading = (to: string, items: readonly Item[] | undefined) => (w: SendWait): SendWait => {
  const { before: _, ...rest } = w;
  return { ...rest, phase: "loading", to, kept: (items ?? []).slice(0, w.at) };
};

/** A fork's first message was taken. count: how many items the thread of its branch has now,
 *  undefined for one that is not kept (it is read again, with the message). The message stays on
 *  screen until the thread has it. */
export const taken = (count: number | undefined) => (w: SendWait): SendWait | null =>
  count !== undefined && count > w.at ? null : { ...w, phase: "taken" };

/** A thread changed: a fork's first message that was taken ends once the thread of its branch has
 *  it. count: the items of that thread now. */
export function afterThread(all: Waits, chat: string, branch: string, count: number): Waits {
  const w = all[chat]?.send;
  return w && w.kind === "first" && w.phase === "taken" && w.branch === branch && count > w.at ? ended(all, chat, "send", w.id) : all;
}

/** The fetch of a branch's list begins (on) or has ended. */
export function withLoad(all: Waits, chat: string, branch: string, on: boolean): Waits {
  const w = all[chat] ?? {}, had = w.loads ?? [];
  if (had.includes(branch) === on) return all;
  const { loads: _, ...rest } = w;
  const loads = on ? [...had, branch] : had.filter((b) => b !== branch);
  return put(all, chat, loads.length ? { ...rest, loads } : rest);
}

/** Every fetch of a chat's lists was given up (conn.ts forgetThread): none of them will tell of its end. */
export function withoutLoads(all: Waits, chat: string): Waits {
  const w = all[chat];
  if (!w?.loads) return all;
  const { loads: _, ...rest } = w;
  return put(all, chat, rest);
}

/** The chat is gone: its waits go with it. */
export function withoutChat(all: Waits, chat: string): Waits {
  return put(all, chat, {});
}

// ---- what is held, and in which words

export const SENDING = "Your message is being sent";
/** Why a control does nothing while a message that starts a new branch waits for its answer. */
export const SEND_HELD = `${SENDING}: this works again once the server has answered`;
/** Why Fork does nothing while a fork of the chat is being made. */
export const FORK_HELD = "A fork of this chat is being made: this works again once it is there";

/** Whether a chat's pending move is being sent: from Send until the new branch is known. Nothing
 *  drops the move then, Back does not undo it, and the controls that would change where the
 *  message goes are held. */
export const sendHeld = (w: ChatWaits | undefined): boolean =>
  w?.send?.kind === "branch" && (w.send.phase === "sending" || w.send.phase === "unnamed");

/** A control of a chat that a wait can hold.
 *  back: the banner's Back. alert: the header's "Approval needed on…" and "Error on…", which put
 *  the chat on another branch. open: opening a row of the tree. branch, branchEdit: a message's
 *  "Branch" and "Branch and edit", and the tree's. choice: the model and effort pickers. send: Send
 *  and Enter. fork, forkEdit: "Fork" and "Fork and edit". label, stop, tree: Label, a branch's
 *  Stop, and what opens the tree ("N other branches working"): never held. */
export type Control = "back" | "alert" | "open" | "branch" | "branchEdit" | "choice" | "send" | "fork" | "forkEdit" | "label" | "stop" | "tree";

const BY_SEND: readonly Control[] = ["back", "alert", "open", "branch", "branchEdit", "choice", "send"];
const BY_FORK: readonly Control[] = ["fork", "forkEdit"];

/** Why a control of a chat does nothing now: it is drawn disabled, with this as its title. "" for
 *  one that is live. A fork asked for during a branch send is not held by the send, nor a branch
 *  by a fork. */
export function heldReason(w: ChatWaits | undefined, control: Control): string {
  if (sendHeld(w) && BY_SEND.includes(control)) return SEND_HELD;
  if (w?.fork && BY_FORK.includes(control)) return FORK_HELD;
  return "";
}

/** The choice a fork's agent is being started on, for the composer of `branch`; null with none. */
export const pickOn = (w: ChatWaits | undefined, branch: string): PickWait | null => (w?.pick?.branch === branch ? w.pick : null);

/** What Send says while a fork's agent starts on a model. label: the model's, with its effort. */
export const startingOn = (label: string): string => `The agent is starting on ${label}`;

/** What a wait makes of the Send of `branch`'s composer: it takes no press, says why (title), and
 *  shows a spinner in place of its arrow while a message is on its way (spin). null: no wait
 *  concerns it. While a fork's agent is being started on a choice, Send names that choice. */
export function sendWait(w: ChatWaits | undefined, branch: string): { spin: boolean; title: string } | null {
  const s = w?.send;
  if (sendHeld(w) || (s?.kind === "first" && s.phase === "sending" && s.branch === branch)) return { spin: true, title: SENDING };
  const p = pickOn(w, branch);
  return p ? { spin: false, title: startingOn(p.label) } : null;
}

// ---- what the thread draws

export const STARTING_LINE = "Starting the agent…";
export const LOADING_LINE = "Loading…";
export const OPENING_LINE = "Opening the branch…";
export const FORKING_LINE = "Making a fork of this chat…";

export type WaitLine = { id: "send" | "load" | "open" | "pick" | "fork"; text: string };

/** What a chat's thread draws for its waits.
 *  kept: the history drawn, read-only, in the place of a list that is not here yet; null: the
 *    thread draws its own items.
 *  sent: the message on its way, drawn after the items in the pending look.
 *  lines: the lines at the thread's foot, each with dots.
 *  quiet: the status line of the branch shown is left out: that branch is the source of a new one,
 *    and the line of the message says what goes on. */
export type ThreadWait = { kept: readonly Item[] | null; sent: { text: string; references: Reference[] } | null; lines: WaitLine[]; quiet: boolean };

const NOTHING: ThreadWait = { kept: null, sent: null, lines: [], quiet: false };

/** What the thread of a chat draws for its waits (ThreadWait).
 *  shown: the branch whose items the chat shows; loaded: its list is kept; count: how many items
 *  it has; move: a move is pending (the thread is cut at its point); busy: the branch shown is in
 *  a turn, and the thread says so by itself; server: the name of the chat's server when that is
 *  another one, "" for this computer; archived: the chat takes no message, and shows nothing of
 *  one that was on its way or of a fork.
 *  A branch send shows the message after the cut thread, with the line that the agent is starting
 *  (on another server: that it is being sent there), until its answer; from then until the new
 *  branch's list is here, the same history and the message, in the place of that list.
 *  A fork's first message shows after the copied history until the thread has it.
 *  A branch that is being opened, a list that is being fetched and a fork that is being made are a
 *  line each. A message on its way has the foot to itself, but for the fork's line.
 *  A fork's agent that is being started on another model has the line a fork says of its start by
 *  itself, where the fork does not (an agent kind that tells nothing of the start): the thread
 *  says "Starting the agent…" once, whatever the kind. */
export function threadWait(w: ChatWaits | undefined, t: { shown: string; loaded: boolean; count: number; move: boolean; busy: boolean; server?: string; archived?: boolean }): ThreadWait {
  if (!w) return NOTHING;
  const lines: WaitLine[] = [], s = t.archived ? undefined : w.send;
  let kept: ThreadWait["kept"] = null, sent: ThreadWait["sent"] = null, quiet = false;
  const message = (m: SendWait) => ({ text: m.text, references: m.references });
  if (s?.kind === "branch" && s.phase === "loading") {
    if (!t.loaded && t.shown === s.to) {
      kept = s.kept ?? [];
      sent = message(s);
      if (!t.busy) lines.push({ id: "load", text: LOADING_LINE });
    }
  } else if (s?.kind === "branch") {
    if (t.move && t.shown === s.branch) {
      sent = message(s);
      quiet = true;
      lines.push({ id: "send", text: t.server ? sendingLine(t.server) : STARTING_LINE });
    }
  } else if (s && !t.move && t.loaded && t.shown === s.branch && t.count <= s.at) sent = message(s);
  if (!sent) {
    if (w.open && !t.archived) lines.push({ id: "open", text: OPENING_LINE });
    else if (!t.loaded && w.loads?.includes(t.shown)) lines.push({ id: "load", text: LOADING_LINE });
    else if (pickOn(w, t.shown) && t.loaded && !t.busy && !t.archived) lines.push({ id: "pick", text: STARTING_LINE });
  }
  if (w.fork && !t.archived) lines.push({ id: "fork", text: FORKING_LINE });
  return kept || sent || lines.length ? { kept, sent, lines, quiet } : NOTHING;
}
