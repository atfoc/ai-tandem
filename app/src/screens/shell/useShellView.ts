// What the window shows (stack.ts `shellView`) as a hook: the three parts are read as plain values, so the store's snapshot stays stable.
import { useMemo } from "react";

import { useStore } from "../../state/useStore.ts";
import { shellView, stackOf, sameRoutes, type Route, type ShellView } from "./stack.ts";

export function useShellView(): ShellView {
  const kind = useStore((s) => shellView(s).kind);
  const board = useStore((s) => { const v = shellView(s); return v.kind === "board" ? v.board : null; });
  const chat = useStore((s) => { const v = shellView(s); return v.kind === "home" ? null : v.chat; });
  return useMemo<ShellView>(() => (kind === "board" ? { kind, board: board!, chat } : kind === "chat" ? { kind, chat: chat! } : { kind }), [kind, board, chat]);
}

/** The phone's stack (stack.ts `stackOf`), the same list while the screens are the same. */
export function useRoutes(): Route[] {
  const key = useStore((s) => stackOf(s).join(","));
  return useMemo(() => key.split(",") as Route[], [key]);
}

export { sameRoutes };
