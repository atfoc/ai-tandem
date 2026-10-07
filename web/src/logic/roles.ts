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
  dropped: boolean;       // an edit that waited is lost: the panel or the note on the canvas says so
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

/** The board is not this window's to write: an edit that waits can no longer be saved, so it
 *  is dropped with the scene it was made on. A scene with nothing unsaved stays, and is judged
 *  by its revision at the next grant. */
const without = (role: BoardRole, cache: Cache): Step =>
  ({ role, forget: !!cache?.unsaved, flush: false, dropped: !!cache?.unsaved });

/** `superseded`: the board went to another window, or the wait for it ended. */
export const onLost = (cache: Cache): Step => without("lost", cache);

/** The answer of a take, also of the one made if free after a reconnect. `held`: the grant.
 *  `busy` (only if free): another window holds the board. `waiting`: the holder was asked, and
 *  a `held` event follows; nothing is dropped until then. null: the answer changes nothing (a
 *  take if free that was overtaken by a take). */
export function onTake(cache: Cache, a: TakeAnswer, role: BoardRole | null): Step | null {
  switch (a.state) {
    case "held": return onGrant(cache, a.rev ?? 0);
    case "busy": return role === "taking" ? null : without("other", cache);
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
 *  being taken are not asked for any more. What is known of the other windows stays until the
 *  take that follows the snapshot. */
export function afterReconnect(roles: Record<string, BoardRole>): Record<string, BoardRole> {
  return Object.fromEntries(Object.entries(roles).filter(([, r]) => r === "other" || r === "lost"));
}

/** Whether the take-over panel shows in place of the board's canvas. */
export const showsPanel = (role: BoardRole | null | undefined): role is "taking" | "other" | "lost" =>
  role === "taking" || role === "other" || role === "lost";

/** What selecting a board asks of the server. "take": a window that holds the board is asked to
 *  hand it over; that is for the user's action on the board itself, a click on its row or on a
 *  reference to it. "free": the board is taken only when no window holds it; that is for a
 *  selection that names one of its chats (ifFree: a click on a chat's row or on a reference to a
 *  chat, an agent's show_board), since a window that does not hold a board uses its chats fully.
 *  null: nothing is asked. A board this window holds or is taking needs no take. One that is on
 *  screen already (same) is taken from another window only by a click on its own row in the
 *  sidebar (row) or by "Use here" on its panel: any other selection asks for it only when it was
 *  not asked for yet, if free. */
export function takeOnSelect(role: BoardRole | null | undefined, same: boolean, ifFree: boolean, row = false): "take" | "free" | null {
  if (role === "held" || role === "taking") return null;
  if (row) return "take";
  if (same) return role ? null : "free";
  return ifFree ? "free" : "take";
}

/** How many selected elements the composer of a chat on `board` offers for its message. The page
 *  keeps one count, of the canvas last drawn on: it is this board's only while the board is on
 *  screen (onScreen) and its canvas shows, which is when this window holds it. Behind the
 *  take-over panel, or with another board on screen, the composer is as with nothing selected. */
export const selectedOn = (count: number, board: string | null | undefined, onScreen: string | null | undefined, role: BoardRole | null | undefined): number =>
  board && board === onScreen && role === "held" ? count : 0;
