// A branch's unsent message, kept on the server (PUT /api/chats/{id}/draft?branch=) so it
// survives switching chats and branches, reloads and restarts. Each branch of a chat has its
// own. DOM-free: Composer keeps one DraftSaver per open composer and gives it every change.
//
// A page that reloads or closes is no longer a client the server knows once its event stream
// drops, so a save sent while the page goes away can be refused (`unknown_client`). Each change
// is therefore also kept in an Unsaved copy (localStorage) until the server has it; the composer
// opens with that copy over the server's draft and saves it again.

import { MAIN, type BranchState, type ChatView, type Draft, type Held, type Reference } from "../types.ts";
import type { Picked } from "./mentions.ts";
import { currentBranch, stateFromView } from "./branches.ts";
import { mergeQuotes } from "./quotes.ts";

/** How long typing pauses before the draft is saved. */
export const DRAFT_DELAY = 400;

/** How long after a Send's answer the removal of the sent draft is still taken as that Send's:
 *  the event that tells of it can reach the page just after the answer. */
export const SEND_GRACE = 1000;

/** The draft for a composer's value and quotes: blank text and no quotes is no draft, and
 *  mentions only go with text. */
export function draftOf(text: string, picked: Picked[] = [], references: Reference[] = []): Draft {
  const d: Draft = { text: text.trim() ? text : "" };
  if (d.text && picked.length) d.mentions = picked;
  if (references.length) d.references = references;
  return d;
}

/** Whether a draft has anything to keep. */
export const hasDraft = (d?: Draft | null): d is Draft => !!(d?.text || d?.references?.length);

/** Whether any branch of a chat has a draft: the server's count over its branches, else the
 *  current branch's own draft. */
export const chatHasDraft = (c?: ChatView | null): boolean => !!c && (c.hasDraft ?? hasDraft(c.draft));

/** Whether a branch of a chat other than the one shown has a draft, from the chat's records: the
 *  shown branch's own draft is in the composer, another branch's is nowhere in the chat. */
export const otherDrafts = (states: readonly Pick<BranchState, "branch" | "draft">[], shown: string): boolean =>
  states.some((st) => (st.branch || MAIN) !== (shown || MAIN) && hasDraft(st.draft));

/** The localStorage key of a branch's unsaved draft. */
export const draftKey = (chat: string, branch: string): string => `aiwb.draft.${chat}:${branch}`;
/** The key a chat's unsaved draft had while a chat had one draft; what it holds belongs under
 *  draftKey of the chat's current branch. */
export const legacyDraftKey = (chat: string): string => `aiwb.draft.${chat}`;

/** Whether a localStorage key holds an unsaved draft of a chat: a branch's, or the one the chat
 *  had before each branch had its own. */
export const draftKeyOf = (key: string, chat: string): boolean => key === legacyDraftKey(chat) || key.startsWith(legacyDraftKey(chat) + ":");

/** The renames that bring the unsaved drafts kept per chat under their chats' current branches,
 *  each [from, to]. keys: the localStorage keys; current: a chat's current branch, undefined for
 *  a chat that is not known, whose key is left as it is. */
export function legacyDraftRenames(keys: readonly string[], current: (chat: string) => string | undefined): [string, string][] {
  const prefix = legacyDraftKey("");
  const out: [string, string][] = [];
  for (const k of keys) {
    if (!k.startsWith(prefix) || k.includes(":", prefix.length)) continue; // a branch's key has the colon; an id has none
    const chat = k.slice(prefix.length), branch = chat ? current(chat) : undefined;
    if (branch !== undefined) out.push([k, draftKey(chat, branch)]);
  }
  return out;
}

/** A branch's draft that the server may not have yet; null: nothing waiting. base: the draft
 *  counter the copy was typed on; none for a copy of a build before the counter, and for a run's
 *  goal, which has no counter. */
export type Unsaved = { read(): Draft | null; write(d: Draft | null, base?: number): void; base?(): number | undefined };

/** The unsaved copy a composer opens with. rev: the server's counter of the branch's draft,
 *  undefined when it is not known. A copy typed on another counter is dropped: the server's draft
 *  is newer, and the copy would replace it at the next save. A copy with no base is used. */
export function unsavedToShow(u: Unsaved, rev?: number): Draft | null {
  const d = u.read();
  if (!d) return null;
  const base = u.base?.();
  if (base === undefined || rev === undefined || base === rev) return d;
  u.write(null);
  return null;
}

/** What a refused save tells when the draft was changed elsewhere (409 `stale`): the server's
 *  counter and its draft, the empty one for none. null: another error. */
export function staleOf(e: unknown): { rev: number; draft: Draft } | null {
  const x = e as { code?: unknown; rev?: unknown; draft?: Draft | null } | null;
  return x?.code === "stale" && typeof x.rev === "number" ? { rev: x.rev, draft: x.draft ?? NONE } : null;
}

const key = (d: Draft) => JSON.stringify(d);
const NONE: Draft = { text: "" };
const EMPTY = key(NONE);
const ofHeld = (h: Held): Draft => draftOf(h.text, h.mentions, h.references);

/** Whether what a save refused as stale tells (the server's counter and its draft) goes into the
 *  store: not when the counter known here is a later one, whose draft an event brought since. */
export const staleTaken = (rev: number, known?: number): boolean => rev >= (known ?? 0);

/** Whether a save's answer brings a counter later than the one known here: the store then gets
 *  that counter together with the draft saved, which is the server's on it. Left with the draft
 *  an earlier event brought, the record would give the composer's saver that one as the draft on
 *  the new counter (arrived), and the saver would put it into the box over the text just saved. */
export const answerNewer = (rev: unknown, known?: number): rev is number => typeof rev === "number" && rev > (known ?? 0);

/** The text a composer's box gets as it appears (on open, after an unarchive): the draft's to
 *  show; with no draft, the text the composer holds, which was set while no box was drawn (an
 *  archived chat draws none). null: nothing to put in. */
export const boxText = (d: Draft | null | undefined, held: string): string | null => (hasDraft(d) ? d.text : held || null);

/** A draft as what a composer holds. */
export const heldOf = (d: Draft): Held => ({ text: d.text, mentions: d.mentions ?? [], references: d.references ?? [] });

/** Whether two drafts are the same; none is the empty one. */
export const sameDraft = (a?: Draft | null, b?: Draft | null): boolean => key(ofHeld(heldOf(a ?? NONE))) === key(ofHeld(heldOf(b ?? NONE)));

/** Two drafts in the one place there is for both: the texts one after the other, with the
 *  mentions and the quotes of both. The same draft twice, or one with nothing, is one draft. */
export function joinDrafts(a: Draft, b?: Draft | null): Draft {
  if (!hasDraft(b) || sameDraft(a, b)) return a;
  if (!hasDraft(a)) return b;
  const mentions = [...(a.mentions ?? []), ...(b.mentions ?? []).filter((m) => !a.mentions?.some((x) => x.id === m.id && x.name === m.name))];
  return draftOf(a.text && b.text ? `${a.text}\n\n${b.text}` : a.text || b.text, mentions, mergeQuotes(a.references ?? [], b.references ?? []));
}

/** The drafts a sent move leaves. A move makes a new branch, which has no draft, and the server
 *  clears only the draft of the branch a message was sent on: the composer's draft was the one of
 *  the branch left, and nothing cleared it.
 *  aside: the draft the move had put aside for the message it put into the composer (Branch and
 *  edit); null when it put nothing: what the composer held was that draft, and it was sent.
 *  typed: what the composer got after the Send.
 *  moved: the chat is on the new branch. left, the draft of the branch left, is then what was
 *  put aside, or none; to, the one of the new branch, is what was typed, null when nothing was.
 *  Not moved (the move ended while the chat still shows the branch left, the new one not being
 *  known): its composer holds what was typed, so that goes to the branch left, before what was
 *  put aside, and to is null. */
export function draftsAfterSent(aside: Held | null, typed: Held, moved: boolean): { left: Draft; to: Draft | null } {
  const t = ofHeld(typed), a = aside ? ofHeld(aside) : NONE;
  if (!moved) return { left: joinDrafts(t, a), to: null };
  return { left: a, to: hasDraft(t) ? t : null };
}

/** What a branch's draft set here changes in the store, before the server tells of it. states:
 *  the chat's records, the current branch's being the view's own when the server sent none.
 *  state: the branch's record with the draft, when one is kept. view: the chat's view, which has
 *  the draft of its current branch and tells whether any branch has one; c itself when neither
 *  changes. */
export function draftSet(c: ChatView, states: readonly BranchState[], branch: string, d: Draft): { state?: BranchState; view: ChatView } {
  const b = branch || MAIN, draft = hasDraft(d) ? d : undefined;
  const on = (st: BranchState) => (st.branch || MAIN) === b;
  const st = states.find(on);
  const out: { state?: BranchState; view: ChatView } = { view: c };
  if (st && st !== stateFromView(c)) {
    const { draft: _, ...rest } = st;
    out.state = draft ? { ...rest, draft } : rest;
  }
  const cur = currentBranch(c) === b;
  const any = !!draft || states.some((x) => !on(x) && hasDraft(x.draft));
  if ((cur && !sameDraft(c.draft, draft)) || any !== chatHasDraft(c)) {
    const { draft: was, hasDraft: __, ...rest } = c;
    const mine = cur ? draft : was;
    out.view = { ...rest, ...(mine ? { draft: mine } : {}), ...(any ? { hasDraft: true } : {}) };
  }
  return out;
}

/** What a save's answer changes in the store: the branch's record with the counter the server
 *  gave; undefined when no record is kept or it has that counter or a later one. */
export function revSet(c: ChatView, states: readonly BranchState[], branch: string, rev: number): BranchState | undefined {
  const st = states.find((x) => (x.branch || MAIN) === (branch || MAIN));
  if (!st || st === stateFromView(c) || (st.draftRev ?? 0) >= rev) return undefined;
  return { ...st, draftRev: rev };
}

/** Saves a composer's draft DRAFT_DELAY after the last change, skipping what is saved already.
 *  With a base (the server's counter of the draft) each save names it, one save at a time, and a
 *  draft changed elsewhere is not overwritten: see arrived.
 *
 *  A save refused as stale keeps its text when it has any and nothing was typed since: the user
 *  typed that text after the draft it was based on, so it stays in the composer whatever the
 *  server has stored (another window's draft, or none), and is saved again on the counter the
 *  refusal gave. The last save wins on the server, whichever window's timer fired first. Only a
 *  refused save of no text (the composer was emptied here) shows the stored draft.
 *
 *  A draft of the server's that is none does not always mean that another window cleared it: a
 *  Send removes the sent draft on the server, and nothing tells that removal from one made
 *  elsewhere. A draft arriving as none (arrived) while the composer holds saved text keeps that
 *  text and saves it again only while this composer's own Send is on its way (sending) and no
 *  removal has come since it started: the removal is then taken as that Send's, come after the
 *  save of the text typed since (a server that takes the message late; one that removes the sent
 *  draft only on the counter the Send found sends no such removal). With no Send of this
 *  composer's on its way the saved text is what another window sent or cleared, and it goes:
 *  kept, it would come back as a draft in the window that sent it.
 *  A draft that is not none arriving replaces saved text as before.
 *
 *  A Send that removes nothing sends no removal (one that was refused, one whose text the server
 *  never had, one whose counter moved), and the next removal is then another window's. So only
 *  text that this composer itself saved since its Send began is saved again (own): a draft that
 *  was there before, or one that came from elsewhere, is what the other window sent or cleared.
 *  And the Send is over at once, with no grace, when its answer tells that it removed nothing: it
 *  was refused, or the server had no draft when it began and this composer saved none while it ran.
 *
 *  A held Send (sending with hold: the first message of a chat on another server, one call that
 *  can take long) saves nothing until it is answered: the text is saved at once if it was not
 *  yet, and stays the draft on the server while the composer is empty, so a page that reloads
 *  meanwhile shows it. The emptied draft is never saved: accepted, the server removed the sent
 *  draft itself; refused, the text is the draft still. Only when the Send is answered before the
 *  save of its own text is, the emptied draft waits for that save's answer: it is dropped when
 *  that tells of the removal, and saved when the text landed after all. Text typed meanwhile is
 *  saved after the answer, or at once by a page that goes away.
 *
 *  A Send that fails puts its message back into the composer, but not one whose draft was removed
 *  on the server while the Send was on its way (mine, gone): another window sent that very draft,
 *  or the Send was taken after all, and put back it would be a draft of a sent message in every
 *  window. What sending answers tells the composer so. */
export class DraftSaver {
  private put: (d: Draft, keepalive: boolean, base?: number) => Promise<unknown>;
  private unsaved?: Unsaved;
  private delay: number;
  private saved: string;
  private pending: Draft | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private base: number | undefined;
  private show?: (d: Draft) => void;
  private flying: string | null = null; // the draft of the save in flight
  private held = false;                 // a flush waits for the save in flight to end
  private late: Draft | null = null;    // a newer draft that came while a save was in flight
  private sent: object | null = null;   // this composer's Send is on its way (sending), and no removal of a draft has come since it started
  private own: string | null = null;    // the text this composer saved since that Send began: what a removal taken as the Send's leaves to save again
  private had = false;                  // the server had a draft, or a save was in flight, when that Send began: it has one to remove
  private wait: object | null = null;   // a held Send is on its way: nothing is saved until it is answered
  private mine: string | null = null;   // the draft that Send sent, while it is the server's (saved, or its save in flight): null once the server has another, or never had it
  private gone: object | null = null;   // the Send whose draft (mine) was removed on the server while it was on its way

  /** put saves a draft (keepalive: the page is going away) on the counter base, and answers the
   *  new counter; saved is the server's draft now and base its counter, undefined for a draft
   *  with no counter; show puts a draft of the server's into the composer. */
  constructor(put: (d: Draft, keepalive: boolean, base?: number) => Promise<unknown>, saved?: Draft, unsaved?: Unsaved, delay = DRAFT_DELAY,
    base?: number, show?: (d: Draft) => void) {
    this.put = put;
    this.unsaved = unsaved;
    this.delay = delay;
    this.saved = key(draftOf(saved?.text ?? "", saved?.mentions, saved?.references));
    this.base = base;
    this.show = show;
  }

  /** This composer's Send is on its way: the server removes the sent draft, and that removal,
   *  when it arrives over text typed and saved since, is not another window's (the class's
   *  comment). hold: nothing is saved until the Send is answered (a held Send). Answers what to
   *  call once the Send's POST is answered; refused: the server answered that it did not take the
   *  message, so it removed nothing. The Send is then over after grace, unless a later one runs,
   *  and at once when it can have removed nothing. That call answers whether the sent draft was
   *  removed on the server while the Send was on its way: a Send that failed then puts nothing
   *  back (the class's comment). */
  sending(grace = SEND_GRACE, hold = false): (refused?: boolean) => boolean {
    const mark = {};
    if (hold) this.flush(); // text typed just before the Send: the server has it while the Send waits
    this.sent = mark;
    this.own = null;
    this.had = this.saved !== EMPTY || this.flying !== null;
    this.mine = !this.pending && this.saved !== EMPTY ? this.saved : null; // text not saved yet is no draft another window can send
    this.gone = null;
    if (hold) this.wait = mark;
    return (refused = false) => {
      const removed = this.gone === mark;
      if (removed) this.gone = null;
      if (this.wait === mark) this.release(refused);
      if (this.sent !== mark) return removed;
      const saving = this.own !== null || (this.flying !== null && this.flying !== EMPTY); // text of this composer's that the Send can have found
      if (refused || (!this.had && !saving)) this.sent = null;
      else setTimeout(() => { if (this.sent === mark) this.sent = null; }, grace);
      return removed;
    };
  }

  /** The held Send is answered. The emptied draft is not saved: see the class's comment. Text
   *  typed meanwhile is saved after the pause, when the removal of the sent draft has come. */
  private release(refused: boolean) {
    this.wait = null;
    if (!this.pending) return;
    clearTimeout(this.timer);
    if (!hasDraft(this.pending)) {
      // Answered before the save of the sent text is: the emptied draft waits for that answer. Dropped here, a save refused as stale would take the
      // sent text as what the composer holds still, and save it again.
      if (!refused && this.flying !== null && this.flying !== EMPTY) { this.held = true; return; }
      this.pending = null; this.held = false;
      return;
    }
    this.timer = setTimeout(() => this.flush(false), this.delay);
  }

  /** Keeps the unsaved copy of what is pending. A held Send's emptied draft is none to keep: the
   *  copy is then the text whose save is still in flight, else none, and a page that reloads
   *  shows the server's draft, the sent text. */
  private note(base = this.base) {
    const d = this.pending;
    if (!d) return;
    if (this.wait && !hasDraft(d)) this.unsaved?.write(this.flying !== null && this.flying !== EMPTY ? JSON.parse(this.flying) as Draft : null, base);
    else this.unsaved?.write(d, base);
  }

  change(text: string, picked: Picked[] = [], references: Reference[] = []) {
    clearTimeout(this.timer);
    const d = draftOf(text, picked, references);
    if (key(d) === this.saved) {
      this.pending = null;
      this.unsaved?.write(null);
      return;
    }
    this.pending = d;
    this.note();
    this.timer = setTimeout(() => this.flush(false), this.delay);
  }

  /** Saves the pending draft now, if there is one. While a save is in flight it waits for that
   *  one's answer, which has the counter to name; a page that goes away cannot wait, and names
   *  the counter that save leaves. While a held Send is on its way nothing is saved, but text by
   *  a page that goes away. */
  flush(keepalive = false) {
    clearTimeout(this.timer);
    const d = this.pending;
    if (!d) return;
    if (this.wait && !(keepalive && hasDraft(d))) return;
    if (this.flying !== null && !keepalive) { this.held = true; return; }
    const k = key(d), before = this.saved, mark = this.sent;
    const base = this.base !== undefined && this.flying !== null ? this.base + 1 : this.base;
    this.pending = null;
    this.held = false;
    this.saved = k;
    this.flying = k;
    this.put(d, keepalive, base).then(
      (rev) => {
        if (this.flying === k) this.flying = null;
        if (this.base !== undefined && typeof rev === "number" && rev > this.base) this.base = rev;
        if (mark && this.sent === mark) this.own = hasDraft(d) ? k : null; // saved since this composer's Send began
        if (k !== this.mine) this.mine = null; // the server's draft is no longer the one that Send sent
        const late = this.take();
        if (late) this.newer(late);
        else if (this.pending) this.note();
        else if (this.saved === k) this.unsaved?.write(null);
        this.next();
      },
      (e) => {
        if (this.flying === k) this.flying = null;
        if (k === this.mine) this.mine = null; // the server never had it
        const stale = this.base === undefined ? null : staleOf(e);
        let late = this.take();
        if (stale && stale.rev >= this.base!) { this.base = stale.rev; late = stale.draft; }
        const typed = !!this.pending || this.saved !== k; // more was typed since
        if (!stale && this.saved === k) this.saved = before; // the unsaved copy stays for the next open
        // Refused for another reason (the stream was down, the network): the draft is pending
        // again, with no timer, so that a draft arriving from elsewhere does not replace it.
        if (!stale && !typed) this.pending = d;
        // Stale: the text was typed here since its base, so it stays whatever the server has stored, and next saves it again on the new counter.
        if (stale && !typed && late && hasDraft(d)) { this.pending = d; this.held = true; }
        if (late) this.newer(late);
        this.next();
      },
    );
  }

  /** The server's draft has the counter rev (a `branch_state` event). A newer one than this
   *  composer's is shown when nothing is pending and nothing is in flight; else what was typed
   *  stays and the next save names the new counter. One that equals the save in flight is its echo.
   *  None arriving over saved text while this composer's Send is on its way leaves the text and
   *  saves it again (the class's comment says why). */
  arrived(rev: number, d?: Draft | null) {
    if (this.base === undefined || rev <= this.base) return;
    this.base = rev;
    const n = d ?? NONE;
    if (this.flying !== null) {
      this.late = key(ofHeld(heldOf(n))) === this.flying ? null : n;
      this.note(rev);
      return;
    }
    this.newer(n);
    this.next();
  }

  /** This composer's first message was answered `first_text_kept`: the chat started on its server
   *  with an earlier text during the call, which removed the draft and raised its counter by one.
   *  That removal is told here as if its event had come, so that the text the composer puts back
   *  is saved as the started chat's draft, and the event, coming after it, does not empty the box.
   *  Only while no removal has come since the Send began (sent; one that waits for a save in
   *  flight is in late): it was that one then, and the counter has it already. It counts from
   *  this saver's own counter, the one its saves name, and not from the store's record: that can
   *  have a later draft of another window's by now, and one counter too high is never corrected,
   *  where one too low is by the save refused as stale. */
  kept() {
    if (!this.sent || this.base === undefined || (this.late && !hasDraft(this.late))) return;
    this.arrived(this.base + 1, null);
  }

  /** The newer draft kept while a save was in flight, once none is. */
  private take(): Draft | null {
    if (this.flying !== null) return null;
    const late = this.late;
    this.late = null;
    return late;
  }

  /** The server has d, changed elsewhere, and nothing is in flight. */
  private newer(d: Draft) {
    const k = key(ofHeld(heldOf(d))), was = this.saved, same = k === was;
    const sent = !!this.sent && k === EMPTY, own = this.own;
    if (sent && this.mine !== null) this.gone = this.sent; // the draft this composer's Send sent was removed: by that Send, or by another window's Send of it
    if (sent) this.sent = null; // a Send removes one draft
    this.own = null; // the server's draft is one from elsewhere
    if (k !== this.mine) this.mine = null;
    this.saved = k;
    if (sent && !this.pending && was !== EMPTY && was === own) { this.pending = JSON.parse(was) as Draft; this.held = true; } // the text typed after this composer's Send: saved again by next
    if (this.pending && key(this.pending) !== k) { this.note(); return; } // what was typed stays, on the new counter
    const typed = !!this.pending; // the same draft was typed here: nothing to save, nothing to put in
    clearTimeout(this.timer);
    this.pending = null;
    this.held = false;
    this.unsaved?.write(null);
    if (!same && !typed) this.show?.(d);
  }

  /** Sends the save that waited for the one in flight. */
  private next() {
    if (this.held && this.pending && this.flying === null) this.flush(false);
  }
}
