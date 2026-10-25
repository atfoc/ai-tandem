// The Prompt picker of the composer on the phone (ux-improvements goal 3.6, mockup "04 Insert a prompt"): the insert popup as a P2-shaped search sheet. The head says
// "Insert a prompt" with Cancel at the left and Library at the right; under it, pinned, a 44 pt search at 17 pt; then the last inserted prompts (Recent, gone while searching)
// and the prompts by folder, each folder a 13 pt section head, each prompt a two-line row (its name, the first line of its text). A tap puts the prompt's text where the box's
// caret was; Cancel, a swipe down, the dimmed page and Android's back leave the box as it was. The words and the testIDs are the wide popup's (InsertPopup.tsx), so PL5.1 and
// PL5.2 read both; its keys too, on the web build (the arrows move a soft tint over the rows, Enter inserts the tinted one, or the first).
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { libraryTrees, moveIn, promptList, textLine, type Hit } from "@aiwb/core/logic/libraryview.ts";
import type { InsertTarget } from "@aiwb/core/logic/insert.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { Button } from "../../../ui/Button.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Sheet } from "../../../ui/Sheet.tsx";
import { SheetHead } from "../../../ui/SheetHead.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { pushScreen } from "../../shell/screens.ts";
import { OffMark, SearchField } from "../parts.tsx";
import { useLibraries } from "../useLibraries.ts";
import { S4_TID } from "./ids.ts";
import { promptSections, rowsOf, type PromptRow } from "./promptlogic.ts";
import { recentPrompts, rememberPrompt } from "./promptrecent.ts";

export function PromptSheet({ target }: { target: InsertTarget }) {
  const t = useTokens();
  const libs = useLibraries();
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null); // the id of the row the arrow keys tinted; null = none yet (Enter takes the first)
  const [recent] = useState(recentPrompts); // (read when the sheet opens, and not again while it is open)
  const sections = useMemo(() => promptSections(trees, recent, query), [trees, recent, query]);
  const rows = useMemo(() => rowsOf(sections), [sections]);
  const any = useMemo(() => promptList(trees, "").length > 0, [trees]);
  const at = rows.findIndex((r) => r.id === picked);
  const els = useRef(new Map<string, unknown>());

  // The box takes the focus as it is told, while the sheet is still on screen (the sheet leaves a focus that is outside it alone).
  const close = (text?: string, row?: PromptRow) => {
    if (getState().insertPopup !== target) return;
    setState({ insertPopup: null });
    if (text === undefined) target.cancel(); else { if (row) rememberPrompt(row.hit.server, row.hit.prompt.id); target.insert(text); }
  };
  // The library is a screen of its own: the sheet closes with the box as it was, and the screen is pushed.
  const toLibrary = () => { if (getState().insertPopup !== target) return; close(); pushScreen("library", {}); };

  // The tinted row stays in sight as it moves (the web build's keys).
  useEffect(() => {
    if (Platform.OS !== "web" || picked === null) return;
    (els.current.get(picked) as { scrollIntoView?(o: object): void } | undefined)?.scrollIntoView?.({ block: "nearest" });
  }, [picked]);

  const enter = () => { const row = at >= 0 ? rows[at] : rows[0]; if (row) close(row.hit.prompt.text, row); else if (!any) toLibrary(); };
  const key = (e: { nativeEvent: { key: string }; preventDefault(): void }) => {
    const k = e.nativeEvent.key;
    if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); setPicked(rows[moveIn(rows.length, at, k === "ArrowDown" ? 1 : -1)]?.id ?? null); return; }
    if (k === "Enter") { e.preventDefault(); enter(); }
  };
  const shown = query.trim();
  const head = (
    <>
      <SheetHead title="Insert a prompt" left={{ label: "Cancel", testID: S4_TID.insertCancel, onPress: () => close() }} right={{ label: "Library", testID: S4_TID.insertLibrary, onPress: toLibrary }} />
      <View style={styles.search}>
        <SearchField phone testID={S4_TID.insertSearch} autoFocus={Platform.OS === "web"} combobox value={query} size={TYPE.control}
          onChange={(v) => { setQuery(v); setPicked(null); }} onKeyPress={key} onSubmit={enter} onClear={() => { setQuery(""); setPicked(null); }} clearTestID="insert-search-clear" />
      </View>
    </>
  );
  return (
    <Sheet open detent="large" label="Insert a prompt" testID={S4_TID.insertPopup} onClose={() => close()} head={head}>
      <View {...tid(S4_TID.insertList)} role={"listbox" as never} aria-label="Prompts">
        {!any ? (
          <View {...tid(S4_TID.insertEmpty)} style={styles.empty}>
            <Text size={TYPE.control} tone="muted" style={styles.centre}>The library has no prompts yet.</Text>
            <Button size="touch" tone="primary" testID={S4_TID.insertOpenLibrary} label="Open the library" onPress={toLibrary} style={styles.centre} />
          </View>
        ) : !rows.length ? (
          <View {...tid(S4_TID.insertNone)} style={styles.empty}>
            <Text size={TYPE.control} tone="muted" style={styles.centre}>{`No prompts match “${shown}”`}</Text>
          </View>
        ) : sections.map((s) => (
          <View key={s.id} role="group" aria-label={s.head || undefined}>
            {s.head ? <Text {...tid(S4_TID.insertSection)} size={TYPE.secondary} weight="600" tone="muted" accessibilityRole="header" style={styles.section}>{s.head}</Text> : null}
            {s.rows.map((r) => (
              <Row key={r.id} row={r} tinted={r.id === picked} line={t.line} setEl={(el) => { if (el) els.current.set(r.id, el); else els.current.delete(r.id); }} onPress={() => close(r.hit.prompt.text, r)} />
            ))}
          </View>
        ))}
      </View>
    </Sheet>
  );
}

function Row({ row, tinted, line, setEl, onPress }: { row: PromptRow; tinted: boolean; line: string; setEl(el: unknown): void; onPress(): void }) {
  const t = useTokens();
  const h: Hit = row.hit;
  return (
    <Pressable ref={setEl as never} {...tid(S4_TID.insertRow, { key: h.key, server: h.server, recent: row.recent ? "true" : undefined })} role="option" aria-selected={tinted} accessibilityState={{ selected: tinted }}
      focusable={false} tabIndex={-1} onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.row, { borderBottomColor: line }, (tinted || pressed) && { backgroundColor: t.hover2 }, webStyle({ cursor: "pointer" })]}>
      <View style={styles.name}>
        <Text {...tid("lib-pname")} size={TYPE.control} numberOfLines={1} style={styles.nameText}>{h.prompt.name}</Text>
        {h.off ? <OffMark size={TYPE.secondary} /> : null}
      </View>
      <Text {...tid("insert-text")} size={TYPE.secondary} tone="muted" numberOfLines={1}>{textLine(h.prompt.text) || "No text"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 8, paddingBottom: 8, paddingHorizontal: PHONE.margin - 8 },
  section: { paddingTop: 16, paddingBottom: 4, paddingHorizontal: PHONE.margin - 8 },
  row: { minHeight: PHONE.sheetRow, justifyContent: "center", paddingVertical: 6, paddingHorizontal: PHONE.margin - 8, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { flexDirection: "row", alignItems: "center", gap: 8 },
  nameText: { flexShrink: 1, minWidth: 0 },
  empty: { alignItems: "center", gap: 16, paddingVertical: 32, paddingHorizontal: PHONE.margin - 8 },
  centre: { textAlign: "center", alignSelf: "center" },
});
