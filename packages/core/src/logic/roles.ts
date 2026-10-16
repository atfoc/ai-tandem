// The role this window has on a board, and what each word of the server about a board does to
// the scene kept for it and to the edit that waits to be saved. Several windows work on one
// server at once and each board is held by one of them: only the holder writes its scene, and a
// stored scene has a revision, which a write names as its base. DOM-free; board.ts carries the
// steps out.

/** held: this window writes the board. taking: the window that holds it was asked to hand it
 *  over. other: another window holds it. lost: it was taken from this window. A board with no
 *  role was not asked for. */
export type BoardRole = "held" | "taking" | "other" | "lost";

/** The scene kept for a board: the revision it was read at or last saved as, and whether an edit
 *  of it still waits to be saved (a write that waits, runs or failed). null: none is kept. */
export type Cache = { base: number; unsaved: boolean } | null;

/** The answer of a take (POST /api/boards/{id}/take). */
export type TakeAnswer = { state: "held" | "waiting" | "busy"; rev?: number };

export type Step = {
  role: BoardRole | null; // the board's role from here on; null: not asked
  forget: boolean;        // the kept scene and its save state go: the scene is read again when wanted
  flush: boolean;         // the edit that waits is written now
  dropped: boolean;       // an edit that waited is lost: the note on the canvas or the reader's bar says so
};

/** The board is this window's (a take answered `held`, or a `held` event), at the stored
 *  revision rev. A scene kept at that revision is the stored one, so its waiting edit is saved.
 *  One kept at another revision is older than what another window stored: it goes, and its edit
 *  with it, since saving it would overwrite the newer drawing. */
export function onGrant(cache: Cache, rev: number): Step {
  if (!cache) return { role: "held", forget: false, flush: false, dropped: false };
  if (cache.base === rev) return { role: "held", forget: false, flush: cache.unsaved, dropped: false };
  return { role: "held", forget: true, flush: false, dropped: cache.unsaved };
}

/** The stored scene of a board this window does not hold moved to the revision rev (a `scene` event, or the answer of a `follow`):
 *  a scene kept at another revision is older than the stored one, so it goes (the screen reads the stored one) and an edit that
 *  waited on it with it, since saving it would overwrite the newer drawing (D16). A scene at that revision, or none, stays.
 *  The role stays. null: nothing changes. */
export function onMoved(cache: Cache, rev: number, role: BoardRole | null): Step | null {
  if (!cache || cache.base === rev) return null;
  return { role, forget: true, flush: false, dropped: cache.unsaved };
}

/** The board is not this window's to write: an edit that waits can no longer be saved, so it
 *  is dropped with the scene it was made on. A scene with nothing unsaved stays, and is judged
 *  by its revision at the next grant. */
const without = (role: BoardRole, cache: Cache): Step =>
  ({ role, forget: !!cache?.unsaved, flush: false, dropped: !!cache?.unsaved });

/** The board is not this window's to write, and its edit waited for the board's server (a board on
 *  another server, under an outage): the scene and the edit stay, since the board may only be open
 *  on that server, unchanged. The next grant decides by the revision (onGrant). */
const kept = (role: BoardRole): Step => ({ role, forget: false, flush: false, dropped: false });

/** `superseded`: the board went to another window, or the wait for it ended. keep: the edit waited
 *  for the board's server, see kept. */
export const onLost = (cache: Cache, keep = false): Step => keep ? kept("lost") : without("lost", cache);

/** The answer of a take (the user's button). `held`: the grant.
 *  `busy` (only if free): another window holds the board. `waiting`: the holder was asked, and
 *  a `held` event follows; nothing is dropped until then. null: the answer changes nothing (a
 *  take if free that was overtaken by a take). keep: the edit was kept at a loss (onLost), and a
 *  `busy` keeps it on. */
export function onTake(cache: Cache, a: TakeAnswer, role: BoardRole | null, keep = false): Step | null {
  switch (a.state) {
    case "held": return onGrant(cache, a.rev ?? 0);
    case "busy": return role === "taking" ? null : keep ? kept("other") : without("other", cache);
    case "waiting": return { role: "taking", forget: false, flush: false, dropped: false };
  }
  return null;
}

/** A save the server refused. `stale`: the stored scene is not the one the edit was made on;
 *  the role stays. `not_holder`: another window holds the board. Either way the edit is dropped
 *  and the scene is read again. */
export const onRefusal = (code: "stale" | "not_holder", role: BoardRole | null): Step =>
  ({ role: code === "not_holder" ? "other" : role, forget: true, flush: false, dropped: true });

/** A new stream holds nothing and waits for nothing on the server: the boards that were held or
 *  being taken are not asked for any more, and nothing asks for them again by itself: they are a
 *  reader's until the user presses the button. What is known of the other windows stays. */
export function afterReconnect(roles: Record<string, BoardRole>): Record<string, BoardRole> {
  return Object.fromEntries(Object.entries(roles).filter(([, r]) => r === "other" || r === "lost"));
}

/** Whether the view of a board is in view mode, and nothing of it is kept or written: every role but `held`. */
export const readOnly = (role: BoardRole | null | undefined): boolean => role !== "held";

/** How many selected elements the composer of a chat on `board` offers for its message. The page
 *  keeps one count, of the canvas last drawn on: it is this board's only while the board is on
 *  screen (onScreen) and this window holds it. As a reader (the canvas is in view mode), or with
 *  another board on screen, the composer is as with nothing selected. */
export const selectedOn = (count: number, board: string | null | undefined, onScreen: string | null | undefined, role: BoardRole | null | undefined): number =>
  board && board === onScreen && role === "held" ? count : 0;
