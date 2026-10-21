// The ports of voice on a phone (architecture §3.2): the secure store, the page's own calls to the service, the native audio. Made once
// in bootstrap; making them starts nothing (no socket, no microphone, no player until a tap).
import { Linking } from "react-native";

import type { VoicePorts } from "../ports.ts";
import { audioNative } from "./audio.native.ts";
import { keystore } from "./keystore.native.ts";
import { nativeNet } from "./net.native.ts";

export function platformVoicePorts(): VoicePorts {
  return {
    keystore,
    net: nativeNet(keystore),
    audio: audioNative(),
    now: () => Date.now(),
    // Only an address of the web: the system's browser opens it.
    openLink: (url) => { if (url.startsWith("https://")) Linking.openURL(url).catch(() => { /* no app takes the address: nothing opens */ }); },
  };
}
