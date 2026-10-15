// The scan port on a device: a full-screen camera (expo-camera) that reads QR codes only and hands each new text to the flow. The flow decides
// whether it is a server's (the same parser as the paste) and answers the words of a refusal, which stay on screen while the camera looks
// on; a text taken ends the scan. The camera asks its permission here, with the reason, and when it was refused says where to allow it.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";

import { SCAN_AIM, SCAN_CAMERA_ASK, SCAN_CAMERA_OFF } from "./scanwords.ts";
import { Button } from "../ui/Button.tsx";
import { Text } from "../ui/Text.tsx";
import { tid } from "../ui/tid.ts";
import { localNetwork } from "./localnetwork.native.ts";
import type { ScannerProps } from "./scan.types.ts";

export type { ScannerProps } from "./scan.types.ts";

export const canScan = true;

/** The same text is not offered twice in a row inside this many milliseconds: a camera reads a code many times a second. */
const AGAIN_MS = 1500;

export function CodeScanner({ onText, onClose }: ScannerProps) {
  const [permission, ask] = useCameraPermissions();
  const [refusal, setRefusal] = useState("");
  const last = useRef({ text: "", at: 0 });
  const taken = useRef(false);

  const seen = ({ data }: { data: string }) => {
    const now = Date.now();
    if (taken.current || (data === last.current.text && now - last.current.at < AGAIN_MS)) return;
    last.current = { text: data, at: now };
    const why = onText(data);
    if (why === null) taken.current = true;
    else setRefusal(why);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View {...tid("addserver-scanner")} style={styles.screen}>
        {permission?.granted ? (
          <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={seen} />
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
        <View style={styles.foot} pointerEvents="box-none">
          <Text {...tid("addserver-scan-words")} tone="onAccent" style={styles.centre}>{refusal || SCAN_AIM}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel" {...tid("addserver-scan-cancel")} onPress={onClose} style={styles.cancel}>
            <Text tone="onAccent">Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#000" },
  camera: { flex: 1 },
  ask: { flex: 1, alignItems: "center", justifyContent: "center", gap: 14, padding: 24 },
  foot: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center", gap: 12, padding: 24, paddingBottom: 40, backgroundColor: "rgba(0,0,0,0.55)" },
  centre: { textAlign: "center" },
  cancel: { paddingVertical: 8, paddingHorizontal: 18 },
});
