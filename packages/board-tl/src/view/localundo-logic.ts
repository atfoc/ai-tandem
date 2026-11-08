// Undo and redo that touch only what this window did (goal 3.3). Pure logic, no tldraw: localundo.ts wires it to the store.
//
// tldraw's history keeps whole records and an undo writes the whole "before" record back, so a property someone else (another
// window, the agent) changed in between would be put back too. While an undo or redo runs, each record it writes is merged
// field by field: the history's value is taken only where the current value is still the one this window left; where someone
// else changed the field since, the current value stays. Top-level fields are compared whole, `props` and `meta` field by
// field (so a sticky's colour and its size are separate); values (rich text included) are compared deeply.

type Obj = Record<string, unknown>;

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as Obj), kb = Object.keys(b as Obj);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b as Obj, k) && deepEqual((a as Obj)[k], (b as Obj)[k]));
}

/** The fields compared one by one rather than whole. */
const NESTED = new Set(["props", "meta"]);

function mergeFields(current: Obj, target: Obj, left: Obj, nested: boolean): Obj {
  const out: Obj = {};
  for (const k of new Set([...Object.keys(current), ...Object.keys(target)])) {
    const c = current[k], t = target[k], l = left[k];
    if (nested && NESTED.has(k) && isObj(c) && isObj(t) && isObj(l)) {
      out[k] = mergeFields(c, t, l, false);
      continue;
    }
    // the field is this window's as long as nobody changed it since: then the history's value (or its absence) wins
    const from = deepEqual(c, l) ? target : current;
    if (Object.hasOwn(from, k)) out[k] = from[k];
  }
  return out;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The record an undo or redo writes: `target` (the history's record) where `current` still equals `left` (the record as this
 * window last left it), `current` elsewhere. With nothing known of what this window left, the history's record as it is.
 * Returns `current` itself when nothing would change.
 */
export function mergeReplay<R extends object>(current: R, target: R, left: R | undefined): R {
  if (!left) return target;
  const merged = mergeFields(current as Obj, target as Obj, left as Obj, true) as R;
  return deepEqual(merged, current) ? current : merged;
}
