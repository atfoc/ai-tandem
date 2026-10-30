// The composer's keys, as decisions over plain values (the old page's Composer.tsx onKeyDown and the window handler for ⌘L / ⌘⇧L). No React and
// no react-native here, so Node loads it and test/composer.test.ts holds it.
//
// ENTER, on every platform and layout: Enter is a line break, Shift+Enter too, and ⌘Enter (a Mac, an iPad) / Ctrl+Enter (elsewhere) sends,
// with Alt not held (Shift+⌘Enter is nothing). The composer's `onKey` takes no plain Enter, so the box keeps the line break it makes. Who
// reports ⌘Enter / Ctrl+Enter:
//  - web: the box's keydown, with its modifiers (`boxAction`). Enter while an input method composes reaches no one (the box does not give it).
//  - iOS and Android: `onKeyPress` reports the key without its modifiers (and a soft keyboard's return is the same "Enter"), so the box only
//    ever gives a line break; a hardware keyboard's ⌘Enter / Ctrl+Enter comes from the keys port (AD-73: aiwb-keys' mod+Enter, the one the
//    library's edit form uses to save): `sendByKey`. [not verified on a device] The web keys port listens on the window before the box, so it takes
//    no Enter there (one send, not two).
// A message of quotes or images alone is sent the same way: no key decision looks at the text (Composer.tsx submit decides what goes).
import type { KeyLike } from "../../platform/keys.types.ts";

export type BoxKey = Pick<KeyLike, "key" | "shiftKey"> & Partial<Pick<KeyLike, "metaKey" | "ctrlKey" | "altKey">>;

/** ⌘Enter / Ctrl+Enter, without Alt or Shift: the composer's send key. */
const sendKey = (e: BoxKey): boolean =>
  !!(e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

export type BoxState = {
  /** Esc stops the agent: it is busy on the branch shown and the chat takes changes. */
  stoppable: boolean;
};

export type BoxAction = "send" | "stop" | null;

/** What the composer does with a key given by the box. null: it leaves the key to the box (typing, a line break). */
export function boxAction(e: BoxKey, s: BoxState): BoxAction {
  if (e.key === "Enter" && sendKey(e)) return "send";
  if (e.key === "Escape" && s.stoppable) return "stop";
  return null;
}

type Mod = Pick<KeyLike, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** ⌘L / Ctrl+L: quote the selected text, else put the board's selection in (the composer's); ⌘⇧L: wait for a point on the board (the board's:
 *  screens/board/boardkeys.ts). */
export function refKey(e: Mod): "selection" | "point" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyL") return null;
  return e.shiftKey ? "point" : "selection";
}

/** ⌘Enter / Ctrl+Enter, reported by the keys port (native only: on web the box reports it, `boxAction`). */
export function sendByKey(e: Mod, os: string): boolean {
  return os !== "web" && sendKey(e) && e.code === "Enter";
}

/** The title of Send with the name of its key (`keyNames().send`), "" for none (the phone's touch Send); a title that says why Send is off
 *  stays as it is. */
export const sendTitleFor = (title: string, key: string): string => (title === "Send" && key ? `Send (${key})` : title);

/** The names of the composer's keys for titles and hints: ⌘ on a Mac and an iPad, Ctrl elsewhere. `platform` is keyplatform.ts' answer. */
export function keyNames(platform: string): { ref: string; point: string; insert: string; send: string } {
  const mac = /Mac|iPhone|iPad/.test(platform);
  return mac ? { ref: "⌘L", point: "⌘⇧L", insert: "⌘P", send: "⌘Enter" } : { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P", send: "Ctrl+Enter" };
}
