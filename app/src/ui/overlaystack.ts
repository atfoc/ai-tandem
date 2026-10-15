// The overlays that are open, in the order they opened (AD-70). Esc and the back button close the top one only: a
// confirm dialog over a menu closes first, and the menu stays. No React and no react-native here, so Node loads it.
const open: symbol[] = [];

/** An overlay opens: its token goes on top. Returns the function that takes it away again. */
export function pushOverlay(): { token: symbol; remove(): void } {
  const token = Symbol("overlay");
  open.push(token);
  return {
    token,
    remove() {
      const at = open.indexOf(token);
      if (at >= 0) open.splice(at, 1);
    },
  };
}

/** Whether the overlay of this token is the one on top. */
export const isTopOverlay = (token: symbol): boolean => open.length > 0 && open[open.length - 1] === token;

/** How many overlays are open. */
export const overlaysOpen = (): number => open.length;
