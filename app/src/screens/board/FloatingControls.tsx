// The phone board's controls in landscape (package B1, plans/ux-improvements/b1-design.md §4 "Landscape"; goal 3.4): the bar and the
// bottom row become floating controls over the canvas, which fills the screen. Top left one control with the back, the board's name,
// the state word and, for a reader, **Edit here** (a labelled action); top right **Chats** with its count; bottom right the orb's
// box. They keep clear of the sides the notch and the home indicator take. BoardRoute draws them in place of the bar.
import { useContext, useEffect } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { PHONE, TYPE } from "../../ui/metrics.ts";
import { StateWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { TID, tid } from "../../ui/tid.ts";
import { NavBack } from "../shell/BackButton.tsx";
import { useSlots } from "../shell/slots.tsx";
import { EditHereButton } from "./BottomRow.tsx";
import { boardApp } from "../shell/boardside.ts";
import { floatEdges, topInsetFor } from "./floatlayout.ts";
import { B1_TID } from "./ids.ts";
import { PickBar, usePickWait } from "./PickBar.tsx";
import { ChatsButton, useBoardBarModel } from "./PhoneBoardBar.tsx";
import { ORB_INSET } from "./rowinset.ts";

const RADIUS = 12;

export function FloatingControls({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const insets = useContext(SafeAreaInsetsContext);
  const m = useBoardBarModel(board);
  const waits = !!usePickWait(board); // a chat of the board waits for a point or shapes: the pick bar floats at the bottom edge, Edit here and the orb are away
  // The view keeps its top bar below these controls: their lowest edge (in the board's coordinates: this fills the stage the canvas fills) + 8.
  // Landscape ends (this unmounts) and the inset goes with it.
  const measured = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    boardApp.setTopInset(topInsetFor(y + height));
  };
  useEffect(() => () => { boardApp.setTopInset(0); }, []);
  if (!m) return null;
  const { top, right, bottom, left } = floatEdges(insets);
  const float = { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowSm };
  return (
    <View pointerEvents="box-none" style={styles.fill}>
      <View pointerEvents="box-none" onLayout={measured} style={[styles.top, { top, paddingLeft: left, paddingRight: right }]}>
        <View {...tid(B1_TID.float)} style={[styles.left, float]}>
          <NavBack />
          <View style={styles.name} accessible accessibilityLabel={m.busy ? m.name : `${m.name}, ${m.place}`}>
            <Text {...tid(TID.barTitle)} size={TYPE.control} weight="600" numberOfLines={1} ellipsizeMode="clip" accessibilityRole="header">{m.name}</Text>
          </View>
          <StateWord word={m.word} colour={m.colour} />
          {!waits && <EditHereButton board={board} />}
        </View>
        <View style={[styles.right, float]}>
          <ChatsButton board={board} count={m.count} busy={m.busy} paint={m.paint} off={m.waits} />
        </View>
      </View>
      {waits
        ? <PickBar board={board} floating />
        : <View {...tid(B1_TID.orbSlot)} pointerEvents="box-none" style={[styles.orb, { right, bottom }]}>
            <slots.BoardOrb board={board} />
          </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 4 },
  top: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: PHONE.margin },
  left: { flexShrink: 1, minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS },
  right: { flexShrink: 0, minHeight: PHONE.target, flexDirection: "row", alignItems: "center", paddingHorizontal: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS },
  name: { flexShrink: 1, minWidth: 0 },
  orb: { position: "absolute", width: ORB_INSET, height: ORB_INSET, alignItems: "center", justifyContent: "center" },
});
