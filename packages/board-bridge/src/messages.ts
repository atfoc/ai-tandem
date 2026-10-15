// The board bridge (AD-50): every message between the app and the board view, both ways. The board view is Excalidraw
// and its endpoint (`@aiwb/board-view`), in the page itself on the web build and in a web view on a phone; the app is
// everything else. The messages are JSON-safe (no functions, no Blobs; pictures as base64), so they cross a web view's
// `postMessage` as they are and the in-page view gets the same ones by a function call. `validate.ts` has a validator
// for each: the app validates what comes from the view, the view what comes from the app.
//
// The bridge carries no address, no secret, no server and no call (goal 6). The view can ask for nothing; it tells the
// state of the board it shows.
//
// Types, and the names of the messages; the code is in `validate.ts`.
import type { ChromeMsg } from "./chrome.ts";

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** An Excalidraw element, as loose as the bridge needs: its id and its version. The rest is the engine's. */
export type El = Record<string, unknown> & { id: string; version: number };

/** Excalidraw's `BinaryFiles` (a picture by file id), loose: each file is an object. */
export type Files = Record<string, Record<string, unknown>>;

/** What a board file keeps of the view: where it is scrolled, how far it is zoomed (Excalidraw's `{ value }`) and the
 *  colour of the sheet. Every key may be absent (a board nobody drew on has `{}`). */
export type SavedAppState = {
  scrollX?: number;
  scrollY?: number;
  zoom?: { value: number };
  viewBackgroundColor?: string;
};

/** The drawing style the user last chose, the `currentItem*` keys of Excalidraw's appState that `Canvas.tsx` carries from
 *  one board to the next (stroke colour, fill, font, roundness, arrow type, …). */
export type CurrentItemStyle = Record<`currentItem${string}`, string | number | boolean | null>;

/** An SVG filter that gives the canvas a theme (`logic/canvastheme.ts` `CanvasFilter`): an feColorMatrix of 4 rows of
 *  5 values, then an feComponentTransfer with a table of 256 values in 0 to 1 per channel. `id` names it in the view's
 *  document (letters, digits, `_` and `-`). */
export type CanvasFilterMsg = {
  id: string;
  matrix: number[];
  tables: { r: number[]; g: number[]; b: number[] };
};

/** The theme of the board: Excalidraw's own `light` or `dark`, the filter laid over the canvas (null for plain light and
 *  for plain Excalidraw dark, which has none of ours) and, in a Catppuccin flavour, the colours of Excalidraw's chrome
 *  (`chrome.ts`; absent or null: Excalidraw's own). The board's colours stay the stored ones; the theme is a view. */
export type ThemeMsg = { mode: "light" | "dark"; filter: CanvasFilterMsg | null; chrome?: ChromeMsg | null };

/** A reference to an element: by its id, or by the `key` an agent gave it. */
export type Ref = { id: string } | { key: string };

/** The call of `apply.ts` `applyChanges`: what to create, update and delete, what to select afterwards, whether to scroll
 *  the result into view. Each create, update and delete is a JSON object (its meaning is `apply.ts`'s, not the bridge's). */
export type ApplyParams = {
  create?: Record<string, unknown>[];
  update?: Record<string, unknown>[];
  delete?: Record<string, unknown>[];
  select?: Ref[];
  focus?: boolean;
};

/** A scene (a board's content) as the view takes it and gives it back. */
export type SceneMsg = { elements: El[]; files: Files; appState: SavedAppState };

/** What an operation works on: the scene on the screen, or the given elements without touching the canvas (a board that
 *  is not on screen). */
export type ElementsTarget = "live" | { elements: El[] };

/** The work the view does for the app and answers with `res`. */
export type EngineOp =
  | { op: "apply"; target: ElementsTarget; params: ApplyParams; rev: number }
  | { op: "delete"; target: ElementsTarget; refs: Ref[]; cascade: boolean; rev: number }
  | { op: "restore"; elements: unknown[] }
  | { op: "export"; target: "live" | { elements: El[]; files: Files; appState: SavedAppState };
      ids: string[]; scale: number; background: boolean }
  | { op: "snapshot" };

// What a request is answered with (`res` with `ok: true`), by its `op`. `res.value` itself stays `unknown` in `FromBoard`: the
// reply does not say which request it answers, the app does (it keeps the id it sent). `validate.ts` checks a value
// against its op (`validateEngineValue`). A request that fails is `res` with `ok: false`, a `code` and a `message`
// (the codes are the ones the board tools use: `BAD_PARAMS`, `BAD_REF`, `NO_BOARD`, `TOO_LARGE`, `EMPTY`, `RENDER_FAILED`, …).

/** `apply` (and `delete`): what `apply.ts` `applyChanges` answers. `rev` is the one the request carried. `elements` (every
 *  element of the scene after the change, deleted ones included, in scene order) is there only when the request's target
 *  was `{ elements }`: the app keeps that scene. For the live scene the app is told by `changed`, which the view sends before
 *  this reply. */
export type ApplyValue = {
  created: Record<string, string>;
  updated: string[];
  deleted: string[];
  conflicts: { ref: Ref; expectedVersion: number; actualVersion?: number }[];
  rev: number;
  elements?: El[];
};
export type DeleteValue = ApplyValue;

/** `restore`: Excalidraw's `restoreElements` over the given elements (an element it cannot restore is dropped). */
export type RestoreValue = { elements: El[] };

/** `export`: the picture. `png` is base64 with no `data:` prefix. `width` and `height` are the pixels of the PNG (the
 *  bounds and the padding on both sides, times the scale, rounded up). `bounds` is the box of what is drawn, in board
 *  coordinates, padding left out: the numbers `get_image` tells the agent. `count` is the number of elements drawn, bound
 *  text counted with its container. The request's `ids` name the elements to draw (bound text of a named container is
 *  drawn with it); an empty list means every element of the scene. An element with no extent (zero width and height) is
 *  left out, as Excalidraw drops it. The pictures are limited as `get_image` limits them (8192 px on a side, 32 million
 *  pixels): a bigger one fails with `TOO_LARGE`, nothing to draw with `EMPTY`. */
export type ExportValue = {
  png: string;
  width: number;
  height: number;
  bounds: { x: number; y: number; width: number; height: number };
  count: number;
};

/** `snapshot`: the scene of the board the view shows, now. `elements` are all of them, deleted ones included. `files` is
 *  every picture the scene holds. `appState` is what a board file keeps of the view and `style` the drawing style
 *  last chosen: what `changed` carries, with all files and no debounce. `board` is the board the view shows, so the
 *  app can tell an answer for another board (the view moved on) from the one it wants. With no board shown the request
 *  fails with `NO_BOARD`. */
export type SnapshotValue = { board: string; elements: El[]; files: Files; appState: SavedAppState; style: CurrentItemStyle };

/** The value of each request, by its `op`. */
export type EngineValues = {
  apply: ApplyValue;
  delete: DeleteValue;
  restore: RestoreValue;
  export: ExportValue;
  snapshot: SnapshotValue;
};

/** App → board view. */
export type ToBoard =
  | { t: "load"; board: string; scene: SceneMsg; viewMode: boolean; theme: ThemeMsg; style: CurrentItemStyle }
  | { t: "unload" }
  | { t: "viewMode"; on: boolean }
  | { t: "theme"; theme: ThemeMsg }
  | { t: "select"; ids: string[] }
  | { t: "scrollTo"; ids: string[]; animate: boolean }
  | { t: "req"; id: number; op: EngineOp };

/** Board view → app. `changed` is a **delta** (AD-50; `delta.ts` makes and applies it): `elements` are those whose version
 *  differs from what the app last heard for this board (new ones, and deleted ones, which Excalidraw keeps with
 *  `isDeleted: true`), `order` is every element id in scene order, sent when the order or the set of ids changed, `files`
 *  are the files added since the last `changed` (files are never changed in place). The baseline is what `load` gave, or the
 *  scene of the last `snapshot`, then each `changed`. */
export type FromBoard =
  | { t: "ready"; version: string }
  | { t: "loaded"; board: string }
  | { t: "changed"; board: string; elements: El[]; order?: string[]; files?: Files; appState: SavedAppState; style: CurrentItemStyle }
  | { t: "view"; board: string; scrollX: number; scrollY: number; zoom: number; width: number; height: number }
  | { t: "selection"; board: string; ids: string[] }
  | { t: "res"; id: number; ok: true; value: unknown }
  | { t: "res"; id: number; ok: false; code: string; message: string }
  | { t: "error"; message: string };

/** The `t` of every message each way. */
export const TO_BOARD_TYPES = ["load", "unload", "viewMode", "theme", "select", "scrollTo", "req"] as const;
export const FROM_BOARD_TYPES = ["ready", "loaded", "changed", "view", "selection", "res", "error"] as const;
/** The `op` of every request. */
export const ENGINE_OPS = ["apply", "delete", "restore", "export", "snapshot"] as const;
