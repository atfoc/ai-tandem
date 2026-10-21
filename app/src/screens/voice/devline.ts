// The dev-only status line of the device flow `voice-mic` (package P17): registered in the shell's `Overlays` slot in a development build that was
// given a stand-in voice service (the variable only that flow's runner sets). A Release build and every build for people have no such line.
import { setSlot } from "../shell/slots.tsx";
import { VoiceDevLine } from "./DevLine.tsx";

if (__DEV__ && process.env.EXPO_PUBLIC_AIWB_VOICE_BASE) setSlot("Overlays", VoiceDevLine);
