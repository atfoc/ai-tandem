// The kv port on the web (AD-12): `localStorage`, with the page's own keys. What the old page left in the same origin
// is read as the page would read it; nothing is migrated. A storage that is missing or refuses (private mode, full)
// reads as empty and keeps nothing: the callers already treat a failed set as "holds for this run".
import type { Kv } from "./kv.types.ts";

export type { Kv } from "./kv.types.ts";

const storage = (): Storage | null => {
  try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
};

export const kv: Kv = {
  get: (key) => { try { return storage()?.getItem(key) ?? null; } catch { return null; } },
  set: (key, value) => { storage()?.setItem(key, value); },
  remove: (key) => { try { storage()?.removeItem(key); } catch { /* nothing to remove */ } },
  keys: () => {
    try {
      const s = storage();
      return s ? Array.from({ length: s.length }, (_, i) => s.key(i)).filter((k): k is string => k !== null) : [];
    } catch { return []; }
  },
};
