// How a theme looks on the canvas: a view transform, never a change of the board. DOM-free. The board file is shared
// (agents read it, the image export draws it with exportWithDarkMode:false, other windows show it), so the colours
// it holds are always the light-space ones Excalidraw draws by default, and a theme only changes how they look.
//
// Excalidraw does its own dark mode the same way: CSS puts `filter: invert(93%) hue-rotate(180deg)` on the canvases.
// Here the filter is an SVG one in its place, in two stages. The first is an feColorMatrix: for the dark themes
// Excalidraw's own two steps folded into one matrix (the CSS Filter Effects formulas), the identity for Latte. The
// second is an feComponentTransfer with a table per channel, a curve through four anchors that puts the theme's ground
// where the stored white lands and the theme's ink where the stored default stroke lands:
//
//   dark themes   (0 → 0), (s(white) → Ground), (s(ink) → Ink), (1 → 1)   s(x): stage 1 for the grey x
//   Latte         (0 → 0), (ink → Ink), (1 → Ground)
//
// A stored white is the canvas's own default background and a stored #1e1e1e its default stroke, so a board that
// was never coloured shows the theme's ground and ink exactly. Plain light has no filter (its ground is white).
//
// `shown` is what the browser does with a stored colour: the tests hold it to the anchors above.
import { PALETTE, hex as toHex, rgb as toRgb } from "./flavours.ts";
import { FLAVOURS, type Flavour, type Theme } from "./theme.ts";

export type CanvasTheme = "dark" | Flavour;

/** The canvas theme of the page's theme and flavour; null for plain light, which has no filter. */
export function canvasThemeOf(theme: Theme, flavour: Flavour | null): CanvasTheme | null {
  return flavour ?? (theme === "dark" ? "dark" : null);
}

export const CANVAS_THEMES: CanvasTheme[] = ["dark", ...FLAVOURS];

/** Plain dark's ground and ink: the --bg and --text of `:root[data-theme="dark"]` in styles.css (a test holds them to it). */
export const DARK = { ground: "#1c1c21", ink: "#e5e5ea" };
/** What Excalidraw draws by default: the canvas's background and the stroke. */
const WHITE = "#ffffff", INK = "#1e1e1e";

/** The ground and the ink a theme shows in place of the stored white and the stored #1e1e1e. */
export function targets(t: CanvasTheme): { ground: string; ink: string } {
  return t === "dark" ? DARK : { ground: PALETTE[t].base, ink: PALETTE[t].text };
}

export type CanvasFilter = {
  id: string;
  matrix: number[]; // feColorMatrix type="matrix" values: 4 rows of 5, row-major, the last row 0 0 0 1 0
  tables: { r: number[]; g: number[]; b: number[] }; // feComponentTransfer type="table" tableValues, 256 entries each
};

// ---- stage 1

type Stage = { m: number[][]; o: number[] }; // out = m · rgb + o, on 0 to 1

/** Excalidraw's `invert(93%) hue-rotate(180deg)` as one matrix, from the formulas of the CSS Filter Effects spec:
 *  invert(p) is c' = p + c (1 - 2p), hue-rotate(a) the matrix of the luminance coefficients 0.213, 0.715 and 0.072. */
function excalidrawDark(): Stage {
  const p = 0.93, a = Math.PI, cos = Math.cos(a), sin = Math.sin(a);
  const h = [
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
    [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.140, 0.072 - cos * 0.072 - sin * 0.283],
    [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
  ];
  // h · (p + c (1 - 2p)): the matrix scaled by 1 - 2p, and h's rows summed times p for the offset
  return { m: h.map((row) => row.map((v) => v * (1 - 2 * p))), o: h.map((row) => row.reduce((s, v) => s + v, 0) * p) };
}
const IDENTITY: Stage = { m: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], o: [0, 0, 0] };

const stage1 = (t: CanvasTheme): Stage => (t === "latte" ? IDENTITY : excalidrawDark());
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const apply = (s: Stage, c: number[]) => s.m.map((row, i) => clamp(row[0] * c[0] + row[1] * c[1] + row[2] * c[2] + s.o[i]));

// ---- stage 2

const ENTRIES = 256;

/** The value at x of the piecewise-linear curve through the anchors (xs rising). */
function curve(xs: number[], ys: number[], x: number): number {
  let k = 0;
  while (k < xs.length - 2 && x > xs[k + 1]) k++;
  return ys[k] + ((x - xs[k]) / (xs[k + 1] - xs[k])) * (ys[k + 1] - ys[k]);
}

/** One channel's table: the curve at i/255. Throws when the curve does not rise. */
function table(what: string, xs: number[], ys: number[]): number[] {
  for (let i = 1; i < xs.length; i++) {
    if (!(xs[i] > xs[i - 1])) throw new Error(`${what}: the anchors do not rise (${xs.join(", ")})`);
    if (!(ys[i] >= ys[i - 1])) throw new Error(`${what}: the curve does not rise (${ys.join(", ")})`);
  }
  return Array.from({ length: ENTRIES }, (_, i) => Math.round(curve(xs, ys, i / (ENTRIES - 1)) * 1e5) / 1e5);
}

/** What feComponentTransfer type="table" does with x. */
function lookup(tab: number[], x: number): number {
  const pos = clamp(x) * (tab.length - 1), k = Math.min(Math.floor(pos), tab.length - 2);
  return tab[k] + (pos - k) * (tab[k + 1] - tab[k]);
}

const cache = new Map<CanvasTheme, CanvasFilter>();

/** The SVG filter of a canvas theme. */
export function canvasFilter(t: CanvasTheme): CanvasFilter {
  const hit = cache.get(t);
  if (hit) return hit;
  const s = stage1(t), { ground, ink } = targets(t), g = toRgb(ground).map((v) => v / 255), k = toRgb(ink).map((v) => v / 255);
  const white = apply(s, [1, 1, 1]), dark = apply(s, toRgb(INK).map((v) => v / 255));
  const [r, gr, b] = [0, 1, 2].map((c) => t === "latte"
    ? table(`${t} channel ${c}`, [0, dark[c], 1], [0, k[c], g[c]])
    : table(`${t} channel ${c}`, [0, white[c], dark[c], 1], [0, g[c], k[c], 1]));
  const matrix = s.m.flatMap((row, i) => [...row, 0, s.o[i]]).concat([0, 0, 0, 1, 0]).map((v) => Math.round(v * 1e5) / 1e5);
  const filter = { id: `aiwb-canvas-${t}`, matrix, tables: { r, g: gr, b } };
  cache.set(t, filter);
  return filter;
}

// ---- what is shown

const channels = (f: CanvasFilter) => [f.tables.r, f.tables.g, f.tables.b];

/** The matrix of a filter as a stage (the rounded numbers the browser gets, not the exact ones). */
const stageOf = (f: CanvasFilter): Stage => ({
  m: [0, 1, 2].map((i) => f.matrix.slice(i * 5, i * 5 + 3)),
  o: [0, 1, 2].map((i) => f.matrix[i * 5 + 4]),
});

function showRgb(f: CanvasFilter, c: number[]): number[] {
  return apply(stageOf(f), c.map((v) => v / 255)).map((v, i) => lookup(channels(f)[i], v) * 255);
}

/** How a stored colour (#rrggbb) looks under a canvas theme: the matrix with its result clamped to 0 to 1, as the
 *  browser does between two filter primitives, then each channel's table with linear interpolation. */
export function shown(t: CanvasTheme, colour: string): string {
  return toHex(showRgb(canvasFilter(t), toRgb(colour)));
}
