// The scenario of L6 (checks/L6-agenttools.mjs): an agent's board tools run through the page, as the server relays them (the
// `rpc` knob of mock.mjs). It is a module of its own so that another check can run the same scenario with its own way to open a page
// and its own selectors.
//
//   apply            on a board that is not on screen (no board view is up: the engine does it), then on the board on screen
//   get_image        a PNG comes back with the bounds of what it drew, for all, a rect and an empty selection (an error)
//   delete_elements  the element made goes; the edit is stored on the server; a flash says "Removed"
//   show_board       the page shows the board, with the elements brought into view
// Each tool's answer is the one the page gives the server: a text, or { text, image } for get_image, or an error with its code.
import { mockEval, until } from "./shot.mjs";

const J = JSON.stringify;
const CALL = { chat: "c_A2_sketch", board: "b_ui", target: "b_ui" };
const BOARD = "b_ui", NAME = "Sketch";
const SEEDED = ["ui_rect", "ui_ellipse", "ui_diamond"];

/**
 * @param {object} o
 * @param {string} o.url        the mock's address
 * @param {(sel: object) => Promise<{page: import("playwright").Page, close: () => Promise<void>}>} o.open   a page with this selection, drawn
 * @param {(msg: string) => void} o.fail
 * @param {(msg: string) => void} o.note
 * @param {{ live: string, flash: string, flashLabel: string, presence: string }} o.sel   CSS selectors: the editable canvas, a
 *        flash box, the label in it, the "is working on" pill
 * @param {(page: import("playwright").Page) => Promise<boolean>} o.canvasOf   whether the board `BOARD` is on screen, drawn and editable
 */
export async function agentTools({ url, open, fail, note, sel, canvasOf }) {
  const tool = (name, args, over) => mockEval(`return await rpc(${J({ ...CALL, ...over, name, args })});`, url);
  const stored = () => mockEval(`return scenes.${BOARD}.scene.elements.filter((e) => !e.isDeleted).map((e) => e.id);`, url);
  const says = (r, what) => (r && "result" in r ? String(typeof r.result === "string" ? r.result : r.result?.text) : `${what}: ${J(r)}`);
  const parsed = (name, r) => {
    if (!r || r.error !== undefined || typeof r.result !== "string") { fail(`${name}: the page answered ${J(r)?.slice(0, 300)}, not a result`); return null; }
    try { return JSON.parse(r.result); } catch { fail(`${name}: the page's result is not JSON: ${r.result.slice(0, 200)}`); return null; }
  };
  const png = (name, r) => {
    const img = r?.result?.image;
    if (!img || img.mimeType !== "image/png" || typeof img.data !== "string") { fail(`${name}: the page answered ${J(r)?.slice(0, 300)}, not a picture`); return null; }
    const head = Buffer.from(img.data.slice(0, 16), "base64");
    if (head.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || img.data.length < 200) fail(`${name}: the picture is not a PNG of some size (${img.data.length} characters, starting ${head.toString("hex")})`);
    return img;
  };
  const bounds = (name, r) => {
    const m = /bounds x=(-?\d+) y=(-?\d+) w=(\d+) h=(\d+) \(board coordinates\), (\d+) elements?/.exec(String(r?.result?.text ?? ""));
    if (!m) { fail(`${name}: the picture's text has no bounds: ${J(r?.result?.text)}`); return null; }
    return { x: +m[1], y: +m[2], width: +m[3], height: +m[4], count: +m[5] };
  };

  await mockEval(`return seedUI("A2");`, url).then(() => {});
  const { page, close } = await open({ chat: "c_plain" });
  try {
    // ---- a board that is not on screen: apply and get_image through the engine
    const applied = parsed("apply, the board off screen", await tool("apply", { create: [{ type: "rectangle", key: "l6_box", x: 500, y: 80, width: 140, height: 90, label: "Added by L6" }] }));
    const made = applied?.created?.l6_box;
    if (applied && (typeof made !== "string" || !made || applied.board !== NAME)) fail(`apply, the board off screen: the result is ${J(applied)}, not a board named ${NAME} with the id made for l6_box`);
    if (!await until(async () => (await stored()).includes(made), 15000)) fail(`apply, the board off screen: the server's board has ${J(await stored())}, not the new element ${made}`);
    if (!await until(async () => J((await stored()).filter((id) => !id.startsWith("ui_")).length) === "2", 15000)) note(`(the stored board has ${J(await stored())}: the rectangle and its label)`);
    const all = await tool("get_image", { scope: "all", scale: 1 });
    png("get_image all, the board off screen", all);
    const b0 = bounds("get_image all, the board off screen", all);
    if (b0 && (b0.count !== 4 || b0.x > 80 || b0.x + b0.width < 640)) fail(`get_image all: ${J(b0)} for the three shapes and the rectangle at x 500 to 640`);
    const off = await tool("get_image", { scope: "selection" });
    if (!/NO_SELECTION/.test(off.error ?? "")) fail(`get_image of the selection with the board off screen answered ${J(off).slice(0, 300)}, not NO_SELECTION`);
    if (await canvasOf(page)) fail("the board is on screen before show_board asked for it");

    // ---- show_board: the page shows the board
    const shown = await tool("show_board", { refs: [{ key: "l6_box" }] });
    if (says(shown) !== `showing ${NAME}`) fail(`show_board answered ${J(shown).slice(0, 200)}, not "showing ${NAME}"`);
    if (!await until(() => canvasOf(page), 20000)) fail("show_board: the board is not on screen and editable");
    const selNow = await page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));
    if (selNow.board !== BOARD) fail(`show_board: the selection is ${J(selNow)}, not the board ${BOARD}`);

    // ---- on screen
    const view = await tool("get_view", {});
    if (!/Sketch/.test(says(view, "get_view"))) fail(`get_view answered ${J(view).slice(0, 300)}, which does not name the board`);
    const moved = parsed("apply, the board on screen", await tool("apply", { update: [{ ref: { key: "l6_box" }, moveBy: [0, 130] }] }));
    if (moved && !moved.updated?.includes(made)) fail(`apply moveBy: the result is ${J(moved)}, which does not list ${made} as updated`);
    if (!await until(() => page.locator(sel.flash).count(), 10000)) fail("apply on the board on screen drew no flash box");
    else if (!(await page.locator(sel.flashLabel).first().textContent())?.trim()) fail("the flash box on the board has no label");
    if (!await until(() => page.locator(sel.presence).count(), 10000)) fail("an agent worked on the board on screen and the page does not say who is working on it");

    const rect = await tool("get_image", { scope: "rect", rect: { x: 60, y: 60, width: 200, height: 130 }, scale: 1 });
    png("get_image rect", rect);
    const b1 = bounds("get_image rect", rect);
    if (b1 && J([b1.x, b1.y, b1.width, b1.height, b1.count]) !== J([80, 80, 160, 90, 1])) fail(`get_image rect: ${J(b1)}, not the rectangle alone at x=80 y=80 w=160 h=90`);

    const noRef = await tool("delete_elements", { refs: [{ key: "nope" }] });
    if (!/BAD_REF/.test(noRef.error ?? "")) fail(`delete_elements of an unknown key answered ${J(noRef).slice(0, 300)}, not BAD_REF`);
    const del = parsed("delete_elements", await tool("delete_elements", { refs: [{ key: "l6_box" }] }));
    if (del && !del.deleted?.includes(made)) fail(`delete_elements: the result is ${J(del)}, which does not list ${made} as deleted`);
    if (!await until(async () => J((await stored()).filter((id) => !SEEDED.includes(id))) === "[]", 15000)) fail(`delete_elements: the server's board has ${J(await stored())}, not the three seeded shapes`);
    if (!await until(async () => (await page.locator(sel.flashLabel).allTextContents()).some((t) => /Removed/.test(t)), 10000)) fail("delete_elements on the board on screen drew no flash that says Removed");
    const after = bounds("get_image all, after the delete", await tool("get_image", { scope: "all", scale: 1 }));
    if (after && after.count !== 3) fail(`get_image all after the delete counts ${after.count} elements, not 3`);
    note("an agent's apply, get_image, delete_elements and show_board ran through the page: off screen by the engine, on screen by the board's view, each stored on the server and answered as the server relays it");
  } finally { await close(); }
}
