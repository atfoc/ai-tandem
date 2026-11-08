// Undo and redo that touch only what this window did (goal 3.3), wired to a tldraw store. The merge is localundo-logic.ts.
//
// - `installLocalUndo(store)` keeps, per record id, the record as this window last left it: every change with source "user"
//   (the store's own after-change/create/delete handlers; remote changes, which tldraw's sync client applies inside
//   `mergeRemoteChanges`, come with source "remote" and are not this window's).
// - `replay(store, fn)` runs an undo or redo (`fn`): while it runs, a before-change handler merges each record the history
//   writes (mergeReplay), and the record this window is taken to have left becomes the history's record, so a later redo or
//   undo again finds the fields someone else changed different from it and leaves them alone.
// - `localUndo(editor)` / `localRedo(editor)` are what every undo and redo of the window goes through: tldraw's undo/redo
//   actions (⌘Z, Ctrl+Z, ⇧⌘Z, Ctrl+⇧Z; overridden in MainToolbar's UI_OVERRIDES) and our Ctrl+Y (interactions.ts).
// Creates and deletes are tldraw's: undoing a delete recreates the record, also one someone else deleted since; undoing a
// create deletes it, also when someone else changed it since. A cancel (tldraw's bail, e.g. Escape in a drag) is not merged.
import type { Editor, TLRecord, TLStore } from "tldraw";
import { mergeReplay } from "./localundo-logic.ts";

type State = { left: Map<string, TLRecord>; replaying: number; dispose: () => void };
const states = new WeakMap<TLStore, State>();

/** The record types a person edits (the document's); camera, pointer and presence are the session's and not merged. */
const TYPES = ["shape", "binding", "asset", "page", "document"];

type Source = "user" | "remote";
/** tldraw's StoreSideEffects, typed once for any of TYPES (its per-type generics do not take a loop over type names). */
type SideEffects = {
  registerBeforeChangeHandler(t: string, h: (prev: TLRecord, next: TLRecord, s: Source) => TLRecord): () => void;
  registerAfterChangeHandler(t: string, h: (prev: TLRecord, next: TLRecord, s: Source) => void): () => void;
  registerAfterCreateHandler(t: string, h: (rec: TLRecord, s: Source) => void): () => void;
  registerAfterDeleteHandler(t: string, h: (rec: TLRecord, s: Source) => void): () => void;
};

export function installLocalUndo(store: TLStore): () => void {
  const had = states.get(store);
  if (had) return had.dispose;
  const left = new Map<string, TLRecord>();
  const fx = store.sideEffects as unknown as SideEffects;
  const offs: Array<() => void> = [];
  const state: State = { left, replaying: 0, dispose: () => {} };
  for (const type of TYPES) {
    offs.push(
      fx.registerBeforeChangeHandler(type, (prev, next, source) => {
        if (source !== "user" || state.replaying === 0) return next;
        const merged = mergeReplay(prev, next, left.get(next.id));
        left.set(next.id, next);
        return merged;
      }),
      fx.registerAfterChangeHandler(type, (_prev, next, source) => {
        if (source === "user" && state.replaying === 0) left.set(next.id, next);
      }),
      fx.registerAfterCreateHandler(type, (rec, source) => {
        if (source === "user") left.set(rec.id, rec);
      }),
      fx.registerAfterDeleteHandler(type, (rec, source) => {
        if (source === "user") left.delete(rec.id);
      }),
    );
  }
  state.dispose = () => {
    for (const off of offs) off();
    states.delete(store);
  };
  states.set(store, state);
  return state.dispose;
}

/** Runs an undo or redo with the merge on (installLocalUndo must have run on this store; without it, `fn` as it is). */
export function replay<T>(store: TLStore, fn: () => T): T {
  const state = states.get(store);
  if (!state) return fn();
  state.replaying++;
  try {
    return fn();
  } finally {
    state.replaying--;
  }
}

export const localUndo = (editor: Editor) => void replay(editor.store, () => editor.undo());
export const localRedo = (editor: Editor) => void replay(editor.store, () => editor.redo());
