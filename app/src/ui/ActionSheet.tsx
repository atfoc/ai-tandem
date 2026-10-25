// P1, the action sheet (ux-improvements goal 3.1.4): doing something to one thing. A head with the thing's icon, its name and
// "type · place · model"; an optional quick row (a message's Copy, Quote, Read aloud, Select); 50 pt rows, each an icon, a 17 pt label
// and a second line where needed; an action that must wait stays, faded, with its reason; the destructive row last, red, after a
// separator, naming what it deletes. No Cancel row: the grabber, a tap outside, a swipe down and Android's back close it.
// Phone only: the wide layouts keep their popover menus (goal 4.2); a screen picks with `usePhone()`.
//
// It is a Sheet of the `fit` detent (half the window at most, the rows scroll past that) with its head kept above the rows. A press on
// a row runs its `onPress` and then closes the sheet itself (`onClose`): the caller does not close it after an action.
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Menu, MenuItem, MenuSep } from "./Menu.tsx";
import { PHONE, TYPE } from "./metrics.ts";
import { Sheet } from "./Sheet.tsx";
import { SheetHead } from "./SheetHead.tsx";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid, type DataSet } from "./tid.ts";

export type ActionItem = {
  /** Stable: the row's dataSet `action` (checks press rows by it). */
  id: string;
  label: string;
  icon?: ReactNode;
  /** The second line. */
  note?: string;
  /** The action must wait: the row stays, faded, and says why. */
  waitReason?: string;
  /** The row is offered as the likely choice: tinted, with this text as a chip at its end ("In clipboard"). The dataSet gets `tag`. */
  tag?: string;
  /** A 13 pt muted section head drawn before the first row of each new section (rows with none come first, under no head). */
  section?: string;
  onPress(): void;
};

export type ActionSheetProps = {
  open: boolean;
  onClose(): void;
  /** The thing acted on: its tile, its name and "type · place · model". */
  head: { title: string; sub?: string; icon?: ReactNode };
  /** A row of up to four square actions above the list. */
  quick?: ActionItem[];
  items: ActionItem[];
  /** After the items, behind a separator, in the normal tone (a help row). */
  after?: ActionItem[];
  /** Last, red, after a separator; its label names what it deletes ("Delete chat…"). */
  destructive?: ActionItem;
  /** Drawn over the dimmed page, under the sheet (see Sheet): a message lifted out of the thread. */
  lift?: ReactNode;
  testID?: string;
  /** The sheet's dataSet (see Sheet). */
  dataSet?: DataSet;
};

const TILE = 40; // the head's tile
const QUICK_WIDTH = 64;
const QUICK_HEIGHT = 64;

export function ActionSheet({ open, onClose, head, quick, items, after, destructive, lift, testID = TID.actionSheet, dataSet }: ActionSheetProps) {
  const t = useTokens();
  const run = (a: ActionItem) => () => { a.onPress(); onClose(); };
  const row = (a: ActionItem, danger = false) => (
    <MenuItem key={a.id} {...tid(TID.actionRow, a.tag ? { action: a.id, tag: a.tag } : { action: a.id })} label={a.label} icon={danger ? inColour(a.icon, t.danger) : a.icon}
      accessibilityLabel={a.tag ? `${a.label}, ${a.tag}` : undefined} selected={!!a.tag} trailing={a.tag ? <Chip text={a.tag} /> : undefined}
      note={a.waitReason ?? a.note} disabled={!!a.waitReason} tone={danger ? "danger" : "default"} onPress={run(a)} />
  );
  const tile = head.icon ? <View style={[styles.tile, { borderColor: t.accent }]}>{head.icon}</View> : undefined;
  return (
    <Sheet open={open} onClose={onClose} label={head.title} testID={testID} dataSet={dataSet} detent="fit" lift={lift}
      head={<SheetHead title={head.title} sub={head.sub} leading={tile} />}>
      {quick?.length ? <View {...tid(TID.actionQuick)} style={styles.quick}>{quick.slice(0, 4).map((a) => <QuickButton key={a.id} a={a} onPress={run(a)} />)}</View> : null}
      <Menu>
        {items.map((a, i) => (
          <Fragment key={a.id}>
            {a.section && a.section !== items[i - 1]?.section ? <View {...tid(TID.actionSection)} style={styles.section} accessibilityRole="header"><Text size={TYPE.secondary} tone="muted" numberOfLines={1}>{a.section}</Text></View> : null}
            {row(a)}
          </Fragment>
        ))}
        {after?.length ? <><MenuSep />{after.map((a) => row(a))}</> : null}
        {destructive ? <><MenuSep />{row(destructive, true)}</> : null}
      </Menu>
    </Sheet>
  );
}

/** An icon drawn in another colour (the icons of ui/icons.tsx take `color`); anything else as it is. */
function inColour(icon: ReactNode, color: string): ReactNode {
  return isValidElement(icon) ? cloneElement(icon as ReactElement<{ color?: string }>, { color }) : icon;
}

/** The tag of a likely choice: 13 pt accent text in a rounded accent border. */
function Chip({ text }: { text: string }) {
  const t = useTokens();
  return <View style={[styles.chip, { borderColor: t.accent }]}><Text size={TYPE.secondary} numberOfLines={1} style={{ color: t.accent }}>{text}</Text></View>;
}

/** A square button of the quick row: the icon over a 13 pt label. */
function QuickButton({ a, onPress }: { a: ActionItem; onPress(): void }) {
  const t = useTokens();
  const waits = !!a.waitReason;
  return (
    <Pressable {...tid(TID.actionRow, { action: a.id })} role="button" accessibilityLabel={waits ? `${a.label}. ${a.waitReason}` : a.label}
      disabled={waits} aria-disabled={waits || undefined} onPress={onPress}
      style={[styles.quickButton, { backgroundColor: t.panel }, waits && styles.waits]}>
      {a.icon ? <View style={styles.quickIcon}>{a.icon}</View> : null}
      <Text size={TYPE.secondary} numberOfLines={1}>{a.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { width: TILE, height: TILE, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  chip: { flexShrink: 0, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  section: { paddingHorizontal: PHONE.margin - 8, paddingTop: 14, paddingBottom: 4 },
  quick: { flexDirection: "row", gap: 8, paddingHorizontal: PHONE.margin - 8, paddingTop: 12, paddingBottom: 8 },
  quickButton: { flex: 1, minWidth: QUICK_WIDTH, minHeight: QUICK_HEIGHT, borderRadius: 10, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 4, paddingVertical: 6 },
  quickIcon: { height: 24, alignItems: "center", justifyContent: "center" },
  waits: { opacity: 0.5 },
});
