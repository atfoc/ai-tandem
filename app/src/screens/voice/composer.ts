// The composer's voice (VC-17): the Dictate and Speech mode buttons (`VoiceButtons`) and the speech bar (`SpeechBar`), registered here with `setComposerPart`.
// The mic mark of a spoken message (VC-23, the chat part `MessageMark`) goes with speech mode, and is registered here too.
import { setChatPart } from "../chat/index.ts";
import { setComposerPart } from "../composer/parts.tsx";
import { ComposerVoice } from "./ComposerVoice.tsx";
import { MicMark } from "./MicMark.tsx";
import { SpeechBar } from "./SpeechBar.tsx";

setComposerPart("VoiceButtons", ComposerVoice);
setComposerPart("SpeechBar", SpeechBar);
setChatPart("MessageMark", MicMark);
