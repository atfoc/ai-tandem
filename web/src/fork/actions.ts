// What the fork UI does: labels, forks to a new chat, the tree popup, and moves between branches.
import { api } from "../api.ts";
import { getState, setState, upsertChat, setMove, setShown, isBusy, isLegacy, branchState, currentBranch, shownBranch, shownView, viewedBranch, threadAt, threadOf, unsavedDraft } from "../store.ts";
import { keepBranch, showBranch } from "../conn.ts";
import { openChat } from "../Sidebar.tsx";
import { focusComposer, saveDraft } from "../Composer.tsx";
import { reportError } from "../Dialogs.tsx";
import { LIVE_FORK, sessionEnd } from "../logic/forkpoints.ts";
import { afterBack, afterSent, moveDropped, moveValid, quoteLimit, quotesBefore } from "../logic/branchview.ts";
import { draftOf, draftsAfterSent, hasDraft, heldOf, sameDraft } from "../logic/drafts.ts";
import { mergeQuotes } from "../logic/quotes.ts";
import { branchKey } from "../logic/branches.ts";
import { sameChoice, withModel, type Choice } from "../logic/models.ts";
import { catalogFor } from "../logic/agentlist.ts";
import type { Draft, Held, PendingMove, Target } from "../types.ts";
import { serverOf } from "../logic/serverlists.ts";

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

// ---- the branch a chat is on here (State.shown), and the pending move: a point chosen for the
// next message, kept in State.moves until Send or Back. A move is always to a branch that is not
// there yet; its `from` is the branch the chat is on, whose draft the composer holds.

type ComposerBridge = { get(): Held; set(h: Held): void };

/** The open composers, by chat id: what a move reads from them and puts into them. A chat has
 *  one, of the branch it is on, whose draft it holds. */
const composers = new Map<string, { branch: string; b: ComposerBridge }>();
/** The open composer of a chat's branch; none when the chat's composer is another branch's. */
const composerOf = (chat: string, branch: string): ComposerBridge | undefined => {
  const open = composers.get(chat);
  return open?.branch === branch ? open.b : undefined;
};
const NOTHING: Held = { text: "", mentions: [], references: [] };

/** Puts h into a composer and tells what it then holds: its box may write the text its own way,
 *  and Back compares with what the box says. */
function putInto(b: ComposerBridge, h: Held): Held {
  b.set(h);
  return { ...h, text: b.get().text };
}

/** The count below which an index names the same message at a move's point and in the branch it
 *  was started on, which Back returns to. */
const backLimit = (chat: string, move: PendingMove) => quoteLimit(getState().trees[chat], move.at, move.branch, move.from);

/** What Back would leave in the open composer of a chat's branch: the branch's draft when the
 *  composer or the page goes away during a pending move. null: not the branch the move was
 *  started on, no open composer of it, no pending move, or one being sent. */
export function leftByBack(chat: string, branch: string): Held | null {
  const move = getState().moves[chat], b = composerOf(chat, branch);
  if (!move || move.from !== branch || !b || isSending(chat)) return null;
  return afterBack(move, b.get(), backLimit(chat, move));
}

/** The composer of a chat's branch, while it is mounted (null: it went away). A pending move
 *  concerns only the composer of the branch it was started on (move.from): one of another branch
 *  opens with its own draft and is left alone. One that goes away during a pending move leaves
 *  what it held with the move, and what Back would leave as its branch's unsaved draft: a reload,
 *  or a move dropped meanwhile, shows that. While the move is being sent it leaves only what it
 *  held, when that is anything (typed after the Send): the move's end makes it the draft of the
 *  branch sent to. One that opens on a chat with a pending move gets back what the one before it
 *  held; else it holds its saved draft, which is what Back returns to, and gets what the move
 *  put, or its draft without the quotes past the point (not while the move is being sent). */
export function registerComposer(chat: string, branch: string, b: ComposerBridge | null): void {
  if (!b) {
    const open = composers.get(chat);
    if (open?.branch !== branch) return; // the chat has another branch's composer by now
    const h = leftByBack(chat, branch), move = getState().moves[chat], typed = open.b.get();
    if (h) {
      setMove(chat, { ...move, typed });
      unsavedDraft(chat, branch).write(draftOf(h.text, h.mentions, h.references));
    } else if (move?.from === branch && isSending(chat) && hasDraft(draftOf(typed.text, typed.mentions, typed.references))) setMove(chat, { ...move, typed });
    composers.delete(chat);
    return;
  }
  composers.set(chat, { branch, b });
  const move = getState().moves[chat];
  if (!move || move.from !== branch || (isSending(chat) && !move.typed)) return;
  const { typed, ...rest } = move;
  if (typed) { setMove(chat, rest); b.set(typed); return; }
  const held = b.get();
  if (move.put) setMove(chat, { ...move, held, put: putInto(b, move.put) });
  else {
    const kept = quotesBefore(held.references, backLimit(chat, move));
    setMove(chat, { ...move, held, hid: held.references.filter((r) => !kept.includes(r)) });
    b.set({ ...held, references: kept });
  }
}

/** A Send failed after its composer went away (another chat was opened meanwhile): a notice
 *  tells of it, and h, what was not sent, is kept. branch: the one of the composer that sent it.
 *  Only a composer of that branch that is open again gets h: under a pending move as what it
 *  holds, else as the one that sent it would (the text into an empty box, the quotes with its
 *  own). An open composer of another branch counts as none: it and its draft are left alone.
 *  With none open, a pending move started on the branch (the failed Send left it) keeps h for the
 *  composer's next opening, and the branch's unsaved draft is what Back would leave of it.
 *  false: none open and no such move, so h is the draft of the branch it was typed on again: the
 *  caller, that branch's composer, saves it. */
export function sendFailed(chat: string, branch: string, h: Held, err: unknown): boolean {
  const s = getState(), c = s.chats[chat], b = composerOf(chat, branch);
  if (!c) return true; // deleted meanwhile
  const move = s.moves[chat]?.from === branch ? s.moves[chat] : undefined;
  reportError(`Couldn't send your message in “${c.name || "the chat"}”`, err);
  if (b) { const now = b.get(); b.set(move ? h : { ...(now.text.trim() ? now : h), references: mergeQuotes(h.references, now.references) }); }
  else if (move) {
    const left = afterBack(move, h, backLimit(chat, move));
    setMove(chat, { ...move, typed: h });
    unsavedDraft(chat, move.from).write(draftOf(left.text, left.mentions, left.references));
  }
  return !!b || !!move;
}

const starts = new Map<string, number>(); // by chat id: its newest startMove or viewBranch call, the one that goes on after its list loaded
let startSeq = 0;
const sending = new Set<string>();        // chats whose move's Send is in flight
const sent = new Map<string, string>();   // chats whose move's Send a server answered without naming the branch, until the view names another current branch: the one before the Send

/** Whether a chat's pending move is being sent: nothing drops it, and Back does not undo it. */
export const isSending = (chat: string) => sending.has(chat) || sent.has(chat);

/** Puts a chat on another of its branches: the thread, the composer with that branch's draft and
 *  the session state shown are that branch's from then on. It is this client's state alone:
 *  nothing is sent but, the first time, the fetch of the branch's list. A pending move is undone
 *  first (Back); nothing happens while one is being sent. When the list cannot be fetched the
 *  chat is on the branch it was on again, and the error is shown with reportError. */
export async function viewBranch(chat: string, branch: string): Promise<void> {
  if (!getState().chats[chat] || isSending(chat)) return;
  goBack(chat);
  const before = viewedBranch(getState(), chat);
  const n = ++startSeq;
  starts.set(chat, n);
  setShown(chat, branch);
  try {
    await showBranch(chat);
    const s = getState();
    if (starts.get(chat) === n && s.sel.chat === chat && !threadOf(s, chat)) throw new Error("its messages did not load");
  } catch (e) {
    const s = getState();
    if (starts.get(chat) !== n || !s.chats[chat] || s.moves[chat] || s.shown[chat] !== branch) return; // another branch or a move was chosen meanwhile
    if (before !== branch) {
      setShown(chat, before);
      void showBranch(chat).catch(() => {});
    }
    reportError("Couldn't open that branch", e);
  }
}

/** Starts a pending move to target. edit: the index, in target.branch's items, of the user message
 *  to put into the composer (Branch and edit). Nothing happens in an archived or legacy chat.
 *  A target that asks for no new branch at its branch's end is no move: that branch is looked at
 *  (viewBranch), and the next message carries it on. Every other target is a move to a new
 *  branch, so a pending move never names a branch that is there as where the message goes.
 *  What other branches do does not matter, and the target's own branch may be in a turn when the
 *  agent kind can branch from a running source (LIVE_FORK): the point must then be a finished
 *  boundary, as checkMove judges once the list is there. */
export async function startMove(chat: string, target: Target, edit?: number): Promise<void> {
  const ok = () => { const c = getState().chats[chat]; return !!c && !c.archived && !isLegacy(c) && !isSending(chat); };
  const live = () => { const a = getState().chats[chat]!.agent; return (!!a && LIVE_FORK[a]) || !sourceBusy(chat, target.branch); };
  if (!ok()) return;
  const n = ++startSeq;
  starts.set(chat, n);
  if (!target.new) {
    // Whether the point is the branch's end is read from its items: they are fetched for it when not kept.
    const key = branchKey(chat, target.branch);
    try {
      await keepBranch(chat, target.branch);
      if (starts.get(chat) === n && getState().chats[chat] && !threadAt(getState(), key)) throw new Error("its messages did not load");
    } catch (e) {
      if (starts.get(chat) === n) reportError("Couldn't open that branch", e);
      return;
    }
    if (starts.get(chat) !== n || !ok()) return; // another point was chosen, or the chat changed meanwhile
    if (sessionEnd(threadAt(getState(), key)!.items, target.at)) { await viewBranch(chat, target.branch); focusComposer(); return; }
  }
  if (!live()) return; // this agent kind branches only from a branch at rest
  const s = getState(), prev = s.moves[chat];
  const from = viewedBranch(s, chat), before = shownBranch(s, chat);

  // Back returns to before the first move, as long as the composer holds what the moves put.
  const move: PendingMove = { branch: target.branch, at: target.at, new: true, from, held: prev?.held ?? composerOf(chat, from)?.get() ?? NOTHING, put: prev?.put ?? null, hid: prev?.hid };
  // The model and effort chosen for another point of the same branch stay: its source is the same.
  if (prev?.model && prev.branch === target.branch) { move.model = prev.model; if (prev.effort) move.effort = prev.effort; }
  setMove(chat, move);
  const mine = () => starts.get(chat) === n && !!getState().moves[chat];
  try {
    await showBranch(chat);
    if (mine() && !threadOf(getState(), chat)) throw new Error("its messages did not load");
  } catch (e) {
    if (mine()) { goBack(chat); reportError("Couldn't open that branch", e); }
    return;
  }
  if (!mine()) return; // taken back, dropped or replaced meanwhile
  const items = threadOf(getState(), chat)!.items;
  checkMove(chat);
  if (!mine()) return;

  const b = composerOf(chat, from);
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

/** Sets the model and effort the pending move's new branch starts on: they go with the move's
 *  message (sendAt) and end with the move, whatever ends it. null, or the choice of the move's
 *  source (the branch shown during the move), is no choice: the new branch then starts on its
 *  source's. A model alone is posted alone, and the server then takes the effort from the source's
 *  (withModel), not from the pick before: that effort is the one held, so what is shown is what
 *  the branch gets. Nothing is sent, and nothing happens without a pending move or while it is being sent. */
export function setMoveChoice(chat: string, choice: Choice | null): void {
  const s = getState(), move = s.moves[chat];
  if (!move || isSending(chat)) return;
  const source = shownView(s, chat);
  const { model: _, effort: __, ...rest } = move;
  if (choice && !choice.effort && source) {
    const id = choice.model, cat = catalogFor(s, serverOf(s.chats[chat]), s.chats[chat]?.agent ?? "");
    if (cat?.models.some((m) => m.id === id)) choice = withModel(source, id, cat);
  }
  if (!choice || (source && sameChoice(choice, source))) { if (move.model !== undefined || move.effort !== undefined) setMove(chat, rest); return; }
  setMove(chat, choice.effort ? { ...rest, model: choice.model, effort: choice.effort } : { ...rest, model: choice.model });
}

/** Undoes the pending move (Back), and drops it when it can no longer be sent: the chat shows the
 *  branch it is on again, and that branch's composer holds what it held before the move, or what
 *  was typed meanwhile without the quotes that name another message there. A move being sent
 *  stays. */
export function goBack(chat: string): void {
  const move = getState().moves[chat];
  if (!move || isSending(chat)) return;
  starts.delete(chat);
  const limit = backLimit(chat, move);
  setMove(chat, null);
  void showBranch(chat).catch(() => {});
  const b = composerOf(chat, move.from);
  if (b) b.set(afterBack(move, b.get(), limit));
}

/** Drops every pending move, as Back: a snapshot replaces the state they were chosen in. One
 *  whose POST runs stays; the ids of the chats of those are returned, for applySnapshot. */
export function dropMoves(): string[] {
  endSent();
  for (const chat of Object.keys(getState().moves)) goBack(chat);
  return Object.keys(getState().moves);
}

/** Whether a branch of a chat is in a turn or waits for approval, by its own record. */
const sourceBusy = (chat: string, branch: string) => isBusy(branchState(getState(), chat, branch)?.status);

/** Drops a chat's pending move, as Back, when the chat is archived, or the move is no longer
 *  possible on the list shown. Called after the chat's view or that list changed. The point is
 *  judged as one of a running source while the move's branch is busy. A busy source keeps a valid
 *  move, whatever other branches do. With an agent kind that cannot branch from a running source
 *  the move stays as well: the turn may be one the app started, and Send waits for its end. */
export function checkMove(chat: string): void {
  const s = getState(), move = s.moves[chat], c = s.chats[chat];
  if (!move || !c || !c.agent) return; // a chat with no agent has no point to move to
  const items = threadOf(s, chat)?.items;
  const running = sourceBusy(chat, move.branch) && LIVE_FORK[c.agent];
  const valid = !items || moveValid(c.agent, items, move, running); // not loaded yet: judged when it is
  if (moveDropped({ archived: !!c.archived, valid, sending: isSending(chat) })) goBack(chat);
}

/** Sends to the point a chat shows: post gets the pending move as its target, or none, and then
 *  the branch the chat is on: the message goes to that branch's end, whatever the server's
 *  current branch is. The target carries the move's model and effort when they were chosen
 *  (setMoveChoice). While a move's POST runs the move is sending: it still cuts the thread,
 *  Back does not undo it, and nothing drops it. The POST's answer names the branch the message
 *  was put on, the new one: the move ends at once and the chat is on that branch (moveSent). When
 *  the POST fails the move stays and the error is thrown on. Nothing more is needed then: the
 *  server lists a new branch only once the agent took its message, so after a failure no branch
 *  was made, and the move, the banner and the message are there for the next try. */
export async function sendAt(chat: string, post: (branch: string, target?: Target & { model?: string; effort?: string }) => Promise<unknown>): Promise<void> {
  const s = getState(), move = s.moves[chat];
  if (!move) { await post(viewedBranch(s, chat)); return; }
  const before = currentBranch(s.chats[chat]);
  let answer: unknown;
  sending.add(chat);
  const target: Target & { model?: string; effort?: string } = { branch: move.branch, at: move.at, new: move.new };
  if (move.model) { target.model = move.model; if (move.effort) target.effort = move.effort; }
  try { answer = await post(move.branch, target); }
  finally { sending.delete(chat); }
  const to = (answer as { branch?: unknown } | null | undefined)?.branch;
  if (typeof to === "string" && to) { moveSent(chat, to); return; }
  sent.set(chat, before); // a server that does not name the branch: the chat's view will
  moveSent(chat);
}

/** Ends a sent move without Back's restore. to: the branch the message was put on, as the POST's
 *  answer names it: the chat is on that branch from now, the drafts of it and of the branch left
 *  are set (setSentDrafts), and its list is fetched; the thread stays cut until then, so the
 *  branch left is never shown whole. The chat's own events decide nothing here: with several
 *  branches at work they come all the time.
 *  Without to (called for a `chat` event, and after an answer that named no branch) only a move
 *  whose answer named none ends, once the chat's view names another current branch than before
 *  the Send, which is then the new one. */
export function moveSent(chat: string, to?: string): void {
  const s = getState(), c = s.chats[chat], move = s.moves[chat];
  if (to === undefined) {
    const before = sent.get(chat);
    if (before === undefined) return;
    if (move && c && currentBranch(c) === before) return;
    if (c) to = currentBranch(c);
  }
  sent.delete(chat);
  starts.delete(chat);
  if (c && to !== undefined) {
    if (move) setSentDrafts(chat, move, to);
    setShown(chat, to);
  }
  setMove(chat, null);
  void showBranch(chat).catch(() => {});
}

/** Ends every sent move that still waits for its chat's view (the answer named no branch),
 *  without Back's restore: a snapshot replaces the state it waits in, or the page goes away. The
 *  branch sent to is not known: what the composer holds stays with the branch left, and the chat
 *  is on no branch of its own choosing any more, so that it shows the server's current one, the
 *  new branch, as after a reload. */
function endSent(): void {
  for (const chat of sent.keys()) {
    const move = getState().moves[chat];
    if (move) setSentDrafts(chat, move, null);
    setState((s) => {
      const { [chat]: _, ...shown } = s.shown;
      return { shown };
    });
    setMove(chat, null);
  }
  sent.clear();
}
// Before the composer's own listener (Composer.tsx), which then saves what the move's end left in it.
if (typeof window !== "undefined") window.addEventListener("pagehide", endSent);

/** Sets the drafts of the two branches of a sent move, as draftsAfterSent rules. The message made
 *  a new branch (to), which has no draft, and the Send cleared none: the composer held the draft
 *  of the branch left (move.from). That branch keeps the draft that Branch and edit put aside,
 *  whole: its quotes name its own messages. A move that put nothing sent the draft itself: the
 *  branch left has none then. What was typed after the Send (in the open composer of the branch
 *  left, or by the one that went away) goes to the new branch. The branch left gets its draft
 *  through its composer when that is open, also when it is going away because the chat is on the
 *  new branch by now: it saves what it holds. Else the draft is written here. No other branch's
 *  composer or draft is touched. to null: the new branch is not known (endSent), and what was
 *  typed stays with the branch left. */
function setSentDrafts(chat: string, move: PendingMove, to: string | null): void {
  const b = composerOf(chat, move.from);
  const typed = b?.get() ?? move.typed ?? NOTHING;
  const d = draftsAfterSent(afterSent(move, NOTHING, Infinity), typed, to !== null);
  if (b) b.set(heldOf(d.left));
  else putDraft(chat, move.from, d.left);
  if (to !== null && d.to) putDraft(chat, to, d.to);
}

/** Sets a branch's draft from outside its composer: as its unsaved draft, which the branch's next
 *  composer opens with and saves, and on the server. The unsaved copy goes when the server has
 *  the draft. When the save failed and the copy is gone (a composer of the branch took it), it is
 *  there again only when d is still the branch's draft here: a newer one is not replaced by it. */
function putDraft(chat: string, branch: string, d: Draft): void {
  const unsaved = unsavedDraft(chat, branch);
  unsaved.write(d);
  saveDraft(chat, branch, d).then(
    () => { if (sameDraft(unsaved.read(), d)) unsaved.write(null); },
    () => { if (!unsaved.read() && sameDraft(branchState(getState(), chat, branch)?.draft, d)) unsaved.write(d); },
  );
}
