// The web target (AD-40): board-view's in-page view as one script, `board.js`, for the web build. It defines
// `window.aiwbBoardView.mount(element, post, options)`; the app's `board.web.tsx` calls it with an in-process `post`, so the
// web build speaks the same messages as the web view does. Excalidraw, its own React and the endpoint are inside; the two
// React roots (the app's and this one) share nothing but the element.
import "./assetpath.ts";
import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import { BoardView, type BoardViewHandle } from "../BoardView.web.tsx";
import type { AiwbBoardView } from "./api.ts";

const api: AiwbBoardView = {
  mount(element, post, options = {}) {
    const handle = createRef<BoardViewHandle>();
    const root = createRoot(element);
    root.render(<BoardView post={post} ref={handle} className={options.className} testID={options.testID} />);
    return {
      receive(m) {
        if (handle.current) handle.current.receive(m);
        else console.warn("board view: a message came before the view said `ready`; dropped");
      },
      unmount() { root.unmount(); },
    };
  },
};

window.aiwbBoardView = api;
