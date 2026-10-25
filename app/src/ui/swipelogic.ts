// Where a swiped row goes (ux-improvements goal 3.3): the decisions of SwipeRow that are plain arithmetic, so that Node tests them.
// No React and no react-native here. A row's position `x` is the front's translation: negative when a left swipe shows the actions at
// the right end, positive when a right swipe shows those at the left end.

/** Each action button's width, in points. */
export const ACTION_WIDTH = 88;
/** A swipe past this share of the row's width runs the side's `full` action. */
export const FULL_SHARE = 0.6;
/** A release faster than this (points per second) settles the way it moves, whatever the distance. */
export const FLING_VELOCITY = 800;
/** A finger that starts this close to the screen's left edge belongs to the platform's back swipe. */
export const EDGE = 20;

export type Sides = {
  /** Width of the actions at the right end (shown by a left swipe), 0 for none. */
  rightWidth: number;
  /** Width of the actions at the left end (shown by a right swipe), 0 for none. */
  leftWidth: number;
  rowWidth: number;
  /** The side has an action marked `full`. */
  rightFull: boolean;
  leftFull: boolean;
};

export type Settle = "closed" | "open-right" | "open-left" | "full-right" | "full-left";

/** The width `count` buttons take. */
export const actionsWidth = (count: number) => count * ACTION_WIDTH;

/** The front's position while the finger moves: the position the drag began at plus its travel, held to the sides that have actions
 *  (a side without any does not give) and to the row's width. */
export function dragPosition(start: number, translation: number, s: Sides): number {
  const x = start + translation;
  return Math.min(s.leftWidth > 0 ? s.rowWidth : 0, Math.max(s.rightWidth > 0 ? -s.rowWidth : 0, x));
}

/** Where the row settles when the finger lifts at `x` moving at `velocity` (points per second, negative to the left). */
export function settle(x: number, velocity: number, s: Sides): Settle {
  if (x < 0 && s.rightWidth > 0) {
    if (s.rightFull && -x > s.rowWidth * FULL_SHARE) return "full-right";
    if (velocity < -FLING_VELOCITY) return "open-right";
    if (velocity > FLING_VELOCITY) return "closed";
    return -x > s.rightWidth / 2 ? "open-right" : "closed";
  }
  if (x > 0 && s.leftWidth > 0) {
    if (s.leftFull && x > s.rowWidth * FULL_SHARE) return "full-left";
    if (velocity > FLING_VELOCITY) return "open-left";
    if (velocity < -FLING_VELOCITY) return "closed";
    return x > s.leftWidth / 2 ? "open-left" : "closed";
  }
  return "closed";
}

/** The front's resting position for a settle (`rowWidth` for a full swipe: it leaves the row). */
export function restAt(to: Settle, s: Sides): number {
  return to === "open-right" ? -s.rightWidth : to === "open-left" ? s.leftWidth : to === "full-right" ? -s.rowWidth : to === "full-left" ? s.rowWidth : 0;
}

/** A touch that began at absolute x `x` may start a swipe unless it is inside the edge zone. */
export const mayStart = (x: number) => x >= EDGE;
