// The phone's back (AD-71): a chevron turned to the left (`nav-back`). It sets the store with the screen on top gone, never the stack itself.
// It stands in the bar of a screen of the stack: the board's bar, the chat's own header (S8: one bar for a chat, with its title and
// controls), the drawer's bar.
import { StyleSheet, View } from "react-native";

import { getState, setState } from "@aiwb/core/state/store.ts";

import { IconButton } from "../../ui/IconButton.tsx";
import { Chevron } from "../../ui/icons.tsx";
import { tid } from "../../ui/tid.ts";
import { awayNow, pickPoint } from "../board/refs.ts";
import { select } from "./nav.ts";
import { backFrom, stackOf } from "./stack.ts";

/** A back from the screen on top: the store with that screen gone (the drawer closed). While the phone waits for a point on the board, the
 *  board is the screen on top and its back ends the wait, with the chat opened again and nothing added to it (board/refs.ts). */
export function goBack(): void {
  if (awayNow()) return pickPoint(null);
  const r = backFrom(stackOf(getState()), getState().sel);
  if (!r) return;
  if ("closeDrawer" in r) setState({ subDrawer: null }); else select(r.sel);
}

/** The control that goes back (`nav-back`): a chevron turned to the left, in the bar of the screen. */
export function BackButton() {
  return (
    <IconButton {...tid("nav-back")} title="Back" onPress={goBack}>
      {(color) => <View style={styles.back}><Chevron size={12} color={color} /></View>}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  back: { transform: [{ rotate: "180deg" }] },
});
