// A subagent's ring in its row and in the drawer (the old page's Subagents.tsx SubMeter, B-US-12): its tokens and window, shown without a press, the
// title (on hover) saying them; nothing before it has used any.
import type { Subagent } from "@aiwb/core/types.ts";

import { CtxRing } from "./CtxRing.tsx";
import { ctxTitle } from "./meter.ts";

export function SubMeter({ sa }: { sa: Pick<Subagent, "tokens" | "window"> }) {
  const used = sa.tokens ?? 0, win = sa.window ?? 0;
  if (!used) return null;
  return <CtxRing used={used} win={win} title={ctxTitle(used, win)} sub testID="ctx-meter" />;
}
