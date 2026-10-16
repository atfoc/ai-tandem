// The bridge without React Native: the board view driven by the typed messages of @aiwb/board-bridge in Chromium, and what
// it answers checked. Two pages run the same checks:
//   1. the web view's page: dist-webview/board.html (one file) loaded from file://, spoken to as a web view speaks to it (a
//      `message` event with no source on `window`, or on `document`, as react-native-webview does on iOS and on Android) and
//      listened to as the app does (`window.ReactNativeWebView.postMessage(json)`), under the page's own CSP (by hash);
//   2. the web build's board: the web target (`node build.mjs web --out <tmp>/board`: board.js, board.css, fonts/) in a page
//      of its own that loads it as app/public/index.html does, under the Content-Security-Policy of the web build
//      (app/scripts/export-web.mjs): `window.aiwbBoardView.mount(element, post)`, objects in and out.
// The theme step differs by page on purpose: the phone's page draws the canvas filter as CSS functions and blend layers (src/phonetheme.ts),
// the web page as the SVG filter on the canvases (src/theme.ts); the pixel read back through the filter is the same on both.
// What the view tells (`changed`) is a delta: the checks keep a mirror of the board as the app does (load, then each `changed`
// through the bridge's `applyDelta`) and hold it equal to the view's own scene.
// Both pages also run `behaviours`: what an agent's change does (apply.ts: the clean look, upsert, ifVersion, atomic refusals, labels, arrows,
// cascade, focus, one undo step), the picture (stored colours, fonts), what a person draws (the clean style, undo, the menu without Open and
// Save, a dropped file). Usage: npm run build:webview && node dev/harness.mjs [--keep]   (--keep leaves the second page in a temp folder;
// ONLY=behaviours runs the web target and those steps alone, a few seconds, while one is being written)
// Needs Playwright (no dependency of the repository: `npm install --no-save playwright && npx playwright install chromium`
// in web/ as AGENTS.md says); found through PLAYWRIGHT=<dir of the playwright package>, node's own resolution, the web/
// of this checkout or of the main one, or the npx cache. No server is started and no network is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { csp as webBuildCsp } from "../../../app/scripts/export-web.mjs";
import { CHROME_VARS } from "@aiwb/board-bridge/chrome.ts";
import { applyDelta } from "@aiwb/board-bridge/delta.ts";
import { validateEngineValue, validateFromBoard, validateToBoard } from "@aiwb/board-bridge/validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
const dist = path.join(pkg, "dist-webview");
if (!fs.existsSync(path.join(dist, "board.html"))) { console.error("dist-webview/ is not built: run `npm run build:webview` first"); process.exit(2); }

// ---- Playwright

function findPlaywright() {
  const require = createRequire(import.meta.url);
  const dirs = [process.env.PLAYWRIGHT, path.join(pkg, "../../web/node_modules/playwright")].filter(Boolean);
  try { dirs.push(path.join(execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: pkg, encoding: "utf8" }).trim(), "../web/node_modules/playwright")); } catch { /* not a checkout */ }
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (fs.existsSync(npx)) dirs.push(...fs.readdirSync(npx).map((d) => path.join(npx, d, "node_modules/playwright")));
  try { return require("playwright"); } catch { /* try the folders */ }
  for (const d of dirs) if (fs.existsSync(path.join(d, "package.json"))) return require(d);
  throw new Error("playwright not found in:\n  " + dirs.join("\n  ") + "\nrun once: cd web && npm install --no-save playwright && npx playwright install chromium");
}

// ---- the samples

const filter = {
  id: "aiwb-canvas-test", matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
  tables: { r: Array.from({ length: 256 }, (_, i) => i / 255), g: Array.from({ length: 256 }, (_, i) => (i / 255) * 0.9), b: Array.from({ length: 256 }, (_, i) => (i / 255) * 0.8) },
};
const box = (id, x, y, w = 160, h = 80) => ({ id, type: "rectangle", x, y, width: w, height: h, version: 1 });

// ---- one page, spoken to by messages

class Page {
  constructor(page, name, send) { this.page = page; this.name = name; this._send = send; this.nextId = 1; this.seen = 0; this.loadAt = 0; this.loaded = null; }
  async out() { return this.page.evaluate(() => window.__out); }
  /** Sends the view a message (checked first: the harness only sends what the bridge allows). */
  async send(m) {
    const v = validateToBoard(m);
    assert.ok(v.ok, `the harness sent an invalid message: ${v.ok ? "" : v.error}`);
    if (m.t === "load") { this.loadAt = (await this.out()).length; this.loaded = m; }
    await this._send(m);
  }
  /** The board as the app keeps it: what `load` gave, then each `changed` of that board since (AD-50), the files added. */
  async mirror() {
    let elements = this.loaded.scene.elements.slice();
    const files = { ...this.loaded.scene.files };
    for (const m of (await this.out()).slice(this.loadAt)) {
      if (m.t !== "changed" || m.board !== this.loaded.board) continue;
      elements = applyDelta(elements, m);
      Object.assign(files, m.files);
    }
    return { elements, files };
  }
  /** The mirror equals the view's own scene (a snapshot asks for it, whole): the same elements in the same order, the same files. */
  async mirrorIsScene(what) {
    const { value } = await this.ok({ op: "snapshot" });
    const mine = await this.mirror();
    assert.deepEqual(mine.elements.map((e) => [e.id, e.version]), value.elements.map((e) => [e.id, e.version]), `${this.name}: ${what}: the mirror has the scene's elements, in its order`);
    assert.deepEqual(mine.elements, value.elements, `${this.name}: ${what}: the mirror's elements are the scene's`);
    assert.deepEqual(Object.keys(mine.files).sort(), Object.keys(value.files).sort(), `${this.name}: ${what}: the mirror has the scene's files`);
    return value;
  }
  /** Waits for a message that satisfies `want`, among those posted after `from` (default: all). */
  async until(want, what, { from = 0, timeout = 30000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const out = await this.out();
      const at = out.findIndex((m, i) => i >= from && want(m));
      if (at >= 0) return { m: out[at], at, out };
      if (Date.now() - t0 > timeout) throw new Error(`${this.name}: no ${what} within ${timeout} ms; got ${JSON.stringify(out.slice(from).map((m) => m.t + (m.id ? "#" + m.id : "")))}`);
      await this.page.waitForTimeout(40);
    }
  }
  /** A request, its reply, and the messages that came before the reply. */
  async req(op, { timeout } = {}) {
    const id = this.nextId++;
    const from = (await this.out()).length;
    await this.send({ t: "req", id, op });
    const { m, at, out } = await this.until((x) => x.t === "res" && x.id === id, `reply to ${op.op}`, { from, timeout });
    return { res: m, before: out.slice(from, at) };
  }
  async ok(op) {
    const { res, before } = await this.req(op);
    assert.equal(res.ok, true, `${this.name}: ${op.op} failed: ${res.code} ${res.message}`);
    const v = validateEngineValue(op.op, res.value);
    assert.ok(v.ok, `${this.name}: the value of ${op.op} is not valid: ${v.ok ? "" : v.error}`);
    return { value: res.value, before };
  }
  async fails(op, code) {
    const { res } = await this.req(op);
    assert.equal(res.ok, false, `${this.name}: ${op.op} should have failed with ${code}`);
    assert.equal(res.code, code, `${this.name}: ${op.op} failed with ${res.code}: ${res.message}`);
    return res;
  }
  async mark() { return (await this.out()).length; }
}

/** The colour of the page at a pixel, from a screenshot of that pixel alone (a PNG of one pixel: one scanline). */
async function pixel(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const idat = []; let at = 8, channels = 3;
  while (at < png.length) {
    const n = png.readUInt32BE(at), type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") channels = png[at + 8 + 9] === 6 ? 4 : 3;
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  assert.ok(raw[0] <= 4, "a scanline filter"); // (a pixel with no neighbour is its own value under every filter)
  return [raw[1], raw[2], raw[3]];
}
const near = (got, want, what) => assert.ok(got.every((v, i) => Math.abs(v - want[i]) <= 3), `${what}: ${got} is not ${want}`);

const pngSize = (b64) => { const b = Buffer.from(b64, "base64"); assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG"); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length }; };

// ---- the checks (same on both pages)

async function checks(p, ctx) {
  const t = (name) => console.log(`  ${p.name}: ${name}`);

  // ready, then the app sends theme and load
  const ready = await p.until((m) => m.t === "ready", "ready");
  assert.match(ready.m.version, /./);
  t(`ready (${ready.m.version})`);
  await p.send({ t: "theme", theme: { mode: "dark", filter } });
  if (only) { await behaviours(p, ctx); return; }

  // restore: the scene the app keeps is the one Excalidraw restores
  const restored = (await p.ok({ op: "restore", elements: [box("r1", 40, 40), box("r2", 300, 160), box("r3", 40, 260, 100, 100), { garbage: true }] })).value.elements;
  assert.deepEqual(restored.map((e) => e.id), ["r1", "r2", "r3"], "restore keeps the elements it can restore");
  assert.equal(restored[0].strokeColor, "#1e1e1e", "restore fills in the defaults");
  t("restore");

  // load: view, then loaded; nothing is `changed` by loading
  let mark = await p.mark();
  const style = { currentItemStrokeColor: "#e03131" };
  await p.send({ t: "load", board: "b1", viewMode: false, theme: { mode: "dark", filter }, style, scene: { elements: restored, files: {}, appState: { scrollX: 10, scrollY: 20, zoom: { value: 1 }, viewBackgroundColor: "#ffffff" } } });
  const loaded = await p.until((m) => m.t === "loaded", "loaded", { from: mark });
  assert.equal(loaded.m.board, "b1");
  const afterLoad = loaded.out.slice(mark);
  const view = afterLoad.find((m) => m.t === "view");
  assert.ok(view, "a `view` before `loaded`");
  assert.equal(view.board, "b1"); assert.equal(view.scrollX, 10); assert.equal(view.scrollY, 20); assert.equal(view.zoom, 1);
  assert.ok(view.width > 500 && view.height > 300, `the view has the size of the page (${view.width}x${view.height})`);
  assert.ok(afterLoad.findIndex((m) => m.t === "view") < afterLoad.findIndex((m) => m.t === "loaded"), "view comes before loaded");
  await p.page.waitForTimeout(600);
  assert.equal((await p.out()).slice(mark).filter((m) => m.t === "changed").length, 0, "loading a board changes nothing");
  t("load: view, loaded, no change");

  // theme: the filter is in the document, --theme-filter points at it, and plain light has none of ours
  const themed = () => p.page.evaluate(() => {
    const ex = document.querySelector(".excalidraw");
    const layers = [...document.querySelectorAll(".aiwb-board > .aiwb-canvas-layer")].map((d) => ({ blend: getComputedStyle(d).mixBlendMode, ariaHidden: d.getAttribute("aria-hidden"), after: !!(ex.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) }));
    return { filter: !!document.getElementById("aiwb-canvas-test"), tf: ex && getComputedStyle(ex).getPropertyValue("--theme-filter").trim(), canvas: ex && getComputedStyle(ex.querySelector("canvas")).filter, layers };
  });
  // (the phone's page draws the filter as CSS functions and blend layers, the web page as the SVG filter: phonetheme.ts)
  const phone = p.name === "webview";
  await p.page.waitForTimeout(150);
  if (process.env.SHOT) await p.page.screenshot({ path: process.env.SHOT });
  near(await pixel(p.page, 700, 500), [255, 230, 204], "the empty canvas seen through the filter (white: 1, 0.9, 0.8)");
  let th = await themed();
  assert.equal(th.filter, true, "the filter is in the document");
  assert.equal(th.tf, "url(#aiwb-canvas-test)", "--theme-filter is the filter");
  if (phone) {
    // the harness filter is the identity matrix and tables 1, 0.9, 0.8: no CSS stage, one multiply layer (1, 0.9, 0.8)
    assert.equal(th.canvas, "none", "the canvas wears the stage (none for the identity), not the SVG filter");
    assert.deepEqual(th.layers.map((l) => [l.blend, l.ariaHidden, l.after]), [["multiply", "true", true]], "one multiply layer after Excalidraw");
  } else {
    assert.match(th.canvas, /url\(.*aiwb-canvas-test/, "the canvas wears it");
    assert.deepEqual(th.layers, [], "no layers on the web page");
  }
  await p.send({ t: "theme", theme: { mode: "light", filter: null } });
  await p.page.waitForTimeout(150);
  th = await themed();
  assert.equal(th.filter, false, "no filter, no <filter>");
  assert.equal(th.tf, "none", "plain light: no --theme-filter");
  assert.equal(th.canvas, "none");
  assert.deepEqual(th.layers, [], "plain light: no layers");
  near(await pixel(p.page, 700, 500), [255, 255, 255], "plain light shows the stored white");
  await p.send({ t: "theme", theme: { mode: "dark", filter } });
  await p.page.waitForTimeout(150);
  th = await themed();
  assert.equal(th.tf, "url(#aiwb-canvas-test)");
  assert.equal(th.layers.length, phone ? 1 : 0, "the layers are back with the filter");
  near(await pixel(p.page, 700, 500), [255, 230, 204], "and the empty canvas seen through the filter again");
  t(`theme: filter${phone ? " (stage and layers)" : ""}, none, filter`);

  // chrome: a flavour's colours reach Excalidraw's own toolbar, panels and shortcuts, and are gone with the map
  const chrome = Object.fromEntries(CHROME_VARS.map((n) => [n, "#336699"]));
  Object.assign(chrome, { "--island-bg-color": "#1e1e2e", "--popup-text-color": "#cdd6f4", "--color-gray-40": "#bac2de", "--aiwb-line": "#313244", "--color-primary": "#cba6f7" });
  const chromed = () => p.page.evaluate(() => {
    const ex = document.querySelector(".excalidraw"), bar = ex.querySelector(".App-toolbar"), zoom = ex.querySelector(".zoom-actions");
    return { island: getComputedStyle(ex).getPropertyValue("--island-bg-color").trim(), grey: getComputedStyle(ex).getPropertyValue("--color-gray-40").trim(),
      bar: getComputedStyle(bar).backgroundColor, zoom: zoom && getComputedStyle(zoom).boxShadow, shadow: getComputedStyle(ex).getPropertyValue("--shadow-island") };
  });
  await p.send({ t: "theme", theme: { mode: "dark", filter, chrome } });
  await p.page.waitForTimeout(150);
  let ch = await chromed();
  assert.equal(ch.island, "#1e1e2e", "the chrome's island colour is the flavour's");
  assert.equal(ch.grey, "#bac2de", "a grey of the dark theme is the flavour's (over Excalidraw's .theme--dark)");
  assert.equal(ch.bar, "rgb(30, 30, 46)", "the toolbar is drawn in it");
  assert.match(ch.shadow, /^0 0 0 1px #313244,/, "the island's shadow is the ring of the line");
  assert.match(ch.zoom, /rgb\(49, 50, 68\) 0px 0px 0px 1px/, "the zoom buttons' ring is the flavour's line");
  assert.equal((await themed()).tf, "url(#aiwb-canvas-test)", "the filter is as it was");
  await p.send({ t: "theme", theme: { mode: "dark", filter, chrome: null } });
  await p.page.waitForTimeout(150);
  ch = await chromed();
  assert.notEqual(ch.island, "#1e1e2e", "no map: the chrome is Excalidraw's own");
  assert.notEqual(ch.bar, "rgb(30, 30, 46)");
  await p.send({ t: "theme", theme: { mode: "dark", filter } });
  await p.page.waitForTimeout(150);
  t("theme: the chrome of a flavour, and without it");

  // apply on the live scene: `changed` goes out before the reply, the reply is applyChanges' own
  const rev = 7;
  const applied = await p.ok({ op: "apply", target: "live", rev, params: {
    create: [{ type: "rectangle", key: "a", x: 500, y: 40, width: 160, height: 80, label: { text: "Added" } }, { type: "arrow", start: { key: "a" }, end: { id: "r1" } }],
    update: [{ ref: { id: "r2" }, backgroundColor: "#a5d8ff" }],
    select: [{ key: "a" }],
  } });
  assert.equal(applied.value.rev, rev, "rev is the request's");
  assert.ok(applied.value.created.a, "the key `a` was given an id");
  assert.ok(applied.value.updated.includes("r2"), "updated");
  assert.equal(applied.value.elements, undefined, "a live apply returns no elements: `changed` tells them");
  const changed = applied.before.filter((m) => m.t === "changed");
  assert.equal(changed.length, 1, "exactly one `changed` before the reply");
  assert.equal(changed[0].board, "b1");
  const aId = applied.value.created.a;
  assert.ok(changed[0].elements.some((e) => e.id === aId && !e.isDeleted), "`changed` has the new rectangle");
  assert.ok(changed[0].elements.some((e) => e.id === "r2" && e.backgroundColor === "#a5d8ff"), "and the update");
  assert.ok(changed[0].elements.some((e) => e.type === "text" && e.containerId === aId), "and the label");
  assert.ok(!changed[0].elements.some((e) => e.id === "r3"), "`changed` is a delta: r3 was not touched and is not in it");
  assert.ok(Array.isArray(changed[0].order) && changed[0].order.includes(aId) && changed[0].order.length === 6, "new ids: `order` names every element, in scene order");
  assert.equal(changed[0].files, undefined, "files are not told when they did not change");
  assert.equal(changed[0].appState.scrollX, 10, "appState carries the view");
  assert.equal(changed[0].style.currentItemStrokeColor, "#e03131", "the style the app gave is the style the board draws with");
  assert.equal(changed[0].style.currentItemRoughness, 0, "and the clean look is the rest of it");
  await p.mirrorIsScene("after an apply");
  t("apply live: a delta before the reply, the mirror is the scene");

  // the selection that apply asked for is told
  const sel = await p.until((m) => m.t === "selection" && m.ids.length === 1 && m.ids[0] === aId, "selection of the new rectangle");
  assert.equal(sel.m.board, "b1");
  t("selection after apply");

  // apply on given elements: the live scene is not touched, the reply carries the scene
  mark = await p.mark();
  const given = await p.ok({ op: "apply", target: { elements: restored }, rev: 1, params: { create: [{ type: "rectangle", key: "z", x: 0, y: 500, width: 50, height: 50 }], delete: [{ ref: { id: "r3" } }] } });
  assert.ok(Array.isArray(given.value.elements) && given.value.elements.some((e) => e.id === given.value.created.z) && given.value.elements.find((e) => e.id === "r3").isDeleted, "the scene comes back");
  await p.page.waitForTimeout(500);
  assert.equal((await p.out()).slice(mark).filter((m) => m.t === "changed").length, 0, "a scene that is not on screen leaves the live scene alone");
  t("apply on given elements");

  // errors: a ref that is not there, no board
  const bad = await p.fails({ op: "apply", target: "live", rev: 1, params: { update: [{ ref: { key: "nope" }, x: 1 }] } }, "BAD_REF");
  assert.match(bad.message, /no live element/);
  t("apply error: BAD_REF");

  // export: the whole scene, some of it, a scale, the limits
  const all = (await p.ok({ op: "export", target: "live", ids: [], scale: 1, background: true })).value;
  const size = pngSize(all.png);
  assert.deepEqual([all.width, all.height], [size.width, size.height], "the PNG has the size it says");
  assert.equal(all.count, 5, "r1, r2, r3, the new rectangle and the arrow; the label is counted with its rectangle");
  assert.ok(all.bounds.x <= 40 && all.bounds.y <= 40 && all.bounds.x + all.bounds.width >= 660, `the bounds hold the elements (${JSON.stringify(all.bounds)})`);
  assert.equal(all.width, Math.ceil(all.bounds.width + 32) , "width = bounds + padding on both sides, rounded up");
  const some = (await p.ok({ op: "export", target: "live", ids: ["r1"], scale: 2, background: false })).value;
  assert.equal(some.count, 1);
  assert.deepEqual(some.bounds, { x: 40, y: 40, width: 160, height: 80 }, "the bounds of one rectangle are its own");
  assert.deepEqual([some.width, some.height], [Math.ceil((160 + 32) * 2), Math.ceil((80 + 32) * 2)], "scale 2");
  assert.deepEqual([pngSize(some.png).width, pngSize(some.png).height], [some.width, some.height]);
  const label = (await p.ok({ op: "export", target: "live", ids: [aId], scale: 1, background: true })).value;
  assert.equal(label.count, 1, "a container and its bound text count once");
  await p.fails({ op: "export", target: "live", ids: ["nope"], scale: 1, background: true }, "EMPTY");
  const huge = await p.fails({ op: "export", target: "live", ids: [], scale: 20, background: true }, "TOO_LARGE");
  assert.match(huge.message, /limit is 8192 px/);
  await p.fails({ op: "export", target: "live", ids: [], scale: 0.001, background: true }, "BAD_ARGS");
  // an export of given elements, not on screen
  const given2 = (await p.ok({ op: "export", target: { elements: restored, files: {}, appState: {} }, ids: ["r3"], scale: 1, background: true })).value;
  assert.deepEqual(given2.bounds, { x: 40, y: 260, width: 100, height: 100 });
  t(`export: ${all.width}x${all.height}, ids, scale, EMPTY, TOO_LARGE, BAD_ARGS, given elements`);
  ctx.png ??= all.png;

  // a text in the hand-drawn font: the font comes from fonts/ next to the page, and the picture is drawn with it
  const hand = (await p.ok({ op: "apply", target: "live", rev: 8, params: { create: [{ type: "text", key: "hand", x: 400, y: 400, text: "Hello", fontFamily: "hand" }] } })).value;
  const handPicture = (await p.ok({ op: "export", target: "live", ids: [hand.created.hand], scale: 1, background: true })).value;
  assert.ok(handPicture.width > 32 && handPicture.height > 32 && handPicture.count === 1);
  await p.ok({ op: "delete", target: "live", refs: [{ id: hand.created.hand }], cascade: false, rev: 9 });
  t("text in the hand-drawn font");

  // delete: cascade takes the arrow and its label, and the reply comes after `changed`
  const del = await p.ok({ op: "delete", target: "live", refs: [{ id: "r1" }], cascade: true, rev: 10 });
  assert.equal(del.value.rev, 10);
  assert.ok(del.value.deleted.includes("r1") && del.value.deleted.length >= 2, `r1 and its arrow are deleted (${del.value.deleted})`);
  const afterDel = del.before.filter((m) => m.t === "changed");
  assert.equal(afterDel.length, 1, "`changed` before the delete's reply");
  assert.ok(afterDel[0].elements.find((e) => e.id === "r1").isDeleted, "deleted elements are in `changed` (marked)");
  assert.equal(afterDel[0].order, undefined, "Excalidraw keeps a deleted element: the ids did not change, so no `order`");
  await p.mirrorIsScene("after a delete");
  t("delete cascade: a delta with the deleted elements marked, the mirror is the scene");

  // snapshot: the live scene at once, a pending change goes first
  const snap = await p.ok({ op: "snapshot" });
  assert.equal(snap.value.board, "b1");
  assert.ok(snap.value.elements.find((e) => e.id === "r1").isDeleted);
  assert.equal(snap.value.appState.zoom.value, 1);
  assert.equal(snap.value.style.currentItemStrokeColor, "#e03131");
  t("snapshot");

  // a drawing by the user: a rectangle with the mouse is told, within a quarter of a second plus the slack of a slow machine
  mark = await p.mark();
  await p.send({ t: "viewMode", on: false });
  const pos = await p.page.evaluate(() => { const r = document.querySelector("canvas.interactive").getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await p.page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await p.page.mouse.move(pos.x + 300, pos.y + 420);
  await p.page.mouse.down();
  await p.page.mouse.move(pos.x + 380, pos.y + 470, { steps: 6 });
  await p.page.mouse.up();
  const drawn = await p.until((m) => m.t === "changed" && m.elements.some((e) => !snap.value.elements.some((s) => s.id === e.id)), "`changed` for the user's rectangle", { from: mark });
  const mine = drawn.m.elements.find((e) => !snap.value.elements.some((s) => s.id === e.id));
  assert.ok(drawn.m.elements.length <= 2, `the delta holds the new rectangle (and at most the one it was drawn over), not the scene (${drawn.m.elements.length} elements)`);
  assert.ok(drawn.m.order.includes(mine.id), "and `order` names it");
  assert.equal(mine.type, "rectangle");
  assert.equal(mine.strokeColor, "#e03131", "the user's rectangle has the style the app gave");
  assert.equal(mine.roughness, 0);
  await p.until((m) => m.t === "selection" && m.ids.includes(mine.id), "the new rectangle selected", { from: mark });
  await p.mirrorIsScene("after the user draws");
  t("user draws a rectangle: a delta, selection, the mirror is the scene");

  // view mode: the pointer draws nothing
  mark = await p.mark();
  await p.send({ t: "viewMode", on: true });
  await p.page.waitForTimeout(150);
  await p.page.locator('[data-testid="toolbar-rectangle"]').click({ force: true }).catch(() => {}); // (view mode hides the toolbar)
  await p.page.mouse.move(pos.x + 500, pos.y + 420);
  await p.page.mouse.down();
  await p.page.mouse.move(pos.x + 560, pos.y + 480, { steps: 6 });
  await p.page.mouse.up();
  await p.page.waitForTimeout(700);
  assert.equal((await p.out()).slice(mark).filter((m) => m.t === "changed").length, 0, "view mode: no drawing");
  await p.send({ t: "viewMode", on: false });
  t("view mode");

  // select and scrollTo
  mark = await p.mark();
  await p.send({ t: "select", ids: ["r2", "r3"] });
  const picked = await p.until((m) => m.t === "selection" && m.ids.length === 2, "selection of two", { from: mark });
  assert.deepEqual([...picked.m.ids].sort(), ["r2", "r3"]);
  await p.send({ t: "scrollTo", ids: ["r3"], animate: false });
  const scrolled = await p.until((m) => m.t === "view" && m.scrollX !== 10, "view after scrollTo", { from: mark });
  assert.equal(scrolled.m.board, "b1");
  t("select, scrollTo");

  // a message the bridge does not allow is refused; a request is still answered
  mark = await p.mark();
  await p.page.evaluate(() => window.__sendRaw({ t: "req", id: 99, op: { op: "eval", code: "1" } }));
  const refused = await p.until((m) => m.t === "res" && m.id === 99, "reply to the refused request", { from: mark });
  assert.equal(refused.m.ok, false); assert.equal(refused.m.code, "BAD_MESSAGE");
  await p.page.evaluate(() => window.__sendRaw({ t: "fetch", url: "https://example.com" }));
  await p.page.waitForTimeout(100);
  t("refused messages");

  // a second board replaces the first, and what the first had not told goes first
  mark = await p.mark();
  await p.send({ t: "load", board: "b2", viewMode: false, theme: { mode: "light", filter: null }, style: {}, scene: { elements: [], files: {}, appState: {} } });
  const l2 = await p.until((m) => m.t === "loaded" && m.board === "b2", "loaded b2 (an empty board)", { from: mark });
  const second = (await p.ok({ op: "snapshot" })).value;
  assert.equal(second.board, "b2"); assert.deepEqual(second.elements, []);
  assert.equal(second.style.currentItemStrokeColor, "#1e1e1e", "a board loaded without a style draws in the clean default, not in the last board's red");
  assert.equal(l2.out.slice(mark).filter((m) => m.t === "changed" && m.board === "b2").length, 0);
  t("second board (empty)");

  await behaviours(p, ctx);

  // a big board: one rectangle added is a delta of one element and the order, not the scene; a picture the board came with is not told again
  const bigScene = Array.from({ length: 1500 }, (_, i) => ({ ...box(`g${i}`, (i % 50) * 30, Math.floor(i / 50) * 30, 20, 20), version: 1 + (i % 3) }));
  const bigRestored = (await p.ok({ op: "restore", elements: bigScene })).value.elements;
  const pic = { f0: { id: "f0", mimeType: "image/png", created: 1, dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==" } };
  const image = { ...box("pic", 5000, 0, 40, 40), type: "image", fileId: "f0", status: "saved", scale: [1, 1], crop: null };
  mark = await p.mark();
  await p.send({ t: "load", board: "b3", viewMode: false, theme: { mode: "light", filter: null }, style: {}, scene: { elements: [...bigRestored, image], files: pic, appState: {} } });
  await p.until((m) => m.t === "loaded" && m.board === "b3", "loaded b3 (1501 elements)", { from: mark, timeout: 60000 });
  await p.page.waitForTimeout(700);
  // (Excalidraw counts a picture it has just drawn from its file a change of that element: version 1 to 2, and nothing else)
  const bigLoad = (await p.out()).slice(mark).filter((m) => m.t === "changed");
  assert.ok(bigLoad.every((m) => m.elements.length === 1 && m.elements[0].id === "pic" && m.order === undefined && m.files === undefined),
    `loading 1501 elements and a picture changes nothing but the picture's own version: ${JSON.stringify(bigLoad.map((m) => m.elements.map((e) => e.id)))}`);
  const whole = JSON.stringify({ elements: (await p.ok({ op: "snapshot" })).value.elements }).length;
  mark = await p.mark();
  const big = await p.ok({ op: "apply", target: "live", rev: 11, params: { create: [{ type: "rectangle", key: "one", x: 0, y: 2000, width: 40, height: 40 }] } });
  const bigChanged = big.before.filter((m) => m.t === "changed");
  assert.equal(bigChanged.length, 1);
  assert.deepEqual(bigChanged[0].elements.map((e) => e.id), [big.value.created.one], "one element in the delta");
  assert.equal(bigChanged[0].order.length, 1502, "and the order of the 1502 ids");
  assert.equal(bigChanged[0].files, undefined, "the picture the board came with is not told again");
  const deltaSize = JSON.stringify(bigChanged[0]).length;
  assert.ok(deltaSize < whole / 10, `the delta (${deltaSize} bytes) is a fraction of the scene (${whole} bytes)`);
  await p.mirrorIsScene("on the big board");
  t(`big board: one rectangle is ${deltaSize} bytes of ${whole}`);

  // unload: nothing is shown, the view still answers what needs no board
  await p.send({ t: "unload" });
  await p.page.waitForTimeout(100);
  await p.fails({ op: "snapshot" }, "NO_BOARD");
  await p.fails({ op: "apply", target: "live", rev: 1, params: {} }, "NO_BOARD");
  assert.equal((await p.ok({ op: "restore", elements: [box("q", 0, 0)] })).value.elements.length, 1);
  t("unload: NO_BOARD");

  // every message the view posted is one the bridge allows
  for (const m of await p.out()) { const v = validateFromBoard(m); assert.ok(v.ok, `${p.name}: the view posted an invalid message: ${v.ok ? "" : v.error} ${JSON.stringify(m).slice(0, 200)}`); }
  t(`all ${(await p.out()).length} messages are valid`);
}

// ---- what the board does when an agent changes it and when a person draws on it (rows D-BD, D-AG, D-EX and D-CT of area D of the
// parity inventory), on boards of its own: nothing here depends on the steps before it but the page being up.
async function behaviours(p, ctx) {
  const t = (name) => console.log(`  ${p.name}: ${name}`);
  let rev = 200;
  const snap = async () => (await p.ok({ op: "snapshot" })).value;
  const byKey = (s, k) => s.elements.find((e) => !e.isDeleted && e.customData?.key === k);
  const boundText = (s, e) => s.elements.find((x) => !x.isDeleted && x.containerId === e.id);
  const apply = (params) => p.ok({ op: "apply", target: "live", rev: ++rev, params });
  const applyFails = (params, code) => p.fails({ op: "apply", target: "live", rev: ++rev, params }, code);
  const board = async (id, theme = { mode: "light", filter: null }) => {
    const mark = await p.mark();
    await p.send({ t: "load", board: id, viewMode: false, theme, style: {}, scene: { elements: [], files: {}, appState: {} } });
    await p.until((m) => m.t === "loaded" && m.board === id, `loaded ${id}`, { from: mark });
  };
  const centre = (e) => [e.x + e.width / 2, e.y + e.height / 2];
  const within = (a, b, tol, what) => assert.ok(Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol, `${what}: ${a.map(Math.round)} is not ${b.map(Math.round)}`);
  const ends = (a) => [[a.x, a.y], [a.x + a.points.at(-1)[0], a.y + a.points.at(-1)[1]]];
  const gapTo = (pt, b) => Math.hypot(Math.max(b.x - pt[0], 0, pt[0] - (b.x + b.width)), Math.max(b.y - pt[1], 0, pt[1] - (b.y + b.height)));
  const FONT = { hand: 5, normal: 6, code: 8 }; // Excalidraw's FONT_FAMILY: Excalifont, Nunito, Comic Shanns
  const ROUND = 3;                              // ROUNDNESS.ADAPTIVE_RADIUS

  // ---- shapes an agent makes start clean, unless it asks for another look; an update never gets the defaults (D-AG-02)
  await board("b4");
  await apply({ create: [
    { type: "rectangle", key: "clean", x: 0, y: 0, width: 200, height: 100, label: "Clean" },
    { type: "ellipse", key: "oval", x: 300, y: 0, width: 100, height: 60 },
    { type: "text", key: "plain", x: 0, y: 200, text: "plain" },
    { type: "rectangle", key: "round", x: 500, y: 0, width: 160, height: 80, roundness: "round", roughness: "artist", fontFamily: "code", label: "Code" },
    { type: "text", key: "hand", x: 0, y: 300, text: "hand", fontFamily: "hand" },
    { type: "rectangle", key: "toon", x: 500, y: 200, width: 160, height: 80, roughness: "cartoonist", roundness: "sharp" },
  ] });
  let s = await snap();
  const clean = byKey(s, "clean"), oval = byKey(s, "oval"), plain = byKey(s, "plain"), round = byKey(s, "round");
  assert.deepEqual([clean.roughness, clean.roundness], [0, null], "a rectangle starts architect-clean, with sharp corners");
  assert.equal(boundText(s, clean).fontFamily, FONT.normal, "its label is in the normal font");
  assert.deepEqual([oval.roughness, oval.roundness], [0, null]);
  assert.deepEqual([plain.roughness, plain.fontFamily], [0, FONT.normal], "a text is in the normal font");
  assert.equal(byKey(s, "hand").fontFamily, FONT.hand, "fontFamily hand");
  assert.deepEqual([round.roughness, round.roundness?.type], [1, ROUND], "roughness artist, roundness round");
  assert.equal(boundText(s, round).fontFamily, FONT.code, "a font asked of the container is its label's");
  assert.equal(byKey(s, "toon").roughness, 2, "roughness cartoonist");
  assert.equal(byKey(s, "toon").roundness, null, "roundness sharp");
  await apply({ update: [{ ref: { key: "round" }, backgroundColor: "#ffc9c9" }, { ref: { key: "clean" }, x: 20 }] });
  s = await snap();
  assert.deepEqual([byKey(s, "round").roughness, byKey(s, "round").roundness?.type], [1, ROUND], "an update that names no style leaves the look as it is");
  await apply({ update: [{ ref: { key: "clean" }, roundness: "round", roughness: "cartoonist" }] });
  s = await snap();
  assert.deepEqual([byKey(s, "clean").roughness, byKey(s, "clean").roundness?.type], [2, ROUND], "an update that names a look sets it");
  t("agent-made shapes: clean by default, the look asked for, an update leaves the look");

  // ---- a create with a key that exists updates it; a key of another type is refused (D-AG-04)
  const cleanId = byKey(s, "clean").id, before = liveCount(s);
  const upsert = await apply({ create: [{ type: "rectangle", key: "clean", x: 300, y: 300 }] });
  assert.deepEqual(upsert.value.created, {}, "nothing is made");
  assert.deepEqual(upsert.value.updated, [cleanId], "the element that has the key is updated");
  s = await snap();
  assert.equal(liveCount(s), before, "no element was added");
  assert.deepEqual([byKey(s, "clean").x, byKey(s, "clean").y], [300, 300]);
  const wrongType = await applyFails({ create: [{ type: "ellipse", key: "clean", x: 0, y: 0 }, { type: "rectangle", key: "fresh" }] }, "BAD_PARAMS");
  assert.match(wrongType.message, /key clean is a rectangle, not a ellipse/);
  s = await snap();
  assert.equal(byKey(s, "fresh"), undefined, "the refused call made nothing of the rest");
  function liveCount(sc) { return sc.elements.filter((e) => !e.isDeleted).length; }
  t("upsert by key; a key of another type is BAD_PARAMS");

  // ---- a change that names a version that is not the current one is not applied, and is told as a conflict (D-AG-06)
  const v0 = byKey(s, "clean").version;
  const stale = await apply({ update: [{ ref: { key: "clean" }, x: 999, ifVersion: v0 - 1 }], delete: [{ ref: { key: "oval" }, ifVersion: 1 }] });
  assert.deepEqual(stale.value.conflicts, [
    { ref: { key: "clean" }, expectedVersion: v0 - 1, actualVersion: v0 },
    { ref: { key: "oval" }, expectedVersion: 1, actualVersion: byKey(s, "oval").version },
  ], "each stale change is a conflict, with the version it expected and the one there is");
  assert.deepEqual([stale.value.updated, stale.value.deleted], [[], []]);
  s = await snap();
  assert.equal(byKey(s, "clean").x, 300, "the stale update changed nothing");
  assert.ok(byKey(s, "oval"), "and the stale delete deleted nothing");
  const current = await apply({ update: [{ ref: { key: "clean" }, x: 999, ifVersion: v0 }] });
  assert.deepEqual(current.value.conflicts, []);
  assert.equal(byKey(await snap(), "clean").x, 999, "the version that is current goes through");
  t("ifVersion: a stale change is a conflict and applies nothing");

  // ---- a bad call applies nothing of the rest: everything is checked first (D-AG-07)
  s = await snap();
  const bad = [
    [{ create: [{ type: "rectangle", key: "atom" }], update: [{ ref: { key: "clean" }, x: 5000 }], delete: [{ ref: { key: "nope" } }] }, "BAD_REF"],
    [{ create: [{ type: "rectangle", key: "atom" }], update: [{ ref: { key: "clean" }, x: 5000 }, { ref: { key: "round" }, moveBy: [1, 1], y: 4 }] }, "BAD_PARAMS"],
    [{ update: [{ ref: { key: "round" }, x: 7 }, { ref: "round", y: 1 }] }, "BAD_REF"],
  ];
  for (const [params, code] of bad) {
    await applyFails(params, code);
    const after = await snap();
    assert.deepEqual(after.elements, s.elements, `a ${code} call changed nothing: not the elements it could do, not the ones that came first`);
  }
  t("a call refused for BAD_REF or BAD_PARAMS applies nothing");

  // ---- a label is centred in its shape and measured; an arrow runs edge to edge and follows a shape that moves (D-AG-03, D-AG-05)
  await apply({ create: [
    { type: "rectangle", key: "A", x: 0, y: 700, width: 200, height: 100, label: "Centred" },
    { type: "rectangle", key: "B", x: 500, y: 700, width: 200, height: 100 },
    { type: "arrow", key: "AB", start: { key: "A" }, end: { key: "B" }, label: "to B" },
    { type: "rectangle", key: "small", x: 900, y: 700, width: 60, height: 30, label: "ok" },
  ] });
  s = await snap();
  let A = byKey(s, "A"), B = byKey(s, "B"), AB = byKey(s, "AB");
  const labelA = boundText(s, A);
  assert.ok(labelA.width > 10 && labelA.height > 10, "the label was measured");
  within(centre(labelA), centre(A), 2, "the label is centred in its shape");
  assert.deepEqual([AB.startBinding?.elementId, AB.endBinding?.elementId], [A.id, B.id], "the arrow is bound to both shapes");
  const routed = (arrow, a, b, what) => {
    const [from, to] = ends(arrow);
    assert.ok(Math.abs(gapTo(from, a) - 6) <= 1.5, `${what}: the arrow starts 6 px from its first shape (${gapTo(from, a).toFixed(1)})`);
    assert.ok(Math.abs(gapTo(to, b) - 6) <= 1.5, `${what}: and ends 6 px from its second (${gapTo(to, b).toFixed(1)})`);
    assert.equal(arrow.points.length, 2, `${what}: a straight route`);
  };
  routed(AB, A, B, "edge to edge");
  const labelAB = () => boundText(s, byKey(s, "AB"));
  const midOf = (arrow) => { const [f, t] = ends(arrow); return [(f[0] + t[0]) / 2, (f[1] + t[1]) / 2]; };
  within(centre(labelAB()), midOf(AB), 3, "the arrow's label sits on its middle");
  const arrowBefore = { x: AB.x, y: AB.y };
  const textBefore = [labelA.x, labelA.y];
  await apply({ update: [{ ref: { key: "A" }, moveBy: [0, 150] }] }); // (D-AG-05: a bound text follows its container, the arrows follow)
  s = await snap();
  A = byKey(s, "A"); AB = byKey(s, "AB");
  assert.equal(A.y, 850);
  assert.deepEqual([boundText(s, A).x - textBefore[0], boundText(s, A).y - textBefore[1]], [0, 150], "the bound text moved with its shape");
  assert.notEqual(AB.y, arrowBefore.y, "the arrow was routed again");
  routed(AB, A, byKey(s, "B"), "after the shape moved");
  within(centre(labelAB()), midOf(AB), 3, "the arrow's label followed");
  await apply({ update: [{ ref: { key: "A" }, width: 320, height: 140 }] }); // resized: its label is centred again, the arrow meets the new edge
  s = await snap();
  A = byKey(s, "A"); AB = byKey(s, "AB");
  assert.deepEqual([A.width, A.height], [320, 140]);
  within(centre(boundText(s, A)), centre(A), 2, "the label is centred in the resized shape");
  routed(AB, A, byKey(s, "B"), "after the shape was resized");
  await apply({ update: [{ ref: { key: "plain" }, text: "a much longer line of text than before" }] });
  s = await snap();
  const longer = byKey(s, "plain");
  assert.equal(longer.text, "a much longer line of text than before");
  assert.equal(longer.originalText, "a much longer line of text than before");
  assert.ok(longer.width > plain.width * 3, `a text is measured again (${plain.width} to ${longer.width})`);
  const small = byKey(s, "small");
  await apply({ update: [{ ref: { key: "small" }, label: "This label is much too long for a box of sixty by thirty" }] });
  s = await snap();
  const grown = byKey(s, "small"), grownLabel = boundText(s, grown);
  assert.ok(grown.width > small.width || grown.height > small.height, `a longer label makes its shape grow (${small.width}x${small.height} to ${grown.width}x${grown.height})`);
  assert.ok(grownLabel.x >= grown.x - 1 && grownLabel.y >= grown.y - 1 && grownLabel.x + grownLabel.width <= grown.x + grown.width + 1 && grownLabel.y + grownLabel.height <= grown.y + grown.height + 1, "and holds it");
  t("labels centred and measured; an arrow edge to edge, following a shape moved or resized; a text measured again; a shape grown by its label");

  // ---- delete without cascade lets the arrows go free; a deleted frame frees its children (D-AG-11)
  const del = await p.ok({ op: "delete", target: "live", refs: [{ key: "A" }], cascade: false, rev: ++rev });
  assert.ok(del.value.deleted.includes(A.id) && !del.value.deleted.includes(AB.id), "only the shape is deleted");
  s = await snap();
  assert.equal(s.elements.find((e) => e.id === A.id).isDeleted, true);
  assert.equal(s.elements.find((e) => e.id === labelA.id).isDeleted, true, "its label goes with it");
  assert.ok(byKey(s, "AB"), "the arrow stays");
  assert.deepEqual([byKey(s, "AB").startBinding, byKey(s, "AB").endBinding?.elementId], [null, B.id], "unbound from the deleted shape, still bound to the other");
  await apply({ create: [
    { type: "rectangle", key: "kid", x: 1200, y: 700, width: 80, height: 40 },
    { type: "frame", key: "box", x: 1180, y: 680, width: 200, height: 160, children: [{ key: "kid" }] },
  ] });
  s = await snap();
  assert.equal(byKey(s, "kid").frameId, byKey(s, "box").id, "the frame holds its child");
  await p.ok({ op: "delete", target: "live", refs: [{ key: "box" }], cascade: false, rev: ++rev });
  s = await snap();
  assert.equal(byKey(s, "box"), undefined);
  assert.ok(byKey(s, "kid") && byKey(s, "kid").frameId === null, "the child outlives the frame, free of it");
  t("delete without cascade: arrows unbound, a frame's children freed");

  // ---- focus brings what the call changed into view (D-AG-09)
  const views = async () => (await p.out()).filter((m) => m.t === "view" && m.board === "b4");
  const first = (await views()).at(-1);
  await apply({ create: [{ type: "rectangle", key: "far", x: 4000, y: 3000, width: 100, height: 60 }] });
  await p.page.waitForTimeout(300);
  assert.deepEqual([(await views()).at(-1).scrollX, (await views()).at(-1).scrollY], [first.scrollX, first.scrollY], "without focus the view stays");
  await apply({ create: [{ type: "rectangle", key: "farther", x: -3000, y: -2500, width: 100, height: 60 }], focus: true });
  const moved = (await p.until((m) => m.t === "view" && m.board === "b4" && (m.scrollX !== first.scrollX || m.scrollY !== first.scrollY), "the view after focus", { from: 0 })).m;
  const latest = (await views()).at(-1);
  const sx = (-3000 + latest.scrollX) * latest.zoom, sy = (-2500 + latest.scrollY) * latest.zoom;
  assert.ok(sx >= 0 && sx + 100 * latest.zoom <= latest.width && sy >= 0 && sy + 60 * latest.zoom <= latest.height, `with focus the element is on the screen (at ${Math.round(sx)},${Math.round(sy)} of ${latest.width}x${latest.height}; first view ${JSON.stringify(moved)})`);
  t("focus: the changed element is scrolled into view");

  // ---- the picture is drawn in the stored light colours whatever the theme, on a sheet or on nothing (D-EX-02)
  await apply({ create: [{ type: "rectangle", key: "swatch", x: 6000, y: 6000, width: 100, height: 60, backgroundColor: "#a5d8ff", fillStyle: "solid" }] });
  await p.send({ t: "theme", theme: { mode: "dark", filter } });
  const swatch = byKey(await snap(), "swatch").id;
  const onSheet = (await p.ok({ op: "export", target: "live", ids: [swatch], scale: 1, background: true })).value;
  const [corner, inside] = await pixelsOf(ctx, onSheet.png, [[3, 3], [Math.round(onSheet.width / 2), Math.round(onSheet.height / 2)]]);
  assert.deepEqual(corner, [255, 255, 255, 255], "the sheet is the stored white, not the dark theme's");
  assert.deepEqual(inside, [165, 216, 255, 255], "the fill is the stored colour, not inverted");
  const stroke = (await pixelsOf(ctx, onSheet.png, [[15, 40], [16, 40], [17, 40], [18, 40]])).map((c) => c.slice(0, 3));
  assert.ok(stroke.some((c) => c.every((v) => v < 60)), `the ink is the stored dark #1e1e1e (${JSON.stringify(stroke)})`);
  const bare = (await p.ok({ op: "export", target: "live", ids: [swatch], scale: 1, background: false })).value;
  assert.equal((await pixelsOf(ctx, bare.png, [[3, 3]]))[0][3], 0, "with no background the sheet is transparent");
  await p.send({ t: "theme", theme: { mode: "dark", filter } });
  t("export: the stored light colours under a dark theme, a transparent sheet when asked");

  // ---- the picture waits for the fonts and does not depend on them (D-EX-13)
  const hold = () => p.page.evaluate(() => { window.__fontsGate = new Promise((r) => { window.__fontsOpen = r; }); Object.defineProperty(document.fonts, "ready", { configurable: true, get: () => window.__fontsGate }); });
  const restore = () => p.page.evaluate(() => { delete document.fonts.ready; });
  await hold();
  try {
    const id = p.nextId++, from = await p.mark();
    await p.send({ t: "req", id, op: { op: "export", target: "live", ids: [swatch], scale: 1, background: true } });
    await p.page.waitForTimeout(700);
    assert.equal((await p.out()).slice(from).some((m) => m.t === "res" && m.id === id), false, "the picture is not drawn while the fonts are not ready");
    await p.page.evaluate(() => window.__fontsOpen());
    const done = await p.until((m) => m.t === "res" && m.id === id, "the picture once the fonts are ready", { from });
    assert.equal(done.m.ok, true, JSON.stringify(done.m).slice(0, 200));
  } finally { await restore(); }
  await p.page.evaluate(() => { Object.defineProperty(document.fonts, "ready", { configurable: true, get: () => Promise.reject(new Error("no font API")) }); });
  try {
    const drawn = (await p.ok({ op: "export", target: "live", ids: [swatch], scale: 1, background: true })).value;
    assert.ok(drawn.width > 100 && pngSize(drawn.png).width === drawn.width, "fonts that fail to say they are ready do not stop the picture");
  } finally { await restore(); }
  t("export: waits for document.fonts.ready, and is drawn when it fails");

  // ---- one call of an agent is one undo step, and a person's drawing is undone and redone (D-AG-10, D-BD-13)
  await board("b5");
  const pos = await p.page.evaluate(() => { const r = document.querySelector("canvas.interactive").getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await apply({ create: [{ type: "rectangle", key: "u1", x: 100, y: 100, width: 100, height: 60 }, { type: "ellipse", key: "u2", x: 300, y: 100, width: 100, height: 60 }, { type: "text", key: "u3", x: 100, y: 250, text: "three" }] });
  const liveKeys = async () => (await snap()).elements.filter((e) => !e.isDeleted).map((e) => e.customData?.key ?? "(user)").sort();
  assert.deepEqual(await liveKeys(), ["u1", "u2", "u3"]);
  await p.page.mouse.click(pos.x + 700, pos.y + 500); // (an empty place: the canvas has the keys)
  await p.page.keyboard.press("ControlOrMeta+z");
  await untilKeys(p, liveKeys, [], "one undo takes away all that the call made");
  await p.page.keyboard.press("ControlOrMeta+Shift+z");
  await untilKeys(p, liveKeys, ["u1", "u2", "u3"], "and one redo brings it back");
  await p.page.locator('[data-testid="toolbar-rectangle"]').click({ force: true });
  await p.page.mouse.move(pos.x + 500, pos.y + 400); await p.page.mouse.down();
  await p.page.mouse.move(pos.x + 580, pos.y + 460, { steps: 6 }); await p.page.mouse.up();
  await untilKeys(p, liveKeys, ["(user)", "u1", "u2", "u3"], "the person's rectangle");
  await p.page.keyboard.press("ControlOrMeta+z");
  await untilKeys(p, liveKeys, ["u1", "u2", "u3"], "undo takes away the rectangle and nothing of the call");
  await p.page.keyboard.press("ControlOrMeta+Shift+z");
  await untilKeys(p, liveKeys, ["(user)", "u1", "u2", "u3"], "redo brings the rectangle back");
  await p.mirrorIsScene("after undo and redo");
  t("undo and redo: one step for an agent's call, the person's drawing apart");

  // ---- what a person draws starts clean too: sharp corners, a sharp arrow, the normal font (D-BD-06)
  await board("b6");
  const where = await p.page.evaluate(() => { const r = document.querySelector("canvas.interactive").getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const drag = async (tool, x0, y0, x1, y1) => {
    await p.page.locator(`[data-testid="toolbar-${tool}"]`).click({ force: true });
    await p.page.mouse.move(where.x + x0, where.y + y0); await p.page.mouse.down();
    await p.page.mouse.move(where.x + x1, where.y + y1, { steps: 6 }); await p.page.mouse.up();
  };
  await p.page.mouse.click(where.x + 700, where.y + 500); // (an empty place: the canvas has the pointer and the keys)
  await drag("rectangle", 450, 250, 570, 330); // (clear of the panel of properties, which a tool opens at the left)
  await drag("arrow", 650, 250, 830, 250);
  await p.page.locator('[data-testid="toolbar-text"]').click({ force: true });
  await p.page.mouse.click(where.x + 450, where.y + 420);
  await p.page.keyboard.type("hello");
  await p.page.keyboard.press("Escape");
  const kinds = async () => { const m = await p.mirror(); return Object.fromEntries(["rectangle", "arrow", "text"].map((k) => [k, m.elements.find((e) => e.type === k && !e.isDeleted)])); };
  for (let i = 0; i < 100 && !Object.values(await kinds()).every(Boolean); i++) await p.page.waitForTimeout(100);
  const mine = await kinds();
  assert.ok(mine.rectangle && mine.arrow && mine.text, `a rectangle, an arrow and a text were drawn (${Object.entries(mine).map(([k, v]) => k + ":" + !!v)}; the scene has ${JSON.stringify((await p.mirror()).elements.map((e) => [e.type, e.isDeleted]))})`);
  assert.deepEqual([mine.rectangle.roundness, mine.rectangle.roughness], [null, 0], "a rectangle has sharp corners");
  assert.deepEqual([mine.arrow.roundness, !!mine.arrow.elbowed, mine.arrow.roughness], [null, false, 0], "an arrow is sharp, not elbowed");
  assert.deepEqual([mine.text.fontFamily, mine.text.text], [FONT.normal, "hello"], "a text is in the normal font");
  t("a person's drawing: sharp corners, a sharp arrow, the normal font");

  // ---- Excalidraw's main menu has no Open, no Save and no theme toggle; the keys that would open or save a file do nothing (D-BD-08, D-CT-08)
  await p.page.evaluate(() => {
    window.__pickers = 0;
    window.showOpenFilePicker = window.showSaveFilePicker = window.showDirectoryPicker = () => { window.__pickers++; return Promise.reject(new DOMException("none", "AbortError")); };
    const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function (...a) { if (this.type === "file") window.__pickers++; return click.apply(this, a); };
  });
  await p.page.mouse.click(where.x + 700, where.y + 500);
  for (const k of ["ControlOrMeta+o", "ControlOrMeta+s", "ControlOrMeta+Shift+s"]) { await p.page.keyboard.press(k); await p.page.waitForTimeout(150); }
  // (Excalidraw's own ⇧S, with or without ⌘, picks a stroke colour from the canvas: its eye dropper opens, and Esc closes it)
  await p.page.keyboard.press("Escape");
  await p.page.waitForSelector(".excalidraw-eye-dropper-backdrop", { state: "detached", timeout: 5000 });
  assert.equal(await p.page.evaluate(() => window.__pickers), 0, "⌘O, ⌘S and ⌘⇧S open no file picker");
  await p.page.locator('[data-testid="main-menu-trigger"]').click();
  await p.page.waitForSelector(".dropdown-menu-container, .dropdown-menu", { timeout: 5000 });
  const items = (await p.page.locator(".dropdown-menu-item").allTextContents()).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  assert.ok(items.length >= 3, `the menu has its items (${JSON.stringify(items)})`);
  assert.ok(items.some((x) => /^Export image/i.test(x)), `the picture export stays in the menu (${JSON.stringify(items)})`);
  assert.deepEqual(items.filter((x) => /^open\b|load scene/i.test(x)), [], "no Open");
  assert.deepEqual(items.filter((x) => /dark mode|light mode|theme/i.test(x)), [], "no theme toggle: the canvas takes the app's");
  // (Excalidraw still lists its "Save to..." entry, as the old page's canvas did: with saveFileToDisk off its dialog has nothing to press)
  const saveTo = items.filter((x) => /^save/i.test(x));
  assert.deepEqual(saveTo, ["Save to..."], `the one entry of the menu that speaks of saving (${JSON.stringify(items)})`);
  await p.page.locator(".dropdown-menu-item", { hasText: "Save to..." }).click();
  await p.page.waitForSelector(".ExportDialog--json", { state: "attached", timeout: 5000 }); // (an empty box: not "visible")
  assert.equal(await p.page.locator(".ExportDialog--json button, .ExportDialog--json a, .ExportDialog--json input").count(), 0, "its dialog has no control that writes a file");
  assert.equal(await p.page.evaluate(() => window.__pickers), 0, "and opened no file picker");
  await p.page.locator(".Modal__content").focus();
  await p.page.keyboard.press("Escape");
  await p.page.waitForSelector(".ExportDialog--json", { state: "detached", timeout: 5000 });
  t(`main menu (${items.join(" | ")}): no Open, no theme toggle, no way to save a file; ⌘O ⌘S ⌘⇧S do nothing`);

  // ---- a dropped .excalidraw file does not replace the scene; a dropped picture still adds a picture (D-BD-09)
  const dropped = (name, type, content) => p.page.evaluate(([name, type, content]) => {
    const target = document.querySelector("canvas.interactive");
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(content), (c) => c.charCodeAt(0))], name, { type }));
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: r.left + 400, clientY: r.top + 400, dataTransfer: dt }));
  }, [name, type, content]);
  const sceneFile = Buffer.from(JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "from-file", type: "rectangle", x: 0, y: 0, width: 50, height: 50, version: 1, versionNonce: 1, isDeleted: false, strokeColor: "#000000", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100, angle: 0, groupIds: [], frameId: null, roundness: null, boundElements: null, updated: 1, link: null, locked: false, seed: 1, index: "a0" }], appState: {}, files: {} })).toString("base64");
  const before6 = (await snap()).elements.map((e) => [e.id, e.version]);
  await dropped("scene.excalidraw", "", sceneFile);
  await dropped("scene.json", "application/json", sceneFile);
  await p.page.waitForTimeout(600);
  const after6 = await snap();
  assert.deepEqual(after6.elements.map((e) => [e.id, e.version]), before6, "a dropped scene file changed nothing");
  assert.ok(!after6.elements.some((e) => e.id === "from-file"));
  const png1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
  await dropped("dot.png", "image/png", png1);
  for (let i = 0; i < 100 && !(await snap()).elements.some((e) => e.type === "image" && !e.isDeleted); i++) await p.page.waitForTimeout(100);
  const withPicture = await snap();
  const image = withPicture.elements.find((e) => e.type === "image" && !e.isDeleted);
  assert.ok(image, "a dropped picture still adds a picture");
  assert.match(withPicture.files[image.fileId]?.dataURL ?? "", /^data:image\/png;base64,/, "and keeps its file with the board's scene");
  // (Excalidraw resizes a picture it is given with WebAssembly where it may, and in plain JavaScript where the page's policy does not
  // allow it, which is so here: AD-51 keeps `wasm-unsafe-eval` out. That one refusal is the policy at work; any other one is not.)
  const refused = await p.page.evaluate(() => { const v = window.__csp ?? []; window.__csp = []; return v; });
  assert.deepEqual(refused.filter((x) => x !== "script-src: wasm-eval"), [], "a picture dropped on the board broke no rule of the page's policy but the one against WebAssembly");
  t("a dropped scene file is blocked; a dropped picture is added");
}

/** Waits for the keys of the live elements to be these (the person's own are "(user)"). */
async function untilKeys(p, keys, want, what) {
  let got = [];
  for (let i = 0; i < 100; i++) { got = await keys(); if (JSON.stringify(got) === JSON.stringify(want)) return; await p.page.waitForTimeout(80); }
  assert.deepEqual(got, want, what);
}

/** The RGBA of some pixels of a PNG (the browser decodes it, in a page of its own). */
async function pixelsOf(ctx, b64, points) {
  const d = (ctx.decoder ??= await browser.newPage());
  return d.evaluate(async ([b64, points]) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height), g = c.getContext("2d");
    g.drawImage(bmp, 0, 0);
    return points.map(([x, y]) => [...g.getImageData(x, y, 1, 1).data]);
  }, [b64, points]);
}

/** What only the web view's page does: take the app's messages from `window` and from `document`, once, and only those with no source. */
async function webviewChecks({ page }) {
  const answers = (id) => page.evaluate((id) => window.__out.filter((m) => m.t === "res" && m.id === id).length, id);
  const restore = (id) => ({ t: "req", id, op: { op: "restore", elements: [box("q", 0, 0)] } });
  const waitFor = async (id) => { for (let i = 0; i < 200 && !(await answers(id)); i++) await page.waitForTimeout(25); };
  // on document, as react-native-webview does on Android
  await page.evaluate((m) => document.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) })), restore(7001));
  await waitFor(7001);
  assert.equal(await answers(7001), 1, "a message on document is taken, once");
  // an event that bubbles from document to window is still taken once
  await page.evaluate((m) => document.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m), bubbles: true })), restore(7002));
  await waitFor(7002);
  await page.waitForTimeout(150);
  assert.equal(await answers(7002), 1, "an event heard on document and on window is taken once");
  // a message from a window (the page itself, or a frame) has a source: not the app's, not taken
  await page.evaluate((m) => window.postMessage(JSON.stringify(m), "*"), restore(7003));
  await page.waitForTimeout(300);
  assert.equal(await answers(7003), 0, "a message with a source window is ignored");
  // and the entry of the harness is still there
  await page.evaluate((m) => window.aiwbBoardReceive(JSON.stringify(m)), restore(7004));
  await waitFor(7004);
  assert.equal(await answers(7004), 1, "aiwbBoardReceive answers (the harness's entry)");
  console.log("  webview: messages on window and on document, once; with a source, ignored");
}

// ---- run

const pw = findPlaywright();
const browser = await pw.chromium.launch();
const problems = [];
const keep = process.argv.includes("--keep");
// ONLY=behaviours: the web target alone, and only the board behaviours (the steps of `behaviours`), while a step is being written
const only = process.env.ONLY === "behaviours";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-board-view-"));
let failed = false;

async function open(name, url, init) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  const watch = { console: [], requests: [], failed: [], csp: [] };
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") watch.console.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => watch.console.push(`pageerror: ${e.message}`));
  page.on("request", (r) => watch.requests.push(r.url()));
  page.on("requestfailed", (r) => watch.failed.push(`${r.url()} ${r.failure()?.errorText}`));
  await page.addInitScript(() => { document.addEventListener("securitypolicyviolation", (e) => (window.__csp ||= []).push(`${e.violatedDirective}: ${e.blockedURI}`)); });
  if (init) await page.addInitScript(init);
  await page.goto(url);
  return { name, context, page, watch };
}

function noTrouble({ name, page, watch }) {
  return page.evaluate(() => window.__csp ?? []).then((csp) => {
    assert.deepEqual(csp, [], `${name}: the page broke its Content-Security-Policy`);
    const net = watch.requests.filter((u) => !u.startsWith("file:") && !u.startsWith("data:") && !u.startsWith("blob:"));
    assert.deepEqual(net, [], `${name}: the page asked for the network`);
    assert.deepEqual(watch.failed, [], `${name}: a request failed`);
    // (the two warnings are the refusals the checks provoke on purpose)
    assert.deepEqual(watch.console.filter((l) => !/Download the React DevTools|board view: refused a message: message\.(op\.op: unknown request "eval"|t: unknown app → view message "fetch")/.test(l)), [], `${name}: errors in the console`);
    assert.equal(watch.console.filter((l) => /refused a message/.test(l)).length, 2, `${name}: both refusals were logged`);
  });
}

try {
  const ctx = {};

  // 1. the web view's page, from file://
  if (!only) {
  console.log("web view page (dist-webview/board.html from file://)");
  const wv = await open("webview", pathToFileURL(path.join(dist, "board.html")).href, () => {
    window.__out = [];
    window.ReactNativeWebView = { postMessage: (text) => window.__out.push(JSON.parse(text)) };
    // what a web view does with its `postMessage(json)`: a `message` event with no source window (here on window, as iOS does)
    window.__sendRaw = (m) => window.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(m) }));
  });
  const wvPage = new Page(wv.page, "webview", (m) => wv.page.evaluate((m) => window.__sendRaw(m), m));
  const html = fs.readFileSync(path.join(dist, "board.html"), "utf8");
  const policy = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(policy, /default-src 'none'/, "the web view's page has its policy");
  assert.match(policy, /script-src ('sha256-[A-Za-z0-9+/=]+' ?)+;/, "its scripts are allowed by hash alone");
  assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline/, "no eval, no inline script without a hash");
  assert.match(policy, /connect-src 'none'/);
  const shell = html.replace(/<script>[\s\S]*?<\/script>/g, "<script></script>").replace(/<style>[\s\S]*?<\/style>/, "<style></style>");
  assert.equal(shell.match(/<script/g)?.length, 2, "two inline scripts (the font shim and the board), no src");
  assert.doesNotMatch(shell, /<script[^>]* src=|<link /, "board.html loads nothing: one file");
  await checks(wvPage, ctx);
  await webviewChecks(wv);
  // the fonts came from the page itself (data: URLs), not from anywhere else
  const fonts = await wv.page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  console.log(`  webview: fonts loaded: ${[...new Set(fonts)].join(", ") || "(none)"}`);
  assert.ok(fonts.includes("Nunito") && fonts.includes("Excalifont"), "Excalidraw's fonts load from inside the page");
  await noTrouble(wv);
  fs.writeFileSync(path.join(tmp, "export.png"), Buffer.from(ctx.png, "base64"));
  await wv.page.screenshot({ path: path.join(tmp, "webview.png") });
  await wv.context.close();
  }

  // 2. the web build's board: the web target in a page that loads it as app/public/index.html does
  console.log("web target (board.js, board.css, fonts/ built by `build.mjs web --out`)");
  const site = path.join(tmp, "site");
  fs.mkdirSync(site, { recursive: true });
  execFileSync(process.execPath, [path.join(pkg, "build.mjs"), "web", "--out", path.join(site, "board")], { stdio: "inherit" });
  assert.deepEqual(fs.readdirSync(path.join(site, "board")).sort(), ["board.css", "board.js", "fonts"], "the web target is board.js, board.css and fonts/");
  assert.ok(!fs.existsSync(path.join(site, "board/fonts/Xiaolai")), "Xiaolai is left out");
  // (under the Content-Security-Policy of the web build itself, app/scripts/export-web.mjs: no inline script, so the driver is a file)
  fs.writeFileSync(path.join(site, "driver.js"), `
    window.__out = [];
    window.__mounted = window.aiwbBoardView.mount(document.getElementById("root"), (m) => { window.__out.push(JSON.parse(JSON.stringify(m))); }, { testID: "board" });
    window.__sendRaw = (m) => window.__mounted.receive(m);
    window.__send = window.__sendRaw;`);
  fs.writeFileSync(path.join(site, "index.html"), `<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${webBuildCsp}">
<style>html, body, #root { height: 100%; margin: 0; overflow: hidden; }</style>
<link rel="stylesheet" href="./board/board.css"><script src="./board/board.js" defer></script>
<div id="root"></div><script src="./driver.js" defer></script></html>`);
  const ip = await open("web", pathToFileURL(path.join(site, "index.html")).href);
  const ipPage = new Page(ip.page, "web", (m) => ip.page.evaluate((x) => window.__send(x), m));
  assert.equal(await ip.page.evaluate(() => typeof window.aiwbBoardView?.mount), "function", "board.js defines window.aiwbBoardView.mount");
  assert.equal(await ip.page.evaluate(() => window.EXCALIDRAW_ASSET_PATH), pathToFileURL(path.join(site, "board")).href + "/", "Excalidraw's assets are the folder board.js was loaded from");
  await checks(ipPage, {});
  const loadedFonts = await ip.page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  assert.ok(loadedFonts.includes("Nunito") && loadedFonts.includes("Excalifont"), "Excalidraw's fonts load");
  assert.ok(ip.watch.requests.some((u) => /\/board\/fonts\/Excalifont\/.*\.woff2$/.test(u)), `the fonts come from fonts/ next to board.js (${ip.watch.requests.filter((u) => /fonts/.test(u)).join(" ")})`);
  // unmount: the board goes out of the element
  assert.ok(await ip.page.evaluate(() => document.getElementById("root").childElementCount) > 0);
  await ip.page.evaluate(() => window.__mounted.unmount());
  await ip.page.waitForTimeout(100);
  assert.equal(await ip.page.evaluate(() => document.getElementById("root").childElementCount), 0, "unmount empties the element");
  console.log("  web: unmount");
  if (!only) await noTrouble(ip);
  await ip.context.close();
  console.log(`\nharness: ok${keep ? ` (kept in ${tmp})` : ""}`);
} catch (e) {
  failed = true;
  console.error(`\nharness: FAILED\n${e.stack ?? e}`);
  console.error(`(kept in ${tmp})`);
} finally {
  await browser.close();
  if (!failed && !keep) fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
