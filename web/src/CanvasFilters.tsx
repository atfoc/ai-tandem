// The SVG filters the canvas themes are made of (logic/canvastheme.ts says what each does), one per theme, in one
// hidden <svg> that the page holds for as long as it is open. flavours-canvas.css points Excalidraw's --theme-filter
// at them by id, so every .excalidraw of the page, and the container of its dialogs, finds them.
import React from "react";
import { CANVAS_THEMES, canvasFilter } from "./logic/canvastheme.ts";

// Static: the numbers are made once, when the page loads.
const FILTERS = CANVAS_THEMES.map((t) => {
  const f = canvasFilter(t), { r, g, b } = f.tables;
  return (
    // (the region is the whole box: a filter that only changes a colour moves nothing)
    <filter key={f.id} id={f.id} colorInterpolationFilters="sRGB" filterUnits="objectBoundingBox" x="0" y="0" width="1" height="1">
      <feColorMatrix type="matrix" values={f.matrix.join(" ")} />
      <feComponentTransfer>
        <feFuncR type="table" tableValues={r.join(" ")} />
        <feFuncG type="table" tableValues={g.join(" ")} />
        <feFuncB type="table" tableValues={b.join(" ")} />
      </feComponentTransfer>
    </filter>
  );
});

export function CanvasFilters() {
  return <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}><defs>{FILTERS}</defs></svg>;
}
