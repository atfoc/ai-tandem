import { StyleSheet } from "react-native";

// The text style shared by the input and (on the web) the layer drawn behind it: the two must lay text out alike.
export const font = { fontSize: 16, lineHeight: 22, fontFamily: undefined as string | undefined };

export const colors = { text: "#1e1e2e", chipBg: "#cba6f7", chipText: "#1e1e2e", pointBg: "#89dceb", box: "#eff1f5", line: "#9ca0b0" };

export const styles = StyleSheet.create({
  chip: { backgroundColor: colors.chipBg, color: colors.chipText, fontWeight: "600" },
  point: { backgroundColor: colors.pointBg, color: colors.chipText, fontWeight: "600" },
});
