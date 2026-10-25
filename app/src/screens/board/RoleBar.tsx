// The bar over the canvas of an open board (D19), in place of the take-over panel: a reader sees the board in view mode, with what
// it is and the button that makes this window the writer ("Edit here": the only way a window becomes one); the writer sees a small
// "Editing" mark. A change dropped from this window (the board moved on meanwhile) is said in the bar, as the panel did.
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { DROPPED_TEXT } from "@aiwb/core/logic/boardsave.ts";
import { setDropped } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { boardApp } from "../shell/boardside.ts";
import { EDIT_HERE, roleBar } from "./rolebar.ts";

/** "Edit here": the board is taken, from the window or the agent that holds it. What the bar said of a dropped change is seen by then. */
export function editHere(board: string) {
  setDropped(board, false);
  void boardApp.takeBoard(board);
}

export function RoleBar({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const role = useStore((s) => s.roles[board]);
  const writer = useStore((s) => s.writers[board] ?? "");
  const dropped = useStore((s) => !!s.dropped[board]);
  const bar = roleBar(role, writer);
  if (bar.kind === "held") return (
    <View pointerEvents="none" style={styles.row}>
      <View {...tid("board-editing")} style={[styles.mark, { backgroundColor: t.bg, borderColor: t.line }]}>
        <Text size={12} tone="muted">{bar.text}</Text>
      </View>
    </View>
  );
  return (
    <View pointerEvents="box-none" style={styles.row}>
      <View {...tid("board-role", { role: role ?? "none", writer: writer || "none" })} role="status" style={[styles.bar, { backgroundColor: t.bg, borderColor: t.line }]}>
        <View style={styles.line}>
          {bar.kind === "taking" && <ActivityIndicator {...tid("board-role-spin")} size="small" color={t.accent} />}
          <Text size={13} style={styles.text}>{bar.text}</Text>
          {bar.kind !== "taking" && <Button {...tid("board-take")} tone="primary" size="sm" label={EDIT_HERE} onPress={() => editHere(board)} />}
        </View>
        {dropped && <Text {...tid("board-role-dropped")} size={12} tone="danger">{DROPPED_TEXT}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: "absolute", top: 10, left: 0, right: 0, alignItems: "center", zIndex: 4 },
  bar: { maxWidth: "92%", gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  line: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  text: { flexShrink: 1 },
  mark: { paddingVertical: 3, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1 },
});
