// The Servers dialog (src/Servers.tsx with the real src/store.ts and src/conn.ts), bundled with
// esbuild as conn.test.ts does and rendered to a string: there is no DOM here, so no click, focus
// or layer is checked. What another server said must come out as text. The store's useStore is
// replaced by a plain read (a render on the server has no subscription); the board, the api and
// the fork actions are stubs that do nothing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

let source: { onmessage?: (e: { data: string }) => void } | undefined;
(globalThis as any).EventSource = class { onmessage?: (e: { data: string }) => void; constructor() { source = this; } close() {} };

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const nothing = `module.exports = new Proxy({}, { get: (_, k) => (k === "__esModule" ? false : k === "clientId" ? "test" : () => {}) });`;
const stubs: Record<string, string> = {
  "./board.ts": nothing, "./version.ts": nothing, "./api.ts": nothing, "./fork/actions.ts": nothing,
  "./store.ts": `
    export * from ${JSON.stringify(path.join(src, "store.ts"))};
    import { getState } from ${JSON.stringify(path.join(src, "store.ts"))};
    export const useStore = (sel) => sel(getState());`,
};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-servers-")), "servers.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as ui from "./Servers.tsx"; export * as store from "./store.ts"; export * as conn from "./conn.ts";
      export { createElement } from "react"; export { renderToStaticMarkup } from "react-dom/server";`,
    resolveDir: src, loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", loader: { ".css": "empty" },
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => (a.path in stubs && a.resolveDir === src ? { path: a.path, namespace: "stub" } : undefined));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: src }));
    },
  }],
});
const { ui, store, conn, createElement, renderToStaticMarkup } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const html = (component: unknown, props: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(component, props));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { source!.onmessage!({ data: JSON.stringify(m) }); await tick(); }

const EVIL = "<img src=x onerror=1>";
const ESCAPED = "&lt;img src=x onerror=1&gt;";
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected", version: "1.4.0" };
const studio = (o: Record<string, unknown> = {}) =>
  ({ id: "s_3f9a1c2b77de", name: "Studio", address: "https://mac.local:4748", selfSigned: true, pin: "AB:CD:EF:01", state: "connected", version: "1.2.3", agents: ["claude", "pi"], ...o });
const form = (o: Record<string, unknown> = {}) => ({ name: "Studio", address: "https://mac.local:4748", secret: "", selfSigned: true, pin: "", ...o });
const buttons = (h: string): string[] => [...h.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]*>/g, ""));

beforeEach(() => { store.setState({ servers: [LOCAL], serversNotice: "", serversDialog: null, confirm: null }); });

test("the exports of the contract", () => {
  for (const k of ["openServers", "ServersButton", "ServersDialog", "ServerRow", "ServerForm"]) assert.equal(typeof ui[k], "function", k);
});

test("the store starts with the local entry, no notice and the dialog closed", () => {
  // (as the bundle loaded it; beforeEach has put the same back)
  assert.deepEqual(store.getState().servers.map((v: { id: string }) => v.id), ["local"]);
  assert.equal(store.getState().serversNotice, "");
  assert.equal(store.getState().serversDialog, null);
  assert.equal(html(ui.ServersDialog), "");
});

test("openServers opens the dialog, with a form when one is given", () => {
  ui.openServers();
  assert.deepEqual(store.getState().serversDialog, {});
  const f = form({ name: "From a chat" });
  ui.openServers(f);
  assert.deepEqual(store.getState().serversDialog, { form: f });
  const h = html(ui.ServersDialog);
  assert.match(h, /Add server/);
  assert.match(h, /value="From a chat"/);
});

test("the button has a dot only while an entry is not connected", () => {
  assert.doesNotMatch(html(ui.ServersButton), /servers-dot/);
  assert.match(html(ui.ServersButton), /<button class="servers-btn" title="Servers" aria-label="Servers">/);
  store.setState({ servers: [LOCAL, studio()] });
  assert.doesNotMatch(html(ui.ServersButton), /servers-dot/);
  store.setState({ servers: [LOCAL, studio({ state: "unreachable" })] });
  assert.match(html(ui.ServersButton), /servers-dot/);
  assert.match(html(ui.ServersButton), /<button class="servers-btn" title="Servers: one is not connected" aria-label="Servers">/);
});

test("the dialog lists the rows with state, version, fingerprint and agents, on its own backdrop", () => {
  store.setState({ servers: [LOCAL, studio()], serversNotice: "server list: /r/servers.json cannot be read", serversDialog: {} });
  const h = html(ui.ServersDialog);
  assert.match(h, /^<div class="servers-backdrop">/);
  assert.doesNotMatch(h, /dialog-backdrop/);
  assert.match(h, /role="dialog" aria-modal="true" aria-label="Servers"/);
  assert.match(h, /server list: \/r\/servers\.json cannot be read/);
  for (const t of ["This computer", "Studio", "https://mac.local:4748", "Connected", "Version 1.2.3", "Version 1.4.0", "AB:CD:EF:01", "Agents: claude, pi"]) assert.ok(h.includes(t), t);
  assert.ok(buttons(h).includes("Add server"));
  assert.ok(buttons(h).includes("Close"));
});

test("the local row has no Edit and no Remove; a remote row has both and the test", () => {
  assert.deepEqual(buttons(html(ui.ServerRow, { v: LOCAL })), []);
  assert.deepEqual(buttons(html(ui.ServerRow, { v: studio() })), ["Test connection", "Edit", "Remove"]);
  assert.deepEqual(buttons(html(ui.ServerRow, { v: studio({ state: "too_old" }) })), ["Test connection", "Edit", "Remove"]);
  store.setState({ servers: [LOCAL], serversDialog: {} });
  assert.deepEqual(buttons(html(ui.ServersDialog)), ["Close", "Add server"]);
});

test("each state's row shows its label", () => {
  const labels: Record<string, string> = { connecting: "Connecting…", unreachable: "Unreachable", secret_not_accepted: "Secret not accepted",
    name_not_known: "Name not known there", not_aiwb: "Not an AI Whiteboard server", too_old: "Too old: update the server on that machine", another_server: "Another server" };
  for (const [state, label] of Object.entries(labels)) assert.ok(html(ui.ServerRow, { v: studio({ state }) }).includes(label), state);
});

test("a changed certificate shows both fingerprints and offers to accept; one not accepted yet is read first", () => {
  const h = html(ui.ServerRow, { v: studio({ state: "certificate_changed", pin: "11:22:33", fingerprint: "AA:BB:CC" }) });
  assert.match(h, /Certificate changed/);
  assert.match(h, /Accepted before <span class="servers-fp">11:22:33<\/span>/);
  assert.match(h, /Presented now <span class="servers-fp">AA:BB:CC<\/span>/);
  assert.deepEqual(buttons(h), ["Accept fingerprint", "Test connection", "Edit", "Remove"]);
  const none = html(ui.ServerRow, { v: studio({ state: "fingerprint_not_accepted", pin: undefined }) });
  assert.deepEqual(buttons(none), ["Show fingerprint", "Test connection", "Edit", "Remove"]);
  // After "Show fingerprint": the fingerprint the test read, with the accept.
  const read = html(ui.ServerRow, { v: studio({ state: "fingerprint_not_accepted", pin: undefined }),
    result: { ok: false, step: 3, outcome: "fingerprint", message: "Compare this fingerprint", fingerprint: "AA:BB:CC" } });
  assert.match(read, /Fingerprint <span class="servers-fp">AA:BB:CC<\/span>/);
  assert.deepEqual(buttons(read), ["Accept fingerprint", "Test connection", "Edit", "Remove"]);
});

test("what another server said comes out as text: a row's version, detail, agents, name and fingerprints", () => {
  const h = html(ui.ServerRow, { v: studio({ state: "certificate_changed", name: EVIL, version: EVIL, detail: EVIL, agents: [EVIL], pin: EVIL, fingerprint: EVIL }) });
  assert.equal(h.includes("<img"), false);
  assert.equal(h.split(ESCAPED).length - 1, 6);
  assert.ok(h.includes(`Version ${ESCAPED}`));
  assert.ok(h.includes(`<div class="servers-line">${ESCAPED}</div>`)); // the detail
  store.setState({ servers: [LOCAL, studio({ version: EVIL, detail: EVIL })], serversNotice: EVIL, serversDialog: {} });
  const all = html(ui.ServersDialog);
  assert.equal(all.includes("<img"), false);
  assert.equal(all.split(ESCAPED).length - 1, 3);
});

test("what another server said comes out as text: a test's message, detail, version, agents and fingerprints", () => {
  const r = { ok: false, step: 3, outcome: "cert_changed", message: EVIL, detail: EVIL, version: EVIL, agents: [EVIL], fingerprint: EVIL, pinned: EVIL };
  for (const h of [html(ui.ServerRow, { v: studio(), result: r }), html(ui.ServerForm, { initial: form(), onClose() {}, result: r })]) {
    assert.equal(h.includes("<img"), false);
    assert.ok(h.split(ESCAPED).length - 1 >= 6, h);
    assert.ok(h.includes(`<div class="servers-result-msg">${ESCAPED}</div>`));
  }
});

test("the add form: the fields, the secret as a password without autocomplete, and Save only after a test", () => {
  const h = html(ui.ServerForm, { initial: { name: "Studio", address: "https://mac.local:4748", secret: "s3cret", selfSigned: false, pin: "" }, onClose() {} });
  assert.match(h, /Add server/);
  for (const t of ["Name", "Address", "Secret", "Self-signed certificate"]) assert.ok(h.includes(t), t);
  assert.match(h, /<input type="password"[^>]*autoComplete="off"/i);
  assert.equal((h.match(/type="password"/g) ?? []).length, 1);
  assert.deepEqual(buttons(h), ["Cancel", "Test connection", "Save anyway", "Save"]);
  assert.match(h, /<button type="button" class="btn sm primary" disabled="">Save<\/button>/);
  // An empty form offers neither a test nor a save.
  const empty = html(ui.ServerForm, { initial: { name: "", address: "", secret: "", selfSigned: false, pin: "" }, onClose() {} });
  assert.deepEqual(buttons(empty), ["Cancel", "Test connection", "Save"]);
  assert.match(empty, /disabled="">Test connection/);
});

test("the edit form: the secret is empty with the placeholder `unchanged`", () => {
  const h = html(ui.ServerForm, { initial: form({ id: "s_3f9a1c2b77de", pin: "AB:CD:EF:01" }), onClose() {} });
  assert.match(h, /Edit server/);
  assert.match(h, /<input type="password"[^>]*placeholder="unchanged"[^>]*value=""|<input type="password"[^>]*value=""[^>]*placeholder="unchanged"/);
  assert.match(h, /Accepted fingerprint <span class="servers-fp">AB:CD:EF:01<\/span>/);
});

test("the form after a test: Save after an OK one; Accept fingerprint for a certificate to compare; no Save anyway for a duplicate", () => {
  const initial = form({ secret: "s3cret" });
  const ok = html(ui.ServerForm, { initial, onClose() {}, result: { ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.2.3", agents: ["claude", "pi"] } });
  assert.deepEqual(buttons(ok), ["Cancel", "Test connection", "Save"]);
  assert.match(ok, /<button type="button" class="btn sm primary">Save<\/button>/);
  for (const t of ["Connected", "Version 1.2.3", "Agents: claude, pi"]) assert.ok(ok.includes(t), t);
  const fp = html(ui.ServerForm, { initial, onClose() {}, result: { ok: false, step: 3, outcome: "fingerprint", message: "Compare this fingerprint", fingerprint: "AA:BB:CC" } });
  assert.deepEqual(buttons(fp), ["Cancel", "Test connection", "Accept fingerprint", "Save anyway", "Save"]);
  assert.match(fp, /Fingerprint <span class="servers-fp">AA:BB:CC<\/span>/);
  const changed = html(ui.ServerForm, { initial: { ...initial, pin: "11:22:33" }, onClose() {},
    result: { ok: false, step: 3, outcome: "cert_changed", message: "Certificate changed", fingerprint: "AA:BB:CC", pinned: "11:22:33" } });
  assert.match(changed, /Accepted before <span class="servers-fp">11:22:33<\/span>/);
  assert.match(changed, /Presented now <span class="servers-fp">AA:BB:CC<\/span>/);
  const dup = html(ui.ServerForm, { initial, onClose() {}, result: { ok: false, step: 4, outcome: "duplicate", message: "Already added as Studio" } });
  assert.deepEqual(buttons(dup), ["Cancel", "Test connection", "Save"]);
  assert.match(dup, /Already added as Studio/);
});

test("events: `servers` replaces the list and the notice, `server_state` one entry; a snapshot without the field gives the local entry", async () => {
  conn.connect();
  await ev({ type: "servers", servers: [LOCAL, studio()], notice: "set aside" });
  assert.deepEqual(store.getState().servers, [LOCAL, studio()]);
  assert.equal(store.getState().serversNotice, "set aside");
  await ev({ type: "server_state", server: studio({ state: "unreachable", detail: "No answer" }) });
  assert.deepEqual(store.getState().servers, [LOCAL, studio({ state: "unreachable", detail: "No answer" })]);
  await ev({ type: "server_state", server: studio({ id: "s_2", name: "Two" }) });
  assert.deepEqual(store.getState().servers.map((v: { id: string }) => v.id), ["local", "s_3f9a1c2b77de", "s_2"]);
  await ev({ type: "servers" });
  assert.deepEqual(store.getState().servers, [{ id: "local", local: true, name: "This computer", state: "connected" }]);
  assert.equal(store.getState().serversNotice, "");
  const snapshot = { groups: [], boards: [], chats: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "", dataDir: "" };
  store.applySnapshot({ ...snapshot, servers: [LOCAL, studio()] });
  assert.deepEqual(store.getState().servers, [LOCAL, studio()]);
  store.applySnapshot(snapshot);
  assert.deepEqual(store.getState().servers, [{ id: "local", local: true, name: "This computer", state: "connected" }]);
});

const count = (h: string, t: string): number => h.split(t).length - 1;

test("a row after its test shows each fact once: the version, the detail, the agents and the fingerprints", () => {
  const old = studio({ state: "too_old", version: "dev", detail: "Update the server there" });
  const h = html(ui.ServerRow, { v: old, result: { ok: false, step: 4, outcome: "too_old", message: "Server too old", version: "dev", detail: "Update the server there", agents: ["claude", "pi"] } });
  for (const t of ["Version dev", "Update the server there", "Agents: claude, pi", "Server too old", "AB:CD:EF:01"]) assert.equal(count(h, t), 1, t);
  // A version the test read that the entry does not have is shown.
  const other = html(ui.ServerRow, { v: old, result: { ok: false, step: 4, outcome: "too_old", message: "Server too old", version: "0.9" } });
  assert.equal(count(other, "Version dev"), 1);
  assert.equal(count(other, "Version 0.9"), 1);
  const changed = studio({ state: "certificate_changed", pin: "11:22:33", fingerprint: "AA:BB:CC" });
  const c = html(ui.ServerRow, { v: changed, result: { ok: false, step: 3, outcome: "cert_changed", message: "The certificate changed", fingerprint: "AA:BB:CC", pinned: "11:22:33" } });
  for (const t of ["Accepted before", "Presented now", "11:22:33", "AA:BB:CC"]) assert.equal(count(c, t), 1, t);
  assert.deepEqual(buttons(c), ["Accept fingerprint", "Test connection", "Edit", "Remove"]);
  // Without a test the row's own lines are there, once.
  const plain = html(ui.ServerRow, { v: changed });
  for (const t of ["Accepted before", "Presented now", "11:22:33", "AA:BB:CC"]) assert.equal(count(plain, t), 1, t);
});

test("a failed test shows its step, in the row and in the form; one that passed shows none", () => {
  const failed = { ok: false, step: 3, outcome: "cert_not_accepted", message: "The certificate is not accepted" };
  const row = html(ui.ServerRow, { v: studio(), result: failed });
  const inForm = html(ui.ServerForm, { initial: form({ secret: "s3cret" }), onClose() {}, result: failed });
  for (const h of [row, inForm]) assert.equal(count(h, "Step 3 of 5: the certificate"), 1, h);
  const names = ["the address", "the connection", "the certificate", "the secret", "the first events"];
  names.forEach((name, i) => {
    const r = { ok: false, step: i + 1, outcome: "x", message: "No" };
    assert.ok(html(ui.ServerRow, { v: studio(), result: r }).includes(`Step ${i + 1} of 5: ${name}`), name);
    assert.ok(html(ui.ServerForm, { initial: form({ secret: "s3cret" }), onClose() {}, result: r }).includes(`Step ${i + 1} of 5: ${name}`), name);
  });
  const passed = { ok: true, step: 5, outcome: "connected", message: "Connected" };
  assert.doesNotMatch(html(ui.ServerRow, { v: studio(), result: passed }), /Step \d of 5/);
  assert.doesNotMatch(html(ui.ServerForm, { initial: form({ secret: "s3cret" }), onClose() {}, result: passed }), /Step \d of 5/);
  // A step that is none of the five gives no line.
  assert.doesNotMatch(html(ui.ServerRow, { v: studio(), result: { ...failed, step: 9 } }), /Step \d/);
});

// Every piece of text of a rendered row: what stands between two tags.
const pieces = (h: string): string[] => h.replace(/&#x27;/g, "'").split(/<[^>]*>/).map((t) => t.trim()).filter(Boolean);
const NOTHING = "Nothing listens there: is remote access set up on that machine?";

test("a row after its test repeats nothing the row says: the block leads with whether the test passed", () => {
  const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
    [studio(), { ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.2.3", agents: ["claude", "pi"] }, "Test passed"],
    [studio({ state: "unreachable", detail: NOTHING, version: undefined, agents: undefined }),
      { ok: false, step: 2, outcome: "unreachable", message: NOTHING, detail: "dial tcp4 127.0.0.1:47899: connect: connection refused" }, "Test failed"],
    [studio({ state: "secret_not_accepted", version: undefined, agents: undefined }), { ok: false, step: 4, outcome: "secret", message: "Secret not accepted" }, "Test failed"],
  ];
  for (const [v, result, heading] of cases) {
    const h = html(ui.ServerRow, { v, result });
    const all = pieces(h);
    assert.deepEqual(all.filter((t, i) => all.indexOf(t) !== i), [], h);
    assert.match(h, new RegExp(`<div class="servers-result-msg">${heading}</div>`), h);
  }
  const failed = html(ui.ServerRow, { v: cases[1][0], result: cases[1][1] });
  assert.match(failed, /Test failed<\/div><div class="servers-line servers-step">Step 2 of 5: the connection<\/div><div class="servers-line">dial tcp4 127\.0\.0\.1:47899: connect: connection refused<\/div>/);
  // A message the row does not show stays the heading: the test found another thing than the row's state says.
  const other = html(ui.ServerRow, { v: studio({ state: "unreachable", detail: NOTHING }), result: { ok: true, step: 5, outcome: "connected", message: "Connected" } });
  assert.match(other, /<div class="servers-result-msg">Connected<\/div>/);
  assert.doesNotMatch(other, /Test passed/);
});

test("the edit form as saved has Save disabled; the form is judged against the saved entry, and a rename's Save sends force", () => {
  const saved = form({ id: "s_3f9a1c2b77de", pin: "AB:CD:EF:01" });
  const disabled = (h: string, label: string) => new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`).test(h);
  const asSaved = html(ui.ServerForm, { initial: saved, onClose() {} });
  assert.deepEqual(buttons(asSaved), ["Cancel", "Test connection", "Save anyway", "Save"]);
  assert.ok(disabled(asSaved, "Save"));
  // No DOM here, so no typing: the rename's case is formView's (servers.test.ts), and the wiring is read from the source.
  const code = fs.readFileSync(path.join(src, "Servers.tsx"), "utf8");
  assert.match(code, /formView\(f, tested, r, initial\)/);
  assert.equal(count(code, "save(!!view.force)"), 2);
  assert.doesNotMatch(code, /save\(false\)/);
});

// The answer of an add, an edit or an accept carries the entry as it was when the request was served;
// the stream's events of the same change, and of what the connection did since, may be here first.
const bare = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(studio({ version: undefined, agents: undefined, ...o }))); // as the stream sends it: no key without a value
const stateOf = (id: string): string | undefined => store.getState().servers.find((v: { id: string }) => v.id === id)?.state;
const B = "s_b";
const asked = () => bare({ id: B, name: "Scratch B", state: "connecting" });
const tooOld = () => bare({ id: B, name: "Scratch B", state: "too_old", version: "dev" });

test("add: the events before the answer, and the answer before the events, both end with the stream's state", async () => {
  conn.connect();
  // `servers` and `server_state`, then the answer (the failed browser scenario: "Save anyway" on loopback).
  await ev({ type: "servers", servers: [LOCAL, asked()] });
  await ev({ type: "server_state", server: tooOld() });
  ui.answered(asked());
  assert.equal(stateOf(B), "too_old");
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld()]);
  assert.ok(html(ui.ServerRow, { v: store.getState().servers[1] }).includes("Too old"));
  // The answer, then the events: the entry is there at once, and the stream's state after.
  store.setState({ servers: [LOCAL] });
  ui.answered(asked());
  assert.deepEqual(store.getState().servers, [LOCAL, asked()]);
  await ev({ type: "servers", servers: [LOCAL, asked()] });
  await ev({ type: "server_state", server: tooOld() });
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld()]);
  // The answer between the two events.
  store.setState({ servers: [LOCAL] });
  await ev({ type: "servers", servers: [LOCAL, asked()] });
  ui.answered(asked());
  await ev({ type: "server_state", server: tooOld() });
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld()]);
  // A `server_state` for an entry the store does not know adds it (conn.ts); the answer leaves it, and the
  // `servers` event after it, which the local server made later than that state, has the same.
  store.setState({ servers: [LOCAL] });
  await ev({ type: "server_state", server: tooOld() });
  ui.answered(asked());
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld()]);
  await ev({ type: "servers", servers: [LOCAL, tooOld()] });
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld()]);
  assert.equal(store.getState().servers.filter((v: { id: string }) => v.id === B).length, 1);
});

test("edit: the answer never replaces what the stream delivered, in either order", async () => {
  conn.connect();
  const before = studio({ id: B, name: "Scratch B" });
  const edited = bare({ id: B, name: "Scratch B2", address: "https://other.local:4748", state: "connecting" });
  const refused = { ...edited, state: "secret_not_accepted", detail: "The secret was not accepted" };
  // Events, then the answer.
  store.setState({ servers: [LOCAL, before] });
  await ev({ type: "servers", servers: [LOCAL, edited] });
  await ev({ type: "server_state", server: refused });
  ui.answered(edited);
  assert.deepEqual(store.getState().servers, [LOCAL, refused]);
  // The answer, then the events: the stream's `servers` brings the new name and address.
  store.setState({ servers: [LOCAL, before] });
  ui.answered(edited);
  assert.deepEqual(store.getState().servers, [LOCAL, before]);
  await ev({ type: "servers", servers: [LOCAL, edited] });
  assert.equal(store.getState().servers[1].name, "Scratch B2");
  await ev({ type: "server_state", server: refused });
  assert.deepEqual(store.getState().servers, [LOCAL, refused]);
});

test("accept: the answer never replaces what the stream delivered, in either order", async () => {
  conn.connect();
  const changed = studio({ id: B, state: "certificate_changed", pin: "11:22:33", fingerprint: "AA:BB:CC" });
  const accepted = bare({ id: B, state: "connecting", pin: "AA:BB:CC" });
  const connected = studio({ id: B, state: "connected", pin: "AA:BB:CC" });
  // Events, then the answer.
  store.setState({ servers: [LOCAL, changed] });
  await ev({ type: "servers", servers: [LOCAL, accepted] });
  await ev({ type: "server_state", server: connected });
  ui.answered(accepted);
  assert.deepEqual(store.getState().servers, [LOCAL, connected]);
  // The answer, then the events.
  store.setState({ servers: [LOCAL, changed] });
  ui.answered(accepted);
  assert.deepEqual(store.getState().servers, [LOCAL, changed]);
  await ev({ type: "servers", servers: [LOCAL, accepted] });
  await ev({ type: "server_state", server: connected });
  assert.deepEqual(store.getState().servers, [LOCAL, connected]);
  // An answer without an entry changes nothing.
  ui.answered(undefined);
  ui.answered(null);
  assert.deepEqual(store.getState().servers, [LOCAL, connected]);
});

test("the list read when the dialog opens gives the notice and the entries the store lacks, and replaces none", async () => {
  conn.connect();
  await ev({ type: "servers", servers: [LOCAL, tooOld()] });
  ui.listed({ servers: [LOCAL, asked(), studio()], notice: "set aside" });
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld(), studio()]);
  assert.equal(store.getState().serversNotice, "set aside");
  ui.listed(undefined);
  assert.deepEqual(store.getState().servers, [LOCAL, tooOld(), studio()]);
  assert.equal(store.getState().serversNotice, "");
});

test("save and accept put their answer into the store through `answered` alone", () => {
  const text = fs.readFileSync(path.join(src, "Servers.tsx"), "utf8");
  assert.equal(text.includes("upsertServer"), false);
  assert.equal((text.match(/answered\(a\?\.server\)/g) ?? []).length, 2);
});

test("Servers.tsx renders no HTML of its own making and no markdown", () => {
  const text = fs.readFileSync(path.join(src, "Servers.tsx"), "utf8");
  assert.equal(text.includes("dangerouslySetInnerHTML"), false);
  assert.equal(/markdown/i.test(text), false);
  assert.equal(text.includes("innerHTML"), false);
});
