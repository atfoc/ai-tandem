// The board host (AD-52): the component that holds one board view (Excalidraw behind `@aiwb/board-view`'s endpoint) where the
// canvas goes, as a channel the board side talks to. `board.web.tsx` mounts board-view's web target in the page, in-process
// (`window.aiwbBoardView.mount`, AD-40); `board.native.tsx` holds it in a web view. Both are the same component to the screen.
import type { BoardChannel } from "@aiwb/core/board/channel.ts";

/** The channel of a host, with what the screen needs to let a view go without losing a request that is on its way. */
export type HostChannel = BoardChannel & {
  /** How many requests wait for their reply. */
  inflight(): number;
  /** Resolves when none does (at once when none does now). */
  idle(): Promise<void>;
};

export type BoardHostProps = {
  /** Called once the host has made its channel (before the view says `ready`; what is sent waits for it), and with null when
   *  the host goes away. The channel stays the same when a web view's process ends and the page is loaded again. */
  onChannel(channel: HostChannel | null): void;
  /** An engine view nobody sees (AD-52): the box has no size worth the name and draws nothing. */
  hidden?: boolean;
  /** A page tried to open this address (a link on an element of the scene): the host refused, the screen may offer it. */
  onOpenLink?(url: string): void;
  testID?: string;
};
