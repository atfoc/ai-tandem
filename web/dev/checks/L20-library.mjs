// L20 (new in the app, AD-80; package S11): the rows of the prompt library's popups (C-PL-*) that no old check proved, at the three viewports, on the mock.
//   The library popup's head reads "<⌘P> in a message box inserts a prompt", the key named as the platform of the page does (C-PL-02).
//   What a library says is shown as plain text, in both popups: a group and a prompt whose names and text are markup, a server's name that is markup, and the notice of a library file that was
//   set aside at a server's start (the notice comes with the snapshot, is the popup's, and names its server when there are several: "Studio: …") are on screen as the characters they
//   are, with no element made of them (C-PL-18).
//   Tab is kept inside the library popup: from its last control to its first, and Shift+Tab back (C-PL-32; the insert popup's is PL5.2's).
//   Both popups are readable in each theme and each Catppuccin flavour (C-PL-33, the library's part of the old A6.3): every text and icon has 3:1 against what is behind it, or no less than the same
//   element has in the theme the flavour is laid over (a faint hint, a "not connected" mark are as they are today), as A6.3-markdown holds the chat to.
import { atRest, check, contrastAudit, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, press, tidSel } from "./sel.mjs";
import { seen, insertSeen } from "./library.mjs";
import { barOf, openGroup, openLibrary, rowsOf, sectionsOf, texts } from "./libphone.mjs";
import { atRest as atRestId } from "./settings.mjs";

// At the phone (ux-improvements S4) the two popups are the pushed Library and group screens, the editor sheet and the Prompt sheet, and this check proves the same through them. What a library says is the
//   characters it is on the Library screen, a group's screen (its bar's title too), the editor (the values of its Name and text fields) and the Prompt sheet (its folder heads, names and lines, the server's name
//   among them): with no element made of it. The notice of a library file that was set aside (`lib-file-notice`, one per library that has one, at the top of the Library screen under the search) is plain too and names
//   its server when there are several ("This computer: …", "<u>Studio</u>: …"). The ⌘P line of the wide head has no phone counterpart (the phone shows no key), and Tab is kept inside the wide dialog only: the
//   phone's sheets are the kit's, whose trap UX.F1 proves. Each theme and flavour: the Library screen, a group screen, the editor sheet and the Prompt sheet pass the same rule (3:1, or no less than the
//   same element has in the theme the flavour is laid over).
export const viewports = ["desktop", "tablet", "phone"];

const MARKUP = { groups: [{ id: "g_b", name: "<b>bold</b>", parent: "" }], prompts: [{ id: "p_i", name: "<img src=x onerror=alert(1)>", parent: "g_b", text: "<script>alert(1)</script> & <i>text</i>" }, { id: "p_t", name: "plain", parent: "", text: "Plain." }] };
const NOTICE = "The library file could not be read: it was set aside as prompt-library.json.unreadable-2026-10-01T00:00:00Z. <b>Not markup.</b>";
const STUDIO = { id: "s_studio", name: "<u>Studio</u>", address: "https://studio.example:4790", state: "connected", version: "dev" };
const LIBRARIES = `setServers([${JSON.stringify(STUDIO)}]);
  setLibrary("local", { groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [{ id: "p_review", name: "review", parent: "g_git", text: "Review this change.\\n\\n- say what is wrong" }, { id: "p_todo", name: "todo", parent: "", text: "" }] });
  setLibrary("s_studio", { groups: [], prompts: [{ id: "p_rules", name: "rules", parent: "", text: "Be kind." }] });
  setServerState("s_studio", "unreachable");`;
const PHONE_LIBRARIES = `${LIBRARIES}
  setLibrary("local", { groups: [{ id: "g_git", name: "git", parent: "" }], prompts: [{ id: "p_review", name: "review", parent: "g_git", text: "Review this change.\\n\\n- say what is wrong" }, { id: "p_todo", name: "todo", parent: "", text: "" }], notice: ${JSON.stringify(NOTICE)} });`;
const FLAVOURS = { latte: "light", frappe: "dark", macchiato: "dark", mocha: "dark" };
const FLOOR = 3;
const CLAUDE = "#d97757";

await check("L20 the prompt library's popups: the head's key, what a library says as text, Tab, and each flavour", async ({ url, open, fail, note, touch, layout }) => {
  const seeded = await seed(url, "A2");
  const sel = seeded.find((s) => s.id === "plain-started")?.sel ?? fail("the seed has no state plain-started");
  const servers = (list) => mockEval(`setServers(${JSON.stringify(list)});`, url);
  const markup = (root) => root.evaluate((e) => e.querySelectorAll("b, i, u, img, script, a").length);

  // ---- the head's key, and what a library says
  await servers([]);
  await mockEval(`setLibrary("local", ${JSON.stringify({ ...MARKUP, notice: NOTICE })});`, url);
  if (layout === "phone") {
    // (the screens of the stack, the bar, the editor and the sheet: the places a library's words are drawn)
    const parts = '[data-testid="pushed-screen"], [data-testid="place-bar"], [data-testid="prompt-editor"], [data-testid="insert-popup"]';
    const made = (page) => page.evaluate((parts) => [...document.querySelectorAll(parts)].reduce((n, r) => n + r.querySelectorAll("b, i, u, img, script, a").length, 0), parts);
    const J = JSON.stringify;
    // (the names are the library's own words as the server keeps them: a name has no "/", which the library's paths are joined with, so the closing tags of the wide seed are left out)
    const STUDIO_P = { ...STUDIO, name: "<u>Studio" };
    await mockEval(`setLibrary("local", ${J({ groups: [{ id: "g_b", name: "<b>bold", parent: "" }], prompts: MARKUP.prompts, notice: NOTICE })});`, url);
    const { page, ctx } = await open({ sel, wait: tidSel("composer-input") });
    const shows = async (what, read, want) => { let s; if (!await until(async () => want((s = await read())), 10000)) fail(`${what}: the page shows ${J(s)}`); return s; };
    // the Library screen: the names, the notice
    await openLibrary(page);
    let rows = await shows("the Library screen with markup for names", () => rowsOf(page), (r) => r.length === 2);
    if (rows.map((r) => r.name).join("|") !== "<b>bold|plain") fail(`the Library screen shows ${J(rows.map((r) => r.name))}: the names are not the characters they are`);
    let notices = await texts(page, "lib-file-notice");
    if (notices.length !== 1 || notices[0] !== NOTICE) fail(`the notice of a library set aside is ${J(notices)} on the Library screen, not ${J([NOTICE])}`);
    if (await made(page)) fail(`the Library screen has ${await made(page)} elements made of what the library says`);
    // a group's screen: the prompt, its first line, the bar's title
    await openGroup(page, "g_b");
    rows = await shows("the group screen", () => rowsOf(page), (r) => r.length === 1);
    if (rows[0].name !== "<img src=x onerror=alert(1)>" || rows[0].sub !== "<script>alert(1)</script> & <i>text</i>") fail(`the group's screen shows ${J([rows[0].name, rows[0].sub])}`);
    const bar = await barOf(page);
    if (bar.title !== "<b>bold") fail(`the group screen's bar is titled ${J(bar.title)}`);
    if (await made(page)) fail(`the group screen has ${await made(page)} elements made of what the library says`);
    // the editor: the values of its fields
    await press(page, byTid(page, "lib-prompt-row").last());
    await atRestId(page, "prompt-editor");
    const field = (id) => byTid(page, id).last().inputValue();
    if (await field("editor-name") !== "<img src=x onerror=alert(1)>") fail(`the editor's Name field holds ${J(await field("editor-name"))}`);
    if (await field("editor-text") !== "<script>alert(1)</script> & <i>text</i>") fail(`the editor's text field holds ${J(await field("editor-text"))}`);
    if (await made(page)) fail(`the editor has ${await made(page)} elements made of what the library says`);
    await press(page, byTid(page, "sheet-left").last());
    await until(async () => (await byTid(page, "prompt-editor").count()) === 0, 10000) || fail("Cancel did not close the editor");
    // a second library whose notice and name are markup: the notices name their servers
    await back(page);
    await servers([STUDIO_P]);
    await mockEval(`setLibrary("s_studio", { groups: [], prompts: [], notice: "Set aside." }); setServerState("s_studio", "unreachable"); setServerState("s_studio", "connected");`, url); // (the notice comes with the server's snapshot: it joins again)
    await shows("a second library with a notice", () => sectionsOf(page), (x) => x.some((c) => c.title.includes("Studio")));
    const both = await texts(page, "lib-file-notice");
    if (both.join("|") !== `This computer: ${NOTICE}|<u>Studio: Set aside.`) fail(`with two libraries the notices are ${J(both)}`);
    const titles = (await sectionsOf(page)).map((c) => c.title);
    if (!titles.includes("<u>Studio")) fail(`the Library screen's cards are titled ${J(titles)}, not with the server's name as characters`);
    if (await made(page)) fail(`with a server named by markup the Library screen has ${await made(page)} elements made of it`);
    await ctx.close(); // (the mock has one stream: two pages open take it from each other)
    // the Prompt sheet shows the same as text, with one library and with two
    await servers([]);
    await mockEval(`setLibrary("local", ${J({ groups: [{ id: "g_b", name: "<b>bold", parent: "" }], prompts: MARKUP.prompts })}); setLibrary("s_studio", null);`, url);
    {
      const { page: chat, ctx: chatCtx } = await open({ sel, wait: tidSel("composer-input") });
      const sheet = () => chat.evaluate(() => {
        const pop = document.querySelector('[data-testid="insert-popup"]'), t = (e) => e?.textContent.trim() ?? "", q = (id) => [...(pop?.querySelectorAll(`[data-testid="${id}"]`) ?? [])].map(t);
        return pop && { heads: q("insert-section"), names: q("lib-pname"), lines: q("insert-text") };
      });
      await press(chat, byTid(chat, "composer-input").first());
      await chat.keyboard.press("ControlOrMeta+p");
      let r = await shows("the Prompt sheet", sheet, (x) => x && x.names.length === 2);
      if (J(r) !== J({ heads: ["<b>bold", "Top level"], names: ["<img src=x onerror=alert(1)>", "plain"], lines: ["<script>alert(1)</script> & <i>text</i>", "Plain."] })) fail(`the Prompt sheet shows ${J(r)}`);
      if (await made(chat)) fail(`the Prompt sheet has ${await made(chat)} elements made of what the library says`);
      await servers([STUDIO_P]); // (joins while the sheet is open)
      await mockEval(`setLibrary("s_studio", { groups: [], prompts: [{ id: "p_rules", name: "rules", parent: "", text: "Be kind." }] });`, url);
      r = await shows("the Prompt sheet with a second library", sheet, (x) => x && x.names.length === 3);
      if (J(r.heads) !== J(["This computer › <b>bold", "This computer", "<u>Studio"])) fail(`with two libraries the Prompt sheet's heads are ${J(r.heads)}`);
      if (await made(chat)) fail(`with a server named by markup the Prompt sheet has ${await made(chat)} elements made of it`);
      await chat.keyboard.press("Escape");
      await chatCtx.close();
    }
    note("the names, texts, a server's name and the notices are text on the Library screen, a group's screen, the editor and the Prompt sheet; the notice names its server when there are several; the ⌘P line and Tab are the wide popups' (the phone shows no key; its sheets are the kit's)");
  } else {
    const { page, ctx } = await open({ sel, wait: tidSel("composer-input") });
    const platform = await page.evaluate(() => navigator.platform), key = /Mac|iPhone|iPad/.test(platform) ? "⌘P" : "Ctrl+P";
    await (await import("./sel.mjs")).showList(page);
    await press(page, byTid(page, "library-btn"));
    await byTid(page, "library-dialog").waitFor({ state: "visible", timeout: 15000 });
    const D = byTid(page, "library-dialog");
    const head = await byTid(D, "lib-hint-keys").textContent();
    if (head !== `${key} in a message box inserts a prompt`) fail(`the library popup's head reads ${JSON.stringify(head)}, not "${key} in a message box inserts a prompt"`);
    const shows = async (what, want) => { let s; if (!await until(async () => want((s = await page.evaluate(seen))), 10000)) fail(`${what}: the page shows ${JSON.stringify(s)}`); return s; };
    let s = await shows("the library with markup for names", (x) => x.rows.length === 3);
    if (s.rows.join("|") !== "<b>bold</b>|  <img src=x onerror=alert(1)>|plain") fail(`the tree shows ${JSON.stringify(s.rows)}: the names are not the characters they are`);
    const notices = await byTid(D, "lib-notice").allTextContents();
    if (notices.length !== 1 || notices[0] !== NOTICE) fail(`the notice of a library set aside is ${JSON.stringify(notices)}, not ${JSON.stringify([NOTICE])}`);
    await press(page, D.locator(tidSel("lib-row")).filter({ hasText: "img" }));
    s = await shows("the prompt with markup chosen", (x) => x.form?.name === "<img src=x onerror=alert(1)>");
    if (s.form.text !== "<script>alert(1)</script> & <i>text</i>") fail(`the editor shows the text ${JSON.stringify(s.form.text)}`);
    if (await markup(D)) fail(`the library popup has ${await markup(D)} elements made of what the library says`);
    // (the notice says its server when there are several libraries)
    await servers([STUDIO]);
    await mockEval(`setLibrary("s_studio", { groups: [], prompts: [], notice: "Set aside." }); setServerState("s_studio", "unreachable"); setServerState("s_studio", "connected");`, url); // (the notice comes with the server's snapshot: it joins again)
    await shows("a second library with a notice", (x) => x.rows.some((r) => r.includes("Studio")));
    const both = await byTid(D, "lib-notice").allTextContents();
    if (both.join("|") !== `This computer: ${NOTICE}|<u>Studio</u>: Set aside.`) fail(`with two libraries the notices are ${JSON.stringify(both)}`);
    if (await markup(D)) fail(`with a server named by markup the library popup has ${await markup(D)} elements made of it`);
    // ---- Tab is kept inside the popup
    const ctl = () => page.evaluate(() => { const a = document.activeElement, d = document.querySelector('[data-testid="library-dialog"]'); return { in: !!a && d.contains(a), id: a?.dataset?.testid ?? a?.tagName }; });
    await page.locator(tidSel("lib-close")).focus();
    await page.keyboard.press("Tab");
    if (!await until(async () => (await ctl()).id === "lib-search", 5000)) fail(`Tab from the popup's last control (Close) goes to ${JSON.stringify(await ctl())}, not to its search`);
    await page.keyboard.press("Shift+Tab");
    if (!await until(async () => (await ctl()).id === "lib-close", 5000)) fail(`Shift+Tab from the popup's first control (the search) goes to ${JSON.stringify(await ctl())}, not to Close`);
    // ---- the insert popup shows the same as text
    await page.keyboard.press("Escape");
    await byTid(page, "library-dialog").waitFor({ state: "detached", timeout: 10000 });
    await servers([]);
    await mockEval(`setLibrary("local", ${JSON.stringify(MARKUP)}); setLibrary("s_studio", null);`, url);
    await ctx.close(); // (the mock has one stream: two pages open take it from each other)
    {
      const { page: chat, ctx: chatCtx } = await open({ sel, wait: tidSel("composer-input") });
      await press(chat, byTid(chat, "composer-input").first());
      await chat.keyboard.press("ControlOrMeta+p");
      const ok = await until(async () => (await chat.evaluate(insertSeen)).rows.length === 2, 10000);
      const r = await chat.evaluate(insertSeen);
      if (!ok || r.rows.join("|") !== "<b>bold</b>/<img src=x onerror=alert(1)>|plain") fail(`the insert popup lists ${JSON.stringify(r.rows)}`);
      if (await markup(byTid(chat, "insert-popup"))) fail(`the insert popup has ${await markup(byTid(chat, "insert-popup"))} elements made of what the library says`);
      await chat.keyboard.press("Escape");
      await chatCtx.close();
    }
    note(`the head names ${key}; names, texts, a server's name and the notices are text in both popups; Tab stays in the library popup`);
  }

  // ---- each theme and flavour: both popups readable
  await servers([]);
  await mockEval(layout === "phone" ? PHONE_LIBRARIES : LIBRARIES, url);
  const STAGES = layout === "phone" ? [
    { name: "the Library screen", part: tidSel("lib-screen"), min: 10, async show(page) { await openLibrary(page); await byTid(page, "lib-file-notice").first().waitFor({ state: "visible", timeout: 15000 }); } },
    { name: "a group screen", part: tidSel("lib-group-screen"), min: 4, async show(page) { await openLibrary(page); await openGroup(page, "g_git"); } },
    { name: "the editor sheet", part: tidSel("prompt-editor"), min: 6, async show(page) {
      await openLibrary(page); await openGroup(page, "g_git");
      await press(page, byTid(page, "lib-prompt-row").last());
      await atRestId(page, "prompt-editor");
    } },
    { name: "the Prompt sheet", part: tidSel("insert-popup"), min: 6, async show(page) {
      await press(page, byTid(page, "composer-input").first());
      await page.keyboard.press("ControlOrMeta+p");
      await byTid(page, "insert-row").first().waitFor({ state: "visible", timeout: 15000 });
    } },
  ] : [
    { name: "the library popup", part: tidSel("library-dialog"), min: 12, async show(page) {
      await (await import("./sel.mjs")).showList(page);
      await press(page, byTid(page, "library-btn"));
      await byTid(page, "lib-row").first().waitFor({ state: "visible", timeout: 15000 });
      await press(page, byTid(page, "lib-row").filter({ hasText: "review" }).first());
      await byTid(page, "lib-text-input").waitFor({ state: "visible", timeout: 10000 });
    } },
    { name: "the insert popup", part: tidSel("insert-popup"), min: 6, async show(page) {
      await press(page, byTid(page, "composer-input").first());
      await page.keyboard.press("ControlOrMeta+p");
      await byTid(page, "insert-row").first().waitFor({ state: "visible", timeout: 15000 });
    } },
  ];
  const read = async (theme, stage) => {
    const { ctx, page } = await open({ sel, ls: { "aiwb.theme": theme }, wait: tidSel("composer-input") }); // (the clock is not pinned: a sheet rises on it, and neither popup tells a time)
    try {
      await stage.show(page);
      if (!await atRest(page, 8)) fail(`${theme}, ${stage.name}: the page did not come to rest`);
      if (process.env.OUT && layout === "phone" && stage.name === "the Library screen" && (theme === "light" || theme === "mocha")) await page.screenshot({ path: `${process.env.OUT}/library-notice-${theme}.png` }); // (OUT=/tmp/x keeps the Library screen with the file's notice, light and Mocha)
      const rows = await contrastAudit(page, { only: [stage.part] });
      const least = new Map();
      for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
      return least;
    } finally { await ctx.close(); }
  };
  const found = async (theme) => { // (one page at a time: the mock has one stream, and two pages open take it from each other)
    const out = {};
    for (const st of STAGES) out[st.name] = await read(theme, st);
    return out;
  };
  const under = { light: await found("light"), dark: await found("dark") };
  for (const [flavour, over] of Object.entries(FLAVOURS)) {
    const now = await found(flavour);
    let audited = 0, least = null;
    const asToday = new Map(), accepted = new Map();
    for (const st of STAGES) {
      const rows = now[st.name], base = under[over][st.name];
      if (rows.size < st.min) fail(`${flavour}, ${st.name}: only ${rows.size} texts were read: the popup is not on screen`);
      audited += rows.size;
      for (const [key, r] of rows) {
        if (!least || r.ratio < least.ratio) least = r;
        if (r.ratio >= FLOOR) continue;
        const was = base.get(key);
        if (flavour === "latte" && r.kind === "icon" && r.fg === CLAUDE) accepted.set(`${r.fg} on ${r.bg}`, r.ratio);
        else if (was && r.ratio >= was.ratio - 0.005) asToday.set(`${r.kind} ${r.where.split(" > ").pop()}`, `${r.ratio} (${over} ${was.ratio})`);
        else fail(`${flavour}, ${st.name}: ${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${over}` : ` (${over} has no such element)`}`);
      }
    }
    const list = (m) => [...m].map(([k, v]) => `${k} ${v}`).join(", ") || "nothing";
    note(`${flavour}: ${audited} texts in ${STAGES.length} ${layout === "phone" ? "screens and sheets" : "popups"}; the weakest ${least?.ratio}:1; under ${FLOOR}:1 and no weaker than in ${over}: ${list(asToday)}; accepted by the goal: ${list(accepted)}`);
  }
}, { viewports, page: false });
