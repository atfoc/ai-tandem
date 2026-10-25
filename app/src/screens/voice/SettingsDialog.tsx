// Settings > Voice (VC-13, goal 3.7): a rounded page with the key, the voice, the microphone and speaker, how a spoken turn is sent, and the advanced options. A centred
// dialog on the wide layouts and a bottom sheet on the phone (`Overlay` decides). It is mounted always (the shell's `Overlays` slot) and shows
// itself from the voice store's `settingsOpen`, which the foot's gear button and the problem popover's "Open Settings" set. Everything it
// changes is a voice setting (one stored value, read by the speech bar and the pill too) or the key (which only the keystore holds): the key
// typed here is held in this component alone and dropped at Save and at close.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import { DEFAULTS, PAUSE_MAX_MS, PAUSE_MIN_MS, PAUSE_STEP_MS, SPEEDS } from "../../voice/logic/settings.ts";
import { closeVoiceSettings, setVoiceSettings, useVoiceSettings, useVoiceSettingsOpen, voice } from "../../voice/index.ts";
import type { VoiceSettings } from "../../voice/index.ts";
import {
  ADVANCED_LANGUAGE, ADVANCED_LANGUAGE_AUTO, ADVANCED_PAUSE, ADVANCED_PAUSE_VALUE, ADVANCED_SKIP_CODE, ADVANCED_SPEED, ADVANCED_SPEED_VALUE,
  ADVANCED_STT_MODEL, ADVANCED_STT_SCRIBE, ADVANCED_TITLE, ADVANCED_TTS_FLASH, ADVANCED_TTS_MODEL, ADVANCED_TTS_MULTILINGUAL, ADVANCED_TTS_V4_TURBO, AUTOSEND_NOTE,
  AUTOSEND_OFF, AUTOSEND_ON, AUTOSEND_TITLE, KEY_BAD, KEY_HIDE, KEY_PLACEHOLDER, KEY_PLACEHOLDER_SAVED, KEY_REMOVE, KEY_REMOVE_BODY,
  KEY_REMOVE_DO, KEY_REMOVE_TITLE, KEY_REMOVED, KEY_SAVE, KEY_SAVED, KEY_SHOW, KEY_STORED_NOTE, KEY_TEST, KEY_TESTING, KEY_TITLE, LANGUAGES,
  PROBLEM_WORDS, SETTINGS_CLOSE, SETTINGS_TITLE, SETTINGS_VOICE_TITLE, VOICES_TITLE, keyWorks,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogActions, DialogTitle } from "../../ui/Dialog.tsx";
import { MicIcon } from "../../ui/icons.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { SecretInput } from "../../ui/SecretInput.tsx";
import { Slider } from "../../ui/Slider.tsx";
import { Text } from "../../ui/Text.tsx";
import { usePhone } from "../../ui/useLayout.ts";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { confirm } from "../shell/confirm.ts";
import { SECRET_INPUT } from "../servers/parts.tsx";
import { Choice, Disclosure, Picker, Row, Section, SwitchRow, type Option } from "./SettingsParts.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { VoiceChoice } from "./VoiceChoice.tsx";
import { openVoicePhone, voiceScreenShown } from "./open.ts";

export const SETTINGS_DIALOG_ID = "settings-dialog";

export function SettingsDialog() {
  const open = useVoiceSettingsOpen();
  const phone = usePhone();
  // On the phone Settings > Voice is the pushed screen `voice-settings` (S3); no dialog is drawn. A request to open it (the flag set while the
  // screen is not shown) clears the flag and pushes the screen, which then holds the flag itself while it is mounted (open.ts).
  useEffect(() => { if (open && phone && !voiceScreenShown()) { closeVoiceSettings(); openVoicePhone(); } }, [open, phone]);
  if (!open || phone) return null;
  return (
    <Overlay open kind="dialog" label={SETTINGS_TITLE} width={600} testID={SETTINGS_DIALOG_ID} onClose={closeVoiceSettings}>
      <SettingsPage />
    </Overlay>
  );
}

/** The page. It is mounted while the dialog is open only, so everything it holds (the typed key, the result line, the open Advanced options) starts anew at each opening. */
function SettingsPage() {
  const { tokens: t } = useTheme();
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  // Counts the changes of the key, so that the voice list asks the service again.
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    voice.hasKey().then((has) => { if (live) setHasKey(has); }, () => { if (live) setHasKey(false); });
    return () => { live = false; };
  }, []);
  const changed = (has: boolean) => { setHasKey(has); setStamp((n) => n + 1); };
  return (
    <View {...tid("vs-page")}>
      <DialogTitle>{SETTINGS_TITLE}</DialogTitle>
      <View style={styles.section}>
        <MicIcon color={t.accent} />
        <Text {...tid("vs-section-title")} size={12} weight="600" tone="accent" style={styles.caps}>{SETTINGS_VOICE_TITLE}</Text>
      </View>
      <KeySection hasKey={hasKey} onChanged={changed} />
      <Section title={VOICES_TITLE} testID="vs-voices-section"><VoiceChoice hasKey={hasKey} stamp={stamp} /></Section>
      <DevicesSection hasKey={hasKey} />
      <AutoSendSection />
      <AdvancedSection />
      <DialogActions>
        <Button size="sm" label={SETTINGS_CLOSE} testID="vs-close" autoFocus onPress={closeVoiceSettings} />
      </DialogActions>
    </View>
  );
}

type Line = { tone: "ok" | "danger" | "muted"; text: string };

/** The key (goal 3.7, VC-13): the secret box with Show, Test key and Save, the line that tells what Test key found, the note on where the key goes, and "Remove key from this device". */
function KeySection({ hasKey, onChanged }: { hasKey: boolean | null; onChanged(has: boolean): void }) {
  const { tokens: t } = useTheme();
  const [typed, setTyped] = useState("");
  const [shown, setShown] = useState(false);
  const [line, setLine] = useState<Line | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const Input = shown ? TextInput : SecretInput;
  const { secret: _secret, ...box } = SECRET_INPUT;

  const save = async () => {
    const key = typed.trim();
    if (!key || busy) return;
    setBusy(true);
    try {
      await voice.setKey(key);
      setTyped("");
      setLine({ tone: "ok", text: KEY_SAVED });
      onChanged(true);
    } catch {
      setLine({ tone: "danger", text: KEY_BAD }); // (the keystore refuses a key that is not plain printable text; it never says why, and the text is not echoed)
    } finally { setBusy(false); }
  };
  const test = async () => {
    if (busy) return;
    setBusy(true);
    setLine({ tone: "muted", text: KEY_TESTING });
    try {
      const r = await voice.testKey(typed.trim() || undefined);
      setLine(r.ok ? { tone: "ok", text: keyWorks(r.voices) } : { tone: "danger", text: PROBLEM_WORDS[r.problem].sentence });
    } finally { setBusy(false); }
  };
  const remove = () => confirm({
    title: KEY_REMOVE_TITLE, body: KEY_REMOVE_BODY,
    actions: [{ label: KEY_REMOVE_DO, tone: "danger", run: async () => { await voice.removeKey(); setTyped(""); setLine({ tone: "muted", text: KEY_REMOVED }); onChanged(false); } }],
  });

  return (
    <Section title={KEY_TITLE} note={KEY_STORED_NOTE} testID="vs-key-section">
      <View style={styles.keyRow}>
        <Input {...box} {...tid("vs-key", { shown })} value={typed} onChangeText={(v) => { setTyped(v); if (line) setLine(null); }} accessibilityLabel={KEY_TITLE} aria-label={KEY_TITLE}
          placeholder={hasKey ? KEY_PLACEHOLDER_SAVED : KEY_PLACEHOLDER} placeholderTextColor={t.faint} returnKeyType="done" onSubmitEditing={() => void save()}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: focus ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as object]} />
        <Button size="sm" label={shown ? KEY_HIDE : KEY_SHOW} testID="vs-key-show" aria-pressed={shown} onPress={() => setShown(!shown)} />
      </View>
      <View style={styles.keyActions}>
        <Button size="sm" label={KEY_TEST} testID="vs-key-test" disabled={busy} onPress={() => void test()} />
        <Button size="sm" tone="primary" label={KEY_SAVE} testID="vs-key-save" disabled={busy || !typed.trim()} onPress={() => void save()} />
        {hasKey ? <Button size="sm" accessibilityLabel={KEY_REMOVE} testID="vs-key-remove" onPress={remove}><Text size={12} tone="danger">{KEY_REMOVE}</Text></Button> : null}
      </View>
      {line ? <Text {...tid("vs-key-result", { tone: line.tone })} role="status" selectable size={12} weight={line.tone === "muted" ? undefined : "600"} tone={line.tone}>{line.text}</Text> : null}
    </Section>
  );
}

/** "Speech mode sends my turn": the default of the speech bar and the pill, whose toggle is this same setting (goal 4.6). */
function AutoSendSection() {
  const autoSend = useVoiceSettings((s) => s.autoSend);
  const options: Option<boolean>[] = [{ value: true, label: AUTOSEND_ON }, { value: false, label: AUTOSEND_OFF }];
  return (
    <Section title={AUTOSEND_TITLE} note={AUTOSEND_NOTE} testID="vs-autosend-section">
      <Choice label={AUTOSEND_TITLE} value={autoSend} options={options} onChange={(v) => setVoiceSettings({ autoSend: v })} testID="vs-autosend" />
    </Section>
  );
}

const TTS_OPTIONS: Option<VoiceSettings["ttsModel"]>[] = [
  { value: "eleven_flash_v2_5", label: ADVANCED_TTS_FLASH }, { value: "eleven_v4_turbo", label: ADVANCED_TTS_V4_TURBO },
  { value: "eleven_multilingual_v2", label: ADVANCED_TTS_MULTILINGUAL },
];
const STT_OPTIONS: Option<VoiceSettings["sttModel"]>[] = [{ value: "scribe_v2_realtime", label: ADVANCED_STT_SCRIBE }];
const LANGUAGE_OPTIONS: Option<string | null>[] = [{ value: null, label: ADVANCED_LANGUAGE_AUTO }, ...LANGUAGES.map(([code, name]) => ({ value: code, label: name }))];
const SPEED_OPTIONS: Option<number>[] = SPEEDS.map((x) => ({ value: x, label: ADVANCED_SPEED_VALUE(x) }));

/** Advanced options, collapsed until opened. */
function AdvancedSection() {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const s = useVoiceSettings((x) => x);
  const labelOf = <T,>(options: Option<T>[], value: T, other: string): string => options.find((o) => o.value === value)?.label ?? other;
  return (
    <View {...tid("vs-advanced-section")} style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Pressable {...tid("vs-advanced", { open })} role="button" aria-expanded={open} accessibilityState={{ expanded: open }} accessibilityLabel={ADVANCED_TITLE}
        onPress={() => setOpen(!open)} style={[styles.disclosure, webStyle({ cursor: "pointer" })]}>
        <Disclosure open={open} color={t.muted} />
        <Text weight="600">{ADVANCED_TITLE}</Text>
      </Pressable>
      {open ? (
        <View {...tid("vs-advanced-body")} style={styles.advanced}>
          <Row label={ADVANCED_TTS_MODEL}>
            <Picker label={ADVANCED_TTS_MODEL} value={s.ttsModel} options={TTS_OPTIONS} shown={labelOf(TTS_OPTIONS, s.ttsModel, s.ttsModel)} onChange={(v) => setVoiceSettings({ ttsModel: v })} testID="vs-adv-tts" />
          </Row>
          <Row label={ADVANCED_STT_MODEL}>
            <Picker label={ADVANCED_STT_MODEL} value={s.sttModel} options={STT_OPTIONS} shown={labelOf(STT_OPTIONS, s.sttModel, s.sttModel)} onChange={(v) => setVoiceSettings({ sttModel: v })} testID="vs-adv-stt" />
          </Row>
          <Row label={ADVANCED_LANGUAGE}>
            <Picker label={ADVANCED_LANGUAGE} value={s.language} options={LANGUAGE_OPTIONS} shown={labelOf(LANGUAGE_OPTIONS, s.language, s.language ?? ADVANCED_LANGUAGE_AUTO)} onChange={(v) => setVoiceSettings({ language: v })} testID="vs-adv-language" />
          </Row>
          <Row label={ADVANCED_PAUSE} wide>
            <Slider testID="vs-adv-pause" label={ADVANCED_PAUSE} value={s.pauseMs} min={PAUSE_MIN_MS} max={PAUSE_MAX_MS} step={PAUSE_STEP_MS}
              format={ADVANCED_PAUSE_VALUE} mark={DEFAULTS.pauseMs} onCommit={(v) => setVoiceSettings({ pauseMs: v })} />
          </Row>
          <Row label={ADVANCED_SPEED}>
            <Picker label={ADVANCED_SPEED} value={s.speed} options={SPEED_OPTIONS} shown={ADVANCED_SPEED_VALUE(s.speed)} onChange={(v) => setVoiceSettings({ speed: v })} testID="vs-adv-speed" />
          </Row>
          <SwitchRow label={ADVANCED_SKIP_CODE} on={s.skipCode} onChange={(v) => setVoiceSettings({ skipCode: v })} testID="vs-adv-skipcode" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  keyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, minWidth: 0, fontSize: 13, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  keyActions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  card: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, marginTop: 12 },
  disclosure: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" },
  advanced: { marginTop: 10, gap: 8 },
});
