// The Appearance screen (ux-improvements goal 3.1.4 P5, 3.8.1; package S1): a pushed place screen whose bar the stack draws. The theme
// as a checked list (Light, Dark, System), the Catppuccin flavours as a row that opens a P2 sheet with a swatch per flavour, and a
// preview that shows the chosen colours at once. The theme is one stored value; a change applies at once (`setPref`).
import { useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";

import type { Flavour } from "@aiwb/core/logic/theme.ts";

import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { BoardIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { PickerSheet } from "../../ui/PickerSheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import type { ScreenSpec } from "../shell/screens.ts";
import { flavourFooter, flavourOptions, flavourValue, swatchOf, systemFooter, themeRows } from "./appearance.ts";
import { APPEARANCE_TID } from "./appearanceids.ts";

/** A flavour's swatch: a square split in its base and its mauve. */
function Swatch({ flavour, line }: { flavour: Flavour; line: string }) {
  const [base, mauve] = swatchOf(flavour);
  return (
    <View style={[styles.swatch, { borderColor: line }]}>
      <View style={{ flex: 1, backgroundColor: base }} />
      <View style={{ flex: 1, backgroundColor: mauve }} />
    </View>
  );
}

export function AppearanceScreen() {
  const { pref, setPref, flavour, tokens: t } = useTheme();
  const [sheet, setSheet] = useState(false);
  return (
    <ScrollView {...tid(APPEARANCE_TID.screen)} style={[styles.fill, { backgroundColor: t.panel }]} contentContainerStyle={styles.body}>
      <CellGroup title="Theme" footer={systemFooter(Platform.OS === "web")}>
        {themeRows(pref).map((r) => (
          <Cell key={r.pref} testID={APPEARANCE_TID.themeRow} data={{ theme: r.pref, checked: r.checked ? "true" : "false" }}
            label={r.label} chevron={false} onPress={() => setPref(r.pref)}
            trailing={r.checked ? <Text size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text> : undefined} />
        ))}
      </CellGroup>
      <CellGroup title="Colours" footer={flavourFooter(pref)}>
        <Cell testID={APPEARANCE_TID.flavourRow} data={{ flavour: flavour ?? "off" }} label="Catppuccin flavours" value={flavourValue(pref)} onPress={() => setSheet(true)} />
      </CellGroup>
      <CellGroup title="Preview" testID={APPEARANCE_TID.preview}>
        <Cell label="Checkout flow" sub="Whiteboard · 2 chats" chevron
          leading={<View style={[styles.tile, { backgroundColor: t.accentSoft }]}><BoardIcon size={18} color={t.accent} /></View>} />
      </CellGroup>
      <PickerSheet open={sheet} onClose={() => setSheet(false)} testID={APPEARANCE_TID.flavourSheet} title="Catppuccin flavours" sub="How the app looks on this device"
        search={false} value={flavour} onPick={(f) => setPref(f)}
        options={flavourOptions().map((o) => ({ ...o, icon: <Swatch flavour={o.value} line={t.line} /> }))} />
    </ScrollView>
  );
}

export const APPEARANCE_SPEC: ScreenSpec<Record<string, never>> = { kind: "place", title: () => "Appearance", component: AppearanceScreen };

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  body: { paddingTop: 16, paddingBottom: PHONE.margin * 2 },
  tile: { width: 29, height: 29, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  swatch: { width: 24, height: 24, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexDirection: "row", overflow: "hidden" },
});
