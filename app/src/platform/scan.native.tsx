// The scan port on a device: a full-screen camera (expo-camera) that reads QR codes only and hands each new text to the flow. The flow decides
// whether it is a server's (the same parser as the paste) and answers the words of a refusal, which stay on screen while the camera looks
// on; a text taken ends the scan. The camera asks its permission here, with the reason, and when it was refused says where to allow it.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useContext, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";

import { SCAN_AIM, SCAN_CAMERA_ASK, SCAN_CAMERA_OFF } from "./scanwords.ts";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { tid } from "../ui/tid.ts";
import { S2_TID } from "../screens/servers/ids.ts";
import { localNetwork } from "./localnetwork.native.ts";
import type { ScannerProps } from "./scan.types.ts";

export type { ScannerProps } from "./scan.types.ts";

export const canScan = true;

/** The same text is not offered twice in a row inside this many milliseconds: a camera reads a code many times a second. */
const AGAIN_MS = 1500;

export function CodeScanner({ onText, onClose, onPaste, title, hint }: ScannerProps) {
  const [permission, ask] = useCameraPermissions();
  const [refusal, setRefusal] = useState("");
  const last = useRef({ text: "", at: 0 });
  const taken = useRef(false);
  const insets = useContext(SafeAreaInsetsContext);

  const seen = ({ data }: { data: string }) => {
    const now = Date.now();
    if (taken.current || (data === last.current.text && now - last.current.at < AGAIN_MS)) return;
    last.current = { text: data, at: now };
    const why = onText(data);
    if (why === null) taken.current = true;
    else setRefusal(why);
  };

  // dl-04b: full-screen dark; a 44 pt round × and the title at the top, the aim square, the words under it, "Paste text instead" at the foot.
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View {...tid("addserver-scanner")} style={styles.screen}>
        {permission?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={seen} />
        ) : null}
        <View style={styles.shade} pointerEvents="none" />
        <View style={[styles.top, { paddingTop: (insets?.top ?? 0) + 8 }]}>
          <Pressable {...tid(S2_TID.scanClose)} accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} style={styles.close}>
            <Svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round"><Path d="M4 4l10 10M14 4 4 14" /></Svg>
          </Pressable>
          {title ? <Text {...tid("add-scan-title")} accessibilityRole="header" size={17} weight="600" tone="onAccent" style={styles.title}>{title}</Text> : null}
        </View>
        {permission?.granted ? (
          <View style={styles.aimBox} pointerEvents="none">
            <View style={styles.aim}>
              <View style={[styles.corner, styles.tl]} /><View style={[styles.corner, styles.tr]} /><View style={[styles.corner, styles.bl]} /><View style={[styles.corner, styles.br]} />
            </View>
          </View>
        ) : (
          <View style={styles.ask}>
            {permission === null ? null : permission.canAskAgain ? (
              <>
                <Text tone="onAccent" style={styles.centre}>{SCAN_CAMERA_ASK}</Text>
                <Button tone="primary" label="Allow the camera" testID="addserver-camera-allow" onPress={() => void ask()} />
              </>
            ) : (
              <>
                <Text tone="onAccent" style={styles.centre}>{SCAN_CAMERA_OFF}</Text>
                <Button label="Open settings" testID="addserver-open-settings" onPress={() => void localNetwork.openSettings().catch(() => {})} />
              </>
            )}
          </View>
        )}
        <View style={[styles.foot, { paddingBottom: (insets?.bottom ?? 0) + 16 }]} pointerEvents="box-none">
          <Text {...tid("addserver-scan-words")} accessibilityLiveRegion="polite" size={15} style={[styles.centre, { color: refusal ? "#ffb4b4" : "#fff" }]}>{refusal || hint || SCAN_AIM}</Text>
          {onPaste ? (
            <Pressable {...tid(S2_TID.scanPaste)} accessibilityRole="button" accessibilityLabel="Paste text instead" onPress={onPaste} style={styles.paste}>
              <Text size={17} tone="onAccent">Paste text instead</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const CORNER = 36;
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#16161a" },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.25)" },
  top: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" },
  title: { flexShrink: 1 },
  ask: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  aimBox: { flex: 1, alignItems: "center", justifyContent: "center" },
  aim: { width: 240, height: 240 },
  corner: { position: "absolute", width: CORNER, height: CORNER, borderColor: "#fff" },
  tl: { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4 },
  tr: { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4 },
  bl: { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4 },
  br: { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4 },
  foot: { position: "absolute", left: 0, right: 0, bottom: 0, gap: 16, paddingHorizontal: 16, paddingTop: 16 },
  centre: { textAlign: "center" },
  paste: { minHeight: 50, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" },
});
