// Which characters of a text measure differently? Each prefix and each character, Chromium vs Node, for a family string.
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
const cases = [["20px Nunito, Segoe UI Emoji", "Hearts ❤️ ♥ ☺️ ✔︎ ⚠️"]];
const c = await startChromium(); await c.load("b", { elements: [], files: {}, appState: {} });
const n = await startNode();
for (const [f, t] of cases) {
  await c.warm([f], t);
  const chars = [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(t)].map((x) => x.segment);
  const [cw] = await c.measure([f], chars), [nw] = n.measure([f], chars);
  const [cf] = await c.measure([f], [t]), [nf] = n.measure([f], [t]);
  const bad = chars.map((ch, i) => [ch, ch.codePointAt(0).toString(16), cw[i], nw[i]]).filter((x) => Math.abs(x[2] - x[3]) > 0.005);
  const sumC = cw.reduce((a, b) => a + b, 0), sumN = nw.reduce((a, b) => a + b, 0);
  console.log(f, `whole ${cf[0].toFixed(2)}/${nf[0].toFixed(2)}, sum of chars ${sumC.toFixed(2)}/${sumN.toFixed(2)}`, bad.length ? "chars differing: " + JSON.stringify(bad) : "every char equal");
}
await c.close();
