// The rows of a menu (today's .menu-item and its neighbours), drawn the same inside a Popover, a Dialog or a Sheet.
// In a sheet the rows are tall enough for a finger (50 points, PHONE.sheetRow), the label is 17 pt, the note 13 pt, an icon sits in a
// 24 pt slot and the text is 16 pt from the screen's edge (the sheet's own side padding is 8), and the menu has no minimum width. The menu closes
// nothing itself: the item's `onPress` closes the overlay it is in, as today's menus do.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type PressableProps, type ViewProps } from "react-native";

import { PHONE, TYPE } from "./metrics.ts";
import { useOverlayKind } from "./overlaykind.ts";
import { Text } from "./Text.tsx";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { webStyle } from "./webstyle.ts";
import { useControlRef } from "./useControlRef";
import { useMenuKeys } from "./useMenuKeys";

type Role = NonNullable<ViewProps["role"]>;
// (react-native's Role list has no menuitemradio; react-native-web draws any role it is given)
const MENUITEMRADIO = "menuitemradio" as unknown as Role;

/** label: the menu is one of choices or has a name (it gets role "menu" and the name). */
export function Menu({ children, label, minWidth = 200, testID = TID.menu }: { children: ReactNode; label?: string; minWidth?: number; testID?: string }) {
  const kind = useOverlayKind();
  const keys = useMenuKeys();
  return (
    <View ref={keys} testID={testID} role={label ? "menu" : undefined} aria-label={label}
      style={kind === "sheet" ? styles.menuSheet : { minWidth }}>
      {children}
    </View>
  );
}

export type MenuItemProps = Omit<PressableProps, "children" | "style"> & {
  label?: string;
  children?: ReactNode;
  /** Before the label. */
  icon?: ReactNode;
  /** After the label, at the right edge. */
  trailing?: ReactNode;
  /** The item shows the choice that is on (the accent ground). */
  selected?: boolean;
  /** The menu is one of choices and this is one: role menuitemradio, `selected` is its aria-checked. */
  choice?: boolean;
  tone?: "default" | "danger";
  /** A line of small print under the label. */
  note?: string;
  /** The tooltip on web. */
  title?: string;
  /** Web: the item has the focus when it appears (a menu of choices opens on the one that is on). */
  autoFocus?: boolean;
};

export function MenuItem({ label, children, icon, trailing, selected, choice, tone = "default", note, title, autoFocus, disabled, testID = TID.menuItem, accessibilityLabel, ...rest }: MenuItemProps) {
  const { tokens: t } = useTheme();
  const kind = useOverlayKind();
  const tip = useControlRef(title, autoFocus);
  const tall = kind === "sheet";
  return (
    <Pressable {...rest} ref={tip} testID={testID} disabled={disabled}
      role={choice ? MENUITEMRADIO : "menuitem"} aria-checked={choice ? !!selected : undefined} aria-disabled={disabled || undefined}
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.item, tall && styles.itemTall,
        { backgroundColor: selected || hovered || pressed ? t.accentSoft : "transparent" },
        disabled && styles.disabled,
        webStyle({ cursor: disabled ? "default" : "pointer" }),
      ]}>
      {icon && tall ? <View style={styles.iconSlot}>{icon}</View> : icon}
      <View style={styles.text}>
        {children ?? (label != null ? <Text numberOfLines={1} tone={tone === "danger" ? "danger" : "text"} size={tall ? TYPE.control : undefined} style={styles.label}>{label}</Text> : null)}
        {note ? <Text size={tall ? TYPE.secondary : 11} tone={tall ? "muted" : "faint"} style={styles.note}>{note}</Text> : null}
      </View>
      {trailing}
    </Pressable>
  );
}

/** A heading inside a menu (.menu-head): small, upper case, muted. */
export function MenuHead({ children }: { children: ReactNode }) {
  const tall = useOverlayKind() === "sheet";
  return (
    <View testID={TID.menuHead} style={[styles.head, tall && styles.headTall]} accessibilityRole="header">
      <Text size={tall ? TYPE.secondary : 11} weight="600" tone="muted" style={styles.caps}>{children}</Text>
    </View>
  );
}

/** A smaller heading for a group of items (.menu-group-head). */
export function MenuGroupHead({ children }: { children: ReactNode }) {
  const tall = useOverlayKind() === "sheet";
  return (
    <View style={[styles.groupHead, tall && styles.headTall]}>
      <Text size={tall ? TYPE.secondary : 10.5} weight="600" tone="faint" numberOfLines={1} style={styles.caps}>{children}</Text>
    </View>
  );
}

export function MenuSep() {
  const { tokens: t } = useTheme();
  const tall = useOverlayKind() === "sheet";
  return <View testID={TID.menuSep} role="separator" style={[styles.sep, tall && styles.sepTall, { backgroundColor: t.line }]} />;
}

/** What a menu says when it has no items (.menu-empty). */
export function MenuEmpty({ children }: { children: ReactNode }) {
  return <View style={styles.empty}><Text size={12} tone="muted">{children}</Text></View>;
}

const styles = StyleSheet.create({
  menuSheet: { alignSelf: "stretch" },
  item: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 10, paddingRight: 8, borderRadius: 5, alignSelf: "stretch" },
  itemTall: { minHeight: PHONE.sheetRow, paddingVertical: 8, paddingHorizontal: PHONE.margin - 8, gap: 12 },
  iconSlot: { minWidth: 24, minHeight: 24, alignItems: "center", justifyContent: "center" }, // (a larger icon, the agent picker's 34-pt tile, widens it)
  disabled: { opacity: 0.5 },
  text: { flex: 1, flexShrink: 1, minWidth: 0 },
  label: { flexShrink: 1 },
  note: { marginTop: 1 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 6, paddingHorizontal: 8, paddingBottom: 4 },
  groupHead: { paddingTop: 8, paddingHorizontal: 8, paddingBottom: 2 },
  headTall: { paddingHorizontal: PHONE.margin - 8 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  sep: { height: 1, marginVertical: 4 },
  sepTall: { marginVertical: 6 },
  empty: { padding: 8, alignItems: "center" },
});
