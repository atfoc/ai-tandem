// The native chip input's gallery (package K2, the composer spike's screen): the box of ChipInput.native.tsx's logic
// (ChipDocInput over chipdoc.ts) with buttons that act through its handle, and readouts of what it holds. DEV ONLY, part of
// no screen; the composer (K3) uses ChipInput.
//  - In a browser: `/?gallery=chipdoc`, drawn with the spike's web field (chipdocfield.web.tsx), for
//    web/dev/checks/L4b-chipdoc.mjs.
//  - On iOS and Android: the app shows it when its bundle was made with EXPO_PUBLIC_AIWB_GALLERY=chipdoc (App.tsx), drawn with
//    the native field, for the device checks of app/e2e (`run.mjs composer-chips`: its second part, the Maestro flow composer-chips-gallery.yaml; on Android its keys).
//    With EXPO_PUBLIC_AIWB_REPORT_URL set, it posts there what it holds after every change and on each press of Mark, what is
//    sent, its height, and the selections the field reported before the snap.
import React, { useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { onInsertPopup, type InsertTarget } from "@aiwb/core/logic/insert.ts";
import { ChipDocInput, type DocState } from "../platform/chipinput/ChipDocInput.tsx";
import type { ChipInputHandle } from "../platform/chipinput/types.ts";
import { Text } from "../ui/Text.tsx";
import { useTheme } from "../ui/theme.tsx";
import { report } from "./chipreport.ts";
import { DevField } from "./chipdocfield";
import { INSERTED, MENTION, POINT, SELECTIONS } from "./chipdocfixtures.ts";

export function ChipDocGallery() {
  const { tokens: t } = useTheme();
  const input = useRef<ChipInputHandle>(null);
  const [value, setValue] = useState("");
  const [before, setBefore] = useState("");
  const [sent, setSent] = useState("");
  const [shown, setShown] = useState("");
  const [keys, setKeys] = useState("");
  const [height, setHeight] = useState(0);
  const [locked, setLocked] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [enterSends, setEnterSends] = useState(false);
  const [assist, setAssist] = useState(!!process.env.EXPO_PUBLIC_AIWB_KEYBOARD_ASSIST); // the keyboard's own corrections and suggestions
  const [popup, setPopup] = useState<InsertTarget | null>(null);
  const state = useRef<object>({});
  const n = useRef(0), marks = useRef(0);
  const now = useRef({ value, enterSends });
  now.current = { value, enterSends };
  React.useEffect(() => onInsertPopup(setPopup), []);

  const send = () => {
    const m = now.current.value.trim();
    setSent(m);
    report({ sent: m });
    input.current?.set("");
  };
  const onState = (s: DocState) => {
    state.current = { ...state.current, ...s };
    setShown(`${JSON.stringify(s.text.replace(/\u00A0/g, "_"))} sel ${s.selection.start}-${s.selection.end}`);
    report({ state: s });
  };

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.root} keyboardShouldPersistTaps="always" testID="chipdoc-gallery">
      <Text size={16} weight="600">Chip input · {Platform.OS}</Text>
      <View
        style={[styles.box, { borderColor: t.line2, backgroundColor: readOnly ? t.panel : t.bg }]}
        onLayout={(e) => { const h = e.nativeEvent.layout.height; setHeight(h); state.current = { ...state.current, height: h }; report({ height: h }); }}
      >
        <ChipDocInput
          ref={input}
          Field={DevField}
          testID="composer-input"
          placeholder="Ask or tell…"
          plain={!assist}
          locked={locked}
          readOnly={readOnly}
          onChange={(v, b) => { setValue(v); setBefore(b); }}
          onKey={(e) => {
            setKeys((k) => `${k} ${e.key}`.slice(-60));
            if (e.key === "Enter" && now.current.enterSends) { send(); return true; }
            return false;
          }}
          onRaw={(s) => report({ raw: s })}
          onState={onState}
        />
      </View>
      <View style={styles.row}>
        <Btn id="insert-selection" label="+ Selection" onPress={() => input.current?.insertRef(SELECTIONS[n.current++ % SELECTIONS.length]())} />
        <Btn id="insert-point" label="+ Point" onPress={() => input.current?.insertRef(POINT())} />
        <Btn id="send" label="Send" onPress={send} />
        <Btn id="clear" label="Clear" onPress={() => { n.current = 0; input.current?.set(""); }} />
        <Btn id="mark" label="Mark" onPress={() => report({ mark: marks.current++, state: { ...state.current, before } })} />
      </View>
      <View style={styles.row}>
        <Btn id="mention" label={`Complete ${MENTION.typed}`} onPress={() => input.current?.replaceBeforeCaret(MENTION.typed.length, MENTION.done)} />
        <Btn id="open-insert" label="Insert…" onPress={() => input.current?.openInsert()} />
        <Btn id="locked" label={locked ? "Locked ✓" : "Locked"} onPress={() => setLocked((x) => !x)} />
        <Btn id="readonly" label={readOnly ? "Read-only ✓" : "Read-only"} onPress={() => setReadOnly((x) => !x)} />
        <Btn id="enter-sends" label={enterSends ? "Enter sends ✓" : "Enter sends"} onPress={() => setEnterSends((x) => !x)} />
        <Btn id="assist" label={assist ? "Suggestions ✓" : "Suggestions"} onPress={() => setAssist((x) => !x)} />
      </View>
      {popup ? (
        <View style={styles.row} testID="chipdoc-popup">
          <Btn id="popup-insert" label="Insert the prompt" onPress={() => { popup.insert(INSERTED); setPopup(null); }} />
          <Btn id="popup-cancel" label="Cancel" onPress={() => { popup.cancel(); setPopup(null); }} />
        </View>
      ) : null}
      <Text size={11} tone="muted">shown (no-break space as _)</Text>
      <Text testID="shown" mono size={12}>{shown}</Text>
      <Text size={11} tone="muted">value · box height {Math.round(height)}</Text>
      <Text testID="model" mono size={12}>{value}</Text>
      <Text size={11} tone="muted">before the caret</Text>
      <Text testID="before" mono size={12}>{before}</Text>
      <Text size={11} tone="muted">sent</Text>
      <Text testID="sent" mono size={12}>{sent}</Text>
      <Text size={11} tone="muted">keys</Text>
      <Text testID="keys" mono size={12}>{keys}</Text>
    </ScrollView>
  );
}

function Btn({ id, label, onPress }: { id: string; label: string; onPress(): void }) {
  const { tokens: t } = useTheme();
  return (
    <Pressable testID={id} accessibilityLabel={id} accessibilityRole="button" onPress={onPress} style={[styles.btn, { borderColor: t.line2 }]}>
      <Text>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 16, paddingTop: 64, paddingBottom: 32, gap: 6 },
  box: { borderWidth: 1, borderRadius: 8, padding: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  btn: { borderWidth: 1, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10 },
});
