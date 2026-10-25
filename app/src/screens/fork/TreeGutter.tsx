// The tree lines and the marks' colours the two shapes of the chat tree draw alike (TreePopup.tsx, TreeSheet.tsx).
import { StyleSheet, View } from "react-native";

import type { RowMark } from "@aiwb/core/logic/treepopup.ts";

import { useTokens } from "../../ui/theme.tsx";
import { gutterCells } from "./treemodel.ts";

const MARK_COLOUR: Record<RowMark, "accent" | "warn" | "danger" | "muted"> = { approval: "warn", running: "accent", subs: "accent", error: "danger", stopped: "muted" };
export const markColour = (t: ReturnType<typeof useTokens>, m: RowMark): string => t[MARK_COLOUR[m]];

/** The tree lines in front of a row, drawn from its gutter ("│  ├─ "), three characters a level. `cell`: the width of a level's cell (16 on the wide
 *  layouts, a little longer on the phone's 48 pt rows). */
export function Gutter({ g, cell = 16 }: { g: string; cell?: number }) {
  const t = useTokens();
  const line = t.faint, x = Math.floor((cell - 1.5) / 2);
  return (
    <View style={styles.gutter}>
      {gutterCells(g).map((k, i) => (
        <View key={i} style={{ width: cell }}>
          {(k === "pipe" || k === "tee" || k === "elbow") && <View style={[styles.vert, { left: x, borderLeftColor: line }, k === "elbow" && styles.vertHalf]} />}
          {(k === "tee" || k === "elbow") && <View style={[styles.horiz, { left: x, borderTopColor: line }]} />}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  gutter: { flexDirection: "row", alignSelf: "stretch" },
  vert: { position: "absolute", top: 0, bottom: 0, borderLeftWidth: 1.5, opacity: 0.6 },
  vertHalf: { bottom: "50%" },
  horiz: { position: "absolute", right: 0, top: "50%", borderTopWidth: 1.5, opacity: 0.6 },
});
