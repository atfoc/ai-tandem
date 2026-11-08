// The host of a new board's view (kind "tl", plans/better-board/design.md 6): `tlboard.web.tsx` mounts board-tl's web target
// (`tl/tl.js`, `window.aiwbTlView`) into a box of the page, as board.web.tsx mounts board-view's; `tlboard.native.tsx` says the
// phone does not have new boards yet (goal 5). The app does not import tldraw or board-tl's view: these types are structural.
import type { TlLink } from "@aiwb/core/tl/link.ts";
import type { TlViewHandle } from "@aiwb/core/tl/registry.ts";

import type { TlUser } from "../screens/board/tluser.ts";

export type TlHostProps = {
  /** The board's key in the page. */
  board: string;
  /** The board's sync line (core's openTlLink), made and closed by the screen. */
  link: TlLink;
  /** The person, as the others see them (D12). */
  user: TlUser;
  /** The view's handle once it has mounted (for get_view and show_board), null when it goes. */
  onHandle(handle: TlViewHandle | null): void;
  testID?: string;
};

/** What `tl/tl.js` defines on the page: `window.aiwbTlView`. */
export type TlViewApi = {
  mount(element: HTMLElement, options: { board: string; link: TlLink; user: TlUser; testID?: string; onHandle(handle: TlViewHandle | null): void }): { unmount(): void };
};
