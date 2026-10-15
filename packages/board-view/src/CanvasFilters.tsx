// The SVG filter the canvas theme is made of (logic/canvastheme.ts says what each does), the one the `theme` message carries,
// in a hidden <svg> that the view holds while it is mounted. themeCss (theme.ts) points Excalidraw's --theme-filter at it by
// id, so every .excalidraw of the document, and the container of its dialogs, finds it.
import React from "react";
import type { CanvasFilterMsg } from "@aiwb/board-bridge/messages.ts";
import { matrixValues, tableValues } from "./theme.ts";

export function CanvasFilters({ filter }: { filter: CanvasFilterMsg | null }) {
  if (!filter) return null;
  const { r, g, b } = filter.tables;
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute" }}>
      <defs>
        {/* (the region is the whole box: a filter that only changes a colour moves nothing) */}
        <filter id={filter.id} colorInterpolationFilters="sRGB" filterUnits="objectBoundingBox" x="0" y="0" width="1" height="1">
          <feColorMatrix type="matrix" values={matrixValues(filter)} />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={tableValues(r)} />
            <feFuncG type="table" tableValues={tableValues(g)} />
            <feFuncB type="table" tableValues={tableValues(b)} />
          </feComponentTransfer>
        </filter>
      </defs>
    </svg>
  );
}
