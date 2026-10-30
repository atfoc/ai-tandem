// UX.C1-composer (package C1, ux-improvements goal 3.6; mockups "01 The box", "04 The + sheet", "05 A board chat's context", "07 Notices, and the
// keyboard"): the phone's composer, on the mock's section UXC1 (dev/mock-ui.js: `seed(url, "UXC1")`; every session below seeds it anew, so what one
// section changes in a draft is not what the next finds). At the PHONE it asserts:
//   1 the box          the text is 17 px; empty it is one line high; 8 lines typed show 6 and scroll inside (scrollHeight > clientHeight); the images'
//                      strip is above the input
//   2 the toolbar      under the box, in `composer-phone-tools`: "+" (Add to message), the context ring (no text seen, 44 px), Dictate and ONE primary:
//                      Talk while the box is empty, Send once something is typed (no Talk then), Stop while the agent works (busy), with Send beside it
//                      once something is typed; every target is at least 44 px; the labels are the goal's words; the ring opens Context and usage
//   3 the keys         Return adds a line and sends nothing; Ctrl+Enter sends (the message reaches the mock); the Send button sends
//   4 the "+" sheet    "Add to message": a row for each of files and prompt (dataSet `action`; the web build has no camera and no library row, the
//                      sheet says so in PlusSheet.tsx), each at least 50 px with a sub-line; in a board chat also selection ("Add selection": the note is
//                      "Select shapes on the board", or "3 shapes selected on the board"; never dimmed, it opens the board) and point ("Point at") under
//                      the head "Board · <name>"; a plain chat has neither row nor head
//   5 the images       an upload that waits shows its ring on a 72 px thumb and Send is soft (data-soft) with "An image is being uploaded"; every ×
//                      is at least 44 px; a refused file stays as a marked tile with its reason in red under the strip; 11 images give the limit
//                      line (it names the limit and what was left out) and the sheet's Files row is dimmed with the reason (= Photo library)
//   6 the context row  in a board chat (`context-row`): the board chip first (kind board), then "2 quotes"; "2 quotes" opens "Quoted in this message" (a card for each quote, the comment
//                      field or "+ Add a comment", a 44 px trash); the last quote removed closes the sheet; no "Add 3 selected" while shapes are selected
//                      (the selection rule, B2)
//   7 the ring         amber (data-tone "warn") from 80 % (a chat at 86 %); not in a chat at 21 %
//   8 the chip row     `composer-chip-row` in a new chat (plain and on a board) and none in a started one
// At the TABLET and the DESKTOP only: none of the phone's parts (`composer-phone-tools`, `composer-plus`, `plus-sheet`; `context-row`
// in a plain chat) is drawn, and the wide composer (`composer-box`, `send`) is.
import zlib from "node:zlib";

import { check, mockEval, seed, until } from "../shot.mjs";
import { act, back, byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WAIT = 15000;
const J = JSON.stringify;

/** A 1×1 PNG of the colour `n`: distinct pictures, so that the box does not take them for one image. */
function pngOf(n) {
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, n & 255, (n >> 8) & 255, 100 + n]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const PLAIN = "c_UXC1_started";

await check("UX.C1-composer the phone's composer: the box, the toolbar, the keys, the + sheet, the images, the context row, the ring, the chip row", async ({ url, layout, open, fail, note }) => {
  /** Seeds UXC1 anew, opens `sel` and waits for the box; closes the page when `body` ends. */
  const session = async (sel, body) => {
    await seed(url, "UXC1");
    const o = await open({ sel, wait: tidSel("composer-input") });
    try { await body(o.page); } finally { await o.ctx.close().catch(() => {}); }
  };
  const rect = async (loc) => loc.boundingBox();
  const present = (page, id, data) => byTid(page, id, data).first().isVisible().catch(() => false);
  /** Waits for a testID to be drawn (or gone, with `on` false); fails with what it saw. */
  const shows = async (page, what, id, data, on = true) => {
    const ok = await until(async () => (await present(page, id, data)) === on, WAIT);
    if (!ok) fail(`${what}: ${id}${data ? " " + J(data) : ""} is ${on ? "not drawn" : "still drawn"}`);
    return ok;
  };
  /** At least `min` px each way (a touch target). */
  const target = async (what, loc, min = 44) => {
    const r = await rect(loc);
    if (!r) return fail(`${what}: not drawn, so it has no target`);
    if (r.width < min - 0.5 || r.height < min - 0.5) fail(`${what}: its target is ${Math.round(r.width)}×${Math.round(r.height)} px, under ${min}×${min}`);
  };
  const label = (loc) => loc.getAttribute("aria-label").catch(() => null);
  const input = (page) => byTid(page, "composer-input").first();
  const metrics = (page) => input(page).evaluate((e) => ({ size: getComputedStyle(e).fontSize, h: e.clientHeight, sh: e.scrollHeight, line: parseFloat(getComputedStyle(e).lineHeight) }));
  const userTexts = (chat) => mockEval(`return (items[${J(chat)}] ?? []).filter((x) => x.kind === "user").map((x) => x.text);`, url);
  const focusBox = async (page) => { await press(page, input(page)); await page.waitForFunction((id) => document.activeElement?.dataset?.testid === id, "composer-input", { timeout: WAIT }); };

  // ================= the wide layouts: none of the phone's parts, the wide composer
  if (layout !== "phone") {
    await session({ chat: PLAIN }, async (page) => {
      await shows(page, "the wide composer", "composer-box");
      await shows(page, "the wide composer", "send");
      for (const id of ["composer-phone-tools", "composer-plus", "plus-sheet", "context-row"]) {
        if (await byTid(page, id).count()) fail(`a plain chat at the ${layout} layout draws ${id}, which is the phone's`);
      }
      if (await byTid(page, "composer-talk").count()) fail(`a plain chat at the ${layout} layout draws the phone's Talk (composer-talk)`);
    });
    await session({ board: "b_UXC1", chat: "c_UXC1_board" }, async (page) => {
      await shows(page, "the wide composer on a board", "composer-box");
      await focusBox(page);
      await page.keyboard.type("hi");
      for (const id of ["composer-phone-tools", "composer-plus", "plus-sheet"]) {
        if (await byTid(page, id).count()) fail(`a board chat at the ${layout} layout draws ${id}, which is the phone's`);
      }
    });
    note(`${layout}: no part of the phone's composer is drawn; the wide composer is`);
    return;
  }

  // ================= 1, 2, 3: the box, the toolbar, the keys (a started plain chat)
  await session({ chat: PLAIN }, async (page) => {
    const m0 = await metrics(page);
    if (m0.size !== "17px") fail(`the box's text is ${m0.size}, not 17px`);
    if (m0.h < 24 || m0.h > 40) fail(`the empty box is ${m0.h} px high: not one line (a line of 17 px text is about 31 px with its padding)`);
    if (!(await shows(page, "the toolbar", "composer-phone-tools"))) return;
    const tools = byTid(page, "composer-phone-tools").first();
    const inTools = (id, data) => byTid(tools, id, data).first();
    const boxRect = await rect(byTid(page, "composer-box").first()), toolsRect = await rect(tools);
    if (boxRect && toolsRect && toolsRect.y < (await rect(input(page))).y) fail("the toolbar is not under the text of the box");

    // the controls, left to right: +, the ring, Dictate, the primary
    const plus = inTools("composer-plus"), ring = inTools("ctx-meter"), dictate = inTools("composer-dictate"), talk = inTools("composer-talk");
    for (const [what, loc] of [["+", plus], ["the context ring", ring], ["Dictate", dictate], ["Talk", talk]]) if (!(await loc.isVisible().catch(() => false))) fail(`the empty box's toolbar has no ${what}`);
    if (await label(plus) !== "Add to message") fail(`"+" is labelled ${J(await label(plus))}, not "Add to message"`);
    if (!/dictate/i.test((await label(dictate)) ?? "")) fail(`Dictate is labelled ${J(await label(dictate))}: it does not say Dictate`);
    if (!/talk/i.test((await label(talk)) ?? "")) fail(`Talk is labelled ${J(await label(talk))}: it does not say Talk`);
    for (const [what, loc] of [["+", plus], ["the context ring", ring], ["Dictate", dictate], ["Talk", talk]]) await target(what, loc);
    const xs = await Promise.all([plus, ring, dictate, talk].map(async (l) => (await rect(l))?.x ?? -1));
    if (!xs.every((x, i) => i === 0 || x > xs[i - 1])) fail(`the toolbar's controls are not in the order +, ring, Dictate, primary (their left edges: ${xs.map(Math.round).join(", ")})`);
    if (await byTid(page, "send").count() || await byTid(page, "stop").count()) fail("the empty box shows Send or Stop beside Talk: there is one primary button");
    // the ring has no text seen (its words are drawn clipped to a point), and a tap opens Context and usage
    const seen = await ring.evaluate((e) => [...e.querySelectorAll("*")].filter((n) => n.childNodes.length === 1 && n.firstChild.nodeType === 3 && n.firstChild.textContent.trim())
      .filter((n) => !n.closest('[data-testid="ctx-text"]')) // (the words are drawn, in an element clipped to a point)
      .map((n) => n.textContent.trim()));
    const clip = await ring.locator('[data-testid="ctx-text"]').first().boundingBox().catch(() => null);
    if (clip && (clip.width > 1.5 || clip.height > 1.5)) seen.push(`(ctx-text is ${Math.round(clip.width)}×${Math.round(clip.height)} px, not clipped to a point)`);
    if (seen.length) fail(`the context ring shows text: ${J(seen)}`);
    await press(page, ring);
    // (on the phone the ring opens T3's Context and usage sheet, goal 3.6)
    if (await shows(page, "a tap on the ring", "usage-sheet")) {
      if (!/context/i.test(await byTid(page, "usage-sheet").first().innerText())) fail(`the ring's sheet does not say Context: ${J(await byTid(page, "usage-sheet").first().innerText())}`);
      await page.keyboard.press("Escape");
      await shows(page, "Esc on the ring's sheet", "usage-sheet", undefined, false);
    }
    if (await byTid(page, "composer-chip-row").count()) fail("a started chat draws the chip row");

    // 8 lines typed show 6 and scroll inside
    await focusBox(page);
    for (let i = 1; i <= 8; i++) { await page.keyboard.type(`line ${i}`); if (i < 8) await page.keyboard.press("Enter"); }
    const m8 = await metrics(page);
    if (m8.size !== "17px") fail(`the typed box's text is ${m8.size}, not 17px`);
    if (!(m8.sh > m8.h + 1)) fail(`8 lines typed do not scroll inside the box: scrollHeight ${m8.sh} is not over clientHeight ${m8.h}`);
    const lines = (m8.h - 6) / m8.line;
    if (Math.abs(lines - 6) > 0.4) fail(`the box shows ${lines.toFixed(1)} lines at most, not 6 (clientHeight ${m8.h}, line ${m8.line})`);
    if ((await userTexts(PLAIN)).some((x) => x.includes("line 8"))) fail("Return sent the message: it must add a line");
    // the text is a line break per Return: eight lines
    const typed = await input(page).evaluate((e) => e.innerText.split("\n").filter((l) => l.trim()).length);
    if (typed !== 8) fail(`Return did not add a line each: the box holds ${typed} lines, not 8`);

    // typed: Send is the primary, Talk is gone
    if (await shows(page, "a typed box", "send")) {
      if (await byTid(page, "composer-talk").count()) fail("a typed box still shows Talk beside Send");
      if (!/send/i.test((await label(inTools("send"))) ?? "")) fail(`Send is labelled ${J(await label(inTools("send")))}`);
      await target("Send", inTools("send"));
    }
    // Ctrl+Enter sends, once
    const before = (await userTexts(PLAIN)).length;
    await page.keyboard.press("Control+Enter");
    if (!(await until(async () => (await userTexts(PLAIN)).length === before + 1, WAIT))) fail("Ctrl+Enter did not send: the mock got no new message");
    else if (!(await userTexts(PLAIN)).at(-1).includes("line 8")) fail(`the sent message is ${J((await userTexts(PLAIN)).at(-1))}: not what was typed`);
    await until(async () => (await input(page).evaluate((e) => e.innerText.trim())) === "", WAIT);

    // the button sends too
    await focusBox(page);
    await page.keyboard.type("sent by the button");
    if (await shows(page, "the second message", "send")) {
      const n = (await userTexts(PLAIN)).length;
      await press(page, inTools("send"));
      if (!(await until(async () => (await userTexts(PLAIN)).length === n + 1, WAIT))) fail("the Send button did not send: the mock got no new message");
      else if ((await userTexts(PLAIN)).at(-1) !== "sent by the button") fail(`the Send button sent ${J((await userTexts(PLAIN)).at(-1))}`);
    }
    note("the box 17 px, one line empty, 6 lines then a scroll; the toolbar +, ring, Dictate, Talk; Return adds a line; Ctrl+Enter and the button send");
  });

  // ================= 2: the primary while the agent works
  await session({ chat: "c_UXC1_busy" }, async (page) => {
    const tools = byTid(page, "composer-phone-tools").first();
    if (!(await shows(page, "the busy chat's toolbar", "composer-phone-tools"))) return;
    if (!(await shows(page, "the busy chat", "stop"))) return;
    if (await byTid(tools, "send").count()) fail("an empty box at work shows Send beside Stop: Stop is the one primary");
    if (await byTid(tools, "composer-talk").count()) fail("a box at work shows Talk beside Stop");
    if (!/stop/i.test((await label(byTid(tools, "stop").first())) ?? "")) fail(`Stop is labelled ${J(await label(byTid(tools, "stop").first()))}`);
    await target("Stop", byTid(tools, "stop").first());
    await focusBox(page);
    await page.keyboard.type("next");
    if (await shows(page, "a typed box at work", "send")) {
      const s = await rect(byTid(tools, "send").first()), p = await rect(byTid(tools, "stop").first());
      if (!(s.x < p.x)) fail(`Send (x ${Math.round(s.x)}) is not beside Stop on its left (x ${Math.round(p.x)})`);
      await target("Send beside Stop", byTid(tools, "send").first());
      await target("Stop beside Send", byTid(tools, "stop").first());
    }
  });

  // ================= 7: the ring turns amber from 80 %
  const strokes = {};
  for (const [chat, tone] of [["c_UXC1_amber", "warn"], [PLAIN, "ok"]]) {
    await session({ chat }, async (page) => {
      const ring = byTid(page, "composer-phone-tools").first().locator('[data-testid="ctx-meter"]').first();
      if (!(await ring.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) return fail(`${chat}: no ring in the toolbar`);
      const got = await ring.getAttribute("data-tone"), stroke = await ring.evaluate((e) => [...e.querySelectorAll("circle")].map((c) => c.getAttribute("stroke")).pop());
      if (tone === "warn" && got !== "warn") fail(`a chat at 86 % has a ring of tone ${J(got)}, not "warn" (amber)`);
      if (tone === "ok" && got === "warn") fail("a chat at 21 % has an amber ring");
      strokes[chat] = stroke;
    });
  }
  if (strokes.c_UXC1_amber && strokes.c_UXC1_amber === strokes[PLAIN]) fail(`the ring of 86 % is drawn in the colour of the ring of 21 % (${strokes[PLAIN]})`);
  note("the ring: amber at 86 %, not at 21 %");

  // ================= 8: the chip row only in a new chat
  for (const [sel, on] of [[{ chat: "c_UXC1_new" }, true], [{ board: "b_UXC1", chat: "c_UXC1_board_new" }, true], [{ board: "b_UXC1", chat: "c_UXC1_board" }, false]]) {
    await session(sel, async (page) => {
      await shows(page, "the composer", "composer-phone-tools");
      const has = await until(async () => await present(page, "composer-chip-row"), on ? WAIT : 2500);
      if (on && !has) fail(`a new chat (${J(sel)}) has no chip row`);
      if (!on && await byTid(page, "composer-chip-row").count()) fail(`a started chat (${J(sel)}) draws the chip row`);
      if (on && has) {
        const r = await rect(byTid(page, "composer-chip-row").first()), b = await rect(byTid(page, "composer-box").first());
        if (r && b && r.y + r.height > b.y + 1) fail("the chip row is not above the box");
      }
    });
  }
  note("the chip row: in a new chat, plain and on a board; none in a started one");

  // ================= 4: the "+" sheet
  const rows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="plus-sheet"] [data-testid="action-row"]')].map((e) => {
    const r = e.getBoundingClientRect();
    return { action: e.dataset.action, h: Math.round(r.height), text: e.innerText.replace(/\n+/g, " | "), lines: e.innerText.split("\n").filter((x) => x.trim()).length, disabled: e.getAttribute("aria-disabled") === "true" || getComputedStyle(e).opacity < 1 || e.querySelector('[aria-disabled="true"]') !== null };
  }));
  const openPlus = async (page) => { await press(page, byTid(page, "composer-plus").first()); return shows(page, "a tap on +", "plus-sheet"); };
  await session({ chat: PLAIN }, async (page) => {
    if (!(await openPlus(page))) return;
    const sheet = byTid(page, "plus-sheet").first();
    if (!(await sheet.innerText()).includes("Add to message")) fail(`the sheet's head is not "Add to message": ${J((await sheet.innerText()).slice(0, 60))}`);
    const got = await rows(page), ids = got.map((r) => r.action);
    for (const want of ["files", "prompt"]) if (!ids.includes(want)) fail(`the "+" sheet has no ${want} row (it has ${ids.join(", ")})`);
    for (const none of ["selection", "point"]) if (ids.includes(none)) fail(`a plain chat's "+" sheet has the board row ${none}`);
    for (const r of ["camera", "library"]) if (ids.includes(r)) fail(`the web build's "+" sheet has a ${r} row: it has one picker, Files`);
    if (await byTid(page, "action-section").count()) fail("a plain chat's \"+\" sheet has a section head");
    for (const r of got) {
      if (r.h < 50) fail(`the "${r.action}" row is ${r.h} px high, under 50`);
      if (r.lines < 2) fail(`the "${r.action}" row has no sub-line: ${J(r.text)}`);
    }
    note(`the "+" sheet of a plain chat: ${got.map((r) => `${r.action} ${r.h}px`).join(", ")}`);
  });
  await session({ board: "b_UXC1", chat: "c_UXC1_board" }, async (page) => {
    if (!(await openPlus(page))) return;
    const got = await rows(page), ids = got.map((r) => r.action);
    for (const want of ["files", "prompt", "selection", "point"]) if (!ids.includes(want)) fail(`a board chat's "+" sheet has no ${want} row (it has ${ids.join(", ")})`);
    const head = byTid(page, "action-section").first();
    if (!(await head.isVisible().catch(() => false)) || (await head.innerText()).trim() !== "Board · Pipeline") fail(`the board rows' head is ${J(await head.innerText().catch(() => null))}, not "Board · Pipeline"`);
    for (const r of got) { if (r.h < 50) fail(`the "${r.action}" row is ${r.h} px high, under 50`); if (r.lines < 2) fail(`the "${r.action}" row has no sub-line: ${J(r.text)}`); }
    // (B2: the rows are "Add selection" and "Point at"; each opens the board)
    for (const [action, name] of [["selection", "Add selection"], ["point", "Point at"]]) {
      const r = got.find((x) => x.action === action);
      if (r && !r.text.startsWith(`${name} |`)) fail(`the ${action} row reads ${J(r.text)}, not "${name}" with a note`);
    }
    const order = ids.indexOf("selection") > ids.indexOf("prompt") && ids.indexOf("point") > ids.indexOf("selection");
    if (!order) fail(`the board rows are not after the others, selection then point: ${ids.join(", ")}`);
  });
  // with shapes selected on the board: the row says how many, and the context row offers nothing (the selection rule, B2: a selection goes to no chat by itself)
  await session({ board: "b_ui", chat: "c_UXC1_sketch" }, async (page) => {
    await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: WAIT });
    if (!(await back(page))) return fail("the phone's stack has no back from the chat to the board");
    await byTid(page, "board-bar").first().waitFor({ state: "visible", timeout: WAIT });
    await page.waitForSelector(tidSel("board-canvas", { state: "ready" }), { timeout: WAIT });
    // (the window shows the board as a reader until it takes it: Edit here)
    if (await until(async () => await byTid(page, "board-take").first().isVisible().catch(() => false), 4000)) await press(page, byTid(page, "board-take").first());
    await act(page, "select");
    // (the bar's Chats button opens the Chats sheet; its row opens the chat)
    await press(page, byTid(page, "board-chats").first());
    await byTid(page, "chats-sheet").first().waitFor({ state: "visible", timeout: WAIT });
    await press(page, byTid(page, "chats-row", { chat: "c_UXC1_sketch" }).first());
    await byTid(page, "chat-head").first().waitFor({ state: "visible", timeout: WAIT });
    await shows(page, "the chat on the sketch", "composer-phone-tools");
    await shows(page, "the context row of the chat on the sketch", "context-row");
    await page.waitForTimeout(500);
    if (await byTid(page, "ctx-act", { kind: "selection" }).count()) fail("three shapes are selected and the context row offers \"Add 3 selected\": the selection goes to no chat by itself");
    if (!(await openPlus(page))) return;
    const sel = (await rows(page)).find((r) => r.action === "selection");
    if (!sel) return fail("the board chat's \"+\" sheet has no selection row");
    if (!/3 shapes selected on the board/.test(sel.text) || !sel.text.startsWith("Add selection |")) fail(`the selection row is not "Add selection" with the note "3 shapes selected on the board": ${J(sel.text)}`);
    if (sel.disabled) fail(`the selection row is dimmed with 3 shapes selected: ${J(sel.text)}`);
    note(`selection row with shapes selected: ${J(sel.text)}`);
  });
  await session({ board: "b_UXC1", chat: "c_UXC1_board" }, async (page) => {
    // nothing selected: the row is on all the same (it opens the board to select there) and says what to do
    if (!(await openPlus(page))) return;
    const sel = (await rows(page)).find((r) => r.action === "selection");
    if (sel && sel.disabled) fail(`the selection row is dimmed with nothing selected: it opens the board to select there, so it is on: ${J(sel.text)}`);
    if (sel && !/Select shapes on the board/.test(sel.text)) fail(`the selection row with nothing selected does not say what to do: ${J(sel.text)}`);
  });

  // ================= 5: the images
  await session({ chat: PLAIN }, async (page) => {
    const tools = byTid(page, "composer-phone-tools").first();
    const addFiles = async (files) => {
      if (!(await openPlus(page))) return false;
      const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), press(page, byTid(page, "action-row", { action: "files" }).first())]);
      await chooser.setFiles(files);
      return true;
    };
    await mockEval("flags.upload = { hold: true };", url);
    if (!(await addFiles([{ name: "diagram.png", mimeType: "image/png", buffer: pngOf(1) }]))) return;
    const thumb = byTid(page, "image-thumb").first();
    if (!(await thumb.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) return fail("a picked image has no thumbnail");
    const tr = await rect(thumb);
    if (Math.abs(tr.width - 72) > 1 || Math.abs(tr.height - 72) > 1) fail(`a thumbnail is ${Math.round(tr.width)}×${Math.round(tr.height)} px, not 72×72`);
    if (!(await shows(page, "an upload that waits", "image-thumb-busy"))) fail("the thumbnail of an upload that waits has no ring");
    const strip = await rect(byTid(page, "composer-images").first()), box = await rect(input(page));
    if (strip && box && strip.y + strip.height > box.y + 1) fail("the images' strip is not above the text input");
    // the box holds no text: the upload still makes Send the primary (soft, waiting), not Talk
    const send = byTid(tools, "send").first();
    if (!(await send.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false))) {
      fail(`an upload waits in an empty box and the toolbar shows ${(await byTid(tools, "composer-talk").count()) ? "Talk" : "no primary"}, not a soft Send (Composer.tsx: \`empty\` ignores the uploads)`);
      await focusBox(page);
      await page.keyboard.type("with text");
      await send.waitFor({ state: "visible", timeout: WAIT }).catch(() => {});
    }
    if (await send.isVisible().catch(() => false)) {
      if (await send.getAttribute("data-soft") !== "true") fail(`Send is not soft while an image is uploading (data-soft ${J(await send.getAttribute("data-soft"))})`);
      if (await label(send) !== "An image is being uploaded") fail(`Send is labelled ${J(await label(send))}, not "An image is being uploaded"`);
    }
    await target("the thumbnail's ×", byTid(thumb, "image-thumb-remove").first());
    // released: the ring goes and Send is on
    await mockEval(`release("upload"); delete flags.upload;`, url);
    if (!(await until(async () => !(await byTid(page, "image-thumb-busy").count()), WAIT))) fail("the ring stays on the thumbnail after the upload was answered");
    if (!(await until(async () => (await byTid(tools, "send").first().getAttribute("data-soft").catch(() => "x")) !== "true", WAIT))) fail("Send stays soft after the upload was answered");

    // a refused file stays as a marked tile with its reason in red
    if (!(await addFiles([{ name: "IMG_2041.HEIC", mimeType: "image/heic", buffer: Buffer.from("heic") }]))) return;
    const line = byTid(page, "composer-images-line").first();
    if (!(await line.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) return fail("a refused file left no line under the strip");
    if (!(await line.innerText()).includes("IMG_2041.HEIC is not added")) fail(`the refused file's line says ${J(await line.innerText())}`);
    const rgb = await line.evaluate((e) => getComputedStyle(e).color.match(/\d+/g).slice(0, 3).map(Number));
    if (!(rgb[0] > 150 && rgb[0] > rgb[1] + 60 && rgb[0] > rgb[2] + 60)) fail(`the refused file's reason is not red: rgb(${rgb.join(", ")})`);
    const refusedTile = byTid(page, "image-refused").first();
    if (!(await refusedTile.isVisible().catch(() => false))) fail("the refused file is not a marked tile in the strip (image-refused)");
    else {
      const rr = await rect(refusedTile);
      if (Math.abs(rr.width - 72) > 1 || Math.abs(rr.height - 72) > 1) fail(`the refused tile is ${Math.round(rr.width)}×${Math.round(rr.height)} px, not 72×72`);
      const lr = await rect(line);
      if (lr && lr.y < rr.y + rr.height - 1) fail("the reason is not under the thumbnails");
      if (!/not added/.test((await refusedTile.getAttribute("aria-label")) ?? "")) fail(`the refused tile is labelled ${J(await refusedTile.getAttribute("aria-label"))}: it does not say it was not added`);
    }
    for (const id of ["image-thumb-remove", "image-refused-remove"]) for (const x of await byTid(page, id).all()) await target(`${id}`, x);
    // the refused tile's × takes the tile and its line away
    await press(page, byTid(page, "image-refused-remove").first());
    if (!(await until(async () => !(await byTid(page, "image-refused").count()) && !(await byTid(page, "composer-images-line").count()), WAIT))) fail("the refused tile's × did not take the tile and its line away");

    // the limit: 11 images; the line names it and what was left out, and the Files row is dimmed
    const eleven = Array.from({ length: 11 }, (_, i) => ({ name: `IMG_${i + 1}.png`, mimeType: "image/png", buffer: pngOf(100 + i) }));
    // (a clean box first: the picture above counts too)
    for (let i = 0; i < 5 && (await byTid(page, "image-thumb-remove").count()); i++) await press(page, byTid(page, "image-thumb-remove").first());
    await until(async () => !(await byTid(page, "image-thumb").count()), WAIT);
    if (!(await addFiles(eleven))) return;
    const limit = byTid(page, "composer-images-line", { kind: "count" }).first();
    if (!(await limit.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) return fail("11 images gave no line naming the limit");
    const text = await limit.innerText();
    if (!/10 images/.test(text) || !/IMG_11\.png/.test(text)) fail(`the limit line is ${J(text)}: it must name the 10 images and the file left out`);
    if (!(await until(async () => (await byTid(page, "image-thumb").count()) === 10, WAIT))) fail(`the strip holds ${await byTid(page, "image-thumb").count()} thumbnails, not 10`);
    if (!(await openPlus(page))) return;
    const files = (await rows(page)).find((r) => r.action === "files");
    if (!files) fail("the sheet has no Files row at the limit");
    else if (!files.disabled) fail(`the Files row is not dimmed at the limit of images: ${J(files.text)}`);
    else if (!/10|image|remove/i.test(files.text)) fail(`the dimmed Files row does not say why: ${J(files.text)}`);
    note("images: a 72 px thumb with its ring and a soft Send, 44 px ×, a refused tile with its reason in red, the limit line and the dimmed Files row");
  });

  // ================= 6: the context row of a board chat (a draft with two quotes)
  const DRAFT = { board: "b_UXC1", chat: "c_UXC1_board_draft" };
  await session(DRAFT, async (page) => {
    if (!(await shows(page, "the context row", "context-row"))) return;
    const chips = await byTid(page, "context-row").first().evaluate((row) => [...row.querySelectorAll('[data-testid="ctx-chip"], [data-testid="qcount"], [data-testid="ctx-act"]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { id: e.dataset.testid, kind: e.dataset.kind ?? "", x: Math.round(r.x), h: Math.round(r.height), text: e.innerText.trim() };
    }));
    const order = chips.map((c) => (c.id === "ctx-chip" ? c.kind : c.id));
    if (order.join() !== "board,qcount") fail(`the context row holds ${order.join(", ") || "nothing"}, in that order: not board, qcount (the board chip first, the quotes)`);
    if (chips[0] && !chips[0].text.includes("Pipeline")) fail(`the board chip says ${J(chips[0].text)}, not the board's name`);
    if (chips.some((c) => c.h < 33 || c.h > 36)) fail(`the chips are ${chips.map((c) => c.h).join(", ")} px high, not 34`);
    if (!chips.every((c, i) => i === 0 || c.x > chips[i - 1].x)) fail(`the chips are not left to right in that order: x ${chips.map((c) => c.x).join(", ")}`);
    const row = await rect(byTid(page, "context-row").first());
    if (row && Math.abs(row.height - 44) > 1.5) fail(`the context row is ${Math.round(row.height)} px high, not 44`);
    if (chips.find((c) => c.id === "qcount") && !/2 quotes/.test(chips.find((c) => c.id === "qcount").text)) fail(`the quotes chip says ${J(chips.find((c) => c.id === "qcount").text)}, not "2 quotes"`);

    // "2 quotes" opens "Quoted in this message"
    await press(page, byTid(page, "qcount").first());
    if (!(await shows(page, "a tap on the quotes chip", "quotes-sheet"))) return;
    const sheet = byTid(page, "quotes-sheet").first();
    if (!(await sheet.innerText()).includes("Quoted in this message")) fail(`the quotes sheet's title is not "Quoted in this message": ${J((await sheet.innerText()).slice(0, 80))}`);
    const cards = byTid(sheet, "quote-card");
    if (await cards.count() !== 2) fail(`the quotes sheet holds ${await cards.count()} cards, not 2`);
    else {
      if (!(await byTid(cards.nth(0), "quote-comment").count())) fail("the first quote has a comment and its card shows no comment field");
      if (!(await byTid(cards.nth(1), "quote-add-comment").count()) || !/Add a comment/.test(await byTid(cards.nth(1), "quote-add-comment").first().innerText())) fail("the quote with no comment has no \"+ Add a comment\"");
      for (let i = 0; i < 2; i++) {
        await target(`the trash of card ${i + 1}`, byTid(cards.nth(i), "quote-remove").first());
        if (!(await byTid(cards.nth(i), "quote-passage").first().innerText()).trim()) fail(`card ${i + 1} shows no passage`);
        if (!(await byTid(cards.nth(i), "quote-from").first().innerText()).trim()) fail(`card ${i + 1} does not say where the quote is from`);
      }
      await press(page, byTid(cards.nth(1), "quote-add-comment").first());
      if (!(await byTid(cards.nth(1), "quote-comment").first().waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("\"+ Add a comment\" did not turn into the comment field");
      await press(page, byTid(sheet, "quote-remove").first());
      if (!(await until(async () => (await byTid(sheet, "quote-card").count()) === 1, WAIT))) fail("the trash did not take the quote out of the sheet");
      await press(page, byTid(sheet, "quote-remove").first());
      await shows(page, "the last quote removed", "quotes-sheet", undefined, false); // (the sheet closes when no quote is left)
      await shows(page, "the last quote removed", "qcount", undefined, false);
    }
    note("the context row board, 2 quotes; the quotes sheet with its cards, comment field, 44 px trash; the last removal closes it");
  });
}, { viewports, page: false });
