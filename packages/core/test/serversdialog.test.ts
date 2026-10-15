// The part of web/test/serversdialog.test.ts that needs nothing of the old page's Servers.tsx: what the app's events and the answers of the dialog's calls do to
// the store's server list (answered, listed and openServers are core's, state/serversdialog.ts, which Servers.tsx only re-exports). The rest of that
// file (the dialog, its rows and form as the old page draws them) stays there until the old page is retired (plans/rn-rewrite/parity/webtest.md).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { alias, coreSrc, inSrc, kvFile } from "./fixtures/bundle.ts";
import { fakeStream } from "./fixtures/stream.ts";

const stream = fakeStream();

const stubs: Record<string, string> = {};
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-servers-")), "servers.mjs");
await esbuild.build({
  stdin: {
    contents: `export * as store from "@aiwb/core/state/store.ts"; export * as conn from "@aiwb/core/state/conn.ts"; export * as tr from "@aiwb/core/transport/index.ts"; export * as ports from "@aiwb/core/state/ports.ts"; export { localStorageKv } from "${kvFile}"; export * as ui from "@aiwb/core/state/serversdialog.ts";`,
    resolveDir: coreSrc, loader: "ts",
  },
  bundle: true, alias, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^(\.|@aiwb\/core\/)/ }, (a) => {
        const rel = inSrc(coreSrc, a);
        return rel !== null && ("./" + rel) in stubs ? { path: "./" + rel, namespace: "stub" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path], loader: "js", resolveDir: coreSrc }));
    },
  }],
});
const { ui, store, conn, tr, ports, localStorageKv } = await import(pathToFileURL(out).href);
tr.useTransport(stream.transport);
ports.setKv(localStorageKv);
ports.setUi({ openChat() {}, select() {}, focusComposer() {}, reportError() {}, confirm: (req: unknown) => store.setState({ confirm: req }) });
fs.rmSync(path.dirname(out), { recursive: true, force: true });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ev(m: Record<string, unknown>) { stream.push(m, { servers: store.getState().servers, sections: Object.keys(store.getState().sections) }); await tick(); }
const LOCAL = { id: "local", local: true, name: "This computer", state: "connected", version: "1.4.0" };
const studio = (o: Record<string, unknown> = {}) =>
  ({ id: "s_3f9a1c2b77de", name: "Studio", address: "https://mac.local:4748", selfSigned: true, pin: "AB:CD:EF:01", state: "connected", version: "1.2.3", agents: ["claude", "pi"], ...o });
const form = (o: Record<string, unknown> = {}) => ({ name: "Studio", address: "https://mac.local:4748", secret: "", selfSigned: true, pin: "", ...o });

beforeEach(() => { store.setState({ servers: [LOCAL], serversNotice: "", serversDialog: null, confirm: null, restart: { phase: "idle", why: "" } }); });

test("the store starts with the local entry, no notice and the dialog closed", () => {
  // (as the bundle loaded it; beforeEach has put the same back)
  assert.deepEqual(store.getState().servers.map((v: { id: string }) => v.id), ["local"]);
  assert.equal(store.getState().serversNotice, "");
  assert.equal(store.getState().serversDialog, null);
});

test("openServers opens the dialog, with a form when one is given", () => {
  ui.openServers();
  assert.deepEqual(store.getState().serversDialog, {});
  const f = form({ name: "From a chat" });
  ui.openServers(f);
  assert.deepEqual(store.getState().serversDialog, { form: f });
});

test("the app's events: `servers` replaces the list and the notice, `server_state` one entry; a snapshot of this computer leaves the list as it is", async () => {
  conn.connect();
  await ev({ type: "servers", servers: [LOCAL, studio()], notice: "set aside" });
  assert.deepEqual(store.getState().servers, [LOCAL, studio()]);
  assert.equal(store.getState().serversNotice, "set aside");
  await ev({ type: "server_state", server: studio({ state: "unreachable", detail: "No answer" }) });
  assert.deepEqual(store.getState().servers, [LOCAL, studio({ state: "unreachable", detail: "No answer" })]);
  await ev({ type: "server_state", server: studio({ id: "s_2", name: "Two" }) });
  assert.deepEqual(store.getState().servers.map((v: { id: string }) => v.id), ["local", "s_3f9a1c2b77de", "s_2"]);
  await ev({ type: "servers" });
  assert.deepEqual(store.getState().servers, [{ id: "local", local: true, name: "This computer", state: "connecting" }], "a list without a word is the local entry alone, and nothing has answered");
  assert.equal(store.getState().serversNotice, "");
  await ev({ type: "servers", servers: [LOCAL, studio()], notice: "" });
  const snapshot = { groups: [], boards: [], chats: [], defaults: { groups: {} }, catalogs: {}, home: "", defaultCwd: "" };
  store.applySnapshot(snapshot);
  assert.deepEqual(store.getState().servers, [LOCAL, studio()], "the list is the app's word, not a snapshot's");
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
