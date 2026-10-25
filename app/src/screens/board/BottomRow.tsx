// The phone board's bottom row (package B1, plans/ux-improvements/b1-design.md §4; goal 3.4): what the app puts over the right end of
// the board view's footer band: for a reader **Edit here** (a 44 pt primary button at the thumb that says **Taking over…** while it
// works), nothing for the one who holds the board, and the 64 pt box of the voice orb (V1's slot). Its measured width is the right
// inset the board view keeps free in the band (rowinset.ts). BoardCanvas draws it, on the phone only.
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { BAND_HEIGHT } from "@aiwb/board-bridge/messages.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useToastLift } from "../../ui/Toast.tsx";
import { useSlots } from "../shell/slots.tsx";
import { B1_TID } from "./ids.ts";
import { PickBar, usePickWait } from "./PickBar.tsx";
import { EDIT_HERE, TAKING } from "./rolebar.ts";
import { editHere } from "./RoleBar.tsx";
import { ORB_INSET, setRowInset } from "./rowinset.ts";

/** The gap kept between the row and what Excalidraw's footer shows to its left. */
const GAP = 8;

export function BottomRow({ board }: { board: string }) {
  const slots = useSlots();
  useToastLift(BAND_HEIGHT);
  useEffect(() => () => setRowInset(ORB_INSET), []);
  const onLayout = (e: LayoutChangeEvent) => setRowInset(e.nativeEvent.layout.width + GAP);
  // while a chat of this board waits for a point or for shapes the pick bar is the whole row (b2-design §6)
  if (usePickWait(board)) return <PickBar board={board} />;
  return (
    <View {...tid(B1_TID.row)} pointerEvents="box-none" onLayout={onLayout} style={styles.row}>
      <EditHereButton board={board} />
      <View {...tid(B1_TID.orbSlot)} pointerEvents="box-none" style={styles.orb}><slots.BoardOrb board={board} /></View>
    </View>
  );
}

/** For a reader **Edit here**, and **Taking over…** (disabled, with a spinner) while the window takes the board; nothing for the one
 *  who holds it or on an archived board. The landscape controls draw it too. */
export function EditHereButton({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const role = useStore((s) => s.roles[board]);
  const archived = useStore((s) => !!s.boards[board]?.archived);
  if (role === "held" || archived) return null;
  return role === "taking"
    ? <Button {...tid(B1_TID.take, { taking: true })} tone="primary" size="touch" disabled label={TAKING}
        icon={<ActivityIndicator {...tid("board-role-spin")} size="small" color={t.onAccent} />} />
    : <Button {...tid(B1_TID.take)} tone="primary" size="touch" label={EDIT_HERE} onPress={() => editHere(board)} />;
}

const styles = StyleSheet.create({
  row: { position: "absolute", right: 0, bottom: 0, height: BAND_HEIGHT, flexDirection: "row", alignItems: "center", zIndex: 4 },
  orb: { width: ORB_INSET, height: BAND_HEIGHT, alignItems: "center", justifyContent: "center" },
});
