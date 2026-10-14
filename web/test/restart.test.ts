// "Restart server", "Retry" and "Open server log" (src/version.ts with the real src/store.ts): the page asks the app to restart the
// server (the owner's thing `owner.restart`) and waits for this computer's entry to be connected again, with its tree; the page is
// not loaded again. The board layer is a stub; the transport is a fake.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { FakeTransport } from "./fixtures/faketransport.ts";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(web, "src");
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-restart-")), "restart.mjs");
await esbuild.build({
  stdin: { contents: `export * as version from "./version.ts"; export * as store from "./store.ts"; export * as tr from "./transport/index.ts";`, resolveDir: src, loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", jsx: "automatic", loader: { ".css": "empty" },
  define: { __APP_VERSION__: JSON.stringify("2.0.0") },
  banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
  plugins: [{
    name: "stubs",
    setup(b) {
      b.onResolve({ filter: /^\.\/board\.ts$/ }, () => ({ path: "board", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ loader: "js", contents: "export const forgetBoard = () => {}; export const boardUnsaved = () => false;" }));
    },
  }],
});
const { version, store, tr } = await import(pathToFileURL(out).href);
fs.rmSync(path.dirname(out), { recursive: true, force: true });

(globalThis as any).window ??= {}; // (the page writes window.aiwbFlush; a restart asks it to write what is pending)
const fake = new FakeTransport();
tr.useTransport(fake);
const S = () => store.getState();
const local = (o: Record<string, unknown> = {}) => ({ id: "local", local: true, name: "This computer", state: "connected", version: "1.0.0", ...o });
const phase = () => S().restart.phase;
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(f(), "it happened"); };

beforeEach(() => {
  fake.reset(); fake.appHandler = () => undefined;
  version.restartWaits.pollMs = 10; version.restartWaits.giveUpMs = 45_000;
  store.setState({ servers: [local()], connected: true, restart: { phase: "idle", why: "" }, chats: {}, states: {}, confirm: null });
});

/** The app, as it restarts the server: this computer's entry is connecting meanwhile, and connected again at the new version. */
const restarts = (ms: number) => async (c: { op: string }) => {
  assert.equal(c.op, "owner.restart");
  store.setState({ servers: [local({ state: "connecting", detail: "Restarting…" })], connected: false });
  setTimeout(() => store.setState({ servers: [local({ version: "2.0.0" })], connected: true }), ms);
  return { status: 200, text: JSON.stringify({ ok: true }) };
};

test("the page's version is the app's build", () => {
  assert.equal(version.pageVersion(), "2.0.0");
});

test("Restart server asks the app (owner.restart) and waits for this computer's entry to be connected again; the page is not loaded again", async () => {
  fake.appHandler = restarts(120);
  version.restartServer();
  await until(() => phase() === "restarting");
  assert.equal(S().restart.why, "");
  await until(() => phase() === "idle");
  assert.deepEqual(fake.apps.map((a) => a.op), ["owner.restart"]);
  assert.equal(fake.calls.length, 0, "no call to a server: the page does not reach the program");
  assert.equal(S().servers[0].version, "2.0.0");
});

test("the restart waits for the page to hold this computer's tree too, not for its entry's state alone", async () => {
  fake.appHandler = async () => {
    store.setState({ servers: [local({ state: "connecting" })], connected: false });
    setTimeout(() => store.setState({ servers: [local()] }), 30);                  // the entry says connected
    setTimeout(() => store.setState({ connected: true }), 150);                    // and the snapshot is in later
    return { status: 200, text: "{}" };
  };
  version.restartServer();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(phase(), "restarting", "the entry says connected, the tree is not here");
  await until(() => phase() === "idle");
});

test("a restart the app refused is a failed one, with the app's reason; Retry restarts again", async () => {
  fake.appHandler = () => ({ status: 500, text: JSON.stringify({ error: "the server stopped while starting\nlast line of the log", code: "restart_failed" }) });
  version.restartServer();
  await until(() => phase() === "failed");
  assert.equal(S().restart.why, "the server stopped while starting\nlast line of the log");
  fake.appHandler = restarts(30);
  version.restartServer();
  await until(() => phase() === "idle");
  assert.equal(S().restart.why, "");
});

test("a server that does not come back in time is a failed restart too", async () => {
  version.restartWaits.giveUpMs = 80;
  fake.appHandler = async () => { store.setState({ servers: [local({ state: "connecting" })], connected: false }); return { status: 200, text: "{}" }; };
  version.restartServer();
  await until(() => phase() === "failed");
  assert.match(S().restart.why, /did not come back/);
});

test("Retry after a start that failed asks the app to start the server (owner.retry), and nothing else", async () => {
  version.startAgain();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fake.apps.map((a) => a.op), ["owner.retry"]);
  assert.equal(phase(), "idle");
});

test("while agents run the restart asks first, and a second press while it runs does nothing", async () => {
  store.setState({ chats: { c_1: { id: "c_1", status: "thinking" } }, states: {} });
  version.restartServer();
  assert.equal(S().confirm.title, "Restart server");
  assert.match(S().confirm.body, /ends 1 running agent chat/);
  assert.equal(fake.apps.length, 0, "nothing before the answer");
  fake.appHandler = restarts(60);
  S().confirm.actions[0].run();
  version.restartServer();
  await until(() => phase() === "idle");
  assert.equal(fake.apps.length, 1);
});

test("Open log is the owner's thing too; the page is in the app when its way is IPC", async () => {
  version.openServerLog();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fake.apps.map((a) => a.op), ["owner.openLog"]);
  fake.way = "http";
  assert.equal(version.inDesktopApp(), false);
  fake.way = "ipc";
  assert.equal(version.inDesktopApp(), true);
});
