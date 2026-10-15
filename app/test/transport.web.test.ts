// The choice of the web build's transport (U3, AD-20): by the way the page was loaded, on fake windows.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { DesktopBridge } from "@aiwb/core/transport/desktop.ts";

import { NO_WAY } from "../src/appname.ts";
import { chooseTransport } from "../src/platform/transport.web.ts";

const bridge = (): DesktopBridge => ({
  way: "ipc",
  call: async () => ({ status: 200, text: "{}", sceneRev: null }),
  stream: () => ({ close() {} }),
  picture: async (s, c, i) => `aiwb-picture://${s}/${c}/${i}`,
  app: async () => ({ ok: true }) as never,
  pickImages: async () => ({ images: [], failed: [] }) as never,
});

test("a window that gave the page its bridge: the desktop transport over that bridge", async () => {
  const t = chooseTransport({ aiwbTransport: bridge(), location: { protocol: "file:" } }, { product: "Gecko" });
  assert.equal(t?.way, "ipc");
  assert.equal(await t!.picture("local", "c1", "abc"), "aiwb-picture://local/c1/abc");
});

test("a page loaded over http (the test host, the mock): the http transport, whose picture addresses are the host's", async () => {
  const t = chooseTransport({ location: { protocol: "http:" } }, { product: "Gecko" });
  assert.equal(t?.way, "http");
  assert.equal(await t!.picture("local", "c1", "abc"), "/host/picture/local/c1/abc");
});

test("the bridge wins over the address: a window of the app that was loaded over http still uses the bridge", () => {
  assert.equal(chooseTransport({ aiwbTransport: bridge(), location: { protocol: "http:" } }, {})?.way, "ipc");
});

test("a file opened without the app: no transport", () => {
  assert.equal(chooseTransport({ location: { protocol: "file:" } }, {}), null);
  assert.equal(chooseTransport(undefined, undefined), null);
});

test("the words of a page with no way", () => {
  assert.equal(NO_WAY, "AI Whiteboard runs in its app.");
});
