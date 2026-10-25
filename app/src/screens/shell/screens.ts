// The phone's stack of screens beyond the board and the chat (ux-improvements goal 3.1.2, 3.2, 4.8; package F2): a registry of named
// screens that a package pushes by name, the overlays that the presenter of ui/pushedscreen.tsx pushes, and the entries of the whole
// stack with their titles (the back's label, the hold sheet).
//
// The stack stays derived (AD-71): the bottom is Home, then the groups browsed on Home or, while a board or a chat is open, the
// groups of its place (the same whichever way the person came: a row, a search result, a notification), then the board, its chat
// and the subagent drawer, as stack.ts derives them from the store. Pushed screens (Settings and its pages, a server's detail, the
// Archived list, the library's screens, a full diff, a table, a subagent) lie on top of that, in the order they were pushed; a back
// takes the top one away. PhoneStack.tsx draws every entry as a route of the one native stack.
//
// This file holds the pushed screens only: a list in the order of the pushes, and the entries it makes (`pushedEntries`, the same
// array while nothing changed, so a hook can read it). It uses React's hooks and imports no react-native.
import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import type { HomePlace, ScreenKind, StackEntry } from "./stack.ts";

export type { HomePlace, ScreenKind, StackEntry };

export type ScreenSpec<P> = {
  kind: ScreenKind;
  /** The title in its bar, in the back of the screen above it, and in the hold sheet. */
  title(params: P): string;
  component: ComponentType<{ params: P }>;
  /** The action at the right of a place screen's bar. */
  right?: ComponentType<{ params: P }>;
  /** The edge swipe goes back (true by default; the board's canvas is not a pushed screen). */
  edgeSwipe?: boolean;
};

/** A pushed screen: a registered one with its params, or an overlay (name `OVERLAY`, no params) whose content its owner sets. */
export type Pushed = {
  key: string;
  name: string;
  params: unknown;
  /** An overlay's own title and testID. */
  title?: string;
  testID?: string;
  /** Called when a back or `clearPushed` takes the screen away, not when its owner closes it. */
  onPop?(): void;
};

export const OVERLAY = "overlay";

const specs = new Map<string, ScreenSpec<never>>();
let pushed: Pushed[] = [];
let entries: StackEntry[] = [];
let contents = new Map<string, ReactNode>();
let n = 0;
const listeners = new Set<() => void>();
const contentListeners = new Set<() => void>();

const entryOf = (p: Pushed): StackEntry => {
  const spec = specs.get(p.name) as ScreenSpec<unknown> | undefined;
  return { key: p.key, name: p.name, title: spec ? spec.title(p.params) : p.title ?? "", kind: spec?.kind ?? "place", route: "pushed", id: p.key };
};

function set(next: Pushed[]): void {
  pushed = next;
  entries = next.map(entryOf);
  if ([...contents.keys()].some((k) => !next.some((p) => p.key === k))) contents = new Map([...contents].filter(([k]) => next.some((p) => p.key === k)));
  listeners.forEach((l) => l());
  contentListeners.forEach((l) => l());
}

/** Registers a screen by name (once, at import of the package's index.ts, as setSlot does). */
export function registerScreen<P>(name: string, spec: ScreenSpec<P>): void {
  specs.set(name, spec as ScreenSpec<never>);
}

/** Pushes the screen `name` with its params on top of the stack. Answers the entry's key. */
export function pushScreen<P>(name: string, params: P, o: { onPop?(): void } = {}): string {
  if (!specs.has(name)) throw new Error(`no screen "${name}" is registered`);
  const key = `${name}#${++n}`;
  set([...pushed, { key, name, params, onPop: o.onPop }]);
  return key;
}

/** Pushes an overlay: a place screen with this title whose content its owner gives with `setPushedContent`. `onPop` is how a back
 *  tells the owner to close. Answers the entry's key. */
export function pushOverlay(o: { title: string; testID?: string; onPop(): void }): string {
  const key = `${OVERLAY}#${++n}`;
  set([...pushed, { key, name: OVERLAY, params: undefined, title: o.title, testID: o.testID, onPop: o.onPop }]);
  return key;
}

/** Takes the pushed screen `key` away, and every one above it; without a key, the top one. Each one's `onPop` is called, the top one
 *  first. `quiet` leaves out the named one's: its owner is closing it (the ones above it have owners that must still hear). */
export function popScreen(key?: string, o: { quiet?: boolean } = {}): void {
  const at = key ? pushed.findIndex((p) => p.key === key) : pushed.length - 1;
  if (at < 0) return;
  const gone = pushed.slice(at);
  const own = gone[0]!;
  set(pushed.slice(0, at));
  for (const p of gone.reverse()) if (!(o.quiet && p === own)) p.onPop?.();
}

/** Takes every pushed screen away (opening content from a pushed screen shows the content, not the screen over it). */
export function clearPushed(): void {
  const gone = pushed;
  if (!gone.length) return;
  set([]);
  for (const p of [...gone].reverse()) p.onPop?.();
}

/** The pushed screens now, bottom first. */
export const pushedScreens = (): readonly Pushed[] => pushed;

/** The pushed screens as entries of the stack, bottom first; the same array until the list changes. */
export const pushedEntries = (): StackEntry[] => entries;

export function subscribePushed(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The spec of a registered screen (PhoneStack draws it). */
export const screenSpec = (name: string): ScreenSpec<never> | undefined => specs.get(name);

/** Sets what an overlay's screen draws: a React node of the presenter, so the content sees the app's providers as the presenter's own
 *  tree does (as ui/overlayhost.tsx does). Nothing for a key that is not pushed. */
export function setPushedContent(key: string, node: ReactNode): void {
  if (!pushed.some((p) => p.key === key) || contents.get(key) === node) return;
  contents = new Map(contents).set(key, node);
  contentListeners.forEach((l) => l());
}

const subscribeContent = (l: () => void) => { contentListeners.add(l); return () => { contentListeners.delete(l); }; };

/** The content of an overlay's screen (null while it has none). */
export const usePushedContent = (key: string): ReactNode => useSyncExternalStore(subscribeContent, () => contents.get(key) ?? null, () => null);
