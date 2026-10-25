// The helpers of the checks of the prompt library's phone screens (package S4; no dash in the name: not a check). The Library screen is pushed
// from Settings' Prompt library row, a group's screen from a group's row; both are screens of the phone's stack, so the ones below the top are
// still in the page and every reader here looks at the one on top.
//
//   LIB_EXAMPLE                the library of the mockups (group git ⊃ pull requests; review; writing; prompts at the top and inside)
//   seedLibrary(url, lib)      gives this computer's library the groups and prompts of `lib` (`setLibrary("local", …)` of the mock)
//   openLibrary(page)          Settings (pushed when it is not on screen) › Prompt library, at rest; nothing when the Library screen is on top
//   openGroup(page, id)        presses the group's row on the screen on top, waits for the group's screen at rest
//   topScreen(page)            the pushed screen on top: { name, testId } (`lib-screen` | `lib-group-screen`)
//   barOf(page)                { back, backName, title, text } of the bar on top
//   rowsOf(page)               the rows of the screen on top: [{ kind: group | prompt | hit, server, id, name, sub, h, tile, chevron, fonts }]
//   sectionsOf(page)           the cards: [{ server, title, rows, notice }]
//   texts(page, id)            the texts of every `id` element on the screen on top
//   sheetOf(page, id)          the open sheet with the testID: { title, sub, rows: [{ action, label, note, disabled, danger, h }], sep }
//   pressSheetRow(page, id, action)   a row of the open action sheet pressed
//   holdOpen(page, locator)    a finger held on the row until its action sheet is open, then lifted over the sheet's head (a finger lifted over the dimmed
//                              page would be a tap on it that closes the sheet at once: a real long press fires `contextmenu` instead, which the
//                              synthetic touch of DevTools does not)
//   smalls(page)               what is under 13 px or has a target under 44 pt on the screen on top: { fonts, targets }
import { byTid, press } from "./sel.mjs";
import { mockEval } from "../shot.mjs";
import { atRest, openSettings, openRow } from "./settings.mjs";

const J = JSON.stringify;
const g = (id, name, parent = "") => ({ id, name, parent }), p = (id, name, parent, text) => ({ id, name, parent, text });

export const LIB_EXAMPLE = {
  groups: [g("g_git", "git"), g("g_pr", "pull requests", "g_git"), g("g_review", "review"), g("g_writing", "writing")],
  prompts: [
    p("p_commit", "Commit message", "g_git", "Write a commit message for the staged changes."),
    p("p_squash", "Squash commits", "g_git", "Squash these commits into one."),
    p("p_sum", "Summarise this chat", "", "Summarise what was decided in this chat.\nKeep it short."),
    p("p_prt", "PR title", "g_pr", "Write titles for this pull request, in the imperative."),
    p("p_prd", "Pull request description", "g_pr", "Write a pull request description for this change."),
    p("p_rev1", "Review this change", "g_review", "Review this change for bugs."),
    p("p_rev2", "Review the tests", "g_review", ""),
    p("p_wr", "Plain English", "g_writing", "Rewrite this in plain English."),
  ],
};

export const seedLibrary = (url, lib = LIB_EXAMPLE, server = "local") => mockEval(`setLibrary(${J(server)}, ${J(lib)});`, url);

const onTop = (page, id) => byTid(page, id).last().isVisible().catch(() => false);

/** The Library screen on top: Settings (pushed when needed) and its Prompt library row. */
export async function openLibrary(page) {
  if (await onTop(page, "lib-screen")) return;
  if (!(await onTop(page, "settings-screen"))) await openSettings(page);
  await openRow(page, "library", "lib-screen");
}

export async function openGroup(page, id) {
  const top = await topScreen(page), root = byTid(page, top.testId).last();
  await press(page, root.locator(`[data-testid="lib-group-row"][data-id=${J(id)}]`).first());
  await atRest(page, "lib-group-screen");
}

export const topScreen = (page) => page.evaluate(() => {
  const s = [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop();
  const id = ["lib-screen", "lib-group-screen"].find((t) => s?.querySelector(`[data-testid="${t}"]`));
  return { name: s?.dataset.screen ?? null, testId: id ?? null };
});

export const barOf = (page) => page.evaluate(() => {
  const bar = [...document.querySelectorAll('[data-testid="place-bar"]')].pop(), back = [...document.querySelectorAll('[data-testid="nav-back"]')].pop();
  return { back: back?.innerText.trim() ?? null, backName: back?.getAttribute("aria-label") ?? null, title: bar?.querySelector('[data-testid="bar-title"]')?.innerText.trim() ?? null, text: bar?.innerText.replace(/\s+/g, " ").trim() ?? null };
});

export const rowsOf = (page) => page.evaluate(() => {
  const root = (() => { const s = [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop(); return s?.querySelector('[data-testid="lib-screen"], [data-testid="lib-group-screen"]') ?? null; })();
  const kinds = { "lib-group-row": "group", "lib-prompt-row": "prompt", "lib-hit-row": "hit" };
  const leaf = (e) => [...e.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim());
  return [...(root?.querySelectorAll('[data-testid="lib-group-row"], [data-testid="lib-prompt-row"], [data-testid="lib-hit-row"]') ?? [])].map((e) => {
    const r = e.getBoundingClientRect(), texts = leaf(e), svgs = [...e.querySelectorAll("svg")].map((s) => s.getBoundingClientRect());
    return {
      kind: kinds[e.dataset.testid], server: e.dataset.server, id: e.dataset.id, name: texts[0]?.textContent.trim() ?? "", sub: texts[1]?.textContent.trim() ?? "",
      h: r.height, top: r.top, tile: svgs.length > 0 && svgs[0].left < r.left + 60, chevron: svgs.some((s) => s.right > r.right - 40), fonts: texts.map((d) => parseFloat(getComputedStyle(d).fontSize)),
    };
  });
});

export const sectionsOf = (page) => page.evaluate(() => {
  const root = (() => { const s = [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop(); return s?.querySelector('[data-testid="lib-screen"], [data-testid="lib-group-screen"]') ?? null; })();
  const q = (e, id) => [...e.querySelectorAll(`[data-testid="${id}"]`)];
  return q(root ?? document, "lib-section").map((s) => ({
    server: s.dataset.server, title: s.querySelector('[role="heading"]')?.textContent.trim() ?? "", rows: q(s, "lib-group-row").length + q(s, "lib-prompt-row").length,
    notice: q(s, "lib-off-notice").map((n) => n.textContent.trim()),
  }));
});

export const texts = (page, id) => page.evaluate((id) => {
  const root = (() => { const s = [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop(); return s?.querySelector('[data-testid="lib-screen"], [data-testid="lib-group-screen"]') ?? null; })();
  return [...(root?.querySelectorAll(`[data-testid="${id}"]`) ?? [])].map((e) => e.textContent.replace(/\s+/g, " ").trim());
}, id);

export const sheetOf = (page, id = "action-sheet") => page.evaluate((id) => {
  const s = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop();
  if (!s) return null;
  const rows = [...s.querySelectorAll('[data-testid="action-row"]')];
  const sep = s.querySelector('[data-testid="menu-sep"]');
  return {
    title: s.querySelector('[data-testid="sheet-title"]')?.textContent.trim() ?? "", sub: s.querySelector('[data-testid="sheet-sub"]')?.textContent.trim() ?? "",
    rows: rows.map((e) => {
      const leaf = [...e.querySelectorAll("div")].filter((d) => d.children.length === 0 && d.textContent.trim());
      return { action: e.dataset.action, label: leaf[0]?.textContent.trim() ?? "", note: leaf[1]?.textContent.trim() ?? "", disabled: e.getAttribute("aria-disabled") === "true", h: e.getBoundingClientRect().height, top: e.getBoundingClientRect().top };
    }),
    sepTop: sep?.getBoundingClientRect().top ?? null,
  };
}, id);

export const pressSheetRow = (page, id, action) => press(page, byTid(page, id).last().locator(`[data-testid="action-row"][data-action=${J(action)}]`).first());

const cdps = new WeakMap();
export async function holdOpen(page, locator, { sheet = "action-sheet" } = {}) {
  if (!cdps.has(page)) cdps.set(page, await page.context().newCDPSession(page));
  const c = cdps.get(page);
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox(), at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y, id: 1 }] });
  try {
    await byTid(page, sheet).last().waitFor({ state: "visible", timeout: 5000 });
    await atRest(page, "sheet-head");
    const h = await byTid(page, sheet).last().locator('[data-testid="sheet-head"]').boundingBox();
    await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: h.x + h.width / 2, y: h.y + h.height / 2, id: 1 }] });
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } catch (e) {
    await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    throw e;
  }
}

export const smalls = (page) => page.evaluate(() => {
  const root = (() => { const s = [...document.querySelectorAll('[data-testid="pushed-screen"]')].pop(); return s?.querySelector('[data-testid="lib-screen"], [data-testid="lib-group-screen"]') ?? null; })();
  const fonts = [...(root?.querySelectorAll("div, span") ?? [])].filter((d) => d.children.length === 0 && d.textContent.trim()).map((d) => ({ text: d.textContent.trim().slice(0, 30), px: parseFloat(getComputedStyle(d).fontSize) })).filter((f) => f.px < 13);
  const targets = [...(root?.querySelectorAll('[role="button"], input, textarea') ?? [])].map((e) => ({ id: e.dataset.testid ?? e.tagName, h: e.getBoundingClientRect().height })).filter((t) => t.h > 0 && t.h < 43.5);
  return { fonts, targets };
});
