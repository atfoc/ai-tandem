// The widths the toolbar's controls ask for, kept by what decides them (composerfit.ts widthKey), so that a chip is measured once,
// whichever composer shows it (the old page's Composer.tsx `widths`). They are the widths of one zoom of the screen, and are dropped when it
// changes. No React and no react-native here: the zoom is given.

/** A width as the fit reads it: rounded up to a tenth of a point. */
export const roundUp = (w: number): number => Math.ceil(w * 10 - 1e-6) / 10;

/** A row's width as the fit reads it: rounded down to a tenth. */
export const roundDown = (w: number): number => Math.floor(w * 10 + 1e-6) / 10;

export type Widths = {
  get(key: string): number | undefined;
  /** Keeps a measured width; true when the key had none (the first measurement stays: a control measured again in another place would
   *  otherwise change the fit with its surroundings). */
  keep(key: string, w: number): boolean;
  /** How many widths were kept since the start (a check reads it: a change of zoom measures again). */
  readonly count: number;
  /** What is kept, by key (a check reads it). */
  dump(): Record<string, number>;
};

export function createWidths(zoom: () => number): Widths {
  const kept = new Map<string, number>();
  let at = zoom(), count = 0;
  const sync = () => { const z = zoom(); if (z !== at) { kept.clear(); at = z; } };
  return {
    get(key) { sync(); return kept.get(key); },
    keep(key, w) {
      sync();
      if (kept.has(key)) return false;
      kept.set(key, roundUp(w));
      count++;
      return true;
    },
    get count() { return count; },
    dump() { sync(); return Object.fromEntries(kept); },
  };
}
