// The types of the mount (`window.aiwbTlView`, design 6), free of tldraw's types so the app can declare the global without
// importing tldraw: the link is core's `TlLink` (structurally: socket.ts's subset), the handle core's `TlViewHandle`.
import type { TlLink } from "@aiwb/core/tl/link.ts";
import type { TlViewHandle } from "@aiwb/core/tl/registry.ts";

/** The person at this window (D12). */
export type TlViewUser = { id: string; name: string; color: string };

export type MountOptions = {
  /** The board's key in the page (kept as `data-board` on the root element; the link already names the board). */
  board?: string;
  /** The board's sync line (core's `openTlLink(board)`; the app opens and closes it). Absent: a local store (the dev page). */
  link?: Pick<TlLink, "status" | "send" | "onMessages" | "onStatus" | "restart">;
  /** The person (D12): the name and colour others see on this window's cursor and selection. */
  user?: TlViewUser;
  /** `data-testid` of the board's root element. */
  testID?: string;
  /** The handle for `get_view`/`show_board` once the editor is ready (again if the editor is remade), null at unmount. */
  onHandle?(handle: TlViewHandle | null): void;
  /** The editor (tldraw's `Editor`) once it is ready (fonts loaded). */
  onMount?(editor: object): void;
};

export type TlView = { mount(element: HTMLElement, options?: MountOptions): { unmount(): void } };
