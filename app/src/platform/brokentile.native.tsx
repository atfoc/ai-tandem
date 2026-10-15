// The tile for a picture that cannot be had, on iOS and Android: its name in a box with a dashed edge (the page's `.img-thumb.broken`).
import { StyleSheet, View, type ImageStyle, type StyleProp } from "react-native";

import { Text } from "../ui/Text.tsx";
import { useTheme } from "../ui/theme.tsx";
import { TID } from "../ui/tid.ts";

export function BrokenPicture({ name, style, lines = 4 }: { name?: string; style?: StyleProp<ImageStyle>; lines?: number }) {
  const { tokens: t } = useTheme();
  return (
    <View testID={TID.picture} dataSet={{ state: "broken" }} role="img" aria-label={name || "Image"}
      style={[styles.tile, { borderColor: t.line2, backgroundColor: t.bg }, style as never]}>
      <Text size={11} tone="muted" numberOfLines={lines} style={styles.name}>{name ?? ""}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderStyle: "dashed", borderRadius: 6, padding: 4, alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: 40, minHeight: 40 },
  name: { textAlign: "center" },
});
