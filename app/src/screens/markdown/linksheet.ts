// The link sheet's store (ux-improvements goal 3.5): the link that was held, or none. LinkSheet.tsx shows itself from it. No React and no
// react-native here, so Node loads it (test/markdown.linksheet.test.ts).
import type { Inline } from "./doc.ts";

export type HeldLink = { text: string; href: string };

let held: HeldLink | null = null;
const listeners = new Set<() => void>();

/** The listener is called after every change of the link held; answers a function that removes it. */
export function subscribeLinkSheet(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getLinkSheet = (): HeldLink | null => held;

/** Opens the sheet for a link; a link with no words of its own is named by its address. */
export function openLinkSheet(link: HeldLink): void {
  held = { text: link.text.trim() || link.href, href: link.href };
  listeners.forEach((l) => l());
}

let liftUntil = 0;
/** The finger that held a link is lifting: for a moment a close asked by the page under it (the browser's click on the backdrop that now sits there) is no close. */
export function guardLift(ms = 300): void {
  liftUntil = Date.now() + ms;
}

/** Whether a close asked now comes from the lift of the hold that opened the sheet. */
export const liftGuarded = (): boolean => Date.now() < liftUntil;

export function closeLinkSheet(): void {
  if (!held) return;
  held = null;
  listeners.forEach((l) => l());
}

/** The words of a link as they are drawn: the sheet's title. */
export function linkText(kids: Inline[]): string {
  return kids.map((n): string => {
    switch (n.k) {
      case "text": case "code": case "indent": return n.v.replace(/[ \t\r\n]+/g, " ");
      case "br": return " ";
      case "chip": return n.ref.label + n.after;
      case "mention": return n.raw;
      case "check": return "";
      default: return linkText(n.kids);
    }
  }).join("");
}
