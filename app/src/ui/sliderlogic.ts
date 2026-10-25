// What a slider decides from plain numbers (small-improvements goal 3.4, plans/small-improvements/sliders.md): which step a position is, how far
// along the track a value sits, where a key moves it, and when a change is worth a commit. No React and no react-native here, so Node tests it.
// A value is `min + k·step`, held to the ends: the delay is 100…10000 in steps of 100 (milliseconds), the max chats 1…100 in steps of 1.

export type Range = { min: number; max: number; step: number };

/** A key press as plain values (the DOM's event is read once, at the edge). */
export type KeyPress = { key: string; alt: boolean; ctrl: boolean; meta: boolean };

export type KeyOptions = Range & {
  /** Page Up / Page Down; default ten steps. */
  bigStep?: number;
  /** false: ArrowUp and ArrowDown are not the slider's (a menu around it moves its focus with them); default true. */
  verticalKeys?: boolean;
};

/** Arithmetic on steps like 0.1 would drift (0.1 × 3 is 0.30000000000000004): numbers are rounded to nine decimals. */
const tidy = (n: number) => Math.round(n * 1e9) / 1e9;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** How many steps `v` is from `min` (a fraction when off the steps); rounded as above, so 0.3 over 0.1 is 3 and not 2.9999999999999996. */
const stepsFrom = (v: number, r: Range) => tidy((v - r.min) / r.step);

/** The step nearest to `v`, from `min`, held to the ends (a value past an end is the end; one halfway between two steps goes up). */
export function snap(v: number, min: number, max: number, step: number): number {
  if (!Number.isFinite(v)) return min;
  const held = clamp(v, min, max);
  if (!(step > 0)) return held;
  return clamp(tidy(min + Math.round(stepsFrom(held, { min, max, step })) * step), min, max);
}

/** How far along the track a value sits, 0 at `min` to 1 at `max`: a value off the steps keeps its own place, one past an end is held to it
 *  (the handle is never drawn outside the track). */
export function fractionOf(v: number, min: number, max: number): number {
  if (!Number.isFinite(v) || !(max > min)) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

/** The value for a pointer `x` points along a track `width` points wide (x from the track's left end), snapped; before the left end it is
 *  `min`, past the right end `max`. */
export function valueAt(x: number, width: number, min: number, max: number, step: number): number {
  if (!(width > 0) || !Number.isFinite(x)) return snap(min, min, max, step);
  return snap(min + clamp(x / width, 0, 1) * (max - min), min, max, step);
}

/** The step next to `v` in direction `dir` (1 up, −1 down): for a value on the steps, one step; for one off them, the step on that side of it
 *  (4730 up is 4800, down 4700). At an end it stays. */
function neighbour(v: number, dir: 1 | -1, r: Range): number {
  const held = clamp(Number.isFinite(v) ? v : r.min, r.min, r.max);
  if (!(r.step > 0)) return held;
  const k = stepsFrom(held, r);
  const next = dir > 0 ? Math.floor(k) + 1 : Math.ceil(k) - 1;
  return snap(r.min + next * r.step, r.min, r.max, r.step);
}

/** One step from `v` in direction `dir`, or `by` points when that is more than a step (Page Up / Page Down: from a value off the steps, the
 *  nearest step to `v` ± `by`): snapped and held to the ends. */
export function nudge(v: number, dir: 1 | -1, r: Range, by: number = r.step): number {
  if (!(by > r.step)) return neighbour(v, dir, r);
  const held = clamp(Number.isFinite(v) ? v : r.min, r.min, r.max);
  return snap(held + dir * by, r.min, r.max, r.step);
}

/** The larger step of Page Up / Page Down: `bigStep` if it is a positive number, else ten steps. */
export function bigStepOf(o: { step: number; bigStep?: number }): number {
  return o.bigStep !== undefined && o.bigStep > 0 ? o.bigStep : 10 * o.step;
}

/** The value a key press gives, or null when the key is not the slider's (it bubbles). → and ↑ one step up, ← and ↓ one step down (↑ and ↓
 *  only with `verticalKeys`, the default), Page Up / Page Down `bigStep`, Home and End the ends. The result is on the steps and held to the ends (Home and End are the ends themselves). */
export function keyStep(key: string, v: number, o: KeyOptions): number | null {
  const r: Range = { min: o.min, max: o.max, step: o.step };
  const vertical = o.verticalKeys !== false;
  switch (key) {
    case "ArrowRight": return nudge(v, 1, r);
    case "ArrowLeft": return nudge(v, -1, r);
    case "ArrowUp": return vertical ? nudge(v, 1, r) : null;
    case "ArrowDown": return vertical ? nudge(v, -1, r) : null;
    case "PageUp": return nudge(v, 1, r, bigStepOf(o));
    case "PageDown": return nudge(v, -1, r, bigStepOf(o));
    case "Home": return o.min;
    case "End": return o.max;
    default: return null;
  }
}

/** A change is committed only when it is a different value from the one the slider has. */
export function shouldCommit(next: number, value: number): boolean {
  return Number.isFinite(next) && next !== value;
}
