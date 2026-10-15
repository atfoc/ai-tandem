// The self-test screen of the hardware keyboard (architecture AD-73, AD-83; package N3): the real keys port (platform/keys, the
// aiwb-keys module) with the real window shortcuts of the shell (screens/shell/shortcuts.ts: ⌘J, ⌘N, ⌘B) over the real store, and a
// text box. A device test sends the keys (iOS: the XCUITest bundle app/e2e/xcuitest/keys, Android: adb input) and reads this
// screen; the screen says "keys self-test ok" once every shortcut of the module's list (but the optional ones, below) has come exactly as the platform makes it,
// and "keys self-test FAILED" at the first key that is not one of them (a typed letter must never come here).
import { useEffect, useReducer, useRef, useState } from "react";
import { Keyboard, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { getState, setState, subscribe } from "@aiwb/core/state/store.ts";

import { eventOf, SHORTCUTS } from "../../modules/aiwb-keys/src/AiwbKeys.ts";
import { onKey } from "../platform/keys";
import type { KeyLike } from "../platform/keys.types.ts";
import { keyPlatform } from "../screens/shell/keyplatform.ts";
import { shortcutHandler } from "../screens/shell/shortcuts.ts";
import { selfTestReportUrl } from "./selftestEnv.ts";

const platform = Platform.OS === "android" ? "android" : "ios";
const idOf = (e: Pick<KeyLike, "code" | "metaKey" | "ctrlKey" | "shiftKey">) => `${e.metaKey || e.ctrlKey ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${e.code}`;
const WANTED = new Map(SHORTCUTS.map((s) => [idOf(eventOf(s, platform)), s]));
/** What the screen need not wait for: the device test on iOS (XCUITest in the simulator) cannot send Return or Escape (a plain Return into a
 *  text box does nothing either), so ⌘Enter and Escape count if they come and are not waited for there. Android's test sends all nine. */
const OPTIONAL = new Set(platform === "ios" ? SHORTCUTS.filter((s) => s.code === "Enter" || s.code === "Escape").map((s) => idOf(eventOf(s, platform))) : []);

/** What became of the last post to the runner, shown on the screen (`keys-report`), as SelfTestRoot shows its own. */
let reportNote = "report: none";
let noteChanged: () => void = () => {};
const setNote = (n: string) => { reportNote = n; noteChanged(); };

/** Tells the runner (fire and forget), as SelfTestRoot does. */
function post(kind: string, text: string) {
  const url = selfTestReportUrl();
  if (!url) { setNote("report: no url given"); return; }
  setNote(`report: sending to ${url}`);
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, text }) })
    .then((r) => setNote(`report: ${r.status}`))
    .catch((e) => setNote(`report to ${url} failed: ${e}`));
}

/** What the screen says about one key: `key=B code=KeyB meta ctrl shift alt repeat` with only the flags that are set. */
const describe = (e: KeyLike) => `key=${e.key} code=${e.code}${e.metaKey ? " meta" : ""}${e.ctrlKey ? " ctrl" : ""}${e.shiftKey ? " shift" : ""}${e.altKey ? " alt" : ""}${e.repeat ? " repeat" : ""}`;

export function KeysSelfTest() {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [log, setLog] = useState<string[]>([]);
  const seen = useRef(new Set<string>());
  const bad = useRef<string[]>([]);
  const said = useRef("");
  const chats = useRef<string[]>([]);
  const [typed, setTyped] = useState("");
  const [focused, setFocused] = useState(false);
  const [modal, setModal] = useState(false);
  noteChanged = redraw;

  useEffect(() => {
    // The state the shell's shortcuts read: connected, nothing open and nothing selected (⌘N then asks for an ungrouped chat).
    setState({ connected: true, confirm: null, serversDialog: null, libraryDialog: null, insertPopup: null, treeNav: null, panel: true, sideHidden: false, sel: { board: null, chat: null }, chats: {}, boards: {}, groups: [] });
    const handle = shortcutHandler({
      platform: keyPlatform,
      newChat: (where) => { chats.current.push(JSON.stringify(where)); redraw(); },
      setSideHidden: (hidden) => setState({ sideHidden: hidden }),
    });
    const offStore = subscribe(redraw);
    // First, so the record shows a key before the shell's handler takes it.
    const offRecord = onKey((e) => {
      const id = idOf(e), want = WANTED.get(id);
      const exact = want && JSON.stringify({ ...eventOf(want, platform), repeat: false }) === JSON.stringify({ key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, repeat: false });
      if (!exact) bad.current.push(describe(e)); else seen.current.add(id);
      setLog((l) => [...l, `${describe(e)}${e.defaultPrevented ? " prevented" : ""}`].slice(-12));
    });
    const offShell = onKey(handle);
    return () => { offShell(); offRecord(); offStore(); };
  }, []);

  const state = getState();
  const missing = [...WANTED.keys()].filter((id) => !seen.current.has(id) && !OPTIONAL.has(id));
  const status = bad.current.length ? `keys self-test FAILED: unexpected key ${bad.current[0]}`
    : missing.length ? `keys self-test waiting (${seen.current.size} of ${WANTED.size - OPTIONAL.size} needed)` : "keys self-test ok";
  if (said.current !== status && (bad.current.length || !missing.length)) { said.current = status; post("verdict", status.replace("keys self-test ", "keys: ")); }

  return (
    <View style={styles.root} testID="keys-root">
      <Text style={styles.title}>Keys self-test ({platform})</Text>
      <Text style={styles.status} testID="keys-status">{status}</Text>
      <View style={styles.row}>
        {!state.sideHidden ? <View style={styles.sidebar} testID="keys-sidebar"><Text style={styles.sidebarText}>sidebar</Text></View> : null}
        <View style={styles.col}>
          <Text testID="keys-side-state">{`sidebar: ${state.sideHidden ? "hidden" : "shown"}`}</Text>
          <Text testID="keys-panel-state">{`panel: ${state.panel ? "shown" : "hidden"}`}</Text>
          <Text testID="keys-chats">{`chats made: ${chats.current.length}`}</Text>
          <Text testID="keys-chat-last">{`last chat: ${chats.current[chats.current.length - 1] ?? "none"}`}</Text>
          <Text testID="keys-seen">{`seen: ${seen.current.size} of ${WANTED.size}`}</Text>
        </View>
      </View>
      <Text style={styles.label}>A text box: typing and the keys it keeps</Text>
      <TextInput testID="keys-input" accessibilityLabel="keys-input" style={styles.input} value={typed} onChangeText={setTyped} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} autoCapitalize="none" autoCorrect={false} multiline />
      <Text testID="keys-focus">{`focus: ${focused ? "text box" : "none"}`}</Text>
      <Text testID="keys-report" style={styles.line}>{reportNote}</Text>
      <Text testID="keys-typed">{`typed: ${JSON.stringify(typed)}`}</Text>
      <Pressable testID="keys-clear" accessibilityRole="button" style={styles.button} onPress={() => { setTyped(""); setLog([]); }}><Text style={styles.buttonText}>Clear</Text></Pressable>
      <View style={styles.buttons}>
        {/* The device test presses these: the first takes the focus out of the text box (the shortcuts must still come); the second opens a React Native `Modal`, a window of its own (N3: the module does not see keys while it is open). */}
        <Pressable testID="keys-blur" accessibilityRole="button" style={styles.button} onPress={() => Keyboard.dismiss()}><Text style={styles.buttonText}>No focus</Text></Pressable>
        <Pressable testID="keys-modal" accessibilityRole="button" style={styles.button} onPress={() => setModal(true)}><Text style={styles.buttonText}>Open modal</Text></Pressable>
      </View>
      <Modal visible={modal} transparent animationType="none" onRequestClose={() => setModal(false)}>
        <View style={styles.modalBack}>
          <View style={styles.modalCard} testID="keys-modal-card">
            <Text testID="keys-modal-state">modal: open</Text>
            <Text testID="keys-modal-side">{`modal sees sidebar: ${state.sideHidden ? "hidden" : "shown"}, keys seen: ${seen.current.size}, last: ${log.length ? log[log.length - 1] : "none"}`}</Text>
            <Pressable testID="keys-modal-close" accessibilityRole="button" style={styles.button} onPress={() => setModal(false)}><Text style={styles.buttonText}>Close modal</Text></Pressable>
          </View>
        </View>
      </Modal>
      <ScrollView style={styles.log} testID="keys-log">
        {log.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
      </ScrollView>
      <Text testID="keys-last" style={styles.line}>{`last key: ${log.length ? log[log.length - 1] : "none"}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 70, paddingHorizontal: 16, backgroundColor: "#ffffff" },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 8 },
  status: { fontSize: 18, fontWeight: "600", marginBottom: 10 },
  row: { flexDirection: "row", gap: 12, marginBottom: 10 },
  col: { flex: 1, gap: 2 },
  sidebar: { width: 110, height: 90, borderRadius: 8, backgroundColor: "#e0dfff", alignItems: "center", justifyContent: "center" },
  sidebarText: { fontSize: 15 },
  label: { fontSize: 13, color: "#555555", marginBottom: 4 },
  input: { borderWidth: 1, borderColor: "#999999", borderRadius: 6, padding: 8, minHeight: 60, fontSize: 16, marginBottom: 6 },
  button: { backgroundColor: "#6965db", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, marginTop: 6, alignSelf: "flex-start" },
  buttonText: { color: "#ffffff", fontSize: 15 },
  buttons: { flexDirection: "row", gap: 10 },
  modalBack: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.3)" },
  modalCard: { backgroundColor: "#ffffff", padding: 20, borderRadius: 10, gap: 10 },
  log: { flex: 1, marginTop: 8 },
  line: { fontSize: 12, color: "#333333", marginBottom: 2 },
});
