// Rename (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §2): one P3 form for a chat, a whiteboard and a group,
// the same from a row of Home, from Chat info (package T3) and from a board's title (package B1): they call `openRename(item)`.
// RenameHost is mounted once, for every layout's phone screens, through the shell's Overlays slot (home/index.ts).
// The sheet is the phone's P3 form (ui/FormSheet.tsx); the pure words and rules are renamemodel.ts.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { getState, groupsOn, threadOf } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { FormSheet } from "../../ui/FormSheet.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { renameBoard, renameGroup } from "../sidebar/actions.ts";
import { H2_TID } from "./h2ids.ts";
import { canSaveName, renameTarget } from "./renamemodel.ts";

export type RenameItem = { kind: "chat" | "board" | "group"; key: string };

let open: RenameItem | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openRename(item: RenameItem): void {
  open = { kind: item.kind, key: item.key };
  emit();
}

export function closeRename(): void {
  if (open === null) return;
  open = null;
  emit();
}

/** The item the sheet is open for, or null. */
export const useRenameOpen = (): RenameItem | null =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => open, () => null);

export function RenameHost() {
  const item = useRenameOpen();
  return item ? <RenameForm key={`${item.kind}:${item.key}`} item={item} /> : null;
}

function RenameForm({ item }: { item: RenameItem }) {
  const t = useTokens();
  const [opened] = useState(() => renameTarget(getState(), item.kind, item.key, item.kind === "chat" ? threadOf(getState(), item.key)?.items : undefined)); // read once, at open: a change on its server meanwhile does not move the field
  const [name, setName] = useState(opened?.name ?? "");
  const [focused, setFocused] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState("");
  const input = useRef<TextInput>(null);
  const gone = useStore((s) => renameTarget(s, item.kind, item.key) === null);
  useEffect(() => { if (gone) closeRename(); }, [gone]); // the item is gone while the sheet is open
  if (!opened) return null;
  const typed = name.trim(), canSave = canSaveName(name, opened.name) && !saving;
  const run = async () => {
    const s = getState();
    if (item.kind === "chat") await api.renameChat(item.key, typed);
    else if (item.kind === "board") { const b = s.boards[item.key]; if (b) await renameBoard(b, typed); }
    else { const g = groupsOn(s, serverOfKey(item.key)).find((x) => x.id === item.key); if (g) renameGroup(g, typed); }
  };
  // Return saves: the sheet's own Save runs `run` itself (and shows its throw); here the same, with the sheet told the refusal.
  const submit = async () => {
    if (!canSave) return;
    setSaving(true); setRefused("");
    try { await run(); closeRename(); } catch (e) { setRefused((e as Error)?.message ?? String(e)); } finally { setSaving(false); }
  };
  return (
    <FormSheet open onClose={closeRename} title={opened.title} sub={opened.sub} testID={H2_TID.renameSheet} dataSet={{ kind: item.kind, key: item.key }} canSave={canSave}
      dirty={typed !== opened.name} onSave={run} error={refused}>
      <View style={styles.wrap}>
        <TextInput {...tid(H2_TID.renameInput)} ref={input} value={name} onChangeText={(v) => { setName(v); setRefused(""); }} autoFocus selectTextOnFocus
          returnKeyType="done" blurOnSubmit={false} onSubmitEditing={() => void submit()} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          editable={!saving} accessibilityLabel="Name" placeholderTextColor={t.faint} autoCorrect={false}
          style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: focused ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
        {name !== "" ? (
          <Pressable {...tid(H2_TID.renameClear)} accessibilityRole="button" accessibilityLabel="Clear name" disabled={saving}
            onPress={() => { setName(""); input.current?.focus(); }} style={[styles.clear, webStyle({ cursor: "pointer" })]}>
            <View style={[styles.glyph, { backgroundColor: t.faint }]}>
              <Text size={TYPE.secondary} tone="onAccent" weight="600" style={styles.cross}>×</Text>
            </View>
          </Pressable>
        ) : null}
      </View>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: PHONE.margin, marginTop: 8, marginBottom: PHONE.margin, justifyContent: "center" },
  input: { minHeight: PHONE.target, borderWidth: 1, borderRadius: 10, paddingLeft: 12, paddingRight: PHONE.target, paddingVertical: 0, fontSize: TYPE.control },
  clear: { position: "absolute", right: 0, top: 0, width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" },
  glyph: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  cross: { lineHeight: 18, textAlign: "center" },
});
