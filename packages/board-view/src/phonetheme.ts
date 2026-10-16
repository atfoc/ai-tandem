// The canvas filter of the phone target: the same look as theme.ts's SVG filter, made of what the phone's engines draw on the
// GPU. DOM-free.
//
// The SVG filter (a reference filter, `url(#id)`) makes WebKit paint the canvas through its software filter path on every
// repaint, which is every frame of a pan or a pinch. CSS filter functions and `mix-blend-mode` on a layer are composited by
// the render server instead. Every CSS filter function is, per pixel, an affine map of the colour followed by a clamp, and
// every separable blend mode with a constant colour is a per-channel function of it, so what a cheap filter can draw is, per
// channel, the straight line through the two anchors of the theme (where the stored white and the stored #1e1e1e land),
// clipped at 0 and 1. The tables of the SVG filter bend between their anchors; this cannot. The line is exact for every
// colour whose channels lie between the anchors and differs where one lies outside (plans/excalidraw-optimization/replacement.md).
//
// A theme message gives:
//   stage    the CSS filter on the board's canvases: Excalidraw's own `invert(93%) hue-rotate(180deg)` (dark themes), or none
//            (Latte, whose matrix is the identity). A matrix that is neither is the fallback: today's SVG filter, as it is.
//   layers   up to three full-size constant-colour <div>s over the canvases, blended in this order:
//              color-dodge  d_c = 1 - v*_c      v*_c is where channel c's line reaches 1: clipped there, not before
//              multiply     m_c = b_c v*_c / (1 - a_c)
//              screen       s_c = a_c
//            which on the stage's output v gives s + (1 - s) m min(1, v / v*) = a + b v, up to where it reaches 1.
//
// `phoneShown` is the model of what the browser draws with that, held by the tests to `shown()` of logic/canvastheme.ts.
import type { CanvasFilterMsg } from "@aiwb/board-bridge/messages.ts";
import { themeCss } from "./theme.ts";

export type Layer = { mode: "color-dodge" | "multiply" | "screen"; colour: string };
export type PhoneCanvas =
  | { kind: "none" }
  | { kind: "layers"; stage: string; layers: Layer[] }
  | { kind: "fallback"; why: string };

/** The CSS filter on the canvases of the stage Excalidraw's dark theme has. */
const EXCALIDRAW_DARK = "invert(93%) hue-rotate(180deg)";
const NO_STAGE = "none";
/** How close a message's matrix is to a known stage, per entry (the matrix travels rounded to 1e-5). */
const MATRIX_TOLERANCE = 1e-4;
/** A layer whose colour is this close to the identity is left out. */
const IDENTITY_TOLERANCE = 1e-6;
/** Floating-point noise in a line's offset. */
const ROUNDING = 1e-9;

type Matrix = { m: number[][]; o: number[] }; // out = m · rgb + o, on 0 to 1

const IDENTITY: Matrix = { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], o: [0, 0, 0] };

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** `hue-rotate(a)` of the CSS Filter Effects spec: the luminance coefficients 0.213, 0.715 and 0.072. */
function hueRotate(c: number[], degrees: number): number[] {
  const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [
    (0.213 + cos * 0.787 - sin * 0.213) * c[0] + (0.715 - cos * 0.715 - sin * 0.715) * c[1] + (0.072 - cos * 0.072 + sin * 0.928) * c[2],
    (0.213 - cos * 0.213 + sin * 0.143) * c[0] + (0.715 + cos * 0.285 + sin * 0.140) * c[1] + (0.072 - cos * 0.072 - sin * 0.283) * c[2],
    (0.213 - cos * 0.213 - sin * 0.787) * c[0] + (0.715 - cos * 0.715 + sin * 0.715) * c[1] + (0.072 + cos * 0.928 + sin * 0.072) * c[2],
  ];
}

/** `invert(p)`: c' = p + c (1 - 2p), the spec's table of two values. */
const invert = (c: number[], p: number) => c.map((v) => p + v * (1 - 2 * p));

/** A stage of CSS functions applied to a colour (0 to 1), each function's result clamped as the browser does (`clamped`),
 *  or not (the matrix the functions are together). */
function applyStage(stage: string, c: number[], clamped = true): number[] {
  const step = clamped ? (v: number[]) => v.map(clamp) : (v: number[]) => v;
  if (stage === NO_STAGE) return c;
  if (stage === EXCALIDRAW_DARK) return step(hueRotate(step(invert(c, 0.93)), 180));
  throw new Error(`phonetheme: unknown stage "${stage}"`);
}

/** The matrix of a stage as the message carries it: the functions, unclamped, applied to the unit vectors. */
function stageMatrix(stage: string): Matrix {
  const o = applyStage(stage, [0, 0, 0], false);
  const columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => applyStage(stage, e, false).map((v, i) => v - o[i]));
  return { m: [0, 1, 2].map((i) => columns.map((col) => col[i])), o };
}

/** Whether the message's matrix is `stage`'s (the last row must be 0 0 0 1 0, and the channels must not be mixed with alpha). */
function matches(f: CanvasFilterMsg, stage: string): boolean {
  if (f.matrix.length !== 20) return false;
  const want = stage === NO_STAGE ? IDENTITY : stageMatrix(stage);
  const rows = [0, 1, 2].flatMap((i) => [...want.m[i], 0, want.o[i]]).concat([0, 0, 0, 1, 0]);
  return rows.every((v, i) => Math.abs(v - f.matrix[i]) <= MATRIX_TOLERANCE);
}

/** What feComponentTransfer type="table" does with x (linear interpolation between the entries). */
function lookup(table: number[], x: number): number {
  const pos = clamp(x) * (table.length - 1), k = Math.min(Math.floor(pos), table.length - 2);
  return table[k] + (pos - k) * (table[k + 1] - table[k]);
}

const text = (v: number) => String(+(v * 255).toFixed(3));
/** A colour of three channels (0 to 1) as CSS: decimals of 0 to 255 in the legacy comma syntax, which Chromium and WebKit both read. */
const css = (c: number[]) => `rgb(${c.map(text).join(", ")})`;

const STAGE_GREYS = { white: [1, 1, 1], ink: [0x1e / 255, 0x1e / 255, 0x1e / 255] };

/** The derivation of the design, steps 1 to 4. null: no filter at all, no rules and no layers. */
export function phoneCanvas(filter: CanvasFilterMsg | null): PhoneCanvas {
  if (!filter) return { kind: "none" };
  const tables = [filter.tables.r, filter.tables.g, filter.tables.b];
  if (tables.some((t) => !Array.isArray(t) || t.length < 2)) return { kind: "fallback", why: "a table has fewer than two entries" };
  const stage = matches(filter, EXCALIDRAW_DARK) ? EXCALIDRAW_DARK : matches(filter, NO_STAGE) ? NO_STAGE : null;
  if (!stage) return { kind: "fallback", why: `the matrix of ${filter.id} is neither Excalidraw's dark nor the identity` };

  // the anchors: what the stage makes of the stored white and of the stored #1e1e1e (a grey stays a grey: one number each)
  const grey = (c: number[]) => applyStage(stage, c).reduce((s, v) => s + v, 0) / 3;
  const vw = grey(STAGE_GREYS.white), vk = grey(STAGE_GREYS.ink);
  if (!(Math.abs(vw - vk) > 1e-6)) return { kind: "fallback", why: "the two anchors fall on one point" };

  const dodge: number[] = [], multiply: number[] = [], screen: number[] = [];
  for (let c = 0; c < 3; c++) {
    const ground = lookup(tables[c], vw), ink = lookup(tables[c], vk);
    const b = (ink - ground) / (vk - vw), raw = ground - b * vw, a = Math.abs(raw) < ROUNDING ? 0 : raw; // (a line through the origin is 0 to a rounding)
    if (!(b > 0)) return { kind: "fallback", why: `channel ${c}: the line does not rise (slope ${b})` };
    if (a < 0 || !(a < 1)) return { kind: "fallback", why: `channel ${c}: the line starts outside 0 to 1 (${a})` };
    const reach = Math.min(1, (1 - a) / b);
    dodge.push(1 - reach);
    multiply.push((b * reach) / (1 - a));
    screen.push(a);
  }

  const layers: Layer[] = [];
  const identity = (v: number[], at: number) => v.every((x) => Math.abs(x - at) <= IDENTITY_TOLERANCE);
  if (!identity(dodge, 0)) layers.push({ mode: "color-dodge", colour: css(dodge) });
  if (!identity(multiply, 1)) layers.push({ mode: "multiply", colour: css(multiply) });
  if (!identity(screen, 0)) layers.push({ mode: "screen", colour: css(screen) });
  return { kind: "layers", stage, layers };
}

// ---- what is shown

const channelOf = (c: string) => c.match(/-?\d+(\.\d+)?/g)!.map((v) => Number(v) / 255);

/** The separable blend formulas of Compositing and Blending Level 1, a source colour `s` over a backdrop `b`, per channel. */
function blend(mode: Layer["mode"], b: number, s: number): number {
  switch (mode) {
    case "multiply": return b * s;
    case "screen": return b + s - b * s;
    case "color-dodge": return b === 0 ? 0 : s === 1 ? 1 : Math.min(1, b / (1 - s));
  }
}

/** How a stored colour (#rrggbb) looks on the phone under the filter: the stage's functions by the spec's formulas, clamped
 *  after each, then each layer over the result so far. Throws for the fallback (the SVG filter draws it: `shown()` of
 *  logic/canvastheme.ts is its model) and for no filter (the colour is its own). */
export function phoneShown(filter: CanvasFilterMsg | null, colour: string): string {
  const p = phoneCanvas(filter);
  if (p.kind !== "layers") throw new Error(`phoneShown: no layers for this filter (${p.kind})`);
  let v = applyStage(p.stage, [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255));
  for (const layer of p.layers) {
    const s = channelOf(layer.colour);
    v = v.map((b, i) => clamp(blend(layer.mode, b, s[i])));
  }
  return "#" + v.map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

// ---- the CSS

/** The CSS of the phone target. No filter: none. The fallback: today's `themeCss`, to the letter. Layers: today's two rules, so
 *  `--theme-filter` is still `url(#id)` for everything of Excalidraw that wears it (the colour picker's swatches, the library, the
 *  text editor), and one more that gives the board's own canvases the stage in its place; it has the weight of five classes,
 *  over `canvas { filter: var(--theme-filter) }`. */
export function phoneThemeCss(filter: CanvasFilterMsg | null): string {
  const p = phoneCanvas(filter);
  if (p.kind !== "layers") return themeCss(filter);
  return [themeCss(filter), `:root .aiwb-board .excalidraw.excalidraw canvas.excalidraw__canvas { filter: ${p.stage}; }`].join("\n");
}
