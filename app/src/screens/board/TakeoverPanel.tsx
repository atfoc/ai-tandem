// The panel shown in place of one board's canvas while this window does not hold the board: another window holds it, or took
// it, or is handing it over. The rest of the window (the sidebar, the board's chats, every other board) stays in use
// (the old page's TakeoverPanel.tsx).
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { DROPPED_TEXT, serverNameOf, takeoverText } from "@aiwb/core/logic/boardsave.ts";
import { inSection } from "@aiwb/core/logic/keys.ts";
import type { BoardRole } from "@aiwb/core/logic/roles.ts";
import { setDropped } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { boardApp } from "../shell/boardside.ts";
import { FILL } from "./fill.ts";

/** "Use here": the board is taken from the window that holds it. What the panel said of a dropped change is seen by then. */
function useHere(board: string) {
  setDropped(board, false);
  void boardApp.takeBoard(board);
}

export function TakeoverPanel({ board, role, dropped }: { board: string; role: Exclude<BoardRole, "held">; dropped: boolean }) {
  const { tokens: t } = useTheme();
  const name = useStore((s) => serverNameOf(board, s.servers));
  if (role === "taking") return (
    <View {...tid("takeover-panel", { role })} style={styles.panel}>
      <ActivityIndicator {...tid("takeover-spin")} size="small" color={t.accent} />
      <Text tone="muted">Taking over from the other window…</Text>
    </View>
  );
  const text = takeoverText(inSection(board), name);
  return (
    <View {...tid("takeover-panel", { role })} style={styles.panel}>
      <Text size={18} weight="600" accessibilityRole="header" style={styles.title}>{text.title}</Text>
      <Text tone="muted" style={styles.body}>{text.body}</Text>
      {dropped && <Text {...tid("takeover-dropped")} tone="danger" style={styles.body}>{DROPPED_TEXT}</Text>}
      <Button {...tid("takeover-use-here")} tone="primary" label="Use here" onPress={() => useHere(board)} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { ...FILL, alignItems: "center", justifyContent: "center", gap: 10, padding: 40 },
  title: { marginTop: 4, textAlign: "center" },
  body: { maxWidth: 380, textAlign: "center", marginBottom: 6 },
});
