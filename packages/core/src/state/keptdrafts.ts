// The drafts of the composers that are not open, saved when the page's stream is back
// (logic/draftsback.ts KeptDrafts): what that asks of the page. The copies are the browser's
// (store.ts), which keeps them for this computer's chats alone; a composer is open while it is
// registered for a move (fork/actions.ts), and a save is the one a composer's saver makes
// (chatdraft.ts saveDraft), so the store learns of it the same way. conn.ts tells draftBacks of a
// stream's snapshot.
import { getState, draftRevOf, keptDrafts, keptRaw, unsavedDraft } from "./store.ts";
import { saveDraft } from "./chatdraft.ts";
import { composerOpen } from "./actions.ts";
import { KeptDrafts, draftBacks } from "../logic/draftsback.ts";

/** From now on the drafts kept of the composers that are not open are saved when the page's stream is back. */
export function watchKeptDrafts(): void {
  draftBacks.kept = new KeptDrafts({
    all: keptDrafts,
    raw: keptRaw,
    write: (chat, branch, d, base) => unsavedDraft(chat, branch).write(d, base),
    open: composerOpen,
    moving: (chat) => !!getState().moves[chat],
    known: (chat) => !!getState().chats[chat],
    rev: draftRevOf,
    save: (chat, branch, d, base) => saveDraft(chat, branch, d, false, base),
  });
}
