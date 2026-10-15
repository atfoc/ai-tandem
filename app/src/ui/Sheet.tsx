// A sheet (AD-70): a surface that rises from the bottom edge over a dimmed page, the form every popup takes on the
// phone layout. A press on the dimmed page, a swipe down on its handle, Esc (web) and the back button (Android) close it. On a phone it rises
// over the on-screen keyboard (the box that has the focus and the buttons below it stay in sight); opened over another overlay it is drawn
// inside it (overlayhost.tsx).
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { Modal } from "./modal";
import { InTopOverlay, OverlayHost } from "./overlayhost.tsx";
import { OverlayKindProvider } from "./overlaykind.ts";
import { SheetFooterProvider } from "./sheetfooter.tsx";
import { useTheme } from "./theme.tsx";
import { TID } from "./tid.ts";
import { useKeyboardAvoid } from "./useKeyboardAvoid";
import { useOverlayClose } from "./useOverlayClose";

export type SheetProps = {
  open: boolean;
  onClose(): void;
  /** Its name, for a screen reader. */
  label: string;
  testID?: string;
  /** A press on the dimmed page closes it (default); false for a sheet that holds a form (a swipe, Esc and the back button still close). */
  closeOnBackdrop?: boolean;
  children: ReactNode;
};

const RISE_MS = 180;
/** A swipe down this far (points), or this fast (points per second), closes the sheet. */
const CLOSE_DISTANCE = 80;
const CLOSE_VELOCITY = 800;

export function Sheet({ open, onClose, label, testID = TID.sheet, closeOnBackdrop = true, children }: SheetProps) {
  const { tokens: t } = useTheme();
  const win = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext);
  const onRequestClose = useOverlayClose(open, onClose);
  const rise = useRef(new Animated.Value(0)).current; // 0 below the edge, 1 risen
  const drag = useRef(new Animated.Value(0)).current; // points the handle has been pulled down
  const { rootRef, inset, scrollRef, scrollProps } = useKeyboardAvoid();
  const [footer, setFooter] = useState<ReactNode>(null); // the actions of the content (sheetfooter.tsx)
  const bottom = 12 + (inset > 0 ? 0 : insets?.bottom ?? 0); // the safe area is the keyboard's while it is up

  useEffect(() => {
    if (!open) return;
    drag.setValue(0);
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: RISE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
  }, [open, rise, drag]);

  const close = useRef(onClose);
  close.current = onClose;
  const pull = Gesture.Pan().runOnJS(true).activeOffsetY(6)
    .onUpdate((e) => drag.setValue(Math.max(0, e.translationY)))
    .onEnd((e) => {
      if (e.translationY > CLOSE_DISTANCE || e.velocityY > CLOSE_VELOCITY) close.current();
      else Animated.spring(drag, { toValue: 0, useNativeDriver: Platform.OS !== "web" }).start();
    });

  const lift = Animated.add(Animated.multiply(Animated.subtract(1, rise), win.height), drag);
  const room = win.height - inset - (insets?.top ?? 0) - 8; // what the keyboard leaves
  return (
    <InTopOverlay open={open}>
      <Modal visible={open} transparent animationType="none" onRequestClose={onRequestClose} statusBarTranslucent
        {...({ "aria-label": label } as object)}>
        <OverlayKindProvider value="sheet">
          <GestureHandlerRootView style={StyleSheet.absoluteFill}>
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop, opacity: rise }]}>
              <Pressable testID={TID.backdrop} style={StyleSheet.absoluteFill} onPress={closeOnBackdrop ? onClose : undefined} focusable={false} tabIndex={-1} accessible={false} />
            </Animated.View>
            <View ref={rootRef} style={[styles.bottom, { paddingBottom: inset }]} pointerEvents="box-none">
              <Animated.View testID={testID} accessibilityLabel={label}
                style={[styles.surface, { maxHeight: Math.min(Math.round(win.height * 0.85), room), backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowLg, transform: [{ translateY: lift }] }]}>
                <GestureDetector gesture={pull}>
                  <View style={styles.handleArea} testID="sheet-handle"><View style={[styles.handle, { backgroundColor: t.line2 }]} /></View>
                </GestureDetector>
                <SheetFooterProvider value={Platform.OS === "web" ? null : setFooter}>
                  <ScrollView ref={scrollRef} {...scrollProps} keyboardShouldPersistTaps="handled" bounces={false}
                    contentContainerStyle={{ paddingBottom: footer ? 0 : bottom }}>
                    {children}
                  </ScrollView>
                  {footer ? <View style={{ paddingTop: 8, paddingBottom: bottom }}>{footer}</View> : null}
                </SheetFooterProvider>
              </Animated.View>
            </View>
          </GestureHandlerRootView>
          <OverlayHost />
        </OverlayKindProvider>
      </Modal>
    </InTopOverlay>
  );
}

const styles = StyleSheet.create({
  bottom: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end" },
  surface: { borderTopWidth: 1, borderTopLeftRadius: 14, borderTopRightRadius: 14, paddingHorizontal: 8, overflow: "hidden" },
  handleArea: { alignItems: "center", paddingTop: 8, paddingBottom: 8 },
  handle: { width: 36, height: 4, borderRadius: 2 },
});
