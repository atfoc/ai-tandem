// Proves A6.3 for the board: the board's own parts are readable in each Catppuccin flavour: its toolbar, properties panel, menu and export dialog
// (and its context menu and help dialog). Readable is measured, on computed colours: every text and every icon of the part (contrastAudit of
// dev/shot.mjs) has 3:1 against what is behind it, the weakest floor the goal has. One that has less passes only if it has no less than the same
// element has in the theme the flavour is laid over (Light under Latte, Dark under the others), or if the goal accepts it: in Latte, the Claude
// agent's glyph. What passed that way is printed.
// It also proves that the canvas's chrome follows the flavour (the toolbar, the properties panel, the menu and the export dialog are on Base with
// Text, and Excalidraw has the theme the flavour is laid over) and that the drawing is shown through the flavour's own filter (--theme-filter);
// P7.5 reads what that makes of it. The colours reach Excalidraw in the `theme` message (`chrome`, board-bridge chrome.ts), on the web build to the
// view in the page and on a phone to the web view, which is the same code (board-view): this is the only place where they are read in a browser.
// OUT=/tmp/x keeps a screenshot of every part in every flavour there, for a person's look.
// Ports the board part of dev/checks/A6.3-readable.mjs (B7) to the new build, at all three viewports. The other parts of the old check are
// other packages': the chat with code and its cards (A6.3-markdown.mjs for the code; S4 for the cards), the tree, the Servers dialog (L7), the
// library (the prompt library's package) and the picker's menu (S1). The Excalidraw of a touch viewport is its own layout, so what differs is
// what the body does to reach each part, not what it asserts:
//   - the properties panel of the tablet and the phone is behind the bottom bar's Edit button (as P7.5 reads the picks), which is pressed;
//   - the context menu is opened by a right click of the mouse on every viewport (Excalidraw takes it from a pointer of any kind).
// Deviations from the old check: the page is the board alone (`chat: null`, as P7.5 has it), at the viewport's own window. The flavours are put on a
// page each by the choice stored under "aiwb.theme", as the old check did: it never switched a flavour on an open page (its picker stage only read the
// picker's menu, which A6.1 and L11 read here), so there is no live switch to port. The live switch of the open canvas by the picker of the sidebar's foot,
// in the four flavours and in Light and Dark, is P7.5's (the ground and the filter follow it with no reload).
import fs from "node:fs";
import path from "node:path";
import { atRest, check, colourOf, contrastAudit, seed } from "../shot.mjs";
import { press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// Base and Text of @catppuccin/palette 1.8.0, and the theme each flavour is laid over
const FLAVOURS = {
  latte: { under: "light", base: "#eff1f5", text: "#4c4f69" },
  frappe: { under: "dark", base: "#303446", text: "#c6d0f5" },
  macchiato: { under: "dark", base: "#24273a", text: "#cad3f5" },
  mocha: { under: "dark", base: "#1e1e2e", text: "#cdd6f4" },
};
const FLOOR = 3, OUT = process.env.OUT;
const CLAUDE = "#d97757"; // the Claude agent's colour in the light theme, which a flavour keeps
const BOARD = { board: "b_ui", chat: null }, EDIT = ".excalidraw:not(.excalidraw--view-mode) .App-toolbar";
const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");

/** The stages: each shown by `do` and on screen when `see` matches. chrome: [selector of a surface, selector of a text or icon on it].
 *  `mobile` has what differs in Excalidraw's layout for a narrow container (`.App-toolbar--mobile`: the tablet and the phone). */
const STAGES = [
  { name: "a board's toolbar", see: EDIT, chrome: [".excalidraw .App-toolbar", ".excalidraw .App-toolbar .ToolIcon__icon"] },
  { name: "a board's properties panel", mobile: { see: ".excalidraw .Island:has(legend)", chrome: [".excalidraw .Island:has(legend)", ".excalidraw .Island legend"] }, see: ".excalidraw .selected-shape-actions .App-menu__left", chrome: [".excalidraw .App-menu__left", ".excalidraw .App-menu__left legend"],
    do: async (page) => {
      const b = await page.locator(".excalidraw canvas.interactive").boundingBox();
      await page.mouse.click(b.x + b.width * 0.75, b.y + b.height * 0.7);
      await page.keyboard.press("ControlOrMeta+a");
      // (Excalidraw's phone and tablet layouts keep the panel behind the bottom bar's Edit button)
      if (!await page.waitForSelector(".excalidraw .selected-shape-actions .App-menu__left", { timeout: 3000 }).then(() => true, () => false)) {
        await press(page, page.locator('button[aria-label="Edit"]').first(), { timeout: 10000 });
      }
    } },
  { name: "a board's menu", see: ".excalidraw .dropdown-menu .dropdown-menu-container", chrome: [".excalidraw .dropdown-menu .dropdown-menu-container", ".excalidraw .dropdown-menu .dropdown-menu-item"],
    do: async (page) => { await page.keyboard.press("Escape"); await press(page, page.locator('.excalidraw [data-testid="main-menu-trigger"]')); } },
  { name: "a board's export dialog", see: ".excalidraw .ImageExportModal", chrome: [".excalidraw .Modal__content", ".excalidraw .ImageExportModal h3"],
    do: (page) => press(page, page.locator('.excalidraw [data-testid="image-export-button"]')) },
  // (two more of the canvas's own, which the goal does not name: they are coloured by the same variables)
  { name: "a board's context menu", see: ".excalidraw .context-menu", chrome: [".excalidraw .context-menu", ".excalidraw .context-menu .context-menu-item__label"],
    do: async (page) => {
      await page.keyboard.press("Escape"); await page.waitForSelector(".excalidraw .ImageExportModal", { state: "detached" });
      const b = await page.locator(".excalidraw canvas.interactive").boundingBox();
      await page.mouse.click(b.x + b.width * 0.6, b.y + b.height * 0.8, { button: "right" });
    } },
  { name: "a board's help dialog", see: ".excalidraw .HelpDialog", chrome: [".excalidraw .Modal__content", ".excalidraw .HelpDialog h3"],
    do: async (page) => {
      await page.keyboard.press("Escape");
      await press(page, page.locator('.excalidraw [data-testid="main-menu-trigger"]'));
      await press(page, page.locator('.excalidraw [data-testid="help-menu-item"]'));
    } },
];

await check("A6.3 the board's parts are readable in each flavour", async ({ url, open, fail, note, viewport }) => {
  await seed(url, "A1", "A6");
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  /** Every stage in one theme: { [stage]: Map(element → its least ratio) }. */
  const walk = async (theme, P) => {
    const dark = (P?.under ?? theme) === "dark", found = {};
    const { ctx, page } = await open({ sel: BOARD, ls: { "aiwb.theme": theme }, wait: EDIT, still: true });
    try {
      const mobile = await page.locator(".excalidraw .App-toolbar--mobile").count() > 0;
      for (const stage of STAGES) {
        const st = { ...stage, ...(mobile ? stage.mobile : {}) };
        await st.do?.(page);
        await page.waitForSelector(st.see, { timeout: 15000 });
        // (a part is read once it is still: a popup that opens takes its place over some frames)
        if (!await atRest(page, 8)) fail(`${theme}, ${st.name}: the page did not come to rest`);
        const rows = await contrastAudit(page, { only: [".excalidraw"], canvas: P ? [1, 3, 5].map((i) => parseInt(P.base.slice(i, i + 2), 16)) : dark ? [28, 28, 33] : [255, 255, 255] }); // (the canvas's ground: the flavour's Base, in Dark the page's)
        const least = new Map();
        for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
        found[st.name] = least;
        if (OUT && P) await page.screenshot({ path: path.join(OUT, `board-${st.name.replace(/[^a-z]+/gi, "-").toLowerCase()}-${theme}-${viewport}.png`) });
        if (P && st.chrome) { // the canvas's chrome is in the flavour
          const [surface, on] = st.chrome, bg = hex(await colourOf(page, surface, "backgroundColor")), fg = hex(await colourOf(page, on, "color"));
          if (bg !== P.base) fail(`${theme}, ${st.name}: ${surface} is on ${bg}, not on Base ${P.base}`);
          if (fg !== P.text) fail(`${theme}, ${st.name}: ${on} is drawn in ${fg}, not in Text ${P.text}`);
        }
      }
      if (P) { // Excalidraw has the theme under the flavour, and draws through the flavour's filter
        const c = await page.evaluate(() => ({ dark: document.querySelector('[data-testid="board-view"] .excalidraw').classList.contains("theme--dark"), filter: getComputedStyle(document.querySelector(".excalidraw canvas.static")).filter }));
        if (c.dark !== dark) fail(`${theme}: the canvas has ${c.dark ? "the dark" : "the light"} theme of Excalidraw under a flavour laid over ${P.under}`);
        if (c.filter !== `url("#aiwb-canvas-${theme}")`) fail(`${theme}: the drawing's filter is "${c.filter}", not the flavour's`);
      }
    } catch (e) { fail(`${theme}: ${e.message.split("\n")[0]}`); }
    finally { await ctx.close(); }
    return found;
  };

  const under = { light: await walk("light"), dark: await walk("dark") };
  for (const [flavour, P] of Object.entries(FLAVOURS)) {
    const found = await walk(flavour, P), base = under[P.under];
    let audited = 0;
    const asToday = new Map(), accepted = new Map();
    for (const [stage, rows] of Object.entries(found)) {
      if (rows.size < 5) fail(`${flavour}, ${stage}: only ${rows.size} texts and icons were read: the part is not on screen`);
      audited += rows.size;
      for (const [key, r] of rows) {
        if (r.ratio >= FLOOR) continue;
        const was = base[stage]?.get(key);
        if (flavour === "latte" && r.kind === "icon" && r.fg === CLAUDE) accepted.set(`${r.fg} on ${r.bg}`, r.ratio);
        else if (was && r.ratio >= was.ratio - 0.005) asToday.set(`${r.kind} ${r.where.split(" > ").pop()}`, `${r.ratio} (${P.under} ${was.ratio})`);
        else fail(`${flavour}, ${stage}: ${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${P.under}` : ` (${P.under} has no such element)`}`);
      }
    }
    const list = (m) => [...m].map(([k, v]) => `${k} ${v}`).join(", ") || "nothing";
    note(`${flavour}: ${audited} texts and icons in ${Object.keys(found).length} stages; under ${FLOOR}:1 and no weaker than in ${P.under}: ${list(asToday)}; accepted by the goal (the Claude glyph): ${list(accepted)}`);
  }
}, { viewports, page: false });
