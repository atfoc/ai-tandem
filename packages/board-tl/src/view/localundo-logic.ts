// Undo and redo that touch only what this window did (goal 3.3). Pure logic, no tldraw: localundo.ts wires it to the store.
//
// tldraw's history keeps whole records and an undo writes the whole "before" record back, so a property someone else (another
// window, the agent) changed in between would be put back too. So the window keeps, per record, only the fields it wrote
// itself and the value it wrote ("owned"): a top-level field whole, `props` and `meta` field by field (so a sticky's colour and
// its size are separate). While an undo or redo runs, each record it writes is merged field by field: the history's value is
// taken only where this window owns the field and the current value still deep-equals the owned one (nobody changed it since);
// everywhere else the current value stays. Values (rich text included) are compared deeply.

type Obj = Record<string, unknown>;

/** A field this window removed (or that the record does not have), as the owned value. */
export const ABSENT: unique symbol = Symbol("absent");

/** The fields of one record this window wrote, with the value it wrote; `props` and `meta` hold their own fields. */
export type Owned = Obj & { props?: Obj; meta?: Obj };

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

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const valueOf = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : ABSENT);
const keys = (a: Obj, b: Obj) => new Set([...Object.keys(a), ...Object.keys(b)]);

/** Each field (or field of props/meta) whose value differs between prev and next (all of next's with `prev` undefined), as
 * [field, field of props/meta or null, next value]. */
function changed(prev: Obj | undefined, next: Obj): Array<[string, string | null, unknown]> {
  const out: Array<[string, string | null, unknown]> = [];
  for (const k of keys(prev ?? {}, next)) {
    if (NESTED.has(k) && (isObj(next[k]) || isObj(prev?.[k]))) {
      const p = prev && isObj(prev[k]) ? (prev[k] as Obj) : undefined, n = isObj(next[k]) ? (next[k] as Obj) : {};
      for (const s of keys(p ?? {}, n)) {
        const nv = valueOf(n, s);
        if (!p || !deepEqual(valueOf(p, s), nv)) out.push([k, s, nv]);
      }
      continue;
    }
    const nv = valueOf(next, k);
    if (!prev || !deepEqual(valueOf(prev, k), nv)) out.push([k, null, nv]);
  }
  return out;
}

/**
 * What this window owns of a record after it wrote `next` over `prev` (`prev` undefined: it created the record, so every
 * field): each field whose value changed is owned with its new value; the others stay as they were (absent stays absent).
 */
export function own(owned: Owned | undefined, prev: object | undefined, next: object): Owned {
  const out: Owned = { ...owned, props: { ...owned?.props }, meta: { ...owned?.meta } };
  for (const [k, s, v] of changed(prev as Obj | undefined, next as Obj)) {
    if (s === null) out[k] = v;
    else (out[k] as Obj)[s] = v;
  }
  return out;
}

const owns = (o: Obj | undefined, k: string) => !!o && Object.hasOwn(o, k);

function mergeFields(current: Obj, target: Obj, owned: Obj | undefined, nested: boolean): Obj {
  const out: Obj = {};
  for (const k of keys(current, target)) {
    if (nested && NESTED.has(k) && isObj(current[k]) && isObj(target[k])) {
      out[k] = mergeFields(current[k] as Obj, target[k] as Obj, (owned as Owned | undefined)?.[k as "props"], false);
      continue;
    }
    // the history's value (or its absence) only for a field this window wrote and nobody changed since
    const mine = owns(owned, k) && deepEqual(valueOf(current, k), owned![k]);
    const from = mine ? target : current;
    if (Object.hasOwn(from, k)) out[k] = from[k];
  }
  return out;
}

/**
 * The record an undo or redo writes: `target` (the history's record) in the fields this window owns whose current value is
 * still the owned one, `current` elsewhere. With nothing owned, `current`. Returns `current` itself when nothing would change.
 */
export function mergeReplay<R extends object>(current: R, target: R, owned: Owned | undefined): R {
  if (!owned) return current;
  const merged = mergeFields(current as Obj, target as Obj, owned, true) as R;
  return deepEqual(merged, current) ? current : merged;
}
