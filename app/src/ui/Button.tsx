// The button of the page (.btn): a bordered, rounded control with an optional icon before its label. Tones: default,
// primary (the accent), danger, ghost (no border until hovered); `size="sm"` is the dialogs' and menus' size. The phone asks for
// `touch` (a 44 pt target, 17 pt text) or `block` (the full width, 50 pt, 17 pt text, the label centred: a sheet's or a form's main
// action); nothing takes them by itself. `title` is the tooltip on web (hover) and, with no `accessibilityLabel`, the accessibility label everywhere.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import { PHONE, TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { webStyle } from "./webstyle.ts";
import { useControlRef } from "./useControlRef";

export type ButtonTone = "default" | "primary" | "danger" | "ghost";

export type ButtonProps = Omit<PressableProps, "children" | "style"> & {
  label?: string;
  children?: ReactNode;
  tone?: ButtonTone;
  size?: "md" | "sm" | "touch" | "block";
  /** A ghost button that shows something is on (a toggle). */
  on?: boolean;
  /** The icon before the label. */
  icon?: ReactNode;
  title?: string;
  /** Web: the button has the focus when it appears (a dialog's default action). */
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({ label, children, tone = "default", size = "md", on, icon, title, autoFocus, disabled, style, testID = TID.button, accessibilityLabel, ...rest }: ButtonProps) {
  const { tokens: t } = useTheme();
  const tip = useControlRef(title, autoFocus);
  const sm = size === "sm", touch = size === "touch", block = size === "block";
  return (
    <Pressable {...rest} ref={tip} testID={testID} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title ?? label}
      accessibilityState={{ disabled: !!disabled, selected: on }}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => {
        const ghost = tone === "ghost", fill = tone === "primary" ? t.accentFill : tone === "danger" ? t.dangerFill : undefined;
        const soft = ghost && (hovered || pressed || on);
        return [
          styles.base, sm && styles.sm, touch && styles.touch, block && styles.block,
          {
            borderColor: fill ?? (ghost ? "transparent" : t.line2),
            backgroundColor: fill ?? (soft ? t.accentSoft : ghost ? "transparent" : hovered || pressed ? t.panel : t.bg),
          },
          fill && (hovered || pressed) ? { filter: "brightness(1.07)" } : null,
          disabled && styles.disabled,
          webStyle({ cursor: disabled ? "default" : "pointer" }),
          style,
        ];
      }}>
      {({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => {
        const ghost = tone === "ghost", soft = ghost && (hovered || pressed || on);
        const tint = tone === "primary" ? "onAccent" : tone === "danger" ? "onDanger" : soft ? "accent" : "text";
        return (
          <View style={styles.row}>
            {icon}
            {children ?? (label != null ? <Text size={touch || block ? TYPE.control : sm ? 12 : 13} tone={tint}>{label}</Text> : null)}
          </View>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", alignSelf: "flex-start" },
  sm: { paddingVertical: 4, paddingHorizontal: 10 },
  touch: { minHeight: PHONE.target, paddingHorizontal: 16, justifyContent: "center" },
  block: { minHeight: PHONE.sheetRow, paddingHorizontal: 16, alignSelf: "stretch", justifyContent: "center", borderRadius: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }, // (a label longer than the button wraps inside it)
  disabled: { opacity: 0.6 },
});
