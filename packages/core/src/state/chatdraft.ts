// A branch's draft between the page's store and the server: the save every composer and every draft operation goes
// through, the draft a composer opens with, and a draft set from outside a composer. No DOM: Composer.tsx, fork/actions.ts
// and uploads.ts act through these.
import { api } from "../api.ts";
import { getState, upsertChat, upsertState, unsavedDraft, draftRevOf, branchState, statesOfChat } from "./store.ts";
import { answerNewer, draftOf, draftSet, revSet, sameDraft, staleOf, staleTaken, unsavedToShow } from "../logic/drafts.ts";
import { withoutImages } from "../logic/chatimage.ts";
import { branchKey } from "../logic/branches.ts";
import { imagesGone } from "./uploads.ts";
import type { Draft } from "../types.ts";

/** The saves of a branch's draft that are on their way, by the branch's key. */
const flying = new Map<string, Set<Promise<unknown>>>();

/** Resolves when no save of a branch's draft is on its way: also not one that the end of another started. */
export async function savesDone(chat: string, branch: string): Promise<void> {
  const key = branchKey(chat, branch);
  for (let set = flying.get(key); set?.size; set = flying.get(key)) await Promise.allSettled([...set]);
}

/** d without the images named. */
const without = (d: Draft, ids: readonly string[]): Draft => draftOf(d.text, d.references, withoutImages(d.images ?? [], ids));

/** Saves a branch's draft on the server, and in the store at once (on the branch's record, and
 *  on the chat's view when the branch is its current one): a composer reopened before the
 *  server's events come back starts from it. base: the counter the draft was typed on, the one
 *  known here when the caller keeps none. Answers the new counter, which the branch's record
 *  gets, with the draft it counts when it is a later one than the record's (an event that came
 *  while the save was on its way has put the server's earlier draft there, and the composer's
 *  saver would take that one for the draft on the new counter); a save refused as stale puts the
 *  server's draft and counter there, unless the record has a later counter by then (staleTaken).
 *  A draft that names images the chat does not hold is saved without them, and the answer names
 *  them: the draft the store gets is then the one without them, and the branch's composer is told
 *  (uploads.ts imagesGone), which takes them out of its strip and says what must be added again. */
export function saveDraft(chat: string, branch: string, d: Draft, keepalive = false, base?: number): Promise<number | undefined> {
  if (!storeDraft(chat, branch, d)) return Promise.resolve(undefined); // deleted
  const key = branchKey(chat, branch), set = flying.get(key) ?? new Set();
  flying.set(key, set);
  const p = (async () => {
    try {
      const { rev, missing } = await api.saveDraft(chat, branch, d, base ?? draftRevOf(chat, branch) ?? 0, keepalive);
      if (answerNewer(rev, draftRevOf(chat, branch))) storeDraft(chat, branch, missing ? without(d, missing) : d);
      setDraftRev(chat, branch, rev);
      if (missing) imagesGone(chat, branch, (d.images ?? []).filter((x) => missing.includes(x.id)));
      return rev;
    } catch (e) {
      console.warn(`draft of ${chat} on ${branch} not saved:`, e);
      const stale = staleOf(e);
      if (stale && staleTaken(stale.rev, draftRevOf(chat, branch)) && storeDraft(chat, branch, stale.draft)) setDraftRev(chat, branch, stale.rev);
      throw e;
    }
  })();
  set.add(p);
  const done = () => { set.delete(p); if (!set.size && flying.get(key) === set) flying.delete(key); };
  p.then(done, done);
  return p;
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

/** Sets a branch's draft from outside its composer: as its unsaved draft, which the branch's next
 *  composer opens with and saves, and on the server. The unsaved copy goes when the server has
 *  the draft. When the save failed and the copy is gone (a composer of the branch took it), it is
 *  there again only when d is still the branch's draft here: a newer one is not replaced by it.
 *  Rejects as the save does. */
export function putDraft(chat: string, branch: string, d: Draft): Promise<void> {
  const unsaved = unsavedDraft(chat, branch);
  unsaved.write(d);
  return saveDraft(chat, branch, d).then(
    () => { if (sameDraft(unsaved.read(), d)) unsaved.write(null); },
    (e) => { if (!unsaved.read() && sameDraft(branchState(getState(), chat, branch)?.draft, d)) unsaved.write(d); throw e; },
  );
}
