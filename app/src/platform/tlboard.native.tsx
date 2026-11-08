// The new board's view on the phone's platforms (kind "tl", plans/better-board/design.md 6): not there yet (goal 5 keeps phones
// out of the prototype). The screen says so; the link the screen opened stays unused.
import { StyleSheet, View } from "react-native";

import { Text } from "../ui/Text.tsx";
import type { TlHostProps } from "./tlboard.types.ts";

export type { TlHostProps } from "./tlboard.types.ts";

export const TL_VIEW_ID = "tl-board-view";

export function TlHost({ testID = TL_VIEW_ID }: TlHostProps) {
  return (
    <View testID={testID} style={styles.fill}>
      <Text tone="muted" style={styles.words}>New boards are not available on this device yet.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, alignItems: "center", justifyContent: "center", padding: 24 },
  words: { textAlign: "center" },
});
