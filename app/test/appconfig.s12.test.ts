// The config of the add-server flow (S12, goal 4.7): the camera plugin with a usage text and no microphone, the local network usage text, and the
// ATS dict of AD-36 still exactly as N1 left it (test/appconfig.test.ts holds that one; here it is checked beside the new Info.plist keys).
import assert from "node:assert/strict";
import { test } from "node:test";

import config from "../app.config.ts";

const options = (name: string) => {
  const entry = (config.plugins ?? []).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  assert.ok(Array.isArray(entry), `${name} has an entry with options`);
  return (entry as unknown[])[1] as Record<string, unknown>;
};

test("app config: the camera plugin says why the camera is used, and asks for no microphone and no audio", () => {
  const o = options("expo-camera");
  assert.equal(typeof o.cameraPermission, "string");
  assert.match(o.cameraPermission as string, /scan/);
  assert.equal(o.microphonePermission, false);
  assert.equal(o.recordAudioAndroid, false);
});

test("app config: NSLocalNetworkUsageDescription says why the system asks to reach the local network", () => {
  const text = config.ios?.infoPlist?.NSLocalNetworkUsageDescription;
  assert.equal(typeof text, "string");
  assert.match(text as string, /local network/);
});

test("app config: the new Info.plist keys leave the ATS dict as it is (AD-36)", () => {
  assert.deepEqual(config.ios?.infoPlist?.NSAppTransportSecurity, { NSAllowsArbitraryLoads: true });
  const keys = Object.keys(config.ios?.infoPlist ?? {}).sort();
  assert.deepEqual(keys, ["NSAppTransportSecurity", "NSLocalNetworkUsageDescription"]);
});
