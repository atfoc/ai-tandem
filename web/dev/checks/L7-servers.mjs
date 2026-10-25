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
//
// The PHONE half (ux-improvements goal 4.10, package S2) proves the same behaviours on the phone's pushed screens, not on a sheet: the Servers
// button pushes the list (`srv-list`, rows `srv-row` with the dataSet `server` and `word`); a row pushes the server's detail (`srv-facts`, the one
// body of ServerFacts); the bar's Edit opens the P3 form (`srv-edit-form`); Remove server… asks in a P4 (`confirm-sheet`); "Add server" is the add
// flow (`add-choose` → `add-form`). Where the phone differs by design, its line says so; the wide halves are as they were.
//   the list         A–Z rows, each one's word (the twelve states fold into the six words of the phone, the rest as the row's reason), tone and host; the
//                    stream changes a row and the list while the screen is open; what another server said is text; no buttons in a row; the system back
//   tests            "Test connection" / "Test again" on the detail: the answer in place (each step by name, the markup as text, gone with the state), a
//                    changed certificate (Compare fingerprints → the certificate screen → Trust: servers.accept with the fingerprint presented now), an
//                    error line, the button off while it runs
//   remove           "Remove server…" → the P4 in its words; Esc leaves it; confirmed, servers.remove is sent, the screen leaves, the row and the section go
//   add              Add server → Enter address manually: the fields, the first problem as typed, no Save before a passing test (the phone has no "Save
//                    anyway"), a test that fails stays in the form, a self-signed server's fingerprint to trust, what is sent (the secret by its length), a
//                    save that did not pass, the entry connecting by itself, the secret dropped at Cancel, Esc asks before it drops what was typed
//   edit             starts from the entry, the secret empty ("Unchanged"), only what changed is sent, a rename alone saves with no test
//   owner's things   this computer's detail (the test host's transport is `http`): the MCP listener, the reason of a start that failed, Retry, Restart
//                    server and its question, a restart that fails; no Edit, Remove or Test
//   readable         the list and a server's detail in each flavour
import { atRest, check, contrastAudit, mockEval, seed, until } from "../shot.mjs";
import { acts, back, byTid, press, showList } from "./sel.mjs";
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
    try { await (wide ? body : P[name])(page); } finally { await ctx.close(); await reset(); }
  };
  const press2 = (page, name, label) => press(page, btn(dialog(page), label)).catch((e) => { throw new Error(`${name}: no button "${label}": ${e.message.split("\n")[0]}`); });

  // ================================================================ the phone's halves (pushed screens, see the header)
  // The sections below are run in place of the wide ones when the layout is the phone; a line that says "phone:" tells where it differs and why.
  const P = {};
  const prow = (page, name) => byTid(page, "srv-row").filter({ has: page.getByText(name, { exact: true }) });
  const labelOf = (loc) => loc.first().getAttribute("aria-label").then((l) => l ?? "");
  const facts = (page) => byTid(page, "srv-facts");
  // the P4: confirm() draws it with the testID of the dialog it stands for (remove), a screen's own ConfirmSheet with its own (the certificate's trust)
  const confirmSheet = (page) => page.locator('[data-testid="confirm-dialog"], [data-testid="confirm-sheet"]');
  const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
  /** A fingerprint as the screens draw it: 16 blocks of two pairs ("ABCD", …). */
  const blocks = (fp) => fp.split(":").reduce((a, x, i) => (i % 2 ? (a[a.length - 1] += x, a) : [...a, x]), []);
  const pOpenList = async (page) => {
    const b = byTid(page, "servers-btn").first();
    if (await b.isVisible().catch(() => false)) await press(page, b); else await acts["srv-list"](page);
    if (!await shown(byTid(page, "srv-list"))) throw new Error("the Servers button pushed no list screen");
    await shown(byTid(page, "srv-row"));
  };
  const pOpenServer = async (page, name) => {
    await press(page, prow(page, name));
    if (!await shown(facts(page))) throw new Error(`the row of ${name} pushed no detail`);
  };
  const chipsSeen = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="server-chip"]')].map((s) => s.dataset.server)); // (the phone's counterpart of the sidebar's sections)
  const pBack = async (page) => { if (!await back(page)) throw new Error("the phone has no back button on this screen"); };
  const pNames = (page) => byTid(page, "srv-row").evaluateAll((es) => es.map((e) => (e.getAttribute("aria-label") ?? "").split(", ")[0]));
  const bySheetRight = (page) => byTid(page, "sheet-right").last();
  const bySheetLeft = (page) => byTid(page, "sheet-left").last();
  // the phone's words of the twelve states: [word key, the word's text, its tone]; the others fold into "Unreachable" with the state's own label as the reason
  const PWORD = { connecting: ["connecting", "Connecting…", "wait"], connected: ["connected", "Connected", "ok"], certificate_changed: ["cert-changed", "Certificate changed · paused", "bad"], too_old: ["too-old", "Too old", "warn"] };

  // ---------------------------------------------------------------- the list
  P.list = async (page) => {
    const n = "the list";
    await mockEval('extra.notice = "The list file was set aside: <b>unreadable</b>."; addServer({ id: "s_evil", name: "<img src=x onerror=1>", address: "https://evil.example:4790", state: "connected", version: "<b>9</b>", agents: ["<i>x</i>"] }); emit(serversEvent());', url);
    await pOpenList(page);
    // phone: a screen pushed on the stack, not a dialog or a sheet; the system back (not Esc, nor the dimmed page) leaves it
    if (!await shown(byTid(page, "pushed-screen", { screen: "servers" }))) said(n, "the list is not a screen pushed on the stack");
    if (await dialog(page).count() || await byTid(page, "sheet-handle").count()) said(n, "the phone draws the Servers dialog or a sheet for the list");
    const wantNames = ["This computer", LAB, "Office Mac", "Bare box", "<img src=x onerror=1>"].sort(new Intl.Collator(undefined, { sensitivity: "base" }).compare);
    if (!await until(async () => JSON.stringify(await pNames(page)) === JSON.stringify(wantNames), 10000)) said(n, `the rows are ${JSON.stringify(await pNames(page))}, not ${JSON.stringify(wantNames)} (A–Z by name; phone: this computer is not first)`);
    // the notice, as text (phone: the list screen has to show it, as the dialog does)
    const list = byTid(page, "srv-list");
    if (!await until(async () => (await textOf(list)).includes("The list file was set aside: <b>unreadable</b>."), 3000)) said(n, "the list screen shows no notice (\"The list file was set aside: <b>unreadable</b>.\")");
    if (await list.first().locator("img, b, i").count()) said(n, "what another server said (its name, the notice) was drawn as markup");
    // each row's words: the word (key, text, tone) and the host, or the reason of a problem
    const here = prow(page, "This computer"), lab = prow(page, LAB), off = prow(page, "Office Mac"), evil = prow(page, "<img src=x onerror=1>");
    const wordOf = (row) => byTid(row, "state-word").first();
    if (await here.getAttribute("data-word") !== "connected" || await textOf(wordOf(here)) !== "Connected" || await wordOf(here).getAttribute("data-tone") !== "ok") said(n, "this computer's row does not say Connected, in the tone of ok");
    if (await here.getAttribute("data-server") !== "local") said(n, "this computer's row is not the entry local");
    if (await wordOf(off).getAttribute("data-tone") !== "bad" || await textOf(wordOf(off)) !== "Unreachable" || await off.getAttribute("data-word") !== "unreachable") said(n, "the row of a server that is not connected is not Unreachable, in the tone of bad");
    if (!(await labelOf(lab)).endsWith(`Connected, ${LAB}`)) said(n, `the row of the lab box reads "${await labelOf(lab)}": its host after the word`);
    if (!(await labelOf(off)).endsWith("Unreachable, connection refused")) said(n, `the row of Office Mac reads "${await labelOf(off)}": its reason after the word`);
    if ((await labelOf(here)) !== "This computer, Connected") said(n, `this computer's row reads "${await labelOf(here)}": no address`);
    // phone: a row is one button that opens the detail; Test connection, Edit and Remove are on the detail, not in the list
    for (const b of ["Test connection", "Edit", "Remove", "Accept fingerprint", "Show fingerprint", "Restart server"]) if (await list.first().getByText(b, { exact: true }).count()) said(n, `the list has "${b}" (phone: a row is only a way to the detail)`);
    if (!await byTid(page, "srv-add").count() || !await byTid(page, "srv-plus").count()) said(n, 'the list has no "Add server" or "+"');
    // the app's events, while the screen is open: one entry's state, then the list
    for (const [state, label] of Object.entries(LABELS)) {
      // (the entry's detail is dropped when it connects: the unreachable state is given its reason again)
      await mockEval(`setServerState("s_off", ${JSON.stringify(state)}, ${state === "certificate_changed" ? `{ fingerprint: "${FP2}", pin: "${FP1}" }` : state === "unreachable" ? '{ detail: "connection refused" }' : "{}"});`, url);
      const [key, text, tone] = PWORD[state] ?? ["unreachable", "Unreachable", "bad"];
      if (!await until(async () => (await off.getAttribute("data-word")) === key && (await textOf(wordOf(off))) === text, 10000)) { said(n, `the state ${state} reads "${await textOf(wordOf(off))}" (${await off.getAttribute("data-word")}), not "${text}"`); continue; }
      if (await wordOf(off).getAttribute("data-tone") !== tone) said(n, `the state ${state} has the tone ${await wordOf(off).getAttribute("data-tone")}, not ${tone}`);
      // phone: the states the word folds into Unreachable say their own label as the reason, lower case
      const reason = key === "unreachable" ? (state === "unreachable" ? "connection refused" : lowerFirst(label)) : key === "too-old" ? "update it" : "";
      if (reason && !(await labelOf(off)).endsWith(`, ${reason}`)) said(n, `the state ${state} reads "${await labelOf(off)}", not ending ", ${reason}"`);
    }
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" }); removeServer("s_bare");', url);
    if (!await gone(prow(page, "Bare box"))) said(n, "a server that left the list stays on the screen");
    // the facts the dialog's row repeated are on the detail: the address, the version, the agents; what another server said is text there too
    await pOpenServer(page, LAB);
    if (!(await textOf(byTid(page, "srv-address"))).includes("https://" + LAB + ":4790")) said(n, `the detail of the lab box does not say its address: "${await textOf(byTid(page, "srv-address"))}"`);
    if (!(await textOf(byTid(page, "srv-version"))).includes("dev")) said(n, "the detail of the lab box does not say Version dev");
    const agents = (await textOf(byTid(page, "srv-agents"))).toLowerCase();
    for (const a of ["claude", "cursor", "pi"]) if (!agents.includes(a)) said(n, `the detail of the lab box does not list the agent ${a}: "${agents}"`);
    await pBack(page);
    await pOpenServer(page, "<img src=x onerror=1>");
    for (const [id, want] of [["srv-version", "<b>9</b>"], ["srv-agents", "<i>x</i>"]]) if (!(await textOf(byTid(page, id))).includes(want)) said(n, `the detail of the server with markup in its words does not read "${want}": "${await textOf(byTid(page, id))}"`);
    if (await facts(page).first().locator("img, b, i").count()) said(n, "what another server said (its name, version, agents) was drawn as markup on the detail");
    await pBack(page);
    // phone: the system back pops the list to Home (the phone has no sidebar) (Esc, the dimmed page and "Close" are a dialog's; the focus has no button to go back to)
    await pBack(page);
    if (!await gone(byTid(page, "srv-list"))) said(n, "the back did not leave the list");
    else if (!await shown(byTid(page, "home"))) said(n, "the back from the list did not come to Home");
    note(`${n}: ${wantNames.length} rows A–Z, the twelve states in the phone's six words and tones live, the notice and the markup as text, no buttons in a row, the facts on the detail, the back; a pushed screen`);
  };

  // ---------------------------------------------------------------- the test of a saved entry
  P.test = async (page) => {
    const n = "test connection";
    await pOpenList(page);
    const result = byTid(page, "srv-result"), test = byTid(page, "srv-test");
    // a test that passes: the answer in place says so and repeats nothing the detail says
    await pOpenServer(page, LAB);
    await knob("servers.testSaved", { answer: OK });
    await press(page, test);
    if (!await shown(result)) return said(n, "a test that passed shows no answer under the button");
    const passed = await textOf(result);
    if (!passed.startsWith("✓ Reached")) said(n, `the answer of a test that passed starts "${passed}", not "✓ Reached"`);
    if (!passed.includes("version dev") || passed.includes("Agents")) said(n, `the answer reads "${passed}": the version, and not the agents the detail says`);
    if (await result.first().getAttribute("data-ok") !== "true") said(n, "the answer of a test that passed is not marked ok");
    if (await textOf(byTid(page, "srv-since")) !== "Checked just now") said(n, `the header's second line reads "${await textOf(byTid(page, "srv-since"))}" after a test, not "Checked just now"`);
    await pBack(page);
    // the five steps of a failure, by name (phone: the unreachable detail's "Test again" answers in place, under the why and the tries)
    await pOpenServer(page, "Office Mac");
    if (!await shown(byTid(page, "srv-why")) || !await shown(byTid(page, "srv-tries"))) said(n, "an unreachable server's detail has no Why or What to try");
    for (let step = 1; step <= 5; step++) {
      await knob("servers.testSaved", { answer: fail1(step, "refused", "That did not work: step " + step, { detail: step === 2 ? "connection refused" : "detail " + step }) });
      await press(page, test);
      const want = `Step ${step} of 5: ${STEPS[step - 1]}`;
      if (!await until(async () => (await textOf(result)).includes(`That did not work: step ${step}`), 10000)) { said(n, `the answer of a test that failed at step ${step} says "${await textOf(result)}"`); continue; }
      const t = await textOf(result);
      if (!t.startsWith("✕") || !t.includes(want)) said(n, `step ${step}: the answer lacks "✕ … ${want}": "${t}"`);
      if (await result.first().getAttribute("data-ok") !== "false") said(n, "the answer of a failed test is marked ok");
    }
    // what the test found out about another server comes out as text, in the answer and in the why (phone: the answer has the message, not the
    // detail, version, agents or fingerprints: the dialog's block drew those; web/test/serversdialog.test.ts, A-SV-24)
    await knob("servers.testSaved", { answer: fail1(3, "cert_changed", "<img src=x onerror=1>", { detail: "<b>detail</b>", version: "<i>9</i>", agents: ["<u>a</u>"], fingerprint: "<img src=y>", pinned: "<s>pin</s>" }) });
    await press(page, test);
    if (!await until(async () => (await textOf(result)).includes("<img src=x onerror=1>"), 10000)) said(n, `a test's message with markup in it reads "${await textOf(result)}"`);
    else if (await facts(page).first().locator("img, b, i, u, s").count()) said(n, "what the test found out about another server (message, detail, version, agents, fingerprints) was drawn as markup");
    // the answer goes when the entry's state changes
    await mockEval('setServerState("s_off", "connecting");', url);
    if (!await gone(result)) said(n, "the answer stays when the entry's state changes");
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" });', url);
    // phone: a fingerprint not accepted folds into Unreachable with its reason; there is no "Show fingerprint" or "Accept fingerprint" on the detail:
    // a certificate the app does not trust is trusted from the certificate screen (below)
    // a certificate that changed: no test, the notice, and Compare fingerprints → the certificate screen → Trust: servers.accept with the one presented now
    await mockEval(`setServerState("s_off", "certificate_changed", { fingerprint: "${FP2}", pin: "${FP1}" });`, url);
    if (!await shown(byTid(page, "srv-cert-notice")) || !await shown(byTid(page, "srv-compare"))) return said(n, "a changed certificate shows no notice or no Compare fingerprints");
    if (await byTid(page, "srv-test").count()) said(n, "a changed certificate offers Test connection (phone: the one way on is Compare fingerprints)");
    await press(page, byTid(page, "srv-compare"));
    const cert = byTid(page, "srv-cert", { changed: "yes" });
    if (!await shown(cert)) return said(n, "Compare fingerprints opened no certificate screen");
    const now = (await textOf(byTid(page, "srv-fp-now"))).replace(/\s+/g, ""), old = (await textOf(byTid(page, "srv-fp-old"))).replace(/\s+/g, "");
    if (!now.includes(blocks(FP2).join("")) || !old.includes(blocks(FP1).join(""))) said(n, `the certificate screen does not show both fingerprints: now "${now}", before "${old}"`);
    await reset();
    // (the screen on top: the stack keeps the screens below it drawn)
    await press(page, byTid(page, "srv-trust").last());
    if (!await shown(confirmSheet(page))) return said(n, "Trust the new certificate… asked nothing");
    await press(page, byTid(page, "confirm-go"));
    const again = await until(async () => (await asked("servers.accept")).length > 0, 10000) && (await asked("servers.accept"))[0];
    if (!again || again.args.id !== "s_off" || again.args.fingerprint !== FP2) said(n, `trusting the changed certificate sent ${JSON.stringify(again && again.args)}, not the one presented now`);
    if (!await until(async () => (await facts(page).first().getAttribute("data-word")) === "connected", 10000)) said(n, "the detail is not Connected after the new certificate was trusted");
    // an error of the call is a red line in the answer (an alert), and the button is off while it runs
    await knob("servers.testSaved", { refuse: [500, "The test could not run."] });
    await press(page, test);
    if (!await until(async () => (await textOf(result)).includes("The test could not run."), 10000)) said(n, "a call that failed shows no line under the button");
    else if (await result.first().getAttribute("role") !== "alert" || await result.first().getAttribute("data-ok") !== "false") said(n, "the error line is not an alert marked not ok");
    await knob("servers.testSaved", { delay: 1500, answer: OK });
    await press(page, test);
    if (!await until(() => isOff(test), 5000)) said(n, "the button is not off while the test runs");
    else if (!(await textOf(test)).includes("Testing…")) said(n, `the button reads "${await textOf(test)}" while the test runs, not "Testing…"`);
    if (!await until(async () => !await isOff(test), 10000)) said(n, "the button stays off after the test");
    note(`${n}: the answer in place (passed, five steps, markup as text, gone with the state), a changed certificate trusted from its screen, an error line, the button off while it runs`);
  };

  // ---------------------------------------------------------------- remove
  P.remove = async (page) => {
    const n = "remove";
    if (!(await chipsSeen(page)).includes("s_bare")) said(n, "the entry has no chip on Home before it is removed: the check would prove nothing");
    await pOpenList(page);
    await pOpenServer(page, "Bare box");
    const question = confirmSheet(page);
    await press(page, byTid(page, "srv-remove"));
    if (!await shown(question)) return said(n, "Remove server… asked nothing");
    const title = await textOf(byTid(page, "confirm-title")), body = await textOf(byTid(page, "confirm-body"));
    if (title !== "Remove “Bare box”?" || body !== "Its section leaves your list. Nothing is deleted or stopped on Bare box: its chats and whiteboards stay there, and you can add it again.") said(n, `the question reads "${title}" / "${body}"`);
    if (await textOf(byTid(page, "confirm-go")) !== "Remove Bare box") said(n, `the button reads "${await textOf(byTid(page, "confirm-go"))}", not "Remove Bare box"`);
    await page.keyboard.press("Escape");
    if (!await gone(question)) said(n, "Esc did not leave the question");
    if (!await facts(page).first().isVisible()) said(n, "Esc over the question left the server's screen as well");
    if ((await asked("servers.remove")).length) said(n, "a removal that was not confirmed was made");
    const calls = [];
    page.on("request", (r) => { if (r.url().includes("/host/call") && r.url().includes("s_bare")) calls.push(r.url()); });
    await press(page, byTid(page, "srv-remove"));
    await shown(question);
    await press(page, byTid(page, "confirm-go"));
    // phone: the detail goes with its entry, to the list, where the row is gone
    if (!await gone(facts(page))) said(n, "the server's screen stays after Remove");
    if (!await shown(byTid(page, "srv-list")) || !await gone(prow(page, "Bare box"))) said(n, "the entry stays in the list after Remove");
    const sent = await asked("servers.remove");
    if (sent.length !== 1 || sent[0].args.id !== "s_bare") said(n, `the removal sent ${JSON.stringify(sent.map((c) => c.args))}`);
    if (calls.length) said(n, `that server was asked ${calls.length} thing(s) when it was removed: ${calls[0]}`);
    if (!await gone(question)) said(n, "the question stays after the removal");
    await showList(page);
    if (!await until(async () => !(await chipsSeen(page)).includes("s_bare"), 10000)) said(n, "the chip of an entry that was removed stays on Home (web/test/sidebar.test.ts \"removing an entry takes its section away\", A-SC-20)");
    note(`${n}: the P4 in its words, Esc leaves it and not the screen, the screen, the row and the section go and its server is told nothing`);
  };

  // ---------------------------------------------------------------- add
  P.add = async (page) => {
    const n = "add";
    await pOpenList(page);
    await press(page, byTid(page, "srv-add"));
    const choose = byTid(page, "add-choose");
    if (!await shown(choose)) return said(n, "Add server shows no sheet of ways in");
    if (!(await textOf(choose)).includes("Add a server")) said(n, `the sheet of ways in reads "${await textOf(choose)}"`);
    for (const a of ["paste", "manual", "help"]) if (!await byTid(page, "action-row", { action: a }).count()) said(n, `the sheet of ways in has no "${a}"`);
    if (await byTid(page, "action-row", { action: "scan" }).count()) said(n, "the web build offers to scan a code (there is no camera: it is the device's)");
    const openManual = async () => {
      await press(page, byTid(page, "srv-add"));
      await shown(choose);
      await press(page, byTid(page, "action-row", { action: "manual" }));
      if (!await shown(byTid(page, "add-form", { step: "manual" }))) throw new Error("Enter address manually shows no form");
    };
    await press(page, byTid(page, "action-row", { action: "manual" }));
    const form = byTid(page, "add-form");
    if (!await shown(form) || await form.first().getAttribute("data-step") !== "manual") return said(n, "Enter address manually shows no manual form");
    if (!(await textOf(byTid(page, "sheet-title"))).includes("New server")) said(n, "the form is not titled New server");
    const field = (f) => byTid(page, "add-field", { field: f });
    const name = field("name"), address = field("address"), secret = field("secret"), box = byTid(page, "add-selfsigned");
    const save = bySheetRight(page), test = byTid(page, "add-test"), trust = byTid(page, "add-trust");
    // the fields
    if (await name.getAttribute("placeholder") !== "Studio" || await name.getAttribute("maxlength") !== "80") said(n, "the Name field has not the placeholder Studio and 80 characters");
    if (await address.getAttribute("placeholder") !== "https://host:port") said(n, "the Address field has not the placeholder https://host:port");
    if (await secret.getAttribute("type") !== "password") said(n, "the secret is not a password field");
    if (await secret.getAttribute("autocomplete") !== "off") said(n, "the secret field is not told to be left out of autofill");
    if (await address.getAttribute("spellcheck") !== "false") said(n, "the Address field checks spelling");
    if (await box.getAttribute("data-on") !== "false") said(n, "the Self-signed switch starts on");
    // (phone: no field has the focus when the form opens, so that the keyboard does not cover the form before it is read)
    if (!await isOff(save) || !await isOff(test)) said(n, "Save or Test connection is on in an empty form");
    if (await page.getByText("Save anyway", { exact: true }).count()) said(n, 'the phone offers "Save anyway" (it has none: Save is on only after a passing test)');
    // the first problem, as something is typed
    const problem = async () => ((await textOf(byTid(page, "add-error", { why: "form" }))) || "");
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
    await secret.fill("s3cret-value");
    if (await problem()) said(n, `a good form gives "${await problem()}"`);
    if (!await isOff(save)) said(n, "Save is on before any test");
    // a test that failed stays in the form (phone: there is no Save anyway; not past a bad address, a duplicate, this computer or another server either)
    await knob("servers.test", { answer: fail1(2, "refused", "Nothing listens there: is the server running on that machine?") });
    await press(page, test);
    const err = byTid(page, "add-error", { why: "test" });
    if (!await until(async () => (await textOf(err)).includes("Step 2 of 5: the connection"), 10000)) said(n, "a failed test shows no step in the form");
    if (!await isOff(save) || await form.first().getAttribute("data-step") !== "manual") said(n, "after a failed test Save is on or the form left its step");
    for (const outcome of ["bad_address", "duplicate", "is_local", "another_server"]) {
      await knob("servers.test", { answer: fail1(outcome === "bad_address" ? 1 : 4, outcome, "no way past " + outcome) });
      await press(page, test);
      if (!await until(async () => (await textOf(err)).includes("no way past " + outcome), 10000)) { said(n, `the answer ${outcome} was not shown`); continue; }
      if (!await isOff(save) || await trust.count()) said(n, `Save is on past ${outcome}`);
    }
    // a test that is slow: "Testing…", then its answer; Save is on only after an OK test of the form as it is (phone: the form turns to Trust and save)
    await knob("servers.test", { delay: 900, answer: OK });
    await press(page, test);
    if (!await until(async () => (await textOf(test)) === "Testing…", 5000)) said(n, "Test connection does not read Testing… while it runs");
    else if (!await isOff(test)) said(n, "the test's button is on while it runs");
    if (!await until(async () => (await form.first().getAttribute("data-step")) === "trust", 10000)) return said(n, "an OK test did not lead to Trust and save");
    if (!await until(async () => !await isOff(save), 5000)) return said(n, "Save is off after an OK test");
    if (!(await textOf(byTid(page, "add-result"))).startsWith("Connected")) said(n, `an OK test's answer reads "${await textOf(byTid(page, "add-result"))}"`);
    if (await byTid(page, "add-result").first().getAttribute("data-ok") !== "true") said(n, "an OK test's answer is not marked ok");
    if (await textOf(trust) !== "Save server") said(n, `the button reads "${await textOf(trust)}": with no fingerprint to compare it is "Save server"`);
    const sentTest = (await asked("servers.test")).at(-1);
    if (!sentTest || sentTest.args.form.secret !== "<12 characters>" || sentTest.args.form.address !== "https://studio.example:4790") said(n, `the test sent ${JSON.stringify(sentTest && sentTest.args)}`);
    // (phone: after the test the form has no fields to change, so a result of another form cannot count: to change a field, Cancel and start again)
    // a save that did not pass: the app tested the form itself; the form stays open with its words, and without a result it says so
    await reset();
    await knob("servers.add", { queue: [{ answer: { saved: false, result: fail1(4, "secret_refused", "Secret not accepted") } }, { answer: { saved: false } }] });
    await press(page, trust);
    if (!await until(async () => (await textOf(byTid(page, "add-error", { why: "test" }))).includes("Secret not accepted"), 10000)) said(n, "a save that did not pass shows no result");
    if (!await form.first().isVisible()) said(n, "the form closed after a save that did not pass");
    await press(page, trust);
    if (!await until(async () => (await textOf(byTid(page, "add-error", { why: "test" }))).includes("The server was not saved."), 10000)) said(n, 'a save with no result says nothing ("The server was not saved.")');
    // saved: the entry is added and the toast says so, then the row reads Connected by itself
    await mockEval("delete flags.app['servers.add'];", url);
    await press(page, trust);
    if (!await gone(form)) return said(n, `the form stays after a save: "${await textOf(form)}"`);
    const sent = (await asked("servers.add")).at(-1)?.args;
    // (phone: the app tests again before it saves, so the add is not forced, as it was after "Save anyway")
    if (!sent || sent.force || sent.form.name !== "Studio" || sent.form.address !== "https://studio.example:4790" || sent.form.secret !== "<12 characters>") said(n, `the add sent ${JSON.stringify(sent)}`);
    if (!(await textOf(byTid(page, "toast"))).includes("Studio added · its chats are in your list")) said(n, `the toast reads "${await textOf(byTid(page, "toast"))}"`);
    const studio = prow(page, "Studio");
    if (!await shown(studio)) return said(n, "the new entry is not in the list");
    if (!await until(async () => (await studio.first().getAttribute("data-word")) === "connected", 15000)) said(n, `the new entry reads "${await studio.first().getAttribute("data-word")}", not connected, by itself`);
    // a self-signed server: its fingerprint to trust (phone: Trust and save pins it; the flow has no box to tick and no second test by the page)
    await openManual();
    await name.fill("Studio Mac");
    await address.fill("https://studio-mac.example:4790");
    await secret.fill("another-secret");
    await press(page, box);
    if (!await until(async () => await box.getAttribute("data-on") === "true", 5000)) said(n, "the Self-signed switch did not turn on");
    await reset();
    await knob("servers.test", { answer: fail1(3, "fingerprint", "Compare this fingerprint with the one shown on the other machine, then accept it", { fingerprint: FP1 }) });
    await press(page, test);
    if (!await until(async () => (await form.first().getAttribute("data-step")) === "trust", 10000)) return said(n, "a self-signed certificate did not lead to Trust and save");
    if (!await shown(byTid(page, "add-compare"))) said(n, "the form does not ask to compare the fingerprint with the one the server printed");
    if ((await textOf(byTid(page, "srv-fp-now"))).replace(/\s+/g, "") !== blocks(FP1).join("")) said(n, `the form does not show the fingerprint to compare: "${await textOf(byTid(page, "srv-fp-now"))}"`);
    if (await textOf(trust) !== "Trust and save") said(n, `the button reads "${await textOf(trust)}", not "Trust and save"`);
    await press(page, trust);
    if (!await gone(form)) return said(n, "the form stays after Trust and save");
    const pinned = (await asked("servers.add")).at(-1)?.args;
    if (!pinned || pinned.form.pin !== FP1 || pinned.form.selfSigned !== true || pinned.form.secret !== "<14 characters>" || pinned.form.name !== "Studio Mac") said(n, `Trust and save sent ${JSON.stringify(pinned)}: the pin the person trusted, self-signed`);
    // the secret is dropped at Cancel: a second form is empty; phone: Esc, Cancel or a swipe ask before they drop what was typed (and Cancel there keeps editing)
    await openManual();
    await secret.fill("yet-another-secret");
    await name.fill("Dropped");
    await page.keyboard.press("Escape");
    if (!await shown(confirmSheet(page))) return said(n, "Esc over a form with typed words asked nothing");
    await press(page, byTid(page, "confirm-cancel"));
    if (!await gone(confirmSheet(page)) || !await form.first().isVisible() || await name.inputValue() !== "Dropped") said(n, "Cancel of the question did not keep the form as it was");
    await press(page, bySheetLeft(page));
    await shown(confirmSheet(page));
    await press(page, byTid(page, "confirm-go"));
    if (!await gone(form)) said(n, "Discard changes did not leave the form");
    await openManual();
    if (await field("secret").inputValue() !== "" || await field("name").inputValue() !== "") said(n, "a form that was cancelled leaves its words for the next");
    await press(page, bySheetLeft(page));
    if (!await gone(form)) said(n, "Cancel of an empty form did not leave it at once");
    note(`${n}: the ways in, the fields, the rule's problems, Save only after a passing test (no Save anyway), a failed test stays, the fingerprint to trust, what is sent, a save that did not pass, the entry connecting by itself, the secret dropped, Esc asks first`);
  };

  // ---------------------------------------------------------------- edit
  P.edit = async (page) => {
    const n = "edit";
    await pOpenList(page);
    await pOpenServer(page, "Office Mac");
    await press(page, byTid(page, "srv-edit"));
    const form = byTid(page, "srv-edit-form");
    if (!await shown(form)) return said(n, "Edit shows no form");
    if (!(await textOf(byTid(page, "sheet-title"))).includes("Edit server")) said(n, "the form is not titled Edit server");
    const field = (f) => byTid(page, "srv-edit-field", { field: f });
    const name = field("name"), address = field("address"), secret = field("secret");
    const save = bySheetRight(page);
    if (await name.inputValue() !== "Office Mac" || await address.inputValue() !== "https://office-mac.example:4790") said(n, "the form does not start from the saved entry");
    if (await secret.inputValue() !== "" || await secret.getAttribute("placeholder") !== "Unchanged") said(n, "the secret is not empty with the placeholder Unchanged");
    if (!await isOff(save)) said(n, "Save is on before something changed");
    // (phone: the form has no Test connection: the app tests what changed itself when it saves, and shows its words in the form)
    // a rename alone: saved without a test
    await name.fill("Office Mac 2");
    if (!await until(async () => !await isOff(save), 5000)) return said(n, "a rename alone does not turn Save on");
    await press(page, save);
    if (!await gone(form)) return said(n, "the form stays after the save of a rename");
    const edit = (await asked("servers.edit")).at(-1)?.args;
    if (!edit || edit.id !== "s_off" || JSON.stringify(edit.patch) !== JSON.stringify({ name: "Office Mac 2" }) || edit.force !== true) said(n, `a rename sent ${JSON.stringify(edit)}: only the name, forced`);
    if ((await asked("servers.testSaved")).length || (await asked("servers.test")).length) said(n, "a rename was tested");
    if (!(await textOf(facts(page))).includes("Office Mac 2")) said(n, "the detail does not show the new name");
    // another change: the app tests it itself; a result that did not pass is shown in the form, which stays open (phone: no test is asked of the person first)
    await press(page, byTid(page, "srv-edit"));
    await shown(form);
    await address.fill("https://office-mac.example:4791");
    await secret.fill("new-secret-1");
    if (!await until(async () => !await isOff(save), 5000)) return said(n, "Save is off for a changed address and secret");
    await knob("servers.edit", { answer: { saved: false, result: fail1(4, "secret_refused", "Secret not accepted") } });
    await press(page, save);
    if (!await until(async () => (await textOf(byTid(page, "form-error"))).includes("Secret not accepted"), 10000)) said(n, "an edit that did not pass shows no words in the form");
    if (!await form.first().isVisible()) said(n, "the form closed after an edit that did not pass");
    await mockEval("delete flags.app['servers.edit'];", url);
    await press(page, save);
    if (!await gone(form)) return said(n, "the form stays after the save");
    const patch = (await asked("servers.edit")).at(-1)?.args;
    if (!patch || JSON.stringify(Object.keys(patch.patch).sort()) !== JSON.stringify(["address", "secret"]) || patch.patch.address !== "https://office-mac.example:4791" || patch.patch.secret !== "<12 characters>" || patch.force !== false) said(n, `the edit sent ${JSON.stringify(patch)}: the address and the secret, as they changed, not forced`);
    // an empty secret is sent as none
    await press(page, byTid(page, "srv-edit"));
    await shown(form);
    await address.fill("https://office-mac.example:4792");
    await until(async () => !await isOff(save), 5000);
    await press(page, save);
    await gone(form);
    const p2 = (await asked("servers.edit")).at(-1)?.args;
    if (!p2 || JSON.stringify(Object.keys(p2.patch)) !== JSON.stringify(["address"])) said(n, `an edit with an empty secret sent ${JSON.stringify(p2 && p2.patch)}: the address alone`);
    // Cancel of a changed form asks first, and sends nothing
    const before = (await asked("servers.edit")).length;
    await press(page, byTid(page, "srv-edit"));
    await shown(form);
    await name.fill("Dropped");
    await press(page, bySheetLeft(page));
    if (!await shown(confirmSheet(page))) return said(n, "Cancel of a changed form asked nothing");
    await press(page, byTid(page, "confirm-go"));
    if (!await gone(form) || (await asked("servers.edit")).length !== before) said(n, "Discard changes left the form open or sent an edit");
    note(`${n}: starts from the entry, the secret empty and "Unchanged", a rename alone saves forced with no test, another change is tested by the app and sends what changed, Cancel asks first`);
  };

  // ---------------------------------------------------------------- the owner's things
  P.owner = async (page) => {
    const n = "this computer";
    await mockEval("flags.mcp = { up: false };", url);
    await pOpenList(page);
    // phone: the test host's transport is `http`, so this computer's detail draws the owner's things (srv-owner); a native app has none (app/test/servers.owner.test.ts)
    await pOpenServer(page, "This computer");
    const owner = byTid(page, "srv-owner");
    if (!await shown(owner)) return said(n, "this computer's detail shows no owner's things");
    for (const id of ["srv-edit", "srv-remove", "srv-test"]) if (await byTid(page, id).count()) said(n, `this computer's detail has ${id}`);
    if (!await until(async () => (await textOf(byTid(owner, "servers-mcp"))) === "MCP listener: http://localhost:6006/mcp (down)", 10000)) said(n, `the MCP listener's line reads "${await textOf(byTid(owner, "servers-mcp"))}", not "(down)"`);
    await pBack(page);
    await mockEval("delete flags.mcp;", url);
    await pOpenServer(page, "This computer");
    if (!await until(async () => (await textOf(byTid(owner, "servers-mcp"))).endsWith("(up)"), 10000)) said(n, "the MCP listener's line does not say (up)");
    // a start that failed: the reason as text (twelve lines and a mark), Retry that fails again and then works
    const reason = Array.from({ length: 30 }, (_, i) => `line ${i + 1} <b>x</b>`).join("\n");
    await mockEval(`setServerState("local", "not_started", { detail: ${JSON.stringify(reason)} });`, url);
    const shownReason = byTid(owner, "servers-reason");
    if (!await shown(shownReason)) return said(n, "a start that failed shows no reason");
    const lines = ((await shownReason.first().textContent()) ?? "").split("\n");
    if (lines.length !== 13 || lines[11] !== "line 12 <b>x</b>" || lines[12] !== "…") said(n, `the reason shows ${lines.length} lines, the 12th "${lines[11]}", then "${lines[12]}"`);
    if (await owner.first().locator("b").count()) said(n, "the reason was drawn as markup");
    // (phone: the word is Unreachable and the list's row says why: "not started")
    await pBack(page);
    if (!(await labelOf(prow(page, "This computer"))).endsWith("Unreachable, not started")) said(n, `this computer's row reads "${await labelOf(prow(page, "This computer"))}", not ending "Unreachable, not started"`);
    await pOpenServer(page, "This computer");
    await mockEval('flags.start = { fail: "still cannot start" };', url);
    await press(page, byTid(owner, "servers-retry"));
    if (!await until(async () => (await textOf(byTid(owner, "servers-reason"))) === "still cannot start", 10000)) said(n, `Retry that fails again shows "${await textOf(byTid(owner, "servers-reason"))}"`);
    await mockEval("delete flags.start;", url);
    await press(page, byTid(owner, "servers-retry"));
    if (!await until(async () => (await facts(page).first().getAttribute("data-word")) === "connected", 10000)) said(n, "Retry did not start the server");
    if (await byTid(owner, "servers-reason").count() || await byTid(owner, "servers-retry").count()) said(n, "the reason and Retry stay after the start");
    // Restart server: asks first when a chat of this computer is at work (the seed has one), and Esc leaves the question with nothing begun;
    // confirmed, it says Restarting… with the button off, and the detail is Connected again when the server answers
    const question = confirmSheet(page), restart = byTid(owner, "servers-restart");
    await mockEval("flags.restart = { delay: 1500 }; appCalls.length = 0;", url);
    await press(page, restart);
    if (!await shown(question)) return said(n, "Restart server with an agent at work asked nothing");
    if (!/^Restart serverRestart ends 1 running agent chat\.RestartCancel$/.test(await textOf(question))) said(n, `the restart's question reads "${await textOf(question)}"`);
    await page.keyboard.press("Escape");
    if (!await gone(question)) said(n, "Esc did not leave the restart's question");
    if (!await facts(page).first().isVisible()) said(n, "Esc over the restart's question left the screen");
    if ((await asked("owner.restart")).length) said(n, "a restart that was not confirmed began");
    await press(page, restart);
    await shown(question);
    await press(page, byTid(page, "confirm-go"));
    if (!await until(async () => (await textOf(byTid(owner, "servers-owner-line"))) === "Restarting…", 10000)) said(n, "a restart does not say Restarting…");
    else if (!await isOff(restart)) said(n, "Restart server is on while it runs");
    if (!await until(async () => (await facts(page).first().getAttribute("data-word")) === "connected" && !await byTid(owner, "servers-owner-line").count(), 15000)) said(n, "the detail is not Connected again after the restart");
    if ((await asked("owner.restart")).length !== 1) said(n, `the restart asked the app ${(await asked("owner.restart")).length} times`);
    // a restart that fails: the owner's things say so with the reason, and offer Restart server again (A-OW-13)
    await mockEval('flags.restart = { fail: "the server stopped while starting" }; appCalls.length = 0;', url);
    await press(page, restart);
    await shown(question);
    await press(page, byTid(page, "confirm-go"));
    if (!await until(async () => { const t = await textOf(owner); return t.includes("Restart failed") && t.includes("the server stopped while starting"); }, 10000)) said(n, `a restart that failed says "${await textOf(owner)}"`);
    else if (!await restart.count() || await isOff(restart)) said(n, "after a restart that failed the owner's things do not offer Restart server");
    await mockEval("delete flags.restart;", url);
    note(`${n}: this computer's detail, the MCP listener (up and down), the reason as text (12 lines and a mark), Retry that fails and works, Restarting…, the question while an agent works, Esc, the restart; no Edit, Remove or Test`);
  };

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
    // wide: the dialog's Cancel then Restart; phone: the confirm sheet's Restart button over its Cancel
    if (!(wide ? /^Restart serverRestart ends 1 running agent chat\.CancelRestart$/ : /^Restart serverRestart ends 1 running agent chat\.RestartCancel$/).test(await textOf(question))) said(n, `the restart's question reads "${await textOf(question)}"`);
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
  // phone: the list and the details are screens, read where the dialog was: the list, an unreachable server's detail after a test, a changed certificate's detail
  const readScreens = async (pref) => {
    await seed(url, "A1");
    const { ctx, page } = await open({ sel: {}, ls: { "aiwb.theme": pref } });
    try {
      await knob("servers.testSaved", { answer: fail1(2, "refused", "Nothing listens there: is the server running on that machine?") });
      await mockEval(`setServerState("s_bare", "certificate_changed", { fingerprint: "${FP2}", pin: "${FP1}" });`, url);
      await pOpenList(page);
      await atRest(page);
      const rows = [...await contrastAudit(page, { only: ['[data-testid="srv-list"]'] })];
      await pOpenServer(page, "Office Mac");
      await press(page, byTid(page, "srv-test"));
      await shown(byTid(page, "srv-result"));
      await atRest(page);
      rows.push(...await contrastAudit(page, { only: ['[data-testid="srv-facts"]'] }));
      await pBack(page);
      await pOpenServer(page, "Bare box");
      await shown(byTid(page, "srv-cert-notice"));
      await atRest(page);
      rows.push(...await contrastAudit(page, { only: ['[data-testid="srv-facts"]'] }));
      const least = new Map();
      for (const r of rows) { const key = `${r.kind} "${r.what}" (${r.where})`, was = least.get(key); if (!was || r.ratio < was.ratio) least.set(key, r); }
      return least;
    } finally { await ctx.close(); await reset(); await mockEval('setServerState("s_bare", "connected");', url); }
  };
  const readOf = wide ? readRows : readScreens, readWhat = wide ? "the Servers dialog" : "the Servers screens";
  if ((viewport === "desktop" || viewport === "phone") && !only) {
    const under = { light: await readOf("light"), dark: await readOf("dark") };
    for (const [flavour, over] of Object.entries(FLAVOURS)) {
      const rows = await readOf(flavour), base = under[over];
      if (rows.size < 8) said(`${flavour}, ${readWhat}`, `only ${rows.size} texts were read: ${wide ? "the dialog" : "the screens are"} not on screen`);
      const asToday = [];
      for (const [key, r] of rows) {
        if (r.ratio >= FLOOR) continue;
        const was = base.get(key);
        if (was && r.ratio >= was.ratio - 0.005) asToday.push(`${r.where.split(" > ").pop()} ${r.ratio}`);
        else said(`${flavour}, ${readWhat}`, `${key} is ${r.fg} on ${r.bg}, ${r.ratio}:1, under ${FLOOR}:1${was ? ` and under the ${was.ratio}:1 it has in ${over}` : ` (${over} has no such element)`}`);
      }
      note(`${flavour}: ${rows.size} texts read; under ${FLOOR}:1 and no weaker than in ${over}: ${asToday.join(", ") || "nothing"}`);
    }
  }
}, { viewports, page: false });
