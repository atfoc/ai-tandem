// The distribution of the largest channel difference per pixel between two pictures (Chromium, Node) of the harness.
import fs from "node:fs";
import { pixels } from "./pngs.mjs";
export async function histogram(aPath, bPath) {
  const a = await pixels(fs.readFileSync(aPath).toString("base64")), b = await pixels(fs.readFileSync(bPath).toString("base64"));
  const bins = { 0: 0, "1-2": 0, "3-8": 0, "9-32": 0, "33-64": 0, ">64": 0 };
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(a.data[i + k] - b.data[i + k])));
    bins[d === 0 ? 0 : d <= 2 ? "1-2" : d <= 8 ? "3-8" : d <= 32 ? "9-32" : d <= 64 ? "33-64" : ">64"]++;
  }
  const n = a.width * a.height;
  return Object.fromEntries(Object.entries(bins).map(([k, v]) => [k, +(100 * v / n).toFixed(2)]));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = new URL("../out/harness/", import.meta.url).pathname;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith("-chromium.png")).sort()) {
    const base = f.replace(/-chromium\.png$/, "");
    try { console.log(base.padEnd(28), JSON.stringify(await histogram(dir + f, dir + base + "-node.png"))); } catch (e) { console.log(base, "size differs"); }
  }
}
