// The stop-gap of Settings until package S1 (settings.ts): a sheet holding the sidebar's foot. It closes when the foot opens a dialog or a screen
// of its own (Servers, the library, the voice settings), so nothing is left behind it.
import { useEffect } from "react";

import { useStore } from "../../state/useStore.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { useVoiceSettingsOpen } from "../../voice/index.ts";
import { Foot } from "../sidebar/Foot.tsx";
import { H1_TID } from "./ids.ts";
import { closeSettingsStopgap, useSettingsStopgap } from "./settings.ts";

export function SettingsStopgap() {
  const open = useSettingsStopgap();
  const elsewhere = useStore((s) => s.serversDialog !== null || s.libraryDialog !== null);
  const voice = useVoiceSettingsOpen();
  const away = elsewhere || voice;
  useEffect(() => { if (open && away) closeSettingsStopgap(); }, [open, away]);
  if (!open) return null;
  return (
    <Sheet open onClose={closeSettingsStopgap} label="Settings" testID={H1_TID.settingsStopgap} detent="fit" head={<SheetHead title="Settings" />}>
      <Foot />
    </Sheet>
  );
}
