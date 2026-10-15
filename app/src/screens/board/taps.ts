// What a tap is, for the layer that waits for a point (Overlays.tsx `PickLayer`): the layer lets the board have every pointer (the wheel,
// a drag, two fingers) and only watches. One pointer that goes down and up without leaving its place is a tap; a pointer that moved
// (a pan), or a second one that came down meanwhile (a pinch, a two-finger pan), is not, and puts no point. No React and no DOM here,
// so Node loads it; PickSurface.web.tsx feeds it the pointer events. (Native has its own recognizer: PickSurface.native.tsx.)

/** How far a pointer may move and still be a tap, in pixels. */
export const TAP_SLOP = 10;

export type Spot = { x: number; y: number };

export type TapWatch = {
  down(id: number, at: Spot): void;
  move(id: number, at: Spot): void;
  /** The pointer went up: where the tap was, when this was one. */
  up(id: number, at: Spot): Spot | null;
  /** The pointer was taken away (the system's cancel). */
  cancel(id: number): void;
  reset(): void;
};

export function tapWatch(slop = TAP_SLOP): TapWatch {
  const down = new Map<number, Spot>();
  let ok = true; // the gesture so far is still a tap: it is judged until the last pointer is up
  const far = (a: Spot, b: Spot) => Math.hypot(a.x - b.x, a.y - b.y) > slop;
  const end = (id: number) => { down.delete(id); if (!down.size) ok = true; };
  return {
    down(id, at) {
      if (down.size) ok = false;
      down.set(id, at);
    },
    move(id, at) {
      const from = down.get(id);
      if (from && far(from, at)) ok = false;
    },
    up(id, at) {
      const from = down.get(id);
      const tap = !!from && ok && down.size === 1 && !far(from, at);
      end(id);
      return tap ? at : null;
    },
    cancel(id) { end(id); },
    reset() { down.clear(); ok = true; },
  };
}
