// Where an anchored popover goes (AD-70): below its anchor (or above, `up`), its left edge on the anchor's left edge or
// its right edge on the anchor's right edge, pulled back inside the window. When the side asked for has less room than
// the popover is tall and the other has more, it goes to the other. With the on-screen keyboard up (`covered`: the points of the window's bottom it
// covers) the window is only the part above the keyboard: an `up` popover whose anchor is under the keyboard rises with the keyboard's top, and one
// that does not fit gets the height that is left. No React and no react-native here, so Node loads it.
export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

export type Placement = {
  left: number;
  top: number;
  /** The most the popover may be tall: the room on its side. */
  maxHeight: number;
  /** Whether it went above the anchor. */
  up: boolean;
};

/** The space kept free at the window's edges. */
export const EDGE = 8;
/** The space between the anchor and the popover, below and above (today's .menu is 4 px below, 6 px above). */
export const GAP_BELOW = 4;
export const GAP_ABOVE = 6;

export function placePopover(a: { anchor: Rect; size: Size; window: Size; align?: "left" | "right"; up?: boolean; covered?: number }): Placement {
  const { anchor, size, window } = a;
  const free = window.height - Math.max(0, a.covered ?? 0); // the part of the window the keyboard leaves
  const roomBelow = free - (anchor.y + anchor.height) - GAP_BELOW - EDGE;
  const bottomAbove = Math.min(anchor.y - GAP_ABOVE, free - EDGE); // where an `up` popover's bottom edge goes: above the anchor, and above the keyboard
  const roomAbove = bottomAbove - EDGE;
  const wantUp = !!a.up;
  const fits = (room: number) => room >= size.height;
  const up = wantUp ? fits(roomAbove) || roomAbove >= roomBelow : !fits(roomBelow) && roomAbove > roomBelow;
  const maxHeight = Math.max(0, up ? roomAbove : roomBelow);
  const height = Math.min(size.height, maxHeight);
  const top = up ? bottomAbove - height : anchor.y + anchor.height + GAP_BELOW;
  const wanted = a.align === "right" ? anchor.x + anchor.width - size.width : anchor.x;
  const left = Math.max(EDGE, Math.min(wanted, window.width - EDGE - size.width));
  return { left, top, maxHeight, up };
}
