// Regenerates the README's screenshots, docs/screenshots/*.png, of the app's web build (app/) on the mock with made-up data (dev/readme-demo.mjs):
//   cd web && node dev/readme-shots.mjs            every shot      (node dev/readme-shots.mjs hero chat: the ones named)
// Needs Playwright with Chromium (see dev/shot.mjs). Own mock on port 4853 (PORT=…), nothing of the real app is used. The build is made now
// (buildAppDist; DIST=… names one made before), OUT=… writes the pictures to another folder than docs/screenshots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildAppDist, loadPlaywright, mockEval, onEnd, openApp, startMock, until } from "./shot.mjs";
import { byTid, press } from "./checks/sel.mjs";
import { openTree } from "./checks/fork.mjs";
import { CREATE } from "./readme-diagram.mjs";
import { CO, installCode, LIBRARY } from "./readme-demo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(process.env.OUT || path.join(HERE, "../../docs/screenshots"));
const PORT = Number(process.env.PORT || 4853);
const only = process.argv.slice(2);
const W = 1440, H = 900;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-readme-"));
onEnd(() => fs.rmSync(tmp, { recursive: true, force: true }));
fs.mkdirSync(OUT, { recursive: true });
const dist = process.env.DIST || buildAppDist(path.join(tmp, "dist"));
const mock = await startMock({ dist, port: PORT });
const ev = (code) => mockEval(code, mock.url);
let browser = await (await loadPlaywright()).chromium.launch();

/** A page of the demo at 1440x900, device scale 2, with nothing moving. */
async function open({ sel, widths = { side: 264, panel: 420 }, theme = "light", ls = {}, size = [W, H] }) {
  const o = await openApp({ url: mock.url, viewport: "desktop", sel, size, scale: 2, still: true, browser, ls: { "aiwb.theme": theme, "aiwb.widths": JSON.stringify(widths), ...ls } });
  browser = o.browser;
  await o.page.evaluate(() => document.fonts.ready);
  return o;
}
const settle = (page, ms = 800) => page.waitForTimeout(ms);
/** Fits the board in its pane (Excalidraw's Shift+1) once its canvas is there. */
async function fit(page) {
  await page.waitForSelector(".excalidraw .App-toolbar", { timeout: 15000 });
  await page.waitForTimeout(600);
  await page.mouse.click(W - 60, H - 150);
  await page.keyboard.press("Shift+1");
  await page.mouse.move(W - 5, 5);
  await page.waitForTimeout(600);
}
/** Saves a PNG; one over ~600 KB is reduced to a palette of 256 colours (what a UI screenshot needs) with Pillow. */
function save(name, buf) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, buf);
  if (buf.length > 600 * 1024) {
    try {
      execFileSync("python3", ["-c", "import sys\nfrom PIL import Image\nim = Image.open(sys.argv[1]).convert('RGB')\nim.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(sys.argv[1], optimize=True)", file]);
    } catch (e) { console.error("could not reduce", name, e.message); }
  }
  console.log(`${name}: ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
const shot = async (page, name, clip) => save(name, await page.screenshot(clip ? { clip } : {}));

/** Two screenshots of a made-up phone app, drawn by the browser, to attach to a message. */
async function pictures() {
  const html = (title, body) => `<body style="margin:0;font:16px -apple-system,Helvetica,Arial,sans-serif;background:#f4f5f7;width:390px;height:560px;overflow:hidden">
    <div style="background:#1e293b;color:#fff;padding:44px 20px 14px;font-weight:600;font-size:18px">${title}</div>${body}</body>`;
  const field = (label, value, bad) => `<div style="margin:14px 20px 0"><div style="font-size:12px;color:#64748b;margin-bottom:4px">${label}</div>
    <div style="background:#fff;border:1.5px solid ${bad ? "#dc2626" : "#cbd5e1"};border-radius:8px;padding:12px;color:#0f172a">${value}</div>${bad ? '<div style="color:#dc2626;font-size:12px;margin-top:4px">Invalid date</div>' : ""}</div>`;
  const pages = {
    "card-step.png": html("Payment", field("Name on card", "Alex Morgan") + field("Card number", "4242 4242 4242 4242") + field("Expiry", "04/29", true) + field("CVC", "123") + `<div style="margin:24px 20px;background:#2563eb;color:#fff;border-radius:10px;padding:14px;text-align:center;font-weight:600">Pay €48.00</div>`),
    "cart-step.png": html("Your cart", `<div style="margin:16px 20px;background:#fff;border-radius:10px;padding:14px">Linen shirt <span style="float:right">€39.00</span><hr style="border:0;border-top:1px solid #e2e8f0"> Tote bag <span style="float:right">€12.00</span><hr style="border:0;border-top:1px solid #e2e8f0"> Promo SPRING-24 <span style="float:right;color:#16a34a">−€3.00</span><hr style="border:0;border-top:1px solid #e2e8f0"><b>Total</b><span style="float:right"><b>€48.00</b></span></div><div style="margin:24px 20px;background:#2563eb;color:#fff;border-radius:10px;padding:14px;text-align:center;font-weight:600">Continue to payment</div>`),
  };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 560 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const files = [];
  for (const [name, content] of Object.entries(pages)) {
    await page.setContent(content);
    const file = path.join(tmp, name);
    fs.writeFileSync(file, await page.screenshot());
    files.push(file);
  }
  await ctx.close();
  return files;
}

// ---- the shots

const REMOTES_FOLDED = { "aiwb.collapsed": JSON.stringify(["s_build", "s_lab"]) };

const SHOTS = {
  async hero({ theme = "light", name = "hero.png" } = {}) {
    const { ctx, page } = await open({ sel: { board: "b_flow", chat: "c_hero" }, widths: { side: 264, panel: 400 }, theme, ls: REMOTES_FOLDED });
    await fit(page);
    await settle(page);
    await shot(page, name);
    await ctx.close();
  },
  async "hero-dark"() { await SHOTS.hero({ theme: "dark", name: "hero-dark.png" }); },
  async chat() {
    const { ctx, page } = await open({ sel: { board: null, chat: "c_tests" }, ls: REMOTES_FOLDED });
    await byTid(page, "tool-card").first().waitFor();
    for (const hint of ["Edited coupon.go"]) await press(page, byTid(page, "tool-row").filter({ hasText: hint }).first());
    await settle(page);
    await shot(page, "chat.png");
    await ctx.close();
  },
  async subagents() {
    const { ctx, page } = await open({ sel: { board: null, chat: "c_audit" }, ls: REMOTES_FOLDED });
    await byTid(page, "sub-row").first().waitFor();
    await settle(page);
    await shot(page, "subagents.png");
    await ctx.close();
  },
  async "remote-servers"() {
    // this computer's groups are folded, so that the servers below them have the room; Office Mac is not connected
    // (a group's fold is the page's own: kept in its storage, by the group's key)
    const folded = await ev(`addServer({ id: "s_office", name: "Office Mac", address: "https://office-mac.example:4790", state: "unreachable", detail: "connection refused" }); resync(); return groups.map((g) => g.id);`);
    const { ctx, page } = await open({ sel: { board: null, chat: "s_build~c_nightly" }, ls: { "aiwb.collapsed": JSON.stringify([...folded, "s_build", "s_lab"]) } });
    await byTid(page, "tool-card").first().waitFor();
    await press(page, byTid(page, "tool-row").filter({ hasText: "Edited integration.sh" }).first());
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "remote-servers.png");
    await press(page, byTid(page, "servers-btn"));
    await byTid(page, "servers-dialog").waitFor();
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "servers-dialog.png");
    await ctx.close();
    await ev(`removeServer("s_office"); return 1;`);
  },
  async "composer-images"() {
    await ev(`chats.c_new = chat("c_new", { group: "g_app", cwd: HOME + "/projects/shop-app", created: iso(Date.now()), ...fresh }); items.c_new = []; send({ type: "chat", chat: chats.c_new }); return 1;`);
    const files = await pictures();
    const { ctx, page } = await open({ sel: { board: null, chat: "c_new" }, ls: REMOTES_FOLDED });
    await byTid(page, "attach-btn").waitFor();
    const chooser = page.waitForEvent("filechooser");
    await press(page, byTid(page, "attach-btn"));
    await (await chooser).setFiles(files);
    await byTid(page, "image-thumb").first().waitFor({ timeout: 15000 });
    await press(page, byTid(page, "composer-input").first());
    await page.keyboard.type("The card step shows \"Invalid date\" for 04/29 on iOS. Screenshots of both screens attached: where is the date parsed?");
    await page.mouse.move(W - 5, 5);
    await settle(page, 1500);
    await shot(page, "composer-images.png");
    await ctx.close();
    await ev(`delete chats.c_new; delete items.c_new; send({ type: "chat_removed", id: "c_new" }); return 1;`);
  },
  async "model-picker"() {
    await ev(`chats.c_new = chat("c_new", { group: "g_co", cwd: CO_DIR, created: iso(Date.now()), ...fresh }); items.c_new = []; send({ type: "chat", chat: chats.c_new }); return 1;`.replace("CO_DIR", JSON.stringify(CO)));
    const { ctx, page } = await open({ sel: { board: null, chat: "c_new" }, ls: REMOTES_FOLDED });
    await byTid(page, "tchip").first().waitFor();
    await press(page, byTid(page, "tchip").filter({ hasText: "Opus 5.5" }).first());
    await byTid(page, "pick-row").first().waitFor();
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "model-picker.png");
    await ctx.close();
    await ev(`delete chats.c_new; delete items.c_new; send({ type: "chat_removed", id: "c_new" }); return 1;`);
  },
  async "permission-card"() {
    await ev(`chats.c_perm = chat("c_perm", { name: "Ship the coupon fix", group: "g_co", cwd: ${JSON.stringify(CO)}, status: "approval", statusTool: "Bash", created: iso(T0 - 5 * MIN) });
      items.c_perm = [{ kind: "user", text: "Commit the coupon fix and push the branch." }, say("The tests pass, so I'll commit and push the fix branch."),
        tool("q0", "Bash", { command: "git commit -am 'Allocate coupon discounts in a fixed order'", description: "Commit the fix" }, "[fix/coupon-rounding 4f2a1c9] Allocate coupon discounts in a fixed order\\n 1 file changed, 7 insertions(+), 5 deletions(-)"),
        { kind: "perm", requestId: "q1", toolName: "Bash", input: { command: "git push origin fix/coupon-rounding", description: "Push the fix branch" }, decided: "" }];
      send({ type: "chat", chat: chats.c_perm }); return 1;`);
    const { ctx, page } = await open({ sel: { board: null, chat: "c_perm" }, ls: REMOTES_FOLDED });
    await byTid(page, "perm").first().waitFor();
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "permission-card.png");
    await ctx.close();
    await ev(`delete chats.c_perm; delete items.c_perm; send({ type: "chat_removed", id: "c_perm" }); return 1;`);
  },
  async "chat-tree"() {
    await ev(`const turn = (q, a, p) => [{ kind: "user", text: q }, say(a), { kind: "end", point: p }];
      chats.c_tree = chat("c_tree", { name: "Design the refund API", group: "g_pay", cwd: ${JSON.stringify(CO)}, created: iso(T0 - 20 * MIN) });
      items.c_tree = [...turn("How should partial refunds work?", "Add a refunds table keyed by order id: several refunds per order, each with an amount and Stripe's refund id.", "p1"), ...turn("And the endpoint?", "POST /orders/{id}/refunds with an Idempotency-Key header; 202 while Stripe confirms.", "p2")];
      const a = addBranch("c_tree", "main", 3, {}, "alt");
      a.items.push(...turn("What if we only allow full refunds?", "Then a boolean on orders is enough, but support will ask for partial ones within a month. I would still build the table.", "q2"));
      const b = addBranch("c_tree", "main", 6, {}, "alt2");
      b.items.push(...turn("Draw the refund flow on the board.", "Drew it next to the checkout flow: client, checkout service, Stripe, and the refunds table.", "r3"));
      send({ type: "chat", chat: chats.c_tree }); send({ type: "snapshot", ...snapshot() }); return 1;`);
    const { ctx, page } = await open({ sel: { board: null, chat: "c_tree" }, ls: REMOTES_FOLDED });
    await byTid(page, "msg").first().waitFor();
    await openTree(page);
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "chat-tree.png");
    await ctx.close();
    await ev(`delete chats.c_tree; delete items.c_tree; delete branches.c_tree; delete sessions.c_tree; send({ type: "chat_removed", id: "c_tree" }); return 1;`);
  },
  async "theme-mocha"() { await SHOTS.hero({ theme: "mocha", name: "hero-mocha.png" }); },
  async "prompt-library"() {
    const { ctx, page } = await open({ sel: { board: null, chat: "c_tests" }, ls: REMOTES_FOLDED });
    await byTid(page, "tool-card").first().waitFor();
    await press(page, byTid(page, "library-btn"));
    await byTid(page, "library-dialog").waitFor();
    await press(page, byTid(page, "library-dialog").getByText("Pull request description", { exact: true }).first());
    await byTid(page, "lib-text-input").waitFor();
    await page.mouse.move(W - 5, 5);
    await settle(page);
    await shot(page, "prompt-library.png");
    await ctx.close();
  },
};

try {
  await ev(installCode());
  await ev(`setLibrary("local", ${JSON.stringify(LIBRARY)}); return 1;`);
  { // the board's drawing is made the way an agent makes it: one `apply` call, answered by the page
    const { ctx, page } = await open({ sel: { board: "b_flow", chat: "c_hero" } });
    await page.waitForSelector(".excalidraw .App-toolbar", { timeout: 15000 });
    let n = 0;
    const tool = (name, args) => ev(`send({ type: "rpc", id: "r${++n}", method: "tool", params: { name: ${JSON.stringify(name)}, board: "b_flow", target: "b_flow", chat: "c_hero", branch: "main", args: ${JSON.stringify(args)} } }); return 1;`);
    const drawn = async (count) => until(async () => (await ev(`return scenes.b_flow.scene.elements.filter((e) => !e.isDeleted).length;`)) >= count, 20000);
    // (the fonts of the labels load on first use, and what is measured before that is too narrow: draw a label, wait, erase it)
    await tool("apply", { create: [{ type: "rectangle", key: "w1", x: 0, y: 0, width: 100, height: 50, label: { text: "warm up", fontSize: 20 } }, { type: "text", key: "w2", x: 0, y: 100, text: "warm up", fontSize: 16 }] });
    await drawn(3);
    await page.waitForTimeout(2500);
    await tool("delete_elements", { refs: [{ key: "w1" }, { key: "w2" }] });
    await page.waitForTimeout(1000);
    await tool("apply", { create: CREATE });
    if (!await drawn(CREATE.length + 19)) throw new Error("the drawing was not stored");
    await page.waitForTimeout(3000);
    await ctx.close();
  }
  for (const [name, run] of Object.entries(SHOTS)) if (!only.length || only.includes(name)) { console.log("shot", name); await run(); }
} finally {
  await browser?.close();
  await mock.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
