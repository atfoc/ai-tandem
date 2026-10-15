// Where the pointer is during a drag (AD-70). The gesture handler reports a move to a gesture; on web it leaves out the move that comes as the
// pointer re-enters the view the gesture began on (the dragged row itself: its `pointerenter` is no move) and a move in the frame of the release,
// so the drag follows the page's own pointer events as well, and a release is judged where the pointer was.
export type Point = { x: number; y: number };

export type DragPointer = {
  /** Calls `move` for every move of the pointer, in window coordinates, until the function answered is called. A no-op where the gesture
   *  reports them all. */
  follow: (move: (p: Point) => void) => () => void;
  /** The pointer's last position the page saw, null where there is none to tell (or before any). */
  now: () => Point | null;
  /** Calls `f` once, when the next press begins (the function answered takes it back). Natively there is no click after a drag to wait out, so `f` is not called. */
  nextPress: (f: () => void) => () => void;
};
