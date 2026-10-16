// The two boards of the bench (README.md here), deterministic (a seeded PRNG), built in the page: nothing large is kept in the
// repository. Each is the `scene` of a `load` message. The scene is centred on the origin, where the bench's view starts
// (scroll 0, zoom 1), so a gesture that moves the view a few hundred pixels either way always has drawing under it.
import { FONT_FAMILY, restoreElements } from "@excalidraw/excalidraw";

export type Scene = { elements: Record<string, unknown>[]; files: Record<string, unknown>; appState: { scrollX: number; scrollY: number; zoom: { value: number }; viewBackgroundColor: string } };
export const BOARDS = ["large", "images"] as const;
export type BoardName = (typeof BOARDS)[number];

/** mulberry32: a small seeded generator, 0 <= x < 1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STROKES = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#6741d9", "#0c8599", "#c2255c"];
const FILLS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99", "#d0bfff", "#99e9f2", "#eebefa"];
const FILL_STYLES = ["solid", "hachure", "cross-hatch"];
const WORDS = ["api", "cache", "queue", "auth", "db", "worker", "gateway", "events", "index", "store", "proxy", "jobs", "mail", "search", "stream", "cron", "edge", "log"];

type Rand = () => number;
const pick = <T,>(r: Rand, xs: T[]): T => xs[Math.floor(r() * xs.length)];
const between = (r: Rand, lo: number, hi: number) => lo + r() * (hi - lo);
const whole = (r: Rand, lo: number, hi: number) => Math.round(between(r, lo, hi));

/** What every element has that is not about its kind: Excalidraw's `restoreElements` fills in the rest. */
function base(r: Rand, id: string, type: string, x: number, y: number, width: number, height: number, style: Record<string, unknown> = {}) {
  return {
    id, type, x, y, width, height, angle: 0, version: 1, isDeleted: false, groupIds: [], frameId: null, boundElements: null, link: null, locked: false,
    strokeColor: pick(r, STROKES), backgroundColor: "transparent", fillStyle: "solid", strokeWidth: pick(r, [1, 2]), strokeStyle: "solid",
    roughness: pick(r, [0, 1]), opacity: 100, roundness: null, ...style,
  };
}

function shape(r: Rand, id: string, x: number, y: number): Record<string, unknown> {
  const type = pick(r, ["rectangle", "ellipse", "diamond"]);
  const w = whole(r, 40, 220), h = whole(r, 30, 160);
  const bg = pick(r, FILLS);
  return base(r, id, type, x, y, w, h, {
    backgroundColor: bg, fillStyle: bg === "transparent" ? "solid" : pick(r, FILL_STYLES),
    roundness: type === "rectangle" && r() < 0.5 ? { type: 3 } : type === "ellipse" ? null : r() < 0.3 ? { type: 2 } : null,
  });
}

function label(r: Rand, id: string, x: number, y: number): Record<string, unknown> {
  const text = Array.from({ length: whole(r, 1, 3) }, () => pick(r, WORDS)).join(" ");
  const fontSize = pick(r, [16, 20, 28]);
  return base(r, id, "text", x, y, Math.round(text.length * fontSize * 0.55), Math.round(fontSize * 1.25), {
    text, originalText: text, fontSize, fontFamily: pick(r, [FONT_FAMILY.Excalifont, FONT_FAMILY.Nunito]), textAlign: "left", verticalAlign: "top",
    containerId: null, autoResize: true, lineHeight: 1.25, roughness: 1,
  });
}

/** An arrow or a line of 2 to 5 points (relative to x, y). */
function linear(r: Rand, id: string, x: number, y: number): Record<string, unknown> {
  const arrow = r() < 0.6;
  const points: [number, number][] = [[0, 0]];
  const n = whole(r, 2, 5);
  for (let i = 1; i < n; i++) { const p = points[i - 1]; points.push([Math.round(p[0] + between(r, -160, 160)), Math.round(p[1] + between(r, -120, 120))]); }
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return base(r, id, arrow ? "arrow" : "line", x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
    points, lastCommittedPoint: null, startBinding: null, endBinding: null,
    startArrowhead: null, endArrowhead: arrow ? "arrow" : null, ...(arrow ? { elbowed: false } : {}),
    roundness: r() < 0.5 ? { type: 2 } : null,
  });
}

/** A freedraw stroke of 40 to 100 points: a random walk with a drifting direction. */
function stroke(r: Rand, id: string, x: number, y: number): Record<string, unknown> {
  const n = whole(r, 40, 100);
  const points: [number, number][] = [[0, 0]];
  let dir = r() * Math.PI * 2;
  for (let i = 1; i < n; i++) {
    dir += between(r, -0.6, 0.6);
    const p = points[i - 1], step = between(r, 2, 7);
    points.push([Math.round((p[0] + Math.cos(dir) * step) * 10) / 10, Math.round((p[1] + Math.sin(dir) * step) * 10) / 10]);
  }
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return base(r, id, "freedraw", x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
    points, pressures: [], simulatePressure: true, lastCommittedPoint: null, roughness: 0, strokeWidth: 2,
  });
}

const restore = (els: Record<string, unknown>[]) => restoreElements(els as never, null) as unknown as Record<string, unknown>[];
const appState = (): Scene["appState"] => ({ scrollX: 0, scrollY: 0, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" });

/** About 3000 elements over about 8000 × 5000 scene px, centred on the origin. */
export function largeScene(): Scene {
  const r = mulberry32(0xb0a2d);
  const els: Record<string, unknown>[] = [];
  const at = () => [Math.round(between(r, -4000, 4000)), Math.round(between(r, -2500, 2500))] as const;
  let n = 0;
  const id = (k: string) => `${k}-${n++}`;
  for (let i = 0; i < 1100; i++) els.push(shape(r, id("shape"), ...at()));
  for (let i = 0; i < 900; i++) els.push(label(r, id("text"), ...at()));
  for (let i = 0; i < 600; i++) els.push(linear(r, id("link"), ...at()));
  for (let i = 0; i < 400; i++) els.push(stroke(r, id("draw"), ...at()));
  // (the kinds interleaved, so the z-order is not a block of each)
  for (let i = els.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [els[i], els[j]] = [els[j], els[i]]; }
  return { elements: restore(els), files: {}, appState: appState() };
}

// ---- images

const IMAGE_W = 1600, IMAGE_H = 1200, IMAGE_COUNT = 12;
let imageFiles: Promise<Record<string, unknown>> | null = null;

/** One photo-like JPEG: gradients, soft blobs, hard shapes and film grain, from a seed. */
function photo(seed: number): string {
  const r = mulberry32(seed);
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_W; canvas.height = IMAGE_H;
  const c = canvas.getContext("2d")!;
  const hue = Math.floor(r() * 360);
  const sky = c.createLinearGradient(0, 0, 0, IMAGE_H);
  sky.addColorStop(0, `hsl(${hue} 60% 62%)`); sky.addColorStop(0.55, `hsl(${(hue + 40) % 360} 55% 78%)`); sky.addColorStop(1, `hsl(${(hue + 120) % 360} 40% 30%)`);
  c.fillStyle = sky; c.fillRect(0, 0, IMAGE_W, IMAGE_H);
  for (let i = 0; i < 14; i++) {
    const x = r() * IMAGE_W, y = r() * IMAGE_H, rad = 80 + r() * 420;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `hsla(${Math.floor(r() * 360)} 70% 60% / 0.55)`); g.addColorStop(1, "hsla(0 0% 50% / 0)");
    c.fillStyle = g; c.fillRect(0, 0, IMAGE_W, IMAGE_H);
  }
  for (let i = 0; i < 40; i++) {
    c.fillStyle = `hsl(${Math.floor(r() * 360)} ${30 + r() * 50}% ${20 + r() * 50}%)`;
    c.beginPath();
    if (r() < 0.5) c.rect(r() * IMAGE_W, r() * IMAGE_H, 40 + r() * 260, 40 + r() * 200);
    else c.arc(r() * IMAGE_W, r() * IMAGE_H, 20 + r() * 140, 0, Math.PI * 2);
    c.fill();
  }
  const data = c.getImageData(0, 0, IMAGE_W, IMAGE_H), px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const n = (r() - 0.5) * 36;
    px[i] += n; px[i + 1] += n; px[i + 2] += n;
  }
  c.putImageData(data, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** The twelve pictures, made once (a few seconds on a phone) and kept. */
function files(): Promise<Record<string, unknown>> {
  imageFiles ??= (async () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < IMAGE_COUNT; i++) {
      out[`bench-image-${i}`] = { id: `bench-image-${i}`, mimeType: "image/jpeg", dataURL: photo(1000 + i), created: 1_700_000_000_000 + i };
      await new Promise((res) => setTimeout(res, 0)); // (the page stays alive while they are made)
    }
    return out;
  })();
  return imageFiles;
}

/** 12 pictures of 1600 × 1200 shown at 400 × 300 in a grid of 4 × 3, and about 100 shapes around and over them. */
export async function imagesScene(): Promise<Scene> {
  const r = mulberry32(0x1ba6e);
  const els: Record<string, unknown>[] = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    const col = i % 4, row = Math.floor(i / 4);
    els.push(base(r, `image-${i}`, "image", -400 + col * 420, -100 + row * 320, 400, 300, {
      fileId: `bench-image-${i}`, status: "saved", scale: [1, 1], crop: null, strokeColor: "transparent", roughness: 0,
    }));
  }
  let n = 0;
  for (let i = 0; i < 70; i++) els.push(shape(r, `shape-${n++}`, Math.round(between(r, -900, 1400)), Math.round(between(r, -400, 1000))));
  for (let i = 0; i < 30; i++) els.push(label(r, `text-${n++}`, Math.round(between(r, -900, 1400)), Math.round(between(r, -400, 1000))));
  return { elements: restore(els), files: await files(), appState: appState() };
}

/** The scene of a board of the bench. */
export async function sceneOf(board: BoardName): Promise<Scene> {
  return board === "large" ? largeScene() : imagesScene();
}
