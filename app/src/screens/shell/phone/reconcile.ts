// How the native stack follows the list of entries (f2-design.md §6): pure, so Node tests it. Both sides are lists of entry keys.

/** What makes the navigator's keys `have` the store's `want`: nothing, a push of the top, a pop of `n`, a reset to all but the top and
 *  then a push of it (a new top slides in over the screens under it), or a reset. */
export type Follow =
  | { kind: "none" }
  | { kind: "push" }
  | { kind: "pop"; n: number }
  | { kind: "slide" }
  | { kind: "reset" };

const startsWith = (a: readonly string[], b: readonly string[]): boolean => a.length >= b.length && b.every((k, i) => a[i] === k);

export function follow(have: readonly string[], want: readonly string[]): Follow {
  if (have.length === want.length && startsWith(have, want)) return { kind: "none" };
  if (want.length === have.length + 1 && startsWith(want, have)) return { kind: "push" };
  if (have.length > want.length && startsWith(have, want)) return { kind: "pop", n: have.length - want.length };
  if (want.length > 1 && !have.includes(want[want.length - 1]!)) return { kind: "slide" };
  return { kind: "reset" };
}

/** The routes of a reset to `entries`: a route whose entry key the navigator already holds (`have`: its routes' React Navigation keys with the
 *  entry key each carries) keeps that route's key, so React Navigation keeps the screen mounted (a chat stays when a group under it comes or
 *  goes); any other gets none, and so a new screen. A key is kept once, by the first entry of that entry key. */
export function keepRoutes<E extends { route: string; key: string }>(
  entries: readonly E[], have: readonly { key: string; entry: string }[],
): { key?: string; name: E["route"]; params: { entry: string } }[] {
  const held = new Map<string, string>();
  for (const h of have) if (!held.has(h.entry)) held.set(h.entry, h.key);
  return entries.map((e) => {
    const key = held.get(e.key);
    held.delete(e.key);
    return key === undefined ? { name: e.route, params: { entry: e.key } } : { key, name: e.route, params: { entry: e.key } };
  });
}

/** A back the navigator made by itself: its keys are a strict prefix of the store's (and not empty). The key to pop to is its top. */
export const navigatorPopped = (have: readonly string[], want: readonly string[]): string | null =>
  have.length > 0 && have.length < want.length && startsWith(want, have) ? have[have.length - 1]! : null;
