// A chip of the toolbar (the old page's styles.css .tchip): a 24-point rounded control with the setting's name, a glyph before it and a caret
// after it; a *static* one (a fixed setting) is no button. `ChipName` cuts a long name with an ellipsis while the chip keeps its glyph
// and caret, and caps it: the toolbar is fitted on the chips' capped widths.
import { useCallback, type ReactNode, type Ref } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Lock } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid, type DataSet } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { useMeasuring } from "./measure.tsx";

/** What a setting's chip says about when it can be changed. */
export const UNTIL_FIRST_MESSAGE = "can be changed until you send the first message";

/** The cap of a chip's name in the toolbar and its "more" popup, in points (the model's is narrower). */
export const NAME_CAP = 160, MODEL_CAP = 76;

/** A chip's name, in an element of its own. */
export function ChipName({ children, cap = NAME_CAP, missing, muted, full }: { children: ReactNode; cap?: number; missing?: boolean; muted?: boolean; full?: string }) {
  const ref = useControlRef(full); // (web: the whole name is the name's own tooltip, where the chip's does not say it)
  return <Text ref={ref} {...tid("chip-name")} size={12} tone={missing ? "danger" : muted ? "muted" : undefined} numberOfLines={1} style={[styles.name, { maxWidth: cap }]}>{children}</Text>;
}

/** The lock before a fixed folder, with the margin of its own the page's had. */
export function LockMark() {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  return <View {...(measuring ? {} : tid("lock"))} style={styles.lock}><Lock color={t.muted} /></View>;
}

export const Caret = () => <Text size={10} tone="muted" style={styles.caret}>▾</Text>;

/** The refs a control takes: the tooltip's (web) and the caller's, as one. */
export function useMergedRef(title: string | undefined, ref?: Ref<View | null>, ariaDisabled?: boolean) {
  const tip = useControlRef(title, false, false, ariaDisabled);
  return useCallback((el: View | null) => {
    (tip as ((e: unknown) => void) | undefined)?.(el);
    if (typeof ref === "function") ref(el); else if (ref) (ref as { current: View | null }).current = el;
  }, [tip, ref]);
}

export type ChipProps = {
  /** dataSet.kind: server | agent | folder | model | effort | subagents | more. */
  kind: string;
  /** The tooltip (web) and the accessibility label. */
  title: string;
  children: ReactNode;
  /** A button when set; else a static chip. */
  onPress?: () => void;
  /** A button that opens nothing now (a change is being saved): aria-disabled, and it keeps the focus. */
  disabled?: boolean;
  missing?: boolean;
  /** The list it opens is open (aria-expanded) and what kind it is. */
  expanded?: boolean;
  popup?: "listbox" | "dialog";
  chipRef?: Ref<View | null>;
  testID?: string;
  data?: DataSet;
  /** Wider than its content, centred (the "more" chip). */
  square?: boolean;
  /** A server that is not connected (the page's `.off`: the muted colour, which a fixed chip has anyway). */
  off?: boolean;
};

export function TChip({ kind, title, children, onPress, disabled, missing, expanded, popup, chipRef, testID = "tchip", data, square }: ChipProps) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useMergedRef(title, chipRef, onPress ? !!disabled : undefined);
  const ids = measuring ? {} : tid(testID, { kind, fixed: !onPress, ...data });
  if (!onPress) {
    return (
      <View ref={ref} {...ids} accessibilityLabel={title} style={[styles.chip, styles.static]}>
        {children}
      </View>
    );
  }
  return (
    <Pressable ref={ref} {...ids} onPress={disabled ? undefined : onPress} role="button" accessibilityLabel={title}
      aria-expanded={expanded} aria-haspopup={popup}
      accessibilityState={{ disabled: !!disabled, expanded }}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.chip, { backgroundColor: t.panel, borderColor: hovered && !disabled ? t.line2 : "transparent" },
        square && styles.square, disabled && styles.disabled, webStyle({ cursor: disabled ? "default" : "pointer" }),
      ]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 4, height: 24, paddingHorizontal: 8, borderWidth: 1, borderColor: "transparent", borderRadius: 6, flexShrink: 0 },
  static: { paddingHorizontal: 4, backgroundColor: "transparent" },
  square: { width: 28, paddingHorizontal: 0, justifyContent: "center" },
  disabled: { opacity: 0.55 },
  name: { minWidth: 0, flexShrink: 1 },
  caret: { flexShrink: 0 },
  lock: { marginLeft: 4 },
});
