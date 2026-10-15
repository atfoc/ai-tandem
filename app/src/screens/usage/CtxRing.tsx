// The ring with "used / window pct%" (the old page's Composer.tsx CtxRing, `.ctx-meter`): the composer's meter, and each subagent's. With `onPress` it is a
// button (the composer's, which opens the usage popup); without, a view with a hover title (each subagent's).
// ringOnly: the text is not seen, but it is drawn, in an element of its own (the composer's meter in a toolbar with no room for it): the
// meter is as wide as its ring, a script still reads the text as the meter's (testID ctx-text), and the title says it.
import { Pressable, StyleSheet, View, type TextStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";

import { WarnIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { ctxShare, ctxText, ctxTitle, fmtK, ringOf } from "./meter.ts";

const R = 6, CIRC = 2 * Math.PI * R;
const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };
/** The text that is drawn and not seen: one point, clipped away (the old `.ctx-meter.compact .ctx-text`). */
const HIDDEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", ...webStyle({ clipPath: "inset(50%)" }) } as const;

export type CtxRingProps = {
  used: number;
  win: number;
  title?: string;
  /** The popup is open: the button has the panel's ground. */
  open?: boolean;
  onPress?: () => void;
  ringOnly?: boolean;
  /** Smaller print and no padding, as in a subagent's row. */
  sub?: boolean;
  testID?: string;
};

export function CtxRing({ used, win, title, open, onPress, ringOnly = false, sub = false, testID = "ctx-meter" }: CtxRingProps) {
  const t = useTokens();
  const { pct, tone } = ringOf(used, win);
  const cut = ringOnly && !!used;
  const label = title ?? (cut ? ctxTitle(used, win) : undefined);
  const ref = useControlRef(label);
  const stroke = tone === "danger" ? t.danger : tone === "warn" ? t.warn : t.accent;
  // (the page's text is one flex item and the share another, which the row's gap of 5 and the share's own 3-point margin set apart: 8 points, as
  // the old meter had it; a space between them in one text is 3)
  const text = used ? (
    <View style={styles.words}>
      <Text size={sub ? 13 : 11.5} tone="muted" numberOfLines={1} style={TABULAR}>{fmtK(used)}{win ? ` / ${fmtK(win)}` : ""}</Text>
      {win ? <Text size={sub ? 13 : 11.5} tone="faint" numberOfLines={1} style={[TABULAR, styles.share]}>{ctxShare(used, win)}</Text> : null}
    </View>
  ) : null;
  const body = (hovered: boolean) => (
    <View style={[styles.meter, sub ? styles.sub : styles.pad, onPress && styles.button, onPress && (hovered || open) && { backgroundColor: t.panel }]}>
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle cx={8} cy={8} r={R} fill="none" stroke={t.line2} strokeWidth={2.2} />
        <Circle cx={8} cy={8} r={R} fill="none" stroke={stroke} strokeWidth={2.2} strokeLinecap="round"
          strokeDasharray={`${CIRC * pct} ${CIRC}`} rotation={-90} origin="8, 8" />
      </Svg>
      {cut ? <View style={HIDDEN} {...tid("ctx-text")}>{text}</View> : text}
    </View>
  );
  const data = tid(testID, { tone, compact: cut || undefined, used, win });
  if (onPress) return (
    <Pressable ref={ref} {...data} role="button" aria-expanded={!!open} accessibilityLabel={label ?? (used ? ctxText(used, win) : "Context")}
      onPress={onPress} style={webStyle({ cursor: "pointer", outline: "none" })}>
      {({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => body(!!hovered || pressed)}
    </Pressable>
  );
  return <View ref={ref} {...data} accessibilityLabel={label}>{body(false)}</View>;
}

/** The meter that says why the context is not known: a warning icon and "Context unavailable", the reason as its title. ringOnly: the icon alone
 *  is seen. */
export function CtxError({ reason, ringOnly = false, testID = "ctx-meter" }: { reason: string; ringOnly?: boolean; testID?: string }) {
  const t = useTokens();
  const ref = useControlRef(reason);
  const words = <Text size={11.5} tone="warn" numberOfLines={1}>Context unavailable</Text>;
  return (
    <View ref={ref} {...tid(testID, { tone: "error", compact: ringOnly || undefined, error: true })} accessibilityLabel={reason}>
      <View style={[styles.meter, styles.pad, { gap: 4 }]}>
        <WarnIcon color={t.warn} />
        {ringOnly ? <View style={HIDDEN} {...tid("ctx-text")}>{words}</View> : words}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { flexDirection: "row", alignItems: "center", gap: 5 },
  pad: { paddingHorizontal: 6 },
  sub: { padding: 0 },
  button: { height: 24, borderRadius: 6 },
  words: { flexDirection: "row", alignItems: "center", gap: 5 },
  share: { marginLeft: 3 },
});
