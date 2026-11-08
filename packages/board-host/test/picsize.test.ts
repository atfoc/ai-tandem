// The picture's pixel size (decision V2): floor(side × scale) on both sides, as tldraw's own export, and the cap's scale
// (H-4) makes the long side exactly 2000 px, never more. Pure arithmetic and resvg alone; no editor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fitScale, pictureSize } from "../src/node/export.ts";
import { MAX_PICTURE_SIDE } from "../src/render.ts";

const { Resvg } = createRequire(import.meta.url)("@resvg/resvg-js");

test("pictureSize: floor of each side × scale, at least 1", () => {
  assert.deepEqual(pictureSize(904.3, 573.6, 1), { width: 904, height: 573 });
  assert.deepEqual(pictureSize(100, 100, 2), { width: 200, height: 200 }); // square
  assert.deepEqual(pictureSize(300.9, 1200.9, 0.5), { width: 150, height: 600 }); // tall
  assert.deepEqual(pictureSize(1200.9, 300.9, 0.5), { width: 600, height: 150 }); // wide
  assert.deepEqual(pictureSize(0.2, 50, 1), { width: 1, height: 50 });
});

test("the cap: the capped cases of the verification come out as tldraw's (741×2000, 2000×741)", () => {
  for (const [W, H, ew, eh] of [[1603.55, 4324, 741, 2000], [4324, 1603.55, 2000, 741], [1604.2, 4324, 741, 2000], [1606.4, 4324, 743, 2000]]) {
    assert.deepEqual(pictureSize(W, H, fitScale(W, H, MAX_PICTURE_SIDE)), { width: ew, height: eh }, `${W}×${H}`);
  }
});

test("the cap: the long side is exactly 2000 and each side the floor of side × scale, for any bounds", () => {
  const cases: [number, number][] = [[500.5, 12000], [12000, 500.5], [3000.4, 2999.7], [2999.7, 3000.4], [2000.05, 2000.05], [5064, 564]];
  for (let L = 2000.05; L < 20000; L += 7.37) cases.push([L, L * 0.37], [L * 0.61, L]);
  for (const [W, H] of cases) {
    const s = fitScale(W, H, MAX_PICTURE_SIDE);
    const { width, height } = pictureSize(W, H, s);
    assert.equal(Math.max(width, height), MAX_PICTURE_SIDE, `${W}×${H} at ${s}`);
    assert.equal(width, Math.floor(W * s));
    assert.equal(height, Math.floor(H * s));
    assert.ok(Math.abs(s - MAX_PICTURE_SIDE / Math.max(W, H)) < 1e-12, "the scale is the plain fit, give or take rounding");
  }
});

test("resvg draws a root sized to pictureSize with preserveAspectRatio none at exactly that size", () => {
  for (const [W, H] of [[1603.55, 4324], [4324, 1603.55], [904.3, 573.6], [500.5, 12000], [777.7, 777.7]]) {
    const { width, height } = pictureSize(W, H, Math.min(1, fitScale(W, H, MAX_PICTURE_SIDE)));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><rect width="${W}" height="${H}" fill="red"/></svg>`;
    const r = new Resvg(svg, { fitTo: { mode: "original" } }).render();
    assert.deepEqual({ width: r.width, height: r.height }, { width, height }, `${W}×${H}`);
  }
});
