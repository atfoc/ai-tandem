// What the window shows (stack.ts `shellView`) as a hook: the three parts are read as plain values, so the store's snapshot stays stable.
import { useMemo, useRef, useSyncExternalStore } from "react";

import { useStore } from "../../state/useStore.ts";
import { useHomePlace } from "./homeplace.ts";
import { withLastGroups } from "./phone/lastgroups.ts";
import { pushedEntries, subscribePushed } from "./screens.ts";
import { sameKeys, shellView, stackOf, type ShellView, type StackEntry } from "./stack.ts";

export function useShellView(): ShellView {
  const kind = useStore((s) => shellView(s).kind);
  const board = useStore((s) => { const v = shellView(s); return v.kind === "board" ? v.board : null; });
  const chat = useStore((s) => { const v = shellView(s); return v.kind === "home" ? null : v.chat; });
  return useMemo<ShellView>(() => (kind === "board" ? { kind, board: board!, chat } : kind === "chat" ? { kind, chat: chat! } : { kind }), [kind, board, chat]);
}

/** The phone's stack (stack.ts `stackOf`) with Home's place and the pushed screens, the same list while its screens and their titles are. */
export function useStack(): StackEntry[] {
  const place = useHomePlace();
  const pushed = useSyncExternalStore(subscribePushed, pushedEntries, pushedEntries);
  const last = useRef<StackEntry[]>([]);
  return useStore((s) => {
    const next = stackOf(withLastGroups(s, place), place, pushed);
    if (sameKeys(last.current, next) && last.current.every((e, i) => e.title === next[i]!.title)) return last.current;
    return (last.current = next);
  });
}
