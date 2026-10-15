import assert from "node:assert/strict";
import { test } from "node:test";

import config from "../app.config.ts";

// App Transport Security (AD-36): off, with nothing else in its dict. A server reached by a dotted DNS name with a
// pinned self-signed certificate fails under ATS (-1200 / -9802), and NSAllowsLocalNetworking, which Expo's default
// has, makes ATS apply again: a later edit that adds it back must fail here.
test("app config: the iOS ATS dict is exactly {NSAllowsArbitraryLoads: true}", () => {
  assert.deepEqual(config.ios?.infoPlist?.NSAppTransportSecurity, { NSAllowsArbitraryLoads: true });
});

test("app config: the secure store plugin keeps its data out of Android's auto backup, and asks for no Face ID", () => {
  const entry = (config.plugins ?? []).find((p) => (Array.isArray(p) ? p[0] : p) === "expo-secure-store");
  assert.ok(Array.isArray(entry), "expo-secure-store has an entry with options");
  const options = (entry as unknown[])[1] as Record<string, unknown>;
  assert.equal(options.configureAndroidBackup, true);
  assert.equal(options.faceIDPermission, false);
});

test("app config: Android keeps cleartext traffic off (no usesCleartextTraffic, no network security config)", () => {
  const text = JSON.stringify(config.android);
  assert.doesNotMatch(text, /usesCleartextTraffic|networkSecurityConfig/);
});
