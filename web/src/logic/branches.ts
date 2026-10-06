// A chat's branches as its view tells them: how many it has, which is current (the one last sent
// to, on which the chat opens), and which one the thread shows. A view without the fields is a
// chat that was never split.
import { MAIN, type BranchState, type ChatView, type PendingMove } from "../types.ts";

export const branchCount = (c?: ChatView) => c?.branches ?? 1;
export const currentBranch = (c?: ChatView) => c?.branch ?? MAIN;

/** The branch whose items a chat shows: the pending move's, else the one the chat is on in this
 *  client (viewed), else, as long as it is on none of its own, the server's current one. */
export const shownBranchOf = (move: PendingMove | undefined, c: ChatView | undefined, viewed?: string) => move?.branch ?? viewed ?? currentBranch(c);

// ---- per-branch state: a branch's session state is kept under its key, and a chat's view is
// shown with the state of the branch on screen.

export type BranchKey = string & { readonly __branchKey: unique symbol };
/** The key of a branch's state: "<chat>:<branch>"; a missing branch is main. */
export const branchKey = (chat: string, branch?: string): BranchKey => `${chat}:${branch || MAIN}` as BranchKey;
/** Whether a key (a BranchKey or a SubKey) belongs to a chat. */
export const keyOfChat = (key: string, chat: string): boolean => key.startsWith(chat + ":");

const fromView = new WeakMap<ChatView, BranchState>();

/** The current branch's record from the view's own session fields. The same view gives the same
 *  record, which is how viewOf knows it. */
export function stateFromView(c: ChatView): BranchState {
  let st = fromView.get(c);
  if (st) return st;
  st = { chat: c.id, branch: currentBranch(c), cwd: c.cwd, model: c.model, locked: c.locked, usage: c.usage, status: c.status };
  if (c.effort !== undefined) st.effort = c.effort;
  if (c.statusTool !== undefined) st.statusTool = c.statusTool;
  if (c.error !== undefined) st.error = c.error;
  if (c.folderMissing !== undefined) st.folderMissing = c.folderMissing;
  if (c.fresh !== undefined) st.fresh = c.fresh;
  if (c.subsRunning !== undefined) st.subsRunning = c.subsRunning;
  if (c.subsOwed !== undefined) st.subsOwed = c.subsOwed;
  if (c.draft !== undefined) st.draft = c.draft;
  fromView.set(c, st);
  return st;
}

/** A branch's record: the one kept, else the view's own for the current branch (a server that
 *  sends no records), else none. */
export function stateOf(states: Record<BranchKey, BranchState>, c: ChatView | undefined, branch?: string): BranchState | undefined {
  if (!c) return undefined;
  const b = branch || MAIN;
  return states[branchKey(c.id, b)] ?? (b === currentBranch(c) ? stateFromView(c) : undefined);
}

const views = new WeakMap<ChatView, WeakMap<BranchState, ChatView>>();
const bare = new WeakMap<ChatView, ChatView>();

/** A chat's view with the session fields of one branch, st being what stateOf gave for it. The
 *  view's own record gives the view itself. No record is a branch not loaded yet, shown ready,
 *  locked and empty until its items bring the record. The same view and record give the same
 *  object: a store selector must not make a new one on every call. */
export function viewOf(c: ChatView, st: BranchState | undefined): ChatView;
export function viewOf(c: ChatView | undefined, st: BranchState | undefined): ChatView | undefined;
export function viewOf(c: ChatView | undefined, st: BranchState | undefined): ChatView | undefined {
  if (!c) return undefined;
  if (!st) {
    let v = bare.get(c);
    if (!v) {
      v = { ...c, locked: true, status: "ready", usage: { ctxIn: 0, ctxOut: 0, ctxWindow: c.usage.ctxWindow, turns: 0 }, subsRunning: 0, subsOwed: 0 };
      delete v.statusTool; delete v.error; delete v.folderMissing; delete v.fresh; delete v.draft;
      bare.set(c, v);
    }
    return v;
  }
  if (st === fromView.get(c)) return c;
  let of = views.get(c);
  if (!of) views.set(c, of = new WeakMap());
  let v = of.get(st);
  if (!v) {
    v = { ...c, cwd: st.cwd, model: st.model, effort: st.effort, locked: st.locked, usage: st.usage, status: st.status,
      statusTool: st.statusTool, error: st.error, folderMissing: st.folderMissing, fresh: st.fresh,
      subsRunning: st.subsRunning, subsOwed: st.subsOwed, draft: st.draft };
    of.set(st, v);
  }
  return v;
}
