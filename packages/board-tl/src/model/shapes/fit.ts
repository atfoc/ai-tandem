// Shrink-to-fit for the sticky note (goal 3.2, risk 8.3): the largest font size at which the text fits the note's box.
// A pure function of the text measure, so the window (tldraw's DOM measure) and the board host (skia-canvas with the same
// font files) run the same code and get the same answer for the same measurements. No DOM, no tldraw import: the later
// `packages/board-tl/model` lifts this file as it is.

/** What one measurement returns: the laid-out text's size in px. `scrollWidth` is the widest unbreakable run (a long word)
 *  when the measure is asked not to break inside words; equal to `w` (or absent) when nothing overflows. */
export interface MeasuredText {
  w: number;
  h: number;
  scrollWidth?: number;
}

/** Lays the sticky's text out at one font size, wrapped at `maxWidth`, words not broken (`overflow-wrap: normal`).
 *  The window implements it with `editor.textMeasure.measureHtml`, the board host with its skia-canvas measure. */
export type MeasureAt = (fontSize: number, maxWidth: number) => MeasuredText;

export interface FitInput {
  /** The note's box (px, unscaled). */
  w: number;
  h: number;
  /** Inner padding on each side (px). */
  padding: number;
  /** 0 or absent: automatic (shrink to fit). A number: that size, fitted or not. */
  fixed?: number;
  /** The text is empty: the answer is the largest size, nothing is measured. */
  empty?: boolean;
  /** Limits of the automatic size; defaults from `autoRange(w)`. */
  min?: number;
  max?: number;
  /** Size granularity in px (default 1): the answer is a multiple of it, so tiny measuring differences between two
   *  machines rarely change the stored size. */
  step?: number;
}

export interface FitResult {
  fontSize: number;
  /** The text does not fit even at `fontSize` (the minimum, or the fixed size). */
  overflows: boolean;
  /** How many times `measure` was called (for the tests and the measurements of 6.5). */
  measured: number;
}

/** Tolerance (px) for the comparison of a measured size with the box: DOM measures return fractions, and a layout that is
 *  0.5 px taller than the box is still read as fitting, as tldraw's note does with its own FUZZ. */
export const FUZZ = 0.5;

/** The default automatic range for a note of width `w`: the largest size grows with the note (48 px on a 200 px note, as
 *  Miro shows a short word big), the smallest is 6 px whatever the size. */
export function autoRange(w: number): { min: number; max: number } {
  return { min: 6, max: Math.max(6, Math.floor(w * 0.24)) };
}

function fits(m: MeasuredText, innerW: number, innerH: number): boolean {
  const widest = Math.max(m.w, m.scrollWidth ?? 0);
  return m.h <= innerH + FUZZ && widest <= innerW + FUZZ;
}

/** The largest font size (a multiple of `step`, between `min` and `max`) at which the text fits the box, by binary search:
 *  fitting is monotonic in the font size (a smaller font never needs more room), so at most log2((max-min)/step)+1
 *  measurements. */
export function fitFontSize(input: FitInput, measure: MeasureAt): FitResult {
  const { w, h, padding } = input;
  const innerW = Math.max(1, w - padding * 2);
  const innerH = Math.max(1, h - padding * 2);
  const step = input.step && input.step > 0 ? input.step : 1;
  let measured = 0;
  const at = (size: number) => {
    measured++;
    return fits(measure(size, innerW), innerW, innerH);
  };

  if (input.fixed && input.fixed > 0) {
    if (input.empty) return { fontSize: input.fixed, overflows: false, measured };
    return { fontSize: input.fixed, overflows: !at(input.fixed), measured };
  }

  const range = autoRange(w);
  const lo0 = Math.ceil((input.min ?? range.min) / step);
  const hi0 = Math.max(lo0, Math.floor((input.max ?? range.max) / step));
  if (input.empty) return { fontSize: hi0 * step, overflows: false, measured };

  if (at(hi0 * step)) return { fontSize: hi0 * step, overflows: false, measured };
  if (!at(lo0 * step)) return { fontSize: lo0 * step, overflows: true, measured };
  // invariant: lo fits, hi does not
  let lo = lo0;
  let hi = hi0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(mid * step)) lo = mid;
    else hi = mid;
  }
  return { fontSize: lo * step, overflows: false, measured };
}
