// Saves of the phone's sheets wait for the stream (the same helper as LibraryDialog.tsx's: a library's server sends the `library` event of a change before the call's
// answer, but on another line, so the answer may be here first).
import { getState, subscribe } from "@aiwb/core/state/store.ts";

/** Waits until the store is as `ok` says, a few seconds at most. Answers whether it was. */
export function whenStore(ok: (state: ReturnType<typeof getState>) => boolean, ms = 3000): Promise<boolean> {
  if (ok(getState())) return Promise.resolve(true);
  return new Promise((done) => {
    const end = (v: boolean) => { off(); clearTimeout(t); done(v); };
    const off = subscribe(() => { if (ok(getState())) end(true); });
    const t = setTimeout(() => end(false), ms);
  });
}
