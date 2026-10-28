// The model and effort menu (plans/model-effort-menu/design.md, 2.1 to 2.3 and 3.2): one menu for the chat's model and its effort, the same on
// every layout. Top to bottom: the head (title and Done), the held line when a pick cannot be taken now, the search field, the effort (fixed: it
// never scrolls, and its slot keeps one height between a model with efforts and one without), the list of models (the only part that scrolls,
// under provider headings when the catalog names more than one) and, in the desktop's popover, a line of key hints.
//
// It holds a draft (core's MenuState, logic/modeleffort.ts): it opens on the chat's current choice, a press on a row or a segment, ↑ ↓ Tab
// Shift+Tab and typing change the draft only, and Enter or Done applies it in one write (`onApply`, only when something differs) and closes.
// Esc, a click outside, a swipe of the sheet and Cancel close and apply nothing. The keys are the search field's (`onKeyPress`: react-native-web
// gives the keydown there, Tab and the arrows included), so the field has the focus while the menu is open on the desktop; on the phone a tap
// on the chip does not focus it (`focusSearch`), the soft keyboard would cover the sheet.
//
// This file draws the desktop's popover (`ModelEffortPopover`, an Overlay hung above the model chip) and holds the pieces the phone's sheet
// (phone/chips/ModelSheet.tsx) is made of: the draft (`useModelEffortMenu`), the field, the effort section, the list and the held line. The popover
// has compact rows (Picker.tsx's look); the sheet the 50-pt rows of the phone's pickers (ui/PickerSheet.tsx's look).
import { useEffect, useId, useRef, useState, type MutableRefObject, type ReactElement, type RefObject } from "react";
import {
  Platform, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions,
  type NativeScrollEvent, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle, type ViewProps,
} from "react-native";

import {
  applyPatch, canApply, menuKey, moveModel, openMenu, pickEffort, pickModel, stepEffort, typeQuery, type MenuState,
} from "@aiwb/core/logic/modeleffort.ts";
import type { Choice } from "@aiwb/core/logic/models.ts";
import type { Catalog, CatalogModel } from "@aiwb/core/types.ts";

import { Button } from "../../ui/Button.tsx";
import { MenuEmpty, MenuGroupHead, MenuHead, MenuItem } from "../../ui/Menu.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text, BASE_SIZE } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { effortLabel } from "./model.ts";
import { C2_IDS } from "./phone/chips/ids.ts";
import { menuSections, modelNote, type MenuSection } from "./phone/chips/modelrows.ts";
import { Segmented, segmentedHeight } from "./phone/chips/Segmented.tsx";

// (react-native's Role list has no listbox; react-native-web draws any role it is given)
const LISTBOX = "listbox" as unknown as NonNullable<ViewProps["role"]>;

export const MODEL_MENU_TITLE = "Model and effort";
/** The testIDs of the menu (design 3.3); the effort control and its line keep the phone's C2_IDS.effort and C2_IDS.effortLine. */
export const MENU_IDS = {
  popover: "model-menu",
  search: "model-menu-search",
  clear: "model-menu-clear",
  row: "model-menu-row",
  empty: "model-menu-empty",
  held: "model-menu-held",
  done: "model-menu-done",
  cancel: "model-menu-cancel",
  keys: "model-menu-keys",
} as const;
const KEY_HINTS = "↑↓ Model · Tab Effort · Enter Apply · Esc Cancel";
const EFFORT_LINE = "More effort thinks longer and uses more of your plan.";
const NO_EFFORT = "This model has no effort setting.";

export type ModelEffortMenuProps = {
  /** The draft is (re)made from `value` each time it opens, and applying writes what differs from that `value` (not from a later one). */
  open: boolean;
  cat: Catalog;
  /** The current choice. */
  value: Choice;
  /** Why no pick is taken now ("" when one is): rows, segments and Done are off, Enter does nothing. */
  held: string;
  /** Give the search field the focus as it opens. */
  focusSearch: boolean;
  /** Only called with a non-null patch; the menu closes itself after (onClose). */
  onApply(patch: { model?: string; effort?: string }, choice: Choice): void;
  /** Cancel (Esc, outside, swipe, Cancel), and also called after onApply. */
  onClose(): void;
};

/** The menu's draft and what acts on it, for the popover and the sheet. */
export type ModelEffortMenu = ReturnType<typeof useModelEffortMenu>;

export function useModelEffortMenu(p: ModelEffortMenuProps) {
  const [s, setS] = useState<MenuState>(() => openMenu(p.value));
  // The draft is made as the menu opens, in the render that opens it (no frame with the last draft).
  const [wasOpen, setWasOpen] = useState(p.open);
  if (wasOpen !== p.open) {
    setWasOpen(p.open);
    if (p.open) setS(openMenu(p.value));
  }
  const field = useRef<TextInput>(null);
  const scroll = useRef<ScrollView | null>(null);
  const view = useRef({ top: 0, height: 0 });
  const rowAt = useRef<Record<string, { y: number; h: number }>>({});
  const drafted = useRef(s.draft.model);
  drafted.current = s.draft.model;
  const held = !!p.held;
  const cat = p.cat;

  const sections = menuSections(cat.models, s.query);
  const listed = sections.flatMap((g) => g.models);
  const model: CatalogModel | undefined = cat.models.find((m) => m.id === s.draft.model);
  const ok = !held && canApply(s, cat);

  const apply = () => {
    if (!ok) return;
    const patch = applyPatch(s.base, s.draft); // (against the choice it opened with: the chat may have changed meanwhile, from another window)
    if (patch) p.onApply(patch, s.draft);
    p.onClose();
  };
  const type = (q: string) => setS((x) => typeQuery(x, q, cat));
  const pickRow = (id: string) => { if (!held) setS((x) => pickModel(x, id, cat)); };
  const pickSeg = (effort: string) => { if (!held) setS((x) => pickEffort(x, effort)); };
  const onKey = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const a = menuKey(e.nativeEvent as Parameters<typeof menuKey>[0]);
    if (!a || (a === "apply" && Platform.OS !== "web")) return; // (iOS and Android: the return key's submit applies, onSubmitEditing)
    e.preventDefault();
    if (a === "cancel") return p.onClose();
    if (a === "apply") return apply();
    if (a === "effortNext" || a === "effortPrev") field.current?.focus(); // (Tab stays in the field, whatever the overlay's own Tab did)
    if (held) return;
    setS((x) => (a === "next" ? moveModel(x, 1, cat) : a === "prev" ? moveModel(x, -1, cat) : stepEffort(x, a === "effortNext" ? 1 : -1, cat)));
  };

  // The drafted row stays in sight inside the scrolling list as the draft moves, the query changes or the menu opens; also once its row or the
  // list is laid out (they are not, the first time the draft is looked at).
  const reveal = () => {
    const r = rowAt.current[drafted.current], v = view.current;
    if (!r || !v.height) return;
    if (r.y < v.top) scroll.current?.scrollTo({ y: r.y, animated: false });
    else if (r.y + r.h > v.top + v.height) scroll.current?.scrollTo({ y: r.y + r.h - v.height, animated: false });
  };
  useEffect(() => { if (p.open) reveal(); }, [p.open, s.draft.model, s.query]);
  useEffect(() => {
    if (!p.open) { rowAt.current = {}; view.current = { top: 0, height: 0 }; return; }
    if (!p.focusSearch) return;
    const t = setTimeout(() => field.current?.focus(), 50); // (after the overlay's own focus rule, ui/modal.web.tsx)
    return () => clearTimeout(t);
  }, [p.open]);
  const list = {
    scroll: scroll as MutableRefObject<ScrollView | null>,
    onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { view.current.top = e.nativeEvent.contentOffset.y; },
    onViewport: (h: number) => { view.current.height = h; reveal(); },
    onRow: (id: string, y: number, h: number) => { rowAt.current[id] = { y, h }; if (id === drafted.current) reveal(); },
  };

  return { s, sections, listed, model, ok, held, reason: p.held, field, apply, type, pickRow, pickSeg, onKey, list, cat, focusSearch: p.focusSearch };
}

/** The search field, with its × while it holds text; the menu's keys are its keys. */
export function MenuField({ menu, phone, listId, activeId }: { menu: ModelEffortMenu; phone?: boolean; listId?: string; activeId?: string }) {
  const { tokens: t } = useTheme();
  const q = menu.s.query;
  return (
    <View style={phone ? styles.searchPhone : styles.search}>
      <View style={[styles.fieldRow, phone && [styles.boxPhone, { backgroundColor: t.panel }]]}>
        {/* (keepsTab: the overlay's Tab trap, ui/modal.web.tsx, leaves Tab to the field, which steps the effort with it) */}
        <TextInput ref={menu.field} {...tid(MENU_IDS.search, { keepsTab: true })} autoFocus={menu.focusSearch} value={q} onChangeText={menu.type} placeholder="Search models"
          placeholderTextColor={t.faint} accessibilityLabel="Search models" autoCorrect={false} autoCapitalize="none" spellCheck={false} returnKeyType="done"
          role="combobox" aria-expanded aria-autocomplete="list" aria-controls={listId} aria-activedescendant={activeId}
          onKeyPress={menu.onKey} onSubmitEditing={Platform.OS === "web" ? undefined : menu.apply}
          style={[phone ? styles.inputPhone : [styles.field, { borderColor: t.line2, backgroundColor: t.bg }], { color: t.text },
            webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
        {q ? (
          <Pressable {...tid(MENU_IDS.clear)} role="button" accessibilityLabel="Clear search" focusable={false}
            onPress={() => { menu.type(""); menu.field.current?.focus(); }}
            style={[phone ? styles.clearPhone : styles.clear, webStyle({ cursor: "pointer" })]}>
            <Text size={phone ? TYPE.control : 14} tone={phone ? "muted" : "faint"}>{phone ? "✕" : "×"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** The effort of the drafted model: its label, the segmented control and the line on what effort costs. A drafted model with no efforts keeps
 *  the slot's height and says so in it. Not drawn when no model of the catalog has efforts. */
export function EffortSection({ menu, phone }: { menu: ModelEffortMenu; phone?: boolean }) {
  if (!menu.cat.models.some((m) => m.efforts?.length)) return null;
  const m = menu.model;
  const efforts = m?.efforts ?? [];
  const size = phone ? undefined : "sm";
  const small = phone ? TYPE.secondary : 11;
  return (
    <View style={phone ? styles.effortPhone : styles.effort}>
      <Text size={small} tone="muted" weight={phone ? undefined : "600"} style={phone ? styles.effortLabelPhone : styles.effortLabel}>Effort</Text>
      <View>
        {efforts.length ? (
          <>
            <Segmented label="Effort" testID={C2_IDS.effort} size={size} disabled={menu.held} value={menu.s.draft.effort ?? null} onChange={menu.pickSeg}
              options={efforts.map((e) => ({ value: e, label: effortLabel(e, m) }))} />
            <Text {...tid(C2_IDS.effortLine)} size={small} tone={phone ? "muted" : "faint"} style={phone ? styles.linePhone : styles.line}>{EFFORT_LINE}</Text>
          </>
        ) : (
          <>
            {/* (the slot of a model with efforts, unseen, so that the list under it does not move) */}
            <View aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.unseen}>
              <View style={{ height: segmentedHeight(size) }} />
              <Text size={small} style={phone ? styles.linePhone : styles.line}>{EFFORT_LINE}</Text>
            </View>
            <View style={[StyleSheet.absoluteFill, styles.noEffort]}>
              <Text {...tid(C2_IDS.effortLine)} size={small} tone="muted">{NO_EFFORT}</Text>
            </View>
          </>
        )}
      </View>
    </View>
  );
}

/** Why no pick is taken now. */
export function HeldLine({ menu, phone }: { menu: ModelEffortMenu; phone?: boolean }) {
  return menu.reason ? (
    <Text {...tid(MENU_IDS.held)} size={phone ? TYPE.secondary : 11.5} tone="muted" style={phone ? styles.heldPhone : styles.held}>{menu.reason}</Text>
  ) : null;
}

/** The models listed under the search, in runs under their provider's heading; "No matching models" when the search leaves none. The caller
 *  scrolls it (the popover's own scroll view, the sheet's body) and gives `menu.list` to that scroll view. */
export function ModelList({ menu, phone, rowId }: { menu: ModelEffortMenu; phone?: boolean; rowId?(i: number): string }) {
  if (!menu.listed.length) {
    const text = menu.cat.models.length ? "No matching models" : "No models";
    return phone
      ? <View {...tid(MENU_IDS.empty)} style={styles.emptyPhone}><Text size={TYPE.control} tone="muted">{text}</Text></View>
      : <View {...tid(MENU_IDS.empty)}><MenuEmpty>{text}</MenuEmpty></View>;
  }
  let i = 0;
  const row = (m: CatalogModel) => {
    const on = m.id === menu.s.draft.model, at = i++;
    const props = {
      key: m.id, m, on, disabled: menu.held, id: rowId?.(at), onPress: () => menu.pickRow(m.id),
      onLayout: (y: number, h: number) => menu.list.onRow(m.id, y, h),
    };
    return phone ? <PhoneRow {...props} /> : <PickRow {...props} />;
  };
  // (flat, headings and rows side by side: a row's layout y is its place in the scrolling content)
  return <>{menu.sections.map((g: MenuSection) => [g.provider ? (phone ? <MenuHead key={"h" + g.provider}>{g.provider}</MenuHead> : <MenuGroupHead key={"h" + g.provider}>{g.provider}</MenuGroupHead>) : null, ...g.models.map(row)])}</>;
}

type RowProps = { m: CatalogModel; on: boolean; disabled: boolean; id?: string; onPress(): void; onLayout(y: number, h: number): void };

/** The popover's row (Picker.tsx's): the label, its note under it, ✓ and the keyboard's ring on the drafted one. */
function PickRow({ m, on, disabled, id, onPress, onLayout }: RowProps) {
  const { tokens: t } = useTheme();
  const note = modelNote(m);
  return (
    <Pressable nativeID={id} {...tid(MENU_IDS.row, { model: m.id, on, active: on })} role="option" aria-selected={on} disabled={disabled} focusable={false}
      accessibilityLabel={m.label} onPress={onPress} onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.row, { backgroundColor: on || hovered || pressed ? t.accentSoft : "transparent" },
        on && { boxShadow: `inset 0 0 0 2px ${t.accent}` }, disabled && styles.disabled, webStyle({ cursor: disabled ? "default" : "pointer" }),
      ]}>
      <View style={styles.text}>
        <Text style={styles.label}>{m.label}</Text>
        {note ? <Text size={11} tone="faint">{note}</Text> : null}
      </View>
      {on ? <Text tone="accent" style={styles.tick}>✓</Text> : null}
    </Pressable>
  );
}

/** The sheet's row (ui/PickerSheet.tsx's): 50 pt, the label at 17 pt, its note under it, the drafted one tinted with an accent ✓. */
function PhoneRow({ m, on, disabled, onPress, onLayout }: RowProps) {
  return (
    <MenuItem {...tid(MENU_IDS.row, { model: m.id, on, active: on })} choice selected={on} label={m.label} note={modelNote(m) || undefined} disabled={disabled}
      trailing={on ? <Text size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text> : undefined}
      onPress={onPress} onLayout={(e) => onLayout(e.nativeEvent.layout.y, e.nativeEvent.layout.height)} />
  );
}

/** The desktop's popover, hung above the model chip. `keyName`: the key that opens it ("⌘E", "Ctrl+E"), shown in its head. */
export function ModelEffortPopover(p: ModelEffortMenuProps & { anchor: RefObject<View | null>; keyName: string }): ReactElement {
  const { tokens: t } = useTheme();
  const win = useWindowDimensions();
  const menu = useModelEffortMenu(p);
  const listId = useId();
  const rowId = (i: number) => `${listId}-row-${i}`;
  const at = menu.listed.findIndex((m) => m.id === menu.s.draft.model);
  return (
    <Overlay open={p.open} onClose={p.onClose} label={MODEL_MENU_TITLE} kind="popover" anchor={p.anchor} up testID={MENU_IDS.popover}>
      <View style={styles.popover}>
        <View style={styles.head}>
          <View style={styles.title}><MenuHead>{MODEL_MENU_TITLE}</MenuHead></View>
          {p.keyName ? <Text size={11} tone="faint">{p.keyName}</Text> : null}
          <Button {...tid(MENU_IDS.done)} size="sm" tone="primary" label="Done" disabled={!menu.ok} onPress={menu.apply} />
        </View>
        <HeldLine menu={menu} />
        <MenuField menu={menu} listId={listId} activeId={at >= 0 ? rowId(at) : undefined} />
        <EffortSection menu={menu} />
        <ScrollView ref={(r) => { menu.list.scroll.current = r; }} nativeID={listId} role={LISTBOX} aria-label="Models"
          style={[styles.list, { maxHeight: Math.min(320, win.height * 0.4), borderTopColor: t.line }]} keyboardShouldPersistTaps="handled" nestedScrollEnabled
          onLayout={(e) => menu.list.onViewport(e.nativeEvent.layout.height)} onScroll={menu.list.onScroll} scrollEventThrottle={32}>
          <ModelList menu={menu} rowId={rowId} />
        </ScrollView>
        <Text {...tid(MENU_IDS.keys)} size={11} tone="faint" numberOfLines={1} style={[styles.keys, { borderTopColor: t.line }]}>{KEY_HINTS}</Text>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  popover: { width: 360, maxWidth: "100%" },
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingRight: 4 },
  title: { flex: 1, minWidth: 0 },
  held: { paddingHorizontal: 8, paddingBottom: 4 },
  heldPhone: { paddingHorizontal: PHONE.margin, paddingTop: 8 },
  search: { paddingHorizontal: 4, paddingTop: 2, paddingBottom: 4 },
  searchPhone: { paddingHorizontal: PHONE.margin - 8, paddingTop: 8, paddingBottom: 8 },
  fieldRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  boxPhone: { minHeight: PHONE.target, borderRadius: 10, paddingLeft: 12, gap: 0 },
  field: { flex: 1, minWidth: 0, fontSize: 12, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, lineHeight: BASE_SIZE },
  inputPhone: { flex: 1, minWidth: 0, minHeight: PHONE.target, fontSize: TYPE.control, paddingVertical: 0 },
  clear: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 5 },
  clearPhone: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" },
  effort: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  effortPhone: { paddingHorizontal: PHONE.margin - 8, paddingBottom: 12 },
  effortLabel: { textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 },
  effortLabelPhone: { marginBottom: 8 },
  line: { marginTop: 4 },
  linePhone: { marginTop: 10 },
  unseen: { opacity: 0 },
  noEffort: { justifyContent: "center" },
  list: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 6, paddingLeft: 10, paddingRight: 8, borderRadius: 5, alignSelf: "stretch", minHeight: 30 },
  text: { flex: 1, minWidth: 0 },
  label: { flexShrink: 1 },
  tick: { flexShrink: 0 },
  disabled: { opacity: 0.5 },
  emptyPhone: { paddingVertical: 24, paddingHorizontal: PHONE.margin - 8, alignItems: "center" },
  keys: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
});
