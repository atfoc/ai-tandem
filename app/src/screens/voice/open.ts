// Opening Settings > Voice on the phone (S3): what `openVoiceSettings()` means there. No react-native here.
import { popScreen, pushedEntries, pushScreen } from "../shell/screens.ts";

/** Whether the phone's Voice screen is mounted: while it is, the voice store's "Settings is open" flag is the screen's own (set at mount,
 *  cleared at unmount), so the engine ends Settings' notice and its microphone test when the person leaves it, as when the dialog closes. */
let shown = 0;
export const voiceScreenShown = (): boolean => shown > 0;
export function voiceScreenMounted(): () => void {
  shown++;
  return () => { shown--; };
}

/** Shows the pushed Voice screen so that its back always reads "‹ Settings" (goal 3.1.2): already on top, nothing; Settings on top, push Voice;
 *  anything else, push Settings and then Voice. */
export function openVoicePhone(): void {
  const top = pushedEntries().at(-1);
  if (top?.name === "voice-settings") return;
  if (top?.name !== "settings") pushScreen("settings", {});
  pushScreen("voice-settings", {});
}

/** Takes the pushed Voice screen away (an owner closing it). */
export function closeVoicePhone(): void {
  const entry = pushedEntries().find((e) => e.name === "voice-settings");
  if (entry) popScreen(entry.key);
}
