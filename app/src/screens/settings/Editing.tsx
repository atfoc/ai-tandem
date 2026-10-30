// Settings > Composer on the phone: a pushed place screen whose bar the stack draws. What Tab puts in and the tab width, each as a
// checked list like Appearance's theme; a change applies at once to every composer (state/editing.ts). The wide layouts show the
// same choices as a section of the Settings dialog (EditingSection.tsx).
import { Platform, ScrollView, StyleSheet } from "react-native";

import { setEditingSettings, useEditingSettings } from "../../state/editing.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import type { ScreenSpec } from "../shell/screens.ts";
import { keyPlatform } from "../shell/keyplatform.ts";
import { EDITING_TITLE, TAB_INSERTS_OPTIONS, TAB_INSERTS_TITLE, TAB_WIDTH_OPTIONS, TAB_WIDTH_TITLE, editingFooter } from "./editing.ts";
import { EDITING_TID } from "./editingids.ts";

const Check = () => <Text size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text>;

export function EditingScreen() {
  const { tokens: t } = useTheme();
  const s = useEditingSettings();
  return (
    <ScrollView {...tid(EDITING_TID.screen)} style={[styles.fill, { backgroundColor: t.panel }]} contentContainerStyle={styles.body}>
      <CellGroup title={TAB_INSERTS_TITLE}>
        {TAB_INSERTS_OPTIONS.map((o) => {
          const on = o.value === s.tabInserts;
          return <Cell key={o.value} testID={EDITING_TID.insertsRow} data={{ value: o.value, checked: on ? "true" : "false" }} label={o.label} chevron={false}
            onPress={() => setEditingSettings({ tabInserts: o.value })} trailing={on ? <Check /> : undefined} />;
        })}
      </CellGroup>
      <CellGroup title={TAB_WIDTH_TITLE} footer={editingFooter(keyPlatform(), Platform.OS === "web")}>
        {TAB_WIDTH_OPTIONS.map((o) => {
          const on = o.value === s.tabWidth;
          return <Cell key={o.value} testID={EDITING_TID.widthRow} data={{ value: String(o.value), checked: on ? "true" : "false" }} label={o.label} chevron={false}
            onPress={() => setEditingSettings({ tabWidth: o.value })} trailing={on ? <Check /> : undefined} />;
        })}
      </CellGroup>
    </ScrollView>
  );
}

export const EDITING_SPEC: ScreenSpec<Record<string, never>> = { kind: "place", title: () => EDITING_TITLE, component: EditingScreen };

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  body: { paddingTop: 16, paddingBottom: PHONE.margin * 2 },
});
