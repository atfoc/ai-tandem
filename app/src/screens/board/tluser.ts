// The person as a new board (kind "tl") names them to the others (plans/better-board/design.md 8, D12): a generated name, an
// adjective and an animal ("Teal Otter"), and a colour of tldraw's user palette, made the first time and kept in the page's kv
// (`aiwb.tl.user`), so the same window keeps the same name. The view gives it to tldraw as the user's preferences, so the cursor
// and the selection the other windows draw carry it. A real build would take the name from the server's clients or Settings.
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";

export type TlUser = { id: string; name: string; color: string };

export const TL_USER_KEY = "aiwb.tl.user";

export const ADJECTIVES = ["Teal", "Amber", "Coral", "Brave", "Calm", "Swift", "Bright", "Quiet", "Lucky", "Sunny", "Bold", "Clever", "Gentle", "Jolly", "Misty", "Rosy"] as const;
export const ANIMALS = ["Otter", "Fox", "Heron", "Badger", "Lynx", "Panda", "Falcon", "Koala", "Beaver", "Owl", "Seal", "Wren", "Hare", "Moose", "Gecko", "Ibis"] as const;
/** tldraw's user palette (`USER_COLORS` of @tldraw/editor 5.6.0). */
export const USER_COLORS = ["#FF802B", "#EC5E41", "#F2555A", "#F04F88", "#E34BA9", "#BD54C6", "#9D5BD2", "#7B66DC", "#02B1CC", "#11B3A3", "#39B178", "#55B467"] as const;

const pick = <T>(list: readonly T[], random: () => number): T => list[Math.floor(random() * list.length) % list.length];

/** A new person: a random id, name and colour. */
export function makeTlUser(random: () => number = Math.random): TlUser {
  const id = "user:" + Array.from({ length: 12 }, () => pick("abcdefghijklmnopqrstuvwxyz0123456789".split(""), random)).join("");
  return { id, name: `${pick(ADJECTIVES, random)} ${pick(ANIMALS, random)}`, color: pick(USER_COLORS, random) };
}

/** What `aiwb.tl.user` holds, when it is a whole person; null for anything else (missing, broken, an older shape). */
export function parseTlUser(text: string | null): TlUser | null {
  if (!text) return null;
  try {
    const u = JSON.parse(text) as Partial<TlUser>;
    return typeof u?.id === "string" && u.id && typeof u.name === "string" && u.name && typeof u.color === "string" && u.color ? { id: u.id, name: u.name, color: u.color } : null;
  } catch { return null; }
}

/** Where the person is kept: the page's kv through the store (a storage that refuses keeps nothing, and the person holds for this run). */
export type TlUserStore = { get(k: string): string | null; set(k: string, v: string): void };
const pageStore: TlUserStore = { get: safeGet, set: (k, v) => safeSet(k, v) };

/** The person this page is to the others: the one kept, else a new one, kept now. */
export function tlUser(io: TlUserStore = pageStore, random: () => number = Math.random): TlUser {
  const kept = parseTlUser(io.get(TL_USER_KEY));
  if (kept) return kept;
  const made = makeTlUser(random);
  try { io.set(TL_USER_KEY, JSON.stringify(made)); } catch { /* holds for this run */ }
  return made;
}
