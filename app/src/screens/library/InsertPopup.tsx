// The insert popup (the old page's Library.tsx `InsertPopup`; C-PL-20 to C-PL-29, C-PL-31, C-PL-34): the search and the list of the prompts of every library, nothing else
// but the way to the library popup. It is opened for a text box (core's `openInsertPopup`) and puts the picked prompt's text where that box's caret was, or
// closes with the box as it was. A centred dialog on the wide layouts and a bottom sheet on the phone (Overlay; the old popup stood near the top of the
// window, and an `InsertTarget` carries no place to hang a popover from). The words, the keys and the order are the same.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { libraryTrees, moveIn, promptList, textLine, type Hit } from "@aiwb/core/logic/libraryview.ts";
import type { InsertTarget } from "@aiwb/core/logic/insert.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { Button } from "../../ui/Button.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { PromptLine, SearchField } from "./parts.tsx";
import { PromptSheet } from "./phone/PromptSheet.tsx";
import { useLibraries } from "./useLibraries.ts";

export const INSERT_POPUP_ID = "insert-popup";

/** The phone draws the Prompt sheet (phone/PromptSheet.tsx); the wide layouts the dialog below. */
export function InsertPopup({ target }: { target: InsertTarget }) {
  return usePhone() ? <PromptSheet target={target} /> : <InsertDialog target={target} />;
}

function InsertDialog({ target }: { target: InsertTarget }) {
  const t = useTokens();
  const pointer = usePointer();
  const libs = useLibraries();
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null); // the key of the highlighted prompt; null = the first of the list
  const rows = useMemo(() => promptList(trees, query), [trees, query]);
  const any = useMemo(() => promptList(trees, "").length > 0, [trees]);
  const found = rows.findIndex((r) => r.key === picked), hi = found >= 0 ? found : rows.length ? 0 : -1;
  const input = useRef<TextInput>(null), scroll = useRef<ScrollView>(null);
  const view = useRef({ top: 0, height: 0 }), rowAt = useRef<Record<number, { y: number; h: number }>>({});
  const listId = useId();
  // The box takes the focus as it is told, while the popup is still on screen: the popup leaves a focus that is outside it alone (ui/modal.web.tsx).
  const close = (text?: string) => {
    if (getState().insertPopup !== target) return;
    setState({ insertPopup: null });
    if (text === undefined) target.cancel(); else target.insert(text);
  };
  // The library popup takes the box over: it gives the focus and the caret back when it closes.
  const toLibrary = () => { if (getState().insertPopup === target) setState({ insertPopup: null, libraryDialog: { back: target } }); };
  // The highlighted row stays in sight as it moves.
  useEffect(() => {
    const r = rowAt.current[hi], v = view.current;
    if (hi < 0 || !r || !v.height) return;
    if (r.y < v.top) scroll.current?.scrollTo({ y: r.y, animated: false });
    else if (r.y + r.h > v.top + v.height) scroll.current?.scrollTo({ y: r.y + r.h - v.height, animated: false });
  }, [hi, rows]);
  const key = (e: { nativeEvent: { key: string }; preventDefault(): void }) => {
    const k = e.nativeEvent.key;
    if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); setPicked(rows[moveIn(rows.length, hi, k === "ArrowDown" ? 1 : -1)]?.key ?? null); return; }
    if (k !== "Enter") return;
    e.preventDefault();
    enter();
  };
  const enter = () => { if (hi >= 0) close(rows[hi].prompt.text); else if (!any) toLibrary(); };
  return (
    <Overlay open kind="dialog" label="Insert a prompt" width={560} testID={INSERT_POPUP_ID} onClose={() => close()}>
      <View {...tid("insert-body")}>
        <SearchField ref={input} testID="insert-search" autoFocus combobox controls={listId} active={hi >= 0 ? `${listId}-${hi}` : undefined} value={query}
          onChange={(v) => { setQuery(v); setPicked(null); }} onKeyPress={key} onSubmit={enter} size={13} />
        <ScrollView ref={scroll} {...tid("insert-list")} nativeID={listId} role={"listbox" as never} aria-label="Prompts" style={styles.list} keyboardShouldPersistTaps="handled" nestedScrollEnabled
          onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; }} onScroll={(e) => { view.current.top = e.nativeEvent.contentOffset.y; }} scrollEventThrottle={32}>
          {!any ? (
            <View {...tid("insert-empty")} style={styles.empty}>
              <Text tone="muted">The library has no prompts yet.</Text>
              <Button size="sm" tone="primary" testID="insert-open-library" label="Open the library" onPress={toLibrary} />
            </View>
          ) : !rows.length ? <Text {...tid("insert-none")} size={12} tone="muted" style={styles.none}>No matching prompts</Text> : rows.map((h, i) => (
            <Row key={h.key} id={`${listId}-${i}`} h={h} active={i === hi} onHover={() => { if (pointer === "mouse" && i !== hi) setPicked(h.key); }}
              onLaid={(y, hh) => { rowAt.current[i] = { y, h: hh }; }} onPress={() => close(h.prompt.text)} />
          ))}
        </ScrollView>
        <View {...tid("insert-foot")} style={[styles.foot, { borderTopColor: t.line }]}>
          <Text size={11} tone="faint" style={styles.hint}>↑↓ to choose · Enter to insert · Esc to close</Text>
          {any ? <Button size="sm" testID="insert-edit-library" label="Edit the library" onPress={toLibrary} /> : null}
        </View>
      </View>
    </Overlay>
  );
}

function Row({ id, h, active, onHover, onLaid, onPress }: { id: string; h: Hit; active: boolean; onHover(): void; onLaid(y: number, h: number): void; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable nativeID={id} {...tid("insert-row", { key: h.key, server: h.server })} role="option" aria-selected={active} accessibilityState={{ selected: active }} focusable={false} tabIndex={-1}
      {...({ onMouseMove: onHover } as object)} onPress={onPress} onLayout={(e) => onLaid(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      style={[styles.row, active && { backgroundColor: t.hover2, boxShadow: `inset 0 0 0 2px ${t.accent}` }, webStyle({ cursor: "default" })]}>
      <View style={styles.head}><PromptLine h={h} /></View>
      <Text {...tid("insert-text")} size={12} tone="muted" numberOfLines={1} style={styles.text}>{textLine(h.prompt.text) || "(no text)"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 8, maxHeight: 360, flexGrow: 0 },
  row: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  text: { marginTop: 1 },
  none: { padding: 10, textAlign: "center" },
  empty: { alignItems: "center", gap: 10, paddingVertical: 22, paddingHorizontal: 12 },
  foot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 26, marginTop: 8, paddingTop: 8, paddingHorizontal: 2, borderTopWidth: 1 },
  hint: { flexShrink: 1 },
});
