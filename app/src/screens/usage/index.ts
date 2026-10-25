// The context ring and the usage popup (package S9). Self-contained: the composer (K3) draws `ContextMeter` in its toolbar, and the subagent rows
// and the drawer (S7) draw `SubMeter`; the phone's sheet registers itself in the shell's `Overlays` slot (T3).
import { setSlot } from "../shell/slots.tsx";
import { UsageSheet } from "./UsageSheet.tsx";

setSlot("Overlays", UsageSheet);

export { ContextMeter } from "./ContextMeter.tsx";
export { CtxError, CtxRing, type CtxRingProps } from "./CtxRing.tsx";
export { SubMeter } from "./SubMeter.tsx";
export { UsageBody } from "./Popup.tsx";
export { UsageSheet } from "./UsageSheet.tsx";
export { closeUsage, openUsage, useUsageOpen } from "./open.ts";
export { contextLines, contextOf, ctxShare, ctxText, ctxTitle, fmtK, ringOf, type Context, type RingTone } from "./meter.ts";
