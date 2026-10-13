// Proves A6.3: every part of the page the goal names is readable in each Catppuccin flavour: a chat with code, open
// tool cards and permission cards; the tree popup; a board with its toolbar, properties panel, menu and export
// dialog (and its context menu and help dialog); the Servers dialog; and the picker's own menu. The prompt library's two popups, which came after
// the goal, are read the same way: the library popup with a prompt in its editor and a server that is not connected,
// and the insert popup with its list.
// Readable is measured, on computed colours: every text and every icon of the part (contrastAudit of dev/shot.mjs)
// has 3:1 against what is behind it, the weakest floor the goal has. One that has less passes only if it has no
// less than the same element has in the theme the flavour is laid over (Light under Latte, Dark under the others:
// a count's pill, a control that shows on hover, are that weak today), or if the goal accepts it: in Latte, the
// Claude agent's glyph. What passed that way is printed.
// It also proves that the canvas's chrome follows the flavour (the toolbar, the properties panel, the menu and the
// export dialog are on Base with Text, and Excalidraw has the theme the flavour is laid over) while the drawing
// stays as the canvas renders it (its filter is Excalidraw's own).
// OUT=/tmp/x keeps a screenshot of every part in every flavour there, for a person's look.
// The tool cards of every kind, the composer's states and a wait in the thread are read in each flavour by P7.1.
import fs from "node:fs";
import path from "node:path";
import { act, atRest, check, colourOf, contrastAudit, mockEval, openPage, seed } from "../shot.mjs";

// Base and Text of @catppuccin/palette 1.8.0, and the theme each flavour is laid over
const FLAVOURS = {
  latte: { under: "light", base: "#eff1f5", text: "#4c4f69" },
  frappe: { under: "dark", base: "#303446", text: "#c6d0f5" },
  macchiato: { under: "dark", base: "#24273a", text: "#cad3f5" },
  mocha: { under: "dark", base: "#1e1e2e", text: "#cdd6f4" },
};
const FLOOR = 3, OUT = process.env.OUT;
const CLAUDE = "#d97757"; // the Claude agent's colour in the light theme, which a flavour keeps
const BOARD = { board: "b_ui", chat: "c_A6_sketch" }, EDIT = ".excalidraw:not(.excalidraw--view-mode) .App-toolbar";
// In the mock: this computer's library and the one of the seed's server that is not connected, as it last sent it.
const LIBRARIES = `setLibrary("local", { groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [{ id: "p_review", name: "review", parent: "g_git", text: "Review this change.\\n\\n- say what is wrong" }, { id: "p_todo", name: "todo", parent: "", text: "" }] });
  setLibrary(extra.servers.find((x) => x.state === "unreachable").id, { connected: false, groups: [], prompts: [{ id: "p_rules", name: "rules", parent: "", text: "Be kind." }] });`;
const hex = (c) => (c ? "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("") : "none");

/** The parts: a page each, and its stages, each shown by `do` and on screen when `see` matches. chrome: what of the
 *  canvas's chrome the stage shows, [selector of a surface, selector of a text or icon on it]. */
const PARTS = [
  { name: "chat", sel: { chat: "c_A6_cards" }, wait: ".thread .perm.pending .perm-actions", stages: [
    { name: "a chat with code, open tool cards and permission cards", see: ".thread .tool .tool-detail", count: [".thread .md-code", 4],
      do: async (page) => { for (const row of await page.locator(".thread .tool .tool-row").all()) await row.click(); } } ] },
  { name: "tree", sel: { chat: "c_A6_tree" }, wait: ".chat-head .fk-tree-btn", stages: [{ name: "the tree popup", see: ".fk-nav .fk-rows", do: (page) => act(page, "tree") }] },
  { name: "board", sel: BOARD, wait: EDIT, stages: [
    { name: "a board's toolbar", see: EDIT, chrome: [".excalidraw .App-toolbar", ".excalidraw .App-toolbar .ToolIcon__icon"] },
    { name: "a board's properties panel", see: ".excalidraw .selected-shape-actions .App-menu__left", chrome: [".excalidraw .App-menu__left", ".excalidraw .App-menu__left legend"],
      do: async (page) => { const b = await page.locator(".excalidraw canvas.interactive").boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height - 160); await page.keyboard.press("ControlOrMeta+a"); } },
    { name: "a board's menu", see: ".excalidraw .dropdown-menu .dropdown-menu-container", chrome: [".excalidraw .dropdown-menu .dropdown-menu-container", ".excalidraw .dropdown-menu .dropdown-menu-item"],
      do: async (page) => { await page.keyboard.press("Escape"); await page.locator('.excalidraw [data-testid="main-menu-trigger"]').click(); } },
    { name: "a board's export dialog", see: ".excalidraw .ImageExportModal", chrome: [".excalidraw .Modal__content", ".excalidraw .ImageExportModal h3"],
      do: (page) => page.locator('.excalidraw [data-testid="image-export-button"]').click() },
    // (two more of the canvas's own, which the goal does not name: they are coloured by the same variables)
    { name: "a board's context menu", see: ".excalidraw .context-menu", chrome: [".excalidraw .context-menu", ".excalidraw .context-menu .context-menu-item__label"],
      do: async (page) => { await page.keyboard.press("Escape"); await page.waitForSelector(".excalidraw .ImageExportModal", { state: "detached" });
        const b = await page.locator(".excalidraw canvas.interactive").boundingBox(); await page.mouse.click(b.x + b.width * 0.6, b.y + b.height * 0.8, { button: "right" }); } },
    { name: "a board's help dialog", see: ".excalidraw .HelpDialog", chrome: [".excalidraw .Modal__content", ".excalidraw .HelpDialog h3"],
      do: async (page) => { await page.keyboard.press("Escape"); await page.locator('.excalidraw [data-testid="main-menu-trigger"]').click(); await page.locator('.excalidraw [data-testid="help-menu-item"]').click(); } } ] },
  { name: "servers", sel: {}, wait: ".side-foot .servers-btn", stages: [{ name: "the Servers dialog", see: ".servers-dialog", do: (page) => page.locator(".side-foot .servers-btn").click() }] },
  { name: "library", sel: { chat: "c_plain" }, wait: ".composer .composer-input", stages: [
    { name: "the library popup", see: ".lib-dialog .lib-form textarea", count: [".lib-dialog .lib-off", 1],
      do: async (page) => { await mockEval(LIBRARIES, new URL(page.url()).origin); await page.locator(".side-foot .library-btn").click(); await page.locator(".lib-dialog .lib-row.prompt").first().click(); } },
    { name: "the insert popup", see: '.ins-dialog [role="option"] .lib-off',
      do: async (page) => { await page.keyboard.press("Escape"); await page.waitForSelector(".lib-dialog", { state: "detached" }); await page.locator(".composer .composer-input").click(); await page.keyboard.press("ControlOrMeta+p"); } } ] },
  { name: "picker", sel: {}, wait: ".side-foot .theme-btn", stages: [{ name: "the picker's menu", see: '.side-foot [role="menu"][aria-label="Theme"]', do: (page) => page.locator(".side-foot .theme-btn").click() }] },
];

await check("A6.3 every part of the page is readable in each flavour", async ({ url, browser, fail, note }) => {
  await seed(url, "A1", "A6");
  // (the pages' clock stands a second after the mock's start: a label that tells a time is the same in every theme,
  // so an element of a flavour is found again in the theme under it)
  const clock = await mockEval("return T0;", url) + 1000;
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  /** Every stage of every part in one theme: { [stage]: Map(element → its least ratio) }, and what the canvas showed. */
  const walk = async (theme, P) => {
    const dark = (P?.under ?? theme) === "dark", found = {}, errors = [];
    for (const part of PARTS) {
      const { ctx, page } = await openPage({ url, browser, sel: part.sel, size: [1400, 900], ls: { "aiwb.theme": theme }, wait: part.wait, still: true, errors, clock });
      try {
        for (const st of part.stages) {
          await st.do?.(page);
          await page.waitForSelector(st.see, { timeout: 15000 });
          if (st.count && await page.locator(st.count[0]).count() !== st.count[1]) fail(`${theme}, ${st.name}: ${await page.locator(st.count[0]).count()} elements match ${st.count[0]}, not ${st.count[1]}`);
          // (a part is read once it is still: a popup that opens takes its place over some frames)
          if (!await atRest(page, 8)) fail(`${theme}, ${st.name}: the page did not come to rest`);
          const rows = await contrastAudit(page, { canvas: dark ? [18, 18, 18] : [255, 255, 255] });
          const least = new Map();
          for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
          found[st.name] = least;
          if (OUT && P) await page.screenshot({ path: path.join(OUT, `${part.name}-${st.name.replace(/[^a-z]+/gi, "-").toLowerCase()}-${theme}.png`) });
          if (P && st.chrome) { // the canvas's chrome is in the flavour
            const [surface, on] = st.chrome, bg = hex(await colourOf(page, surface, "backgroundColor")), fg = hex(await colourOf(page, on, "color"));
            if (bg !== P.base) fail(`${theme}, ${st.name}: ${surface} is on ${bg}, not on Base ${P.base}`);
            if (fg !== P.text) fail(`${theme}, ${st.name}: ${on} is drawn in ${fg}, not in Text ${P.text}`);
          }
        }
        if (P && part.name === "board") { // Excalidraw has the theme under the flavour, and draws as it does in it
          const c = await page.evaluate(() => ({ dark: document.querySelector(".canvas .excalidraw").classList.contains("theme--dark"), filter: getComputedStyle(document.querySelector(".excalidraw canvas.static")).filter }));
          if (c.dark !== dark) fail(`${theme}: the canvas has ${c.dark ? "the dark" : "the light"} theme of Excalidraw under a flavour laid over ${P.under}`);
          if (c.filter !== (dark ? "invert(0.93) hue-rotate(180deg)" : "none")) fail(`${theme}: the drawing's filter is "${c.filter}", not Excalidraw's own for ${P.under}`);
        }
      } catch (e) { fail(`${theme}, ${part.name}: ${e.message.split("\n")[0]}`); }
      finally { await ctx.close(); }
    }
    for (const e of errors) fail(`${theme}: page error: ${e}`);
    return found;
  };

  const under = { light: await walk("light"), dark: await walk("dark") };
  for (const [flavour, P] of Object.entries(FLAVOURS)) {
    const found = await walk(flavour, P), base = under[P.under];
    let audited = 0, least = null;
    const asToday = new Map(), accepted = new Map();
    for (const [stage, rows] of Object.entries(found)) {
      if (rows.size < 10) fail(`${flavour}, ${stage}: only ${rows.size} texts and icons were read: the part is not on screen`);
      audited += rows.size;
      for (const [key, r] of rows) {
        if (!least || r.ratio < least.ratio) least = { ...r, stage };
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
});
