// Which fonts does Chromium draw each script with, per Excalidraw family string (the system fallback included)?
// CDP CSS.getPlatformFontsForNode on a span per (family, text).
import { startChromium } from "./chromium.mjs";
export const SCRIPTS = {
  latin: "Hello world", accents: "Žluťoučký kůň ÀÉÎõü ß Ł ő", vietnamese: "Tiếng Việt có dấu", cyrillic: "Привет мир Ђурђевак Їжак", greek: "Γειά σου Κόσμε",
  hanzi: "你好世界中文", kana: "こんにちはカタカナ", hangul: "안녕하세요", arabic: "مرحبا", hebrew: "שלום", devanagari: "नमस्ते", thai: "สวัสดี",
  emoji: "🚀✅👍🏽", emojizwj: "👩‍💻🏳️‍🌈", symbols: "→ ← ✓ • … ™ ©",
};
export const FAMILIES = { Virgil: 1, Helvetica: 2, Cascadia: 3, Excalifont: 5, Nunito: 6, "Lilita One": 7, "Comic Shanns": 8, "Liberation Sans": 9 };
export const familyString = (name) => `${name}${name === "Excalifont" ? ", Xiaolai" : ""}, Segoe UI Emoji`;
if (import.meta.url === `file://${process.argv[1]}`) {
  const c = await startChromium();
  await c.load("b", { elements: [], files: {}, appState: {} });
  const cdp = await c.page.context().newCDPSession(c.page);
  await cdp.send("DOM.enable"); await cdp.send("CSS.enable");
  const all = Object.values(SCRIPTS).join("");
  await c.warm(Object.keys(FAMILIES).map((f) => `20px ${familyString(f)}`), all);
  const out = {};
  for (const fam of Object.keys(FAMILIES)) {
    out[fam] = {};
    for (const [k, t] of Object.entries(SCRIPTS)) {
      await c.page.evaluate(([f, t]) => { document.body.querySelector("#probe")?.remove(); const s = document.createElement("span"); s.id = "probe"; s.style.cssText = "position:fixed;top:0;left:0;z-index:99999;white-space:pre"; s.style.font = `20px ${f}`; s.textContent = t; document.body.appendChild(s); return s.offsetWidth; }, [familyString(fam), t]);
      const { root } = await cdp.send("DOM.getDocument");
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
      const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      out[fam][k] = fonts.map((f) => `${f.familyName}${f.isCustomFont ? "*" : ""}:${f.glyphCount}`).join(" + ");
    }
  }
  for (const [k] of Object.entries(SCRIPTS)) console.log(k.padEnd(11), Object.keys(FAMILIES).map((f) => out[f][k]).join(" | "));
  await c.close();
}
