// The config of voice's microphone (architecture VC-8): the Info.plist text iOS shows before it asks, RECORD_AUDIO and MODIFY_AUDIO_SETTINGS
// on Android, and no listening in the background. The config is checked as written and as Expo makes it (`expo config --type introspect`,
// the Info.plist and the manifest after every plugin ran): a plugin's `microphonePermission: false` would delete the text and block the
// permission there, which the config as written does not show.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import config from "../app.config.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");

test("app config: iOS says why voice listens, and nothing listens in the background", () => {
  const text = config.ios?.infoPlist?.NSMicrophoneUsageDescription;
  assert.equal(typeof text, "string");
  assert.match(text as string, /listens only while you dictate or talk to a chat/);
  assert.match(text as string, /ElevenLabs with your own key/);
  assert.equal(config.ios?.infoPlist?.UIBackgroundModes, undefined);
});

test("app config: Android asks for the microphone and may set the audio mode", () => {
  assert.deepEqual([...(config.android?.permissions ?? [])].sort(), ["MODIFY_AUDIO_SETTINGS", "RECORD_AUDIO"]);
  assert.equal(config.android?.blockedPermissions, undefined);
});

test("app config: after every plugin, Info.plist has voice's text and the manifest has RECORD_AUDIO, not removed", () => {
  // Expo starts from the generated ios/ and android/ when they are there (a manifest of an older config keeps what it had); the config is
  // copied to a folder of its own beside them, so that the answer is the one of a clean prebuild, whatever was generated here before.
  const dir = mkdtempSync(join(app, ".configtest-"));
  try {
    for (const f of ["app.config.ts", "package.json"]) copyFileSync(join(app, f), join(dir, f));
    const cli = createRequire(join(app, "package.json")).resolve("expo/bin/cli");
    const out = execFileSync(process.execPath, [cli, "config", "--type", "introspect", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, EXPO_NO_TELEMETRY: "1" } });
    const made = JSON.parse(out) as {
      _internal: { modResults: { ios: { infoPlist: Record<string, unknown> }; android: { manifest: { manifest: { "uses-permission": { $: Record<string, string> }[] } } } } };
    };
    const plist = made._internal.modResults.ios.infoPlist;
    assert.equal(plist.NSMicrophoneUsageDescription, config.ios?.infoPlist?.NSMicrophoneUsageDescription);
    assert.equal(plist.UIBackgroundModes, undefined);
    const uses = made._internal.modResults.android.manifest.manifest["uses-permission"].map((p) => p.$);
    for (const name of ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS"]) {
      const entries = uses.filter((p) => p["android:name"] === name);
      assert.equal(entries.length, 1, `${name} is in the manifest once`);
      assert.equal(entries[0]["tools:node"], undefined, `${name} is not removed by a plugin`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
