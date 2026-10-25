// The composer's keys, as decisions over plain values (the old page's Composer.tsx onKeyDown and the window handler for ⌘L / ⌘⇧L). No React and
// no react-native here, so Node loads it and test/composer.test.ts holds it.
//
// ENTER (package K3's decision for the native boxes, the rows are C-TX-03; ux-improvements goal 3.6 for the phone). The rule is decided by the
// input, not the OS: touch with no hardware keyboard, Return adds a line and only the button sends; a hardware keyboard on a phone or a tablet,
// Return adds a line and ⌘Enter / Ctrl+Enter send; the wide layout with a fine pointer (desktop, Electron), Enter sends. The box reports a key to
// the composer's `onKey` (AD-60):
//  - web, tablet and desktop layouts: the browser's keydown. Enter sends, Shift+Enter is a line break, Enter while an input method composes is
//    neither (the box does not give a key typed during a composition). That is today's behaviour, unchanged.
//  - web at the phone layout: Enter is a line break, Shift+Enter too, and ⌘Enter / Ctrl+Enter send (`enterSends(os, phone)`, `modEnterSends`
//    in BoxState). A browser at the phone layout has no way to tell a soft keyboard from a hardware one, so it gets the touch rule.
//  - iOS and Android: `onKeyPress` reports the key without its modifiers, and the soft keyboard's return key reports the very same
//    "Enter" as a hardware keyboard's, so the composer cannot tell the two apart, nor Shift+Enter from Enter. C-TX-03's note for touch
//    is that the return key is a line break and Send is the button. So on native **Enter is a line break, whatever the keyboard**, and
//    the composer's `onKey` takes no Enter there (the box then keeps the new line it was given). A hardware keyboard sends with
//    **⌘Enter** (iPad) or **Ctrl+Enter** (Android), which the keys port reports (AD-73: aiwb-keys' mod+Enter, the one the library's edit
//    form already uses to save): `sendByKey` below. [not verified on a device]
//  - the @ list: on the phone a tap picks and Return adds a line (BoxState.phone); the arrows and Tab still move and pick on a hardware keyboard.
import type { KeyLike } from "../../platform/keys.types.ts";

export type BoxKey = Pick<KeyLike, "key" | "shiftKey"> & Partial<Pick<KeyLike, "metaKey" | "ctrlKey" | "altKey">>;

/** Whether a plain Enter in the box sends the message: on web at the wide layouts, not on the native boxes nor at the phone layout (see above). */
export const enterSends = (os: string, phone = false): boolean => os === "web" && !phone;

/** Whether ⌘Enter / Ctrl+Enter, given to the box itself, sends: on web at the phone layout, where a plain Enter is a line break. (The native
 *  boxes get it from the keys port: `sendByKey`; the wide web layouts send with Enter.) */
export const modEnterSends = (os: string, phone: boolean): boolean => os === "web" && phone;

export type BoxState = {
  /** The @ list is open and has options. */
  mention: boolean;
  /** Enter sends (enterSends). */
  enterSends: boolean;
  /** ⌘Enter / Ctrl+Enter, given to the box, send (modEnterSends). Without it, they are left to the box. */
  modEnterSends?: boolean;
  /** The phone layout: a tap picks from the @ list, so Enter does not pick, it is a line break (or, with `modEnterSends`, ⌘Enter sends). */
  phone?: boolean;
  /** Esc stops the agent: it is busy on the branch shown and the chat takes changes. */
  stoppable: boolean;
};

export type BoxAction = "next" | "prev" | "pick" | "close" | "send" | "stop" | null;

/** What the composer does with a key given by the box. null: it leaves the key to the box (typing, a line break). */
export function boxAction(e: BoxKey, s: BoxState): BoxAction {
  if (s.mention) {
    if (e.key === "ArrowDown") return "next";
    if (e.key === "ArrowUp") return "prev";
    if ((e.key === "Enter" && !s.phone) || e.key === "Tab") return "pick";
    if (e.key === "Escape") return "close";
  }
  if (e.key === "Enter" && s.modEnterSends && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) return "send";
  if (e.key === "Enter" && !e.shiftKey && s.enterSends) return "send";
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

/** ⌘Enter / Ctrl+Enter, reported by the keys port (native only: on web Enter itself sends). */
export function sendByKey(e: Mod, os: string): boolean {
  return os !== "web" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "Enter";
}

/** The title of Send without the name of a key where Enter does not send (the native boxes: a line break is Enter there). */
export const sendTitleFor = (title: string, enters: boolean): string => (enters ? title : title.replace(" (Enter)", ""));

/** The names of the composer's keys for titles and hints: ⌘ on a Mac and an iPad, Ctrl elsewhere. `platform` is keyplatform.ts' answer. */
export function keyNames(platform: string): { ref: string; point: string; insert: string } {
  const mac = /Mac|iPhone|iPad/.test(platform);
  return mac ? { ref: "⌘L", point: "⌘⇧L", insert: "⌘P" } : { ref: "Ctrl+L", point: "Ctrl+Shift+L", insert: "Ctrl+P" };
}
