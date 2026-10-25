// Add key (P3, S3 goal 3.7.3): a form sheet with the one box of the ElevenLabs key, an eye that shows it, Paste, Test key and the line that says
// what the test found. The key lives in this sheet's state only: it goes to the keystore at Save (`voice.setKey`) and is dropped when the sheet
// closes. It is in no testID, dataSet, log or storage; the result line says the count or the problem, never the key.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { readText } from "../../platform/clipboard";
import { voice } from "../../voice/index.ts";
import {
  KEY_BAD, KEY_PLACEHOLDER, KEY_STORED_NOTE, KEY_TEST, KEY_TESTING, VS_KEY_FIELD, VS_KEY_HIDE, VS_KEY_PASTE, VS_KEY_PROBLEM, VS_KEY_SHEET_TITLE, VS_KEY_SHOW,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { FormSheet } from "../../ui/FormSheet.tsx";
import { EyeIcon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { SecretInput } from "../../ui/SecretInput.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { SECRET_INPUT } from "../servers/parts.tsx";
import { S3_TID } from "./ids.ts";
import { keyResultLine, type KeyResultLine } from "./voicerows.ts";

export type AddKeySheetProps = { open: boolean; onClose(): void; onSaved(): void };

const CLIPBOARD_REFUSED = "The clipboard could not be read.";

export function AddKeySheet({ open, onClose, onSaved }: AddKeySheetProps) {
  const t = useTokens();
  const [typed, setTyped] = useState("");
  const [reveal, setReveal] = useState(false);
  const [focus, setFocus] = useState(false);
  const [line, setLine] = useState<KeyResultLine | null>(null);
  const [testing, setTesting] = useState(false);
  /** The test in flight: an answer that comes after the key changed, or the sheet closed, is not the line of what is typed now. */
  const asked = useRef(0);
  useEffect(() => { if (!open) { asked.current++; setTyped(""); setReveal(false); setLine(null); setTesting(false); } }, [open]);
  const { secret: _secret, ...box } = SECRET_INPUT;
  const change = (v: string) => { asked.current++; setTesting(false); setTyped(v); if (line) setLine(null); };
  const paste = async () => {
    try { change((await readText()).trim()); } catch { setLine({ tone: "danger", text: VS_KEY_PROBLEM(CLIPBOARD_REFUSED) }); }
  };
  const test = async () => {
    const turn = ++asked.current;
    setTesting(true); setLine({ tone: "muted", text: KEY_TESTING });
    const r = await voice.testKey(typed.trim() || undefined);
    if (turn !== asked.current) return;
    setTesting(false); setLine(keyResultLine(r));
  };
  const save = async () => {
    try { await voice.setKey(typed.trim()); } catch { throw new Error(KEY_BAD); } // (the keystore never says why, and the text is not echoed)
    setTyped("");
    onSaved();
  };
  const eye = reveal ? VS_KEY_HIDE : VS_KEY_SHOW;
  return (
    <FormSheet open={open} onClose={onClose} testID={S3_TID.keySheet} title={VS_KEY_SHEET_TITLE} canSave={typed.trim() !== ""} dirty={typed !== ""} onSave={save}>
      <View style={styles.body}>
        <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
          <Text size={TYPE.secondary} tone="muted">{VS_KEY_FIELD}</Text>
          <View style={styles.fieldRow}>
            <SecretInput {...box} {...tid(S3_TID.key)} reveal={reveal} mono value={typed} onChangeText={change} accessibilityLabel={VS_KEY_FIELD} aria-label={VS_KEY_FIELD}
              placeholder={KEY_PLACEHOLDER} placeholderTextColor={t.faint} returnKeyType="done" onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
              style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: focus ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as object]} />
            <IconButton size="touch" title={eye} testID={S3_TID.keyEye} aria-pressed={reveal} on={reveal} onPress={() => setReveal(!reveal)}>
              {(color) => <EyeIcon size={20} color={color} />}
            </IconButton>
          </View>
        </View>
        <View style={styles.actions}>
          <Button size="touch" label={VS_KEY_PASTE} testID={S3_TID.keyPaste} style={styles.action} onPress={() => void paste()} />
          <Button size="touch" label={KEY_TEST} testID={S3_TID.keyTest} style={styles.action} disabled={testing} onPress={() => void test()} />
        </View>
        {line ? <Text {...tid(S3_TID.keyResult, { tone: line.tone })} role="status" selectable size={TYPE.secondary} weight={line.tone === "muted" ? undefined : "600"} tone={line.tone}>{line.text}</Text> : null}
        <Text size={TYPE.secondary} tone="muted">{KEY_STORED_NOTE}</Text>
      </View>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12, paddingHorizontal: PHONE.margin - 8, paddingTop: 8, paddingBottom: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 8 },
  fieldRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, minHeight: PHONE.target, fontSize: TYPE.control, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12 },
  actions: { flexDirection: "row", gap: 12 },
  action: { flex: 1, justifyContent: "center", alignSelf: "stretch" },
});
