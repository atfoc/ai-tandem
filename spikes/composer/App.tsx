// The spike's one screen: the composer and, under it, what it holds, so that a check can read it. A check on a device
// also gets the state posted to it (EXPO_PUBLIC_REPORT_URL: the address of its collector, set when Metro starts).
import React, { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { ChipInput, type ChipInputHandle } from "./src/ChipInput";
import { POINT, SELECTIONS } from "./src/fixtures";
import { colors } from "./src/theme";

const REPORT = process.env.EXPO_PUBLIC_REPORT_URL;
let seq = 0;
const report = (o: object) => { if (REPORT) fetch(REPORT, { method: "POST", body: JSON.stringify({ seq: seq++, ...o }) }).catch(() => {}); };

export default function App() {
  const input = useRef<ChipInputHandle>(null);
  const [value, setValue] = useState("");
  const [sent, setSent] = useState("");
  const [shown, setShown] = useState("");
  const [height, setHeight] = useState(0);
  const state = useRef<object>({});
  const n = useRef(0), marks = useRef(0);
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <Text style={styles.title}>Composer spike · {Platform.OS}</Text>
      <View style={styles.box} onLayout={(e) => { setHeight(e.nativeEvent.layout.height); state.current = { ...state.current, height: e.nativeEvent.layout.height }; report({ height: e.nativeEvent.layout.height }); }}>
        <ChipInput
          ref={input}
          testID="composer"
          placeholder="Ask or tell…"
          plain={!process.env.EXPO_PUBLIC_KEYBOARD_ASSIST}
          onChange={(v) => setValue(v)}
          onRaw={(s) => report({ raw: s })}
          onState={(s) => { state.current = { ...state.current, ...s }; setShown(`${JSON.stringify(s.text.replace(/ /g, "_"))} sel ${s.selection.start}-${s.selection.end}`); report(s); }}
        />
      </View>
      <View style={styles.row}>
        <Btn id="insert-selection" label="+ Selection" onPress={() => input.current?.insertRef(SELECTIONS[n.current++ % SELECTIONS.length]())} />
        <Btn id="insert-point" label="+ Point" onPress={() => input.current?.insertRef(POINT())} />
        <Btn id="send" label="Send" onPress={() => { const m = input.current?.value().trim() ?? ""; setSent(m); report({ sent: m }); input.current?.set(""); }} />
      </View>
      <View style={styles.row}>
        <Btn id="clear" label="Clear" onPress={() => { n.current = 0; input.current?.set(""); }} />
        <Btn id="mark" label="Mark" onPress={() => report({ mark: marks.current++, state: state.current })} />
      </View>
      <Text style={styles.cap}>shown (no-break space as _)</Text>
      <Text testID="shown" style={styles.mono}>{shown}</Text>
      <Text style={styles.cap}>message (what is sent) · box height {Math.round(height)}</Text>
      <Text testID="model" style={styles.mono}>{value}</Text>
      <Text style={styles.cap}>sent</Text>
      <Text testID="sent" style={styles.mono}>{sent}</Text>
    </View>
  );
}

function Btn({ id, label, onPress }: { id: string; label: string; onPress(): void }) {
  return (
    <Pressable testID={id} accessibilityLabel={id} onPress={onPress} style={styles.btn}>
      <Text>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 16, paddingTop: 64 },
  title: { fontSize: 18, fontWeight: "600", marginBottom: 12 },
  box: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 10, backgroundColor: colors.box },
  row: { flexDirection: "row", gap: 8, marginTop: 12 },
  btn: { borderWidth: 1, borderColor: colors.line, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  cap: { fontSize: 11, color: "#6c6f85", marginTop: 12 },
  mono: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 12 },
});
