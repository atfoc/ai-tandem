// L0 (new in the app, package T1): the helpers of sel.mjs and the frame of dev/shot.mjs check(), at desktop, tablet and phone, on a
// stand-in page: the page of the app is loaded (so the viewport, the device and the mock are real) and its document is replaced by
// a small one that draws the contract the screens of Track S draw (IDS of sel.mjs): a sidebar tree of rows, on the phone Home (H1: the
// `home` of one server, its `home-row`s, a group a row that pushes a `group-screen`; the page's `__aiwbHome.placeOf` stands in for the
// store's) and a stack, a hidden sidebar and its show control, a header for a chat and a bar for a board, a row's menu button shown on hover, a menu
// that opens a second one, a long press (500 ms) and a drag (at once with a mouse, after a 300 ms hold with a finger).
// It proves what a port relies on, and nothing of the app: tidSel/byTid with dataSet values; layoutNow and touchNow follow the
// window; press and hover do the thing of the viewport; openChat/openBoard/back take the path of the layout (the list is brought
// back on the phone, the hidden sidebar shown on the wide layouts); openMenu goes through a menu that opens another; longPress;
// the drag, in one call and step by step, with its cancel; that the hold of a finger's drag matters (without it the drag does not
// start). When a screen names an id otherwise than IDS says, this check is unchanged: the stand-in is the contract.
import { check, until } from "../shot.mjs";
import { IDS, back, byTid, dragTo, hover, layoutNow, longPress, openBoard, openChat, openMenu, pointerDragger, press, tidSel, touchDrag, touchNow } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const STAND_IN = String.raw`
document.body.innerHTML = '';
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const style = el('<style>body{margin:0;font:14px sans-serif} [data-testid=side-row],[data-testid=menu-row]{display:flex;gap:8px;padding:10px;border:1px solid #ccc;min-height:44px;align-items:center}' +
  '.menu-btn{visibility:hidden} [data-testid=side-row]:hover .menu-btn,[data-testid=menu-row]:hover .menu-btn{visibility:visible} @media (pointer:coarse){.menu-btn{visibility:visible}}' +
  '[data-testid=menu]{position:fixed;left:20px;top:200px;background:#eee;border:1px solid #999;padding:4px;z-index:5} [data-testid=menu-item]{display:block;padding:12px}' +
  '#pad{width:120px;height:60px;background:#ddd;touch-action:none;user-select:none} #lp{width:120px;height:60px;background:#cde;touch-action:none;user-select:none} #zone{width:200px;height:80px;background:#efe;margin-top:8px}' +
  '[hidden]{display:none !important}</style>');
const root = el('<div data-testid="app-root"></div>');
document.body.append(style, root);
root.innerHTML = '<div data-testid="side-tree" id="tree"></div><button data-testid="side-show" id="show">Show</button><button data-testid="side-hide" id="hide">Hide</button>' +
  '<div data-testid="home" id="home" data-server="local" data-state="list"></div><div data-testid="group-screen" id="group" data-key="s_studio"></div>' +
  '<button data-testid="nav-back" id="back">Back</button><div id="detail"><div data-testid="chat-head" id="chat-head"></div><div data-testid="board-bar" id="board-bar"></div></div>' +
  '<div data-testid="menu-row" id="menurow"><span>A row with a menu</span></div><div id="lp" data-testid="lp-target" data-state="idle">hold</div><div id="pad" data-testid="drag-pad" data-state="idle">drag</div><div id="zone" data-testid="drag-zone"></div><div id="result" data-testid="result"></div>';
const S = { sel: null, kind: null, hidden: false, menu: null, group: false };
const ROWS = [["chat", "c_plain", "A plain chat"], ["board", "b_arch", "Architecture"], ["chat", "s_studio~c_plain", "Studio chat"]];
// (where a thing sits, as the page's seam says it: the studio chat is inside the group "s_studio")
window.__aiwbHome = { placeOf: (kind, key) => ({ server: 'local', groups: key === 's_studio~c_plain' ? ['s_studio'] : [], board: null }), server: () => 'local' };
const $ = (id) => document.getElementById(id);
const phone = () => innerWidth < 700;
function draw() {
  const p = phone();
  $('tree').hidden = p || S.hidden;
  $('home').hidden = !p || !!S.sel || S.group;
  $('group').hidden = !p || !!S.sel || !S.group;
  $('show').hidden = p || !S.hidden;
  $('hide').hidden = p || S.hidden;
  $('detail').hidden = !S.sel;
  $('back').hidden = !p || !(S.sel || S.group);
  $('chat-head').hidden = S.kind !== 'chat'; $('board-bar').hidden = S.kind !== 'board';
  $('chat-head').textContent = S.kind === 'chat' ? 'chat ' + S.sel : ''; $('board-bar').textContent = S.kind === 'board' ? 'board ' + S.sel : '';
  for (const r of document.querySelectorAll('[data-testid=side-row]')) r.setAttribute('aria-selected', String(!p && r.dataset.key === S.sel));
  for (const m of document.querySelectorAll('[data-testid=menu]')) m.remove();
  if (S.menu) {
    const m = el('<div data-testid="menu"></div>');
    for (const t of S.menu) { const i = el('<button data-testid="menu-item"></button>'); i.textContent = t; i.onclick = () => pick(t); m.append(i); }
    document.body.append(m);
  }
}
function pick(t) {
  $('result').textContent = t;
  S.menu = t === 'Move to…' ? ['Shop', 'Other'] : null;
  draw();
}
function homeRow(kind, key, name, onclick) {
  const r = el('<div role="button" data-testid="home-row" tabindex="0"></div>');
  r.dataset.kind = kind; r.dataset.key = key; r.dataset.server = 'local'; r.textContent = name; r.onclick = onclick;
  return r;
}
const open = (kind, key) => () => { S.sel = key; S.kind = kind; draw(); };
$('home').append(homeRow('chat', 'c_plain', 'A plain chat', open('chat', 'c_plain')), homeRow('board', 'b_arch', 'Architecture', open('board', 'b_arch')),
  homeRow('group', 's_studio', 'Studio', () => { S.group = true; draw(); }));
$('group').append(homeRow('chat', 's_studio~c_plain', 'Studio chat', open('chat', 's_studio~c_plain')));
for (const [kind, key, name] of ROWS) {
  const r = el('<div role="button" data-testid="side-row" tabindex="0"></div>');
  r.dataset.kind = kind; r.dataset.key = key;
  r.innerHTML = '<span></span><button class="menu-btn" data-testid="row-menu" aria-label="More">⋯</button>';
  r.firstChild.textContent = name;
  r.onclick = () => { S.sel = key; S.kind = kind; draw(); };
  r.querySelector('button').onclick = (e) => { e.stopPropagation(); S.menu = ['Rename', 'Move to…']; draw(); };
  $('tree').append(r);
}
{ const b = el('<button class="menu-btn" data-testid="row-menu" aria-label="More">⋯</button>'); b.onclick = () => { S.menu = ['Rename', 'Move to…']; draw(); }; $('menurow').append(b); }
$('show').onclick = () => { S.hidden = false; draw(); };
$('hide').onclick = () => { S.hidden = true; draw(); };
$('back').onclick = () => { if (S.sel) { S.sel = null; S.kind = null; } else S.group = false; draw(); };
addEventListener('resize', draw);
// a long press: 500 ms of a pointer down
let lp = 0;
$('lp').onpointerdown = () => { lp = setTimeout(() => { $('lp').dataset.state = 'long'; }, 500); };
$('lp').onpointerup = () => clearTimeout(lp);
// a drag: a mouse starts it at once, a finger after a hold of 300 ms
const pad = $('pad'); let hold = 0, down = null;
pad.onpointerdown = (e) => {
  down = { x: e.clientX, y: e.clientY }; pad.setPointerCapture(e.pointerId);
  const go = () => { pad.dataset.state = 'dragging'; }; if (e.pointerType === 'mouse') go(); else hold = setTimeout(go, 300);
};
pad.onpointermove = (e) => { if (pad.dataset.state === 'dragging') pad.dataset.dx = String(Math.round(e.clientX - down.x)); else if (down) { clearTimeout(hold); } };
pad.onpointerup = (e) => { clearTimeout(hold); if (pad.dataset.state === 'dragging') { const z = $('zone').getBoundingClientRect(); const inside = e.clientX >= z.left && e.clientX <= z.right && e.clientY >= z.top && e.clientY <= z.bottom; pad.dataset.state = inside ? 'dropped' : 'released'; } down = null; };
pad.onpointercancel = () => { clearTimeout(hold); pad.dataset.state = 'cancelled'; down = null; };
addEventListener('keydown', (e) => { if (e.key === 'Escape' && pad.dataset.state === 'dragging') pad.dataset.state = 'cancelled'; });
draw();
`;

await check("L0 the helpers of sel.mjs at three viewports, on a stand-in page", async ({ viewport, layout, touch, page, fail }) => {
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const text = async (loc) => ((await loc.first().textContent()) ?? "").trim();
  await page.evaluate(STAND_IN);
  const state = (id) => byTid(page, id).first().getAttribute("data-state");

  // ---- the selectors
  expect(tidSel("side-row", { kind: "chat", key: "c_plain" }) === '[data-testid="side-row"][data-kind="chat"][data-key="c_plain"]', "tidSel does not write the dataSet values as attributes");
  expect(tidSel("x", { serverId: "a b" }) === '[data-testid="x"][data-server-id="a b"]', "tidSel does not hyphenate a camelCase dataSet key as react-native-web does");
  expect(await byTid(page, IDS.row).count() === 3, "byTid does not find the three rows");
  expect(await byTid(page, IDS.row, { kind: "board" }).count() === 1, "byTid with a dataSet value does not narrow the list");
  expect(await byTid(page.locator("body"), IDS.row, { kind: "chat", key: "s_studio~c_plain" }).count() === 1, "byTid does not take a locator as its root, or does not take a key with a ~");

  // ---- the viewport, as the page says it
  expect(layoutNow(page) === layout, `layoutNow says ${layoutNow(page)}, the viewport is ${layout}`);
  expect(await touchNow(page) === touch, `touchNow says ${await touchNow(page)} at ${viewport}`);

  // ---- navigating by the path of the layout
  await openChat(page, "c_plain");
  expect(await text(byTid(page, IDS.chatHead)) === "chat c_plain", "openChat did not open the chat");
  expect(await byTid(page, layout === "phone" ? IDS.home : IDS.tree).first().isVisible() === (layout !== "phone"), layout === "phone" ? "Home is still on screen on the phone after a chat opened" : "the list is gone on a wide layout after a chat opened");
  const wentBack = await back(page);
  expect(wentBack === (layout === "phone"), `back answered ${wentBack} at ${layout}`);
  expect(layout !== "phone" || await byTid(page, IDS.home).first().isVisible(), "back did not bring Home back on the phone");
  await openBoard(page, "b_arch"); // (from the list on the phone, from the open chat on a wide layout)
  expect(await text(byTid(page, IDS.boardBar)) === "board b_arch", "openBoard did not open the board");
  await openChat(page, "s_studio~c_plain"); // (from an open board: the phone goes back first)
  expect(await text(byTid(page, IDS.chatHead)) === "chat s_studio~c_plain", "openChat from an open board did not open the chat");
  if (layout !== "phone") {
    await press(page, byTid(page, "side-hide"));
    expect(!await byTid(page, IDS.tree).first().isVisible(), "the stand-in's hide control did not hide the list");
    await openChat(page, "c_plain"); // (the sidebar is shown first)
    expect(await text(byTid(page, IDS.chatHead)) === "chat c_plain", "openChat with the sidebar hidden did not show it and open the chat");
  }
  await openChat(page, "c_plain").catch((e) => fail(`openChat of a row that is there threw: ${e.message}`));
  let missing = "";
  await openChat(page, "c_nowhere", { timeout: 1500 }).catch((e) => { missing = e.message; });
  expect(/no chat row "c_nowhere"/.test(missing), `openChat of a row that is not there did not say so: "${missing}"`);
  await back(page);

  // ---- hover and the menu of a row
  const row = byTid(page, "menu-row"); // (a row of its own: the phone's rows are Home's, with no menu button)
  await page.mouse.move(1000, 700); // (the last press left the pointer over a row)
  expect(await byTid(row, "row-menu").isVisible() === touch, touch ? "a row's menu button is hidden on a touch viewport" : "a row's menu button shows with no hover");
  await hover(page, row);
  expect(await byTid(row, "row-menu").isVisible(), "the menu button of a row is not shown with the pointer over the row");
  const left = await openMenu(page, byTid(row, "row-menu"), "Move to…", "Other");
  expect(left === null, "openMenu left a menu open after the last item closed it");
  expect(await text(byTid(page, "result")) === "Other", `the items of openMenu were not pressed in order: the result says "${await text(byTid(page, "result"))}"`);
  await hover(page, row); // (a pick left the pointer over the menu: a button shown on hover needs its row hovered again)
  const kept = await openMenu(page, byTid(row, "row-menu"), "Move to…");
  expect(!!kept && await byTid(kept, IDS.menuItem).count() === 2, "openMenu did not answer the second menu left open");
  await page.keyboard.press("Escape");
  await byTid(page, IDS.menu).first().evaluate((m) => m.remove());

  // ---- a long press
  await press(page, byTid(page, "lp-target"));
  expect(await state("lp-target") === "idle", "a tap counted as a long press");
  await longPress(page, byTid(page, "lp-target"));
  expect(await until(async () => (await state("lp-target")) === "long"), "longPress did not hold long enough");

  // ---- drags: a finger is held first, a mouse starts at once
  const pad = byTid(page, "drag-pad"), zone = byTid(page, "drag-zone");
  await dragTo(page, pad, zone);
  expect(await until(async () => (await state("drag-pad")) === "dropped"), `dragTo did not drop the pad in the zone: it is ${await state("drag-pad")}`);
  const d = await pointerDragger(page);
  await d.start(pad);
  expect(await state("drag-pad") === "dragging", `the drag has not begun after start(): ${await state("drag-pad")}`);
  await d.move({ x: 300, y: (await pad.boundingBox()).y + 20 });
  const dx = Number(await pad.getAttribute("data-dx"));
  expect(dx > 100, `the pad followed the pointer by ${dx} px, not by 100 or more`);
  await d.cancel();
  expect(await until(async () => (await state("drag-pad")) === "cancelled"), `cancel() did not cancel the drag: ${await state("drag-pad")}`);
  if (touch) {
    await page.evaluate(() => { document.getElementById("pad").dataset.state = "idle"; });
    await touchDrag(page, pad, zone, { hold: 0 });
    expect(await state("drag-pad") === "idle", `a finger that moves at once started a drag that wants a long press: ${await state("drag-pad")}`);
  }
  expect(layout === layoutNow(page), "the layout changed under the check");

  // ---- the layout follows the window
  if (viewport === "desktop") {
    await page.setViewportSize({ width: 600, height: 800 });
    expect(await until(() => layoutNow(page) === "phone"), "layoutNow does not follow a resize");
    await until(() => page.evaluate(() => !document.getElementById("back").hidden)); // (the stand-in has drawn the stack)
    await openChat(page, "c_plain"); // (the phone's path now: the stand-in drew the stack at the resize)
    expect(!await byTid(page, IDS.home).first().isVisible() && !await byTid(page, IDS.tree).first().isVisible(), "after a resize to the phone's width a list is still on screen with a chat open");
    expect(await back(page), "back did nothing after a resize to the phone's width");
  }
}, { viewports, page: { wait: '[data-testid="app-root"]' } });
