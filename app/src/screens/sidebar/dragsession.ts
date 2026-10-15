// The sidebar's drag, as a state machine with no screen in it (AD-70): a gesture says where the pointer is, the session looks that point up
// in the places of the sidebar (drophit.ts), tells the one drop mark what it found, and at the end performs the move the mark named. The
// screen, the store and the keys are given to it (`Env`), so that it runs under node:test with fakes.
//
// What a drag ends in: a release over a lit place moves what is dragged there; a release anywhere else, a cancel (Escape, the system's
// cancel, the dragged row removed meanwhile) moves nothing. After every ending nothing is lit.
import type { DropEvent, DropMark } from "@aiwb/core/logic/dropmark.ts";

import { dropEventAt, edgeSpeed, type Places, type Point, type Rules } from "./drophit.ts";

/** What is dragged: a board or a plain chat row (key: "board:<key>" or "chat:<key>"), or a group (id: its key). server: the entry id of its server. */
export type Dragged = { kind: "row"; key: string; title: string; server: string } | { kind: "group"; id: string; title: string; server: string };

/** What the floating label shows: the dragged thing's name, where the pointer is, and what it is. */
export type DragView = { title: string; kind: "row" | "group"; at: Point };

export type Env = {
  /** The places of the sidebar as they are on screen now (their rectangles, in window coordinates). */
  measure: () => Promise<Places>;
  /** The drop mark now, and the way to change it. */
  mark: () => DropMark;
  tell: (e: DropEvent) => void;
  rules: Rules;
  /** Performs the move a drag ended on: `target` is "in" a zone or "before" a header. */
  drop: (d: Dragged, target: Extract<DropEvent, { type: "in" | "before" }>) => void;
  /** Hears the keys while a drag lasts; answers the function that stops. */
  keys: (handler: (e: { key: string }) => void) => () => void;
  /** The platform's own word of where the pointer is (platform/dragpointer): its moves while a drag lasts, and its last place. */
  pointer: { follow: (move: (p: Point) => void) => () => void; now: () => Point | null };
  /** Scrolls the list by `dy` pixels (a pointer held near its edge). */
  scroll: (dy: number) => void;
  /** Calls `f` every `ms` until the function answered is called (setInterval). */
  every: (f: () => void, ms: number) => () => void;
};

/** A pointer held this long near the edge of the list scrolls it, a tick (ms) at a time; one that passes by does not. */
export const DWELL = 350, TICK = 16;

type Session = { d: Dragged; at: Point; dirty: boolean; pumping: boolean; over: boolean; off: () => void; places: Places | null; dwell: number };

export const sourceKey = (d: Dragged): string => (d.kind === "row" ? d.key : "group:" + d.id);

export function createDrag(env: Env) {
  let s: Session | null = null;
  let view: DragView | null = null;
  let source: string | null = null;
  const onView = new Set<() => void>(), onSource = new Set<() => void>();
  const setView = (v: DragView | null, src: string | null) => {
    view = v;
    for (const f of [...onView]) f();
    if (src !== source) { source = src; for (const f of [...onSource]) f(); }
  };

  /** Looks the pointer up in the places, once at a time: a move that comes while the places are being measured is looked up when they are. */
  function pump(sess: Session): void {
    if (sess.pumping) return;
    sess.pumping = true;
    void (async () => {
      while (s === sess && sess.dirty && !sess.over) {
        sess.dirty = false;
        const at = sess.at;
        let places: Places | null = null;
        try { places = await env.measure(); } catch { /* the places could not be measured: the mark stays as it was */ }
        if (s !== sess || sess.over) break;
        if (places) { sess.places = places; env.tell(dropEventAt(at, places, env.mark(), env.rules)); }
      }
      sess.pumping = false;
    })();
  }

  function stop(sess: Session): void {
    s = null;
    sess.off();
    env.tell({ type: "end" });
    setView(null, null);
  }

  const cancel = (): void => { if (s) stop(s); };

  /** The pointer is at `at` (a place it was already at, and looked up, is not looked up again). */
  const move = (at: Point): void => {
    if (!s || s.over || (s.at.x === at.x && s.at.y === at.y && !s.dirty)) return;
    s.at = at;
    s.dirty = true;
    setView({ ...view!, at }, source);
    pump(s);
  };

  return {
    /** A drag began at `at`. */
    start(d: Dragged, at: Point): void {
      cancel();
      const sess: Session = { d, at, dirty: true, pumping: false, over: false, off: () => {}, places: null, dwell: 0 };
      s = sess;
      const offKeys = env.keys((e) => { if (e.key === "Escape") cancel(); });
      const offPointer = env.pointer.follow((p) => move(p));
      const offTick = env.every(() => {
        if (s !== sess || sess.over) return;
        const v = edgeSpeed(sess.at, sess.places?.clip ?? null);
        sess.dwell = v ? sess.dwell + TICK : 0;
        if (v && sess.dwell >= DWELL) { env.scroll(v); sess.dirty = true; pump(sess); } // (what is under the pointer moved)
      }, TICK);
      sess.off = () => { offKeys(); offPointer(); offTick(); };
      env.tell({ type: "start", group: d.kind === "group" ? d.id : null, server: d.server });
      setView({ title: d.title, kind: d.kind, at }, sourceKey(d));
      pump(sess);
    },
    move,
    /** The pointer was released at `at`: the move the place there asks for is made. A cancelled gesture ends with `cancel`. */
    async end(at: Point): Promise<void> {
      const sess = s;
      if (!sess || sess.over) return;
      sess.over = true;
      // (the release is looked up on its own: a move that came in the frame of the release may not have been heard)
      let target: DropEvent = { type: "nowhere" };
      const place = env.pointer.now() ?? at;
      try { target = dropEventAt(place, await env.measure(), env.mark(), env.rules); } catch { /* nothing is moved */ }
      if (s !== sess) return; // (cancelled meanwhile: the dragged row removed, Escape)
      stop(sess);
      if (target.type === "in" || target.type === "before") env.drop(sess.d, target);
    },
    /** The drag ended with no drop. */
    cancel,
    /** Whether a drag is going on. */
    get active(): boolean { return !!s; },
    view: {
      subscribe: (f: () => void) => { onView.add(f); return () => { onView.delete(f); }; },
      get: (): DragView | null => view,
    },
    source: {
      subscribe: (f: () => void) => { onSource.add(f); return () => { onSource.delete(f); }; },
      get: (): string | null => source,
    },
  };
}

export type Drag = ReturnType<typeof createDrag>;
