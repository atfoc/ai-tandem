// Settings › Claude accounts on the wide layouts: a section of the Settings dialog (screens/voice/SettingsDialog.tsx) with the row's line
// (how many accounts, what needs a restart) and a button that opens the "Claude accounts" dialog in the Settings dialog's place.
import { StyleSheet, View } from "react-native";

import { SCREEN_WORDS, accountSections } from "@aiwb/core/logic/aliases.ts";

import { useStore } from "../../../state/useStore.ts";
import { closeVoiceSettings } from "../../../voice/index.ts";
import { Button } from "../../../ui/Button.tsx";
import { Text } from "../../../ui/Text.tsx";
import { tid } from "../../../ui/tid.ts";
import { Section } from "../../voice/SettingsParts.tsx";
import { ACCOUNTS_TID } from "./ids.ts";
import { accountsRowLine } from "./model.ts";
import { openAccountsList } from "./open.ts";

export function AccountsSettingsSection() {
  const servers = useStore((s) => s.servers), lists = useStore((s) => s.aliases);
  const line = accountsRowLine(accountSections(servers, lists).map((s) => s.list));
  return (
    <>
      <View style={styles.head}>
        <Text size={12} weight="600" tone="accent" style={styles.caps}>{SCREEN_WORDS.settingsRow}</Text>
      </View>
      <Section title={SCREEN_WORDS.title} note={line.text} testID="settings-accounts-section">
        <Button size="sm" label={`${SCREEN_WORDS.settingsRow}…`} testID={ACCOUNTS_TID.settingsOpen} aria-haspopup="dialog"
          onPress={() => { closeVoiceSettings(); openAccountsList(); }} />
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 18 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
});
