// The link sheet (ux-improvements goal 3.5, P1): what holding a link on the phone opens. Titled with the link's words, the address
// under them, and two rows: Open link (as a tap does) and Copy link. Always mounted in the shell's Overlays slot; it shows itself from
// linksheet.ts. `LinkText` is the link as the Markdown draws it on the phone: underlined, and held it takes the hold for itself.
import { useRef, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Text as RNText } from "react-native";
import type { GestureResponderEvent } from "react-native";

import { copyText } from "../../platform/clipboard";
import { haptic } from "../../platform/haptics";
import { openLink } from "../../platform/openlink";
import { ActionSheet } from "../../ui/ActionSheet.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { T1_TID } from "../chat/ids.ts";
import { claimHold } from "./holdclaim.ts";
import { closeLinkSheet, getLinkSheet, guardLift, liftGuarded, openLinkSheet, subscribeLinkSheet } from "./linksheet.ts";

/** The hold on a link fires before the message's own (screens/quotes/hold.ts: 500 ms), so that it can claim it. */
export const LINK_HOLD_MS = 400;
const SLOP = 10;
/** How long after a hold a click on the link is the lift of that hold, not a tap. */
const CLICK_AFTER_HOLD_MS = 1000;

export function LinkSheet() {
  const link = useSyncExternalStore(subscribeLinkSheet, getLinkSheet);
  // (kept while the sheet closes, so that its words do not vanish during the slide down)
  const last = useRef(link);
  if (link) last.current = link;
  const shown = link ?? last.current;
  if (!shown) return null;
  return (
    <ActionSheet open={!!link} onClose={() => { if (!liftGuarded()) closeLinkSheet(); }} testID={T1_TID.linkSheet} head={{ title: shown.text, sub: shown.href }}
      items={[
        { id: "open", label: "Open link", onPress: () => openLink(shown.href) },
        { id: "copy", label: "Copy link", onPress: () => { copyText(shown.href).then(() => showToast({ text: "Link copied" }), (e) => console.error(e)); } },
      ]} />
  );
}

/** A link on the phone: accent and underlined; a tap opens it (`press`, the platform's link props); a hold opens the link sheet. */
export function LinkText({ href, text, press, children }: { href: string; text: string; press: object; children: ReactNode }) {
  const t = useTokens();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const heldAt = useRef(0);
  const holding = useRef(false);
  const hold = () => {
    claimHold();
    haptic("select");
    heldAt.current = Date.now();
    holding.current = true;
    openLinkSheet({ text, href });
  };
  const style = { color: t.accent, textDecorationLine: "underline" as const };
  const stop = () => { clearTimeout(timer.current); timer.current = undefined; };
  if (Platform.OS !== "web") {
    // A Text's own long press waits 500 ms, as the message's hold does: the press-in times the 400 ms instead, and the lift of a hold
    // is no tap.
    const { onPress } = press as { onPress?: () => void };
    return (
      <RNText testID="md-link" dataSet={{ href }} style={style} {...press}
        onPressIn={() => { stop(); timer.current = setTimeout(() => { timer.current = undefined; hold(); }, LINK_HOLD_MS); }}
        onPressOut={stop}
        onPress={() => { if (Date.now() - heldAt.current >= CLICK_AFTER_HOLD_MS) onPress?.(); }}>{children}</RNText>
    );
  }
  // A page's Text has no long press: the touch events time it, and the click that follows the hold is stopped so that the link does
  // not also open in a new tab.
  const point = (e: GestureResponderEvent) => { const p = e.nativeEvent.touches?.[0] ?? e.nativeEvent; return { x: p.pageX, y: p.pageY }; };
  const webProps = {
    onTouchStart: (e: GestureResponderEvent) => {
      stop();
      holding.current = false;
      if ((e.nativeEvent.touches?.length ?? 1) > 1) return;
      from.current = point(e);
      timer.current = setTimeout(() => { timer.current = undefined; hold(); }, LINK_HOLD_MS);
    },
    onTouchMove: (e: GestureResponderEvent) => {
      if (!timer.current) return;
      const p = point(e);
      if (Math.abs(p.x - from.current.x) > SLOP || Math.abs(p.y - from.current.y) > SLOP) stop();
    },
    // (the browser sends the lift of a hold on as a click at that spot, where the sheet's backdrop now is: it must not close the sheet)
    onTouchEnd: () => { stop(); if (holding.current) { holding.current = false; guardLift(); } },
    onTouchCancel: stop,
    onClick: (e: { preventDefault(): void; stopPropagation(): void }) => {
      if (Date.now() - heldAt.current < CLICK_AFTER_HOLD_MS) { e.preventDefault(); e.stopPropagation(); }
    },
    onContextMenu: (e: { preventDefault(): void }) => { if (Date.now() - heldAt.current < CLICK_AFTER_HOLD_MS) e.preventDefault(); },
  };
  return <RNText testID="md-link" dataSet={{ href }} style={style} {...press} {...webProps}>{children}</RNText>;
}
