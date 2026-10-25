// The head of a sheet (ux-improvements goal 3.1.4, 4.3): every sheet says what it is about. A title, a sub-line under it, an
// optional leading item (a P1 sheet's tile of the thing acted on) and up to two text actions at its ends ("Cancel · Title · Save"
// of a P3, "Done" of a P2 with several controls, "Cancel" of a flow). Given to a Sheet as its `head` it is drawn above the scroll
// view and stays while the content scrolls; a hairline under it parts it from the content.
//
// Without `leading` the title is centred, and stays centred whatever the actions at its ends are (both ends take the same room);
// with it the head is aligned to the start: the tile, then the title over the sub-line, then the right action. Its words sit
// 16 pt from the screen's edge (the sheet's own side padding is 8). Actions are 17 pt accent text with a 44 pt target.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { PHONE, TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

/** A text action at an end of the head. `strong`: the committing one (Save, Done), in the accent and bold. */
export type HeadAction = { label: string; onPress(): void; disabled?: boolean; strong?: boolean; testID?: string };

export type SheetHeadProps = {
  title: string;
  /** What is chosen and for what (P2), the place and server (P3 rename), "type · place · model" (P1). */
  sub?: string;
  /** Before the title: a P1 sheet's icon tile. With it the head is aligned to the start; without, centred. */
  leading?: ReactNode;
  left?: HeadAction;
  right?: HeadAction;
  /** The sub-line's testID where a screen's checks know it by another name than `sheet-sub`. */
  subTestID?: string;
};

export function SheetHead({ title, sub, leading, left, right, subTestID = TID.sheetSub }: SheetHeadProps) {
  const t = useTokens();
  const centred = !leading;
  const words = (
    <View style={[styles.words, centred && styles.wordsCentred]}>
      <Text {...tid(TID.sheetTitle)} size={TYPE.control} weight="600" accessibilityRole="header" numberOfLines={2} style={centred ? styles.textCentred : undefined}>{title}</Text>
      {sub ? <Text {...tid(subTestID)} size={TYPE.secondary} tone="muted" numberOfLines={2} style={centred ? styles.textCentred : undefined}>{sub}</Text> : null}
    </View>
  );
  return (
    <View {...tid(TID.sheetHead)} style={[styles.head, { borderBottomColor: t.line }]}>
      {centred ? (
        <>
          {left || right ? <View style={[styles.end, styles.start]}>{left ? <HeadButton a={left} id={TID.sheetLeft} /> : null}</View> : null}
          {words}
          {left || right ? <View style={[styles.end, styles.finish]}>{right ? <HeadButton a={right} id={TID.sheetRight} /> : null}</View> : null}
        </>
      ) : (
        <>
          {left ? <HeadButton a={left} id={TID.sheetLeft} /> : null}
          {leading}
          {words}
          {right ? <HeadButton a={right} id={TID.sheetRight} /> : null}
        </>
      )}
    </View>
  );
}

function HeadButton({ a, id }: { a: HeadAction; id: string }) {
  return (
    <Pressable testID={a.testID ?? id} accessibilityRole="button" accessibilityLabel={a.label} disabled={a.disabled}
      accessibilityState={{ disabled: !!a.disabled }} aria-disabled={a.disabled || undefined} onPress={a.onPress}
      style={[styles.action, a.disabled && styles.off]}>
      <Text size={TYPE.control} tone="accent" weight={a.strong ? "600" : undefined} numberOfLines={1}>{a.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, minHeight: PHONE.target, paddingHorizontal: PHONE.margin - 8, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  words: { flexShrink: 1, flexGrow: 1, minWidth: 0 },
  wordsCentred: { flexGrow: 0, alignItems: "center" },
  textCentred: { textAlign: "center" },
  // the two ends of a centred head share what is left over equally, so that the title is in the middle whatever the actions say
  end: { flexGrow: 1, flexBasis: 0, minWidth: PHONE.target, flexDirection: "row" },
  start: { justifyContent: "flex-start" },
  finish: { justifyContent: "flex-end" },
  action: { minWidth: PHONE.target, minHeight: PHONE.target, justifyContent: "center" },
  off: { opacity: 0.4 },
});
