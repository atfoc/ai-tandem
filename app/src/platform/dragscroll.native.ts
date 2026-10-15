// On the native platforms the gesture handler's arbitration decides between the list's scroll and the drag (and the sidebar's scroll view is
// switched off while a drag lasts: Sidebar.tsx).
import type { ScrollGuard } from "./dragscroll.types.ts";

export type { ScrollGuard } from "./dragscroll.types.ts";

export const makeScrollGuard = (): ScrollGuard => ({ guard: () => {}, hold: () => {} });
export const scrollGuard: ScrollGuard = makeScrollGuard();
