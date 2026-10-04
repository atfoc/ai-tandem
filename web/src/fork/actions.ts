// What the fork UI does: labels, forks to a new chat, the tree popup, and moves between branches.
import { api } from "../api.ts";
import { getState, setState, upsertChat, setMove, isBusy, isLegacy, currentBranch, shownBranch } from "../store.ts";
import { showBranch } from "../conn.ts";
import { openChat } from "../Sidebar.tsx";
import { focusComposer } from "../Composer.tsx";
import { reportError } from "../Dialogs.tsx";
import { sessionEnd } from "../logic/forkpoints.ts";
import { afterBack, moveDropped, moveValid, quoteLimit, quotesBefore } from "../logic/branchview.ts";
import type { Held, Item, PendingMove, Target } from "../types.ts";

/** Sets (or, with blank text, removes) a label; puts the answer's labels into the loaded tree. An error is shown with reportError. */
export async function labelMessage(chat: string, branch: string, item: number, text: string): Promise<void> {
  try {
    const r = await api.setLabel(chat, branch, item, text);
    setState((s) => {
      const tree = s.trees[chat];
      return tree ? { trees: { ...s.trees, [chat]: { ...tree, labels: r.labels ?? [] } } } : {};
    });
  } catch (e) { reportError("Couldn't set the label", e); }
}

/** Forks to a new chat and opens it. message: the user message that becomes its draft. An error is shown with reportError. */
export async function forkChat(chat: string, branch: string, at: number, message?: number): Promise<void> {
  try {
    const c = await api.fork(chat, branch, at, message);
    upsertChat(c);
    openChat(c);
  } catch (e) { reportError("Couldn't fork the chat", e); }
}

/** Opens the tree popup, focused on a message when given. It only sets treeNav: TreePopup loads the tree and shows a failed load. */
export function openTree(chat: string, focus?: { branch: string; item: number }): void {
  setState({ treeNav: focus ? { chat, focus } : { chat } });
}

export function closeTree(): void {
  setState({ treeNav: null });
}

// ---- the pending move: a point chosen for the next message, kept in State.moves until Send or Back

type ComposerBridge = { get(): Held; set(h: Held): void };

/** The open composers, by chat id: what a move reads from them and puts into them. */
const composers = new Map<string, ComposerBridge>();
const NOTHING: Held = { text: "", mentions: [], references: [] };

/** Puts h into a composer and tells what it then holds: its box may write the text its own way,
 *  and Back compares with what the box says. */
function putInto(b: ComposerBridge, h: Held): Held {
  b.set(h);
  return { ...h, text: b.get().text };
}

/** A chat's composer, while it is mounted (null: it went away). One that opens on a chat with a
 *  pending move holds its saved draft, which is what Back returns to; it gets what the move put,
 *  or its draft without the quotes past the point. */
export function registerComposer(chat: string, b: ComposerBridge | null): void {
  if (!b) { composers.delete(chat); return; }
  composers.set(chat, b);
  const s = getState(), move = s.moves[chat];
  if (!move || isSending(chat)) return;
  const held = b.get();
  if (move.put) setMove(chat, { ...move, held, put: putInto(b, move.put) });
  else {
    setMove(chat, { ...move, held });
    b.set({ ...held, references: quotesBefore(held.references, quoteLimit(s.trees[chat], move.at, move.branch, currentBranch(s.chats[chat]))) });
  }
}

const starts = new Map<string, number>(); // by chat id: its newest startMove call, the one that goes on after its list loaded
let startSeq = 0;
const sending = new Set<string>();        // chats whose move's Send is in flight
const sent = new Map<string, string>();   // chats whose move's Send succeeded: the current branch before it, until the view names another

/** Whether a chat's pending move is being sent: nothing drops it, and Back does not undo it. */
const isSending = (chat: string) => sending.has(chat) || sent.has(chat);

/** Starts a pending move to target. edit: the index, in target.branch's items, of the user message
 *  to put into the composer (Branch and edit). Nothing happens in a busy, archived or legacy chat.
 *  The current branch's own end is no move: it undoes the pending one. */
export async function startMove(chat: string, target: Target, edit?: number): Promise<void> {
  const s = getState(), c = s.chats[chat];
  if (!c || isBusy(c.status) || c.archived || isLegacy(c) || isSending(chat)) return;
  const prev = s.moves[chat];
  const current = currentBranch(c), before = shownBranch(s, chat);
  const ownEnd = (items: Item[] | undefined) => target.branch === current && !target.new && !!items && sessionEnd(items, target.at);
  if (before === current && ownEnd(s.items[chat]?.items)) { goBack(chat); return; }

  // Back returns to before the first move, as long as the composer holds what the moves put.
  const move: PendingMove = { branch: target.branch, at: target.at, new: target.new, held: prev?.held ?? composers.get(chat)?.get() ?? NOTHING, put: prev?.put ?? null };
  const n = ++startSeq;
  starts.set(chat, n);
  setMove(chat, move);
  const mine = () => starts.get(chat) === n && !!getState().moves[chat];
  try {
    await showBranch(chat);
    if (mine() && !getState().items[chat]) throw new Error("its messages did not load");
  } catch (e) {
    if (mine()) { goBack(chat); reportError("Couldn't open that branch", e); }
    return;
  }
  if (!mine()) return; // taken back, dropped or replaced meanwhile
  const items = getState().items[chat].items;
  if (ownEnd(items)) { goBack(chat); return; }
  checkMove(chat);
  if (!mine()) return;

  const b = composers.get(chat);
  if (edit !== undefined) {
    const put: Held = { text: items[edit]?.text ?? "", mentions: [], references: items[edit]?.references ?? [] };
    setMove(chat, { ...getState().moves[chat], put: b ? putInto(b, put) : put });
  } else if (b) {
    // The composer's quotes point into the thread shown before: beyond what the two share, or past the point, an index names another message.
    const h = b.get();
    const kept = quotesBefore(h.references, quoteLimit(getState().trees[chat], target.at, target.branch, before));
    if (kept.length !== h.references.length) b.set({ ...h, references: kept });
  }
  focusComposer();
}

/** Undoes the pending move (Back), and drops it when it can no longer be sent: the chat shows its
 *  current branch again, and the composer holds what it held before the move, or what was typed
 *  meanwhile without the quotes that name another message there. A move being sent stays. */
export function goBack(chat: string): void {
  const s = getState(), move = s.moves[chat];
  if (!move || isSending(chat)) return;
  starts.delete(chat);
  setMove(chat, null);
  void showBranch(chat).catch(() => {});
  const b = composers.get(chat);
  if (b) b.set(afterBack(move, b.get(), quoteLimit(s.trees[chat], move.at, move.branch, currentBranch(s.chats[chat]))));
}

/** Drops every pending move, as Back: a snapshot replaces the state they were chosen in. */
export function dropMoves(): void {
  for (const chat of sent.keys()) setMove(chat, null); // sent: it ends without Back's restore
  sent.clear();
  for (const chat of Object.keys(getState().moves)) goBack(chat);
}

/** Drops a chat's pending move, as Back, when the chat is busy or archived, or the move is no
 *  longer possible on the list shown. Called after the chat's view or that list changed. */
export function checkMove(chat: string): void {
  const s = getState(), move = s.moves[chat], c = s.chats[chat];
  if (!move || !c) return;
  const items = s.items[chat]?.items;
  const valid = !items || moveValid(c.agent, items, move); // not loaded yet: judged when it is
  if (moveDropped({ busy: isBusy(c.status) || !!c.archived, valid, sending: isSending(chat) })) goBack(chat);
}

/** Sends to the point a chat shows: post gets the pending move as its target, or none. While the
 *  POST runs the move is sending: it still cuts the thread, and neither the chat turning busy nor
 *  the list changing drops it (the server tells both before it answers). When the POST fails the
 *  move stays and the error is thrown on. */
export async function sendAt(chat: string, post: (target?: Target) => Promise<unknown>): Promise<void> {
  const s = getState(), move = s.moves[chat];
  if (!move) { await post(); return; }
  const before = currentBranch(s.chats[chat]);
  sending.add(chat);
  try { await post({ branch: move.branch, at: move.at, new: move.new }); }
  finally { sending.delete(chat); }
  sent.set(chat, before);
  moveSent(chat);
}

/** Ends a sent move without Back's restore, once the chat's view names another branch than before
 *  the Send (the `chat` event comes before or after the POST's answer): the thread stays cut
 *  until then, so the branch left is never shown whole. fromView: called for a `chat` event; one
 *  that is idle on the branch left ends the wait too. */
export function moveSent(chat: string, fromView = false): void {
  const before = sent.get(chat);
  if (before === undefined) return;
  const s = getState(), c = s.chats[chat];
  if (s.moves[chat] && c && currentBranch(c) === before && !(fromView && !isBusy(c.status))) return;
  sent.delete(chat);
  starts.delete(chat);
  setMove(chat, null);
  void showBranch(chat).catch(() => {});
  const b = composers.get(chat);
  if (b) b.set(b.get()); // what it holds is a draft again: the composer saves it from here on
}
