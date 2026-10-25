// The "Microphone and speaker" card of Settings > Voice (voice-devices VD-17, goal 3.1, 3.2, 3.4): a Microphone row and a Speaker row, each a picker
// (System default first, then what the system reports, a saved device that is not there shown as "(not connected)") or, where the platform
// decides, the line that says so; Test microphone with a live level meter (VD-16) and Test speaker (VD-15). What it lists comes from the engine's
// `useDeviceChoices()` (it lists while the card is mounted and again when a device comes or goes); a pick is a voice setting (`mic`, `speaker`), kept on
// this device and read by every session. The card is made of the parts of the other sections (`Section`, `Row`, `Picker`, `Button`) and the pill's
// `Waveform`; a preview, Test speaker or Test microphone that fell back to the system default says so in `SettingsNotice` (goal 4.5); with no key saved the
// card lists nothing and says so (goal 6.6); the microphone test is the engine's, and a refusal hangs the same problem popover from the button as Dictate does.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { setVoiceSettings, useDeviceChoices, useMicTest, voice } from "../../voice/index.ts";
import type { DeviceChoices } from "../../voice/index.ts";
import { DEVICES_HIDDEN_NOTE, DEVICES_NO_KEY, DEVICES_LINKED_NOTE, DEVICES_MIC, DEVICES_SPEAKER, DEVICES_TITLE, MIC_TEST, MIC_TEST_BUSY, MIC_TEST_END, SPEAKER_TEST } from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { Waveform } from "./pill/Waveform.tsx";
import { ProblemPopover } from "./ProblemPopover.tsx";
import { Picker, Row, Section } from "./SettingsParts.tsx";
import { SettingsNotice } from "./VoiceNotice.tsx";

/** One kind's choice, as `choicesFor` answers it. */
type DeviceChoice = DeviceChoices["mic"];

/** The id the microphone test gives the engine: the problem popover of a refused microphone hangs from the test button. */
const MIC_TEST_ANCHOR = "mictest";

/** The card. Before a key is saved voice is not set up (goal 6.6): the card says so, as the voices' section does, and lists nothing (it does not mount the
 *  hook that lists, so no `enumerateDevices` and no native listing happen). While the keystore has not answered yet it shows its title only. */
export function DevicesSection({ hasKey }: { hasKey: boolean | null }) {
  if (hasKey === true) return <DevicesCard />;
  return (
    <Section title={DEVICES_TITLE} testID="vs-devices-section">
      {hasKey === false ? <Text {...tid("vs-devices-nokey")} size={12} tone="muted">{DEVICES_NO_KEY}</Text> : null}
    </Section>
  );
}

function DevicesCard() {
  const choices = useDeviceChoices();
  // The test the card started ends with the card (the engine ends it when Settings closes, too).
  useEffect(() => () => voice.stopMicTest(), []);

  if (choices.neitherLine) {
    return (
      <Section title={DEVICES_TITLE} testID="vs-devices-section">
        <Text {...tid("vs-devices-neither")} size={12} tone="muted">{choices.neitherLine}</Text>
      </Section>
    );
  }
  const hidden = (c: DeviceChoice) => c.show === "pick" && c.hiddenNote;
  const note = [choices.linkedNote ? DEVICES_LINKED_NOTE : null, hidden(choices.mic) || hidden(choices.speaker) ? DEVICES_HIDDEN_NOTE : null].filter(Boolean).join(" ");
  return (
    <Section title={DEVICES_TITLE} testID="vs-devices-section">
      <View style={styles.groups}>
        <SettingsNotice />
        {note ? <Text {...tid("vs-devices-note")} size={12} tone="muted" style={styles.note}>{note}</Text> : null}
        <DeviceRow label={DEVICES_MIC} choice={choices.mic} testID="vs-mic" onPick={(device) => setVoiceSettings({ mic: device })}>
          <MicTest />
        </DeviceRow>
        <DeviceRow label={DEVICES_SPEAKER} choice={choices.speaker} testID="vs-speaker" onPick={(device) => setVoiceSettings({ speaker: device })}>
          <SpeakerTest />
        </DeviceRow>
      </View>
    </Section>
  );
}

/** One kind of device: its picker with the check under it, or the line that says the system decides (the check stays). */
function DeviceRow({ label, choice, testID, onPick, children }: {
  label: string; choice: DeviceChoice; testID: string; onPick(device: { id: string; name: string } | null): void; children: ReactNode;
}) {
  if (choice.show === "system") {
    return (
      <View style={styles.follows}>
        <Text size={12.5}>{label}</Text>
        <Text {...tid(`${testID}-system`)} size={12} tone="muted">{choice.line}</Text>
        {children}
      </View>
    );
  }
  const selected = choice.options.find((o) => o.key === choice.selected) ?? choice.options[0];
  return (
    <Row label={label}>
      <View style={styles.controls}>
        <Picker label={label} value={selected.key} options={choice.options.map((o) => ({ value: o.key, label: o.label }))} shown={selected.label}
          onChange={(key) => onPick(choice.options.find((o) => o.key === key)?.device ?? null)} testID={testID} />
        {children}
      </View>
    </Row>
  );
}

/** Test microphone (VD-16): a toggle that shows the level of the chosen microphone as the pill's waveform. Nothing is sent anywhere; it is off while a voice session listens. */
function MicTest() {
  const test = useMicTest();
  const ref = useRef<View>(null);
  // The loudest the meter has shown in this test, for a check to read (the waveform itself keeps only the last moments).
  const [peak, setPeak] = useState(0);
  useEffect(() => { setPeak((p) => (test.on ? Math.max(p, test.level) : 0)); }, [test.on, test.level]);
  const busy = test.busy && !test.on;
  return (
    <View style={styles.test}>
      <View ref={ref} collapsable={false}>
        <Button size="sm" label={test.on ? MIC_TEST_END : MIC_TEST} accessibilityLabel={test.on ? MIC_TEST_END : MIC_TEST} title={busy ? MIC_TEST_BUSY : undefined}
          {...tid("vs-mic-test", { on: test.on, busy })} aria-pressed={test.on} disabled={busy}
          onPress={() => { if (test.on) voice.stopMicTest(); else void voice.startMicTest(MIC_TEST_ANCHOR); }} />
        <ProblemPopover anchor={MIC_TEST_ANCHOR} target={ref} align="left" />
      </View>
      {test.on ? (
        <View {...tid("vs-mic-level", { level: Math.round(test.level * 100), peak: Math.round(peak * 100) })}><Waveform level={test.level} /></View>
      ) : null}
    </View>
  );
}

/** Test speaker (VD-15): a short chime the app makes, played through the chosen speaker. It asks the voice service for nothing. */
function SpeakerTest() {
  const [playing, setPlaying] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const play = () => {
    setPlaying(true);
    void voice.testSpeaker().finally(() => { if (live.current) setPlaying(false); });
  };
  return (
    <View style={styles.test}>
      <Button size="sm" label={SPEAKER_TEST} {...tid("vs-speaker-test", { playing })} onPress={play} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Where the card's title has a note, the note sits where a section's own note would (just under the title).
  note: { marginTop: -6 },
  groups: { gap: 16 },
  controls: { gap: 6, alignItems: "flex-start" },
  follows: { gap: 4 },
  test: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 },
});
