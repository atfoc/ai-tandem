import { requireOptionalNativeModule } from "expo";

import type { AiwbAudioModule } from "./AiwbAudio.ts";

// The native module (ios/AiwbAudioModule.swift, android/.../AiwbAudioModule.kt). Its contract is AiwbAudio.ts. Null in a build that was
// made before the module existed: the audio port then fails each call that needs the device, and voice says so.
export default requireOptionalNativeModule<AiwbAudioModule>("AiwbAudio");
