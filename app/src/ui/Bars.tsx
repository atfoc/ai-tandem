// The bars of the phone's screens (ux-improvements goal 3.1.1, 3.1.2): a place screen's bar (the back naming where it goes, a
// centred title, an action), a content screen's bar (the chevron alone, the title leading in two lines: the name at 17 pt, the
// place or the state at 13 pt, at most two 44 pt actions at the right), and the large title of Home and a group. A name is not cut
// to fit: the bar gives the title its room and moves actions out of its way (two lines, then a fade).
//
// Both bars are the ground `bg` with a hairline `line` under them. Their sides are 8 pt from the edge, where the 44 pt target of
// a back or an action begins; the words inside sit 16 pt from it.
//
// Contract of packages F1 (the look) and F2 (the back's wiring) (plans/ux-improvements/PLAN.md).
import { useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from "react-native";

import type { WordTone } from "@aiwb/core/logic/statewords.ts";

import { PHONE, TYPE } from "./metrics.ts";
import { wordColour } from "./StateWord.tsx";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";
import { webStyle } from "./webstyle.ts";

/** The bar of a place screen: `back` is the screen's back control (the shell's NavBack with its label). The two sides are as wide
 *  as the wider of them, so the title is in the middle of the bar whatever the back and the action hold. */
export function PlaceBar({ back, title, right, testID = TID.placeBar }: { back?: ReactNode; title: string; right?: ReactNode; testID?: string }) {
  const t = useTokens();
  const [widths, setWidths] = useState({ left: 0, right: 0 });
  const side = Math.max(widths.left, widths.right, PHONE.target);
  return (
    <View {...tid(testID)} style={[styles.bar, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
      <View style={[styles.side, { minWidth: side }]}>
        <View onLayout={(e) => { const x = e.nativeEvent.layout.width; setWidths((w) => ({ ...w, left: x })); }} style={styles.slot}>{back}</View>
      </View>
      <Text {...tid(TID.barTitle)} size={TYPE.control} weight="600" numberOfLines={1} accessibilityRole="header" style={styles.centre}>{title}</Text>
      <View style={[styles.side, styles.right, { minWidth: side }]}>
        <View onLayout={(e) => { const x = e.nativeEvent.layout.width; setWidths((w) => ({ ...w, right: x })); }} style={styles.slot}>{right}</View>
      </View>
    </View>
  );
}

export type ContentBarProps = {
  back?: ReactNode;
  /** A mark between the back and the titles (a chat's agent tile). */
  leading?: ReactNode;
  title: string;
  /** The title in the muted tone (a chat not yet named). */
  titleMuted?: boolean;
  /** The place or the state, at 13 pt. */
  sub?: string;
  subTone?: WordTone;
  /** A state word (a `StateWord`) drawn on the sub's line after the sub text; it wraps to the next line rather than being cut, and
   *  stands alone when there is no sub. */
  state?: ReactNode;
  /** A tap on the title (a chat's opens Chat info). */
  onTitlePress?(): void;
  /** At most two 44 pt actions. */
  actions?: ReactNode;
  testID?: string;
  /** The ids of the title and the sub, for a screen whose checks read them under its own names. */
  titleTestID?: string;
  subTestID?: string;
};

export function ContentBar({ back, leading, title, titleMuted, sub, subTone, state, onTitlePress, actions, testID = TID.contentBar, titleTestID = TID.barTitle, subTestID = TID.barSub }: ContentBarProps) {
  const t = useTokens();
  const subText = sub ? <Text {...tid(subTestID)} size={TYPE.secondary} numberOfLines={2} style={{ color: subTone ? wordColour(t, subTone) : t.muted }}>{sub}</Text> : null;
  return (
    <View {...tid(testID)} style={[styles.bar, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
      {back}
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <Pressable disabled={!onTitlePress} onPress={onTitlePress} accessibilityRole={onTitlePress ? "button" : "header"}
        accessibilityLabel={sub ? `${title}, ${sub}` : title} style={[styles.titles, !back && styles.titlesAlone]}>
        <BarTitle title={title} muted={titleMuted} testID={titleTestID} />
        {state ? <View style={styles.subLine}>{subText}{state}</View> : subText}
      </Pressable>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </View>
  );
}

const TITLE_LINE = Math.round(TYPE.control * 1.45 * 100) / 100;
const FADE = 40;

/** The name in a content bar: two lines, and a name that needs more is not ended with an ellipsis but fades out at the end of the
 *  second line. A copy of the name that is not drawn, free of any line limit, tells whether it needs more. */
function BarTitle({ title, muted, testID }: { title: string; muted?: boolean; testID: string }) {
  const t = useTokens();
  const [full, setFull] = useState(0);
  const cut = full > 2 * TITLE_LINE + 1;
  const clear = /^#[0-9a-f]{6}$/i.test(t.bg) ? `${t.bg}00` : "transparent";
  const gradient = `linear-gradient(to right, ${clear}, ${t.bg})`;
  const fade: ViewStyle = Platform.OS === "web" ? webStyle({ backgroundImage: gradient })! : ({ experimental_backgroundImage: gradient } as ViewStyle);
  return (
    <View>
      <Text {...tid(testID)} size={TYPE.control} weight="600" numberOfLines={2} ellipsizeMode="clip" tone={muted ? "muted" : undefined}>{title}</Text>
      <Text size={TYPE.control} weight="600" aria-hidden importantForAccessibility="no-hide-descendants" pointerEvents="none"
        onLayout={(e) => setFull(e.nativeEvent.layout.height)} style={styles.measure}>{title}</Text>
      {cut ? <View {...tid(TID.barTitleFade)} pointerEvents="none" style={[styles.fade, fade]} /> : null}
    </View>
  );
}

/** Home's and a group's large title, with the place line under it. */
export function LargeTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <View {...tid(TID.largeTitle)} style={styles.large}>
      <Text size={TYPE.largeTitle} weight="700" accessibilityRole="header">{title}</Text>
      {sub ? <Text size={TYPE.secondary} tone="muted">{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: PHONE.target + 8, flexDirection: "row", alignItems: "center", paddingHorizontal: PHONE.margin / 2, borderBottomWidth: StyleSheet.hairlineWidth },
  side: { flexShrink: 0, flexDirection: "row", alignItems: "center" },
  right: { justifyContent: "flex-end" },
  slot: { flexDirection: "row", alignItems: "center" },
  centre: { flex: 1, minWidth: 0, textAlign: "center" },
  titles: { flex: 1, minWidth: 0, paddingVertical: 4, paddingHorizontal: 4 },
  subLine: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8 },
  leading: { flexShrink: 0, marginLeft: 4 },
  titlesAlone: { paddingLeft: PHONE.margin / 2 },
  measure: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
  fade: { position: "absolute", right: 0, bottom: 0, width: FADE, height: TITLE_LINE },
  actions: { flexShrink: 0, flexDirection: "row", alignItems: "center" },
  large: { paddingHorizontal: PHONE.margin, paddingTop: 4, paddingBottom: 8 },
});
