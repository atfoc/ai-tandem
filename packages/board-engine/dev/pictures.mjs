// Pictures for the faithfulness harness: the test pictures of the image cases (drawn with skia-canvas, which is deterministic),
// and the comparison of two PNGs: the share of pixels that differ at all, by more than 64 in a channel (the strong share, the
// one that decides, O3 of plans/headless-board/engine.md), a histogram of the largest channel difference, and a diff picture.
import { Canvas, loadImage } from "skia-canvas";

/** A data: URL of a test picture (gradient, stripes, a circle) of the given size and type. */
export function createCanvas(w, h, type) {
  const c = new Canvas(w, h), x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, "#ff6b6b"); g.addColorStop(1, "#4dabf7");
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = "#ffffff"; for (let i = 0; i < w; i += 16) x.fillRect(i, 0, 6, h);
  x.beginPath(); x.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, Math.PI * 2); x.fillStyle = "#2f9e44"; x.fill();
  return c.toURLSync(type === "jpeg" ? "jpeg" : "png");
}

/** The RGBA pixels of a PNG given as base64. */
export async function pixels(b64) {
  const img = await loadImage(Buffer.from(b64, "base64"));
  const c = new Canvas(img.width, img.height), x = c.getContext("2d");
  x.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: x.getImageData(0, 0, img.width, img.height).data };
}

/** The bins of the histogram: the largest difference of any channel (alpha included) of a pixel. */
const BINS = ["0", "1-2", "3-8", "9-32", "33-64", ">64"];
const bin = (d) => (d === 0 ? 0 : d <= 2 ? 1 : d <= 8 ? 2 : d <= 32 ? 3 : d <= 64 ? 4 : 5);

/** How two PNGs (base64) differ. Different sizes: `{ sameSize: false, a: [w, h], b: [w, h] }`. Otherwise `any` and `strong` are the
 *  numbers of pixels that differ at all and by more than 64, `anyPct` and `strongPct` their share of all pixels, `histogram` the share
 *  of pixels in each bin of the largest channel difference (in percent), and `diffPng` a picture of where they differ (orange: any
 *  difference, red: strong; the rest the first picture, faded). */
export async function compare(aB64, bB64) {
  const a = await pixels(aB64), b = await pixels(bB64);
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, a: [a.width, a.height], b: [b.width, b.height] };
  const n = a.width * a.height;
  const counts = new Array(BINS.length).fill(0);
  const diff = new Canvas(a.width, a.height), dx = diff.getContext("2d"), img = dx.createImageData(a.width, a.height);
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]), Math.abs(a.data[i + 3] - b.data[i + 3]));
    counts[bin(d)]++;
    const v = 255 - Math.round((a.data[i] + a.data[i + 1] + a.data[i + 2]) / 12);
    img.data[i] = d > 0 ? 255 : v; img.data[i + 1] = d > 64 ? 0 : d > 0 ? 170 : v; img.data[i + 2] = d > 0 ? 0 : v; img.data[i + 3] = 255;
  }
  dx.putImageData(img, 0, 0);
  const any = n - counts[0], strong = counts[5];
  return {
    sameSize: true, size: [a.width, a.height], pixels: n, any, strong, anyPct: (100 * any) / n, strongPct: (100 * strong) / n,
    histogram: Object.fromEntries(BINS.map((k, i) => [k, +((100 * counts[i]) / n).toFixed(2)])), diffPng: await diff.toBuffer("png"),
  };
}
