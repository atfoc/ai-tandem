// L7 (new in the app, package S3): the Servers dialog, whose add and edit flows had no browser check (parity inventory, finding 8; A-SV-16 to
// A-SV-22), and the rest of A-SV and A-OW that was proved by unit tests alone (A-SV-05, the notice; A-SV-18, Enter in the form; A-SV-20, a save
// that did not pass; A-SV-23, Esc leaves the form first, the backdrop closes the list only, the focus goes back; A-SV-25, an error of the
// dialog's own calls). On the mock (dev/mock.mjs: `flags.app[op]` answers an operation as a check says, `appCalls` is what the page asked of
// the app, a secret told by its length), at desktop, tablet and phone: a centred dialog on the wide layouts, a bottom sheet on the phone.
//   the list         this computer first, each row's name, state (the twelve words, a tone), address, detail, version and agents; the app's events
//                    change a row and the list while the dialog is open; the notice; what another server said is text; buttons by row; Esc,
//                    the dimmed page and "Close" close it; the focus goes back to the button
//   tests            "Test connection" on a saved entry: the block under the row (each fact once, the step of a failure, the five steps by name; what the test
//                    found out about the server comes out as text),
//                    "Show fingerprint" then "Accept fingerprint", a changed certificate, a call that fails or is slow
//   remove           the question, its words; Esc leaves it and the dialog stays; the entry goes (and its section leaves the sidebar) and its server is told nothing
//   add              the fields, the rule's first problem as typed, Save only after an OK test of the form as it is, "Save anyway", the
//                    fingerprint to accept (the box ticked, the pin shown, the test again), Enter, a save that did not pass, the entry's
//                    first connection, the secret dropped at Cancel
//   edit             starts from the entry, the secret empty ("unchanged"), only what changed is sent, a rename alone saves with no test
//   owner's things   this computer's row: the state, the reason of a start that failed, Retry, the MCP listener's state, Restart server and its
//                    question, a restart that fails; no Edit, Remove or Test
//   readable         the dialog in each flavour (A-SV-26; the parts of the Servers dialog of dev/checks/A6.3-readable.mjs)
// The owner's things are drawn wherever the transport offers them (here the host's, `http`); a phone or a tablet app has none: its `native`
// transport does not (app/test/servers.owner.test.ts).
import { atRest, check, contrastAudit, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";
import { sectionsSeen } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const FP1 = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const FP2 = "12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0";
const LABELS = {
  connecting: "Connecting…", connected: "Connected", unreachable: "Unreachable", secret_not_accepted: "Secret not accepted", fingerprint_not_accepted: "Fingerprint not accepted",
  certificate_changed: "Certificate changed", certificate_not_accepted: "Certificate not accepted", name_not_known: "Name not known there", not_aiwb: "Not an AI Whiteboard server",
  too_old: "Too old: update the server on that machine", another_server: "Another server",
};
const TONES = { connected: "ok", connecting: "wait" };
const STEPS = ["the address", "the connection", "the certificate", "the secret and the server's answer", "the first events"];
const FLAVOURS = { latte: "light", frappe: "dark", macchiato: "dark", mocha: "dark" };
const FLOOR = 3;
const LAB = "lab-gpu-box.tailnet-1234.ts.net";
const OK = { ok: true, step: 5, outcome: "connected", message: "Connected", version: "dev", agents: ["claude", "cursor", "pi"] };
const fail1 = (step, outcome, message, more = {}) => ({ ok: false, step, outcome, message, ...more });

await check("L7 the Servers dialog: list, tests, remove, add, edit, the owner's things", async ({ url, viewport, layout, open, fail, note }) => {
  const wide = layout !== "phone";
  const said = (n, m) => fail(`${n}: ${m}`);
  const knob = (op, v) => mockEval(`(flags.app ??= {})[${JSON.stringify(op)}] = ${JSON.stringify(v)};`, url);
  const reset = () => mockEval("delete flags.app; delete flags.mcp; delete flags.start; delete flags.restart; appCalls.length = 0;", url);
  const asked = (op) => mockEval(`return appCalls.filter((c) => c.op === ${JSON.stringify(op)});`, url);
  const dialog = (page) => byTid(page, "servers-dialog");
  const rowOf = (page, name) => byTid(page, "servers-row").filter({ has: byTid(page, "servers-name").and(page.getByText(name, { exact: true })) });
  const btn = (root, name) => root.getByRole("button", { name, exact: true });
  const field = (page, f) => byTid(page, "servers-input", { field: f });
  const isOff = async (loc) => (await loc.getAttribute("aria-disabled")) === "true";
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const names = (page) => byTid(page, "servers-name").allTextContents();
  const shown = (loc) => until(() => loc.first().isVisible().catch(() => false), 15000);
  const gone = (loc) => until(async () => (await loc.count()) === 0, 15000);
  const openList = async (page) => {
    await press(page, byTid(page, "servers-btn").first());
    if (!await shown(dialog(page))) throw new Error("the Servers button opened no dialog");
    await shown(byTid(page, "servers-row"));
  };
  const only = process.env.ONLY; // ONLY=add (the section's name) runs that section alone, for a person at work
  const run = async (name, o, body) => {
    if (only && only !== name) return;
    await seed(url, "A1");
    const { ctx, page } = await open({ sel: {}, ...o });
    try { await body(page); } finally { await ctx.close(); await reset(); }
  };
  const press2 = (page, name, label) => press(page, btn(dialog(page), label)).catch((e) => { throw new Error(`${name}: no button "${label}": ${e.message.split("\n")[0]}`); });

  // ---------------------------------------------------------------- the list
  await run("list", {}, async (page) => {
    const n = "the list";
    await mockEval('extra.notice = "The list file was set aside: <b>unreadable</b>."; addServer({ id: "s_evil", name: "<img src=x onerror=1>", address: "https://evil.example:4790", state: "connected", version: "<b>9</b>", agents: ["<i>x</i>"] });', url);
    // focus: the button had it, and has it again after the dialog
    const button = byTid(page, "servers-btn").first();
    await button.focus();
    await page.keyboard.press("Enter");
    if (!await shown(dialog(page))) return said(n, "the Servers button opened no dialog");
    if (!await shown(byTid(page, "servers-row"))) return said(n, "the dialog has no row");
    if (await dialog(page).first().getAttribute("aria-label") !== "Servers") said(n, "the dialog is not named Servers for a screen reader");
    const wantNames = ["This computer", LAB, "Office Mac", "Bare box", "<img src=x onerror=1>"];
    if (!await until(async () => JSON.stringify(await names(page)) === JSON.stringify(wantNames), 10000)) said(n, `the rows are ${JSON.stringify(await names(page))}, not ${JSON.stringify(wantNames)} (this computer first, the list's order; the entry the store lacked is added when the dialog opens)`);
    // the notice, as text; no markup of another server's making
    const notice = byTid(page, "servers-notice");
    if (!await shown(notice)) said(n, "the notice at the top says nothing");
    else if (await textOf(notice) !== "The list file was set aside: <b>unreadable</b>.") said(n, `the notice reads "${await textOf(notice)}"`);
    if (await dialog(page).first().locator("img, b, i").count()) said(n, "what another server said (its name, version, agents, the notice) was drawn as markup");
    const evil = rowOf(page, "<img src=x onerror=1>");
    for (const want of ["Version <b>9</b>", "Agents: <i>x</i>"]) if (!(await textOf(evil)).includes(want)) said(n, `the row of the server with markup in its words does not read "${want}": "${await textOf(evil)}"`);
    // each row's words
    const lab = rowOf(page, LAB), off = rowOf(page, "Office Mac"), here = rowOf(page, "This computer");
    const stateOf = (row) => byTid(row, "servers-state").first();
    if (await textOf(stateOf(here)) !== "Connected" || await stateOf(here).getAttribute("data-tone") !== "ok") said(n, "this computer's row does not say Connected, in the tone of ok");
    if (await textOf(stateOf(off)) !== "Unreachable" || await stateOf(off).getAttribute("data-tone") !== "bad") said(n, "the row of a server that is not connected is not Unreachable, in the tone of bad");
    const labText = await textOf(lab);
    for (const want of ["https://" + LAB + ":4790", "Version dev", "Agents: claude, cursor, pi"]) if (!labText.includes(want)) said(n, `the row of the lab box does not say "${want}": "${labText}"`);
    if (!(await textOf(off)).includes("connection refused")) said(n, "the row of Office Mac does not give its detail");
    if (await byTid(here, "servers-addr").count()) said(n, "this computer's row has an address");
    // the buttons of each kind of row
    for (const [who, row] of [["a remote row", lab], ["a row that is not connected", off]]) for (const b of ["Test connection", "Edit", "Remove"]) if (!await btn(row, b).count()) said(n, `${who} has no "${b}"`);
    for (const b of ["Test connection", "Edit", "Remove", "Accept fingerprint", "Show fingerprint"]) if (await btn(here, b).count()) said(n, `this computer's row has "${b}"`);
    if (!await btn(here, "Restart server").count()) said(n, 'this computer\'s row has no "Restart server"');
    if (await btn(here, "Open server log").count()) said(n, 'a page that is not in the desktop app draws "Open server log"');
    if (!await btn(dialog(page), "Close").count() || !await btn(dialog(page), "Add server").count()) said(n, 'the dialog has no "Close" or "Add server"');
    // the app's events, while it is open: one entry's state, then the list
    for (const [state, label] of Object.entries(LABELS)) {
      await mockEval(`setServerState("s_off", ${JSON.stringify(state)}, ${state === "certificate_changed" ? `{ fingerprint: "${FP2}", pin: "${FP1}" }` : "{}"});`, url);
      if (!await until(async () => (await textOf(stateOf(off))) === label, 10000)) said(n, `the state ${state} reads "${await textOf(stateOf(off))}", not "${label}"`);
      const tone = TONES[state] ?? "bad";
      if (await stateOf(off).getAttribute("data-tone") !== tone) said(n, `the state ${state} has the tone ${await stateOf(off).getAttribute("data-tone")}, not ${tone}`);
    }
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" }); removeServer("s_bare");', url);
    if (!await gone(rowOf(page, "Bare box"))) said(n, "a server that left the list stays in the dialog");
    // close: Esc, the dimmed page, "Close"; the focus goes back to the button
    await page.keyboard.press("Escape");
    if (!await gone(dialog(page))) said(n, "Esc did not close the dialog");
    else if (!await until(() => page.evaluate(() => document.activeElement?.closest("[data-testid]")?.dataset.testid === "servers-btn"), 5000)) said(n, "the focus did not go back to the Servers button");
    await press(page, button);
    await shown(dialog(page));
    await press(page, byTid(page, "overlay-backdrop").first(), { position: { x: 4, y: 4 } });
    if (!await gone(dialog(page))) said(n, "a press on the dimmed page did not close the dialog");
    await press(page, button);
    await shown(dialog(page));
    await press2(page, n, "Close");
    if (!await gone(dialog(page))) said(n, '"Close" did not close the dialog');
    // wide: a dialog in the middle of the window, 560 wide; phone: a sheet from the bottom edge with its handle
    await press(page, button);
    await shown(dialog(page));
    await atRest(page);
    const box = await dialog(page).first().boundingBox(), win = page.viewportSize();
    if (wide && (!box || Math.abs(box.width - 560) > 2 || Math.abs(box.x + box.width / 2 - win.width / 2) > 2)) said(n, `the dialog is ${box ? Math.round(box.width) : "not"} wide and not 560 in the middle`);
    if (!wide && (!box || Math.abs(box.y + box.height - win.height) > 2 || box.width < win.width - 2)) said(n, `the phone's Servers is not a sheet from the bottom edge: ${JSON.stringify(box)} in ${win.width}x${win.height}`);
    if ((await byTid(page, "sheet-handle").count() > 0) === wide) said(n, wide ? "a wide layout draws a sheet's handle" : "the phone's Servers has no handle");
    note(`${n}: ${wantNames.length} rows in order, the twelve states' words and tones live, the notice and the markup as text, Esc, the dimmed page and Close, the focus back; ${wide ? "a dialog" : "a sheet"}`);
  });

  // ---------------------------------------------------------------- the test of a saved entry
  await run("test", {}, async (page) => {
    const n = "test connection";
    await openList(page);
    const lab = rowOf(page, LAB), off = rowOf(page, "Office Mac");
    const block = (row) => byTid(row, "servers-result");
    // a test that passes: the block says so and repeats nothing the row says
    await knob("servers.testSaved", { answer: OK });
    await press(page, btn(lab, "Test connection"));
    if (!await shown(block(lab))) return said(n, "a test that passed shows no block under the row");
    const passed = await textOf(block(lab));
    if (!passed.startsWith("Test passed")) said(n, `the block of a test that passed starts "${passed}", not "Test passed"`);
    if (passed.includes("Version") || passed.includes("Agents")) said(n, `the block repeats the version or the agents the row says: "${passed}"`);
    if (await block(lab).first().getAttribute("data-ok") !== "true") said(n, "the block of a test that passed is not marked ok");
    // the five steps of a failure, by name; the detail the row already says is left out
    for (let step = 1; step <= 5; step++) {
      await knob("servers.testSaved", { answer: fail1(step, "refused", "That did not work: step " + step, { detail: step === 2 ? "connection refused" : "detail " + step }) });
      await press(page, btn(off, "Test connection"));
      const want = `Step ${step} of 5: ${STEPS[step - 1]}`;
      if (!await until(async () => (await textOf(block(off))).includes(`That did not work: step ${step}`), 10000)) { said(n, `the block of a test that failed at step ${step} says "${await textOf(block(off))}"`); continue; }
      const t = await textOf(block(off));
      if (!t.includes(want)) said(n, `step ${step}: the block lacks "${want}": "${t}"`);
      if (await block(off).first().getAttribute("data-ok") !== "false") said(n, "the block of a failed test is marked ok");
      if (step === 2 && (await textOf(off)).split("connection refused").length - 1 !== 1) said(n, `the row says "connection refused" ${(await textOf(off)).split("connection refused").length - 1} times with the block: each fact once`);
    }
    // what the test found out about another server comes out as text, in the block: its message, detail, version, agents and fingerprint (web/test/serversdialog.test.ts,
    // "what another server said comes out as text: a test's message, detail, version, agents and fingerprints"; A-SV-24)
    await knob("servers.testSaved", { answer: fail1(3, "cert_changed", "<img src=x onerror=1>", { detail: "<b>detail</b>", version: "<i>9</i>", agents: ["<u>a</u>"], fingerprint: "<img src=y>", pinned: "<s>pin</s>" }) });
    await press(page, btn(off, "Test connection"));
    if (!await until(async () => (await textOf(block(off))).includes("<img src=x onerror=1>"), 10000)) said(n, `a test's message with markup in it reads "${await textOf(block(off))}"`);
    else {
      const t = await textOf(block(off)), all = await textOf(off);
      for (const want of ["<b>detail</b>", "<i>9</i>", "<u>a</u>"]) if (!all.includes(want)) said(n, `the row after a test whose words have markup does not read "${want}": "${all}"`);
      if (!t.includes("<img src=x onerror=1>")) said(n, "the test's message is not in the block as text");
      if (await off.locator("img, b, i, u, s").count()) said(n, "what the test found out about another server (message, detail, version, agents, fingerprints) was drawn as markup");
    }
    // the block goes when the entry's state changes
    await mockEval('setServerState("s_off", "connecting");', url);
    if (!await gone(block(off))) said(n, "the block stays when the entry's state changes");
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" });', url);
    // a fingerprint not accepted: read it first, then accept it
    await mockEval('setServerState("s_off", "fingerprint_not_accepted");', url);
    await until(async () => (await btn(off, "Show fingerprint").count()) > 0, 10000);
    if (await btn(off, "Accept fingerprint").count()) said(n, "a fingerprint that was not accepted is offered to accept before it is read");
    await knob("servers.testSaved", { answer: fail1(3, "fingerprint", "Compare this fingerprint with the one shown on the other machine, then accept it", { fingerprint: FP1 }) });
    await press(page, btn(off, "Show fingerprint"));
    if (!await shown(btn(off, "Accept fingerprint"))) return said(n, '"Show fingerprint" did not give "Accept fingerprint"');
    if (!(await textOf(off)).includes("Fingerprint " + FP1)) said(n, `the row does not show the fingerprint to compare: "${await textOf(off)}"`);
    await reset();
    await press(page, btn(off, "Accept fingerprint"));
    const accepted = await until(async () => (await asked("servers.accept")).length > 0, 10000) && (await asked("servers.accept"))[0];
    if (!accepted || accepted.args.id !== "s_off" || accepted.args.fingerprint !== FP1) said(n, `the accept sent ${JSON.stringify(accepted && accepted.args)}`);
    if (!await until(async () => (await textOf(byTid(off, "servers-state"))) === "Connected", 10000)) said(n, "the entry is not connected after its fingerprint was accepted");
    if (!await gone(block(off))) said(n, "the test's block stays after the accept");
    if (await btn(off, "Accept fingerprint").count()) said(n, "Accept fingerprint stays after it was accepted");
    // a certificate that changed: both fingerprints, and accept offered at once
    await mockEval(`setServerState("s_off", "certificate_changed", { fingerprint: "${FP2}", pin: "${FP1}" });`, url);
    if (!await shown(btn(off, "Accept fingerprint"))) return said(n, "a changed certificate offers no Accept fingerprint");
    const t = await textOf(off);
    if (!t.includes("Accepted before " + FP1) || !t.includes("Presented now " + FP2)) said(n, `a changed certificate does not show both fingerprints: "${t}"`);
    await reset();
    await press(page, btn(off, "Accept fingerprint"));
    const again = await until(async () => (await asked("servers.accept")).length > 0, 10000) && (await asked("servers.accept"))[0];
    if (!again || again.args.fingerprint !== FP2) said(n, `accepting the changed certificate sent ${JSON.stringify(again && again.args)}, not the one presented now`);
    // an error of the call is a red line in the row, and the buttons are off while it runs
    await until(async () => (await textOf(byTid(off, "servers-state"))) === "Connected", 10000);
    await knob("servers.testSaved", { refuse: [500, "The test could not run."] });
    await press(page, btn(off, "Test connection"));
    if (!await until(async () => (await textOf(off)).includes("The test could not run."), 10000)) said(n, "a call that failed shows no line in the row");
    else if (!await byTid(off, "servers-row").count() && (await off.locator('[role="alert"]').count()) < 1) said(n, "the error line is not an alert");
    await knob("servers.testSaved", { delay: 1500, answer: OK });
    await press(page, btn(off, "Test connection"));
    if (!await until(() => isOff(btn(off, "Test connection")), 5000)) said(n, "the buttons are not off while the test runs");
    else if (!await isOff(btn(off, "Edit")) || !await isOff(btn(off, "Remove"))) said(n, "Edit and Remove stay on while the test runs");
    if (!await until(async () => !await isOff(btn(off, "Test connection")), 10000)) said(n, "the buttons stay off after the test");
    note(`${n}: the block (passed, five steps, each fact once, gone with the state), Show and Accept fingerprint, a changed certificate, an error line, the buttons off while it runs`);
  });

  // ---------------------------------------------------------------- remove
  await run("remove", {}, async (page) => {
    const n = "remove";
    await openList(page);
    const bare = rowOf(page, "Bare box");
    const question = byTid(page, "confirm-dialog");
    await press(page, btn(bare, "Remove"));
    if (!await shown(question)) return said(n, "Remove asked nothing");
    const said1 = await textOf(question);
    const want = 'Remove serverRemove "Bare box"? Its section leaves the sidebar. Nothing is deleted or stopped on that server: its chats and whiteboards stay there.';
    if (!said1.startsWith(want)) said(n, `the question reads "${said1}"`);
    await page.keyboard.press("Escape");
    if (!await gone(question)) said(n, "Esc did not leave the question");
    if (!await dialog(page).first().isVisible()) said(n, "Esc over the question closed the Servers dialog as well");
    if ((await asked("servers.remove")).length) said(n, "a removal that was not confirmed was made");
    if (!await bare.count()) said(n, "the row went before the removal was confirmed");
    const calls = [];
    page.on("request", (r) => { if (r.url().includes("/host/call") && r.url().includes("s_bare")) calls.push(r.url()); });
    await press(page, btn(bare, "Remove"));
    await shown(question);
    if (!(await sectionsSeen(page)).includes("s_bare")) said(n, "the entry has no section in the sidebar before it is removed: the check would prove nothing");
    await press(page, btn(question, "Remove"));
    if (!await gone(bare)) said(n, "the entry stays in the list after Remove");
    if (!await until(async () => !(await sectionsSeen(page)).includes("s_bare"), 10000)) said(n, "the section of an entry that was removed stays in the sidebar (web/test/sidebar.test.ts \"removing an entry takes its section away\", A-SC-20)");
    const sent = await asked("servers.remove");
    if (sent.length !== 1 || sent[0].args.id !== "s_bare") said(n, `the removal sent ${JSON.stringify(sent.map((c) => c.args))}`);
    if (calls.length) said(n, `that server was asked ${calls.length} thing(s) when it was removed: ${calls[0]}`);
    if (!await gone(question)) said(n, "the question stays after the removal");
    if (!await dialog(page).first().isVisible()) said(n, "the removal closed the dialog");
    note(`${n}: the question in its words, Esc leaves it and not the dialog, the entry goes and its server is told nothing`);
  });

  // ---------------------------------------------------------------- add
  await run("add", {}, async (page) => {
    const n = "add";
    await openList(page);
    await press2(page, n, "Add server");
    const form = byTid(page, "servers-form");
    if (!await shown(form)) return said(n, "Add server shows no form");
    if (await form.first().getAttribute("data-mode") !== "add" || !(await textOf(form)).startsWith("Add server")) said(n, "the form is not titled Add server");
    const name = field(page, "name"), address = field(page, "address"), secret = field(page, "secret"), box = byTid(page, "servers-selfsigned");
    const save = btn(form, "Save"), test = btn(form, "Test connection");
    // the fields
    if (await name.getAttribute("placeholder") !== "Studio" || await name.getAttribute("maxlength") !== "80") said(n, "the Name field has not the placeholder Studio and 80 characters");
    if (await address.getAttribute("placeholder") !== "https://host:port") said(n, "the Address field has not the placeholder https://host:port");
    if (await secret.getAttribute("type") !== "password") said(n, "the secret is not a password field");
    if (await secret.getAttribute("autocomplete") !== "off") said(n, "the secret field is not told to be left out of autofill");
    if (await address.getAttribute("spellcheck") !== "false") said(n, "the Address field checks spelling");
    if (await box.getAttribute("aria-checked") !== "false") said(n, "the Self-signed box starts ticked");
    if (!await name.evaluate((e) => e === document.activeElement)) said(n, "the Name field has not the focus when the form opens");
    if (!await isOff(save) || !await isOff(test)) said(n, "Save or Test connection is on in an empty form");
    if (await btn(form, "Save anyway").count()) said(n, "Save anyway is offered in an empty form");
    // the first problem, as something is typed
    const problem = async () => ((await textOf(byTid(page, "servers-problem"))) || "");
    if (await problem()) said(n, "the empty form complains");
    await address.fill("http://nope");
    if (!await until(async () => (await problem()) === "Give the server a name", 5000)) said(n, `an address alone gives "${await problem()}", not "Give the server a name"`);
    await name.fill("Studio");
    if (!await until(async () => (await problem()) === "Not a valid https address (https://host:port)", 5000)) said(n, `a name and a bad address give "${await problem()}"`);
    await address.fill("https://studio.example:4790");
    if (!await until(async () => (await problem()) === "Enter the secret", 5000)) said(n, `no secret gives "${await problem()}"`);
    await secret.fill("has a space");
    if (!await until(async () => (await problem()) === "The secret has no spaces and 256 characters at most", 5000)) said(n, `a secret with a space gives "${await problem()}"`);
    if (!await isOff(test)) said(n, "Test connection is on with a problem in the form");
    // a test that is slow: "Working…", then its answer; Save is on only after an OK test of the form as it is
    await secret.fill("s3cret-value");
    if (await problem()) said(n, `a good form gives "${await problem()}"`);
    if (!await isOff(save)) said(n, "Save is on before any test");
    if (!await btn(form, "Save anyway").count()) said(n, "Save anyway is not offered before a test");
    await knob("servers.test", { delay: 900, answer: OK });
    await press(page, test);
    if (!await until(() => btn(form, "Working…").count(), 5000)) said(n, "Test connection does not read Working… while it runs");
    else if (!await isOff(btn(form, "Working…"))) said(n, "the test's button is on while it runs");
    if (!await until(async () => !await isOff(save), 10000)) return said(n, "Save is off after an OK test");
    if (!(await textOf(byTid(form, "servers-result"))).startsWith("Connected")) said(n, `an OK test's block reads "${await textOf(byTid(form, "servers-result"))}"`);
    if (await btn(form, "Save anyway").count()) said(n, "Save anyway is offered after an OK test");
    const sentTest = (await asked("servers.test")).at(-1);
    if (!sentTest || sentTest.args.form.secret !== "<12 characters>" || sentTest.args.form.address !== "https://studio.example:4790") said(n, `the test sent ${JSON.stringify(sentTest && sentTest.args)}`);
    // a result of another form counts as no test
    await address.fill("https://studio.example:4791");
    if (!await until(() => isOff(save), 5000)) said(n, "Save stays on when a field changed after the test");
    await address.fill("https://studio.example:4790");
    if (await isOff(save)) said(n, "Save is off for the form the test was of");
    // a test that failed: Save anyway, but not past a bad address or a duplicate
    await knob("servers.test", { answer: fail1(2, "refused", "Nothing listens there: is the server running on that machine?") });
    await press(page, test);
    if (!await until(async () => (await textOf(byTid(form, "servers-result"))).includes("Step 2 of 5: the connection"), 10000)) said(n, "a failed test shows no step in the form");
    if (!await btn(form, "Save anyway").count() || !await isOff(save)) said(n, "after a failed test Save anyway is not the way and Save is on");
    for (const outcome of ["bad_address", "duplicate", "is_local", "another_server"]) {
      await knob("servers.test", { answer: fail1(outcome === "bad_address" ? 1 : 4, outcome, "no way past " + outcome) });
      await press(page, test);
      if (!await until(async () => (await textOf(byTid(form, "servers-result"))).includes("no way past " + outcome), 10000)) { said(n, `the answer ${outcome} was not shown`); continue; }
      if (await btn(form, "Save anyway").count()) said(n, `Save anyway is offered past ${outcome}`);
    }
    // a fingerprint to compare: Accept ticks the box, puts the pin in the form and tests again
    await knob("servers.test", { queue: [{ answer: fail1(3, "fingerprint", "Compare this fingerprint with the one shown on the other machine, then accept it", { fingerprint: FP1 }) }, { answer: OK }] });
    await press(page, test);
    if (!await shown(btn(form, "Accept fingerprint"))) return said(n, "a self-signed certificate offers no Accept fingerprint");
    if (!(await textOf(form)).includes("Fingerprint " + FP1)) said(n, "the form does not show the fingerprint to compare");
    await press(page, btn(form, "Accept fingerprint"));
    if (!await until(async () => await box.getAttribute("aria-checked") === "true", 5000)) said(n, "Accept fingerprint did not tick the self-signed box");
    if (!await until(async () => (await textOf(form)).includes("Accepted fingerprint " + FP1), 5000)) said(n, "the accepted fingerprint is not shown in the form");
    const retest = await until(async () => (await asked("servers.test")).at(-1)?.args.form.pin === FP1, 10000);
    if (!retest) said(n, "Accept fingerprint did not test again with the pin in the form");
    if (!await until(async () => !await isOff(save), 10000)) said(n, "Save is off after the accepted test");
    await box.click().catch(() => press(page, box));
    if (!await until(async () => await box.getAttribute("aria-checked") === "false", 5000) || (await textOf(form)).includes("Accepted fingerprint")) said(n, "unticking the box does not drop the pin");
    await press(page, box);
    // Enter: tests when it cannot save, saves when it can
    await reset();
    await knob("servers.test", { answer: OK });
    await name.fill("Studio Mac");
    await secret.press("Enter");
    if (!await until(async () => (await asked("servers.test")).length === 1, 10000)) said(n, "Enter in a form that cannot be saved did not test it");
    await until(async () => !await isOff(save), 10000);
    await press(page, box); // (ticked again, with no pin: the form is no more the one the test was of)
    await name.press("Enter");
    if (!await until(async () => (await asked("servers.test")).length === 2, 10000)) said(n, "Enter after a field changed did not test again");
    await until(async () => !await isOff(save), 10000);
    // a save that did not pass: the app tested the form itself; the form stays open with its result, and without one it says so
    await knob("servers.add", { queue: [{ answer: { saved: false, result: fail1(4, "secret_refused", "Secret not accepted") } }, { answer: { saved: false } }] });
    await press(page, save);
    if (!await until(async () => (await textOf(byTid(form, "servers-result"))).includes("Secret not accepted"), 10000)) said(n, "a save that did not pass shows no result");
    if (!await form.first().isVisible()) said(n, "the form closed after a save that did not pass");
    await press(page, btn(form, "Save anyway"));
    if (!await until(async () => (await textOf(page.locator('[role="alert"]'))).includes("The server was not saved."), 10000)) said(n, 'a save with no result says nothing ("The server was not saved.")');
    // saved: the entry is added and its section says Connecting…, then the row reads Connected by itself
    await mockEval("delete flags.app['servers.add'];", url);
    await press(page, btn(form, "Save anyway"));
    if (!await gone(form)) return said(n, `the form stays after a save: "${await textOf(form)}"`);
    const added = (await asked("servers.add")).at(-1);
    const sent = added?.args;
    if (!sent || sent.force !== true || sent.form.name !== "Studio Mac" || sent.form.address !== "https://studio.example:4790" || sent.form.secret !== "<12 characters>") said(n, `the add sent ${JSON.stringify(sent)}`);
    const studio = rowOf(page, "Studio Mac");
    if (!await shown(studio)) return said(n, "the new entry is not in the list");
    if (!await until(async () => (await textOf(byTid(studio, "servers-state"))) === "Connected", 15000)) said(n, `the new entry reads "${await textOf(byTid(studio, "servers-state"))}", not Connected, by itself`);
    // the secret is dropped at Cancel: a second form is empty
    await press2(page, n, "Add server");
    await shown(form);
    await secret.fill("another-secret");
    await press(page, btn(form, "Cancel"));
    if (!await gone(form)) said(n, "Cancel did not leave the form");
    await press2(page, n, "Add server");
    await shown(byTid(page, "servers-form"));
    if (await field(page, "secret").inputValue() !== "" || await field(page, "name").inputValue() !== "") said(n, "a form that was cancelled leaves its words for the next");
    // Esc leaves the form first, then the dialog; the dimmed page closes the list and not a form
    await press(page, byTid(page, "overlay-backdrop").first(), { position: { x: 4, y: 4 } });
    await page.waitForTimeout(300);
    if (!await byTid(page, "servers-form").count()) said(n, "a press on the dimmed page closed a form");
    await page.keyboard.press("Escape");
    if (!await gone(byTid(page, "servers-form"))) said(n, "Esc did not leave the form");
    if (!await dialog(page).first().isVisible()) said(n, "Esc over a form closed the dialog as well");
    await page.keyboard.press("Escape");
    if (!await gone(dialog(page))) said(n, "a second Esc did not close the dialog");
    note(`${n}: the fields, the rule's problems, Save only after an OK test, Save anyway, the fingerprint, Enter, a save that did not pass, the entry connecting by itself, the secret dropped, Esc form first`);
  });

  // ---------------------------------------------------------------- edit
  await run("edit", {}, async (page) => {
    const n = "edit";
    await openList(page);
    await press(page, btn(rowOf(page, "Office Mac"), "Edit"));
    const form = byTid(page, "servers-form");
    if (!await shown(form)) return said(n, "Edit shows no form");
    if (await form.first().getAttribute("data-mode") !== "edit" || !(await textOf(form)).startsWith("Edit server")) said(n, "the form is not titled Edit server");
    const name = field(page, "name"), address = field(page, "address"), secret = field(page, "secret");
    const save = btn(form, "Save"), test = btn(form, "Test connection");
    if (await name.inputValue() !== "Office Mac" || await address.inputValue() !== "https://office-mac.example:4790") said(n, "the form does not start from the saved entry");
    if (await secret.inputValue() !== "" || await secret.getAttribute("placeholder") !== "unchanged") said(n, "the secret is not empty with the placeholder unchanged");
    if (!await isOff(save)) said(n, "Save is on before something changed");
    if (await isOff(test)) said(n, "Test connection is off for a saved entry's form (an empty secret keeps the stored one)");
    // a rename alone: saved without a test, and no Save anyway
    await name.fill("Office Mac 2");
    if (!await until(async () => !await isOff(save), 5000)) return said(n, "a rename alone does not turn Save on");
    if (await btn(form, "Save anyway").count()) said(n, "a rename alone offers Save anyway");
    await press(page, save);
    if (!await gone(form)) return said(n, "the form stays after the save of a rename");
    const edit = (await asked("servers.edit")).at(-1)?.args;
    if (!edit || edit.id !== "s_off" || JSON.stringify(edit.patch) !== JSON.stringify({ name: "Office Mac 2" }) || edit.force !== true) said(n, `a rename sent ${JSON.stringify(edit)}: only the name, forced`);
    if ((await asked("servers.testSaved")).length || (await asked("servers.test")).length) said(n, "a rename was tested");
    if (!await shown(rowOf(page, "Office Mac 2"))) said(n, "the list does not show the new name");
    // another change keeps the rule: Save only after a test, which names what the form changed
    await press(page, btn(rowOf(page, "Office Mac 2"), "Edit"));
    await shown(form);
    await address.fill("https://office-mac.example:4791");
    await secret.fill("new-secret-1");
    if (!await isOff(save)) said(n, "Save is on for a changed address before a test");
    await knob("servers.testSaved", { answer: OK });
    await press(page, test);
    if (!await until(async () => !await isOff(save), 10000)) return said(n, "Save is off after an OK test of the edit");
    const tested = (await asked("servers.testSaved")).at(-1)?.args;
    if (!tested || tested.id !== "s_off" || tested.over?.address !== "https://office-mac.example:4791" || tested.over?.secret !== "<12 characters>") said(n, `the test of the edit sent ${JSON.stringify(tested)}`);
    await press(page, save);
    if (!await gone(form)) return said(n, "the form stays after the save");
    const patch = (await asked("servers.edit")).at(-1)?.args;
    if (!patch || JSON.stringify(Object.keys(patch.patch).sort()) !== JSON.stringify(["address", "secret"]) || patch.patch.address !== "https://office-mac.example:4791" || patch.force !== false) said(n, `the edit sent ${JSON.stringify(patch)}: the address and the secret, as they changed, not forced`);
    // an empty secret is sent as none
    await press(page, btn(rowOf(page, "Office Mac 2"), "Edit"));
    await shown(form);
    await address.fill("https://office-mac.example:4792");
    await press(page, test);
    await until(async () => !await isOff(save), 10000);
    const t2 = (await asked("servers.testSaved")).at(-1)?.args;
    if (t2?.over && "secret" in t2.over) said(n, "an edit with an empty secret sent a secret to test");
    await press(page, btn(form, "Cancel"));
    note(`${n}: starts from the entry, the secret empty and "unchanged", a rename alone saves forced with no test, another change is tested and sends what changed`);
  });

  // ---------------------------------------------------------------- the owner's things
  await run("owner", {}, async (page) => {
    const n = "this computer";
    await mockEval("flags.mcp = { up: false };", url);
    await openList(page);
    const here = rowOf(page, "This computer");
    if ((await names(page))[0] !== "This computer") said(n, "this computer is not the first row");
    if (!await until(async () => (await textOf(byTid(here, "servers-mcp"))) === "MCP listener: http://localhost:6006/mcp (down)", 10000)) said(n, `the MCP listener's line reads "${await textOf(byTid(here, "servers-mcp"))}", not "(down)"`);
    await page.keyboard.press("Escape");
    await gone(dialog(page));
    await mockEval("delete flags.mcp;", url);
    await openList(page);
    if (!await until(async () => (await textOf(byTid(here, "servers-mcp"))).endsWith("(up)"), 10000)) said(n, "the MCP listener's line does not say (up)");
    // a start that failed: the reason as text (twelve lines and a mark), Retry that fails again and then works
    const reason = Array.from({ length: 30 }, (_, i) => `line ${i + 1} <b>x</b>`).join("\n");
    await mockEval(`setServerState("local", "not_started", { detail: ${JSON.stringify(reason)} });`, url);
    const shownReason = byTid(here, "servers-reason");
    if (!await shown(shownReason)) return said(n, "a start that failed shows no reason");
    const lines = ((await shownReason.first().textContent()) ?? "").split("\n");
    if (lines.length !== 13 || lines[11] !== "line 12 <b>x</b>" || lines[12] !== "…") said(n, `the reason shows ${lines.length} lines, the 12th "${lines[11]}", then "${lines[12]}"`);
    if (await here.locator("b").count()) said(n, "the reason was drawn as markup");
    if (await textOf(byTid(here, "servers-state")) !== "Not started") said(n, "this computer's row does not say Not started");
    await mockEval('flags.start = { fail: "still cannot start" };', url);
    await press(page, btn(here, "Retry"));
    if (!await until(async () => (await textOf(byTid(here, "servers-reason"))) === "still cannot start", 10000)) said(n, `Retry that fails again shows "${await textOf(byTid(here, "servers-reason"))}"`);
    await mockEval("delete flags.start;", url);
    await press(page, btn(here, "Retry"));
    if (!await until(async () => (await textOf(byTid(here, "servers-state"))) === "Connected", 10000)) said(n, "Retry did not start the server");
    if (await byTid(here, "servers-reason").count() || await btn(here, "Retry").count()) said(n, "the reason and Retry stay after the start");
    // Restart server: asks first when a chat of this computer is at work (the seed has one), and Esc leaves the question with nothing begun;
    // confirmed, it says Restarting… with the button off, and the row is Connected again when the server answers (with none at work it
    // restarts at once: test/restart.test.ts)
    const question = byTid(page, "confirm-dialog");
    await mockEval("flags.restart = { delay: 1500 }; appCalls.length = 0;", url);
    await press(page, btn(here, "Restart server"));
    if (!await shown(question)) return said(n, "Restart server with an agent at work asked nothing");
    if (!/^Restart serverRestart ends 1 running agent chat\.CancelRestart$/.test(await textOf(question))) said(n, `the restart's question reads "${await textOf(question)}"`);
    await page.keyboard.press("Escape");
    if (!await gone(question)) said(n, "Esc did not leave the restart's question");
    if (!await dialog(page).first().isVisible()) said(n, "Esc over the restart's question closed the dialog");
    if ((await asked("owner.restart")).length) said(n, "a restart that was not confirmed began");
    await press(page, btn(here, "Restart server"));
    await shown(question);
    await press(page, btn(question, "Restart"));
    if (!await until(async () => (await textOf(byTid(here, "servers-owner-line"))) === "Restarting…", 10000)) said(n, "a restart does not say Restarting…");
    else if (!await isOff(btn(here, "Restart server"))) said(n, "Restart server is on while it runs");
    if (!await until(async () => (await textOf(byTid(here, "servers-state"))) === "Connected" && !await byTid(here, "servers-owner-line").count(), 15000)) said(n, "the row is not Connected again after the restart");
    if ((await asked("owner.restart")).length !== 1) said(n, `the restart asked the app ${(await asked("owner.restart")).length} times`);
    // a restart that fails: the row says so with the reason, and offers Restart server again (web/test/serversdialog.test.ts "this computer's row: ...", A-OW-13)
    await mockEval('flags.restart = { fail: "the server stopped while starting" }; appCalls.length = 0;', url);
    await press(page, btn(here, "Restart server"));
    await shown(question);
    await press(page, btn(question, "Restart"));
    if (!await until(async () => { const t = await textOf(here); return t.includes("Restart failed") && t.includes("the server stopped while starting"); }, 10000)) said(n, `a restart that failed says "${await textOf(here)}" in the row`);
    else if (!await btn(here, "Restart server").count() || await isOff(btn(here, "Restart server"))) said(n, "after a restart that failed the row does not offer Restart server");
    await mockEval("delete flags.restart;", url);
    note(`${n}: first, the MCP listener (up and down), the reason as text (12 lines and a mark), Retry that fails and works, Restarting…, the question while an agent works, Esc, the restart; no Edit, Remove or Test`);
  });

  // ---------------------------------------------------------------- readable in each flavour
  const readRows = async (pref) => {
    await seed(url, "A1");
    const { ctx, page } = await open({ sel: {}, ls: { "aiwb.theme": pref } });
    try {
      await knob("servers.testSaved", { answer: fail1(2, "refused", "Nothing listens there: is the server running on that machine?") });
      await mockEval(`setServerState("s_bare", "certificate_changed", { fingerprint: "${FP2}", pin: "${FP1}" });`, url);
      await openList(page);
      await press(page, btn(rowOf(page, "Office Mac"), "Test connection"));
      await shown(byTid(page, "servers-result"));
      await atRest(page);
      const rows = await contrastAudit(page, { only: ['[data-testid="servers-dialog"]'] });
      const least = new Map();
      for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
      return least;
    } finally { await ctx.close(); await reset(); await mockEval('setServerState("s_bare", "connected");', url); }
  };
  if (viewport === "desktop" && !only) {
    const under = { light: await readRows("light"), dark: await readRows("dark") };
    for (const [flavour, over] of Object.entries(FLAVOURS)) {
      const rows = await readRows(flavour), base = under[over];
      if (rows.size < 8) said(`${flavour}, the Servers dialog`, `only ${rows.size} texts were read: the dialog is not on screen`);
      const asToday = [];
      for (const [key, r] of rows) {
        if (r.ratio >= FLOOR) continue;
        const was = base.get(key);
        if (was && r.ratio >= was.ratio - 0.005) asToday.push(`${r.where.split(" > ").pop()} ${r.ratio}`);
        else said(`${flavour}, the Servers dialog`, `${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${over}` : ` (${over} has no such element)`}`);
      }
      note(`${flavour}: ${rows.size} texts read; under ${FLOOR}:1 and no weaker than in ${over}: ${asToday.join(", ") || "nothing"}`);
    }
  }
}, { viewports, page: false });
