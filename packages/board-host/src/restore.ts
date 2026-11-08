// Loading a room from a save (decision O3, risk 8.5; lifted from spikes/tl-host/src/room.ts). rooms.ts loads every room through
// `restoreSnapshot`.
import type { RoomSnapshot } from "@tldraw/sync-core";

/**
 * A room snapshot made safe to restore after a restart that may have lost changes (risk 8.5): the clock jumps forward by
 * `gap` and the tombstone history starts at the new clock, so every client that comes back, whatever lastServerClock it
 * has (older, equal or newer than the saved one), gets a full `wipe_all` hydration and ends with exactly the room's
 * records plus its own unacknowledged edits. Without it a client whose clock happens to be <= the restored clock gets a
 * partial diff and keeps records the room no longer has (see spikes/tl-host/notes/sync.md). `gap` must exceed the number of
 * commits the lost room could have made after the save (a few seconds of edits); the default is generous.
 */
export function snapshotForRestore(snapshot: RoomSnapshot, gap = 1_000_000): RoomSnapshot {
  const clock = Math.max(snapshot.documentClock ?? snapshot.clock ?? 0, ...snapshot.documents.map((d) => d.lastChangedClock)) + gap;
  return { ...snapshot, documentClock: clock, tombstoneHistoryStartsAtClock: clock, tombstones: {} };
}

/** What a room is made from, given a saved text: a room snapshot (what the host saves) goes through snapshotForRestore; any
 *  other value (a store snapshot, `{ store, schema }`, which TLSocketRoom also takes) is passed as it is; no text, no snapshot. */
export function restoreSnapshot(text: string | null): unknown {
  if (!text) return undefined;
  const v = JSON.parse(text);
  if (v && typeof v === "object" && Array.isArray(v.documents)) return snapshotForRestore(v as RoomSnapshot);
  return v;
}
