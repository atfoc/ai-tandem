// UX.S2-servers (ux-improvements package S2, chunk S2-9): the phone's Servers screens against the board's mockups "03 Servers" (dl-03a to dl-03d),
// "04 Add a server" (dl-04a to dl-04e), "05 Certificate changed" (dl-05a to dl-05d) and "13 Server sheet" (sh2-13a), on the mock's UXS2 seed
// (dev/mock-ui.js: Build box and Home lab connected, Attic server unreachable "connection refused", Cert box with a changed certificate,
// Old Mini too old, Slow link connecting). Phone only: the wide layouts keep the Servers dialog (L7). Each scenario opens a page of its own
// (`ONLY=list` runs one, as L7's `ONLY=add`); the names:
//   list           03a: A–Z by name, each row's `word`, its second line (the host in mono, "Unreachable · connection refused", "Too old · update it",
//                  "Certificate changed · paused" and nothing after), rows of 64 pt, "+ Add server" last and the bar's "+", a press pushes the detail
//   detail         03b to 03d, 05b: Build box (address with Copy, version, agent chips, the certificate row that pushes the certificate, Test connection
//                  answering in place), Attic server (why, numbered tries, Test again), Old Mini (both versions, how to update), Cert box (the danger
//                  notice, Compare fingerprints, no "Last connected", no second header line), Slow link; the header's word is the list's
//   remove         P4 naming the server and saying nothing is deleted there; Cancel keeps it; the confirm sends servers.remove and pops to the list
//   sheet          13a: the server's sheet (`window.__aiwbServers.openServerSheet`), ServerFacts with place=sheet, its rows, a test in place, closing
//   edit           P3: starts from the entry, the secret empty, Save off until a change, a rename alone is saved (servers.edit with the name only)
//   add-match      04a, 04c, 04d: Choose how (paste "In clipboard", manual, help; scan only where a camera exists), the clipboard's setup text fills the
//                  form, the secret is dots and nowhere in the page, the test (pin = the code's fingerprint) shows the green fingerprint, Trust and save
//   add-mismatch   04e: every block red, "In the code: …", no way to trust, Save off, only Cancel, servers.add never called
//   add-manual     the typed form: its fields, Test connection off until the form is valid
//   cert-paste     05c: the command and Copy, the certificate in 16 red blocks and the old one muted, "Or paste its code instead": a code with
//                  another fingerprint is refused in words and sends no servers.accept, one with the presented one trusts with no P4
//   cert-trust     05c, 05d: "Trust the new certificate…" asks first (P4: "Trust and reconnect" sends servers.accept), Cancel sends nothing, Not now pops
// A screenshot of each state is kept in OUT (default /tmp/aiwb-ux-s2-servers) and its path is noted.
//
// Run: `cd web && VIEWPORT=phone npm run uicheck -- UX.S2-servers`, or `ONLY=add-match node web/dev/checks/UX.S2-servers.mjs`.
import fs from "node:fs";
import path from "node:path";
import { atRest, check, mockEval, seed, until } from "../shot.mjs";
import { CERT_NOW, CERT_OLD, BUILD, IDS, IMPOSTOR, STUDIO, STUDIO_CODE, STUDIO_SECRET } from "./srv.mjs";
import { act, back, byTid, press } from "./sel.mjs";

export const viewports = ["phone"];

const WAIT = 15000;
const OUT = process.env.OUT || "/tmp/aiwb-ux-s2-servers";
const J = JSON.stringify;
const flat = (fp) => String(fp ?? "").replace(/[:\s]/g, "").toUpperCase();
/** The 16 blocks of 4 digits of a fingerprint of 32 pairs. */
const blocksOf = (fp) => flat(fp).match(/.{4}/g) ?? [];
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
/** What the screens write (facts.ts WORDS, written out here: a change of their words is a change of the mockup). */
const SAY = {
  removeBody: (n) => `Nothing is deleted or stopped on ${n}`,
  added: (n) => `${n} added · its chats are in your list`,
  trustTitle: (n) => `Trust the new certificate of “${n}”?`,
};

await check("UX.S2-servers the phone's Servers screens: list, detail, sheet, remove, edit, add, certificate", async ({ url, open, fail, note }) => {
  const only = process.env.ONLY;
  fs.mkdirSync(OUT, { recursive: true });
  const shots = [];
  const asked = (op) => mockEval(`return appCalls.filter((c) => c.op === ${J(op)});`, url);
  const say = (n, m) => fail(`${n}: ${m}`);

  /** Each scenario: the UXS2 seed, a page at the phone with the clipboard allowed, the body, and the mock put back (knobs and the entries a scenario added). */
  const run = async (name, body) => {
    if (only && only !== name) return;
    await seed(url, "UXS2");
    await mockEval("appCalls.length = 0; delete flags.certs; delete flags.app;", url);
    const { ctx, page } = await open({ sel: {} });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const n = name;
    const T = (id, data) => byTid(page, id, data);
    const top = (id, data) => byTid(page, id, data).last();
    const shown = (loc, ms = WAIT) => until(() => loc.first().isVisible().catch(() => false), ms);
    const gone = (loc, ms = WAIT) => until(async () => !(await loc.first().isVisible().catch(() => false)), ms);
    const text = async (loc) => squash(await loc.first().innerText().catch(() => ""));
    const expectShown = async (what, loc) => { if (!await shown(loc)) { say(n, `${what} is not drawn`); return false; } return true; };
    const shot = async (state) => {
      await atRest(page, 6).catch(() => {});
      const file = path.join(OUT, `UX.S2-servers-phone-${state}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
    };
    /** The rows of the list as the page draws them. */
    const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="srv-row"]')].map((e) => {
      const r = e.getBoundingClientRect();
      return { server: e.dataset.server, word: e.dataset.word, text: e.innerText.replace(/\s+/g, " ").trim().replace(/^! /, ""), h: r.height, y: r.y, bottom: r.bottom };
    }));
    /** The word the header of the screen on top says (the key of its `state-word`). */
    const headWord = async () => (await top("srv-head").locator('[data-testid="state-word"]').first().getAttribute("data-word").catch(() => null));
    const fpOf = async (id, tone) => {
      const loc = top(id, tone ? { tone } : undefined);
      if (!await shown(loc)) return null;
      return { tone: await loc.getAttribute("data-tone"), blocks: await loc.locator('[data-testid="srv-fp-block"]').allTextContents() };
    };
    const sameBlocks = (got, want) => !!got && J(got.blocks.map((b) => b.trim())) === J(blocksOf(want));
    const confirmWords = async () => ({
      title: await text(T("confirm-title")), body: await text(T("confirm-body")), go: await text(T("confirm-go")), cancel: await text(T("confirm-cancel")),
    });
    const pushedOnTop = (screen) => shown(T("pushed-screen", { screen }).last());
    const toast = async () => text(T("toast"));
    /** The click path to a server's detail: the list, then its row. */
    const toDetail = async (id) => {
      if (!await shown(top("srv-list"))) await act(page, "srv-list");
      await press(page, T("srv-row", { server: id }));
      return expectShown(`the detail of ${id}`, top("srv-facts", { server: id, place: "screen" }));
    };
    try { await body({ page, T, top, shown, gone, text, expectShown, shot, rows, headWord, fpOf, sameBlocks, confirmWords, pushedOnTop, toast, toDetail, n, say, ctx }); }
    finally {
      await ctx.close();
      await mockEval('for (const e of [...extra.servers]) if (/studio\\.local|lab\\.example/i.test(e.address ?? "")) removeServer(e.id); delete flags.certs; delete flags.app;', url).catch(() => {});
    }
  };

  // ---------------------------------------------------------------- the list (dl-03a)
  await run("list", async ({ page, T, shown, text, expectShown, shot, rows, n, say, top }) => {
    await act(page, "srv-list");
    if (!await expectShown("the list", top("srv-list"))) return;
    await until(async () => (await rows()).some((r) => r.server === IDS.slow), WAIT);
    const got = await rows();
    const seeded = got.filter((r) => Object.values(IDS).includes(r.server));
    const order = ["Attic server", "Build box", "Cert box", "Home lab", "Old Mini", "Slow link"];
    const names = (r) => [...order].find((x) => r.text.startsWith(x + " ") || r.text === x);
    if (J(seeded.map(names)) !== J(order)) say(n, `the seeded rows are ${J(seeded.map((r) => r.text))}; A–Z by name is ${J(order)}`);
    const all = got.map((r) => r.text);
    const sorted = [...all].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    if (J(all) !== J(sorted)) say(n, `the rows are not A–Z by name: ${J(all)}`);
    const want = {
      s_build: ["connected", "Build box Connected · build-box.example"],
      s_home: ["connected", "Home lab Connected · home-lab.example"],
      s_attic: ["unreachable", "Attic server Unreachable · connection refused"],
      s_mini: ["too-old", "Old Mini Too old · update it"],
      s_certbox: ["cert-changed", "Cert box Certificate changed · paused"],
      s_slow: ["connecting", "Slow link Connecting… · slow-link.example"],
    };
    for (const r of seeded) {
      const [word, line] = want[r.server];
      if (r.word !== word) say(n, `${r.server}: the row's word is ${J(r.word)}, not ${J(word)}`);
      if (r.text !== line) say(n, `${r.server}: the row reads ${J(r.text)}, not ${J(line)}`);
      if (r.h < 64 - 0.5) say(n, `${r.server}: the row is ${r.h.toFixed(1)} pt tall, under 64`);
    }
    // the host is in the mono type, a reason is not
    const fonts = await page.evaluate(() => {
      const font = (sel, txt) => { const e = [...document.querySelectorAll(sel + " *")].find((x) => x.children.length === 0 && x.textContent.trim() === txt); return e ? getComputedStyle(e).fontFamily : null; };
      return {
        host: font('[data-testid="srv-row"][data-server="s_build"]', "build-box.example"),
        name: font('[data-testid="srv-row"][data-server="s_build"]', "Build box"),
        reason: font('[data-testid="srv-row"][data-server="s_attic"]', "connection refused"),
      };
    });
    if (!fonts.host || fonts.host === fonts.name) say(n, `the host is not in the mono type (${J(fonts)})`);
    if (fonts.reason && fonts.reason !== fonts.name) say(n, `the reason is not in the normal type (${J(fonts)})`);
    // "+ Add server" at the end, the bar's "+"
    const add = await expectShown('"+ Add server"', T("srv-add"));
    if (add) {
      const box = await T("srv-add").first().boundingBox(), lastBottom = Math.max(...got.map((r) => r.bottom));
      if (box.y < lastBottom - 1) say(n, `"+ Add server" (y ${Math.round(box.y)}) is not under the last row (bottom ${Math.round(lastBottom)})`);
      if (!/Add server/.test(await text(T("srv-add")))) say(n, `the add row says ${J(await text(T("srv-add")))}`);
    }
    await expectShown('the bar\'s "+"', T("srv-plus"));
    if (await T("srv-row", { server: IDS.certbox }).locator('button:visible, [role="button"] [role="button"]').count()) say(n, "a row has a button of its own: rows have none (03a callout 3)");
    await shot("list");
    // a press pushes the detail
    await press(page, T("srv-row", { server: IDS.build }));
    if (await expectShown("the detail of Build box after a row press", top("srv-facts", { server: IDS.build, place: "screen" }))) {
      if (!await shown(T("srv-list").first())) { /* (under the detail the list may be unmounted: not asserted) */ }
    }
  });

  // ---------------------------------------------------------------- the detail of each state (dl-03b, dl-03d, dl-05b)
  await run("detail", async ({ page, T, top, shown, gone, text, expectShown, shot, rows, headWord, fpOf, sameBlocks, n, say, toDetail }) => {
    await act(page, "srv-list");
    await until(async () => (await rows()).length >= 6, WAIT);
    const listWord = Object.fromEntries((await rows()).map((r) => [r.server, r.word]));
    const headIs = async (id) => {
      const w = await until(async () => (await headWord()) === listWord[id], 6000);
      if (!w) say(n, `${id}: the header says ${J(await headWord())}, the list ${J(listWord[id])}`);
    };

    // -- Build box: connected (03b)
    if (!await toDetail(IDS.build)) return;
    await headIs(IDS.build);
    const head = await text(top("srv-head"));
    if (!/Build box/.test(head) || !/Connected/.test(head)) say(n, `Build box: the header reads ${J(head)}`);
    if (!/build-box\.example:4790/.test(await text(top("srv-address")))) say(n, `Build box: the address cell reads ${J(await text(top("srv-address")))}`);
    const copy = top("srv-copy");
    if (await expectShown("Build box: Copy", copy)) {
      const b = await copy.boundingBox();
      if (b.width < 43.5 || b.height < 43.5) say(n, `Build box: Copy is ${b.width}×${b.height}, under 44×44`);
    }
    if (!/1\.8\.2/.test(await text(top("srv-version")))) say(n, `Build box: the version cell reads ${J(await text(top("srv-version")))}`);
    const agents = await text(top("srv-agents"));
    if (!/Claude/i.test(agents) || !/Cursor/i.test(agents)) say(n, `Build box: the agent chips read ${J(agents)}`);
    await shot("detail-connected");
    // Test connection answers in place
    const test = top("srv-test");
    if (await expectShown("Build box: Test connection", test)) {
      if (!/Test connection/.test(await text(test))) say(n, `Build box: the test cell says ${J(await text(test))}`);
      await press(page, test);
      if (!await shown(top("srv-result", { ok: "true" }))) say(n, "Build box: the test left no result with ok=true in place");
      else if (!/Reached/.test(await text(top("srv-result")))) say(n, `Build box: the result reads ${J(await text(top("srv-result")))}`);
      if (!await until(async () => /Checked just now/.test(await text(top("srv-head"))), 6000)) say(n, `Build box: after a test the header's second line is not "Checked just now" (${J(await text(top("srv-head")))})`);
      await shot("detail-tested");
    }
    // the certificate row pushes the certificate
    await press(page, top("srv-cert-row"));
    if (await expectShown("Build box: the certificate screen", top("srv-cert", { server: IDS.build, changed: "no" }))) {
      const fp = await fpOf("srv-fp-now");
      if (!sameBlocks(fp, BUILD)) say(n, `Build box: the certificate shows ${J(fp?.blocks)}, not the 16 blocks of ${BUILD}`);
      await shot("cert-same");
      await back(page);
      await expectShown("Build box: the detail again after the back", top("srv-facts", { server: IDS.build, place: "screen" }));
    }
    await back(page);

    // -- Attic server: unreachable (03d)
    if (await toDetail(IDS.attic)) {
      await headIs(IDS.attic);
      const why = await text(top("srv-why"));
      if (!/Connection refused/.test(why) || why.length < 40) say(n, `Attic: the why reads ${J(why)} (a title and the failed step in plain words)`);
      const tries = top("srv-tries");
      if (await expectShown("Attic: the tries", tries)) {
        const t = await text(tries);
        if (!/1\b/.test(t) || !/2\b/.test(t)) say(n, `Attic: the tries are not numbered: ${J(t)}`);
        if (!/Test again\. Its chats come back by themselves\./.test(t)) say(n, `Attic: the last try does not end with "Test again. Its chats come back by themselves." (${J(t)})`);
      }
      const again = top("srv-test");
      if (await expectShown("Attic: Test again", again)) {
        if (!/Test again/.test(await text(again))) say(n, `Attic: the button says ${J(await text(again))}, not "Test again"`);
        await shot("detail-unreachable");
        await press(page, again);
        if (!await shown(top("srv-result"))) say(n, "Attic: Test again left no result in place");
      }
      await back(page);
    }

    // -- Old Mini: too old (03d's amber)
    if (await toDetail(IDS.mini)) {
      await headIs(IDS.mini);
      const upd = await text(top("srv-update"));
      if (!/0\.9\.1/.test(upd) || !/this app is/.test(upd)) say(n, `Old Mini: the update text has not both versions: ${J(upd)}`);
      if (!/Update AI Whiteboard on Old Mini/.test(upd)) say(n, `Old Mini: the update text does not say how to update: ${J(upd)}`);
      await expectShown("Old Mini: Test again", top("srv-test"));
      await shot("detail-too-old");
      await back(page);
    }

    // -- Cert box: certificate changed (05b)
    if (await toDetail(IDS.certbox)) {
      await headIs(IDS.certbox);
      const notice = top("srv-cert-notice");
      if (await expectShown("Cert box: the danger notice", notice)) {
        const t = await text(notice);
        if (!/The server’s certificate changed|The server's certificate changed/.test(t)) say(n, `Cert box: the notice title reads ${J(t)}`);
        if (!/renewed/i.test(t) || !/posing/i.test(t)) say(n, `Cert box: the notice does not name both readings (renewed, someone posing): ${J(t)}`);
        if ((await notice.getAttribute("role")) !== "alert") say(n, "Cert box: the notice is not an alert");
      }
      const lines = (await top("srv-head").innerText()).split("\n").map(squash).filter(Boolean);
      if (lines.length !== 2) say(n, `Cert box: the header has ${lines.length} lines (${J(lines)}), not the name and the word alone (05b: no second line)`);
      if (await T("srv-since").count()) say(n, "Cert box: a second header line (srv-since) is drawn");
      if (/Last connected/i.test(await page.evaluate(() => document.body.innerText))) say(n, 'Cert box: the page says "Last connected", a time the app does not know');
      if (await top("srv-test").count()) say(n, "Cert box: Test connection is offered while the certificate is undecided");
      await shot("detail-cert");
      await press(page, top("srv-compare"));
      if (await expectShown("Cert box: the certificate screen after Compare fingerprints", top("srv-cert", { server: IDS.certbox, changed: "yes" }))) {
        await shot("cert-changed");
        await back(page);
        await expectShown("Cert box: the detail after the back", top("srv-facts", { server: IDS.certbox, place: "screen" }));
      }
      await back(page);
    }

    // -- Slow link: connecting
    if (await toDetail(IDS.slow)) {
      await headIs(IDS.slow);
      const h = await text(top("srv-head"));
      if (!/Slow link/.test(h) || !/Connecting/.test(h)) say(n, `Slow link: the header reads ${J(h)}`);
      await shot("detail-connecting");
      await back(page);
    }
  });

  // ---------------------------------------------------------------- remove (P4, dl-03c)
  await run("remove", async ({ page, T, top, shown, gone, text, expectShown, shot, rows, confirmWords, n, say, toDetail }) => {
    if (!await toDetail(IDS.home)) return;
    const remove = top("srv-remove");
    if (!await expectShown("the Remove server… cell", remove)) return;
    if (!/Remove server…/.test(await text(remove))) say(n, `the cell says ${J(await text(remove))}`);
    await press(page, remove);
    if (!await expectShown("the confirm sheet", T("confirm-dialog"))) return;
    const w = await confirmWords();
    if (!w.title.includes("Home lab")) say(n, `the question does not name the server: ${J(w.title)}`);
    if (!w.body.includes(SAY.removeBody("Home lab"))) say(n, `the body does not say that nothing is deleted there: ${J(w.body)}`);
    if (!w.go.includes("Remove") || !w.go.includes("Home lab")) say(n, `the red action does not repeat verb and noun: ${J(w.go)}`);
    if (!/Cancel/.test(w.cancel)) say(n, `the other button says ${J(w.cancel)}`);
    await shot("remove-confirm");
    await press(page, T("confirm-cancel"));
    await gone(T("confirm-dialog"));
    if ((await asked("servers.remove")).length) say(n, "Cancel sent servers.remove");
    if (!await shown(top("srv-facts", { server: IDS.home, place: "screen" }))) say(n, "Cancel left the detail");
    await press(page, top("srv-remove"));
    await expectShown("the confirm sheet again", T("confirm-dialog"));
    await press(page, T("confirm-go"));
    if (!await until(async () => (await asked("servers.remove")).length === 1, WAIT)) return say(n, "the confirm sent no servers.remove");
    const calls = await asked("servers.remove");
    if (calls[0].args?.id !== IDS.home) say(n, `servers.remove was sent with ${J(calls[0].args)}, not the id ${IDS.home}`);
    if (!await shown(top("srv-list"))) say(n, "after the removal the list is not on top");
    if (!await gone(T("srv-facts", { server: IDS.home }))) say(n, "the removed server's detail is still drawn");
    if (!await until(async () => !(await rows()).some((r) => r.server === IDS.home), WAIT)) say(n, "the list still has the row of the removed server");
    await shot("remove-done");
  });

  // ---------------------------------------------------------------- the server's sheet (sh2-13a)
  await run("sheet", async ({ page, T, top, shown, gone, text, expectShown, shot, n, say, pushedOnTop }) => {
    if (!await until(() => page.evaluate(() => !!window.__aiwbServers), WAIT)) return say(n, "the uicheck build has no seam (window.__aiwbServers)");
    await page.evaluate(() => window.__aiwbServers.openServerSheet("s_build"));
    if (!await expectShown("the sheet", T("srv-sheet"))) return;
    const facts = T("srv-facts", { server: IDS.build, place: "sheet" });
    if (!await expectShown("the sheet's body (srv-facts place=sheet)", facts)) return;
    const head = await text(facts);
    for (const part of ["Build box", "Connected", "version 1.8.2", "build-box.example:4790"]) if (!head.includes(part)) say(n, `the sheet's head lacks ${J(part)}: ${J(head)}`);
    const names = await T("srv-sheet-row").evaluateAll((els) => els.map((e) => e.dataset.row));
    if (J(names) !== J(["name", "cert", "settings"])) say(n, `the sheet's rows are ${J(names)}, not name, cert, settings`);
    if (!/Test connection/.test(await text(T("srv-sheet").locator('[data-testid="srv-test"]')))) say(n, "the sheet has no Test connection");
    if (!/Remove server/.test(await text(T("srv-sheet").locator('[data-testid="srv-remove"]')))) say(n, "the sheet has no Remove server");
    for (const bad of ["New chat", "New whiteboard", "Hide"]) if ((await text(T("srv-sheet"))).includes(bad)) say(n, `the sheet offers ${J(bad)} (13a callout 6: none here)`);
    await shot("sheet");
    await press(page, T("srv-sheet").locator('[data-testid="srv-test"]'));
    if (!await shown(T("srv-sheet").locator('[data-testid="srv-result"][data-ok="true"]'))) say(n, "the sheet's test left no result in place");
    await shot("sheet-tested");
    // closing: a press on the dimmed page
    await page.mouse.click(196, 40);
    if (!await gone(T("srv-sheet"))) say(n, "a press outside did not close the sheet");
    // "Server settings" pushes the detail and the sheet leaves
    await page.evaluate(() => window.__aiwbServers.openServerSheet("s_build"));
    await expectShown("the sheet again", T("srv-sheet"));
    await press(page, T("srv-sheet-row", { row: "settings" }));
    if (!await shown(top("srv-facts", { server: IDS.build, place: "screen" }))) say(n, '"Server settings" did not push the detail');
    if (!await gone(T("srv-sheet"))) say(n, "the sheet stayed over the detail it pushed");
  });

  // ---------------------------------------------------------------- edit (P3)
  await run("edit", async ({ page, T, top, shown, gone, text, expectShown, shot, n, say, toDetail }) => {
    if (!await toDetail(IDS.build)) return;
    await press(page, T("srv-edit"));
    if (!await expectShown("the edit form", T("srv-edit-form"))) return;
    const field = (f) => T("srv-edit-field", { field: f });
    const name = await field("name").inputValue(), address = await field("address").inputValue(), secret = await field("secret").inputValue();
    if (name !== "Build box") say(n, `the name starts as ${J(name)}`);
    if (address !== "https://build-box.example:4790") say(n, `the address starts as ${J(address)}`);
    if (secret !== "") say(n, "the secret does not start empty");
    const save = T("sheet-right");
    const off = async () => (await save.first().getAttribute("aria-disabled")) === "true";
    if (!await off()) say(n, "Save is on before anything changed");
    await shot("edit");
    await field("name").fill("Build box 2");
    if (!await until(async () => !(await off()), 6000)) say(n, "Save stays off after a rename");
    await press(page, save);
    if (!await until(async () => (await asked("servers.edit")).length === 1, WAIT)) return say(n, "Save sent no servers.edit");
    const call = (await asked("servers.edit"))[0];
    const patch = call.args?.patch ?? {};
    if (call.args?.id !== IDS.build || J(Object.keys(patch)) !== J(["name"]) || patch.name !== "Build box 2") say(n, `servers.edit was sent as ${J(call.args)}: a rename sends the name alone`);
    if ((await asked("servers.test")).length) say(n, "a rename was tested first");
    if (!await gone(T("srv-edit-form"))) say(n, "the form stays open after a saved rename");
    // the pushed bar's title follows the rename (PushedRoute reads it through useStore)
    if (!await until(async () => /Build box 2/.test(await text(T("bar-title").last())), 6000)) say(n, `the bar still says ${J(await text(T("bar-title").last()))} after the rename (the detail says ${J((await text(top("srv-facts", { server: IDS.build, place: "screen" }))).slice(0, 80))})`);
    await shot("edit-saved");
  });

  // ---------------------------------------------------------------- add: the certificate matches the code (dl-04a, dl-04c, dl-04d)
  await run("add-match", async ({ page, T, top, shown, gone, text, expectShown, shot, rows, fpOf, sameBlocks, n, say, toast }) => {
    await mockEval(`flags.certs = { "studio.local": ${J(STUDIO)} };`, url);
    await page.evaluate((t) => navigator.clipboard.writeText(t), STUDIO_CODE);
    await act(page, "srv-list");
    await press(page, T("srv-plus"));
    if (!await expectShown("Choose how", T("add-choose"))) return;
    const readActions = () => T("action-row").evaluateAll((els) => els.map((e) => ({ action: e.dataset.action, tag: e.dataset.tag ?? "" })));
    // the tag comes after the screen's own peek at the clipboard (async), not with the first draw
    await until(async () => (await readActions()).find((a) => a.action === "paste")?.tag === "In clipboard", WAIT);
    const actions = await readActions();
    const ways = actions.map((a) => a.action);
    if (ways.includes("scan")) say(n, "the web build offers Scan QR code (no camera here)");
    for (const w of ["paste", "manual", "help"]) if (!ways.includes(w)) say(n, `Choose how has no ${w} row (${J(ways)})`);
    if (actions.find((a) => a.action === "paste")?.tag !== "In clipboard") say(n, `the paste row is not tagged "In clipboard" while the clipboard holds a setup text (${J(actions)})`);
    await shot("add-choose");
    await press(page, T("action-row", { action: "help" }));
    if (await expectShown("the help notice", T("add-help"))) {
      await shot("add-help");
      await press(page, T("add-help").getByRole("button", { name: "Close" }));
      await expectShown("Choose how after the help", T("add-choose"));
    }
    await press(page, T("action-row", { action: "paste" }));
    if (!await expectShown("the form (check)", T("add-form", { step: "check" }))) return;
    await expectShown('"Filled in from the code"', T("add-filled"));
    const nameBox = T("add-field", { field: "name" });
    const name = await nameBox.inputValue();
    if (!name) say(n, "the name is empty after a code");
    if (await nameBox.isDisabled()) say(n, "the name is not editable");
    const sheetText = await text(T("add-form-sheet"));
    if (!/●●●/.test(sheetText)) say(n, "the secret is not shown as dots");
    if (!/from the code/.test(sheetText)) say(n, 'the secret does not say "from the code"');
    if (!sheetText.includes("studio.local")) say(n, `the address is not shown: ${J(sheetText)}`);
    const leak = await page.evaluate((s) => document.documentElement.outerHTML.includes(s) || document.body.innerText.includes(s) || [...document.querySelectorAll("input,textarea")].some((i) => i.value.includes(s)), STUDIO_SECRET);
    if (leak) say(n, "the secret's text is in the page");
    const save = T("sheet-right"), test = T("add-test");
    const off = async (l) => (await l.first().getAttribute("aria-disabled")) === "true";
    if (!await off(save)) say(n, "Save in the head is on before the test");
    await shot("add-check");
    await press(page, test);
    if (!await expectShown("the trust step", T("add-form", { step: "trust" }))) return;
    if (!await expectShown("the match line", T("add-match", { match: "yes" }))) return;
    const fp = await fpOf("srv-fp-now", "ok");
    if (!fp) say(n, "the fingerprint is not drawn in the ok tone");
    else if (fp.blocks.length !== 16) say(n, `the fingerprint has ${fp.blocks.length} blocks, not 16`);
    if (!sameBlocks(fp, STUDIO)) say(n, `the fingerprint shows ${J(fp?.blocks)}, not the code's`);
    const sent = (await asked("servers.test"))[0]?.args?.form;
    if (!sent) say(n, "the test sent no servers.test");
    else {
      if (flat(sent.pin) !== flat(STUDIO)) say(n, `the test's pin is ${J(sent.pin)}, not the code's fingerprint`);
      if (sent.selfSigned !== true) say(n, `the test's selfSigned is ${J(sent.selfSigned)}`);
      if (sent.secret !== `<${STUDIO_SECRET.length} characters>`) say(n, `the test's secret is ${J(sent.secret)}, not the code's (${STUDIO_SECRET.length} characters)`);
    }
    if (await off(save)) say(n, "Save in the head stays off after a passed test");
    await shot("add-trust");
    const trust = T("add-trust");
    if (!/Trust and save/.test(await text(trust))) say(n, `the button says ${J(await text(trust))}`);
    await press(page, trust);
    if (!await until(async () => (await asked("servers.add")).length === 1, WAIT)) return say(n, "Trust and save sent no servers.add");
    const added = (await asked("servers.add"))[0].args?.form ?? {};
    if (flat(added.pin) !== flat(STUDIO)) say(n, `servers.add was sent with the pin ${J(added.pin)}, not the code's`);
    if (!await gone(T("add-form-sheet"))) say(n, "the sheet stays open after Trust and save");
    if (!await until(async () => (await toast()).includes(SAY.added(name)), 8000)) say(n, `the toast reads ${J(await toast())}, not ${J(SAY.added(name))}`);
    await shot("add-done");
    if (!await until(async () => (await rows()).some((r) => r.text.startsWith(name + " ")), WAIT)) say(n, `the list has no row for ${J(name)} after the save`);
  });

  // ---------------------------------------------------------------- add: the certificate is not the code's (dl-04e)
  await run("add-mismatch", async ({ page, T, shown, gone, text, expectShown, shot, fpOf, sameBlocks, n, say }) => {
    await mockEval(`flags.certs = { "studio.local": ${J(IMPOSTOR)} };`, url);
    await page.evaluate((t) => navigator.clipboard.writeText(t), STUDIO_CODE);
    await act(page, "srv-list");
    await press(page, T("srv-plus"));
    if (!await expectShown("Choose how", T("add-choose"))) return;
    await press(page, T("action-row", { action: "paste" }));
    if (!await expectShown("the form (check)", T("add-form", { step: "check" }))) return;
    await press(page, T("add-test"));
    if (!await expectShown("the mismatch step", T("add-form", { step: "mismatch" }))) return;
    await expectShown("the no-match line", T("add-match", { match: "no" }));
    const fp = await fpOf("srv-fp-now", "bad");
    if (!fp) say(n, "the presented fingerprint is not drawn in the bad tone");
    else if (fp.blocks.length !== 16) say(n, `the fingerprint has ${fp.blocks.length} blocks, not 16`);
    if (!sameBlocks(fp, IMPOSTOR)) say(n, `the fingerprint shows ${J(fp?.blocks)}, not the one presented`);
    const body = await text(T("add-form-sheet"));
    if (!body.includes("In the code: C41E 9B07 … E3F1")) say(n, `the sheet does not show "In the code: C41E 9B07 … E3F1": ${J(body)}`);
    if (!/Does NOT match the code/.test(body)) say(n, "the sheet does not say the certificate does NOT match");
    if (!/Nothing secret was sent/.test(body)) say(n, "the sheet does not say nothing secret was sent");
    const buttons = await T("add-form-sheet").locator("[role=button]").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.innerText).trim()));
    const offenders = buttons.filter((b) => /trust|accept|save/i.test(b) && b !== "Save");
    if (offenders.length) say(n, `the mismatch offers ${J(offenders)}: no way to trust it (04e callout 3)`);
    if (await T("add-trust").count()) say(n, "add-trust is drawn on a mismatch");
    if ((await T("sheet-right").first().getAttribute("aria-disabled")) !== "true") say(n, "Save in the head is on on a mismatch");
    if (!await shown(T("add-cancel"))) say(n, "there is no Cancel");
    const bodyButtons = await T("add-form").locator("[role=button]").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? e.innerText).trim()));
    if (J(bodyButtons) !== J(["Cancel"])) say(n, `the body's buttons are ${J(bodyButtons)}, not Cancel alone`);
    await shot("add-mismatch");
    if ((await asked("servers.add")).length) say(n, "servers.add was sent on a mismatch");
    await press(page, T("add-cancel"));
    if (!await gone(T("add-form-sheet"))) say(n, "Cancel did not close the sheet");
    if ((await asked("servers.add")).length) say(n, "servers.add was sent after Cancel");
  });

  // ---------------------------------------------------------------- add: typed
  await run("add-manual", async ({ page, T, top, shown, gone, text, expectShown, shot, n, say }) => {
    await act(page, "srv-list");
    await press(page, T("srv-plus"));
    if (!await expectShown("Choose how", T("add-choose"))) return;
    await press(page, T("action-row", { action: "manual" }));
    if (!await expectShown("the form (manual)", T("add-form", { step: "manual" }))) return;
    for (const f of ["name", "address", "secret"]) if (!await shown(T("add-field", { field: f }))) say(n, `the ${f} field is not drawn`);
    if (!await shown(T("add-selfsigned"))) say(n, "the self-signed switch is not drawn");
    const test = T("add-test"), off = async () => (await test.first().getAttribute("aria-disabled")) === "true";
    if (!await off()) say(n, "Test connection is on before anything is typed");
    await shot("add-manual");
    await T("add-field", { field: "name" }).fill("Lab");
    await T("add-field", { field: "address" }).fill("https://lab.example:4790");
    if (!await off()) say(n, "Test connection is on while the secret is missing");
    await T("add-field", { field: "secret" }).fill("a-secret");
    if (!await until(async () => !(await off()), 6000)) say(n, "Test connection stays off for a valid form");
    if ((await T("sheet-right").first().getAttribute("aria-disabled")) !== "true") say(n, "Save in the head is on before a test passed");
    await shot("add-manual-filled");
  });

  // ---------------------------------------------------------------- the certificate screen: compare by a pasted code (dl-05c)
  const codeFor = (fp) => `Addresses:\n  https://cert-box.example:4790\nFingerprint: ${fp}\nSecret: ${STUDIO_SECRET}\n`;
  await run("cert-paste", async ({ page, T, top, shown, gone, text, expectShown, shot, fpOf, sameBlocks, n, say, toast }) => {
    await act(page, "srv-cert:s_certbox");
    if (!await expectShown("the certificate screen", top("srv-cert", { server: IDS.certbox, changed: "yes" }))) return;
    const now = await fpOf("srv-fp-now", "bad");
    if (!now) say(n, "the fingerprint presented now is not in the bad tone");
    else if (now.blocks.length !== 16) say(n, `the fingerprint presented now has ${now.blocks.length} blocks, not 16`);
    if (!sameBlocks(now, CERT_NOW)) say(n, `the fingerprint presented now shows ${J(now?.blocks)}, not CERT_NOW`);
    const old = await fpOf("srv-fp-old", "muted");
    if (!old) say(n, "the old fingerprint is not muted");
    if (!sameBlocks(old, CERT_OLD)) say(n, `the old fingerprint shows ${J(old?.blocks)}, not CERT_OLD`);
    const cmd = top("srv-command");
    if (!/ai-whiteboard remote status/.test(await text(cmd))) say(n, `the command reads ${J(await text(cmd))}`);
    const copy = cmd.getByRole("button", { name: "Copy command" });
    if (!await shown(copy)) say(n, "the command has no Copy");
    else {
      await press(page, copy);
      const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
      if (clip !== null && clip.trim() !== "ai-whiteboard remote status") say(n, `Copy put ${J(clip)} on the clipboard`);
    }
    if (await T("srv-scan-compare").count()) say(n, "the web build offers the scan");
    await shot("cert-changed-compare");
    await press(page, top("srv-paste-compare"));
    const box = T("servers-input", { field: "code" });
    if (!await expectShown("the paste box", box)) return;
    await shot("cert-paste-box");
    await box.fill(codeFor(IMPOSTOR));
    // (the fill is a paste: it compares at once; the button is the same call for a text that came key by key)
    if (!await shown(top("srv-scan-mismatch"), 4000)) {
      const read = top("srv-paste-read");
      if (await read.count()) await press(page, read);
    }
    if (!await expectShown("the mismatch line", top("srv-scan-mismatch"))) return;
    if (!/does not match/.test(await text(top("srv-scan-mismatch")))) say(n, `the mismatch reads ${J(await text(top("srv-scan-mismatch")))}`);
    await shot("cert-paste-mismatch");
    if ((await asked("servers.accept")).length) say(n, "a code with another fingerprint sent servers.accept");
    if (await T("confirm-sheet").count()) say(n, "a P4 opened for a mismatch");
    // a code with the fingerprint presented: the check was made, no P4
    await press(page, top("srv-paste-compare"));
    const box2 = T("servers-input", { field: "code" });
    if (!await expectShown("the paste box again", box2)) return;
    await box2.fill(codeFor(CERT_NOW));
    if (!await until(async () => (await asked("servers.accept")).length === 1, 4000)) {
      const read = top("srv-paste-read");
      if (await read.count()) await press(page, read);
    }
    if (!await until(async () => (await asked("servers.accept")).length === 1, WAIT)) return say(n, "a code with the presented fingerprint sent no servers.accept");
    const call = (await asked("servers.accept"))[0].args ?? {};
    if (call.id !== IDS.certbox || flat(call.fingerprint) !== flat(CERT_NOW)) say(n, `servers.accept was sent as ${J(call)}, not ${IDS.certbox} with CERT_NOW`);
    if (await T("confirm-sheet").count()) say(n, "a P4 opened after a matching code: the check was made (05d)");
    if (!await gone(T("srv-cert"))) say(n, "the certificate screen stays after the trust");
    if (!await until(async () => /new certificate is trusted/.test(await toast()), 8000)) say(n, `no toast after the trust (${J(await toast())})`);
  });

  // ---------------------------------------------------------------- the certificate screen: trust with the question, Not now (dl-05c, dl-05d)
  await run("cert-trust", async ({ page, T, top, shown, gone, text, expectShown, shot, confirmWords, n, say }) => {
    await act(page, "srv-cert:s_certbox");
    if (!await expectShown("the certificate screen", top("srv-cert", { server: IDS.certbox, changed: "yes" }))) return;
    const trust = top("srv-trust");
    if (!/Trust the new certificate…/.test(await text(trust))) say(n, `the trust button says ${J(await text(trust))}`);
    await press(page, trust);
    if (!await expectShown("the confirm sheet", T("confirm-sheet"))) return;
    const w = await confirmWords();
    if (w.title !== SAY.trustTitle("Cert box")) say(n, `the question reads ${J(w.title)}, not ${J(SAY.trustTitle("Cert box"))}`);
    if (!w.body.includes("8B:47:1E:C2:") && !w.body.includes("8B:47:1E:C2")) say(n, `the body does not repeat the first blocks to check: ${J(w.body)}`);
    if (!w.body.includes("4B:88")) say(n, `the body does not repeat the last block to check: ${J(w.body)}`);
    if (!/sends its secret to it again/.test(w.body)) say(n, `the body does not say the secret is sent again: ${J(w.body)}`);
    if (w.go !== "Trust and reconnect") say(n, `the red action says ${J(w.go)}, not "Trust and reconnect"`);
    await shot("cert-trust-confirm");
    await press(page, T("confirm-cancel"));
    await gone(T("confirm-sheet"));
    if ((await asked("servers.accept")).length) say(n, "Cancel sent servers.accept");
    if (!await shown(top("srv-cert"))) say(n, "Cancel left the certificate screen");
    await press(page, top("srv-trust"));
    await expectShown("the confirm sheet again", T("confirm-sheet"));
    await press(page, T("confirm-go"));
    if (!await until(async () => (await asked("servers.accept")).length === 1, WAIT)) return say(n, "Trust and reconnect sent no servers.accept");
    const call = (await asked("servers.accept"))[0].args ?? {};
    if (call.id !== IDS.certbox || flat(call.fingerprint) !== flat(CERT_NOW)) say(n, `servers.accept was sent as ${J(call)}, not ${IDS.certbox} with CERT_NOW`);
    if (!await gone(T("srv-cert"))) say(n, "the certificate screen stays after the trust");
  });

  await run("cert-notnow", async ({ page, T, top, shown, gone, expectShown, n, say }) => {
    await act(page, "srv-detail:s_certbox");
    await expectShown("the detail", top("srv-facts", { server: IDS.certbox, place: "screen" }));
    await press(page, top("srv-compare"));
    if (!await expectShown("the certificate screen", top("srv-cert", { server: IDS.certbox, changed: "yes" }))) return;
    await press(page, top("srv-not-now"));
    if (!await shown(top("srv-facts", { server: IDS.certbox, place: "screen" }))) say(n, "Not now did not go back to the detail");
    if ((await asked("servers.accept")).length) say(n, "Not now sent servers.accept");
    if (!await expectShown("the notice (still paused)", top("srv-cert-notice"))) return;
  });

  for (const f of shots) note(`screenshot: ${f}`);
}, { viewports, page: false });
