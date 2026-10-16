// The entry of the engine bundle (`build.mjs` → `dist/engine.mjs`): the stand-in page first, then the board view's engine on given
// elements, which answers the requests the board side sends. `node.ts` imports this bundle from the assets folder.
import "./page-first.ts";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { answer } from "@aiwb/board-view/engine.ts";

declare const __EXCALIDRAW_VERSION__: string;

/** The Excalidraw inside this bundle. */
export const excalidrawVersion: string = __EXCALIDRAW_VERSION__;

// Excalidraw declares its FontFaces the first time it needs a font's metrics; one text element makes it do so now, before any font
// string is measured (a font string measured earlier would fall back).
convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: "x" }] as never);

export type GivenEndpointOptions = {
  /** What `ready` tells as its version. */
  version: string;
  /** Where the engine logs a line; never board content. */
  warn: (text: string) => void;
};

/** The board view's endpoint for the requests on given elements: a `req` is answered once with a `res` (`answer`: the value, an
 *  `RpcError`'s code, or `FAILED`; `snapshot` and a `"live"` target are `NO_BOARD`), every other message is ignored. Posts `ready`
 *  once, now. */
export function createGivenEndpoint(post: (m: FromBoard) => void, { version, warn }: GivenEndpointOptions): {
  receive(m: ToBoard): void;
  refuse(raw: unknown, error: string): void;
} {
  post({ t: "ready", version });
  return {
    receive(m) {
      if (m.t === "req") void answer(m.id, m.op, post);
    },
    refuse(raw, error) {
      warn(`board engine: refused a message: ${error}`);
      const r = raw as { t?: unknown; id?: unknown } | null;
      if (r && typeof r === "object" && r.t === "req" && typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id >= 0) {
        post({ t: "res", id: r.id, ok: false, code: "BAD_MESSAGE", message: error });
      }
    },
  };
}
