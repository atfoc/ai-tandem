// A dialog (AD-70): a framed surface in the middle of the window over a dimmed page. A press on the dimmed page, Esc
// (web) and the back button (Android) close it. The parts a dialog is made of (the title, the body, an error, the
// actions) are here too, as the confirm dialog of today's Dialogs.tsx lays them out. A dialog with a text field keeps it and its actions above
// the on-screen keyboard; opened over another overlay it is drawn inside it (overlayhost.tsx).
import { Children, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";

import { Modal } from "./modal";
import { InTopOverlay, OverlayHost } from "./overlayhost.tsx";
import { OverlayKindProvider } from "./overlaykind.ts";
import { InSheetFooter, SheetFooterProvider } from "./sheetfooter.tsx";
import { Text } from "./Text.tsx";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { useKeyboardAvoid } from "./useKeyboardAvoid";
import { useOverlayClose } from "./useOverlayClose";

export type DialogProps = {
  open: boolean;
  onClose(): void;
  /** Its name, for a screen reader (the confirm dialog's is its title). */
  label: string;
  /** Wide (default 420, as today's .dialog; never wider than the window less 32). */
  width?: number;
  testID?: string;
  /** A press on the dimmed page closes it (default); false for a dialog that holds a form (Esc and the back button still close). */
  closeOnBackdrop?: boolean;
  children: ReactNode;
};

export function Dialog({ open, onClose, label, width = 420, testID = TID.dialog, closeOnBackdrop = true, children }: DialogProps) {
  const { tokens: t } = useTheme();
  const win = useWindowDimensions();
  const onRequestClose = useOverlayClose(open, onClose);
  const { rootRef, inset, scrollRef, scrollProps } = useKeyboardAvoid();
  return (
    <InTopOverlay open={open}>
      <Modal visible={open} transparent animationType="none" onRequestClose={onRequestClose} statusBarTranslucent
        {...({ "aria-label": label } as object)}>
        <OverlayKindProvider value="dialog">
          <Pressable testID={TID.backdrop} style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }]} onPress={closeOnBackdrop ? onClose : undefined} focusable={false} tabIndex={-1} accessible={false} />
          <View ref={rootRef} style={[styles.centre, { paddingBottom: inset }]} pointerEvents="box-none">
            <View testID={testID} accessibilityLabel={label}
              style={[styles.surface, { width: Math.min(width, win.width - 32), maxHeight: win.height - inset - 32, backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowLg }]}>
              <SheetFooterProvider value={null}>
                <ScrollView ref={scrollRef} {...scrollProps} keyboardShouldPersistTaps="handled" bounces={false}>{children}</ScrollView>
              </SheetFooterProvider>
            </View>
          </View>
          <OverlayHost />
        </OverlayKindProvider>
      </Modal>
    </InTopOverlay>
  );
}

export function DialogTitle({ children }: { children: ReactNode }) {
  return <Text testID={TID.dialogTitle} weight="600" accessibilityRole="header">{children}</Text>;
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <Text testID={TID.dialogBody} tone="muted" style={styles.body}>{children}</Text>;
}

export function DialogError({ children }: { children: ReactNode }) {
  return <Text tone="danger" size={12} style={styles.error} accessibilityRole="alert">{children}</Text>;
}

/** The actions at the bottom right, Cancel first and the default action last (it is the one with the focus). In a sheet they are its footer.
 *  `layout="stacked"` (a phone form that stays a dialog) is a column of full-width buttons with the primary first: the callers pass the
 *  children in the same order as for the row, Cancel first and the primary last, and they are drawn in reverse. The buttons there are `block`. */
export function DialogActions({ children, layout = "row" }: { children: ReactNode; layout?: "row" | "stacked" }) {
  const row = layout === "stacked"
    ? <View style={styles.stacked}>{Children.toArray(children).reverse().map((child, i) => <View key={i} style={styles.stackedItem}>{child}</View>)}</View>
    : <View style={styles.actions}>{children}</View>;
  return <InSheetFooter inPlace={row}>{row}</InSheetFooter>;
}

const styles = StyleSheet.create({
  centre: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  surface: { borderWidth: 1, borderRadius: 12, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 14 },
  body: { marginTop: 6 },
  error: { marginTop: 8 },
  stacked: { gap: 8, marginTop: 16 },
  stackedItem: { alignSelf: "stretch" },
  actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8, marginTop: 16 },
});
