// The composer's context meter (the old page's Composer.tsx ContextMeter): the ring with "used / window pct%" for the branch a chat shows, and under a
// press its popup (Popup.tsx: the context and the plan's limits). A popover hung above the ring on the wide layouts and a sheet on the phone
// (ui/Overlay); Esc closes it before the composer sees it (the overlay stack). When the context is not known the meter is a warning icon with
// "Context unavailable" and the reason as its title, and nothing opens.
//
// K3 places it in the toolbar: `<ContextMeter chat={chatId} compact={f.meter === "ring"} />` (compact: the toolbar has no room for its text, which
// is then drawn and not seen: the ring alone shows, or the icon of the meter that says why).
import { useRef, useState } from "react";
import { View } from "react-native";

import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { shownView } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { useWhere } from "../chat/hooks.ts";
import { CtxError, CtxRing } from "./CtxRing.tsx";
import { contextLines, contextOf } from "./meter.ts";
import { UsageBody } from "./Popup.tsx";

export function ContextMeter({ chat, compact = false }: { chat: string; compact?: boolean }) {
  const c = useStore((s) => shownView(s, chat));
  const cat = useStore((s) => (c ? catalogFor(s, serverOf(c), c.agent) : undefined));
  const where = useWhere(c);
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  if (!c) return null;
  const { used, win, error } = contextOf(c, cat);
  if (error) return <CtxError reason={error} ringOnly={compact} />;
  return (
    <View ref={anchor} collapsable={false}>
      <CtxRing used={used} win={win} open={open} onPress={() => setOpen(!open)} ringOnly={compact} />
      {open && (
        <Overlay open onClose={() => setOpen(false)} label="Context and plan usage" kind="popover" anchor={anchor} up testID="usage-pop">
          <UsageBody c={c} lines={contextLines({ used, win })} where={where} />
        </Overlay>
      )}
    </View>
  );
}
