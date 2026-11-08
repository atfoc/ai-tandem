// The new board's web target, `tl.js` (like board-view's `board.js`): `window.aiwbTlView.mount(element, options) → { unmount }`,
// an own React root in a box of the app's page (no iframe; decision U2). The dev page (`build.mjs --dev-page`) mounts it with
// the seeded mock board.
import "tldraw/tldraw.css";
import "../view/board.css";
import { createRoot } from "react-dom/client";
import type { Editor } from "tldraw";
import { Board } from "../view/Board.tsx";
import { seed } from "../../dev/seed.ts";

export type MountOptions = {
  /** TEMPORARY (dev page): fill the board with mock elements (dev/seed.ts). */
  seed?: boolean;
  /** Called once the editor is ready (fonts loaded; after the seed when `seed`). */
  onMount?(editor: Editor): void;
};

export type TlView = { mount(element: HTMLElement, options?: MountOptions): { unmount(): void } };

declare global {
  interface Window {
    aiwbTlView: TlView;
  }
}

window.aiwbTlView = {
  mount(element, options = {}) {
    const root = createRoot(element);
    root.render(
      <Board
        onMount={(editor) => {
          if (options.seed) seed(editor);
          options.onMount?.(editor);
        }}
      />,
    );
    return { unmount: () => root.unmount() };
  },
};
