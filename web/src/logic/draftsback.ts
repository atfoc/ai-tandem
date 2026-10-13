// A draft typed while its server was away is saved by itself when that server is connected again
// (a section's tree arrives), and when the page's own connection to the local server opens again
// (`hello`, then the `snapshot` that follows it): conn.ts tells here. Here are the savers of the
// composers that are open (Composer.tsx adds its own, logic/drafts.ts DraftSaver.back), and what
// saves the drafts of the composers that are not: the unsaved copies the browser keeps
// (KeptDrafts), which are of this computer's chats alone. Nothing of a section's chat is kept in
// the browser: what is typed in one while its server is away lives in its open composer, and is
// saved from there. DOM-free.
import { LOCAL_SERVER, type Draft } from "../types.ts";
import { hasDraft, legacyDraftKey, sameDraft, staleOf } from "./drafts.ts";

/** An open composer: the entry id of its chat's server, read when it is asked, and what saves its pending draft. */
export type Backer = { server(): string; back(): void };

export class DraftBacks {
  private open = new Set<Backer>();
  /** What saves the drafts of the composers that are not open (keptdrafts.ts sets the page's); none: they wait for their chat to be opened. */
  kept: KeptDrafts | null = null;

  /** A composer opened; answers what to call when it goes away. */
  add(b: Backer): () => void {
    this.open.add(b);
    return () => { this.open.delete(b); };
  }

  /** A section's tree arrived: that server is connected again. The composers of its chats that
   *  are open save what waits, each on the counter it has: one refused as stale is handled as any
   *  (DraftSaver). A composer that is not open has nothing kept to save. */
  sectionBack(server: string) {
    for (const b of [...this.open]) if ((b.server() || LOCAL_SERVER) === server) b.back();
  }

  /** The page's stream to the local server opened: every chat's calls go through that server, so
   *  every composer saves what waits. (One whose own server is still away fails again, and waits
   *  for its section's tree.) */
  opened() {
    for (const b of [...this.open]) b.back();
  }

  /** The snapshot of a stream that opened is in the store: the chats and the counters of their
   *  drafts are known again, and the drafts kept of the composers that are not open are saved. */
  snapshot() {
    void this.kept?.back();
  }
}

/** The page's own. */
export const draftBacks = new DraftBacks();

// ---- the drafts of the composers that are not open

/** A branch's unsaved draft as the browser keeps it. draft: as it was written, every field of it
 *  (it is handed on as it came). base: the counter it was typed on; none for a copy of a build
 *  before the counter. raw: the copy as stored, by which a later change of it is seen. */
export type Kept = { chat: string; branch: string; draft: Draft; base?: number; raw: string };

const PREFIX = legacyDraftKey("");

/** The unsaved draft a localStorage entry holds; null for a key that is no branch's (a chat's
 *  from before each branch had its own, anything else) and for a value that is no draft. */
export function keptOf(key: string, raw: string | null): Kept | null {
  const at = key.startsWith(PREFIX) ? key.indexOf(":", PREFIX.length) : -1;
  if (at <= PREFIX.length || at === key.length - 1 || raw === null) return null; // (an id has no colon: what is before the first one is the chat)
  try {
    const d = JSON.parse(raw);
    if (typeof d?.text !== "string") return null;
    const { base, ...draft } = d;
    return { chat: key.slice(PREFIX.length, at), branch: key.slice(at + 1), draft, ...(typeof base === "number" ? { base } : {}), raw };
  } catch { return null; }
}

/** What KeptDrafts asks of the page (keptdrafts.ts gives the store's). */
export type KeptOn = {
  /** Every branch's unsaved draft the browser keeps. */
  all(): Kept[];
  /** A branch's copy as it is stored now; null: none. */
  raw(chat: string, branch: string): string | null;
  /** Keeps a draft as a branch's copy, typed on the counter base; null: the copy goes. */
  write(chat: string, branch: string, d: Draft | null, base?: number): void;
  /** Whether a composer of the branch is open: its own saver has the draft. */
  open(chat: string, branch: string): boolean;
  /** Whether a move is pending in the chat: what its composer left is saved by no one until the move ends. */
  moving(chat: string): boolean;
  /** Whether the chat is there: a copy of a chat that is not known waits. */
  known(chat: string): boolean;
  /** The server's counter of the branch's draft as known here; undefined when it is not known. */
  rev(chat: string, branch: string): number | undefined;
  /** Saves a branch's draft on the counter base (chatdraft.ts saveDraft: in the store too). */
  save(chat: string, branch: string, d: Draft, base?: number): Promise<unknown>;
};

/** How often one copy is saved again on the counter a refusal gave, at one event. */
export const KEPT_TRIES = 3;

/** Saves the drafts typed while the page's own connection was away whose composer is not open by
 *  the time it is back (another chat or branch was opened meanwhile): the copies the browser
 *  keeps, which are of this computer's chats.
 *
 *  A copy is saved as the composer that opens next would save it, and by the saver's rules
 *  (logic/drafts.ts):
 *  - A copy typed on another counter than the one known here is left alone: the server's draft is
 *    newer, and the composer that opens next drops the copy (unsavedToShow).
 *  - The save names the counter the copy was typed on.
 *  - Refused as stale, a copy that has text or quotes is the user's later text: it is kept on the
 *    counter the refusal gave and saved again on it. A refused copy of nothing (the composer was
 *    emptied) goes, and so does one the server has already (the save was taken, and its answer
 *    lost): the server's draft stands.
 *  - Refused for another reason, the copy stays as it was.
 *  A branch whose composer is open is not touched: that composer's saver has the draft. Nor is one
 *  whose composer opened while the save was on its way, or whose copy was written since: what is
 *  typed there is that saver's, which learns of this save from the store as of any save made
 *  elsewhere. The draft is handed on as it was kept, whatever fields it has. */
export class KeptDrafts {
  private on: KeptOn;
  private saving = new Set<string>(); // the copies whose save is on its way, by chat and branch

  constructor(on: KeptOn) { this.on = on; }

  /** The page's own stream opened: the copies of the chats that are known are saved, one after
   *  the other (the page has few connections for its calls). Resolves when every save has ended;
   *  never rejects. */
  async back(): Promise<void> {
    for (const k of this.on.all()) {
      if (!this.on.known(k.chat)) continue;
      await this.save(k).catch(() => {});
    }
  }

  /** Whether the copy is still this saver's to save or to drop: its chat is there, no composer of
   *  the branch is open, no move is pending, and the copy is as it was read. */
  private mine(k: Kept, raw: string): boolean {
    return this.on.known(k.chat) && !this.on.open(k.chat, k.branch) && !this.on.moving(k.chat) && this.on.raw(k.chat, k.branch) === raw;
  }

  private async save(k: Kept): Promise<void> {
    const key = `${k.chat}:${k.branch}`;
    if (this.saving.has(key) || !this.mine(k, k.raw)) return;
    const known = this.on.rev(k.chat, k.branch);
    if (k.base !== undefined && known !== undefined && k.base !== known) return;
    this.saving.add(key);
    try {
      let base = k.base, raw = k.raw;
      for (let tries = 0; tries < KEPT_TRIES; tries++) {
        let stale: ReturnType<typeof staleOf> = null;
        try { await this.on.save(k.chat, k.branch, k.draft, base); }
        catch (e) {
          stale = staleOf(e);
          if (!stale) return; // not saved: the copy waits for the next time the stream opens
        }
        if (!this.mine(k, raw)) return;
        if (!stale || !hasDraft(k.draft) || sameDraft(stale.draft, k.draft)) { this.on.write(k.chat, k.branch, null); return; }
        if (base !== undefined && stale.rev < base) return; // (a counter never goes down: no counter to save on)
        base = stale.rev;
        this.on.write(k.chat, k.branch, k.draft, base);
        raw = this.on.raw(k.chat, k.branch) ?? raw;
      }
    } finally { this.saving.delete(key); }
  }
}
