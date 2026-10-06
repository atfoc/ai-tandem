// A branch's unsent message, kept on the server (PUT /api/chats/{id}/draft?branch=) so it
// survives switching chats and branches, reloads and restarts. Each branch of a chat has its
// own. DOM-free: Composer keeps one DraftSaver per open composer and gives it every change.
//
// A tab that reloads or closes stops being the active client as its event stream
// drops, so a save sent while the page goes away can be refused. Each change is
// therefore also kept in an Unsaved copy (localStorage) until the server has it;
// the composer opens with that copy over the server's draft and saves it again.

import { MAIN, type BranchState, type ChatView, type Draft, type Held, type Reference } from "../types.ts";
import type { Picked } from "./mentions.ts";
import { currentBranch, stateFromView } from "./branches.ts";
import { mergeQuotes } from "./quotes.ts";

/** How long typing pauses before the draft is saved. */
export const DRAFT_DELAY = 400;

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

/** A branch's draft that the server may not have yet; null: nothing waiting. */
export type Unsaved = { read(): Draft | null; write(d: Draft | null): void };

const key = (d: Draft) => JSON.stringify(d);
const NONE: Draft = { text: "" };
const ofHeld = (h: Held): Draft => draftOf(h.text, h.mentions, h.references);

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

/** Saves a composer's draft DRAFT_DELAY after the last change, skipping what is saved already. */
export class DraftSaver {
  private put: (d: Draft, keepalive: boolean) => Promise<unknown>;
  private unsaved?: Unsaved;
  private delay: number;
  private saved: string;
  private pending: Draft | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** put saves a draft (keepalive: the page is going away); saved is the server's draft now. */
  constructor(put: (d: Draft, keepalive: boolean) => Promise<unknown>, saved?: Draft, unsaved?: Unsaved, delay = DRAFT_DELAY) {
    this.put = put;
    this.unsaved = unsaved;
    this.delay = delay;
    this.saved = key(draftOf(saved?.text ?? "", saved?.mentions, saved?.references));
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
    this.unsaved?.write(d);
    this.timer = setTimeout(() => this.flush(false), this.delay);
  }

  /** Saves the pending draft now, if there is one. */
  flush(keepalive = false) {
    clearTimeout(this.timer);
    const d = this.pending;
    if (!d) return;
    const k = key(d), before = this.saved;
    this.pending = null;
    this.saved = k;
    this.put(d, keepalive).then(
      () => { if (!this.pending && this.saved === k) this.unsaved?.write(null); },
      () => { if (this.saved === k) this.saved = before; }, // the unsaved copy stays for the next open
    );
  }
}
