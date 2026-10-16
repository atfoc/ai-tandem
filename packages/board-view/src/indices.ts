// Valid fractional indices for the elements an apply puts in the scene. DOM-free (no Excalidraw import), so a test runs it in Node.
//
// `convertToExcalidrawElements` numbers the elements of each call from `a0`, so what an apply adds to a board that has elements gets
// indices lower than the elements before it. On screen Excalidraw's `updateScene` repairs them (and bumps their version); on given
// elements nothing does. Doing it here, before `updateScene`, leaves it nothing to repair: both paths end with the same scene.
import { generateNKeysBetween } from "fractional-indexing";

/** Each run of elements whose index is missing or not above the one before gets indices between its neighbours (the same library
 *  and the same notion of "invalid" as Excalidraw's `syncInvalidIndices`). `withIndex` makes the element with the new index
 *  (`newElementWith` in apply.ts: it bumps the version); it is called only for the elements of invalid runs. */
export function validIndices<T extends { index?: string | null }>(els: T[], withIndex: (e: T, index: string) => T): T[] {
  const out = [...els];
  let i = 0, prev: string | null = null;
  while (i < out.length) {
    const ix = out[i].index;
    if (typeof ix === "string" && (prev === null || ix > prev)) { prev = ix; i++; continue; }
    let j = i; // the run [i, j) of invalid ones; the upper bound is the next index above prev
    while (j < out.length && !above(out[j].index, prev)) j++;
    let upper: string | null = j < out.length ? (out[j].index as string) : null;
    // (an upper bound that is not above the run's lower bound cannot be used)
    if (upper !== null && prev !== null && upper <= prev) upper = null;
    const keys = generateNKeysBetween(prev, upper, j - i);
    for (let k = i; k < j; k++) out[k] = withIndex(out[k], keys[k - i]);
    prev = keys[keys.length - 1]; i = j;
  }
  return out;
}

const above = (ix: string | null | undefined, prev: string | null): boolean => typeof ix === "string" && (prev === null || ix > prev);
