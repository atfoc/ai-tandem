// A square icon control (.icon-btn, 26 px; `size="sm"` 20 px). `title` is required: it is the tooltip on web and the
// accessibility label everywhere, since the control has no words. Hover (or the pressed state) gives it the accent.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { webStyle } from "./webstyle.ts";
import { useControlRef } from "./useControlRef";

export type IconButtonProps = Omit<PressableProps, "children" | "style"> & {
  title: string;
  /** The icon, drawn in the colour given: `(color) => <Icon color={color} />`, or an element drawn as it is. */
  children: ReactNode | ((color: string) => ReactNode);
  size?: "md" | "sm";
  /** The filled "new" variant of the sidebar (.icon-btn.new). */
  filled?: boolean;
  /** A toggle that is on. */
  on?: boolean;
  autoFocus?: boolean;
  /** Web: a press leaves the focus where it was (the control that hides the sidebar does not take it from a rename box). */
  keepFocus?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function IconButton({ title, children, size = "md", filled, on, autoFocus, keepFocus, disabled, style, testID = TID.iconButton, accessibilityLabel, ...rest }: IconButtonProps) {
  const { tokens: t } = useTheme();
  const tip = useControlRef(title, autoFocus, keepFocus);
  const px = size === "sm" ? 20 : 26;
  return (
    <Pressable {...rest} ref={tip} testID={testID} disabled={disabled}
      accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled, selected: on }}
      hitSlop={size === "sm" ? 6 : 4}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.base, { width: px, height: px, borderRadius: size === "sm" ? 5 : 6 },
        { backgroundColor: filled ? t.accentFill : hovered || pressed || on ? t.accentSoft : "transparent" },
        filled && (hovered || pressed) ? { filter: "brightness(1.08)" } : null,
        disabled && styles.disabled,
        webStyle({ cursor: disabled ? "default" : "pointer" }),
        style,
      ]}>
      {({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => {
        const colour = filled ? t.onAccent : hovered || pressed || on ? t.accent : t.muted;
        return typeof children === "function" ? children(colour) : children;
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.6 },
});
