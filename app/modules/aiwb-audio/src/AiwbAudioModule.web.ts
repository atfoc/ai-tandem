import type { AiwbAudioModule } from "./AiwbAudio.ts";

// The web build and the desktop window have their own audio (app/src/voice/platform/audio.web.ts): no native module.
const none: AiwbAudioModule | null = null;
export default none;
