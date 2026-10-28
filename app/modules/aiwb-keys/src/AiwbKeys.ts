// The contract of `aiwb-keys` (architecture AD-73, package N3): the hardware keyboard's shortcuts on an iPad and on Android, as
// the KeyboardEvent-like object the keys port hands its handlers. This file has no run-time import of the native module: it is the
// types, and the one table of the shortcuts the module takes. README.md says how each platform makes the events.

/** What the module emits for a shortcut: the part of a KeyboardEvent that the shortcut logic of @aiwb/core reads. */
export type KeyEvent = {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** The key is held and the system repeats it. */
  repeat: boolean;
};

export type AiwbKeysEvents = { onKey(e: KeyEvent): void };

/** The handle `addListener` answers; Expo's EventSubscription. */
export type Subscription = { remove(): void };

/** The module: the native one (AiwbKeysModule.ts), the fake (fake.ts) and the stand-in of the web build. The native side takes
 *  the keys while at least one listener is added (and gives them back with the last), so a build that nobody asks keeps the keyboard
 *  to the system. */
export interface AiwbKeysModule {
  addListener<E extends keyof AiwbKeysEvents>(name: E, listener: AiwbKeysEvents[E]): Subscription;
}

/** One shortcut the module takes. `mod` is the platform's command key: ⌘ (metaKey) on iPadOS, Ctrl (ctrlKey) on Android. */
export type Shortcut = {
  code: string;
  /** `key` of the event without Shift; with Shift a letter is upper case, as a browser makes it. */
  key: string;
  mod: boolean;
  shift: boolean;
  label: string;
};

/** The shortcuts the desktop page has and a tablet has too (goal 4.4). The native sides carry the same list (checked by
 *  app/test/nativekeys.test.ts); every other key, and every key with another set of modifiers, is the system's and the text box's. */
export const SHORTCUTS: readonly Shortcut[] = [
  { code: "KeyN", key: "n", mod: true, shift: false, label: "New chat" },
  { code: "KeyB", key: "b", mod: true, shift: false, label: "Hide or show the sidebar" },
  { code: "KeyB", key: "b", mod: true, shift: true, label: "Tree of the chat" },
  { code: "KeyJ", key: "j", mod: true, shift: false, label: "Hide or show the chat panel" },
  { code: "KeyL", key: "l", mod: true, shift: false, label: "Quote the selection or add it to the message" },
  { code: "KeyL", key: "l", mod: true, shift: true, label: "Pick a point on the board" },
  { code: "KeyP", key: "p", mod: true, shift: false, label: "Insert a prompt" },
  { code: "KeyE", key: "e", mod: true, shift: false, label: "Model and effort" },
  { code: "Enter", key: "Enter", mod: true, shift: false, label: "Save" },
  { code: "Escape", key: "Escape", mod: false, shift: false, label: "Close" },
];

/** The event of a shortcut as the platform's module makes it. */
export function eventOf(s: Shortcut, platform: "ios" | "android", repeat = false): KeyEvent {
  const letter = /^[a-z]$/.test(s.key);
  return {
    key: s.shift && letter ? s.key.toUpperCase() : s.key,
    code: s.code,
    metaKey: s.mod && platform === "ios",
    ctrlKey: s.mod && platform === "android",
    shiftKey: s.shift,
    altKey: false,
    repeat,
  };
}
