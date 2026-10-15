// A popover (AD-70): a framed surface anchored below (or above) a control, in a transparent layer over the page. A press
// outside it, Esc (web) and the back button (Android) close it. It is today's `.menu`: the surface, not the rows (Menu). Opened over
// another overlay it is drawn inside it (overlayhost.tsx). On native, with the on-screen keyboard up, it is placed in the part of the window the keyboard
// leaves (placement.ts, useKeyboardAvoid.ts): a popover hung from the composer's toolbar that holds a text box rises with the keyboard's top.
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";

import { Modal } from "./modal";
import { InTopOverlay, OverlayHost } from "./overlayhost.tsx";
import { OverlayKindProvider } from "./overlaykind.ts";
import { SheetFooterProvider } from "./sheetfooter.tsx";
import { EDGE, placePopover, type Rect, type Size } from "./placement.ts";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { radius } from "./tokens.ts";
import { useKeyboardAvoid } from "./useKeyboardAvoid";
import { useOverlayClose } from "./useOverlayClose";

export type PopoverProps = {
  open: boolean;
  onClose(): void;
  /** Its name, for a screen reader. */
  label: string;
  /** The control it hangs from; measured when it opens, and when the window changes. */
  anchor: RefObject<View | null>;
  /** Which edge of the anchor it lines up with (default left). */
  align?: "left" | "right";
  /** Opens above the anchor (the composer's and the sidebar foot's menus). */
  up?: boolean;
  testID?: string;
  children: ReactNode;
};

export function Popover({ open, onClose, label, anchor, align = "left", up, testID = TID.popover, children }: PopoverProps) {
  const { tokens: t } = useTheme();
  const win = useWindowDimensions();
  const onRequestClose = useOverlayClose(open, onClose);
  const [rect, setRect] = useState<Rect | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const { rootRef, inset, scrollRef, scrollProps } = useKeyboardAvoid(); // native: the keyboard's points over the layer (the web's browser moves its own page)

  useEffect(() => {
    if (!open) { setRect(null); setSize(null); return; }
    const node = anchor.current;
    if (!node) { setRect({ x: EDGE, y: EDGE, width: 0, height: 0 }); return; }
    node.measureInWindow((x, y, width, height) => setRect({ x, y, width, height }));
  }, [open, anchor, win.width, win.height]);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s && Math.abs(s.width - width) < 0.5 && Math.abs(s.height - height) < 0.5 ? s : { width, height }));
  };
  const at = rect && size ? placePopover({ anchor: rect, size, window: { width: win.width, height: win.height }, align, up, covered: inset }) : null;

  const noRoom = win.height - inset - 2 * EDGE;
  return (
    <InTopOverlay open={open}>
      <Modal visible={open} transparent animationType="none" onRequestClose={onRequestClose} statusBarTranslucent returnTo={anchor}
        {...({ "aria-label": label } as object)}>
        <OverlayKindProvider value="popover">
          <Pressable testID={TID.backdrop} style={StyleSheet.absoluteFill} onPress={onClose} focusable={false} tabIndex={-1} accessible={false} />
          <View ref={rootRef} style={StyleSheet.absoluteFill} pointerEvents="box-none">
            <View testID={testID} onLayout={onLayout} accessibilityLabel={label}
              style={[styles.surface, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowMd, maxWidth: win.width - 2 * EDGE }, at
                ? { left: at.left, top: at.top, maxHeight: at.maxHeight, opacity: 1 }
                : { left: 0, top: 0, opacity: 0, maxHeight: noRoom }]}>
              <SheetFooterProvider value={null}>
                <ScrollView ref={scrollRef} {...scrollProps} bounces={false} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{children}</ScrollView>
              </SheetFooterProvider>
            </View>
          </View>
          <OverlayHost />
        </OverlayKindProvider>
      </Modal>
    </InTopOverlay>
  );
}

const styles = StyleSheet.create({
  surface: { position: "absolute", borderWidth: 1, borderRadius: radius, padding: 4, overflow: "hidden" },
});
