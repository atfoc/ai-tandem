// The room editor (design 7.4, D15, O1): one headless tldraw `Editor` per room, made at the room's first agent call and disposed
// with the room. It is not a sync peer: before every call `sync` sets its store to the room's current document records, and
// `write` puts an apply's diff into the room in one storage transaction. Both are synchronous, so a call can run "sync, apply,
// write" in one JS turn, with no window message handled in between (7.4 steps 1–5).
//
// Sync. The room's records are compared with the editor's: a record the room changed (or added) is put, one the room no longer
// has is removed, all in one `store.mergeRemoteChanges(() => store.applyDiff(…, { runCallbacks: false }))`, so no side effect
// runs while loading (the sticky's fit and the geo's growY run only in the shape utils' onBeforeCreate/onBeforeUpdate, which
// createShapes/updateShapes call and a store put does not; the store's own handlers are off with runCallbacks false), and the
// load is no undo step. The editor's session records (instance, camera, page states) stay. Then the editor's current page is
// the room's first page (by index). The records last synced are remembered by identity, so an unchanged board costs one pass of
// identity checks; anything that is not identical is compared by value. After a failed call the cache is dropped (`stale`) and
// the next sync compares everything.
//
// Write. `room.storage.transaction(txn => { txn.set…; txn.delete… })`: synchronous (InMemorySyncStorage commits inside the call;
// TLSyncRoom is told on a microtask and broadcasts every change since its last clock as one patch), and public in tldraw 5.6.
// `room.updateStore` is not used: it reads the records, then `await`s the updater (a microtask even for a synchronous one) and
// writes after it, so a window's push handled in that gap would be overwritten by the editor's older copy of a record.
import { isEqual, type Editor, type RecordsDiff, type TLPageId, type TLRecord } from "tldraw";
import type { BoardRoom } from "./agent.ts";
import { loadRuntime } from "./node/runtime.ts";

type Rec = TLRecord;

export class RoomEditor {
  readonly editor: Editor;
  /** id → [the room's record, the editor's record] as of the last sync or write: both unchanged means nothing to do. */
  private synced = new Map<string, [unknown, unknown]>();
  private disposed = false;

  constructor(editor: Editor) {
    this.editor = editor;
  }

  static async create(): Promise<RoomEditor> {
    const rt = await loadRuntime();
    return new RoomEditor(rt.createEditor());
  }

  /** The next sync compares every record by value (after a failed or aborted call). */
  stale() {
    this.synced.clear();
  }

  /** The room's document records, by id (the room's own objects: never mutated). */
  static roomRecords(room: BoardRoom): Map<string, Rec> {
    const out = new Map<string, Rec>();
    for (const d of room.getCurrentSnapshot().documents) out.set(d.state.id, d.state as Rec);
    return out;
  }

  /** Sets the editor's document records to the room's (synchronous). Returns the room's records. */
  sync(room: BoardRoom): Map<string, Rec> {
    if (this.disposed) throw new Error("the room editor is disposed");
    const store = this.editor.store;
    const docTypes = store.scopedTypes.document;
    const roomRecs = RoomEditor.roomRecords(room);
    const diff: RecordsDiff<Rec> = { added: {}, updated: {}, removed: {} };
    let any = false;
    for (const [id, r] of roomRecs) {
      const mine = store.unsafeGetWithoutCapture(id as Rec["id"]);
      const last = this.synced.get(id);
      if (mine && last && last[0] === r && last[1] === mine) continue;
      if (mine && (mine === r || isEqual(mine, r))) {
        this.synced.set(id, [r, mine]);
        continue;
      }
      if (mine) (diff.updated as Record<string, [Rec, Rec]>)[id] = [mine, r];
      else (diff.added as Record<string, Rec>)[id] = r;
      any = true;
    }
    for (const r of store.allRecords()) {
      if (!docTypes.has(r.typeName) || roomRecs.has(r.id)) continue;
      (diff.removed as Record<string, Rec>)[r.id] = r;
      this.synced.delete(r.id);
      any = true;
    }
    if (any) {
      store.mergeRemoteChanges(() => store.applyDiff(diff, { runCallbacks: false }));
      for (const id of [...Object.keys(diff.added), ...Object.keys(diff.updated)]) {
        const mine = store.unsafeGetWithoutCapture(id as Rec["id"]);
        if (mine) this.synced.set(id, [roomRecs.get(id), mine]);
      }
    }
    // the room's first page is the page the agent works on (read.ts reads the same one)
    const pages = [...roomRecs.values()].filter((r) => r.typeName === "page").sort((a: any, b: any) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
    const first = pages[0]?.id as TLPageId | undefined;
    if (first && this.editor.getCurrentPageId() !== first) this.editor.run(() => this.editor.setCurrentPage(first), { history: "ignore" });
    return roomRecs;
  }

  /** The document records the editor has and the room has not, or has otherwise (a page or document the editor had to make
   *  because the room had none: written with the apply, so the room's shapes never name a page it lacks). */
  missingFrom(roomRecs: Map<string, Rec>): Rec[] {
    const out: Rec[] = [];
    for (const r of this.editor.store.allRecords()) {
      if ((r.typeName === "page" || r.typeName === "document") && !roomRecs.has(r.id)) out.push(r);
    }
    return out;
  }

  /** Writes a diff (and any extra records) to the room in one storage transaction, synchronously: one change for every window. */
  write(room: BoardRoom, diff: RecordsDiff<Rec>, extra: Rec[] = []) {
    const puts: Rec[] = [...extra, ...Object.values(diff.added), ...Object.values(diff.updated).map(([, to]) => to)];
    const deletes = Object.keys(diff.removed);
    if (puts.length === 0 && deletes.length === 0) return;
    room.storage.transaction((txn) => {
      for (const r of puts) txn.set(r.id, r);
      for (const id of deletes) txn.delete(id);
    });
    // what the room now holds is what the editor holds: the next sync skips them by identity
    const after = RoomEditor.roomRecords(room);
    const store = this.editor.store;
    for (const r of puts) {
      const mine = store.unsafeGetWithoutCapture(r.id);
      if (mine) this.synced.set(r.id, [after.get(r.id), mine]);
    }
    for (const id of deletes) this.synced.delete(id);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.synced.clear();
    this.editor.dispose();
  }
}
