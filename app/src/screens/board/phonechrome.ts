// The chrome the phone's board screen asks of the board view (package B1, b1-design.md §1 and §4): the board's name on the menu, the
// band's ground and hairline in the app's colours, the inset the bottom row measured. No React Native here, so Node loads it.
import type { PhoneChromeMsg } from "@aiwb/board-bridge/messages.ts";

/** `#rrggbb` of a colour that is `#rgb` or `#rrggbb` (any case); `fallback` for anything else (the bridge refuses other forms). */
export function hex6(c: string, fallback: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return fallback;
  const h = m[1]!.toLowerCase();
  return "#" + (h.length === 3 ? [...h].map((x) => x + x).join("") : h);
}

/** The chrome for the board screen in portrait on the phone; null where the view keeps Excalidraw's own (landscape, the wide layouts). */
export function phoneChrome(o: {
  phone: boolean; landscape: boolean; name: string; inset: number; band: string; line: string; share: boolean;
}): PhoneChromeMsg | null {
  if (!o.phone || o.landscape) return null;
  return {
    title: o.name.slice(0, 200),
    inset: Math.min(400, Math.max(0, Math.round(o.inset))),
    band: hex6(o.band, "#ffffff"),
    line: hex6(o.line, "#e7e7ec"),
    share: o.share,
  };
}
