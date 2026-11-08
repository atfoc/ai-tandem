// The new board's web target (spike of board-tl's): one script, `board-tl.js`, like board-view's `board.js`. It defines
// `window.aiwbBoardTl.mount(element, options) → { editor, unmount }`; the app's board host would call it as it calls
// `aiwbBoardView.mount` (no iframe: an own React root in a box of the app's page). The spike page (page.js) mounts it
// with the seeded mock board.
import "tldraw/tldraw.css";
import "./board.css";
import { createRoot } from "react-dom/client";
import type { Editor } from "tldraw";
import { Board } from "./Board.tsx";
import { seed } from "./seed.ts";

declare global {
  interface Window {
    aiwbBoardTl: { mount(element: HTMLElement, options?: { seed?: boolean; onEditor?: (e: Editor) => void }): { unmount(): void } };
    editor?: Editor;
  }
}

window.aiwbBoardTl = {
  mount(element, options = {}) {
    const root = createRoot(element);
    root.render(
      <Board
        onMount={(editor) => {
          window.editor = editor; // (research seam for the Playwright runs; not in board-tl)
          void (options.seed ? seed(editor) : Promise.resolve()).then(() => options.onEditor?.(editor));
        }}
      />,
    );
    return { unmount: () => root.unmount() };
  },
};
