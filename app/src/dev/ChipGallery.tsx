// The chip input on the gallery (package K1): the box with its handle's actions, a stand-in for the board it points at
// (three shapes to select, a layer to pick a point on, ⌘L and ⌘⇧L as the composer will wire them), a stand-in for the insert
// popup, and the readouts web/dev/checks/L4-chips.mjs and P7.4-keys.mjs read. It is part of no screen: the composer (K3)
// builds the real thing from the same ChipInput.
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";

import type { FmtElement } from "@aiwb/core/format.ts";
import { onInsertPopup, type InsertTarget } from "@aiwb/core/logic/insert.ts";
import { pointRef, selectionRef, serializeRef } from "@aiwb/core/logic/refs.ts";
import { onKey } from "../platform/keys";
import { ChipInput, type ChipInputHandle } from "../platform/chipinput/ChipInput";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { useTheme } from "../ui/theme.tsx";

const SHAPES: FmtElement[] = [
  { id: "r1", type: "rectangle", label: "API", x: 10, y: 10, width: 70, height: 40 },
  { id: "r2", type: "rectangle", label: "DB", x: 110, y: 20, width: 70, height: 40 },
  { id: "r3", type: "rectangle", x: 210, y: 70, width: 70, height: 40 },
];
const DRAFT = `see ${serializeRef(selectionRef([SHAPES[0]])!)} and ${serializeRef(pointRef(5, 7))} for @bo`;
const INSERTED = "a prompt text\nof two lines";

export function ChipGallery() {
  const { tokens: t } = useTheme();
  const box = useRef<ChipInputHandle>(null);
  const [value, setValue] = useState("");
  const [before, setBefore] = useState("");
  const [calls, setCalls] = useState(0);
  const [keys, setKeys] = useState("");
  const [sent, setSent] = useState(0);
  const [images, setImages] = useState("");
  const [note, setNote] = useState("");
  const [locked, setLocked] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [popup, setPopup] = useState<InsertTarget | null>(null);
  const [popups, setPopups] = useState(0); // (counts the popups opened: each is drawn anew, with the focus in its field)
  const beforeRef = useRef("");
  beforeRef.current = before;
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  const selected = SHAPES.filter((s) => picked.includes(s.id));

  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(""), 2500); return () => clearTimeout(id); }, [note]);
  // (the checks drive the box by its handle, and answer the popup themselves: PL5.1 puts any text in, `window.__aiwbChip` and `window.__aiwbInsert`)
  useEffect(() => { (window as unknown as { __aiwbChip?: unknown }).__aiwbChip = box.current; });
  useEffect(() => onInsertPopup((t) => { ((window as unknown as { __aiwbInsert?: InsertTarget[] }).__aiwbInsert ??= []).push(t); setPopup(t); setPopups((n) => n + 1); }), []);

  const addSelection = () => {
    const ref = selectionRef(selected);
    if (!ref) { setNote("Select something on the board first"); return; }
    setNote("");
    box.current?.insertRef(ref);
  };
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // ⌘L and ⌘⇧L through the keys port (a handler of the window, as the composer's), Esc ends the wait for a point.
  const act = useRef({ addSelection, picked });
  act.current = { addSelection, picked };
  useEffect(() => onKey((e) => {
    if (e.key === "Escape" && pickingRef.current) { e.preventDefault(); setPicking(false); return; }
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.code !== "KeyL") return;
    e.preventDefault(); e.stopPropagation();
    if (e.shiftKey) setPicking((p) => !p); else act.current.addSelection();
  }), []);

  return (
    <View style={styles.col}>
      <View style={[styles.box, { borderColor: t.line2, backgroundColor: readOnly ? t.panel : t.bg }]}>
        <ChipInput
          ref={box}
          testID="composer-input"
          placeholder="Message… (⌘L adds the selection)"
          locked={locked}
          readOnly={readOnly}
          onChange={(v, b) => { setValue(v); setBefore(b); setCalls((n) => n + 1); }}
          onKey={(e) => {
            setKeys(`${e.key}${e.shiftKey ? "+shift" : ""}`);
            // the @ list's Tab: completes the name being typed
            if (e.key === "Tab" && /@bo$/.test(beforeRef.current)) { box.current?.replaceBeforeCaret(3, "@board "); return true; }
            if (e.key === "Enter" && !e.shiftKey) { setSent((n) => n + 1); return true; }
            return e.key === "Escape";
          }}
          onImages={(files) => setImages(files.map((f) => f.name).join(", "))}
        />
      </View>
      <View style={styles.row}>
        <Button size="sm" testID="gallery-chip-locked" label="Locked" on={locked} onPress={() => setLocked((x) => !x)} />
        <Button size="sm" testID="gallery-chip-readonly" label="Read-only" on={readOnly} onPress={() => setReadOnly((x) => !x)} />
        <Button size="sm" testID="gallery-chip-set" label="Set a draft" onPress={() => box.current?.set(DRAFT)} />
        <Button size="sm" testID="gallery-chip-clear" label="Clear" onPress={() => box.current?.set("")} />
        <Button size="sm" testID="gallery-chip-insert-point" label="Insert a point" onPress={() => box.current?.insertRef(pointRef(120.4, -39.6))} />
        <Button size="sm" testID="gallery-chip-open-insert" label="Insert…" onPress={() => box.current?.openInsert()} />
      </View>
      {popup ? (
        <View key={popups} style={styles.row} testID="gallery-chip-popup">
          <Text tone="muted">Insert popup</Text>
          <TextInput testID="gallery-chip-popup-field" autoFocus placeholder="search" style={[styles.field, { borderColor: t.line2, color: t.text }]} />
          <Button size="sm" tone="primary" testID="gallery-chip-popup-do" label="Insert the prompt" onPress={() => { popup.insert(INSERTED); setPopup(null); }} />
          <Button size="sm" testID="gallery-chip-popup-cancel" label="Cancel" onPress={() => { popup.cancel(); setPopup(null); }} />
        </View>
      ) : null}

      <Text tone="muted" size={11}>The board the references point at</Text>
      <View testID="gallery-board" style={[styles.board, { borderColor: t.line2, backgroundColor: t.panel }]}>
        {SHAPES.map((s) => (
          <Pressable key={s.id} testID="gallery-shape" accessibilityRole="button" accessibilityState={{ selected: picked.includes(s.id) }}
            onPress={() => toggle(s.id)}
            style={[styles.shape, { left: s.x, top: s.y, width: s.width, height: s.height, borderColor: picked.includes(s.id) ? t.accent : t.line2, backgroundColor: picked.includes(s.id) ? t.accentSoft : t.bg }]}>
            <Text size={11}>{s.label ?? s.type}</Text>
          </Pressable>
        ))}
        {picking ? (
          <Pressable testID="pick-layer" style={[StyleSheet.absoluteFill, styles.layer, { borderColor: t.accent }]}
            onPress={(e) => {
              // (react-native gives the place of the press as locationX / locationY, react-native-web the click's offsetX / offsetY)
              const at = e.nativeEvent as unknown as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
              box.current?.insertRef(pointRef(at.locationX ?? at.offsetX ?? 0, at.locationY ?? at.offsetY ?? 0, SHAPES));
              setPicking(false);
            }} />
        ) : null}
      </View>
      <View style={styles.row}>
        <Button size="sm" tone="ghost" testID="ctx-selection" disabled={!selected.length} label={selected.length ? `+ ${selected.length} selected` : "+ Selection"} onPress={addSelection} />
        <Button size="sm" tone="ghost" testID="ctx-point" on={picking} dataSet={{ on: picking }} label="+ Point" onPress={() => setPicking((p) => !p)} />
        <Text testID="gallery-chip-note" tone="muted">{note}</Text>
      </View>

      <Text testID="gallery-chip-mode" tone="faint" size={11}>{[locked && "locked", readOnly && "read-only"].filter(Boolean).join(" ")}</Text>
      <Text testID="gallery-chip-value" tone="faint" mono size={11}>{value}</Text>
      <Text testID="gallery-chip-before" tone="faint" mono size={11}>{before}</Text>
      <Text testID="gallery-chip-calls" tone="faint" size={11}>{String(calls)}</Text>
      <Text testID="gallery-chip-keys" tone="faint" size={11}>{keys}</Text>
      <Text testID="gallery-chip-sent" tone="faint" size={11}>{String(sent)}</Text>
      <Text testID="gallery-chip-images" tone="faint" size={11}>{images}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  field: { borderWidth: 1, borderRadius: 6, paddingVertical: 3, paddingHorizontal: 8, minWidth: 80 },
  box: { borderWidth: 1, borderRadius: 10, paddingVertical: 6, paddingLeft: 10, paddingRight: 6, maxWidth: 520 },
  board: { width: 300, height: 130, borderWidth: 1, position: "relative" },
  shape: { position: "absolute", borderWidth: 1, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  layer: { borderWidth: 2, backgroundColor: "rgba(105, 101, 219, .06)", zIndex: 5 },
});
