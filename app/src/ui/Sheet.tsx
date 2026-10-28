// A sheet (AD-70): a surface that rises from the bottom edge over a dimmed page, the form every popup takes on the
// phone layout. A press on the dimmed page, a swipe down on its handle, Esc (web) and the back button (Android) close it. On a phone it rises
// over the on-screen keyboard (the box that has the focus and the buttons below it stay in sight); opened over another overlay it is drawn
// inside it (overlayhost.tsx).
//
// Its height (ux-improvements goal 3.1, package F1): by default the content's, up to 85 % of the window; `detent="fit"` caps it at
// half the window (the content scrolls past that: an action sheet, a short list); `detent="large"` pins it from just under the top
// safe area down to the bottom whatever the content (a form, a search picker). A `head` is drawn above the scroll view and stays put.
// A sheet over another sheet is for a picker or a confirm over a form only: it says so with `over="form"`, and in development any
// other one warns.
import { useContext, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { Animated, Easing, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { Modal } from "./modal";
import { InTopOverlay, OverlayHost } from "./overlayhost.tsx";
import { OverlayKindProvider } from "./overlaykind.ts";
import { SheetFooterProvider } from "./sheetfooter.tsx";
import { useTheme } from "./theme.tsx";
import { TID, type DataSet } from "./tid.ts";
import { useKeyboardAvoid } from "./useKeyboardAvoid";
import { useOverlayClose } from "./useOverlayClose";

export type SheetProps = {
  open: boolean;
  onClose(): void;
  /** Its name, for a screen reader. */
  label: string;
  testID?: string;
  /** What a check reads from the sheet: `data-<key>` on the element that carries the testID. */
  dataSet?: DataSet;
  /** A press on the dimmed page closes it (default); false for a sheet that holds a form (a swipe, Esc and the back button still close). */
  closeOnBackdrop?: boolean;
  /** The height: none = the content's, up to 85 % of the window; "fit" = the content's, up to 50 % (scrolls past); "large" = down from the top safe area + 8 pt, always. */
  detent?: "fit" | "large";
  /** Drawn between the handle and the scrolling content, and kept there while the content scrolls (a SheetHead). */
  head?: ReactNode;
  /** A node drawn over the dimmed page and under the sheet's surface, not touchable: a message lifted out of the thread. The caller places it
   *  (absolutely, in window coordinates: the sheet's modal fills the window). */
  lift?: ReactNode;
  /** This sheet opens over a form sheet (a picker or a confirm over a P3): the one sheet over a sheet that is allowed. */
  over?: "form";
  /** The content's scroll view, for a caller that scrolls it to a row (the chat tree) and gives it back where it was (the tree steps aside for a P1 or a form). */
  scrollRef?: MutableRefObject<ScrollView | null>;
  /** Called as the content scrolls (with `scrollRef`, to keep the place). */
  onScroll?(e: NativeSyntheticEvent<NativeScrollEvent>): void;
  /** The height of the part of the content that shows (with `scrollRef` and `onScroll`, to keep a row in sight: the model and effort menu). */
  onViewport?(height: number): void;
  children: ReactNode;
};

const RISE_MS = 180;
/** The rise's duration; the device self-test (`dev/SheetsSelfTest.tsx`) lengthens it, to make a sheet that opens while the keyboard moves meet the keyboard's animation. */
export const sheetTiming = { riseMs: RISE_MS };
/** A swipe down this far (points), or this fast (points per second), closes the sheet. */
const CLOSE_DISTANCE = 80;
const CLOSE_VELOCITY = 800;
/** A `fit` sheet is at most this share of the window. */
const FIT_SHARE = 0.5;

let sheetsOpen = 0; // how many sheets are open, for the development warning below

export function Sheet({ open, onClose, label, testID = TID.sheet, dataSet, closeOnBackdrop = true, detent, head, lift: lifted, over, scrollRef: outerRef, onScroll, onViewport, children }: SheetProps) {
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
    Animated.timing(rise, { toValue: 1, duration: sheetTiming.riseMs, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
  }, [open, rise, drag]);

  useEffect(() => {
    if (!open) return;
    if (__DEV__ && sheetsOpen > 0 && over !== "form") console.warn(`Sheet "${label}" opens over another sheet: only a picker or a confirm over a form may (over="form").`);
    sheetsOpen++;
    return () => { sheetsOpen--; };
  }, [open, over, label]);

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
  const size = detent === "large" ? { height: room } : { maxHeight: Math.min(Math.round(win.height * (detent === "fit" ? FIT_SHARE : 0.85)), room) };
  return (
    <InTopOverlay open={open}>
      <Modal visible={open} transparent animationType="none" onRequestClose={onRequestClose} statusBarTranslucent
        {...({ "aria-label": label } as object)}>
        <OverlayKindProvider value="sheet">
          <GestureHandlerRootView style={StyleSheet.absoluteFill}>
            <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop, opacity: rise }]}>
              <Pressable testID={TID.backdrop} style={StyleSheet.absoluteFill} onPress={closeOnBackdrop ? onClose : undefined} focusable={false} tabIndex={-1} accessible={false} />
            </Animated.View>
            {lifted ? <View style={StyleSheet.absoluteFill} pointerEvents="none">{lifted}</View> : null}
            <View ref={rootRef} style={[styles.bottom, { paddingBottom: inset }]} pointerEvents="box-none">
              <Animated.View testID={testID} dataSet={dataSet} accessibilityLabel={label}
                style={[styles.surface, size, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowLg, transform: [{ translateY: lift }] }]}>
                <GestureDetector gesture={pull}>
                  <View style={styles.handleArea} testID="sheet-handle"><View style={[styles.handle, { backgroundColor: t.line2 }]} /></View>
                </GestureDetector>
                {head}
                <SheetFooterProvider value={Platform.OS === "web" ? null : setFooter}>
                  <ScrollView ref={(r) => { scrollRef.current = r; if (outerRef) outerRef.current = r; }} {...scrollProps}
                    {...(onScroll ? { onScroll: (e: NativeSyntheticEvent<NativeScrollEvent>) => { scrollProps.onScroll?.(e); onScroll(e); }, scrollEventThrottle: 16 } : null)}
                    {...(onViewport ? { onLayout: (e: LayoutChangeEvent) => { scrollProps.onLayout?.(e); onViewport(e.nativeEvent.layout.height); } } : null)}
                    keyboardShouldPersistTaps="handled" bounces={false}
                    contentContainerStyle={{ paddingBottom: footer ? 0 : bottom }}>
                    <View testID={TID.sheetBody}>{children}</View>
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
