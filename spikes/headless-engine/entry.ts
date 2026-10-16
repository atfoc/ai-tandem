// The Node engine: the stand-in page first (Excalidraw makes images and FontFaces when it is evaluated), then the engine.
import "./page-first.mjs";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
// Excalidraw declares its FontFaces the first time it needs a font's metrics; one text element makes it do so now, before any
// font string is measured.
convertToExcalidrawElements([{ type: "text", x: 0, y: 0, text: "x" }] as never);
export { request, ops } from "./engine.ts";
export * as excalidraw from "@excalidraw/excalidraw";
export { faces, nativeFont, usableFaces, runsOf } from "./fonts.mjs";
export { lib } from "./canvaslib.mjs";
