// The ports of voice in the web build and the desktop window (architecture §3.2). Made once in bootstrap; making them starts nothing (no
// socket, no microphone, no audio context until a tap).
import type { VoicePorts } from "../ports.ts";
import { audioWeb } from "./audio.web.ts";
import { webKeystore } from "./keystore.web.ts";
import { webNet, type WebWindow } from "./net.web.ts";

export function platformVoicePorts(): VoicePorts {
  const win = window as WebWindow; // the desktop's preload may have put `aiwbVoice` on it
  const keystore = webKeystore(win);
  return {
    keystore,
    net: webNet(win, keystore),
    audio: audioWeb(),
    now: () => Date.now(),
    // Only an address of the web, in a new tab with no opener (as the page's links do).
    openLink: (url) => { if (url.startsWith("https://")) window.open(url, "_blank", "noopener,noreferrer"); },
  };
}
