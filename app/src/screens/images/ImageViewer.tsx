// The image viewer on the phone (ux-improvements goal 3.5 "Images", mockup 09 `ch-09b`): a black full screen in every theme with light status bar, the
// image's name and "Image 1 of 2 · your message" beside a close cross at the top, the picture fitted between the bars, page dots and a row of
// Share, Save and Ask about it at the bottom. A swipe sideways goes to the next image and back (stopping at both ends), a swipe down closes, a pinch
// zooms (to `MAX_ZOOM`) and while it is zoomed a pan moves the picture, which does not change image. No arrow buttons, no ⋯: what a menu would hold is
// in the bottom row. ImageLarge.tsx draws the wide layouts' view and hands the phone's here.
//
// testIDs: `image-large` (dialog; dataSet `at`, `count`), `image-large-close`, `image-large-name`, `image-large-sub`, `image-large-zoom` (dataSet `zoom`),
// `image-large-off`, `image-large-dots` (dataSet `at`, `count`; not for one image), `image-large-share`, `image-large-save`, `image-large-ask`
// (`aria-disabled` when it is off, its reason in `image-large-ask-why`), `image-large-note` (a failed share), `image-large-backdrop`.
import { useContext, useEffect, useRef, useState } from "react";
import { Animated, Platform, Pressable, StyleSheet, Text as RNText, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { stepImage } from "@aiwb/core/logic/messageimages.ts";

import { onKey } from "../../platform/keys";
import { Picture } from "../../platform/picture";
import { SANS } from "../../ui/fonts.ts";
import { Modal } from "../../ui/modal";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useOverlayClose } from "../../ui/useOverlayClose";
import { webStyle } from "../../ui/webstyle.ts";
import { AskGlyph, CloseGlyph, SaveGlyph, ShareGlyph } from "./glyphs.tsx";
import { IMAGE_TID } from "./ids.ts";
import { pictureShare } from "./pictureshare";
import { fitInside, swipeOf, type ShownPicture, type Size } from "./shown.ts";
import { clampPan, clampScale, pageDots, viewerActions, viewerSub, zoomed, type Sender, type ViewerAction } from "./viewer.ts";

const BLACK = "#000", WHITE = "#fff", SOFT = "rgba(255, 255, 255, 0.7)", DOT_OFF = "rgba(255, 255, 255, 0.4)";
const noop = () => {};
const os = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";

export type ImageViewerProps = {
  images: readonly ShownPicture[]; at: number; onAt: (at: number) => void; onClose: () => void;
  /** Whose message the images came with (the line under the name). */
  from?: Sender;
  /** "Ask about it": puts the image at `at` into the chat's composer. Without it the action is not in the row. */
  onAsk?: (at: number) => void;
  /** Why the chat takes no "Ask about it" now; the action stays, off, with this as its label's second line. "" when it takes it. */
  askOff?: string;
};

export function ImageViewer({ images, at, onAt, onClose, from = "you", onAsk, askOff = "" }: ImageViewerProps) {
  const insets = useContext(SafeAreaInsetsContext);
  const onRequestClose = useOverlayClose(true, onClose);
  const image = images[at], count = images.length;
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{ place: string; size: Size } | null>(null);
  const [box, setBox] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(1); // the scale at rest after a pinch: only for what the page reads (`zoom`)
  const [note, setNote] = useState("");
  const place = image ? `${at}:${image.id}` : "";

  // The zoom lives in Animated values, which the gestures set from the JS thread (no reanimated in the app); `now` is what they have committed.
  const scale = useRef(new Animated.Value(1)).current, panX = useRef(new Animated.Value(0)).current, panY = useRef(new Animated.Value(0)).current;
  const now = useRef({ scale: 1, x: 0, y: 0 });
  const fitRef = useRef<Size | null>(null), boxRef = useRef<Size | null>(null);
  const put = (s: number, x: number, y: number) => {
    now.current = { scale: s, x, y };
    scale.setValue(s); panX.setValue(x); panY.setValue(y);
  };
  useEffect(() => { put(1, 0, 0); setZoom(1); setNote(""); }, [place]); // another image starts at rest

  const step = useRef<(by: number) => void>(() => {});
  step.current = (by) => onAt(stepImage(at, count, by));
  useEffect(() => onKey((e) => { // (a hardware keyboard)
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    step.current(e.key === "ArrowRight" ? 1 : -1);
  }), []);
  const close = useRef(onClose);
  close.current = onClose;

  const base = useRef(now.current);
  const pinch = Gesture.Pinch().runOnJS(true)
    .onStart(() => { base.current = now.current; })
    .onUpdate((e) => {
      const s = clampScale(base.current.scale * e.scale), fit = fitRef.current, bx = boxRef.current;
      const p = fit && bx ? clampPan({ x: base.current.x, y: base.current.y }, s, fit, bx) : { x: 0, y: 0 };
      put(s, p.x, p.y);
    })
    .onEnd(() => { const s = now.current.scale; if (!zoomed(s)) put(1, 0, 0); setZoom(zoomed(s) ? s : 1); });
  const pan = Gesture.Pan().runOnJS(true).minDistance(14).maxPointers(1)
    .onStart(() => { base.current = now.current; })
    .onUpdate((e) => {
      if (!zoomed(now.current.scale)) return;
      const fit = fitRef.current, bx = boxRef.current;
      if (!fit || !bx) return;
      const p = clampPan({ x: base.current.x + e.translationX, y: base.current.y + e.translationY }, now.current.scale, fit, bx);
      put(now.current.scale, p.x, p.y);
    })
    .onEnd((e) => {
      if (zoomed(now.current.scale)) return; // zoomed in, a pan moves the picture: it does not change the image or close the view
      const s = swipeOf(e.translationX, e.translationY, e.velocityY);
      if (s === "close") close.current(); else if (s) step.current(s);
    });
  const gesture = Gesture.Simultaneous(pinch, pan);

  if (!image) return null;
  const off = failed === place;
  const fit = loaded?.place === place && box ? fitInside(loaded.size, box) : null;
  fitRef.current = fit;
  boxRef.current = box;
  const dots = pageDots(at, count);
  const actions = viewerActions({ os, canShareFiles: pictureShare.canShare(), canAsk: !!onAsk });
  const run = (what: ViewerAction) => {
    if (what === "ask") { if (!askOff) onAsk?.(at); return; }
    setNote("");
    (what === "share" ? pictureShare.share : pictureShare.save)(image).catch((e) => setNote(`Could not ${what} the image: ${e?.message ?? e}`));
  };
  const top = insets?.top ?? 0, bottom = insets?.bottom ?? 0;
  return (
    <Modal visible transparent animationType={Platform.OS === "web" ? "none" : "slide"} onRequestClose={onRequestClose} statusBarTranslucent
      {...({ "aria-label": image.name } as object)}>
      <StatusBar style="light" />
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <View {...tid("image-large", { at, count })} role="dialog" aria-modal accessibilityLabel={image.name} accessibilityViewIsModal style={styles.root}>
          <View style={[styles.bar, { paddingTop: top }]}>
            <View pointerEvents="none" style={styles.titles}>
              <RNText {...tid("image-large-name")} numberOfLines={1} ellipsizeMode="middle" style={styles.name}>{image.name}</RNText>
              <RNText {...tid(IMAGE_TID.sub)} numberOfLines={1} style={styles.sub}>{viewerSub(at, count, from)}</RNText>
            </View>
            <Close onPress={onClose} top={top} />
          </View>
          <GestureDetector gesture={gesture}>
            {/* (a press on the area, beside the picture, closes) */}
            <Pressable {...tid("image-large-backdrop")} onPress={onClose} accessible={false} focusable={false} tabIndex={-1} style={styles.area}
              onLayout={(e: LayoutChangeEvent) => setBox({ width: Math.floor(e.nativeEvent.layout.width), height: Math.floor(e.nativeEvent.layout.height) })}>
              <Animated.View {...tid(IMAGE_TID.zoom, { zoom: zoom.toFixed(2) })} style={{ transform: [{ translateX: panX }, { translateY: panY }, { scale }] }}>
                <Pressable onPress={noop} accessible={false} focusable={false} tabIndex={-1} style={webStyle({ cursor: "default" })}>
                  {off ? (
                    <View {...tid("image-large-off")} style={styles.off}><RNText style={styles.offText}>This image cannot be shown.</RNText></View>
                  ) : (
                    // (until the picture has loaded and its own size is known it is drawn invisibly at the size of the area)
                    <Picture key={place} server={image.server} chat={image.chat} image={image.id} name={image.name}
                      onLoad={(size) => setLoaded({ place, size })} onError={() => setFailed(place)}
                      style={[{ resizeMode: "contain" }, fit ? fit : { width: box?.width ?? 0, height: box?.height ?? 0, opacity: 0 }]} />
                  )}
                </Pressable>
              </Animated.View>
            </Pressable>
          </GestureDetector>
          <View style={[styles.foot, { paddingBottom: Math.max(bottom, 12) }]}>
            {dots.length > 0 && (
              <View {...tid(IMAGE_TID.dots, { at, count })} accessibilityLabel={`Image ${at + 1} of ${count}`} role="img" style={styles.dots}>
                {dots.map((d, i) => <View key={i} style={[styles.dot, { backgroundColor: d.on ? WHITE : DOT_OFF }]} />)}
              </View>
            )}
            {!!note && <RNText {...tid("image-large-note")} role="status" style={styles.note}>{note}</RNText>}
            <View style={styles.actions}>
              {actions.map((a) => <Action key={a} what={a} why={a === "ask" ? askOff : ""} onPress={() => run(a)} />)}
            </View>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

function Close({ onPress, top }: { onPress: () => void; top: number }) {
  const ref = useControlRef(undefined, true); // (web: the focus goes into the dialog)
  return (
    <Pressable ref={ref} {...tid("image-large-close")} accessibilityRole="button" accessibilityLabel="Close" onPress={onPress} style={[styles.close, { top }]}>
      <CloseGlyph size={16} color={WHITE} />
    </Pressable>
  );
}

const LABEL: Record<ViewerAction, string> = { share: "Share", save: "Save", ask: "Ask about it" };
const ID: Record<ViewerAction, string> = { share: IMAGE_TID.share, save: IMAGE_TID.save, ask: IMAGE_TID.ask };
const GLYPH: Record<ViewerAction, typeof ShareGlyph> = { share: ShareGlyph, save: SaveGlyph, ask: AskGlyph };

/** One of the bottom row's actions: its icon over its label, 44 pt at least. An action that is off (why: the reason) says why as a second line. */
function Action({ what, why, onPress }: { what: ViewerAction; why: string; onPress: () => void }) {
  const Glyph = GLYPH[what], off = !!why;
  return (
    <Pressable {...tid(ID[what])} accessibilityRole="button" accessibilityLabel={off ? `${LABEL[what]}, ${why}` : LABEL[what]} accessibilityState={{ disabled: off }}
      disabled={off} onPress={onPress} style={[styles.action, off && { opacity: 0.4 }]}>
      <Glyph color={WHITE} />
      <RNText style={styles.actionLabel}>{LABEL[what]}</RNText>
      {off && <RNText {...tid(`${ID[what]}-why`)} numberOfLines={2} style={styles.why}>{why}</RNText>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: BLACK },
  bar: { minHeight: PHONE.target + 12, justifyContent: "center", flexShrink: 0 },
  close: { position: "absolute", left: 8, width: PHONE.target + 12, height: PHONE.target + 12, alignItems: "center", justifyContent: "center", zIndex: 2 },
  titles: { alignSelf: "stretch", alignItems: "center", paddingHorizontal: PHONE.target + 20, paddingVertical: 6 },
  name: { maxWidth: "100%", color: WHITE, fontSize: TYPE.control, lineHeight: 22, fontWeight: "600", fontFamily: SANS },
  sub: { maxWidth: "100%", color: SOFT, fontSize: TYPE.secondary, lineHeight: 18, fontFamily: SANS },
  area: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", minHeight: 0 },
  off: { paddingVertical: 28, paddingHorizontal: 36, borderWidth: 1, borderStyle: "dashed", borderColor: "rgba(255, 255, 255, 0.36)", borderRadius: 8 },
  offText: { color: SOFT, fontSize: TYPE.secondary, fontFamily: SANS },
  foot: { flexShrink: 0, alignItems: "center", paddingTop: 12 },
  dots: { flexDirection: "row", gap: 6, height: 7, marginBottom: 12 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  note: { color: "#ff9a9a", fontSize: TYPE.secondary, textAlign: "center", paddingHorizontal: PHONE.margin, marginBottom: 8 },
  actions: { flexDirection: "row", alignSelf: "stretch", alignItems: "flex-start", justifyContent: "space-around", paddingHorizontal: 8 },
  action: { flex: 1, minHeight: PHONE.target + 8, alignItems: "center", justifyContent: "flex-start", gap: 4, paddingVertical: 6, paddingHorizontal: 4 },
  actionLabel: { color: WHITE, fontSize: TYPE.secondary, lineHeight: 18, fontFamily: SANS },
  why: { color: SOFT, fontSize: TYPE.secondary, lineHeight: 16, textAlign: "center", fontFamily: SANS },
});
