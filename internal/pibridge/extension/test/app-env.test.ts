// Unit tests for app-env.ts: the app's AIWB_* handles are taken out of the
// environment (so pi's shell commands do not inherit them), kept for the
// extension, and found again by a second evaluation in the same process.
// Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/app-env.test.ts
//
// No pi, no real app, no npm packages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { APP_ENV_NAMES, takeAppEnv } from "../app-env.ts";

const APP_VALUES: Record<string, string> = {
  AIWB_BRIDGE_SOCKET: "/tmp/aiwbdata/pi-bridge.sock",
  AIWB_BRIDGE_RUN: "run-1",
  AIWB_MCP_CONFIG: '{"mcpServers":{"board":{"type":"http","url":"http://127.0.0.1:1/mcp","headers":{"Authorization":"Bearer TOKEN"}}}}',
  AIWB_MCP_CONFIG_FILE: "/tmp/aiwbdata/chats/c1/mcp.json",
  AIWB_CHAT_DIR: "/tmp/aiwbdata/chats/c1",
  AIWB_APPEND_PROMPT: "/tmp/aiwbdata/chats/c1/pi/append-prompt.md",
};

/** bridgePresent is index.ts's rule for wiring the permission gate. */
function bridgePresent(app: { AIWB_BRIDGE_SOCKET?: string; AIWB_BRIDGE_RUN?: string }): boolean {
  return (app.AIWB_BRIDGE_SOCKET ?? "") !== "" && (app.AIWB_BRIDGE_RUN ?? "") !== "";
}

test("the six app handles are the names taken", () => {
  assert.deepEqual([...APP_ENV_NAMES].sort(), Object.keys(APP_VALUES).sort());
});

test("values are kept after the delete, and the other variables stay", () => {
  const env: Record<string, string | undefined> = {
    ...APP_VALUES,
    AIWB_CHAT_ID: "c1",
    AIWB_SUB_PARENT: "call-1",
    PATH: "/usr/bin",
  };
  const store: Record<symbol, unknown> = {};
  const app = takeAppEnv(env, store);

  assert.deepEqual({ ...app }, APP_VALUES);
  for (const name of APP_ENV_NAMES) assert.equal(name in env, false, `${name} is still in the environment`);
  assert.deepEqual(env, { AIWB_CHAT_ID: "c1", AIWB_SUB_PARENT: "call-1", PATH: "/usr/bin" });
  assert.equal(bridgePresent(app), true);
});

test("a second evaluation finds the values when the variables are gone", () => {
  const env: Record<string, string | undefined> = { ...APP_VALUES };
  const store: Record<symbol, unknown> = {};
  takeAppEnv(env, store);

  const again = takeAppEnv(env, store);
  assert.deepEqual({ ...again }, APP_VALUES);
  assert.equal(bridgePresent(again), true);
  assert.equal(again.AIWB_MCP_CONFIG, APP_VALUES.AIWB_MCP_CONFIG);
});

test("a freshly evaluated module finds the values through globalThis", async () => {
  // pi imports the extension with its module cache off, so a reload or a
  // fork can evaluate the module again: module-level state would be lost.
  const saved: Record<string, string | undefined> = {};
  for (const name of APP_ENV_NAMES) saved[name] = process.env[name];
  const key = Symbol.for("ai-whiteboard.pi-extension.app-env");
  const savedStore = (globalThis as Record<symbol, unknown>)[key];
  delete (globalThis as Record<symbol, unknown>)[key];
  try {
    Object.assign(process.env, APP_VALUES);
    const first = takeAppEnv();
    assert.deepEqual({ ...first }, APP_VALUES);
    for (const name of APP_ENV_NAMES) assert.equal(process.env[name], undefined);

    const fresh = (await import("../app-env.ts?second-evaluation")) as typeof import("../app-env.ts");
    assert.notEqual(fresh.takeAppEnv, takeAppEnv);
    const second = fresh.takeAppEnv();
    assert.deepEqual({ ...second }, APP_VALUES);
    assert.equal(bridgePresent(second), true);
  } finally {
    for (const name of APP_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (savedStore === undefined) delete (globalThis as Record<symbol, unknown>)[key];
    else (globalThis as Record<symbol, unknown>)[key] = savedStore;
  }
});

test("a child process started after the take does not inherit the handles", () => {
  const saved: Record<string, string | undefined> = {};
  for (const name of APP_ENV_NAMES) saved[name] = process.env[name];
  try {
    Object.assign(process.env, APP_VALUES);
    takeAppEnv(process.env, {});
    const out = execFileSync("/bin/sh", ["-c", "env"], { env: { ...process.env }, encoding: "utf8" });
    for (const name of APP_ENV_NAMES) assert.equal(out.includes(name + "="), false, `${name} reached the child`);
  } finally {
    for (const name of APP_ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("with no variables at all nothing is kept and there is no bridge", () => {
  const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
  const store: Record<symbol, unknown> = {};
  const app = takeAppEnv(env, store);
  assert.deepEqual({ ...app }, {});
  assert.equal(bridgePresent(app), false);
  assert.equal(app.AIWB_MCP_CONFIG, undefined);
  assert.deepEqual(env, { PATH: "/usr/bin" });

  // Still nothing on a second evaluation.
  assert.equal(bridgePresent(takeAppEnv(env, store)), false);
});

test("only one of the two bridge variables is no bridge, as before", () => {
  for (const name of ["AIWB_BRIDGE_SOCKET", "AIWB_BRIDGE_RUN"]) {
    const app = takeAppEnv({ [name]: APP_VALUES[name] }, {});
    assert.equal(bridgePresent(app), false);
  }
});

test("a variable that is set again replaces the kept value", () => {
  const store: Record<symbol, unknown> = {};
  takeAppEnv({ ...APP_VALUES }, store);
  const env: Record<string, string | undefined> = { AIWB_BRIDGE_RUN: "run-2" };
  const app = takeAppEnv(env, store);
  assert.equal(app.AIWB_BRIDGE_RUN, "run-2");
  assert.equal(app.AIWB_BRIDGE_SOCKET, APP_VALUES.AIWB_BRIDGE_SOCKET);
  assert.equal("AIWB_BRIDGE_RUN" in env, false);
});
