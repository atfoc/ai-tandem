// `changed` as a delta (AD-50), both ends of it. The board view keeps a **baseline** of what the app last heard for the board it
// shows (id → version, and the ids in scene order) and sends what differs from it; the app keeps a **mirror** of the scene
// and applies each delta to it. The whole scene crosses only in `load` and in a `snapshot`'s answer.
//
// What differs: an element whose version is not the baseline's (a new one, or a deleted one: Excalidraw keeps it with
// `isDeleted: true`), and `order` (every id, in scene order) when the ids or their order changed. Files are never changed in
// place, so a `changed` carries the files added since the last one (the view tracks their ids; the mirror adds them).
import type { El } from "./messages.ts";

export type ElementsDelta = { elements: El[]; order?: string[] };

export type Baseline = {
  /** What differs between these elements (the scene in scene order) and the baseline; null when nothing does. Pure. */
  diff(elements: readonly El[]): ElementsDelta | null;
  /** The baseline is these elements now: after a `load`, a `snapshot`, or a delta that was sent. */
  set(elements: readonly El[]): void;
};

/** A baseline of the given elements (a board just loaded) or of nothing. */
export function createBaseline(elements: readonly El[] = []): Baseline {
  let versions = new Map<string, number>();
  let order: string[] = [];
  const set = (els: readonly El[]) => {
    versions = new Map(els.map((e) => [e.id, e.version]));
    order = els.map((e) => e.id);
  };
  set(elements);
  return {
    diff(els) {
      const changed = els.filter((e) => versions.get(e.id) !== e.version);
      const sameOrder = els.length === order.length && els.every((e, i) => e.id === order[i]);
      if (!changed.length && sameOrder) return null;
      return sameOrder ? { elements: changed } : { elements: changed, order: els.map((e) => e.id) };
    },
    set,
  };
}

/** The mirror after a delta: the elements it carries replace theirs by id (new ones are appended), then `order`, when
 *  present, puts them in scene order and drops the ids it no longer names. An id `order` names that the mirror has not
 *  (it is neither in `prev` nor in the delta) cannot be placed and is left out. */
export function applyDelta(prev: readonly El[], delta: ElementsDelta): El[] {
  const byId = new Map(prev.map((e) => [e.id, e]));
  for (const e of delta.elements) byId.set(e.id, e); // (the view sends only those whose version differs: replace)
  if (!delta.order) return [...byId.values()];
  const out: El[] = [];
  for (const id of delta.order) { const e = byId.get(id); if (e) out.push(e); }
  return out;
}

/** The ids of the files in `files` that `told` does not have. */
export function filesAdded<F extends Record<string, unknown>>(files: F, told: ReadonlySet<string>): Partial<F> {
  const out: Partial<F> = {};
  for (const k of Object.keys(files)) if (!told.has(k)) (out as Record<string, unknown>)[k] = files[k];
  return out;
}
