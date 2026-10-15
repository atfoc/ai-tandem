// Scenes for the checks: a small one, and a large one of a realistic mix (shapes with labels, arrows, hand drawn strokes).
// Elements carry what restoreElements needs; Excalidraw fills in the rest.
import type { El, SceneData } from "../bridge/protocol.ts";

const base = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): El => ({
  id, type, x, y, width: w, height: h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
  strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1 + (x * 7 + y * 13) % 100000, version: 1,
  versionNonce: 1 + (x * 3 + y * 5) % 100000, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
});

export function smallScene(): SceneData {
  return {
    elements: [
      base("rect-a", "rectangle", 100, 100, 200, 100, { boundElements: [{ id: "txt-a", type: "text" }], customData: { key: "a" } }),
      base("txt-a", "text", 130, 135, 140, 30, { text: "Client", originalText: "Client", fontSize: 20, fontFamily: 6, textAlign: "center", verticalAlign: "middle", containerId: "rect-a", lineHeight: 1.25, autoResize: true }),
      base("rect-b", "rectangle", 500, 100, 200, 100, { boundElements: [{ id: "txt-b", type: "text" }], customData: { key: "b" } }),
      base("txt-b", "text", 530, 135, 140, 30, { text: "Server", originalText: "Server", fontSize: 20, fontFamily: 6, textAlign: "center", verticalAlign: "middle", containerId: "rect-b", lineHeight: 1.25, autoResize: true }),
    ],
    appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } },
    files: {},
  };
}

/** About n elements: 25% rectangles, 25% their bound labels, 25% ellipses and diamonds, 15% arrows, 10% freehand strokes. */
export function largeScene(n = 2000): SceneData {
  const els: El[] = [];
  const rects = Math.round(n * 0.25), others = Math.round(n * 0.25), arrows = Math.round(n * 0.15), strokes = n - rects * 2 - others - arrows;
  const cell = (i: number): [number, number] => [(i % 50) * 260, Math.floor(i / 50) * 180];
  for (let i = 0; i < rects; i++) {
    const [x, y] = cell(i);
    els.push(base(`r${i}`, "rectangle", x, y, 200, 90, { boundElements: [{ id: `t${i}`, type: "text" }, ...(i + 1 < rects && i < arrows ? [{ id: `a${i}`, type: "arrow" }] : [])] }));
    els.push(base(`t${i}`, "text", x + 20, y + 30, 160, 30, { text: `Node ${i}`, originalText: `Node ${i}`, fontSize: 20, fontFamily: 6, textAlign: "center", verticalAlign: "middle", containerId: `r${i}`, lineHeight: 1.25, autoResize: true }));
  }
  for (let i = 0; i < others; i++) { const [x, y] = cell(rects + i); els.push(base(`o${i}`, i % 2 ? "ellipse" : "diamond", x, y + 1500, 160, 100, { backgroundColor: i % 3 ? "#a5d8ff" : "#ffc9c9" })); }
  for (let i = 0; i < arrows; i++) { const [x, y] = cell(i); els.push(base(`a${i}`, "arrow", x + 200, y + 45, 60, 0, { points: [[0, 0], [60, 0]], startBinding: { elementId: `r${i}`, focus: 0, gap: 1 }, endBinding: i + 1 < rects ? { elementId: `r${i + 1}`, focus: 0, gap: 1 } : null, startArrowhead: null, endArrowhead: "arrow", lastCommittedPoint: null, elbowed: false })); }
  for (let i = 0; i < strokes; i++) {
    const [x, y] = cell(i); const pts: number[][] = []; for (let k = 0; k < 60; k++) pts.push([k * 2, Math.sin(k / 5 + i) * 20]);
    els.push(base(`s${i}`, "freedraw", x, y + 3000, 120, 40, { points: pts, pressures: [], simulatePressure: true, lastCommittedPoint: null }));
  }
  return { elements: els, appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 0.1 } }, files: {} };
}

export const emptyScene = (): SceneData => ({ elements: [], appState: { viewBackgroundColor: "#ffffff", scrollX: 0, scrollY: 0, zoom: { value: 1 } }, files: {} });
