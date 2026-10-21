// What hold Space needs from the platform beyond the keys port (which reports key presses only): where the focus is, and the release of the key.
// Where there is no page keyboard (the phone, an iPad's or Android's hardware keyboard: `aiwb-keys` takes shortcuts, never typing keys) there is
// no Space for the pill.

/** What the pill does with a Space pressed while the focus is where it is: `take` it (the page does not also act on it), `share` it (the board's canvas keeps
 *  its own use of Space, panning, and hears it too), or leave it to what has the focus (a text box, a button that a Space presses). */
export type SpaceFocus = "take" | "share" | null;

export type SpaceFocusNow = () => SpaceFocus;

/** Registers the release of Space and the window losing the focus (a key released elsewhere is never heard); answers the function that takes them away. */
export type OnSpaceRelease = (release: (e: { preventDefault(): void; stopPropagation(): void }) => void, lost: () => void) => () => void;
