// Which font does Chromium draw common symbols with (Nunito string), and what does Node measure for them?
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
const SYM = [..."♥✔✓★☆⚠☐☑✗✘➜⇒∞☺♦●■▲◆○□△◇•‣→←↑↓↔⇄✚✖✕☎✉⌘⌥⏎⌫☀☁☂☃☄♠♣♪♫✈✂✏✒"];
const f = "20px Nunito, Segoe UI Emoji";
const c = await startChromium(); await c.load("b", { elements: [], files: {}, appState: {} });
await c.warm([f], SYM.join(""));
const cdp = await c.page.context().newCDPSession(c.page); await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
const [cw] = await c.measure([f], SYM);
const n = await startNode(); const [nw] = n.measure([f], SYM);
const rows = [];
for (const [i, ch] of SYM.entries()) {
  await c.page.evaluate(([f, t]) => { document.querySelector("#probe")?.remove(); const s = document.createElement("span"); s.id = "probe"; s.style.cssText = "position:fixed;top:0;left:0;z-index:99999;white-space:pre"; s.style.font = f; s.textContent = t; document.body.appendChild(s); return s.offsetWidth; }, [f, ch]);
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  rows.push([ch, fonts.map((x) => x.familyName).join("+"), cw[i], nw[i]]);
}
await c.close();
const by = {}; for (const r of rows) (by[r[1]] ??= []).push(r);
for (const [font, rs] of Object.entries(by)) console.log(font.padEnd(22), rs.map((r) => `${r[0]}${Math.abs(r[2] - r[3]) > 0.01 ? `(${r[2].toFixed(1)}/${r[3].toFixed(1)})` : "="}`).join(" "));
