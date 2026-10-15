// The type of `window.aiwbBoardView`, which the web target (`board.js`, AD-40) defines. No import of Excalidraw, of React or of
// the endpoint here: the app's type check reads this file and must never read Excalidraw's sources. The messages are the
// bridge's (`@aiwb/board-bridge`), which have no dependency either.
import type { FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";

export type AiwbBoardViewOptions = {
  /** A class and a test id for the box the board fills (a `div` made inside the element mounted into). */
  className?: string;
  testID?: string;
};

/** A board view mounted into a page element. */
export type AiwbBoardViewHandle = {
  /** Sends the view a message of the app. Anything may be passed: the view validates it, drops what fails (logged) and
   *  answers a request that fails with `BAD_MESSAGE`. Send nothing before the view posted `ready`. */
  receive(m: ToBoard | unknown): void;
  /** Takes the board out of the element. What the view had not told yet is told first (`changed`). */
  unmount(): void;
};

export type AiwbBoardView = {
  /** Mounts the board into `element` (which should have a size: the board fills it). `post` gets everything the view
   *  tells the app, as objects (a function call, no text), as it runs, not from a React render. */
  mount(element: HTMLElement, post: (m: FromBoard) => void, options?: AiwbBoardViewOptions): AiwbBoardViewHandle;
};

declare global {
  interface Window {
    /** Defined by `board.js` (board-view's web target, loaded before the app's bundle). */
    aiwbBoardView?: AiwbBoardView;
  }
}
