// The voice notice (voice devices VD-14, goal 4.5): the one sentence above the composer's box, the speech bar or the archived bar when a device
// the person chose was missing at the start, went away during a session, or Read aloud is paused. It is `ModelNotice`'s line (Text 11.5, tone
// `warn`, the same place), drawn by the composer part `VoiceNotice`. The engine decides what it says and for how long (the sentence fades by
// itself); nothing here needs a tap. It is empty at rest. The same line stands in the devices card of Settings > Voice (`SettingsNotice`, testID
// `vs-devices-notice`) for a preview, Test speaker or Test microphone that fell back to the system default.
import { StyleSheet } from "react-native";

import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { useVoiceNotice } from "../../voice/index.ts";

function NoticeLine({ text, testID }: { text: string; testID: string }) {
  return <Text {...tid(testID)} size={11.5} tone="warn" style={styles.notice} accessibilityLiveRegion="polite">{text}</Text>;
}

export function VoiceNotice({ chatId }: { chatId: string }) {
  const text = useVoiceNotice({ kind: "chat", chat: chatId });
  return text ? <NoticeLine text={text} testID="voice-notice" /> : null;
}

/** The notice of Settings > Voice's devices card: the same line, drawn inside the card. */
export function SettingsNotice() {
  const text = useVoiceNotice({ kind: "settings" });
  return text ? <NoticeLine text={text} testID="vs-devices-notice" /> : null;
}

const styles = StyleSheet.create({
  notice: { marginBottom: 6, paddingHorizontal: 2 },
});
