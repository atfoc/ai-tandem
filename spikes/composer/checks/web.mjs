// The composer in a browser: the web build (npx expo export --platform web) served from dist/, driven by Playwright
// in headless Chromium with real key events. Prints PASS/FAIL per check, exits 1 on any FAIL.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { message, sel, pt, tally } from "./lib.mjs";
import { chipText } from "../src/logic/chipdoc.ts";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".ico": "image/x-icon", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let f = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, "index.html");
  res.setHeader("content-type", types[path.extname(f)] ?? "application/octet-stream");
  res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const errors = [];
if (process.env.WEB_THROTTLE) await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.WEB_THROTTLE) });
page.on("pageerror", (e) => errors.push(process.env.WEB_STACKS ? e.stack ?? String(e) : String(e)));
const T = tally("web");

const area = page.locator('textarea[data-testid="composer"]');
const model = () => page.getByTestId("model").innerText().then((s) => s.replace(/\n/g, "\n"));
const field = () => area.evaluate((e) => ({ value: e.value, start: e.selectionStart, end: e.selectionEnd }));
const press = (k, n = 1) => (async () => { for (let i = 0; i < n; i++) await page.keyboard.press(k); })();
const fresh = async () => {
  await page.goto(url);
  await area.waitFor();
  await area.click();
};
const mod = process.platform === "darwin" ? "Meta" : "Control";
const A = sel(0), B = sel(1), P = pt();
const label = (r) => chipText(r);

// ---- 1. insert at the caret, type around it
await fresh();
await page.keyboard.type("move");
await page.getByTestId("insert-selection").click();
T.eq(await model(), message("move ", A, " "), "insert after typed text: space before and after, tag in the message");
let f = await field();
T.eq(f.start, f.value.length, "the caret is after the chip's trailing space");
await page.keyboard.type("to");
T.eq(await model(), message("move ", A, " to"), "typing after the chip");
// the caret to the very start, type before the chip
await press("Home");
await page.keyboard.type("Hey ");
T.eq(await model(), message("Hey move ", A, " to"), "typing before the chip at the start of the text");
await page.getByTestId("insert-point").click();
f = await field();
T.eq(await model(), message("Hey ", P, " move ", A, " to"), "a second chip (a point) goes in at the caret, after the typed \"Hey \"");

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 2. insert in the middle of a text
await fresh();
await page.keyboard.type("ab cd");
await press("ArrowLeft", 2);
await page.getByTestId("insert-selection").click();
T.eq(await model(), message("ab ", A, " cd"), "insert in the middle of a text");
f = await field();
T.eq(f.value.slice(f.start), "cd", "the caret is after the chip's space, before 'cd'");

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 3. backspace deletes a chip whole
await fresh();
await page.keyboard.type("x");
await page.getByTestId("insert-selection").click();
await press("Backspace"); // the space after it
T.eq(await model(), message("x ", A), "backspace removes the space after the chip first");
await press("Backspace"); // the chip
T.eq(await model(), "x ", "the next backspace removes the whole chip");
f = await field();
T.eq(f.value, "x ", "the field's string is the text only");
// delete (forward)
await fresh();
await page.keyboard.type("a b");
await press("ArrowLeft", 2);
await page.getByTestId("insert-selection").click();
await press("ArrowLeft"); // over the chip: the caret is at its start
await press("Delete");
T.eq(await model(), "a  b", "forward delete at the chip's start removes it whole");

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 4. the caret and the selection never land inside a chip
await fresh();
await page.keyboard.type("ab");
await page.getByTestId("insert-selection").click();
await page.keyboard.type("cd");
let chip;
{
  const v = (await field()).value;
  const c = chipText(A);
  chip = { start: v.indexOf(c), end: v.indexOf(c) + c.length };
}
const inside = (p) => p > chip.start && p < chip.end;
await press("Home");
const walk = [];
for (let i = 0; i < 14; i++) { await press("ArrowRight"); const g = await field(); walk.push(g.start); }
T.ok(walk.every((p) => !inside(p)), "ArrowRight across the whole line never stops inside the chip", `positions ${walk}`);
T.ok(walk.includes(chip.end), "the caret goes over the chip in one step", `positions ${walk}`);
const back = [];
for (let i = 0; i < 14; i++) { await press("ArrowLeft"); const g = await field(); back.push(g.start); }
T.ok(back.every((p) => !inside(p)), "ArrowLeft across the whole line never stops inside the chip", `positions ${back}`);
// a click in the middle of the chip
{
  const box = await page.getByTestId("composer-layer").locator("xpath=.//span[2]").boundingBox().catch(() => null);
  const spans = page.getByTestId("composer-layer").locator("span");
  const n = await spans.count();
  let target = null;
  for (let i = 0; i < n; i++) { const t = await spans.nth(i).innerText(); if (t.includes("rectangle")) { target = await spans.nth(i).boundingBox(); break; } }
  T.ok(!!target, "the chip is drawn as its own run in the layer");
  if (target) {
    await page.mouse.click(target.x + target.width * 0.55, target.y + target.height / 2);
    const g = await field();
    T.ok(!inside(g.start) && !inside(g.end), "a tap on the chip puts the caret at one of its edges", `caret ${g.start}-${g.end} chip ${chip.start}-${chip.end}`);
  }
}
// shift+arrow takes a chip whole
await press("Home");
await press("ArrowRight", 3); // after "ab "
{ const g = await field(); T.eq(g.start, 3, "caret after 'ab ' (the text before the chip)"); }
await page.keyboard.press("Shift+ArrowRight");
{
  const g = await field();
  T.ok(g.start === chip.start && g.end === chip.end, "shift+right from the chip's edge selects the whole chip", `selection ${g.start}-${g.end} chip ${chip.start}-${chip.end}`);
}
await page.keyboard.type("Z"); // typed over a selected chip
T.eq(await model(), "ab Z cd", "typing over a selected chip replaces it");

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 5. a double click inside a chip (a word of its label) selects the chip whole
await fresh();
await page.keyboard.type("ab");
await page.getByTestId("insert-selection").click();
await page.keyboard.type("cd");
{
  const spans = page.getByTestId("composer-layer").locator("span");
  let target = null;
  for (let i = 0; i < (await spans.count()); i++) if ((await spans.nth(i).innerText()).includes("rectangle")) target = await spans.nth(i).boundingBox();
  await page.mouse.dblclick(target.x + target.width * 0.3, target.y + target.height / 2);
  const v = (await field()).value, c = chipText(A);
  const g = await field();
  T.ok(g.start === v.indexOf(c) && g.end === v.indexOf(c) + c.length, "a double click in a chip selects the chip, not a word of it", `selection ${g.start}-${g.end}`);
}

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 6. multi-line growth
await fresh();
const heightOf = () => page.getByTestId("composer-layer").evaluate((e) => e.getBoundingClientRect().height);
const h0 = await heightOf();
await page.keyboard.type("one");
await press("Enter");
await page.keyboard.type("two");
await press("Enter");
await page.keyboard.type("three");
const h3 = await heightOf();
T.ok(h3 > h0 + 30, "the box grows with its lines", `height ${h0} -> ${h3}`);
await page.getByTestId("insert-selection").click();
await page.keyboard.type("long ".repeat(40));
const hw = await heightOf();
T.ok(hw > h3 + 60, "the box grows when a line wraps", `height ${h3} -> ${hw}`);
T.ok((await model()).startsWith("one\ntwo\nthree "), "line breaks are in the message");
for (let i = 0; i < 12; i++) { await press("Enter"); }
await page.keyboard.type("last");
const outer = await page.getByTestId("composer").evaluate((e) => { let n = e; while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement; return n ? { top: n.scrollTop, scroll: n.scrollHeight, client: n.clientHeight } : null; });
T.ok(outer && outer.client <= 180 && outer.top > 0, "past its maximum height the box scrolls and follows the caret", JSON.stringify(outer));
await page.screenshot({ path: path.join(dist, "..", "checks", "out", "web-multiline.png") });

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 7. message model, send, draft
await fresh();
await page.keyboard.type("move");
await page.getByTestId("insert-selection").click();
await page.keyboard.type("to");
await page.getByTestId("insert-selection").click(); // the second selection fixture
await page.keyboard.type("and keep");
await page.getByTestId("insert-point").click();
await page.keyboard.type("\nthanks");
const A1 = sel(0), B1 = sel(1);
T.eq(await model(), message("move ", A1, " to ", B1, " and keep ", P, " \nthanks"), "the message equals refs.ts' serialize of the same content (2 selections, a point, a line break)");
await page.getByTestId("send").click();
T.eq(await page.getByTestId("sent").innerText(), message("move ", A1, " to ", B1, " and keep ", P, " \nthanks").trim(), "what is sent is the trimmed message");
T.eq((await field()).value, "", "the box is empty after the send");
await page.screenshot({ path: path.join(dist, "..", "checks", "out", "web-sent.png") });

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 8. copy and paste
await fresh();
await page.keyboard.type("see");
await page.getByTestId("insert-selection").click();
await page.keyboard.type("ok");
await page.screenshot({ path: path.join(dist, "..", "checks", "out", "web-chips.png") });
await page.keyboard.press(`${mod}+a`);
await page.keyboard.press(`${mod}+c`);
const clip = await page.evaluate(() => navigator.clipboard.readText());
T.eq(clip, message("see ", A, " ok"), "copy puts the message form (tags) on the clipboard");
await page.keyboard.press("Backspace");
T.eq(await model(), "", "everything deleted with a selection");
await page.keyboard.press(`${mod}+v`);
T.eq(await model(), message("see ", A, " ok"), "paste of that text gives the chips again");
f = await field();
T.ok(f.value.includes(chipText(A)), "the pasted tag is shown as a chip");
await page.keyboard.press(`${mod}+a`);
await page.keyboard.press(`${mod}+x`);
T.eq(await model(), "", "cut removes the selection");
T.eq(await page.evaluate(() => navigator.clipboard.readText()), message("see ", A, " ok"), "cut puts the tags on the clipboard");

T.ok(errors.length === 0, "no page errors so far", errors.slice(0, 1).join("\n"));
// ---- 9. a draft comes back (set from a saved message text)
T.ok(errors.length === 0, "no page errors", errors.join("\n"));
await browser.close();
server.close();
process.exit(T.done() ? 0 : 1);
