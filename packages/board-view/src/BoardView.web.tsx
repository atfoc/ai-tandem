// The board in the page itself, for the web build (AD-51): the endpoint mounted in place, wired in-process. `post` is a
// function call and `receive` is called directly, so the web build runs the same message protocol as the web view and the
// browser checks test the bridge logic on every board check.
//
//   <BoardView post={(m) => ...} ref={(h) => h?.receive({ t: "load", ... })} />
//
// `receive` validates what it is given, as the web view's entry does for the text it is given; a message that fails is
// logged and dropped (a request is answered with BAD_MESSAGE). The view says `ready` once it is mounted: send nothing before.
// (first: where Excalidraw's fonts are and that it takes them from nowhere else; the web target, src/web/entry.tsx, sets
// EXCALIDRAW_ASSET_PATH to the folder board.js was loaded from, where build.mjs puts fonts/)
import "./fonts.ts";
import React, { useImperativeHandle, useMemo, useRef, type CSSProperties, type Ref } from "react";
import "@excalidraw/excalidraw/index.css";
import type { FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { createEndpoint } from "./endpoint.ts";

export type BoardViewHandle = {
  /** Sends the view a message of the app. Anything may be passed: it is validated. */
  receive(m: ToBoard | unknown): void;
};

export type BoardViewProps = {
  /** Everything the view tells the app. Called as the view runs, not from a React render. */
  post: (m: FromBoard) => void;
  ref?: Ref<BoardViewHandle>;
  className?: string;
  style?: CSSProperties;
  testID?: string;
};

export function BoardView({ post, ref, className, style, testID }: BoardViewProps) {
  const latestPost = useRef(post);
  latestPost.current = post;
  const endpoint = useMemo(() => createEndpoint((m) => latestPost.current(m), { version: "in-page" }), []);
  useImperativeHandle(ref, () => ({
    receive(m) {
      const r = validateToBoard(m);
      if (r.ok) endpoint.receive(r.value); else endpoint.refuse(m, r.error);
    },
  }), [endpoint]);
  const Mount = endpoint.mount;
  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", ...style }} data-testid={testID}>
      <Mount />
    </div>
  );
}
