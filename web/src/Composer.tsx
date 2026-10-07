// The message box under a chat, and its toolbar: folder, model, effort and
// context usage (a click on it also shows the agent's plan usage limits). The pickers come from the server's catalogs and can be changed
// until the first message is sent: of a new chat, of a fork that has had none of its own, and of the branch a pending move starts.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore, getState, setState, safeGet, safeSet, isLegacy, upsertChat, upsertState, unsavedDraft, draftRevOf, branchState, statesOfChat, shownBranch, shownKey, shownView, viewedBranch, setStarting, threadOf } from "./store.ts";
import { api, ApiError, type Dirs } from "./api.ts";
import { refreshChat } from "./conn.ts";
import { buildContext, selectionRefOn } from "./board.ts";
import { resolveMentions, mentionOptions, openMention, type Picked } from "./logic/mentions.ts";
import { filterModels, groupModels, modelNotice, moveChoice, pickerMode, withEffort, withModel, type Choice } from "./logic/models.ts";
import { agentOpen, catalogFor, usableAgents } from "./logic/agentlist.ts";
import { FIRST_TEXT_KEPT, errStays, folderHead, folderStarts, folderTitle, offPlaceholder, recentFrom, sendGone, sendOff, sendTitleOn, showsServer, startsThere, tildeBy, usageKey, usageTitleOn, withRecent } from "./logic/chatserver.ts";
import { listsOf, recentKey, serverConnected, serverOf } from "./logic/serverlists.ts";
import { plainText, type Ref } from "./logic/refs.ts";
import type { BranchKey } from "./logic/branches.ts";
import type { Where } from "./logic/chatserver.ts";
import { DraftSaver, answerNewer, boxText, draftSet, hasDraft, revSet, staleOf, staleTaken, unsavedToShow } from "./logic/drafts.ts";
import { putsBack, refusalShown, startingAfter } from "./logic/sendend.ts";
import { selectedOn } from "./logic/roles.ts";
import { composerControls, refreshAfterRefusal } from "./logic/status.ts";
import { LIVE_FORK } from "./logic/forkpoints.ts";
import { mergeQuotes, toSend } from "./logic/quotes.ts";
import { effortLabel } from "./logic/labels.ts";
import { isStale, limitTone, resetAt, resetIn, sortLimits, updatedAgo } from "./logic/usage.ts";
import { byTokens, deferred, freeTokens, partSegments, segments, share, tokensText, width, type Segment } from "./logic/ctxsplit.ts";
import { RefInput, type RefInputHandle } from "./RefInput.tsx";
import { useComposerQuotes } from "./Quotes.tsx";
import { quoteSelection } from "./quoteDom.ts";
import { BoardIcon, Chevron, Folder, Lock, RunIcon, WarnIcon, agentName } from "./icons.tsx";
import { agentMeta } from "./agents.ts";
import { BranchBanner } from "./fork/Chrome.tsx";
import { FolderHint } from "./fork/FolderHint.tsx";
import { AgentPick, ServerPick, useWhere } from "./ChatChoices.tsx";
import { isSending, leftByBack, registerComposer, sendAt, sendFailed, setMoveChoice } from "./fork/actions.ts";
import type { AgentKind, Catalog, CatalogModel, ChatView, ContextSplit, Draft, Held, PlanUsage, Reference, UsageLimit } from "./types.ts";
import { LOCAL_SERVER } from "./types.ts";

export function focusComposer() { setTimeout(() => (document.querySelector(".composer .composer-input") as HTMLElement | null)?.focus(), 30); }

/** Puts the caret after what a composer's box holds, when the box has the focus. */
function caretToEnd(box: HTMLElement | null) {
  const el = box?.querySelector<HTMLElement>(".composer-input");
  if (!el || document.activeElement !== el) return;
  const r = document.createRange();
  r.selectNodeContents(el); r.collapse(false);
  const sel = getSelection();
  sel?.removeAllRanges(); sel?.addRange(r);
}

/** The chat whose composer had the focus as it went away for the composer of another branch
 *  (the chat is on that one now): the one that opens takes the focus, as if it were the same. */
let refocus: string | null = null;

// ---- folders

/** A server's recent folders: each server has its own list (recentKey). */
export const recentDirs = (server: string = LOCAL_SERVER): string[] => recentFrom(safeGet(recentKey(server)));
const rememberDir = (d: string, server: string) => safeSet(recentKey(server), JSON.stringify(withRecent(recentDirs(server), d)));
/** A path of this computer, or of the server named, with that server's home as "~". */
export const tildify = (p?: string, server: string = LOCAL_SERVER) => tildeBy(listsOf(getState(), server)?.home, p);
const base = (p?: string) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";

// ---- model and effort labels

export { effortLabel };
const modelOf = (c: Pick<ChatView, "model">, cat?: Catalog): CatalogModel | undefined => cat?.models.find((m) => m.id === c.model);
export const modelLabel = (c: Pick<ChatView, "model">, cat?: Catalog) => modelOf(c, cat)?.label ?? c.model;

/** "model · effort", from the catalog's labels. */
export function subline(c: ChatView, cat?: Catalog): string {
  const m = modelOf(c, cat);
  const withEffort = c.effort && (m ? !!m.efforts?.length : true);
  return `${modelLabel(c, cat)}${withEffort ? " · " + effortLabel(c.effort, m) : ""}`;
}

// ---- sending

/** How long the text of a first message that was taken stays in the thread's place when the thread read again does not bring it. */
const STARTING_LINGER = 10_000;

/** Plain chats send the text alone; board chats send the <ui-context> with it. Quotes go with
 *  both. With a pending move the message goes to its point (the target), and a Send that
 *  succeeded ends the move. */
export async function sendMessage(chat: string, text: string, picked: Picked[] = [], references: Reference[] = []) {
  const c = getState().chats[chat];
  if (isLegacy(c)) return;
  const context = c?.board ? buildContext(chat, text, picked) : "";
  // The first message of a chat on another server is that server's creation call: it names no branch.
  return sendAt(chat, (branch, target) => api.send(chat, c?.server && !c.locked ? "" : branch, text, context, references, target));
}

// ---- drafts

/** Saves a branch's draft on the server, and in the store at once (on the branch's record, and
 *  on the chat's view when the branch is its current one): a composer reopened before the
 *  server's events come back starts from it. base: the counter the draft was typed on, the one
 *  known here when the caller keeps none. Answers the new counter, which the branch's record
 *  gets, with the draft it counts when it is a later one than the record's (an event that came
 *  while the save was on its way has put the server's earlier draft there, and the composer's
 *  saver would take that one for the draft on the new counter); a save refused as stale puts the
 *  server's draft and counter there, unless the record has a later counter by then (staleTaken). */
export async function saveDraft(chat: string, branch: string, d: Draft, keepalive = false, base?: number): Promise<number | undefined> {
  if (!storeDraft(chat, branch, d)) return; // deleted
  try {
    const rev = await api.saveDraft(chat, branch, d, base ?? draftRevOf(chat, branch) ?? 0, keepalive);
    if (answerNewer(rev, draftRevOf(chat, branch))) storeDraft(chat, branch, d);
    setDraftRev(chat, branch, rev);
    return rev;
  } catch (e) {
    console.warn(`draft of ${chat} on ${branch} not saved:`, e);
    const stale = staleOf(e);
    if (stale && staleTaken(stale.rev, draftRevOf(chat, branch)) && storeDraft(chat, branch, stale.draft)) setDraftRev(chat, branch, stale.rev);
    throw e;
  }
}

/** Sets a branch's draft in the store (draftSet); false for a chat that is not there. */
function storeDraft(chat: string, branch: string, d: Draft): boolean {
  const s = getState(), c = s.chats[chat];
  if (!c) return false;
  const { state, view } = draftSet(c, statesOfChat(s, chat), branch, d);
  if (state) upsertState(state);
  if (view !== c) upsertChat(view);
  return true;
}

/** Sets the counter of a branch's draft on its record, when the server gave a later one. */
function setDraftRev(chat: string, branch: string, rev: number) {
  const s = getState(), c = s.chats[chat];
  const st = c && typeof rev === "number" ? revSet(c, statesOfChat(s, chat), branch, rev) : undefined;
  if (st) upsertState(st);
}

/** The draft a branch's composer opens with: one the server may not have yet, typed on the
 *  server's counter, else the server's. */
export const draftToShow = (chat: string, branch: string): Draft | undefined =>
  unsavedToShow(unsavedDraft(chat, branch), draftRevOf(chat, branch)) ?? branchState(getState(), chat, branch)?.draft;

// ---- references (⌘L, ⌘⇧L): text selected in a message, or the board's selection

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const KEY_REF = isMac ? "⌘L" : "Ctrl+L";
export const KEY_POINT = isMac ? "⌘⇧L" : "Ctrl+Shift+L";

/** The open board chat composers, by chat id: where a picked point goes. */
const inserters = new Map<string, (r: Ref) => void>();

/** Puts a reference into a chat's composer at its caret. */
export function insertRef(chat: string, r: Ref) { inserters.get(chat)?.(r); }

/** Starts (or stops) waiting for a point clicked on the chat's board. */
export function pickPoint(chat: string | null) { setState({ picking: chat }); }

/** The composer of one branch of a chat: branch is the one the chat is on, whose draft it holds.
 *  On another branch the chat gets another composer (its key in App.tsx names the branch). */
export function Composer({ chatId, branch }: { chatId: string; branch: string }) {
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => !!s.moves[chatId]); // the next message starts a new branch
  const where = useWhere(c);
  const usable = useStore((s) => usableAgents(s, where.server)); // what a chat with no agent says depends on whether one can be chosen
  const boards = useStore((s) => s.boards);
  const runName = useStore((s) => (c?.run ? s.runs[c.run]?.name : undefined));
  const groups = useStore((s) => s.groups);
  const selection = useStore((s) => s.selection);
  const onScreen = useStore((s) => s.sel.board);
  const role = useStore((s) => (c?.board ? s.roles[c.board] : undefined));
  const picking = useStore((s) => s.picking === chatId);
  const [text, setText] = useState(() => draftToShow(chatId, branch)?.text ?? "");
  const [picked, setPicked] = useState<Picked[]>(() => draftToShow(chatId, branch)?.mentions ?? []);
  const [quotes, setQuotes] = useState<Reference[]>(() => draftToShow(chatId, branch)?.references ?? []);
  const [mention, setMention] = useState<{ q: string; at: number; i: number } | null>(null);
  const [err, setErr] = useState("");
  const errKept = useRef(false); // the refusal shown stays when the chat's choices or its start change (errStays)
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<RefInputHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef(text); // the text now, for a failed send
  const now = useRef({ picked, quotes }); // with it, what the composer holds (for a move)
  now.current = { picked, quotes };
  const put = useRef<{ picked: Picked[]; quotes: Reference[] } | null>(null); // what a move set that no render has shown yet: the composer may go away before one does
  const drafts = useRef<DraftSaver | null>(null);
  const gone = useRef(false); // this composer went away
  // Puts a text into the composer. An archived chat draws no box, and the text is then set as what the composer holds all the same: left as it was, it
  // would go to the saver as typed with the next change of the mentions or the quotes, and two windows would save their texts over each other without end.
  const setBox = (t: string) => {
    if (input.current) input.current.set(t);
    else { current.current = t; setText(t); }
  };
  const draftRev = useStore((s) => branchState(s, chatId, branch)?.draftRev ?? 0);
  drafts.current ??= new DraftSaver((d, keepalive, base) => saveDraft(chatId, branch, d, keepalive, base), branchState(getState(), chatId, branch)?.draft, unsavedDraft(chatId, branch),
    undefined, draftRev, (d) => {
      if (getState().moves[chatId]) return; // the composer holds the move's message
      setBox(d.text);
      setPicked(d.mentions ?? []);
      setQuotes(d.references ?? []);
    });
  const board = c?.board;
  const archived = !!c?.archived;
  const legacy = isLegacy(c);
  const canRef = !!board && !archived && !legacy && onScreen === board;
  const q = useComposerQuotes(chatId, quotes, setQuotes, box);

  // ⌘L quotes the text selected in a message; with none, it puts the selection on the board into
  // the message. ⌘⇧L waits for a point clicked on the board.
  const addSelection = () => {
    if (!board) return;
    const r = selectionRefOn(board);
    if (!r) { setNote("Select something on the board first"); return; }
    setNote("");
    input.current?.insertRef(r);
  };
  useEffect(() => {
    if (archived || legacy) return;
    if (canRef) inserters.set(chatId, (r) => { setNote(""); input.current?.insertRef(r); });
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyL") return;
      const sel = e.shiftKey ? null : quoteSelection(chatId);
      if (sel) {
        e.preventDefault(); e.stopPropagation();
        if ("error" in sel) setNote(sel.error); else { setNote(""); q.quote(sel.ref, sel.range); }
        return;
      }
      if (!canRef) {
        if (!board && !e.shiftKey) { e.preventDefault(); setNote("Select text in a message to quote it"); }
        return;
      }
      e.preventDefault(); e.stopPropagation(); // before Excalidraw, whose ⌘⇧L locks shapes
      if (e.shiftKey) pickPoint(getState().picking === chatId ? null : chatId);
      else addSelection();
    };
    window.addEventListener("keydown", k, true);
    return () => {
      window.removeEventListener("keydown", k, true);
      inserters.delete(chatId);
      if (getState().picking === chatId) pickPoint(null);
    };
  }, [canRef, archived, legacy, chatId]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 2500); return () => clearTimeout(t); }, [note]);
  // A refusal's sentence is about the server's state and the chat's choices it was given in: it goes when the server is connected again, when the chat
  // starts or its start is settled, and when its server, agent, folder, model or effort changes.
  useEffect(() => { if (where.connected && !errKept.current) setErr(""); }, [where.connected]);
  useEffect(() => { if (!errKept.current) setErr(""); }, [c?.locked, c?.start, c?.server, c?.agent, c?.cwd, c?.model, c?.effort]);

  // The draft: put into the box when it appears (on open, after unarchiving), saved as it
  // changes, and saved at once when the composer or the page goes away. A later draft from the
  // server is put in only when it is newer than this composer's (another window saved it) and
  // nothing typed here waits to be saved: the saver tells (DraftSaver.arrived). With no draft to
  // show, the box gets the text the composer holds: one set while the chat was archived (setBox),
  // which Enter would send unseen.
  useEffect(() => {
    if (c?.archived || isLegacy(c)) return;
    const d = draftToShow(chatId, branch), t = boxText(d, current.current);
    if (t !== null) input.current?.set(t);
    if (!hasDraft(d)) return;
    setPicked(d.mentions ?? []);
    setQuotes(d.references ?? []);
  }, [c?.archived, c?.instructionsSent]);
  useEffect(() => { drafts.current!.arrived(draftRev, branchState(getState(), chatId, branch)?.draft); }, [draftRev]);
  // The typing goes on in the composer of the branch a sent move went to.
  useLayoutEffect(() => () => {
    const s = getState();
    if (s.sel.chat === chatId && viewedBranch(s, chatId) !== branch && box.current?.contains(document.activeElement)) refocus = chatId;
  }, []);
  useEffect(() => {
    if (refocus === chatId) { input.current?.focus(); caretToEnd(box.current); }
    refocus = null;
  }, []);
  // A move reads what the composer holds and puts into it what it takes back or restores. set
  // gives fresh lists, so the draft is looked at again also when nothing else changed. What it
  // set is what the composer holds at once, also for one that goes away before it renders again
  // (a sent move's end sets the draft of the branch left, and the chat is on another branch).
  const held = (): Held => ({ text: current.current, mentions: put.current?.picked ?? now.current.picked, references: put.current?.quotes ?? now.current.quotes });
  useEffect(() => {
    registerComposer(chatId, branch, {
      get: held,
      set: (h) => {
        if (h.text !== current.current) { setBox(h.text); caretToEnd(box.current); }
        put.current = { picked: [...h.mentions], quotes: [...h.references] };
        setPicked(put.current.picked);
        setQuotes(put.current.quotes);
      },
    });
    return () => { now.current.quotes = q.kept(); registerComposer(chatId, branch, null); };
  }, []);
  // While a move is pending nothing is saved on the server until the page goes away: a reload
  // equals Back, so what Back would leave in the composer is saved then. When only the composer
  // goes away (another chat is opened), that is kept here as the branch's unsaved draft. A comment
  // typed in an open float goes with what is saved when the composer or the page goes away.
  useEffect(() => {
    put.current = null; // shown
    if (!getState().moves[chatId]) drafts.current!.change(text, picked, quotes);
  }, [text, picked, quotes]);
  useEffect(() => {
    const d = drafts.current!;
    const save = (h: Held) => d.change(h.text, h.mentions, h.references);
    const hide = () => {
      now.current.quotes = q.kept();
      const h = leftByBack(chatId, branch);
      if (h) save(h);
      else if (!getState().moves[chatId]) save(held());
      d.flush(true);
    };
    window.addEventListener("pagehide", hide);
    gone.current = false;
    return () => {
      gone.current = true;
      window.removeEventListener("pagehide", hide);
      now.current.quotes = q.kept();
      if (!getState().moves[chatId]) save(held());
      d.flush();
    };
  }, []);

  if (!c) return null;
  if (c.archived) return (
    <div className="composer">
      <div className="archived-bar">
        Archived — unarchive to continue
        <button className="btn sm" onClick={() => api.unarchive("chats", c.id).catch((e) => setErr(e.message))}>Unarchive</button>
      </div>
      {err && <div className="composer-err">{err}</div>}
    </div>
  );
  if (legacy) return (
    <div className="composer">
      <div className="archived-bar">
        This chat used the old board connection — start a new chat to continue
      </div>
    </div>
  );

  // esc: the agent is busy on the branch shown; a message that starts a new branch may go out all the same
  const { stop, blocked, esc } = composerControls(c, { newBranch: move, liveFork: !!c.agent && LIVE_FORK[c.agent] });
  const own = c.board ? boards[c.board] : undefined;
  const refs = c.board ? resolveMentions(plainText(text), boards, picked).filter((b) => b.id !== c.board) : [];
  const matches = mention && c.board ? mentionOptions(mention.q, boards, groups) : [];
  const selected = canRef ? selectedOn(selection.count, board, onScreen, role) : 0;
  const off = sendOff(where, c); // an unstarted chat on a server that is not connected: its agents are not known
  const left = sendGone(c); // its server no longer has the chat

  const submit = async () => {
    const t = text.trim();
    if ((!t && !quotes.length) || blocked || off || left || sending || isSending(chatId)) return; // no send while busy, or while the composer of the branch left sends the move
    setSending(true); setErr(""); errKept.current = false;
    // The saver is told that this composer's Send runs, until it is answered: the removal of the sent draft is then not taken as another window's.
    // A sent move goes to another branch, and removes no draft of this one.
    // The first message of a chat on another server is one call that can take long: its saver saves nothing until the answer, so the text stays the draft
    // on the server meanwhile, and a page that reloads shows it.
    // The saver is told inside the try: whatever is thrown after it, the Send is ended there (finally), and neither its mark nor its hold stays.
    const first = !getState().moves[chatId] && startsThere(c);
    const p = picked, qs = quotes;
    let answered: ((refused?: boolean) => boolean) | null = null;
    let refused = false; // the server answered that it did not take the message: it removed no draft
    let taken = false;
    try {
      answered = getState().moves[chatId] ? null : drafts.current!.sending(undefined, first);
      if (first) setStarting(chatId, t); // the thread shows the text while the call runs
      input.current?.set(""); setMention(null); // the server clears the draft of the branch sent on; the empty one saved after it undoes a save still in flight
      setQuotes([]);
      await sendMessage(chatId, t, p, toSend(qs));
      taken = true;
      // The sent message's mentions go; a draft that the sent move gave back keeps its own. The move's end set a copy of the list: the two are compared by what they hold.
      setPicked((now) => (now.length === p.length && now.every((x, i) => x === p[i]) ? [] : now));
      // A sent move saves nothing here: the Send cleared the draft of the branch sent to, not this composer's, and the move's end (moveSent) sets the
      // drafts of both, this branch's through this composer while it is open.
    } catch (e: any) {
      refused = e instanceof ApiError && e.status < 500; // (a 5xx may hide a message that was taken)
      const code = e instanceof ApiError ? e.code : undefined;
      // (the server's state is read now: the Send that was refused for a server not connected has woken the connection, and the news can be here already)
      if (refusalShown(e instanceof ApiError ? e.status : undefined, code, serverConnected(getState(), where.server))) { errKept.current = errStays(code); setErr(e?.message ?? String(e)); }
      // The chat had started on its server with an earlier text: it is a started chat by now, whose draft the server removed on a counter raised by one.
      // The saver is told so, and takes that removal as come unless its event has (DraftSaver.kept): the text put back below is then saved as that
      // chat's draft, and the event, coming after it, does not empty the box.
      if (code === FIRST_TEXT_KEPT) drafts.current!.kept();
      // The Send is over for the saver, which tells whether the sent draft was removed on the server meanwhile: another window sent it, or this Send was
      // taken after all. The message is then not put back: it would be a draft of a sent message again, here, on the server and in the other window.
      const removed = answered?.(refused) ?? false;
      answered = null;
      if (putsBack(removed, code)) {
        setQuotes((now) => mergeQuotes(qs, now)); // with the quotes added while it was sent
        if (!current.current.trim()) input.current?.set(t); // nothing typed is lost
        // A chat archived while it was sent draws no box: the composer holds the text again all the same, so its saver keeps it as the draft (the emptied
        // one is not saved, or the text is saved again), and the box shows it after an unarchive.
        if (!gone.current && !input.current && !current.current.trim()) setBox(t);
        // This composer went away while it was sent (another chat or branch was opened): the message is its branch's draft again unless a pending move or a
        // composer of the branch opened since holds it. Its saver writes the unsaved copy and saves it: a save of the emptied draft still in flight then leaves that copy alone.
        if (gone.current && !sendFailed(chatId, branch, { text: t, mentions: p, references: qs }, e)) drafts.current!.change(t, p, qs);
      }
      // The chat is read again when its state here is stale (refreshAfterRefusal). Else the text is shown, and the message and a pending move with its
      // choice stay for a later Send.
      if (e instanceof ApiError && refreshAfterRefusal(e.status, e.code)) void refreshChat(chatId, e.code);
    } finally {
      answered?.(refused); setSending(false);
      // The text shown in the thread's place goes with the call; after one that was taken it stays until the thread read again has the message (ChatView.tsx),
      // or for good after a while when that read brings none.
      if (first) {
        if (!startingAfter(taken, !!threadOf(getState(), chatId)?.items.length)) setStarting(chatId, null);
        else setTimeout(() => { if (getState().starting[chatId] === t) setStarting(chatId, null); }, STARTING_LINGER);
      }
    }
  };
  const pick = (o: { board: { id: string; name: string } }) => {
    if (!mention) return;
    input.current?.replaceBeforeCaret(mention.q.length + 1, `@${o.board.name} `);
    setPicked((ps) => [...ps.filter((x) => x.name !== o.board.name), { name: o.board.name, id: o.board.id }]);
    setMention(null);
  };
  const onChange = (v: string, beforeCaret: string) => {
    setText(v); current.current = v;
    if (!c.board) return; // plain chats have no mentions
    const m = openMention(beforeCaret);
    setMention(m ? { ...m, i: 0 } : null);
  };

  const placeholder = offPlaceholder(where, usable, c) || (c.board ? "Ask or tell… (@ to mention a board)" : c.run ? "Ask about this run…" : `Ask ${agentName(c.agent as AgentKind)}…`);
  return (
    <div className="composer">
      {c.board && (
        <div className="context-row">
          <span className="ctx-chip" title={`Every message names this board to the agent (${c.board})`}>
            <BoardIcon /> {own?.name ?? "board"}
          </span>
          {refs.map((r) => <span key={r.id} className="ctx-chip ref" title={`Referenced board (${r.id})`}>@{r.name}</span>)}
          {q.count}
          <span className="grow" />
          {note ? <span className="ctx-note">{note}</span> : canRef && <>
            <button className="ctx-act" disabled={!selected} onMouseDown={(e) => e.preventDefault()} onClick={addSelection}
              title={`Put the selected elements into the message (${KEY_REF})`}>
              + {selected ? `${selected} selected` : "Selection"} <kbd>{KEY_REF}</kbd>
            </button>
            <button className={`ctx-act ${picking ? "on" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pickPoint(picking ? null : chatId)}
              title={`Click a point on the board to put it into the message (${KEY_POINT})`}>
              + Point <kbd>{KEY_POINT}</kbd>
            </button>
          </>}
        </div>
      )}
      {c.run && !c.board && (
        <div className="context-row">
          <span className="ctx-chip" title={`This chat can read and manage this run (${c.run})`}><RunIcon /> {runName ?? "run"}</span>
          {q.count}<span className="grow" />{note && <span className="ctx-note">{note}</span>}
        </div>
      )}
      {!c.board && !c.run && (q.count || note) ? (
        <div className="context-row">{q.count}<span className="grow" />{note && <span className="ctx-note">{note}</span>}</div>
      ) : null}
      <BranchBanner chatId={chatId} />
      <ModelNotice chatId={chatId} />
      <div className="composer-box with-tools" ref={box}>
        {mention && matches.length > 0 && (
          <div className="mention-pop">
            {matches.map((o, i) => (
              <button key={o.board.id} className={`menu-item ${i === mention.i ? "on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
                <span>@{o.board.name}</span>{o.group && <span className="hint">{o.group}</span>}
              </button>
            ))}
          </div>
        )}
        <RefInput
          ref={input}
          placeholder={placeholder}
          onChange={onChange}
          onKeyDown={(e) => {
            e.stopPropagation(); // keep Excalidraw's shortcuts out of the text box
            if (mention && matches.length) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMention({ ...mention, i: (mention.i + 1) % matches.length }); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMention({ ...mention, i: (mention.i - 1 + matches.length) % matches.length }); return; }
              if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[mention.i]); return; }
              if (e.key === "Escape") { setMention(null); return; }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === "Escape" && esc) void api.interrupt(chatId, shownBranch(getState(), chatId));
          }}
        />
        <div className="composer-tools">
          <Toolbar chatId={chatId} onError={setErr} sending={sending} />
          <span className="grow" />
          {stop && <button className="send stop" title={esc ? "Stop (Esc)" : "Stop the subagents"} onClick={() => api.interrupt(chatId, shownBranch(getState(), chatId)).catch((e) => setErr(e.message))}><span className="sq" /></button>}
          <button className="send" title={sendTitleOn(where, usable, c, blocked)} disabled={blocked || off || left || sending || (!text.trim() && !quotes.length)} onClick={() => void submit()}>↑</button>
        </div>
      </div>
      {err ? <div className="composer-err">{err}</div> : c.status === "error" && c.error ? <div className="composer-err">{c.error}</div> : null}
      {q.float}
    </div>
  );
}

// ---- toolbar

/** Server and agent while they can be changed (agentOpen; ChatChoices.tsx; a chat on another
 *  server keeps showing its server, showsServer), then folder, model,
 *  effort and context usage of the branch shown. Where the model and effort
 *  controls write is pickerMode's: with a pending move they show and set the move's choice, which
 *  goes with its message; on a new chat and on a fork without a message of its own they change the
 *  session (PATCH); else they are fixed. While the composer sends a message (sending) they take no
 *  pick: a move's choice has gone with the message, and the server refuses a fork's PATCH. */
export function Toolbar({ chatId, onError, sending = false }: { chatId: string; onError: (msg: string) => void; sending?: boolean }) {
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => (c ? catalogFor(s, serverOf(c), c.agent) : undefined));
  // One open menu at a time for Server, Agent, Model and Effort; their state used to live inside each Picker,
  // which let both menus and both backdrops stack. DirPicker and the usage popover keep theirs.
  const [openPicker, setOpenPicker] = useState<"server" | "agent" | "model" | "effort" | null>(null);
  const [patching, setPatching] = useState(false); // a fork's PATCH starts its agent again, which takes seconds
  const where = useWhere(c);
  if (!c) return null;
  const mode = pickerMode(c, !!move);
  const shown: Choice = mode === "move" ? moveChoice(move, c) : c;
  const configure = (p: { model?: string; effort?: string }) => {
    setPatching(true);
    return api.configure(chatId, shownBranch(getState(), chatId), p).then(() => onError(""), (e) => onError(e.message)).finally(() => setPatching(false));
  };
  // A refusal's text was about the choice before this one.
  const setChoice = (ch: Choice) => { onError(""); setMoveChoice(chatId, ch); };
  const pickModel = (id: string) => (mode === "move" ? setChoice(withModel(shown, id, cat)) : void configure({ model: id }));
  const pickEffort = (id: string) => (mode === "move" ? setChoice(withEffort(shown, id)) : void configure({ effort: id }));
  const folderOpen = !c.locked || !!c.folderMissing;
  const m = modelOf(shown, cat);
  return (
    <>
      {showsServer(c) && <ServerPick c={c} disabled={patching || sending} open={openPicker === "server"} onOpenChange={(o) => setOpenPicker(o ? "server" : null)} onBusy={setPatching} onError={onError} />}
      {agentOpen(c) && <AgentPick c={c} disabled={patching || sending} open={openPicker === "agent"} onOpenChange={(o) => setOpenPicker(o ? "agent" : null)} onBusy={setPatching} onError={onError} />}
      {!folderOpen && <Lock />}
      <DirPicker cwd={c.cwd} missing={c.folderMissing} locked={!folderOpen} server={where.server} onPick={(d) => api.configure(c.id, shownBranch(getState(), c.id), { cwd: d })} />
      <FolderHint chatId={chatId} />
      {mode === "fixed" ? (
        <span className="tchip static" title={c.fresh ? "Starting the agent on this model…" : "Model and effort are fixed once the chat has started"}>
          {folderOpen && <Lock />} {subline(c, cat)}
        </span>
      ) : !c.agent || sendOff(where, c) ? null : !cat ? ( // (a server that is not connected shows no agent: none of its models either)
        // a server that is not connected sends no catalog
        where.connected ? <span className="tchip static">Loading models…</span> : null
      ) : (
        <>
          <Picker label={modelLabel(shown, cat)} title="Model" value={shown.model} searchable disabled={patching || sending}
            options={cat.models}
            open={openPicker === "model"} onOpenChange={(o) => setOpenPicker(o ? "model" : null)}
            onPick={pickModel} />
          {!!m?.efforts?.length && (
            <Picker label={effortLabel(shown.effort, m)} title="Effort" prefix="Effort" value={shown.effort ?? ""} searchable={false} disabled={patching || sending}
              options={m.efforts.map((e) => ({ id: e, label: effortLabel(e, m) }))}
              open={openPicker === "effort"} onOpenChange={(o) => setOpenPicker(o ? "effort" : null)}
              onPick={pickEffort} />
          )}
        </>
      )}
      <ContextMeter c={c} cat={cat} where={where} />
    </>
  );
}

/** The note above the composer's box when the model chosen is not the one the conversation so
 *  far ran on: for a pending move against its source, for a fork without a message of its own
 *  against the branch it was forked from. What it says is modelNotice's. */
function ModelNotice({ chatId }: { chatId: string }) {
  const c = useStore((s) => shownView(s, chatId));
  const move = useStore((s) => s.moves[chatId]);
  const cat = useStore((s) => (c ? catalogFor(s, serverOf(c), c.agent) : undefined));
  const parent = useStore((s) => (c?.fresh && c.forkedFrom ? branchState(s, c.forkedFrom, c.forkedBranch) : undefined));
  if (!c || !c.agent) return null;
  const n = move
    ? modelNotice({ agent: c.agent, choice: moveChoice(move, c), parent: c, at: move.at, ctxIn: c.usage?.ctxIn, cat })
    // A fork is fresh only with a prefix: the server leaves forkedAt out when it does not know the count.
    : c.fresh ? modelNotice({ agent: c.agent, choice: c, parent, at: c.forkedAt || 1, ctxIn: c.usage?.ctxIn, cat }) : null;
  return n ? <div className={`model-notice ${n.warn ? "warn" : ""}`}>{n.text}</div> : null;
}

/** One Picker row: a catalog model for Model (id/label/note/provider), or a bare {id, label} for
 *  Effort. */
export type PickerOption = { id: string; label: string; note?: string; provider?: string; icon?: React.ReactNode; disabled?: boolean };

/** What a setting's chip says about when it can be changed. */
export const UNTIL_FIRST_MESSAGE = "can be changed until you send the first message";

/** The Model and Effort pickers. `searchable` (Model only) adds the search field and provider
 *  grouping; both modes share the keyboard highlight, listbox/option ARIA and single-open state.
 *  A run's goal composer (run/RunComposer.tsx) uses it too, also for the agent: icon goes before
 *  the chip's label, and hint is the title's second half.
 *  `disabled` (a change is being saved): the chip opens nothing, and keeps the focus a pick gave it.
 *  An option that is disabled is listed with its note as the reason and takes no pick. `more` is a
 *  last item under the list that is no option (the server choice's "Servers…"). */
export function Picker({ label, title, prefix, icon, hint = UNTIL_FIRST_MESSAGE, options, value, className = "", more, searchable = false, disabled = false, open, onOpenChange, onPick }: {
  label: string; title: string; prefix?: string; icon?: React.ReactNode; hint?: string; options: PickerOption[]; value: string;
  className?: string; more?: { label: string; onClick: () => void }; searchable?: boolean; disabled?: boolean; open: boolean; onOpenChange: (open: boolean) => void; onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState(""); // searchable only; never touched by Effort
  const [hi, setHi] = useState(-1); // index into the flattened filtered rows; headings excluded
  const input = useRef<HTMLInputElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const wasOpen = useRef(false);
  const listId = React.useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  // The flattened rows in render order for a query: grouped by provider when searchable
  // (provider-less first); the Effort picker stays a flat list. The highlight index, ARIA row ids
  // and rendered rows all derive from this same sequence so they cannot drift.
  const ordered = (q: string): PickerOption[] =>
    searchable ? groupModels(filterModels(options, q)).flatMap((g) => g.models) : options;

  // The rendered rows in order, with the flattened index ARIA and the highlight use. Searchable
  // pickers group by provider (provider-less first); the Effort picker stays a flat list.
  const filtered = searchable ? filterModels(options, query) : options;
  const sections = searchable
    ? groupModels(filtered).map((g) => ({ provider: g.provider, options: g.models }))
    : [{ provider: "", options }];
  const flat: PickerOption[] = [];
  const rowsOf = sections.map((s) => ({
    provider: s.provider,
    rows: s.options.map((o) => { const i = flat.length; flat.push(o); return { o, i }; }),
  }));

  const move = (d: number) => {
    const n = flat.length;
    if (n) setHi((i) => (i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n));
  };
  const pickAt = (i: number) => {
    const o = flat[i];
    if (!o || o.disabled) return; // no highlight: Enter does nothing
    onOpenChange(false);
    if (o.id !== value) onPick(o.id);
  };
  // Typing keeps the selection highlighted when it survives the filter, else highlights the first row.
  const onQuery = (q: string) => {
    setQuery(q);
    const visible = ordered(q);
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
  };

  // Lifecycle on open/close: start on the selected row (else the first) and focus the field;
  // closing drops the query and hands focus back to the chip, from any close path.
  useEffect(() => {
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      if (searchable) setQuery("");
      setHi(-1);
      chip.current?.focus();
      return;
    }
    wasOpen.current = true;
    const visible = ordered("");
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
    if (searchable) { setQuery(""); input.current?.focus(); }
    else chip.current?.focus(); // Effort keeps its keys on the chip; some browsers don't focus it on click
  }, [open]);
  // A list that changes under the open menu (a catalog that arrives late) sets the highlight again,
  // by the rule for typing. Compared by ids: Effort gets a new options array on every render.
  const optionIds = options.map((o) => o.id).join("\n");
  useEffect(() => {
    if (open) onQuery(query);
  }, [optionIds]);
  // Keep the highlighted row visible inside the scroll region as it moves or the menu opens.
  useEffect(() => {
    if (open && hi >= 0) rows.current[hi]?.scrollIntoView({ block: "nearest" });
  }, [open, hi]);
  // The menu is anchored at the chip's left edge: move it left by what its right edge passes the
  // window's (less a 12px margin), never past the window's left edge. Redone when the rows change,
  // since the menu is as wide as its rows.
  const flatIds = flat.map((o) => o.id).join("\n");
  React.useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    el.style.left = "";
    const r = el.getBoundingClientRect();
    const over = Math.min(r.right - (window.innerWidth - 12), r.left);
    if (over > 0) el.style.left = `${-over}px`;
  }, [open, flatIds]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation(); // keep Excalidraw's shortcuts out of the field
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); move(-1); return; }
    if (e.key === "Enter") { e.preventDefault(); pickAt(hi); return; }
    if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
  };
  // Effort has no field, so focus stays on the chip and the wrapper takes the keys while the
  // menu is open. Enter is handled here before the chip's default activation can re-toggle it.
  const onWrapKeyDown = (e: React.KeyboardEvent) => {
    // Model's field has its own keys; Esc from one of its rows closes the menu as Effort's does.
    if (searchable && open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onOpenChange(false); }
    if (searchable || !open) return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter" && e.key !== "Escape") return;
    // Enter on a focused row is that row's own click, not a pick of the highlighted one.
    // The same for the item under the list (more).
    if (e.key === "Enter" && ((e.target as HTMLElement).getAttribute("role") === "option" || (e.target as HTMLElement).classList.contains("menu-more"))) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") pickAt(hi);
    else onOpenChange(false);
  };

  const row = ({ o, i }: { o: PickerOption; i: number }) => (
    <button key={o.id} id={rowId(i)} type="button" role="option" aria-selected={o.id === value} aria-disabled={o.disabled || undefined} title={o.disabled ? o.note : undefined}
      data-model-id={searchable ? o.id : undefined} data-option-id={o.id}
      ref={(el) => { rows.current[i] = el; }}
      className={`menu-item pick ${o.id === value ? "on" : ""} ${i === hi ? "active" : ""}`}
      onClick={() => pickAt(i)}>
      {o.icon}<span className="menu-label">{o.label}{o.note && <span className="menu-note">{o.note}</span>}</span>
      {o.id === value && <span>✓</span>}
    </button>
  );

  return (
    <div className={`menu-wrap ${className}`} onKeyDown={onWrapKeyDown}>
      <button ref={chip} className="tchip" aria-expanded={open} aria-haspopup="listbox" aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) onOpenChange(!open); }} title={`${title} — ${hint}`}>
        {icon}{prefix && <span className="tchip-pre">{prefix}</span>}{label}<span className="caret">▾</span>
      </button>
      {open && (
        <div ref={menu} className="menu up" onMouseDown={(e) => e.stopPropagation()}>
          <div className="menu-head">{title}</div>
          {searchable && (
            <div className="menu-search">
              <input ref={input} className="menu-search-input" type="text" role="combobox"
                aria-controls={listId} aria-expanded={true} aria-autocomplete="list"
                aria-activedescendant={hi >= 0 ? rowId(hi) : undefined}
                placeholder="Search models" spellCheck={false} autoComplete="off"
                value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onSearchKeyDown} />
              {query && <button type="button" className="menu-search-clear" title="Clear search" aria-label="Clear search"
                onMouseDown={(e) => e.preventDefault()} onClick={() => onQuery("")}>×</button>}
            </div>
          )}
          <div className="menu-scroll" role="listbox" id={listId}>
            {options.length === 0 ? (
              <div className="menu-empty">No models</div>
            ) : searchable && flat.length === 0 ? (
              <div className="menu-empty">No matching models</div>
            ) : rowsOf.map((s) => s.provider ? (
              <div key={s.provider} className="menu-group" role="group" aria-label={s.provider}>
                <div className="menu-group-head" aria-hidden="true">{s.provider}</div>
                {s.rows.map(row)}
              </div>
            ) : (
              <React.Fragment key="__flat">{s.rows.map(row)}</React.Fragment>
            ))}
          </div>
          {more && <>
            <div className="menu-sep" />
            <button type="button" className="menu-item menu-more" onClick={() => { onOpenChange(false); more.onClick(); }}>{more.label}</button>
          </>}
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={() => onOpenChange(false)} />}
    </div>
  );
}

/** The folder chip and its browser. onPick sets the folder (a chat's, a run's); a rejection shows
 *  in the browser. */
export function DirPicker({ cwd, missing, locked, hint = UNTIL_FIRST_MESSAGE, server = LOCAL_SERVER, onPick }: {
  cwd: string; missing?: boolean; locked: boolean; hint?: string; server?: string; onPick: (dir: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const where = useWhere({ server });
  const name = base(cwd) || "/";
  if (locked) return <span className="tchip static" title={folderTitle(where, cwd, { locked })}><Folder /> {name}</span>;
  return (
    <div className="menu-wrap">
      <button className={`tchip ${missing ? "missing" : ""}`} onClick={() => setOpen(!open)}
        title={folderTitle(where, cwd, { missing, hint })}>
        <Folder /> {name}<span className="caret">▾</span>
      </button>
      {open && <DirBrowser start={cwd ?? ""} server={server} onPick={async (d) => { await onPick(d); rememberDir(d, server); setOpen(false); }} />}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

/** The folders of a server (this computer's, or the chat's own server's): read there, shortened
 *  with that server's home, started at its default folder, with its own recent folders. */
export function DirBrowser({ start, server = LOCAL_SERVER, onPick }: { start: string; server?: string; onPick: (dir: string) => Promise<void> }) {
  const where = useWhere({ server });
  const tilde = (p?: string) => tildify(p, server);
  const [at, setAt] = useState<Dirs | null>(null);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const go = async (p: string) => {
    try { const r = await api.dirs(p, server); setAt(r); setTyped(tilde(r.path)); setErr(""); return true; }
    catch (e: any) { setErr(e.message); return false; }
  };
  useEffect(() => {
    (async () => {
      const [first, then] = folderStarts(listsOf(getState(), server));
      if (start && await go(start)) return;
      if (!await go(first)) void go(then);
    })();
  }, []);
  const use = async (p: string) => { try { await onPick(p); } catch (e: any) { setErr(e.message); } };
  const recent = recentDirs(server).filter((d) => d !== at?.path).slice(0, 4);
  // Anchored at the chip's left edge and of a fixed width: where the chip is near the window's
  // right edge (a run's narrow stage) it is moved left as a picker's menu is, by what its right
  // edge passes the window's (less a 12px margin), never past the window's left edge.
  const menu = useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = menu.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const over = Math.min(r.right - (window.innerWidth - 12), r.left);
    if (over > 0) el.style.left = `${-over}px`;
  }, []);
  return (
    <div ref={menu} className="menu up dirs" onMouseDown={(e) => e.stopPropagation()}>
      <div className="menu-head">{folderHead(where)}</div>
      <input className="dir-input" value={typed} spellCheck={false} placeholder="~/path/to/project"
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") void go(typed); }} />
      {err && <div className="dir-err">{err}</div>}
      {recent.length > 0 && <>
        <div className="dir-sub">Recent</div>
        {recent.map((d) => <button key={d} className="menu-item dir" onClick={() => void go(d)}><Folder /> {tilde(d)}</button>)}
      </>}
      {at && <>
        <div className="dir-sub">{tilde(at.path)}{at.git && <span className="git">git</span>}</div>
        <div className="dir-list">
          {at.path !== at.parent && <button className="menu-item dir" onClick={() => void go(at.parent)}>↰ ..</button>}
          {at.dirs.map((d) => <button key={d} className="menu-item dir" onClick={() => void go(at.path.replace(/\/$/, "") + "/" + d)}><Folder /> {d}</button>)}
          {!at.dirs.length && <div className="dir-empty">No subfolders</div>}
        </div>
        <div className="dir-foot">
          <button className="btn primary sm" onClick={() => void use(at.path)}>Use {base(at.path) || "/"}</button>
        </div>
      </>}
    </div>
  );
}

// ---- context usage

export const fmtK = (n: number) => n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

function ContextMeter({ c, cat, where }: { c: ChatView; cat?: Catalog; where: Where }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Esc closes the popover, before the composer (where it would stop the agent) sees it.
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  const u = c.usage ?? { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
  if (u.ctxError) return (
    <span className="ctx-meter error" title={u.ctxError}><WarnIcon /> Context unavailable</span>
  );
  const used = (u.ctxIn ?? 0) + (u.ctxOut ?? 0);
  const win = u.ctxWindow || modelOf(c, cat)?.contextWindow || 0;
  const lines = used
    ? [ctxTitle(used, win), "System prompt, tools, board reads and the conversation so far."]
    : [`${win ? `Context window: ${win.toLocaleString()} tokens. ` : ""}Usage shows after the first reply.`];
  // A click opens the context, split by category, and the agent's plan usage limits.
  return (
    <div className="menu-wrap">
      <CtxRing used={used} win={win} open={open} onClick={() => setOpen(!open)} />
      {open && c.agent && <UsagePopover key={usageKey(where.server, c.agent)} agent={c.agent} where={where} context={<ContextSection key={c.id} c={c} lines={lines} />} />}
      {open && <div className="menu-backdrop" onMouseDown={() => setOpen(false)} />}
    </div>
  );
}

export const ctxTitle = (used: number, win: number) =>
  `Context: ${used.toLocaleString()}${win ? ` of ${win.toLocaleString()}` : ""} tokens${win ? ` (${(Math.min(1, used / win) * 100).toFixed(1)}%)` : ""}`;

/** The ring with "used / window pct%": the composer's meter, and each subagent's. With onClick it
 * is a button (the composer's); without, a span with a hover title (each subagent's). */
export function CtxRing({ used, win, title, className = "", open, onClick }: {
  used: number; win: number; title?: string; className?: string; open?: boolean; onClick?: () => void;
}) {
  const pct = win ? Math.min(1, used / win) : 0;
  const r = 6, circ = 2 * Math.PI * r;
  const tone = pct > 0.8 ? "danger" : pct > 0.5 ? "warn" : "ok";
  const body = <>
    <svg width="16" height="16" viewBox="0 0 16 16">
      <circle cx="8" cy="8" r={r} className="ring-bg" />
      <circle cx="8" cy="8" r={r} className="ring" strokeDasharray={`${circ * pct} ${circ}`} transform="rotate(-90 8 8)" />
    </svg>
    {used ? <>{fmtK(used)}{win ? <> / {fmtK(win)}<span className="ctx-pct">{pct < 0.1 ? (pct * 100).toFixed(1) : Math.round(pct * 100)}%</span></> : null}</> : null}
  </>;
  if (onClick) return (
    <button type="button" className={`ctx-meter ${tone} ${open ? "on" : ""} ${className}`} aria-expanded={!!open}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{body}</button>
  );
  return <span className={`ctx-meter ${tone} ${className}`} title={title}>{body}</span>;
}

// ---- plan usage

/** Each agent's last usage answer by server (usageKey), kept while the page is open so the popover opens with numbers. */
const lastUsage: Record<string, PlanUsage> = {};

/** The composer ring's popover: the chat's context, then the plan's limits, fetched on open.
 * Claude's come from `claude -p /usage`, Cursor's from `cursor-cost`. Pi has none: its popover
 * is the context alone, and nothing is asked. The plan is the one of the chat's server, which is asked. */
function UsagePopover({ agent, where, context }: { agent: AgentKind; where: Where; context: React.ReactNode }) {
  const own = agentMeta(agent).usageTitle;
  const title = own && usageTitleOn(where, own);
  const key = usageKey(where.server, agent);
  const [u, setU] = useState<PlanUsage | null>(lastUsage[key] ?? null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try { const r = await api.usage(agent, fresh, where.server); lastUsage[key] = r; setU(r); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setLoading(false); setNow(Date.now()); }
  };
  useEffect(() => {
    if (!title) return;
    void load(false);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  // Anchored at the ring's left edge and of a fixed width: when it opens it is moved left as a
  // picker's menu is, by what its right edge passes the window's (less a 12px margin), never past
  // the window's left edge.
  const pop = useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const over = Math.min(r.right - (window.innerWidth - 12), r.left);
    if (over > 0) el.style.left = `${-over}px`;
  }, []);
  if (!title) return <div ref={pop} className="menu up usage-pop" onMouseDown={(e) => e.preventDefault()}>{context}</div>;
  return (
    <div ref={pop} className="menu up usage-pop" onMouseDown={(e) => e.preventDefault()}>
      {context}
      <div className="menu-sep" />
      <div className="menu-head">
        {title}<span className="grow" />
        <button className="icon-btn usage-refresh" title="Check again" disabled={loading} onClick={() => void load(true)}>
          <span className={loading ? "usage-spin" : ""}>↻</span>
        </button>
      </div>
      {!u && loading && <div className="usage-note">Checking your plan…</div>}
      {u && !u.plan && <div className="usage-note">{u.note || `${agentName(agent)} reported no plan limits.`}</div>}
      {u?.plan && sortLimits(u.limits).map((l) => <LimitRow key={l.kind + l.label} l={l} now={now} />)}
      {u?.plan && u.note && <div className="usage-err"><WarnIcon /> {u.note}</div>}
      {err && <div className="usage-err"><WarnIcon /> {err}</div>}
      {u && <div className={`usage-foot ${!loading && isStale(u.fetchedAt, now) ? "stale" : ""}`}>
        {loading ? "Updating…" : `Updated ${updatedAgo(u.fetchedAt, now)}`}
      </div>}
    </div>
  );
}

function LimitRow({ l, now }: { l: UsageLimit; now: number }) {
  const when = [resetIn(l.resetsAt, now), resetAt(l.resetsAt, now)].filter(Boolean).join(" · ");
  return (
    <div className={`usage-row ${limitTone(l)}`}>
      <div className="usage-top"><span>{l.label}</span><span className="usage-pct">{l.detail && <span className="usage-detail">{l.detail} · </span>}{Math.round(l.percent)}%</span></div>
      <div className="usage-bar"><span style={{ width: `${Math.min(100, Math.max(0, l.percent))}%` }} /></div>
      {when && <div className="usage-reset" title={l.resetsAt && new Date(l.resetsAt).toLocaleString()}>Resets {when}</div>}
    </div>
  );
}

// ---- context split

/** Each branch's last context split, kept while the page is open so the popover opens with it. */
const lastSplit: Record<BranchKey, ContextSplit> = {};

/** The popover's context: the ring's numbers, then what fills the context as the agent splits it,
 * asked for on open. The server answers Claude's from chat.json while no message or turn has
 * moved past it, else asks Claude (about 2 s without a running process); Cursor's it reads from
 * its session store. */
function ContextSection({ c, lines }: { c: ChatView; lines: string[] }) {
  const branch = useStore((st) => shownBranch(st, c.id)), key = useStore((st) => shownKey(st, c.id));
  const [s, setS] = useState<ContextSplit | null>(() => lastSplit[key] ?? null);
  const on = useRef(branch); // the branch now, for an answer that comes after it changed
  on.current = branch;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const load = async (fresh: boolean) => {
    setLoading(true); setErr("");
    try {
      const r = await api.contextSplit(c.id, branch, fresh);
      lastSplit[key] = r;
      if (on.current !== branch) return;
      setS(r);
    }
    catch (e: any) { if (!(e instanceof ApiError && e.status === 409)) setErr(e?.message ?? String(e)); } // 409: not started
    finally { setLoading(false); }
  };
  useEffect(() => { setS(lastSplit[key] ?? null); if (c.locked) void load(false); }, [branch]);
  return <>
    <div className="menu-head">
      Context<span className="grow" />
      {c.locked && <button className="icon-btn usage-refresh" title="Count again" disabled={loading} onClick={() => void load(true)}>
        <span className={loading ? "usage-spin" : ""}>↻</span>
      </button>}
    </div>
    <div className="usage-ctx">{(s ? lines.slice(0, 1) : lines).map((l) => <div key={l}>{l}</div>)}</div>
    {!s && loading && <div className="usage-note">Counting what fills it…</div>}
    {s && c.agent && <SplitView agent={c.agent} s={s} loading={loading} />}
    {err && <div className="usage-err"><WarnIcon /> {err}</div>}
  </>;
}

/** The split: a bar over the whole window, then a row per category (a click opens its parts or
 * items), what is listed but not loaded, and the agent's facts. Hovering a segment or a row marks
 * both. */
function SplitView({ agent, s, loading }: { agent: AgentKind; s: ContextSplit; loading: boolean }) {
  const [hover, setHover] = useState("");
  const win = s.window || s.total;
  const segs = segments(agent, s.categories);
  const free = freeTokens(s.categories, win);
  const notLoaded = deferred(s.categories);
  const row = (g: Segment) => <SplitRow key={g.cat.id} g={g} win={win} hover={hover} setHover={setHover} />;
  return (
    <div className="split" onMouseLeave={() => setHover("")}>
      <SplitBar segs={segs} win={win} hover={hover} setHover={setHover} />
      {segs.map(row)}
      {free > 0 && <SplitRow g={{ cat: { id: "free", label: "Free space", tokens: free, kind: "free" }, slot: 0 }} win={win} hover={hover} setHover={setHover} />}
      {notLoaded.length > 0 && <>
        <div className="split-sub">Listed, loaded when used</div>
        {notLoaded.map((cat) => row({ cat, slot: 0 }))}
      </>}
      {!!s.facts?.length && <div className="split-facts">
        {s.facts.map((f) => <React.Fragment key={f.label}><span>{f.label}</span><span>{f.value}</span></React.Fragment>)}
      </div>}
      <div className="usage-foot">
        {loading ? "Updating…" : `As of message ${s.atMessage} · ${tokensText(s.total)} tokens as ${agentName(agent)} counts them`}
      </div>
    </div>
  );
}

/** Segments side by side over win tokens; the rest of the track is free space. */
function SplitBar({ segs, win, hover, setHover }: { segs: Segment[]; win: number; hover: string; setHover: (id: string) => void }) {
  const marked = segs.some((g) => g.cat.id === hover); // a row of another bar leaves this one alone
  return (
    <div className="split-bar" role="img" aria-label={segs.map((g) => `${g.cat.label} ${share(g.cat.tokens, win)}`).join(", ")}>
      {segs.map((g) => <span key={g.cat.id} className={`split-seg ${swatch(g)} ${marked && hover !== g.cat.id ? "dim" : ""}`}
        style={{ flexBasis: `${width(g.cat.tokens, win)}%` }} onMouseEnter={() => setHover(g.cat.id)}
        title={`${g.cat.label}: ${tokensText(g.cat.tokens)} tokens (${share(g.cat.tokens, win)})`} />)}
      <span className="split-free" />
    </div>
  );
}

const swatch = (g: Segment) =>
  g.cat.kind === "buffer" ? "hatch" : g.cat.kind === "free" ? "free" : g.cat.kind === "deferred" ? "none" : `s${g.slot}`;

/** A category's row: swatch, label, tokens and share of the window. With parts (Claude's
 * Messages) a click opens their own bar and rows; with items, a list of them, largest first. */
function SplitRow({ g, win, hover, setHover, depth = 0 }: {
  g: Segment; win: number; hover: string; setHover: (id: string) => void; depth?: number;
}) {
  const [open, setOpen] = useState(false);
  const { cat } = g;
  const parts = partSegments(cat.parts);
  const items = byTokens(cat.items);
  const more = parts.length > 0 || items.length > 0;
  const body = <>
    <span className={`split-caret ${open ? "open" : ""}`}>{more && <Chevron />}</span>
    <i className={`split-sw ${swatch(g)}`} />
    <span className="split-label">{cat.label}</span>
    <span className="split-num">{tokensText(cat.tokens)}</span>
    <span className="split-pct">{share(cat.tokens, win)}</span>
  </>;
  const props = {
    className: `split-row ${hover === cat.id ? "on" : ""} ${cat.kind === "deferred" ? "off" : ""}`,
    style: { paddingLeft: 4 + depth * 12 },
    onMouseEnter: () => setHover(cat.id),
    title: cat.chars ? `${tokensText(cat.chars)} characters` : undefined,
  };
  return <>
    {more ? <button type="button" {...props} aria-expanded={open} onClick={() => setOpen(!open)}>{body}</button> : <div {...props}>{body}</div>}
    {open && parts.length > 0 && <div className="split-nest" style={{ paddingLeft: 16 + depth * 12 }}>
      <SplitBar segs={parts} win={cat.tokens} hover={hover} setHover={setHover} />
    </div>}
    {open && parts.map((p) => <SplitRow key={p.cat.id} g={p} win={win} hover={hover} setHover={setHover} depth={depth + 1} />)}
    {open && items.length > 0 && <div className="split-items" style={{ paddingLeft: 30 + depth * 12 }}>
      {items.map((it, i) => <div key={i} className="split-item">
        <span className="split-label" title={it.note ? `${it.name} (${it.note})` : it.name}>
          {it.name}{it.note && <span className="split-note"> · {it.note}</span>}
        </span>
        <span className="split-num">{tokensText(it.tokens)}</span>
      </div>)}
    </div>}
  </>;
}
