import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { CanvasFilterMsg } from "@aiwb/board-bridge/messages.ts";
import { CANVAS_THEMES, canvasFilter, shown, type CanvasTheme } from "@aiwb/core/logic/canvastheme.ts";
import { phoneCanvas, phoneShown, phoneThemeCss, type Layer } from "../src/phonetheme.ts";
import { themeCss } from "../src/theme.ts";

const STAGE = "invert(93%) hue-rotate(180deg)";
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const colourOf = (l: Layer) => l.colour.match(/-?\d+(\.\d+)?/g)!.map(Number);

test("every theme is layers over a stage: Excalidraw's dark filter, or none for Latte", () => {
  for (const t of CANVAS_THEMES) {
    const p = phoneCanvas(canvasFilter(t));
    assert.equal(p.kind, "layers", t);
    if (p.kind !== "layers") continue;
    assert.equal(p.stage, t === "latte" ? "none" : STAGE, t);
    // the layers are in the order dodge, multiply, screen, each at most once, and every colour is CSS with decimals of 0 to 255
    const order = ["color-dodge", "multiply", "screen"];
    const modes = p.layers.map((l) => l.mode);
    assert.deepEqual(modes, order.filter((m) => modes.includes(m as never)), `${t}: order`);
    for (const l of p.layers) assert.match(l.colour, /^rgb\(\d+(\.\d{1,3})?, \d+(\.\d{1,3})?, \d+(\.\d{1,3})?\)$/, `${t}: ${l.colour}`);
  }
  // (a layer that does nothing is left out: plain dark's ground and ink are on the line without clipping)
  assert.deepEqual((phoneCanvas(canvasFilter("dark")) as { layers: Layer[] }).layers.map((l) => l.mode), ["color-dodge", "screen"]);
});

test("the anchors: the stored white and #1e1e1e show the theme's ground and ink within 3/255 (the model says under 1)", () => {
  for (const t of CANVAS_THEMES) {
    const f = canvasFilter(t);
    for (const c of ["#ffffff", "#1e1e1e"]) {
      const got = channels(phoneShown(f, c)), want = channels(shown(t, c));
      assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 3), `${t} ${c}: ${got} is not ${want}`);
      assert.ok(got.every((v, i) => Math.abs(v - want[i]) < 1), `${t} ${c}: ${got} is not within 1 of ${want}`);
    }
  }
});

// ---- the colour family, in OKLCH (Björn Ottosson's OKLab from sRGB)

const linear = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
function oklch(hex: string) {
  const [r, g, b] = channels(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360 };
}

// Excalidraw's palette: open-color shades 0, 2, 4, 6, 8 of its eleven colours, the five bronzes, the canvas background picks
const openColor = createRequire(import.meta.url)("open-color") as Record<string, string[]>;
const PALETTE = [
  ...["gray", "red", "pink", "grape", "violet", "blue", "cyan", "teal", "green", "yellow", "orange"].flatMap((n) => [0, 2, 4, 6, 8].map((i) => openColor[n][i])),
  "#f8f1ee", "#eaddd7", "#d2bab0", "#a18072", "#846358",
  "#ffffff", "#f8f9fa", "#f5faff", "#fffce8", "#fdf8f6",
];

const MAX_DL = 0.06, MAX_HUE = 30, MIN_CHROMA = 0.25, COLOURED = 0.05;

/** How a colour on the phone compares with today's: the lightness change, and for a coloured one the hue turn and the share of chroma kept. */
function compare(t: CanvasTheme, c: string) {
  const today = oklch(shown(t, c)), now = oklch(phoneShown(canvasFilter(t), c));
  const dh = Math.abs(today.h - now.h), turn = Math.min(dh, 360 - dh);
  return { dL: Math.abs(today.L - now.L), coloured: today.C >= COLOURED, hue: turn, kept: now.C / today.C };
}
const fails = (r: ReturnType<typeof compare>) => r.dL > MAX_DL || (r.coloured && (r.hue > MAX_HUE || r.kept < MIN_CHROMA));

/** The colours that break the rule of the design (section 4), each with what the model measured (the 2nd decimal rounded
 *  against it): a finding, reported, not a limit raised. The pale yellows of the dark flavours keep nearly no chroma, because
 *  today their blue channel falls to 0 on the steep first segment of the table and the line keeps it at the screen colour. A
 *  hue of #fffce8 means nothing at that chroma (0.006). */
const EXCEPTIONS: { theme: CanvasTheme; colour: string; kept: number; hue: number }[] = [
  { theme: "frappe", colour: "#fff9db", kept: 0.094, hue: 3.0 },
  { theme: "frappe", colour: "#fffce8", kept: 0.106, hue: 146.4 },
  { theme: "macchiato", colour: "#fff9db", kept: 0.143, hue: 10.8 },
];

test("colour family over the palette: lightness, hue and chroma stay near today's, but for the named exceptions", () => {
  const known = new Set(EXCEPTIONS.map((e) => `${e.theme} ${e.colour}`));
  const broken: string[] = [];
  for (const t of CANVAS_THEMES) for (const c of PALETTE) {
    const r = compare(t, c);
    assert.ok(r.dL <= MAX_DL, `${t} ${c}: lightness moved by ${r.dL.toFixed(3)}`);
    if (fails(r) && !known.has(`${t} ${c}`)) broken.push(`${t} ${c}: hue ${r.hue.toFixed(1)}°, chroma kept ${r.kept.toFixed(3)}`);
  }
  assert.deepEqual(broken, [], "colours outside the limits that are not named exceptions");
});

test("the exceptions: each still fails the rule (else it leaves the list) and is not worse than measured", () => {
  for (const e of EXCEPTIONS) {
    const r = compare(e.theme, e.colour);
    assert.ok(fails(r), `${e.theme} ${e.colour} passes now: take it off the list`);
    assert.ok(r.kept >= e.kept - 0.01, `${e.theme} ${e.colour}: chroma kept ${r.kept.toFixed(3)}, measured ${e.kept}`);
    assert.ok(r.hue <= e.hue + 2, `${e.theme} ${e.colour}: hue turn ${r.hue.toFixed(1)}°, measured ${e.hue}°`);
  }
});

// ---- other filters

const table = (k: number) => Array.from({ length: 256 }, (_, i) => (i / 255) * k);
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const harness: CanvasFilterMsg = { id: "aiwb-canvas-test", matrix: IDENTITY_MATRIX, tables: { r: table(1), g: table(0.9), b: table(0.8) } };

test("the harness filter (the identity, tables 1, 0.9 and 0.8 of the input) is one multiply layer", () => {
  const p = phoneCanvas(harness);
  assert.equal(p.kind, "layers");
  if (p.kind !== "layers") return;
  assert.equal(p.stage, "none");
  assert.equal(p.layers.length, 1);
  assert.equal(p.layers[0].mode, "multiply");
  colourOf(p.layers[0]).forEach((v, i) => assert.ok(Math.abs(v - 255 * [1, 0.9, 0.8][i]) < 0.01, p.layers[0].colour));
  assert.equal(phoneShown(harness, "#ffffff"), "#ffe6cc");
});

test("a matrix that is neither Excalidraw's dark nor the identity is the fallback: today's CSS to the letter", () => {
  const s = 0.5; // saturate(0.5)
  const saturate = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0, 0, 0, 0, 1, 0];
  for (const f of [{ ...harness, matrix: saturate }, { ...harness, matrix: IDENTITY_MATRIX.slice(0, 19) }, { ...harness, tables: { r: [0], g: [0, 1], b: [0, 1] } }]) {
    const p = phoneCanvas(f);
    assert.equal(p.kind, "fallback");
    assert.match((p as { why: string }).why, /./);
    assert.equal(phoneThemeCss(f), themeCss(f));
    assert.throws(() => phoneShown(f, "#ffffff"));
  }
  // a line that falls (ink brighter than ground) cannot be made of layers either
  assert.equal(phoneCanvas({ ...harness, tables: { r: table(1), g: table(0.9), b: [1, 0] } }).kind, "fallback");
});

test("no filter: nothing", () => {
  assert.deepEqual(phoneCanvas(null), { kind: "none" });
  assert.equal(phoneThemeCss(null), "");
  assert.throws(() => phoneShown(null, "#ffffff"));
});

test("the desktop CSS did not change: themeCss of Mocha is what it was", () => {
  assert.equal(
    themeCss(canvasFilter("mocha")),
    ":root .excalidraw.excalidraw { --theme-filter: url(#aiwb-canvas-mocha); }\n:root .excalidraw.excalidraw canvas { filter: var(--theme-filter); }",
  );
});

test("phoneThemeCss: today's two rules, and the board's own canvases wear the stage", () => {
  const dark = phoneThemeCss(canvasFilter("mocha")).split("\n");
  assert.equal(dark.length, 3);
  assert.deepEqual(dark.slice(0, 2), themeCss(canvasFilter("mocha")).split("\n"));
  assert.equal(dark[2], `:root .aiwb-board .excalidraw.excalidraw canvas.excalidraw__canvas { filter: ${STAGE}; }`);
  assert.match(phoneThemeCss(canvasFilter("mocha")), /--theme-filter: url\(#aiwb-canvas-mocha\);/);
  assert.match(phoneThemeCss(canvasFilter("latte")), /canvas\.excalidraw__canvas \{ filter: none; \}/);
});
