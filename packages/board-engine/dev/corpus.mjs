// A text corpus measured in Chromium (the board view's page, faces loaded) and in the Node engine, with Excalidraw's own font strings
// (getFontString: "<size>px <family>[, Xiaolai], Segoe UI Emoji"), at Excalidraw's four sizes (16, 20, 28, 36), for every family it
// offers: engine.md section 5. Widths equal within 0.01 px are equal.
export const FAMILIES = { Virgil: 1, Helvetica: 2, Cascadia: 3, Excalifont: 5, Nunito: 6, "Lilita One": 7, "Comic Shanns": 8, "Liberation Sans": 9 };
export const familyString = (name) => `${name}${name === "Excalifont" ? ", Xiaolai" : ""}, Segoe UI Emoji`;
export const SIZES = [16, 20, 28, 36];
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

/** Every width of the corpus on both sides: `[{ family, group, size, line, a, b }]` (a: Chromium, b: Node), in a fixed order.
 *  `chromium` is a page that has shown a board (`load`) and `node` the Node side; the faces the corpus needs are loaded first. */
export async function measureCorpus(chromium, node) {
  const lines = Object.entries(CORPUS).flatMap(([group, ls]) => ls.map((line) => ({ group, line })));
  const texts = lines.map((l) => l.line);
  const fonts = SIZES.flatMap((size) => Object.keys(FAMILIES).map((family) => ({ size, family, font: `${size}px ${familyString(family)}` })));
  await chromium.warm(fonts.map((f) => f.font), texts.join(""));
  const a = await chromium.measure(fonts.map((f) => f.font), texts);
  const b = node.measure(fonts.map((f) => f.font), texts);
  return fonts.flatMap((f, fi) => lines.map((l, li) => ({ family: f.family, group: l.group, size: f.size, line: l.line, a: a[fi][li], b: b[fi][li] })));
}
