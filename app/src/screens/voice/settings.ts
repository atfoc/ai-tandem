// Settings > Voice (VC-13): the dialog in the shell's `Overlays` slot on the wide layouts, and on the phone (S3) the pushed screens
// `voice-settings` and `choose-voice`. The foot's gear button is `SettingsButton`, drawn by the sidebar's foot.
import { registerScreen } from "../shell/screens.ts";
import { setSlot } from "../shell/slots.tsx";
import { ChooseVoice } from "./ChooseVoice.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { VoiceScreen } from "./VoiceScreen.tsx";
import { CV_TITLE, SETTINGS_VOICE_TITLE } from "../../voice/words.ts";

// (S1's placeholder for `voice-settings` is registered only while the name is free, so this one stands whichever file is imported first)
registerScreen("voice-settings", { kind: "place", title: () => SETTINGS_VOICE_TITLE, component: VoiceScreen });
registerScreen("choose-voice", { kind: "place", title: () => CV_TITLE, component: ChooseVoice });
setSlot("Overlays", SettingsDialog);
