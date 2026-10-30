// Settings > Composer on the wide layouts: a section of the Settings dialog (screens/voice/SettingsDialog.tsx), under Voice, with the
// same two choices as the phone's screen (Editing.tsx), drawn with the dialog's own parts.
import { Platform, StyleSheet, View } from "react-native";

import { setEditingSettings, useEditingSettings } from "../../state/editing.ts";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { keyPlatform } from "../shell/keyplatform.ts";
import { Choice, Row, Section } from "../voice/SettingsParts.tsx";
import { EDITING_TITLE, INDENT_TITLE, TAB_INSERTS_OPTIONS, TAB_INSERTS_TITLE, TAB_WIDTH_OPTIONS, TAB_WIDTH_TITLE, editingFooter } from "./editing.ts";
import { EDITING_TID } from "./editingids.ts";

const WIDTHS = TAB_WIDTH_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }));

export function EditingSection() {
  const s = useEditingSettings();
  return (
    <>
      <View style={styles.head}>
        <Text size={12} weight="600" tone="accent" style={styles.caps}>{EDITING_TITLE}</Text>
      </View>
      <Section title={INDENT_TITLE} note={editingFooter(keyPlatform(), Platform.OS === "web")} testID={EDITING_TID.section}>
        <Row label={TAB_INSERTS_TITLE}>
          <Choice label={TAB_INSERTS_TITLE} value={s.tabInserts} options={TAB_INSERTS_OPTIONS} onChange={(v) => setEditingSettings({ tabInserts: v })} testID={EDITING_TID.inserts} />
        </Row>
        <Row label={TAB_WIDTH_TITLE}>
          <Choice label={TAB_WIDTH_TITLE} value={String(s.tabWidth)} options={WIDTHS}
            onChange={(v) => setEditingSettings({ tabWidth: Number(v) as typeof s.tabWidth })} testID={EDITING_TID.width} />
        </Row>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 18 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
});
