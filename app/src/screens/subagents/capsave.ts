// How the cap's slider saves (small-improvements goal 3.3, sliders.md section 3): the decision logic of the commits, without React, so that
// Node tests it. A commit shows its value at once (`want`) and sends one `configure` call; a commit made while a save of the cap is in
// flight is not sent in parallel and not lost: the latest one is sent when the save ends (three commits during one call make one more
// call, with the last value). An error drops `want`, so the slider goes back to the chat's value. `useCapSave` (useCapSave.ts)
// wires it to the store, the toolbar's busy flag and the error line.
import { clampCap, subChange, type SubChange, type SubSettings } from "@aiwb/core/logic/subsettings.ts";

export type CapSaverDeps = {
  /** The chat's settings now (read at each use, from the store: an answer is in it before its call ends). */
  settings(): SubSettings;
  /** Another reason takes no change now (the composer sends, another chip's change is saving). Not asked while a save of the cap runs: the
   *  toolbar's own `disabled` is true then too, as this save has told it it is busy. */
  blocked(): boolean;
  /** Sends the change and resolves when the chat the server answered with is in the store; rejects with the refusal. */
  send(change: SubChange): Promise<void>;
  /** A save is running (true at its start, false when the last one has ended). */
  busy(on: boolean): void;
  /** "" on success, the message on a failure. */
  error(msg: string): void;
  /** The value to show instead of the chat's, or null for the chat's own. */
  want(v: number | null): void;
};

export type CapSaver = {
  /** The person committed a value on the slider. */
  commit(v: number): void;
  /** The chat's cap changed (the answer or an event arrived): a value held for the chat's is let go. */
  chatCap(): void;
};

export function createCapSaver(d: CapSaverDeps): CapSaver {
  let inflight = false;
  let pending: number | null = null; // the latest value committed while a save ran

  const finish = (sent: number | null) => {
    inflight = false;
    d.busy(false);
    // the answer's chat is in the store: the chat's cap is the wanted one (an answer with no chat: the `chat` event brings it, chatCap())
    if (sent === null || d.settings().cap === sent) d.want(null);
  };

  const run = (cap: number) => {
    if (!inflight) d.busy(true); // (a follow-up call keeps the busy flag)
    inflight = true;
    d.want(cap);
    d.send({ subCap: cap }).then(() => true, (e: unknown) => { d.error(e instanceof Error ? e.message : String(e)); return false; }).then((ok) => {
      if (!ok) { pending = null; finish(null); return; }
      d.error("");
      const next = pending;
      pending = null;
      const change = next === null ? null : subChange(d.settings(), "cap", next);
      if (change?.subCap !== undefined) run(change.subCap); else finish(next === null ? cap : null);
    });
  };

  return {
    commit(v) {
      if (inflight) { // the chat's cap is about to change: compare with it when the save ends, not now
        pending = clampCap(v);
        d.want(pending);
        return;
      }
      const change = subChange(d.settings(), "cap", v);
      if (!change?.subCap || d.blocked()) { d.want(null); return; }
      run(change.subCap);
    },
    chatCap() {
      if (!inflight) d.want(null);
    },
  };
}
