// The Model, Effort and Agent pickers (the old page's Composer.tsx Picker): a chip that opens a list. `searchable` (Model) adds the search field and
// the provider grouping; both modes share the keyboard highlight, the listbox / option roles and the single open list (the toolbar keeps
// which is open). The list is a popover over the chip on the wide layouts and a sheet on the phone (Overlay). `disabled` (a change is being
// saved): the chip opens nothing and keeps the focus a pick gave it. An option that is disabled is listed with its note as the reason and
// takes no pick.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions, type TextStyle, type ViewProps } from "react-native";

import { filterModels, groupModels } from "@aiwb/core/logic/models.ts";

import { onKey } from "../../platform/keys";
import { MenuEmpty, MenuGroupHead, MenuHead } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text, BASE_SIZE } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { Caret, ChipName, TChip, UNTIL_FIRST_MESSAGE } from "./Chip.tsx";

/** One row: a catalog model for Model (id / label / note / provider), or a bare { id, label } for Effort and Agent. */
// (react-native's Role list has no listbox; react-native-web draws any role it is given)
const LISTBOX = "listbox" as unknown as NonNullable<ViewProps["role"]>;

export type PickerOption = { id: string; label: string; note?: string; provider?: string; icon?: ReactNode; disabled?: boolean };

export type PickerProps = {
  kind: string;
  label: string;
  title: string;
  prefix?: string;
  icon?: ReactNode;
  hint?: string;
  options: PickerOption[];
  value: string;
  searchable?: boolean;
  disabled?: boolean;
  /** The cap of the chip's name (the model's is narrower). */
  cap?: number;
  open: boolean;
  onOpenChange(open: boolean): void;
  onPick(id: string): void;
};

export function Picker({ kind, label, title, prefix, icon, hint = UNTIL_FIRST_MESSAGE, options, value, searchable = false, disabled = false, cap, open, onOpenChange, onPick }: PickerProps) {
  const { tokens: t } = useTheme();
  const win = useWindowDimensions();
  const [query, setQuery] = useState(""); // searchable only; never touched by Effort
  const [hi, setHi] = useState(-1); // index into the flattened filtered rows; headings excluded
  const chip = useRef<View>(null);
  const wasOpen = useRef(false);
  const rowFocus = useRef(false); // a row has the focus: its Enter is its own press
  const tabbed = useRef(false); // Tab has been pressed since the list opened: only then is a row's focus the person's (the overlay focuses its first row as it opens)
  const scroll = useRef<ScrollView>(null);
  const field = useRef<TextInput>(null);
  const view = useRef({ top: 0, height: 0 });
  const rowAt = useRef<Record<number, { y: number; h: number }>>({});
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;

  // The flattened rows in render order for a query: grouped by provider when searchable (provider-less first); the Effort picker stays a
  // flat list. The highlight index, the ARIA row ids and the rows drawn all derive from this one sequence so they cannot drift.
  const ordered = (q: string): PickerOption[] => (searchable ? groupModels(filterModels(options, q)).flatMap((g) => g.models) : options);
  const filtered = searchable ? filterModels(options, query) : options;
  const sections = searchable ? groupModels(filtered).map((g) => ({ provider: g.provider, options: g.models })) : [{ provider: "", options }];
  const flat: PickerOption[] = [];
  const rowsOf = sections.map((s) => ({ provider: s.provider, rows: s.options.map((o) => { const i = flat.length; flat.push(o); return { o, i }; }) }));

  const move = (d: number) => { const n = flat.length; if (n) setHi((i) => (i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n)); };
  const pickAt = (i: number) => {
    const o = flat[i];
    if (!o || o.disabled) return; // no highlight: Enter does nothing
    onOpenChange(false);
    if (o.id !== value) onPick(o.id);
  };
  // Typing keeps the selection highlighted when it survives the filter, else highlights the first row.
  const onQuery = (q: string) => {
    setQuery(q);
    const visible = ordered(q);
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
  };

  // On open: start on the selected row (else the first); closing drops the query (the overlay hands the focus back to the chip, ui/modal.web.tsx).
  useEffect(() => {
    rowFocus.current = false; // (a row that had the focus as the list closed is unmounted without a blur: the next list starts with none)
    tabbed.current = false;
    if (!open) {
      if (!wasOpen.current) return;
      wasOpen.current = false;
      if (searchable) setQuery("");
      setHi(-1);
      rowAt.current = {};
      return;
    }
    wasOpen.current = true;
    if (searchable) field.current?.focus();
    const visible = ordered("");
    const i = visible.findIndex((o) => o.id === value);
    setHi(i >= 0 ? i : visible.length ? 0 : -1);
    if (searchable) setQuery("");
  }, [open]);
  // A list that changes under the open menu (a catalog that arrives late) sets the highlight again, by the rule for typing. Compared by ids:
  // Effort gets a new options array on every render.
  const optionIds = options.map((o) => o.id).join("\n");
  useEffect(() => { if (open) onQuery(query); }, [optionIds]);
  // The highlighted row stays visible inside the scroll region as it moves or the list opens.
  useEffect(() => {
    const r = rowAt.current[hi], v = view.current;
    if (!open || hi < 0 || !r || !v.height) return;
    if (r.y < v.top) scroll.current?.scrollTo({ y: r.y, animated: false });
    else if (r.y + r.h > v.top + v.height) scroll.current?.scrollTo({ y: r.y + r.h - v.height, animated: false });
  }, [open, hi]);

  // Effort has no field, so the keys are heard from the keyboard while the list is open (the chip keeps the focus). Enter on a row the person has moved the focus to
  // (by Tab: a list opened from the "more" popup has its first row focused by the overlay, which is no choice) is that row's own press, not a pick of the highlighted one. Esc is the overlay's.
  const now = useRef({ move, pickAt, hi });
  now.current = { move, pickAt, hi };
  useEffect(() => {
    if (!open || searchable) return;
    return onKey((e) => {
      if (e.key === "Tab") tabbed.current = true;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
      if (e.key === "Enter" && rowFocus.current && tabbed.current) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === "ArrowDown") now.current.move(1); else if (e.key === "ArrowUp") now.current.move(-1); else now.current.pickAt(now.current.hi);
    });
  }, [open, searchable]);

  const row = ({ o, i }: { o: PickerOption; i: number }) => (
    <PickRow key={o.id} id={rowId(i)} o={o} on={o.id === value} active={i === hi} searchable={searchable}
      onFocus={(f) => { rowFocus.current = f; }} onPress={() => pickAt(i)}
      onLayout={(y, h) => { rowAt.current[i] = { y, h }; }} />
  );
  const grouped = (s: (typeof rowsOf)[number]) => s.provider ? (
    <View key={s.provider} role="group" aria-label={s.provider}>
      <MenuGroupHead>{s.provider}</MenuGroupHead>
      {s.rows.map(row)}
    </View>
  ) : <View key="__flat">{s.rows.map(row)}</View>;

  return (
    <>
      <TChip kind={kind} title={`${label ? `${title}: ${label}` : title} — ${hint}`} chipRef={chip} disabled={disabled} expanded={open} popup="listbox"
        onPress={() => { if (!disabled) onOpenChange(!open); }}>
        {icon}
        {prefix ? <Text size={12} tone="faint" style={styles.prefix}>{prefix}</Text> : null}
        {label ? <ChipName cap={cap}>{label}</ChipName> : null}
        <Caret />
      </TChip>
      <Overlay open={open} onClose={() => onOpenChange(false)} label={title} kind="popover" anchor={chip} up testID="picker">
        <View style={styles.list} role={LISTBOX} aria-label={title}>
          <MenuHead>{title}</MenuHead>
          {searchable && (
            <View style={styles.search}>
              <TextInput ref={field} {...tid("picker-search")} autoFocus value={query} onChangeText={onQuery} placeholder="Search models" placeholderTextColor={t.faint}
                autoCorrect={false} autoCapitalize="none" spellCheck={false} role="combobox" aria-expanded aria-autocomplete="list" aria-controls={listId}
                aria-activedescendant={hi >= 0 ? rowId(hi) : undefined}
                onKeyPress={(e) => {
                  const k = e.nativeEvent.key;
                  if (k === "ArrowDown") { e.preventDefault(); move(1); } else if (k === "ArrowUp") { e.preventDefault(); move(-1); } else if (k === "Enter") { e.preventDefault(); pickAt(hi); }
                }}
                onSubmitEditing={() => pickAt(hi)}
                style={[styles.field, { color: t.text, borderColor: t.line2, backgroundColor: t.bg }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
              {query ? <ClearButton onPress={() => onQuery("")} /> : null}
            </View>
          )}
          <ScrollView ref={scroll} nativeID={listId} style={{ maxHeight: Math.min(320, win.height * 0.4) }} keyboardShouldPersistTaps="handled" nestedScrollEnabled
            onLayout={(e) => { view.current.height = e.nativeEvent.layout.height; }}
            onScroll={(e) => { view.current.top = e.nativeEvent.contentOffset.y; }} scrollEventThrottle={32}>
            {options.length === 0 ? <MenuEmpty>No models</MenuEmpty>
              : searchable && flat.length === 0 ? <MenuEmpty>No matching models</MenuEmpty>
              : rowsOf.map(grouped)}
          </ScrollView>
        </View>
      </Overlay>
    </>
  );
}

function ClearButton({ onPress }: { onPress(): void }) {
  const ref = useControlRef("Clear search");
  const { tokens: t } = useTheme();
  return (
    <Pressable ref={ref} {...tid("picker-clear")} role="button" accessibilityLabel="Clear search" onPress={onPress} focusable={false} style={styles.clear}>
      <Text size={14} tone="faint" style={{ color: t.faint }}>×</Text>
    </Pressable>
  );
}

function PickRow({ id, o, on, active, searchable, onPress, onFocus, onLayout }: {
  id: string; o: PickerOption; on: boolean; active: boolean; searchable: boolean; onPress(): void; onFocus(focused: boolean): void; onLayout(y: number, h: number): void;
}) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(o.disabled ? o.note : undefined);
  return (
    <Pressable ref={ref} nativeID={id} {...tid("pick-row", { optionId: o.id, model: searchable ? o.id : undefined })} role="option" aria-selected={on} disabled={o.disabled}
      accessibilityLabel={o.label} onPress={onPress} onFocus={() => onFocus(true)} onBlur={() => onFocus(false)}
      onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.row, { backgroundColor: on || hovered || pressed ? t.accentSoft : active ? t.hover2 : "transparent" },
        active && { boxShadow: `inset 0 0 0 2px ${t.accent}` }, o.disabled && styles.disabled, webStyle({ cursor: o.disabled ? "default" : "pointer" }),
      ]}>
      {o.icon}
      <View style={styles.text}>
        <Text numberOfLines={undefined} style={styles.label}>{o.label}</Text>
        {o.note ? <Text size={11} tone="faint">{o.note}</Text> : null}
      </View>
      {on ? <Text style={styles.tick}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { alignSelf: "stretch", minWidth: 220, maxWidth: 320 },
  prefix: { marginRight: 2 },
  search: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 4, paddingTop: 2, paddingBottom: 4 },
  field: { flex: 1, minWidth: 0, fontSize: 12, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, lineHeight: BASE_SIZE },
  clear: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 5 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingLeft: 10, paddingRight: 8, borderRadius: 5, alignSelf: "stretch", minHeight: 30 },
  text: { flex: 1, minWidth: 0 },
  label: { flexShrink: 1 },
  tick: { flexShrink: 0 },
  disabled: { opacity: 0.5 },
});
