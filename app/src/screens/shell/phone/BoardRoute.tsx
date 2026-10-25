// The board's route of the phone's stack: the bar (PhoneBoardBar: the back, the name, the state and Chats), and the canvas under it (the board stays mounted beneath its chat, AD-52).
// Turned to landscape the bar goes: the canvas fills the screen under the status bar's absence, with the controls floating over it (FloatingControls).
import { StatusBar } from "expo-status-bar";
import { StyleSheet, View } from "react-native";

import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { FloatingControls } from "../../board/FloatingControls.tsx";
import { useBoardLandscape } from "../../board/landscape.ts";
import { PhoneBoardBar } from "../../board/PhoneBoardBar.tsx";
import { useSlots } from "../slots.tsx";
import { useShellView } from "../useShellView.ts";

export function BoardRoute() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const view = useShellView();
  const landscape = useBoardLandscape();
  if (view.kind !== "board") return <View style={[styles.fill, { backgroundColor: t.bg }]} />;
  return (
    <View {...tid("board-stage")} style={[styles.fill, { backgroundColor: t.bg }]}>
      {landscape ? <StatusBar hidden /> : <PhoneBoardBar board={view.board} />}
      <View style={styles.fill}><slots.Canvas board={view.board} /></View>
      {landscape ? <FloatingControls board={view.board} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
