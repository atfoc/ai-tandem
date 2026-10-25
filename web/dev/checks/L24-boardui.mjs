// New (rn-sw-gaps-d; rows of area D of the parity inventory that were true and nothing showed): what the board screen does with the
// selection and the view, and what it stores, at the three viewports.
//   The selection controls of a board's chat (D-SL-05, D-SL-06): with nothing selected the "selection" control is off ("Add selection" under a finger);
//     with three shapes selected on the board it reads
//     "+ 3 selected" under a mouse and "Add 3 selected" under a finger, "Point at" under a finger, and a press puts one chip, reading 3, in the
//     message. On the phone the chat is the screen over the board, and the selection made on the board is the chat's all the same.
//     At the phone (ux-improvements C1, B2): the context row has no selection control, whatever is selected (the selection rule: a selection on the board goes
//     to no chat by itself); the "+" sheet's `selection` row reads "Add selection" with the note "Select shapes on the board" (nothing selected) or "3 shapes
//     selected on the board", and is not dimmed (it opens the board to select there); Point at is the `point` row, "Point at". Pressing the selection row
//     opens the board with the selecting bar (`pick-bar`, kind select), whose Add (3) (`pick-add`) puts the selection in the context row as a `ctx-chip`
//     "3 shapes ..." (the box keeps the plain text, no inline chip).
//   A chat with no board, and the chat of an archived board, have neither control, and ⌘L puts no chip in them and ⌘⇧L waits for no point (D-SL-14;
//     keys where there is a keyboard: the desktop, and the tablet as P7.4-board has it).
//   An agent's outline follows the view (D-AG-13): a rectangle drawn by an agent's `apply` has the outline on it, to within a few pixels, as it is on
//     the screen, found by the colour of its stroke in a screenshot; and still after the view was zoomed and panned (wheel) while the outline was
//     there; what an agent deleted is outlined dashed in the danger tone and says "Removed". The pinch of a finger is the system's (a device flow).
//   What is stored does not depend on the theme (D-CT-04): a shape drawn on a page in Light, in Dark and in Mocha is stored with Excalidraw's own
//     ink (#1e1e1e) and the white ground; the colours the theme gives are a filter over the canvas, not in the file.
// The phone (B1) reaches the board's chat by the bar's Chats button (`board-chats`) and a row of the Chats sheet (`chats-row`), and "Edit here" is the
// bottom row's `board-take` (the writer's sign there: the button gone, no "Editing" mark: boarddraw.mjs); the rest is read as on the other viewports,
// except that the outline's run makes the agent's shape where the view has it clear of the screen's edge, and its wheel zooms about the shape (the phone's board opens fitted).
// The pixels of a screenshot are read by the browser's own decoder, in a page of its own (as P7.5-canvas.mjs does).
import { check, mockEval, seed, until } from "../shot.mjs";
import { act, byTid, press, tidSel } from "./sel.mjs";
import { drawer, editHere, LIVE } from "./boarddraw.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const J = JSON.stringify;
const BOARD = "b_ui", CHAT = "c_A2_sketch";
const READY = tidSel("board-canvas", { board: BOARD, state: "ready" });
const GREEN = [0, 200, 0];
/** Whether a "+" sheet row is drawn dimmed or disabled (how UX.C1-composer reads it). */
const rowDimmed = (row) => row.evaluate((e) => e.getAttribute("aria-disabled") === "true" || getComputedStyle(e).opacity < 1 || e.querySelector('[aria-disabled="true"]') !== null);

await check("L24 the board's selection controls and outline follow the view, and what it stores is the theme's own", async ({ url, browser, open, fail, note, touch, viewport }) => {
  const phone = viewport === "phone", keys = !phone; // (the tablet has a hardware keyboard, as P7.4-board has it)
  const decoder = await browser.newPage();
  const tool = (name, args) => mockEval(`return await rpc(${J({ chat: CHAT, board: BOARD, target: BOARD, name, args })});`, url);

  // ---- the selection controls of a board's chat (D-SL-05, D-SL-06)
  {
    // with nothing selected the selection control is off, and reads as the pointer says (on the phone the chat is the screen over the board)
    await seed(url, "A2");
    const none = await open({ sel: { board: BOARD, chat: CHAT }, wait: tidSel("chat-head") });
    if (phone) {
      // (the phone's context row never has "+ Add N selected" (the selection rule, B2); the "+" sheet's "Add selection" row opens the board to select there,
      // so it is not dimmed)
      await none.page.waitForSelector(tidSel("context-row"), { timeout: 15000 });
      await none.page.waitForTimeout(500);
      if (await byTid(none.page, "ctx-act", { kind: "selection" }).count()) fail("phone: the board's chat has a selection control with nothing selected on the board");
      await press(none.page, byTid(none.page, "composer-plus").first());
      const row = byTid(none.page, "action-row", { action: "selection" }).first();
      if (!await until(() => row.count(), 15000)) fail("phone: the \"+\" sheet of the board's chat has no Add selection row");
      else {
        const said = (await row.innerText()).replace(/\s+/g, " ").trim();
        if (!/^Add selection\b/.test(said) || !/Select shapes on the board/.test(said)) fail(`phone: the selection row with nothing selected reads ${J(said)}, not "Add selection" with the note "Select shapes on the board"`);
        if (await rowDimmed(row)) fail(`phone: the Add selection row is dimmed with nothing selected: it opens the board to select there, so it is on`);
      }
    } else {
    const off = byTid(none.page, "ctx-act", { kind: "selection" }).first();
    if (!await until(() => off.count(), 15000)) fail("the board's chat has no selection control");
    else {
      if (!await off.isDisabled()) fail("the selection control is on with nothing selected on the board");
      const said = (await off.textContent())?.replace(/\s+/g, " ").trim();
      if (touch ? said !== "Add selection" : !said?.startsWith("+ Selection")) fail(`the selection control with nothing selected reads "${said}", not "${touch ? "Add selection" : "+ Selection"}"`);
    }
    }
    await none.ctx.close();
    await seed(url, "A2");
    const { ctx, page } = await open({ sel: { board: BOARD, chat: null }, wait: READY });
    await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
    await act(page, "select");
    await press(page, byTid(page, "board-chats").first()); // (beside the board; on the phone the Chats sheet, whose row opens the chat's screen over the board)
    if (viewport === "phone") await press(page, byTid(page, "chats-row", { chat: CHAT }).first());
    const selection = byTid(page, "ctx-act", { kind: "selection" }).first(), point = byTid(page, "ctx-act", { kind: "point" }).first();
    if (phone) await page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
    if (phone) {
      // (the selection rule, B2: a selection made on the board goes to no chat by itself and the context row does not offer it; the "+" sheet's rows
      // are the way in: "Add selection" (its note counts the shapes selected) and "Point at")
      await page.waitForSelector(tidSel("context-row"), { timeout: 15000 });
      await page.waitForTimeout(500);
      if (await selection.count()) fail("phone: the context row offers the board's selection (\"+ Add 3 selected\") with three shapes selected: the selection rule says it goes to no chat by itself");
      await press(page, byTid(page, "composer-plus").first());
      const srow = byTid(page, "action-row", { action: "selection" }).first();
      const row = byTid(page, "action-row", { action: "point" }).first();
      if (!await until(() => row.count(), 15000)) fail("phone: the \"+\" sheet has no Point at row");
      else if (!/^Point at\b/.test((await row.innerText()).trim())) fail(`phone: the point row reads ${J((await row.innerText()).replace(/\s+/g, " "))}, not "Point at"`);
      const said = (await srow.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!/^Add selection\b/.test(said) || !/3 shapes selected on the board/.test(said)) fail(`phone: the selection row with three shapes selected reads ${J(said)}, not "Add selection" with the note "3 shapes selected on the board"`);
      if (await rowDimmed(srow)) fail(`phone: the Add selection row is dimmed with three shapes selected`);
      // the row opens the board to select there; the bar's Add (n) puts the selection in the message, as a chip of the context row (not in the box)
      await press(page, srow);
      await page.waitForSelector(tidSel("pick-bar", { kind: "select" }), { timeout: 15000 }).catch(() => fail("phone: the Add selection row did not open the board with the selecting bar (pick-bar, kind select)"));
      await press(page, byTid(page, "pick-add").first());
      const chip = byTid(page, "ctx-chip", { kind: "selection" }).first();
      if (!await until(() => chip.count(), 15000)) fail("phone: Add (3) on the board put no selection chip in the chat's context row");
      else if (!/^3 shapes\b/.test((await chip.innerText()).trim())) fail(`phone: the selection chip reads ${J(await chip.innerText())}, not "3 shapes …"`);
      if (await byTid(page, "composer-input").locator(tidSel("ref-chip")).count()) fail("phone: the selection is an inline chip in the message's box: the phone keeps the box to the plain text");
    } else {
      const pointLabel = (await point.textContent())?.replace(/\s+/g, " ").trim();
      if (touch ? pointLabel !== "Point at" : !pointLabel?.startsWith("+ Point")) fail(`the point control reads "${pointLabel}", not "${touch ? "Point at" : "+ Point"}"`);
    }
    const chips = () => byTid(page, "composer-input").locator(tidSel("ref-chip")).allTextContents();
    if (!phone) {
    if ((await chips()).length) fail(`the message has chips before the control was pressed: ${J(await chips())}`);
    await press(page, selection);
    const one = await until(async () => { const c = await chips(); return c.length === 1 ? c : null; }, 5000);
    if (!one) fail(`pressing the selection control put ${J(await chips())} in the message, not one chip`);
    else if (!/3/.test(one[0])) fail(`the chip of three selected shapes reads "${one[0]}"`);
    }
    await ctx.close(); // (a page that is left open answers the agent's calls too: each block has the one page it looks at)
  }

  // ---- a chat with no board, and the chat of an archived board, have neither control and wait for no point (D-SL-14)
  {
    await seed(url, "A2");
    const { ctx, page } = await open({ sel: { chat: "c_plain" }, wait: tidSel("chat-head") });
    await page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
    if (await byTid(page, "ctx-act").count() || await byTid(page, "context-row").count()) fail("a chat with no board has the board's controls");
    if (keys) {
      await page.keyboard.press("ControlOrMeta+Shift+l");
      await page.waitForTimeout(400);
      if (await byTid(page, "pick-layer").count()) fail("⌘⇧L waits for a point in a chat with no board");
    }
    if (await byTid(page, "composer-input").locator(tidSel("ref-chip")).count()) fail("a chat with no board has a reference chip in its message");
    await ctx.close();

    await seed(url, "A2");
    // (archiving a board archives its chats: internal/app archiveBoard)
    await mockEval('for (const x of [boards.b_ui, chats.c_A2_sketch]) { x.archived = true; x.archiveOp = "op_l24"; } return 1;', url);
    const q = await open({ sel: { board: BOARD, chat: CHAT }, wait: tidSel("chat-head") });
    // (an archived chat has this bar in the place of its box)
    if (!await until(() => byTid(q.page, "archived-bar").count(), 15000)) fail("the chat of an archived board has no archived bar in the place of its box");
    await q.page.waitForTimeout(800); // (the board's screen settles: the controls were there to be drawn, if they were to be)
    if (await byTid(q.page, "ctx-act").count()) fail("the chat of an archived board has the controls for the selection and the point");
    if (keys) {
      await q.page.keyboard.press("ControlOrMeta+Shift+l");
      await q.page.waitForTimeout(400);
      if (await byTid(q.page, "pick-layer").count()) fail("⌘⇧L waits for a point on an archived board");
    }
    await q.ctx.close();
  }

  // ---- an agent's outline sits where the shape is on the screen, and follows the view (D-AG-13)
  {
    await seed(url, "A2");
    const { ctx, page } = await open({ sel: { board: BOARD, chat: null }, wait: READY });
    await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
    /** The bounds of the pixels of a screenshot that are `GREEN` (the stroke of the shape made by the agent), in CSS pixels, or null. */
    const greenBox = async () => {
      const png = (await page.screenshot({ scale: "css" })).toString("base64");
      return decoder.evaluate(async ([png, green]) => {
        const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          if (Math.abs(data[i] - green[0]) < 50 && Math.abs(data[i + 1] - green[1]) < 50 && Math.abs(data[i + 2] - green[2]) < 50) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        }
        return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
      }, [png, GREEN]);
    };
    const flashBox = () => byTid(page, "flash").first().boundingBox().catch(() => null);
    /** The outline and the shape are measured together, while the outline is there; it sits 10 px outside the shape (Overlays.tsx pad). */
    const together = async (what) => {
      const f = await flashBox();
      if (!f) return fail(`${what}: the outline was gone before it was measured`);
      const s = await greenBox();
      if (!s) return fail(`${what}: the shape the agent made is not on the screen (a green stroke is not found)`);
      const want = { x: s.x - 10, y: s.y - 10, width: s.width + 20, height: s.height + 20 };
      for (const k of ["x", "y", "width", "height"]) if (Math.abs(f[k] - want[k]) > 4) fail(`${what}: the outline's ${k} is ${f[k].toFixed(1)}, the shape's ${k} with its 10 px is ${want[k].toFixed(1)} (shape ${J(s)}, outline ${J(f)})`);
    };
    // (the phone's board opens fitted, which puts the shape's usual place at the screen's edge: there it is made where the view has the screen's x 100, canvas y 250)
    const v = viewport === "phone" ? await page.evaluate(() => window.__aiwbView?.() ?? null) : null;
    if (viewport === "phone" && !v) return fail("the build shows no view (window.__aiwbView): it is not made for the checks");
    const place = v ? { x: Math.round(100 / v.zoom - v.scrollX), y: Math.round(250 / v.zoom - v.scrollY) } : { x: 60, y: 380 };
    const made = await tool("apply", { create: [{ type: "rectangle", key: "l24", ...place, width: 150, height: 90, strokeColor: "#00c800", backgroundColor: "transparent" }] });
    if (made.error) return fail(`the agent's apply answered ${J(made).slice(0, 200)}`);
    if (!await until(() => byTid(page, "flash").count(), 10000)) return fail("the agent's apply drew no outline");
    await together("as made");
    const box = await page.locator(LIVE).boundingBox();
    // (the phone zooms about the shape: the board opens fitted there, and a zoom about the middle of the canvas takes a shape that lies at the screen's edge out of it)
    const first = viewport === "phone" ? await greenBox() : null;
    const at = first ? { x: first.x + first.width / 2, y: first.y + first.height / 2 } : { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    const wheel = async (dy, ctrl) => {
      await page.mouse.move(at.x, at.y);
      if (ctrl) await page.keyboard.down("Control");
      await page.mouse.wheel(0, dy);
      if (ctrl) await page.keyboard.up("Control");
    };
    const touched = async () => (await tool("apply", { update: [{ ref: { key: "l24" }, moveBy: [0, 0] }] })).error === undefined && await until(() => byTid(page, "flash").count(), 10000);
    // (the outline of an edit stays about two and a half seconds: each view change is made after a new one and measured before it goes)
    for (const [what, dy, ctrl] of [["zoomed in", -300, true], ["panned", 160, false], ["zoomed out", 400, true]]) {
      if (!await touched()) { fail(`${what}: the agent's second change drew no outline`); continue; }
      const was = await greenBox();
      await wheel(dy, ctrl);
      if (!await until(async () => { const s = await greenBox(); return !was || !s || Math.abs(s.x - was.x) + Math.abs(s.y - was.y) + Math.abs(s.width - was.width) > 3; }, 5000)) { fail(`${what}: the wheel did not change the view`); continue; }
      await together(what);
    }
    // what an agent deletes is outlined dashed, in the danger tone, and says Removed
    await tool("delete_elements", { refs: [{ key: "l24" }] });
    const danger = byTid(page, "flash", { tone: "danger" }).first();
    if (!await until(() => danger.count(), 10000)) fail("the outline of what an agent deleted is not in the danger tone");
    else {
      if ((await byTid(page, "flash-label").allTextContents()).every((t) => !/Removed/.test(t))) fail("the outline of what an agent deleted does not say Removed");
      const style = await danger.evaluate((e) => getComputedStyle(e).borderTopStyle);
      if (style !== "dashed") fail(`the outline of what an agent deleted is ${style}, not dashed`);
    }
    await ctx.close();
  }

  // ---- what is stored does not depend on the theme (D-CT-04)
  {
    const stored = [];
    for (const theme of ["light", "dark", "mocha"]) {
      await seed(url, "A2");
      const { ctx, page } = await open({ sel: { board: BOARD, chat: null }, ls: { "aiwb.theme": theme }, wait: READY });
      try {
        await editHere(page); // (a board opens as a reader's: the button makes the window its writer)
        const count = () => mockEval("return scenes.b_ui.scene.elements.filter((e) => !e.isDeleted).length;", url);
        await drawer(page)();
        if (!await until(async () => await count() === 4, 15000)) { fail(`${theme}: the shape drawn was not stored (${await count()} shapes)`); continue; }
        stored.push([theme, await mockEval("const s = scenes.b_ui.scene; return { ground: s.appState.viewBackgroundColor, keys: Object.keys(s.appState).sort(), ink: s.elements.filter((e) => !e.id.startsWith('ui_') && !e.isDeleted).map((e) => [e.strokeColor, e.backgroundColor]) };", url)]);
      } finally { await ctx.close(); }
    }
    for (const [theme, s] of stored) {
      if (s.ground !== "#ffffff") fail(`${theme}: the stored ground is ${s.ground}, not #ffffff`);
      if (J(s.keys) !== J(["viewBackgroundColor"])) fail(`${theme}: the stored appState has ${J(s.keys)}, not the ground alone`);
      if (J(s.ink) !== J([["#1e1e1e", "transparent"]])) fail(`${theme}: the stored shape has the colours ${J(s.ink)}, not Excalidraw's own ink and no fill`);
    }
  }
  await decoder.close();
  note("the selection control read as its pointer says and put one chip; a chat with no board and the chat of an archived board have no control and wait for no point; "
    + "the agent's outline sat on its shape and followed the zoom and the pan, and the deleted was dashed, danger, Removed; the stored shape had the ink and the ground of Light in Dark and in Mocha");
}, { viewports, page: false });
