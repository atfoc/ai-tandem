// A chat's unsent message, kept on the server (PUT /api/chats/{id}/draft) so it
// survives switching chats, reloads and restarts. DOM-free: Composer keeps one
// DraftSaver per open composer and gives it every change.
//
// A tab that reloads or closes stops being the active client as its event stream
// drops, so a save sent while the page goes away can be refused. Each change is
// therefore also kept in an Unsaved copy (localStorage) until the server has it;
// the composer opens with that copy over the server's draft and saves it again.

import type { Draft, Reference } from "../types.ts";
import type { Picked } from "./mentions.ts";

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

/** A chat's draft that the server may not have yet; null: nothing waiting. */
export type Unsaved = { read(): Draft | null; write(d: Draft | null): void };

const key = (d: Draft) => JSON.stringify(d);

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
