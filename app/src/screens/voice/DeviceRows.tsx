// The Microphone and Speaker rows of Advanced on the phone (S3 chunk 4, goal 3.8.5, voice-devices goal 3.1, 3.2, 3.4, 4.5). The cells show the saved
// choice by name, or "System default", from the settings and the platform's ability alone: they list no device. A tap opens a P2 sheet that lists
// (`useDeviceChoices` is mounted by the sheet's body, so it lists only while the sheet is open and again when a device comes or goes): System default
// first, the devices, a saved one that is gone "(not connected)"; a pick is a voice setting (`mic`, `speaker`). The sheet's extra holds the notes and
// the test (Test microphone with the level meter, Test speaker); a refused microphone is said there as a line with its action, never as a popover
// (no sheet over a sheet), and the devices notice of Settings shows there too. Where the platform decides for a kind the cell says "System" and its
// sheet says the line; with neither kind choosable the two rows are one plain cell. Closing the sheet stops a microphone test.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { setVoiceSettings, useDeviceChoices, useMicTest, useVoiceProblem, useVoiceSettings, voice } from "../../voice/index.ts";
import { voicePorts } from "../../voice/ports.ts";
import {
  DEVICES_HIDDEN_NOTE, DEVICES_LINKED_NOTE, DEVICES_MIC, DEVICES_SPEAKER, MIC_TEST, MIC_TEST_BUSY, MIC_TEST_END, PROBLEM_DISMISS, PROBLEM_WORDS,
  SPEAKER_TEST, VS_DEVICE_SHEET_SUB,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { Cell } from "../../ui/Cells.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { PickerSheet } from "../../ui/PickerSheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { S3_TID } from "./ids.ts";
import { Waveform } from "./pill/Waveform.tsx";
import { SettingsNotice } from "./VoiceNotice.tsx";
import { deviceRows, type DeviceKind } from "./voicerows.ts";

/** The id the microphone test gives the engine: a refusal is the problem store's, and this sheet reads it. */
const MIC_TEST_ANCHOR = "mictest";

const KINDS: Record<DeviceKind, { label: string; cell: string; sheet: string; system: string }> = {
  mic: { label: DEVICES_MIC, cell: S3_TID.mic, sheet: S3_TID.micSheet, system: S3_TID.micSystem },
  speaker: { label: DEVICES_SPEAKER, cell: S3_TID.speaker, sheet: S3_TID.speakerSheet, system: S3_TID.speakerSystem },
};

/** The two cells (they replace nothing else of the group): returns the cells for a CellGroup, so it renders a fragment of its children. */
export function DeviceRows() {
  const mic = useVoiceSettings((s) => s.mic), speaker = useVoiceSettings((s) => s.speaker);
  const [open, setOpen] = useState<DeviceKind | null>(null);
  const rows = deviceRows({ mic, speaker }, voicePorts().audio.devices.ability);
  if (rows.neitherLine) return <Cell testID={S3_TID.devicesNeither} label={rows.neitherLine} />;
  return (
    <>
      {(["mic", "speaker"] as const).map((kind) => (
        <Cell key={kind} testID={KINDS[kind].cell} data={{ value: rows[kind].value }} label={KINDS[kind].label} value={rows[kind].value} onPress={() => setOpen(kind)} />
      ))}
      {open ? <DeviceSheet kind={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/** The sheet of one kind. It exists only while open, so the listing it mounts and the test it may start end with it. */
function DeviceSheet({ kind, onClose }: { kind: DeviceKind; onClose(): void }) {
  const choices = useDeviceChoices();
  const choice = choices[kind], ids = KINDS[kind];
  // The test the sheet started ends with the sheet.
  useEffect(() => () => voice.stopMicTest(), []);
  const pick = choice.show === "pick" ? choice : null;
  const hidden = pick?.hiddenNote ? DEVICES_HIDDEN_NOTE : null;
  const note = [choices.linkedNote ? DEVICES_LINKED_NOTE : null, hidden].filter(Boolean).join(" ");
  return (
    <PickerSheet open onClose={onClose} testID={ids.sheet} title={ids.label} sub={VS_DEVICE_SHEET_SUB}
      options={pick ? pick.options.map((o) => ({ value: o.key, label: o.label })) : []} value={pick ? pick.selected : null}
      onPick={(key) => { if (pick) setVoiceSettings({ [kind]: pick.options.find((o) => o.key === key)?.device ?? null }); }}
      extra={(
        <View style={styles.extra}>
          {choice.show === "system" ? <Text {...tid(ids.system)} size={TYPE.secondary} tone="muted">{choice.line}</Text> : null}
          <SettingsNotice />
          {note ? <Text {...tid(S3_TID.devicesNote)} size={TYPE.secondary} tone="muted">{note}</Text> : null}
          {kind === "mic" ? <MicTest /> : <SpeakerTest />}
        </View>
      )} />
  );
}

/** Test microphone (VD-16): a toggle showing the level of the chosen microphone as the pill's waveform. Nothing is sent; it is off while voice listens. */
function MicTest() {
  const test = useMicTest();
  const problem = useVoiceProblem();
  // The loudest the meter has shown in this test, for a check to read (the waveform itself keeps only the last moments).
  const [peak, setPeak] = useState(0);
  useEffect(() => { setPeak((p) => (test.on ? Math.max(p, test.level) : 0)); }, [test.on, test.level]);
  const busy = test.busy && !test.on;
  const refused = problem?.anchor === MIC_TEST_ANCHOR ? problem : null;
  return (
    <View style={styles.test}>
      <View style={styles.row}>
        <Button size="touch" label={test.on ? MIC_TEST_END : MIC_TEST} title={busy ? MIC_TEST_BUSY : undefined} accessibilityLabel={test.on ? MIC_TEST_END : MIC_TEST}
          {...tid(S3_TID.micTest, { on: test.on, busy })} aria-pressed={test.on} disabled={busy}
          onPress={() => { if (test.on) voice.stopMicTest(); else void voice.startMicTest(MIC_TEST_ANCHOR); }} />
        {test.on ? (
          <View {...tid(S3_TID.micLevel, { level: Math.round(test.level * 100), peak: Math.round(peak * 100) })}><Waveform level={test.level} /></View>
        ) : null}
      </View>
      {refused ? <RefusedLine kind={refused.kind} /> : null}
    </View>
  );
}

/** A refused microphone, said in the sheet: the sentence of the problem and its action (system settings, where the platform has them). */
function RefusedLine({ kind }: { kind: keyof typeof PROBLEM_WORDS }) {
  const words = PROBLEM_WORDS[kind];
  const act = kind === "mic_blocked" && voicePorts().audio.canOpenMicSettings
    ? () => { voicePorts().audio.openMicSettings().catch(() => { /* no settings to open: the line goes */ }); } : null;
  return (
    <View {...tid(S3_TID.devicesProblem, { kind })} style={styles.test}>
      <Text size={TYPE.secondary} tone="danger" accessibilityLiveRegion="polite">{words.sentence}</Text>
      <View style={styles.row}>
        <Button size="touch" label={PROBLEM_DISMISS} testID="voice-problem-dismiss" onPress={voice.dismissProblem} />
        {act ? <Button size="touch" tone="primary" label={words.action} testID="voice-problem-act" onPress={() => { voice.dismissProblem(); act(); }} /> : null}
      </View>
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
  return <Button size="touch" label={SPEAKER_TEST} {...tid(S3_TID.speakerTest, { playing })} onPress={play} style={styles.start} />;
}

const styles = StyleSheet.create({
  extra: { gap: 12 },
  test: { gap: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 },
  start: { alignSelf: "flex-start", minWidth: PHONE.target },
});
