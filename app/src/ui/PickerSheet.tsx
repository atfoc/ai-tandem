// P2, the picker sheet (ux-improvements goal 3.1.4): choosing one value. A centred title and a sub-line saying what is chosen and
// for what; 50 pt rows, a second line per option (its note, or why it cannot be chosen), the chosen one tinted with an accent ✓
// (no focus ring); a tap chooses and closes. Done at the right only when the sheet holds more than one control (`extra`); Cancel at
// the left only in a flow that commits with a button. Past eight options it opens on the large detent with a search pinned in the
// head (it stays while the list scrolls); otherwise it is a `fit` sheet. A picker over a form sheet says `over="form"`.
// Phone only (goal 4.2): the wide layouts keep their popovers.
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Menu, MenuHead, MenuItem } from "./Menu.tsx";
import { PHONE, TYPE } from "./metrics.ts";
import { emptyLine, filterOptions, groupBySection, searchOn } from "./pickerlogic.ts";
import { SearchField } from "./SearchField.tsx";
import { Sheet } from "./Sheet.tsx";
import { SheetHead, type HeadAction } from "./SheetHead.tsx";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

export type PickerOption<T extends string> = {
  value: T;
  label: string;
  note?: string;
  icon?: ReactNode;
  /** Listed dimmed, with the reason ("Not installed on Build box"). */
  disabledReason?: string;
  /** A heading the option falls under (the model picker's providers). Options of one section are consecutive. */
  section?: string;
};

export type PickerSheetProps<T extends string> = {
  open: boolean;
  onClose(): void;
  title: string;
  sub?: string;
  options: PickerOption<T>[];
  value: T | null;
  /** A tap picks; the sheet closes unless `extra` is given (then Done closes). */
  onPick(value: T): void;
  /** More controls under the list (the effort of the model picker, the cap of the subagents): Done appears. */
  extra?: ReactNode;
  /** A line under the list that is no control (the agent picker's "A new agent starts with its own default model and effort."): no Done. */
  foot?: ReactNode;
  /** Only in a flow that commits with a button (the folder browser). */
  cancel?: HeadAction;
  /** Search: forced on or off; by default on past eight options. */
  search?: boolean;
  searchPlaceholder?: string;
  /** This picker opens over a form sheet (P3): the one sheet over a sheet that is allowed. */
  over?: "form";
  testID?: string;
};

export function PickerSheet<T extends string>(p: PickerSheetProps<T>) {
  const t = useTokens();
  const [q, setQ] = useState("");
  useEffect(() => { if (!p.open) setQ(""); }, [p.open]);
  const searching = searchOn(p.options.length, p.search);
  const shown = searching ? filterOptions(p.options, q) : p.options;
  const head = (
    <>
      <SheetHead title={p.title} sub={p.sub} left={p.cancel} right={p.extra ? { label: "Done", strong: true, onPress: p.onClose } : undefined} />
      {searching ? <View style={styles.search}><SearchField value={q} onChangeText={setQ} placeholder={p.searchPlaceholder ?? "Search"} /></View> : null}
    </>
  );
  return (
    <Sheet open={p.open} onClose={p.onClose} label={p.title} testID={p.testID ?? TID.pickerSheet} detent={searching ? "large" : "fit"} over={p.over} head={head}>
      {shown.length === 0 && q.trim() ? (
        <View {...tid(TID.pickerEmpty)} style={styles.empty}><Text size={TYPE.control} tone="muted">{emptyLine(q)}</Text></View>
      ) : (
        <Menu label={p.title}>
          {groupBySection(shown).map((g, i) => [
            g.section ? <MenuHead key={"h" + i}>{g.section}</MenuHead> : null,
            ...g.options.map((o) => (
              <MenuItem key={o.value} {...tid(TID.pickerRow, { value: o.value })} choice selected={o.value === p.value} label={o.label}
                icon={o.icon} note={o.disabledReason ?? o.note} disabled={!!o.disabledReason}
                trailing={o.value === p.value ? <Text {...tid(TID.pickerCheck)} size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text> : undefined}
                onPress={() => { p.onPick(o.value); if (!p.extra) p.onClose(); }} />
            )),
          ])}
        </Menu>
      )}
      {p.extra ? <View {...tid(TID.pickerExtra)} style={[styles.extra, { borderTopColor: t.line }]}>{p.extra}</View> : null}
      {p.foot ? <View {...tid(TID.pickerFoot)} style={[styles.extra, { borderTopColor: t.line }]}>{p.foot}</View> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  search: { paddingTop: 8, paddingBottom: 8 },
  empty: { paddingVertical: 24, paddingHorizontal: PHONE.margin - 8, alignItems: "center" },
  extra: { paddingHorizontal: PHONE.margin - 8, paddingTop: 12, paddingBottom: 4, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth },
});
