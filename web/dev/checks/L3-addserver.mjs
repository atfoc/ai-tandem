// L3 (new in the app, package S12): adding a server on a phone (goal 4.7), the paste path, on the mock. The scan path is device-only (it needs a
// camera: V4); here the build draws no scan button at all, which is checked. At the phone viewport (and, short, the desktop's, which keeps
// S3's form as it is):
//   the form        "Add server" has the box to paste into above the fields, and says before any connection why the system will ask to reach the local
//                   network
//   a paste         the whole output of setup-remote.sh (a real one: packages/core/test/fixtures/remote-setup) fills the address (the first), the
//                   secret, the name (the host's first label) and ticks "Self-signed certificate"; the box is emptied, the page shows the secret nowhere
//                   (not in its text, not in the storage) and nothing is accepted for the person; the other addresses are offered, one is chosen
//   the fingerprint "Test connection" shows the fingerprint the server presents, and the form says whether it is the one the text printed; the person
//                   accepts it (or not, when it differs); the add sends the accepted pin and the secret by its length
//   refused         the empty box, text that is no server's, an address without a secret, the output of `remote setup` without the secret, http, an
//                   address the form refuses, two secrets, a bad fingerprint: each refused in its words, the fields left as they were, the words
//                   without the secret
//   local network   a test answered `local_network_denied` shows the outcome's words, step 2 and the help (the page has no settings to open: the button
//                   is the device's, V1/V4); a saved entry in "unreachable" with those words shows the help in its row, one with another detail does not
// The parser itself is proved by packages/core/test/servercode.test.ts, the form's decisions by app/test/addcode.test.ts.
import { readFileSync } from "node:fs";

import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["phone", "desktop"];

const FIX = new URL("../../../packages/core/test/fixtures/remote-setup/", import.meta.url);
const fixture = (n) => readFileSync(new URL(n, FIX), "utf8");
const SETUP = fixture("setup-remote-default.txt");
const RAW = fixture("remote-setup-raw.txt");
const SECRET = fixture("secret-line.txt").trim();
const FP = "E6:45:B0:35:48:5E:F3:4B:96:8E:6E:F4:40:67:7F:5E:E4:E7:43:3E:71:0D:21:3E:4A:F8:04:DE:DD:3F:A2:E2";
const FP_OTHER = "12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0";
const DENIED = "This app may not reach the local network: allow it in the system settings";
const OK = { ok: true, step: 5, outcome: "connected", message: "Connected", version: "dev", agents: ["claude"] };
const fingerprint = (fp) => ({ ok: false, step: 3, outcome: "fingerprint", message: "Compare this fingerprint with the one shown on the other machine, then accept it", fingerprint: fp });

await check("L3 adding a server on a phone: paste, the fingerprint, the refusals, the local network", async ({ url, layout, open, fail, note }) => {
  const said = (n, m) => fail(`${n}: ${m}`);
  const knob = (op, v) => mockEval(`(flags.app ??= {})[${JSON.stringify(op)}] = ${JSON.stringify(v)};`, url);
  const reset = () => mockEval("delete flags.app; appCalls.length = 0;", url);
  const asked = (op) => mockEval(`return appCalls.filter((c) => c.op === ${JSON.stringify(op)});`, url);
  const dialog = (page) => byTid(page, "servers-dialog");
  const field = (page, f) => byTid(page, "servers-input", { field: f });
  const btn = (root, name) => root.getByRole("button", { name, exact: true });
  const textOf = async (loc) => ((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
  const shown = (loc) => until(() => loc.first().isVisible().catch(() => false), 15000);
  const gone = (loc) => until(async () => (await loc.count()) === 0, 15000);
  const openForm = async (page) => {
    await press(page, byTid(page, "servers-btn").first());
    if (!await shown(byTid(page, "servers-row"))) throw new Error("the Servers button opened no list");
    await press(page, btn(dialog(page), "Add server"));
    if (!await shown(byTid(page, "servers-form"))) throw new Error("Add server shows no form");
  };

  await seed(url, "A1");
  const { ctx, page } = await open({ sel: {} });
  try {
    await openForm(page);
    const form = byTid(page, "servers-form");
    const code = byTid(page, "addserver-code-box");
    const paste = field(page, "code"), name = field(page, "name"), address = field(page, "address"), secret = field(page, "secret"), box = byTid(page, "servers-selfsigned");

    // ------------------------------------------------------------ the desktop keeps S3's form: nothing to paste, nothing weaker
    if (layout !== "phone") {
      if (await code.count()) said("desktop", "the wide layout's add form has the box to paste into (it is the phone's way in)");
      if (await byTid(page, "addserver-localnet").count()) said("desktop", "the wide layout's add form explains the system's question");
      note("desktop: the add form is S3's, with no box to paste into");
      return;
    }

    // ------------------------------------------------------------ the form: the box, the explanation, no scan on the web
    const n = "the form";
    if (!await shown(code)) return said(n, "the add form has no box to paste into");
    if (await paste.first().getAttribute("placeholder") !== "Paste the output of setup-remote.sh, or an address and the secret") said(n, "the box has not its placeholder");
    if (!await shown(byTid(page, "addserver-localnet"))) said(n, "the form does not say why the system will ask to reach the local network");
    else {
      const why = await textOf(byTid(page, "addserver-localnet"));
      if (!/local network/.test(why) || !/ask/.test(why)) said(n, `the explanation reads "${why}"`);
    }
    if (await byTid(page, "addserver-scan").count()) said(n, "the web build draws a scan button (there is no camera scan on the web: it is the device's, V4)");
    if (!await btn(form, "Fill in the form").count()) said(n, 'no "Fill in the form" button');
    else if ((await btn(form, "Fill in the form").getAttribute("aria-disabled")) !== "true") said(n, "Fill in the form is on with an empty box");
    const noted = () => textOf(byTid(page, "addserver-note"));
    const notedOk = async () => (await byTid(page, "addserver-note").first().getAttribute("data-ok").catch(() => null));
    const untouched = async (what) => {
      for (const [f, loc] of [["name", name], ["address", address], ["secret", secret]]) if (await loc.inputValue() !== "") said(what, `a refused text filled the ${f} field`);
      if (await box.getAttribute("aria-checked") !== "false") said(what, "a refused text ticked the self-signed box");
    };

    // ------------------------------------------------------------ the refusals, each in its words; nothing filled
    const R = "refused";
    const refusals = [
      ["a short text that is no server's", "hello", /not what a server prints/],
      ["an address without a secret", "https://studio.example:4790", /secret is missing/],
      ["the output of `remote setup`, which prints no secret", RAW, /secret is missing.*setup-remote\.sh/],
      ["plain http", `http://studio.example:4790 ${SECRET}`, /https only/],
      ["an address the form refuses", `https://studio.example\nSecret: ${SECRET}`, /cannot take.*https:\/\/host:port/],
      ["a secret with a space", "https://studio.example:4790\nSecret: two words", /spaces|256 characters/],
      ["two different secrets", `https://studio.example:4790\nSecret: ${SECRET}\nSecret: ${SECRET.replace(/^./, "0")}`, /two different secrets/],
      ["a fingerprint that is none", `https://studio.example:4790\nSecret: ${SECRET}\nFingerprint: E6:45`, /not 32 pairs/],
      ["a secret and nothing to reach", `Fingerprint: ${FP}\nSecret: ${SECRET}`, /No server address/],
    ];
    for (const [what, text, words] of refusals) {
      await paste.fill(text);
      // (a long text arrives as a paste and is read at once; a short one, or a small edit of what the box holds, is read by the button)
      await press(page, btn(form, "Fill in the form"));
      if (!await until(async () => (await notedOk()) === "false", 5000)) { said(R, `${what}: no refusal (note: "${await noted()}")`); continue; }
      const words2 = await noted();
      if (!words.test(words2)) said(R, `${what}: the refusal reads "${words2}"`);
      if (words2.includes(SECRET) || words2.includes("studio.example")) said(R, `${what}: the refusal repeats the text or the secret`);
      await untouched(`${R} (${what})`);
    }
    await paste.fill("");
    if ((await btn(form, "Fill in the form").getAttribute("aria-disabled")) !== "true") said(R, "Fill in the form is on with an empty box again");
    note(`${R}: ${refusals.length} texts that are no server's, in words, nothing filled`);

    // ------------------------------------------------------------ a paste: the whole output of setup-remote.sh
    const P = "paste";
    await paste.fill(SETUP);
    if (!await until(async () => (await notedOk()) === "true", 5000)) return said(P, `the output of setup-remote.sh was not taken: "${await noted()}"`);
    if (await address.inputValue() !== "https://mac.example.net:4790") said(P, `the address is "${await address.inputValue()}", not the first of the output`);
    if (await name.inputValue() !== "mac") said(P, `the name is "${await name.inputValue()}", not the host's first label`);
    if (await secret.inputValue() !== SECRET) said(P, "the secret field does not hold the secret of the output");
    if (await secret.getAttribute("type") !== "password") said(P, "the secret is not in a password field");
    if (await box.getAttribute("aria-checked") !== "true") said(P, "the self-signed box was not ticked");
    if (await paste.inputValue() !== "") said(P, "the box still holds the pasted text (and its secret)");
    if (await byTid(page, "servers-selfsigned").count() && (await textOf(form)).includes("Accepted fingerprint")) said(P, "a fingerprint was accepted for the person");
    if (!(await textOf(form)).includes(`The text says the fingerprint is ${FP}`)) said(P, "the form does not show the fingerprint the text printed");
    // (the password field's own value attribute is the field: React keeps it in step with what is typed)
    const body = await page.evaluate(() => {
      const copy = document.body.cloneNode(true);
      copy.querySelectorAll("input[type=password]").forEach((e) => e.removeAttribute("value"));
      return copy.innerText + "\n" + copy.outerHTML + "\n" + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    });
    if (body.includes(SECRET)) said(P, "the secret is on the page (its text, its markup or its storage)");
    const choices = byTid(page, "addserver-address");
    if (await choices.count() !== 3) said(P, `${await choices.count()} addresses are offered, not the 3 of the output`);
    else {
      if (await choices.nth(0).getAttribute("aria-checked") !== "true") said(P, "the first address is not the chosen one");
      await press(page, choices.nth(1));
      if (!await until(async () => (await address.inputValue()) === "https://192.168.0.20:4790", 5000)) said(P, `choosing the second address left "${await address.inputValue()}"`);
      if (await choices.nth(1).getAttribute("aria-checked") !== "true" || await choices.nth(0).getAttribute("aria-checked") !== "false") said(P, "the choice is not marked");
      if (await secret.inputValue() !== SECRET) said(P, "choosing an address lost the secret");
    }
    const filled = await asked("servers.test");
    if (filled.length) said(P, "the paste connected to the server by itself (the person tests, then accepts)");

    // ------------------------------------------------------------ the fingerprint: the server's, set against the text's, and the person accepts
    const F = "fingerprint";
    await knob("servers.test", { queue: [{ answer: fingerprint(FP) }, { answer: OK }] });
    await press(page, btn(form, "Test connection"));
    if (!await shown(btn(form, "Accept fingerprint"))) return said(F, "the test offers no fingerprint to accept");
    const matchLine = byTid(page, "addserver-fp-match");
    if (!await shown(matchLine) || await matchLine.first().getAttribute("data-match") !== "match" || await textOf(matchLine) !== "It is the fingerprint the pasted text printed.") said(F, `the form does not say the fingerprint is the text's: "${await textOf(matchLine)}"`);
    if (await box.getAttribute("aria-checked") !== "true" || (await textOf(form)).includes("Accepted fingerprint")) said(F, "the fingerprint was accepted before the person pressed Accept");
    await press(page, btn(form, "Accept fingerprint"));
    if (!await until(async () => (await textOf(form)).includes(`Accepted fingerprint ${FP}`), 10000)) return said(F, "Accept fingerprint did not put the pin in the form");
    if (!await until(async () => (await btn(form, "Save").getAttribute("aria-disabled")) !== "true", 10000)) return said(F, "Save is off after the accepted test");
    await press(page, byTid(page, "servers-save"));
    if (!await gone(form)) return said(F, "the form stays after a save");
    const added = (await asked("servers.add")).at(-1)?.args;
    if (!added || added.form.address !== "https://192.168.0.20:4790" || added.form.secret !== "<64 characters>" || added.form.selfSigned !== true || added.form.pin !== FP || added.form.name !== "mac") {
      said(F, `the add sent ${JSON.stringify(added)}`);
    }
    note(`${P}: the first address, the secret in a password field and nowhere on the page, the name, the box ticked, the box emptied, the other addresses to choose`);
    note(`${F}: the server's fingerprint is set against the text's, the person accepts, the add sends the pin and the secret by its length`);

    // ------------------------------------------------------------ a fingerprint that is not the text's: said, not accepted for the person
    await reset();
    await press(page, btn(dialog(page), "Add server"));
    await shown(form);
    await paste.fill(`${SETUP}`.replace("mac.example.net", "other.example.net").replace(/https:\/\/mac\.example\.net/, "https://other.example.net"));
    await until(async () => (await notedOk()) === "true", 5000);
    await knob("servers.test", { answer: fingerprint(FP_OTHER) });
    await press(page, btn(form, "Test connection"));
    if (!await shown(btn(form, "Accept fingerprint"))) return said(F, "the second test offers no fingerprint to accept");
    const other = byTid(page, "addserver-fp-match");
    if (!await shown(other) || await other.first().getAttribute("data-match") !== "differs" || !/NOT the fingerprint the pasted text printed.*Do not accept/.test(await textOf(other))) said(F, `a fingerprint that differs from the text's is not warned of: "${await textOf(other)}"`);
    await press(page, btn(form, "Cancel"));
    await gone(form);

    // ------------------------------------------------------------ the local network, refused
    const L = "local network";
    await reset();
    await press(page, btn(dialog(page), "Add server"));
    await shown(form);
    await paste.fill(SETUP);
    await until(async () => (await notedOk()) === "true", 5000);
    await knob("servers.test", { queue: [{ answer: { ok: false, step: 2, outcome: "local_network_denied", message: DENIED } }, { answer: OK }] });
    await press(page, btn(form, "Test connection"));
    const help = byTid(page, "addserver-localnet-denied");
    if (!await shown(help)) return said(L, "a test answered local_network_denied shows no help");
    const result = await textOf(byTid(form, "servers-result"));
    if (!result.includes(DENIED) || !result.includes("Step 2 of 5: the connection")) said(L, `the test's block reads "${result}"`);
    if (!/not let AI Whiteboard reach the local network/.test(await textOf(help))) said(L, `the help reads "${await textOf(help)}"`);
    if (await byTid(page, "addserver-open-settings").count()) said(L, "the web build draws a button to the system's settings (it has none: the button is the device's, V1/V4)");
    if (await btn(form, "Save").getAttribute("aria-disabled") !== "true") said(L, "Save is on after a test that was refused by the system");
    await press(page, btn(form, "Test connection"));
    if (!await gone(help)) said(L, "the help stays after a test that passed");
    await press(page, btn(form, "Cancel"));
    await gone(form);
    // a saved entry in `unreachable` with the permission's words shows the help in its row, one with another detail does not
    const row = (nm) => byTid(page, "servers-row").filter({ has: byTid(page, "servers-name").and(page.getByText(nm, { exact: true })) });
    await mockEval(`setServerState("s_off", "unreachable", { detail: ${JSON.stringify(DENIED)} });`, url);
    if (!await until(async () => (await row("Office Mac").locator('[data-testid="addserver-localnet-denied"]').count()) === 1, 10000)) said(L, "an entry unreachable for the permission shows no help in its row");
    if (await row("Bare box").locator('[data-testid="addserver-localnet-denied"]').count()) said(L, "an entry that is not the permission's shows the help");
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" });', url);
    if (!await until(async () => (await row("Office Mac").locator('[data-testid="addserver-localnet-denied"]').count()) === 0, 10000)) said(L, "the help stays in a row whose detail is another");
    note(`${L}: the outcome's words and step, the help in the form and in a row, none for another detail; no settings button on the web`);
  } finally {
    await ctx.close();
    await reset();
  }
}, { viewports, page: false });
