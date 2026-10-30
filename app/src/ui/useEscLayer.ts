// A popup that is not an overlay (the quote float) takes Esc in the order of the overlays (overlaystack.ts) on web:
// one Esc closes the innermost thing. Elsewhere there is no Esc to take and the back button has no popup of this kind to close: nothing here.
export function useEscLayer(_open: boolean, _onEsc: () => void): void {}
