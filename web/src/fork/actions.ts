// What the fork UI does: labels, forks to a new chat, the tree popup, and moves between branches.
import { api } from "../api.ts";
import { getState, setState, upsertChat, setMove, isBusy, isLegacy, currentBranch, shownBranch, unsavedDraft } from "../store.ts";
import { showBranch } from "../conn.ts";
import { openChat } from "../Sidebar.tsx";
import { focusComposer } from "../Composer.tsx";
import { reportError } from "../Dialogs.tsx";
import { sessionEnd } from "../logic/forkpoints.ts";
import { afterBack, afterSent, moveDropped, moveValid, quoteLimit, quotesBefore } from "../logic/branchview.ts";
import { draftOf, hasDraft } from "../logic/drafts.ts";
import { mergeQuotes } from "../logic/quotes.ts";
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

/** What Back would leave in a chat's open composer: the chat's draft when the composer or the
 *  page goes away during a pending move. null: no open composer, no pending move, or one being sent. */
export function leftByBack(chat: string): Held | null {
  const s = getState(), move = s.moves[chat], b = composers.get(chat);
  if (!move || !b || isSending(chat)) return null;
  return afterBack(move, b.get(), quoteLimit(s.trees[chat], move.at, move.branch, currentBranch(s.chats[chat])));
}

/** A chat's composer, while it is mounted (null: it went away). One that goes away during a
 *  pending move leaves what it held with the move, and what Back would leave as the chat's unsaved
 *  draft: a reload, or a move dropped meanwhile, shows that. While the move is being sent it
 *  leaves only what it held, when that is anything (typed after the Send): the move's end makes
 *  it the chat's draft. One that opens on a chat with a pending move gets back what the one before
 *  it held; else it holds its saved draft, which is what Back returns to, and gets what the move
 *  put, or its draft without the quotes past the point (not while the move is being sent). */
export function registerComposer(chat: string, b: ComposerBridge | null): void {
  if (!b) {
    const h = leftByBack(chat), move = getState().moves[chat], typed = composers.get(chat)?.get();
    if (h) {
      setMove(chat, { ...getState().moves[chat], typed: composers.get(chat)!.get() });
      unsavedDraft(chat).write(draftOf(h.text, h.mentions, h.references));
    } else if (move && typed && isSending(chat) && hasDraft(draftOf(typed.text, typed.mentions, typed.references))) setMove(chat, { ...move, typed });
    composers.delete(chat);
    return;
  }
  composers.set(chat, b);
  const s = getState(), move = s.moves[chat];
  if (!move || (isSending(chat) && !move.typed)) return;
  const { typed, ...rest } = move;
  if (typed) { setMove(chat, rest); b.set(typed); return; }
  const held = b.get();
  if (move.put) setMove(chat, { ...move, held, put: putInto(b, move.put) });
  else {
    const kept = quotesBefore(held.references, quoteLimit(s.trees[chat], move.at, move.branch, currentBranch(s.chats[chat])));
    setMove(chat, { ...move, held, hid: held.references.filter((r) => !kept.includes(r)) });
    b.set({ ...held, references: kept });
  }
}

/** A Send failed after its composer went away (another chat was opened meanwhile): a notice
 *  tells of it, and h, what was not sent, is kept. A composer of the chat that is open again gets
 *  it: under a pending move as what it holds, else as the one that sent it would (the text into an
 *  empty box, the quotes with its own). With none open, a pending move (the failed Send left it)
 *  keeps h for the composer's next opening, and the chat's unsaved draft is what Back would leave
 *  of it. false: none open and no move, so h is the chat's draft again: the caller saves it. */
export function sendFailed(chat: string, h: Held, err: unknown): boolean {
  const s = getState(), c = s.chats[chat], move = s.moves[chat], b = composers.get(chat);
  if (!c) return true; // deleted meanwhile
  reportError(`Couldn't send your message in “${c.name || "the chat"}”`, err);
  if (b) { const now = b.get(); b.set(move ? h : { ...(now.text.trim() ? now : h), references: mergeQuotes(h.references, now.references) }); }
  else if (move) {
    const left = afterBack(move, h, quoteLimit(s.trees[chat], move.at, move.branch, currentBranch(c)));
    setMove(chat, { ...move, typed: h });
    unsavedDraft(chat).write(draftOf(left.text, left.mentions, left.references));
  }
  return !!b || !!move;
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
  const move: PendingMove = { branch: target.branch, at: target.at, new: target.new, held: prev?.held ?? composers.get(chat)?.get() ?? NOTHING, put: prev?.put ?? null, hid: prev?.hid };
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
    if (kept.length !== h.references.length) {
      const m = getState().moves[chat]; // Back gives back what this move and the ones before it took out
      setMove(chat, { ...m, hid: [...(m.hid ?? []), ...h.references.filter((r) => !kept.includes(r))] });
      b.set({ ...h, references: kept });
    }
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

/** Drops a chat's pending move, as Back, when the chat is archived, or the move is no longer
 *  possible on the list shown. Called after the chat's view or that list changed. A busy chat
 *  keeps its move: the turn may be one the app started, and Send waits for its end. */
export function checkMove(chat: string): void {
  const s = getState(), move = s.moves[chat], c = s.chats[chat];
  if (!move || !c) return;
  const items = s.items[chat]?.items;
  const valid = !items || moveValid(c.agent, items, move); // not loaded yet: judged when it is
  if (moveDropped({ archived: !!c.archived, valid, sending: isSending(chat) })) goBack(chat);
}

/** Sends to the point a chat shows: post gets the pending move as its target, or none. While the
 *  POST runs the move is sending: it still cuts the thread, Back does not undo it, and the list
 *  changing does not drop it (the server tells of the new branch before it answers). When the
 *  POST fails the move stays and the error is thrown on. */
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
 *  that is idle on the branch left ends the wait too. The draft that Branch and edit put aside
 *  was not sent: an empty composer gets it back. With no composer open (another chat was opened
 *  while it was sent) the chat's unsaved draft, which the composer opens with and saves, becomes
 *  what an open one would hold now: what the one that went away held (typed after the Send), or,
 *  when that was nothing, the draft given back. With neither that draft is cleared, so that one
 *  written when the chat was left earlier in the move does not bring the sent message back. */
export function moveSent(chat: string, fromView = false): void {
  const before = sent.get(chat);
  if (before === undefined) return;
  const s = getState(), c = s.chats[chat], move = s.moves[chat];
  if (move && c && currentBranch(c) === before && !(fromView && !isBusy(c.status))) return;
  sent.delete(chat);
  starts.delete(chat);
  setMove(chat, null);
  void showBranch(chat).catch(() => {});
  const b = composers.get(chat), now = b?.get() ?? move?.typed ?? NOTHING;
  const left = (move && afterSent(move, now, quoteLimit(s.trees[chat], move.at, move.branch, before))) || now;
  const d = draftOf(left.text, left.mentions, left.references);
  if (b) b.set(left); // what it holds is a draft again: the composer saves it from here on
  else unsavedDraft(chat).write(hasDraft(d) ? d : null);
}
