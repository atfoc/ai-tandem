// Does a window that has drawn no board measure an agent's text with Excalidraw's fonts? (the hidden engine view of a phone,
// and the web page before its first board). Creates the same labelled shape cold, after a board is shown, and after warm.
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
const T = { latin: "Hello world, a longer label", accents: "Žluťoučký kůň úpěl ďábelské ódy", cyrillic: "Привет, мир! Съешь же ещё", greek: "Γειά σου Κόσμε", cjk: "你好世界 こんにちは 안녕하세요", emoji: "Ship it 🚀✅👍🏽" };
const op = (text, fontFamily) => ({ op: "apply", target: { elements: [] }, rev: 1, params: { create: [{ type: "text", key: "t", x: 0, y: 0, text, fontFamily }] } });
const w = async (side, text, fam) => { const r = await side.req(op(text, fam)); return r.ok ? r.value.elements[0].width : r; };
const c = await startChromium();
const n = await startNode();
const fams = { Excalifont: 5, Nunito: 6 };
const rows = [];
for (const [fname, fam] of Object.entries(fams)) for (const [k, t] of Object.entries(T)) rows.push({ fname, fam, k, t, cold: await w(c, t, fam) });
await c.load("b1", { elements: [], files: {}, appState: {} }); // a board shown: Excalidraw adds its faces to document.fonts
for (const r of rows) r.shown = await w(c, r.t, r.fam);
for (const r of rows) { await c.warm([`20px ${r.fname}, Xiaolai, Segoe UI Emoji`], r.t); r.warm = await w(c, r.t, r.fam); r.node = await w(n, r.t, r.fam); }
console.log("chromium", c.version);
console.log("family     script    cold      shown     warm      node      node-warm");
for (const r of rows) console.log(r.fname.padEnd(10), r.k.padEnd(9), [r.cold, r.shown, r.warm, r.node].map((x) => x.toFixed(2).padStart(9)).join(" "), (r.node - r.warm).toFixed(3).padStart(9));
console.log("faces in document:", (await c.facesInDocument()).length, "errors:", c.errors);
await c.close();
