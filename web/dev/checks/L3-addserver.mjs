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
// The PHONE half (ux-improvements goal 4.10, package S2) proves these on the add flow of the pushed Servers screens (mockups dl-04a to dl-04e):
// Servers → "+" → Choose how (`add-choose`) → "Paste setup text" with an empty clipboard → the box (`add-form` step paste) → the check step (step
// check) → Test connection, whose pin is the text's fingerprint → Trust and save (step trust), or the mismatch (step mismatch: only Cancel). Where
// the phone differs by design: the secret is dots, never in a field; the local network is announced on iOS alone (device flow _v4-localnet), so
// the web build announces nothing; a saved entry's help is on its detail, the one place for a server. The certificates come from the mock's
// `flags.certs` (the test's pin compared with them).
// The parser itself is proved by packages/core/test/servercode.test.ts, the form's decisions by app/test/addcode.test.ts and app/test/addflow.test.ts.
import { readFileSync } from "node:fs";

import { check, mockEval, seed, until } from "../shot.mjs";
import { act, back, byTid, press } from "./sel.mjs";

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
  const reset = () => mockEval("delete flags.app; delete flags.certs; appCalls.length = 0;", url);
  const flat = (fp) => String(fp ?? "").replace(/[:\s]/g, "").toUpperCase();
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
    // ------------------------------------------------------------ the desktop keeps S3's form: nothing to paste, nothing weaker
    if (layout !== "phone") {
      await openForm(page);
      if (await byTid(page, "addserver-code-box").count()) said("desktop", "the wide layout's add form has the box to paste into (it is the phone's way in)");
      if (await byTid(page, "addserver-localnet").count()) said("desktop", "the wide layout's add form explains the system's question");
      note("desktop: the add form is S3's, with no box to paste into");
      return;
    }

    // ================================================================ the phone: the add flow of the pushed Servers screens (mockups dl-04a to dl-04e)
    // Servers → "+" → Choose how (P1, `add-choose`) → "Paste setup text" → the P3 "New server" (`add-form`, its step in `data-step`). The clipboard
    // holds nothing here (an empty text), so the press opens the box to paste into; a clipboard with a setup text is UX.S2-servers' `add-match`.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const step = (s) => byTid(page, "add-form", { step: s });
    const sheet = () => byTid(page, "add-form-sheet").last();
    const save = () => byTid(page, "sheet-right").last();
    const isOff = async (loc) => (await loc.first().getAttribute("aria-disabled")) === "true";
    const paste = () => byTid(page, "add-field", { field: "code" });
    const openPaste = async () => {
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => {});
      if (!await byTid(page, "srv-plus").last().isVisible().catch(() => false)) await act(page, "srv-list");
      await press(page, byTid(page, "srv-plus").last());
      if (!await shown(byTid(page, "add-choose"))) throw new Error("the bar's + opened no Choose how");
      await press(page, byTid(page, "action-row", { action: "paste" }));
      if (!await shown(step("paste"))) throw new Error("Paste setup text with an empty clipboard opened no box to paste into");
    };
    /** Leaves the form whatever it holds: Cancel, and Discard changes when it asks. */
    const leave = async () => {
      await press(page, byTid(page, "sheet-left").last());
      const ask = page.locator('[data-testid="confirm-dialog"], [data-testid="confirm-sheet"]');
      if (await until(() => ask.first().isVisible().catch(() => false), 1500)) await press(page, byTid(page, "confirm-go").last());
      await gone(byTid(page, "add-form"));
    };

    // ------------------------------------------------------------ the ways in, the box; no scan and no local-network notice on the web
    const n = "the form";
    await act(page, "srv-list");
    await press(page, byTid(page, "srv-plus").last());
    if (!await shown(byTid(page, "add-choose"))) return said(n, "the bar's + opened no Choose how");
    if (await byTid(page, "action-row", { action: "scan" }).count()) said(n, "the web build offers Scan QR code (there is no camera scan on the web: it is the device's, _v4-scan)");
    if (!await byTid(page, "action-row", { action: "paste" }).count()) said(n, "Choose how has no Paste setup text");
    await page.keyboard.press("Escape");
    if (!await gone(byTid(page, "add-choose"))) said(n, "Esc did not close Choose how");
    await openPaste();
    if (!await shown(paste())) return said(n, "the paste step has no box to paste into");
    if (await paste().first().getAttribute("placeholder") !== "Paste here") said(n, `the box's placeholder is "${await paste().first().getAttribute("placeholder")}"`);
    if (!(await textOf(step("paste"))).includes("Paste what setup-remote.sh printed on the server, or an address and the secret.")) said(n, "the box does not say what goes in it");
    // phone: the system's question is announced on iOS alone (goal 3.8.3, dl-04c: "iOS will ask about your local network"); the device flow
    // _v4-localnet shows it. The web build asks nothing, so it announces nothing.
    if (await byTid(page, "add-localnet").count()) said(n, "the web build announces the local network question (iOS's)");
    const read = byTid(page, "add-read");
    if (!await read.count()) said(n, 'no "Use this text" button');
    else if (!await isOff(read)) said(n, "Use this text is on with an empty box");
    if (!await isOff(save())) said(n, "Save is on before any test");
    note(`${n}: Choose how (paste, no scan on the web), the box to paste into and its words, Use this text off while empty, no local-network notice on the web`);

    // ------------------------------------------------------------ the refusals, each in its words; the form not filled
    const R = "refused";
    const noteOf = byTid(page, "add-note", { ok: false });
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
      await paste().fill(text);
      // (a long text arrives as a paste and is read at once; a short one, or a small edit of what the box holds, is read by the button)
      if (await read.isVisible().catch(() => false) && !await isOff(read)) await press(page, read);
      if (!await until(async () => words.test(await textOf(noteOf)), 5000)) { said(R, `${what}: no refusal in its words (the note: "${await textOf(noteOf)}")`); continue; }
      const words2 = await textOf(noteOf);
      if (words2.includes(SECRET) || words2.includes("studio.example")) said(R, `${what}: the refusal repeats the text or the secret`);
      if (!await step("paste").count()) said(R, `${what}: a refused text left the box for the form (step ${await byTid(page, "add-form").first().getAttribute("data-step")})`);
      if ((await asked("servers.test")).length) said(R, `${what}: a refused text was tested`);
    }
    await paste().fill("");
    if (!await isOff(read)) said(R, "Use this text is on with an empty box again");
    note(`${R}: ${refusals.length} texts that are no server's, in words, the box kept, nothing tested`);

    // ------------------------------------------------------------ a paste: the whole output of setup-remote.sh fills the check step
    const P = "paste";
    // the server at both addresses the output names presents the certificate the output printed (the mock compares the test's pin with it)
    const certs = () => mockEval(`flags.certs = { "mac.example.net": ${JSON.stringify(FP)}, "192.168.0.20": ${JSON.stringify(FP)}, "other.example.net": ${JSON.stringify(FP_OTHER)} };`, url);
    await certs();
    await paste().fill(SETUP);
    if (!await shown(step("check"))) return said(P, `the output of setup-remote.sh was not taken: "${await textOf(noteOf)}"`);
    if (!await byTid(page, "add-filled").count()) said(P, 'the form does not say "Filled in from the code"');
    const nameBox = byTid(page, "add-field", { field: "name" });
    if (await nameBox.inputValue() !== "mac") said(P, `the name is "${await nameBox.inputValue()}", not the host's first label`);
    const form = await textOf(step("check"));
    if (!form.includes("https://mac.example.net:4790")) said(P, `the address is not the first of the output: "${form}"`);
    // phone: the secret is never in a field: dots that do not count it, "from the code" (dl-04c)
    if (!/●●●/.test(form) || !form.includes("from the code")) said(P, "the secret is not shown as dots from the code");
    if (await byTid(page, "add-field", { field: "secret" }).count()) said(P, "the check step has a field with the secret");
    if (!/Certificate\s*Self-signed/.test(form)) said(P, "the form does not say the certificate is self-signed");
    if (await paste().count()) said(P, "the box (and the pasted text with its secret) stays");
    const body = await page.evaluate(() => document.body.innerText + "\n" + document.documentElement.outerHTML + "\n" + [...document.querySelectorAll("input,textarea")].map((e) => e.value).join("\n") + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    if (body.includes(SECRET)) said(P, "the secret is on the page (its text, its markup, a field or its storage)");
    // nothing is accepted or tested for the person: Save is off until a test passes (phone: "Trust and save" is the person's press)
    if ((await asked("servers.test")).length) said(P, "the paste connected to the server by itself (the person tests, then trusts)");
    if (!await isOff(save())) said(P, "Save is on before the test");
    const choices = byTid(page, "add-address");
    if (await choices.count() !== 3) said(P, `${await choices.count()} addresses are offered, not the 3 of the output`);
    else {
      const on = (i) => choices.nth(i).getAttribute("data-on");
      if (await on(0) !== "true") said(P, "the first address is not the chosen one");
      await press(page, choices.nth(1));
      if (!await until(async () => (await textOf(step("check"))).includes("https://192.168.0.20:4790"), 5000)) said(P, "choosing the second address did not put it in the form");
      if (await on(1) !== "true" || await on(0) !== "false") said(P, "the choice is not marked");
    }
    note(`${P}: the first address, the secret as dots and nowhere on the page, the name, self-signed, the box gone, the other addresses to choose, nothing tested`);

    // ------------------------------------------------------------ the fingerprint: the test pins the text's; the person trusts and saves
    const F = "fingerprint";
    await press(page, byTid(page, "add-test"));
    if (!await shown(step("trust"))) return said(F, `the test did not come to the trust step: "${await textOf(byTid(page, "add-error"))}"`);
    const tested = (await asked("servers.test")).at(-1)?.args?.form;
    // the code's fingerprint is the test's pin, so the certificate is checked before the secret is sent (lead's decision, goal 3.8.3)
    if (!tested || flat(tested.pin) !== flat(FP) || tested.selfSigned !== true || tested.secret !== "<64 characters>") said(F, `the test sent ${JSON.stringify(tested)}: the text's fingerprint as the pin`);
    const match = byTid(page, "add-match", { match: "yes" });
    if (!await shown(match) || !(await textOf(match)).includes("Matches the fingerprint in the code")) said(F, `the form does not say the fingerprint is the text's: "${await textOf(byTid(page, "add-match"))}"`);
    const drawn = (await byTid(page, "srv-fp-now").last().locator('[data-testid="srv-fp-block"]').allTextContents()).join("");
    if (flat(drawn) !== flat(FP)) said(F, `the fingerprint drawn is "${drawn}", not the text's`);
    if ((await asked("servers.add")).length) said(F, "the server was saved before the person pressed Trust and save");
    await press(page, byTid(page, "add-trust"));
    if (!await gone(byTid(page, "add-form"))) return said(F, "the form stays after Trust and save");
    const added = (await asked("servers.add")).at(-1)?.args;
    if (!added || added.form.address !== "https://192.168.0.20:4790" || added.form.secret !== "<64 characters>" || added.form.selfSigned !== true || flat(added.form.pin) !== flat(FP) || added.form.name !== "mac") {
      said(F, `the add sent ${JSON.stringify(added)}`);
    }
    note(`${F}: the test pins the text's fingerprint, the form says it matches, the person trusts, the add sends the pin and the secret by its length`);

    // ------------------------------------------------------------ a fingerprint that is not the text's: said, no way to trust, nothing saved
    await reset();
    await certs();
    await openPaste();
    await paste().fill(SETUP.replaceAll("mac.example.net", "other.example.net"));
    if (!await shown(step("check"))) return said(F, "the second text was not taken");
    await press(page, byTid(page, "add-test"));
    if (!await shown(step("mismatch"))) return said(F, `a certificate that is not the text's did not come to the mismatch: step ${await byTid(page, "add-form").first().getAttribute("data-step")}`);
    if (!(await textOf(byTid(page, "add-match", { match: "no" }))).includes("Does NOT match the code")) said(F, "a fingerprint that differs from the text's is not warned of");
    if (await byTid(page, "add-trust").count() || !await isOff(save())) said(F, "a fingerprint that differs can be trusted or saved");
    if ((await asked("servers.add")).length) said(F, "a fingerprint that differs was saved");
    await press(page, byTid(page, "add-cancel"));
    await gone(byTid(page, "add-form"));

    // ------------------------------------------------------------ the local network, refused
    const L = "local network";
    await reset();
    await openPaste();
    await paste().fill(SETUP);
    await shown(step("check"));
    await knob("servers.test", { queue: [{ answer: { ok: false, step: 2, outcome: "local_network_denied", message: DENIED } }, { answer: OK }] });
    await press(page, byTid(page, "add-test"));
    const error = byTid(page, "add-error", { why: "test" });
    if (!await shown(error)) return said(L, "a test answered local_network_denied shows nothing");
    const result = await textOf(error);
    if (!result.includes(DENIED) || !result.includes("Step 2 of 5: the connection")) said(L, `the test's words read "${result}"`);
    const HELP = /not let AI Whiteboard reach the local network/;
    if (!HELP.test(await textOf(step("check")))) said(L, "a test refused by the system shows no help");
    if (await byTid(page, "add-open-settings").count()) said(L, "the web build draws a button to the system's settings (it has none: the button is the device's)");
    if (!await isOff(save()) || await byTid(page, "add-trust").count()) said(L, "Save is on after a test that was refused by the system");
    await press(page, byTid(page, "add-test"));
    if (!await shown(step("trust"))) said(L, "a test that passed after the refusal did not come to the trust step");
    else if (HELP.test(await textOf(sheet()))) said(L, "the help stays after a test that passed");
    await leave();
    // a saved entry in `unreachable` with the permission's words says so on its detail, one with another reason does not (phone: the detail is the
    // one place for a server, goal 3.8.2; its "why" names the permission and what to try, dl-03d)
    const NET = /Local network is off[\s\S]*allow Local Network/;
    const whyOf = async (id) => textOf(byTid(page, "srv-facts", { server: id }).last());
    await mockEval(`setServerState("s_off", "unreachable", { detail: ${JSON.stringify(DENIED)} });`, url);
    await press(page, byTid(page, "srv-row", { server: "s_off" }).last());
    if (!await shown(byTid(page, "srv-facts", { server: "s_off" }))) return said(L, "the row of Office Mac pushed no detail");
    if (!await until(async () => NET.test(await whyOf("s_off")), 10000)) said(L, `an entry unreachable for the permission does not say so on its detail: "${await whyOf("s_off")}"`);
    await mockEval('setServerState("s_off", "unreachable", { detail: "connection refused" });', url);
    if (!await until(async () => !NET.test(await whyOf("s_off")), 10000)) said(L, "the permission's words stay on a detail whose reason is another");
    await back(page);
    await press(page, byTid(page, "srv-row", { server: "s_bare" }).last());
    if (await shown(byTid(page, "srv-facts", { server: "s_bare" })) && NET.test(await whyOf("s_bare"))) said(L, "an entry that is not the permission's says the permission");
    note(`${L}: the outcome's words and step, the help in the form and on a detail, none for another reason; no settings button on the web`);
  } finally {
    await ctx.close();
    await reset();
  }
}, { viewports, page: false });
