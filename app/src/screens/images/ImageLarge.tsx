// An image of a message shown large (the old page's ImageLarge.tsx), over the app: a press on its thumbnail opens it. Esc (web, and the system's back
// on Android), the close button, a press beside the picture and (touch) a swipe down close it; with several images ← and → (a keyboard), the
// two buttons at the sides and (touch) a swipe sideways go from one to the next, and stop at both ends. It is a full-screen sheet: a Modal on
// a dark scrim in every theme, light texts on it, the picture whole and in its own shape, never drawn larger than it is, above its name.
//
// On the phone the view is ImageViewer.tsx's (black, pinch to zoom, page dots, Share / Save / Ask about it); this file draws the wide layouts' own.
//
// testIDs: `image-large` (dialog; dataSet `at`, `count`), `image-large-pic`, `image-large-off`, `image-large-name`, `image-large-close`,
// `image-large-prev` and `image-large-next` (at an end the button is marked `aria-disabled`, not removed: a disabled button that has the focus
// would take the keys with it), `image-large-backdrop` (a press on it, beside the picture, closes).
import { useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, Text as RNText, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { largeCaption, stepImage } from "@aiwb/core/logic/messageimages.ts";

import { onKey } from "../../platform/keys";
import { Picture } from "../../platform/picture";
import { SANS } from "../../ui/fonts.ts";
import { Modal } from "../../ui/modal"; // (web: the overlays' focus rule, ui/modal.web.tsx: the focus goes back to the thumbnail that opened it)
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useLayout } from "../../ui/useLayout.ts";
import { useOverlayClose } from "../../ui/useOverlayClose";
import { webStyle } from "../../ui/webstyle.ts";
import { ArrowGlyph, CloseGlyph } from "./glyphs.tsx";
import { ImageViewer, type ImageViewerProps } from "./ImageViewer.tsx";
import { fitInside, swipeOf, type ShownPicture, type Size } from "./shown.ts";


const noop = () => {};
const INK = "#f1f1f4", INK_SOFT = "rgba(255, 255, 255, 0.8)", SCRIM = "rgba(14, 14, 18, 0.88)";
const CHEQUER = "repeating-conic-gradient(#e3e3e8 0 25%, #ffffff 0 50%) 0 0 / 16px 16px";

/** at: which of images is shown; onAt: another one is asked for. The phone's view also takes from, onAsk and askOff (ImageViewer.tsx). */
export function ImageLarge(props: ImageViewerProps) {
  return useLayout() === "phone" ? <ImageViewer {...props} /> : <ImageLargeWide {...props} />;
}

function ImageLargeWide({ images, at, onAt, onClose }: { images: readonly ShownPicture[]; at: number; onAt: (at: number) => void; onClose: () => void }) {
  const insets = useContext(SafeAreaInsetsContext);
  const onRequestClose = useOverlayClose(true, onClose);
  const image = images[at], count = images.length;
  const [failed, setFailed] = useState<string | null>(null); // the picture that could not be shown, by its place
  const [loaded, setLoaded] = useState<{ place: string; size: Size } | null>(null); // the size the picture of that place has
  const [box, setBox] = useState<Size | null>(null);
  const place = image ? `${at}:${image.id}` : "";

  // The arrow keys are the view's before anything under it sees them (web: the window, in the capture phase; a hardware keyboard on a tablet).
  const step = useRef<(by: number) => void>(() => {});
  step.current = (by) => onAt(stepImage(at, count, by));
  useEffect(() => onKey((e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    step.current(e.key === "ArrowRight" ? 1 : -1);
  }), []);

  const close = useRef(onClose);
  close.current = onClose;
  const swipe = Gesture.Pan().runOnJS(true).minDistance(14)
    .onEnd((e) => {
      const s = swipeOf(e.translationX, e.translationY, e.velocityY);
      if (s === "close") close.current(); else if (s) step.current(s);
    });

  if (!image) return null;
  const off = failed === place;
  const fit = loaded?.place === place && box ? fitInside(loaded.size, box) : null;
  const pic = Platform.OS === "web" ? webStyle({ backgroundImage: CHEQUER, boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)" }) : { backgroundColor: "#ececf0" };
  const pad = { paddingTop: 48 + (insets?.top ?? 0), paddingBottom: 16 + (insets?.bottom ?? 0), paddingHorizontal: 60 };
  return (
    <Modal visible transparent animationType={Platform.OS === "web" ? "none" : "fade"} onRequestClose={onRequestClose} statusBarTranslucent
      {...({ "aria-label": image.name } as object)}>
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <View {...tid("image-large", { at, count })} role="dialog" aria-modal accessibilityLabel={image.name} accessibilityViewIsModal style={styles.root}>
          <Pressable {...tid("image-large-backdrop")} onPress={onClose} focusable={false} accessible={false} style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM }, webStyle({ cursor: "zoom-out" })]} />
          <View pointerEvents="box-none" style={[styles.content, pad]}>
            <GestureDetector gesture={swipe}>
              {/* (a press on the area, beside the picture, closes; the picture takes its own press, which does nothing) */}
              <Pressable onPress={onClose} accessible={false} focusable={false} style={[styles.area, webStyle({ cursor: "zoom-out" })]}
                onLayout={(e: LayoutChangeEvent) => setBox({ width: Math.floor(e.nativeEvent.layout.width), height: Math.floor(e.nativeEvent.layout.height) })}>
                <Pressable onPress={noop} accessible={false} focusable={false} style={webStyle({ cursor: "default" })}>
                  {off ? (
                    <View {...tid("image-large-off")} style={styles.off}><RNText style={styles.offText}>This image cannot be shown.</RNText></View>
                  ) : (
                    // (until the picture has loaded and its own size is known it is drawn invisibly at the size of the area)
                    <Picture key={place} server={image.server} chat={image.chat} image={image.id} name={image.name}
                      onLoad={(size) => setLoaded({ place, size })} onError={() => setFailed(place)}
                      style={[{ resizeMode: "contain", borderRadius: 6 }, fit ? fit : { width: box?.width ?? 0, height: box?.height ?? 0, opacity: 0 }, pic as never]} />
                  )}
                </Pressable>
              </Pressable>
            </GestureDetector>
            <RNText {...tid("image-large-name")} numberOfLines={1} style={styles.name}>{largeCaption(image.name, at, count)}</RNText>
          </View>
          <LargeButton id="image-large-close" title="Close (Esc)" label="Close" autoFocus onPress={onClose} style={{ top: 10 + (insets?.top ?? 0), right: 12 }}><CloseGlyph color={INK} /></LargeButton>
          {count > 1 && (
            <>
              <LargeButton id="image-large-prev" title="Previous (←)" label="Previous image" off={at <= 0} onPress={() => step.current(-1)} style={[styles.prev, { left: 12 }]}><ArrowGlyph back color={INK} /></LargeButton>
              <LargeButton id="image-large-next" title="Next (→)" label="Next image" off={at >= count - 1} onPress={() => step.current(1)} style={[styles.next, { right: 12 }]}><ArrowGlyph color={INK} /></LargeButton>
            </>
          )}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** A round control on the scrim. off: its end is reached; the control stays (marked), a press does nothing. */
function LargeButton({ id, title, label, off, autoFocus, onPress, style, children }: {
  id: string; title: string; label: string; off?: boolean; autoFocus?: boolean; onPress: () => void; style?: object; children: ReactNode;
}) {
  const tip = useControlRef(title, autoFocus);
  // (at an end the control is marked off, not `disabled`: react-native-web turns a disabled Pressable into a disabled button, which cannot hold the focus)
  const ref = useCallback((el: unknown) => {
    tip?.(el);
    (el as { setAttribute?: (k: string, v: string) => void } | null)?.setAttribute?.("aria-disabled", off ? "true" : "false");
  }, [tip, off]);
  return (
    <Pressable ref={ref} testID={id} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!off }} hitSlop={8}
      onPress={off ? undefined : onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.btn, { backgroundColor: hovered && !off ? "rgba(255, 255, 255, 0.28)" : "rgba(255, 255, 255, 0.14)", opacity: off ? 0.3 : 1 }, style as never]}>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  content: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", gap: 10 },
  area: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", minHeight: 0 },
  name: { maxWidth: "100%", color: INK_SOFT, fontSize: 12, lineHeight: 17, fontFamily: SANS },
  off: { paddingVertical: 28, paddingHorizontal: 36, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(255, 255, 255, 0.36)", borderRadius: 8 },
  offText: { color: INK_SOFT, fontSize: 13, fontFamily: SANS },
  btn: { position: "absolute", width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  prev: { top: "50%", marginTop: -16 },
  next: { top: "50%", marginTop: -16 },
});
