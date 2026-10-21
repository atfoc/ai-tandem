// The sidebar foot's Settings button (VC-13): the gear, between the library's button and the theme's picker, drawn as the Servers button is.
// It opens Settings > Voice (the shell's `Overlays` slot draws the dialog from the voice store's `settingsOpen`).
import { StyleSheet } from "react-native";

import { openVoiceSettings } from "../../voice/index.ts";
import { SETTINGS_BUTTON } from "../../voice/words.ts";
import { GearIcon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";

export function SettingsButton() {
  const { tokens: t } = useTheme();
  return (
    <IconButton {...tid("settings-btn")} title={SETTINGS_BUTTON} aria-haspopup="dialog" onPress={openVoiceSettings}
      style={[styles.btn, { borderColor: t.line, backgroundColor: t.bg }]}>
      {(c) => <GearIcon color={c} />}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  btn: { width: 28, height: 26, borderWidth: 1, borderRadius: 7 },
});
