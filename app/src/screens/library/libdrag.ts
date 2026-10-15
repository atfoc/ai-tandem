// The library tree's drag, as a state machine with no screen in it (the old page's Library.tsx dragStart and the drop handlers; AD-70): a gesture says
// where the pointer is, the session looks that point up in the places of the popup (the rows, the space under them, the bar of the top level),
// tells the popup what would be landed on, and at the release performs the move. The screen is given (`Env`), so that it runs under node:test with fakes.
//
// Where a drag lands: on a row, that row's place (a group; a prompt, the group it is in; a server's entry, the top of its library); on the space under
// the rows and on the bar of the top level, the top of the dragged item's library; anywhere else nowhere. The popup's own rule (`landing`) says
// whether the item may go there at all (not where it is, not into itself, not to another server): nothing is lit and a drop does nothing where it may not.
import type { Chosen, Place } from "@aiwb/core/logic/libraryview.ts";

import { edgeSpeed, inside, type Point, type Rect } from "../sidebar/drophit.ts";

/** The places of the popup as they are on screen now, in window coordinates. rows: the rows of the tree (and the row of an item being made) with the
 *  place each stands for; list: the tree's box; bar: the bar of the top level, while there is one. */
export type Spots = { list: Rect | null; bar: Rect | null; rows: { key: string; rect: Rect; place: Place | null }[] };

/** The place under a point: before the rule of `landing`. */
export function placeAt(at: Point, s: Spots, top: Place | null): Place | null {
  if (s.bar && inside(s.bar, at)) return top;
  if (!s.list || !inside(s.list, at)) return null;
  const row = s.rows.find((r) => inside(r.rect, at));
  return row ? row.place : top;
}

export type Env = {
  /** The places as they are on screen now. */
  measure: () => Promise<Spots>;
  /** The top of the dragged item's library. */
  top: (item: Chosen) => Place | null;
  /** The place if the item can go there, else null. */
  landing: (item: Chosen, to: Place | null) => Place | null;
  /** A drag began on `item` (the popup shows the bar of the top level and dims the row); it ended (nothing is lit, nothing is dimmed). */
  begin: (item: Chosen) => void;
  finish: () => void;
  /** A finger held on `item` and lifted without moving: a long press, which opens the row's menu. */
  tap: (item: Chosen, at: Point) => void;
  /** Where the item would land now, null where it cannot. */
  over: (to: Place | null) => void;
  /** The release over a place the item can go to. */
  drop: (item: Chosen, to: Place) => void;
  /** Hears the keys while a drag lasts; answers the function that stops. */
  keys: (handler: (e: { key: string }) => void) => () => void;
  /** The platform's own word of where the pointer is (platform/dragpointer). */
  pointer: { follow: (move: (p: Point) => void) => () => void; now: () => Point | null };
  /** Scrolls the tree by `dy` pixels (a pointer held near its edge). */
  scroll: (dy: number) => void;
  every: (f: () => void, ms: number) => () => void;
};

/** A pointer held this long near the edge of the tree scrolls it, a tick (ms) at a time; one that passes by does not. */
export const DWELL = 350, TICK = 16;

type Session = { item: Chosen; at: Point; from: Point; began: boolean; dirty: boolean; pumping: boolean; over: boolean; off: () => void; list: Rect | null; dwell: number };

/** How far a finger that has been held moves before it is a drag and no long press. */
export const SLOP = 4;

export function createLibDrag(env: Env) {
  let s: Session | null = null;

  function pump(sess: Session): void {
    if (sess.pumping) return;
    sess.pumping = true;
    void (async () => {
      while (s === sess && sess.dirty && !sess.over) {
        sess.dirty = false;
        const at = sess.at;
        let spots: Spots | null = null;
        try { spots = await env.measure(); } catch { /* the places could not be measured: what is lit stays */ }
        if (s !== sess || sess.over) break;
        if (spots) { sess.list = spots.list; env.over(env.landing(sess.item, placeAt(at, spots, env.top(sess.item)))); }
      }
      sess.pumping = false;
    })();
  }

  function stop(sess: Session): void {
    s = null;
    sess.off();
    env.over(null);
    env.finish();
  }

  const cancel = (): void => { if (s) stop(s); };
  const move = (at: Point): void => {
    if (!s || s.over || (s.at.x === at.x && s.at.y === at.y && !s.dirty)) return;
    s.at = at;
    if (!s.began) {
      if (Math.hypot(at.x - s.from.x, at.y - s.from.y) < SLOP) return;
      s.began = true;
      env.begin(s.item);
    }
    s.dirty = true;
    pump(s);
  };

  return {
    /** A drag began at `at`. `held`: a finger that was held first (a mouse that moved has begun a drag; a finger may be a long press yet). */
    start(item: Chosen, at: Point, held = false): void {
      cancel();
      const sess: Session = { item, at, from: at, began: !held, dirty: true, pumping: false, over: false, off: () => {}, list: null, dwell: 0 };
      s = sess;
      const offKeys = env.keys((e) => { if (e.key === "Escape") cancel(); });
      const offPointer = env.pointer.follow((p) => move(p));
      const offTick = env.every(() => {
        if (s !== sess || sess.over) return;
        const v = edgeSpeed(sess.at, sess.list);
        sess.dwell = v ? sess.dwell + TICK : 0;
        if (v && sess.dwell >= DWELL) { env.scroll(v); sess.dirty = true; pump(sess); } // (what is under the pointer moved)
      }, TICK);
      sess.off = () => { offKeys(); offPointer(); offTick(); };
      if (sess.began) { env.begin(item); pump(sess); }
    },
    move,
    /** The pointer was released at `at`: the item goes where the place there says. A cancelled gesture ends with `cancel`. */
    async end(at: Point): Promise<void> {
      const sess = s;
      if (!sess || sess.over) return;
      sess.over = true;
      if (!sess.began) { stop(sess); env.tap(sess.item, at); return; }
      // (the release is looked up on its own: a move that came in the frame of the release may not have been heard)
      let to: Place | null = null;
      try { to = env.landing(sess.item, placeAt(env.pointer.now() ?? at, await env.measure(), env.top(sess.item))); } catch { /* nothing is moved */ }
      if (s !== sess) return; // (cancelled meanwhile: Escape, the item removed)
      stop(sess);
      if (to) env.drop(sess.item, to);
    },
    cancel,
    get active(): boolean { return !!s; },
  };
}

export type LibDrag = ReturnType<typeof createLibDrag>;
