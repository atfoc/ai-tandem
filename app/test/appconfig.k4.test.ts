// The config of the images in the composer (K4, AD-26): the image picker plugin says why the photo library is opened, and leaves the camera to the
// camera plugin. Its microphone text is voice's (appconfig.voice.test.ts): `microphonePermission: false`, as K4 had it, blocks RECORD_AUDIO in the
// Android manifest and deletes the Info.plist text, which voice needs. The ATS dict of N1 and the texts of S12 are held by appconfig.test.ts and
// appconfig.s12.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";

import config from "../app.config.ts";

const options = (name: string) => {
  const entry = (config.plugins ?? []).find((p) => (Array.isArray(p) ? p[0] : p) === name);
  assert.ok(Array.isArray(entry), `${name} has an entry with options`);
  return (entry as unknown[])[1] as Record<string, unknown>;
};

test("app config: the image picker plugin has a photo library usage text, and voice's microphone text", () => {
  const o = options("expo-image-picker");
  assert.equal(typeof o.photosPermission, "string");
  assert.match(o.photosPermission as string, /pictures you choose/);
  assert.equal(o.microphonePermission, config.ios?.infoPlist?.NSMicrophoneUsageDescription);
});

test("app config: the image picker does not block the camera (the scan of a server's code needs it) and says what the camera plugin says", () => {
  const picker = options("expo-image-picker"), camera = options("expo-camera");
  assert.notEqual(picker.cameraPermission, false);
  assert.equal(picker.cameraPermission, camera.cameraPermission);
});

test("app config: K4's plugin leaves the ATS dict and S12's Info.plist keys as they were", () => {
  assert.deepEqual(config.ios?.infoPlist?.NSAppTransportSecurity, { NSAllowsArbitraryLoads: true });
  assert.deepEqual(Object.keys(config.ios?.infoPlist ?? {}).sort(), ["NSAppTransportSecurity", "NSLocalNetworkUsageDescription", "NSMicrophoneUsageDescription"]);
});
