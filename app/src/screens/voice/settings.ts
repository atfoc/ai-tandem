// Settings > Voice (VC-13): the dialog in the shell's `Overlays` slot. The foot's gear button is `SettingsButton`, drawn by the sidebar's foot.
import { setSlot } from "../shell/slots.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";

setSlot("Overlays", SettingsDialog);
