// A text corpus measured in Chromium (the board view's page, faces loaded) and in the Node engine, with Excalidraw's own font
// strings (getFontString: "<size>px <family>[, Xiaolai], Segoe UI Emoji"), at Excalidraw's four sizes (16, 20, 28, 36), for
// every family it offers. Reports, per script group, the share of lines whose width is equal within 0.01 px.
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
import { FAMILIES, familyString } from "./probe-fallback.mjs";
export const CORPUS = {
  latin: ["AVATAR WAVE Type To Yo, Ta. P. “Quoted” ‘single’", "The quick brown fox jumps over the lazy dog 0123456789", "Load balancer → API gateway → Auth service (JWT, 15 min)",
    "Q3 revenue: $1,234.56 (+12.5%) vs. Q2 — on track…", "fi fl ffi ff — ligatures? www.example.com/path?q=1&x=2", "TODO: refactor `config.yaml` #42 @team [WIP] {draft}",
    "Temperature 21 °C ± 0.5 × 3 ÷ 2 ≈ 31.5 ≥ 30 ≤ 40 ™ © ®", "    leading spaces and  double  spaces   ", "a", "Wy Vo Te LT AY PA F, V. r. y,"],
  accents: ["Français : façade, naïve, cœur, Noël, où, été", "Deutsch: Größe, Übergänge, Straße, Äpfel, Öl", "Polski: Łódź, żółć, gęślą jaźń, źdźbło", "Čeština: Žluťoučký kůň úpěl ďábelské ódy",
    "Tiếng Việt: Xin chào thế giới, cảm ơn nhiều", "Türkçe: İstanbul, ağaç, şişe, ölçü, ğ ı", "Español: ¿Dónde está el niño? ¡Año nuevo!", "Română: țară, școală, înțelegere", "Íslenska: þú ert ðæs, Æ Ø Å"],
  cyrillic: ["Русский: Сервис авторизации отвечает за токены", "Српски: Ђурђевак, љубав, њива, џеп, ћерка", "Українська: Їжак, ґанок, єдність, Київ", "Български: Щастие, ъгъл, юли, ябълка", "Қазақша: Әлем, Ғалым, Қала, Ңғ, Өнер, Ұл, Үй, Һ, Іс"],
  greek: ["Ελληνικά: Η υπηρεσία πιστοποίησης εκδίδει διακριτικά", "ΑΒΓΔΕΖΗΘ αβγδεζηθ ά έ ή ί ό ύ ώ ΐ ΰ"],
  cjk: ["认证服务负责令牌和会话。", "中文标点：「引号」、逗号，句号。", "日本語：こんにちは、カタカナとひらがな。", "한국어: 안녕하세요, 세계!", "混合 mixed 文本 text 123"],
  emoji: ["Ship it 🚀 when ✅ tests pass 👍🏽", "Family 👨‍👩‍👧‍👦 coder 👩‍💻 flag 🇩🇪 🇯🇵 keycap 1️⃣ #️⃣", "Hearts ❤️ ♥ ☺️ ✔︎ ⚠️", "🔥🔥🔥"],
  rtl: ["عربي: مرحبا بالعالم", "עברית: שלום עולם", "Mixed: API ← مرحبا → done"],
  other: ["हिन्दी: नमस्ते दुनिया", "ไทย: สวัสดีชาวโลก", "Georgian: გამარჯობა", "Armenian: Բարեւ աշխարհ"],
};
const SIZES = [16, 20, 28, 36];
const c = await startChromium(); await c.load("b", { elements: [], files: {}, appState: {} });
const all = Object.values(CORPUS).flat();
const fonts = SIZES.flatMap((s) => Object.keys(FAMILIES).map((f) => `${s}px ${familyString(f)}`));
await c.warm(fonts, all.join(""));
const ref = await c.measure(fonts, all);
await c.close();
const n = await startNode();
const got = n.measure(fonts, all);
const groups = Object.entries(CORPUS).map(([g, lines]) => [g, lines.map((l) => all.indexOf(l))]);
const per = {};
let worst = [];
for (const [fi, f] of fonts.entries()) {
  const fam = f.replace(/^\d+px /, "").split(",")[0];
  for (const [g, idx] of groups) {
    const k = `${fam}|${g}`; per[k] ??= { n: 0, exact: 0, maxPct: 0 };
    for (const i of idx) { const a = ref[fi][i], b = got[fi][i], d = Math.abs(a - b); per[k].n++; if (d <= 0.01) per[k].exact++; else worst.push([d / a * 100, f, all[i], a, b]); per[k].maxPct = Math.max(per[k].maxPct, d / a * 100); }
  }
}
console.log(`Node ${n.canvas}; ${all.length} lines x ${fonts.length} font strings = ${all.length * fonts.length} widths. Cell: lines equal within 0.01 px / lines, worst difference`);
console.log("group".padEnd(10) + Object.keys(FAMILIES).map((f) => f.slice(0, 13).padStart(19)).join(""));
for (const [g] of groups) console.log(g.padEnd(10) + Object.keys(FAMILIES).map((f) => { const p = per[`${f}|${g}`]; return `${p.exact}/${p.n} ${p.maxPct.toFixed(2)}%`.padStart(19); }).join(""));
const tot = Object.values(per).reduce((a, p) => ({ n: a.n + p.n, exact: a.exact + p.exact }), { n: 0, exact: 0 });
console.log(`total: ${tot.exact}/${tot.n} equal (${(100 * tot.exact / tot.n).toFixed(1)}%)`);
worst.sort((a, b) => b[0] - a[0]);
console.log("largest differences:"); for (const w of worst.slice(0, 12)) console.log(`  ${w[0].toFixed(2)}% ${w[1]} ${JSON.stringify(w[2])} ${w[3].toFixed(2)} vs ${w[4].toFixed(2)}`);
const lat = worst.filter((w) => !/[֐-ࣿ　-鿿가-힯ऀ-๿Ⴀ-ჿ԰-֏]|\p{Extended_Pictographic}/u.test(w[2]));
console.log(`differences in lines without CJK, RTL, Indic, Thai, Georgian, Armenian or emoji: ${lat.length}`); for (const w of lat.slice(0, 12)) console.log(`  ${w[0].toFixed(3)}% ${w[1]} ${JSON.stringify(w[2])} ${w[3].toFixed(3)} vs ${w[4].toFixed(3)}`);
const grp = (g) => worst.filter((w) => CORPUS[g].includes(w[2]) && w[1].startsWith("20px"));
for (const g of ["emoji", "cjk", "rtl"]) { console.log(`${g} at 20px:`); for (const w of grp(g).filter((w) => !w[1].includes("Cascadia"))) console.log(`  ${w[0].toFixed(2)}% ${w[1]} ${JSON.stringify(w[2])} ${w[3].toFixed(2)} vs ${w[4].toFixed(2)}`); }
