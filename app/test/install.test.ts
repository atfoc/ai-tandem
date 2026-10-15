import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as core from "../scripts/lib/install-core.mjs";

// (the module is plain JavaScript, so its types are what the checker infers: these are the shapes the tests rely on)
const { parseAdbDevices, parseArgs, parseDevicectl, parseSimctl, signingNeeds, validTeamId } = core;
const explainFailure = core.explainFailure as (log: string) => string;
const pickDevice = core.pickDevice as (connected: any[], named: string, others?: any[]) => { device?: any; problem?: string; candidates?: any[] };

// The install script (I1, goal 4.9): its decisions that need no device, and the two stops that need no build.

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scripts/install.mjs");

test("the arguments: a platform is required, a value is needed after --device, unknown arguments are named", () => {
  assert.deepEqual(parseArgs(["--platform", "android", "--device", "emulator-5554"]).errors, []);
  assert.equal(parseArgs(["--platform", "ios", "--release"]).errors.length, 0, "--release is the only kind of build, accepted");
  assert.match(parseArgs([]).errors.join(), /--platform android\|ios is required/);
  assert.match(parseArgs(["--platform", "windows"]).errors.join(), /android or ios/);
  assert.match(parseArgs(["--platform", "ios", "--device"]).errors.join(), /--device needs a value/);
  assert.match(parseArgs(["--platform", "ios", "--frobnicate"]).errors.join(), /unknown argument --frobnicate/);
  assert.equal(parseArgs(["--platform", "ios", "--ipa"]).method, "development", "an .ipa is development-signed unless --method says ad-hoc");
  assert.deepEqual(parseArgs(["--platform", "ios", "--ipa", "--method", "ad-hoc", "--out", "/tmp/x"]).errors, []);
  assert.match(parseArgs(["--platform", "ios", "--ipa", "--method", "store"]).errors.join(), /development or ad-hoc/);
  assert.match(parseArgs(["--platform", "android", "--ipa"]).errors.join(), /--ipa is for --platform ios/);
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(parseArgs(["--help"]).errors, []);
});

test("adb's list: states are kept, the model names the device", () => {
  const out = parseAdbDevices(`List of devices attached
emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:9
R58M123ABC             unauthorized usb:1-1 transport_id:3
0123456789ABCDEF       device usb:1-2 product:beyond1 model:SM_G973F device:beyond1 transport_id:4
* daemon started successfully
`);
  assert.deepEqual(out.map((d: any) => [d.id, d.state, d.name]), [
    ["emulator-5554", "device", "sdk gphone64 arm64"], ["R58M123ABC", "unauthorized", "R58M123ABC"], ["0123456789ABCDEF", "device", "SM G973F"],
  ]);
});

test("devicectl's list: iPhones and iPads that are physical; an unreachable one is not usable; Developer Mode off is noted", () => {
  const json = { result: { devices: [
    { identifier: "AAA", deviceProperties: { name: "Ana's iPhone", osVersionNumber: "26.4", developerModeStatus: "disabled" }, connectionProperties: { tunnelState: "connected" },
      hardwareProperties: { platform: "iOS", reality: "physical", udid: "00008140-0001", marketingName: "iPhone 17", serialNumber: "S1" } },
    { identifier: "BBB", deviceProperties: { name: "Studio iPad" }, connectionProperties: { tunnelState: "unavailable" },
      hardwareProperties: { platform: "iOS", reality: "physical", udid: "00008140-0002", marketingName: "iPad Pro" } },
    { identifier: "CCC", deviceProperties: { name: "Watch" }, connectionProperties: { tunnelState: "connected" }, hardwareProperties: { platform: "watchOS", reality: "physical" } },
  ] } };
  const d = parseDevicectl(json);
  assert.deepEqual(d.map((x: any) => [x.name, x.usable]), [["Ana's iPhone", true], ["Studio iPad", false]]);
  assert.match(d[0].note, /Developer Mode is off/);
  assert.equal(d[0].developerModeOff, true);
  assert.match(d[1].note, /not reachable/);
  assert.equal(d[0].udid, "00008140-0001");
});

test("simctl's list: iOS simulators only", () => {
  const s = parseSimctl({ devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [{ udid: "U1", name: "iPhone 17", state: "Booted", isAvailable: true }, { udid: "U2", name: "Gone", state: "Shutdown", isAvailable: false }],
    "com.apple.CoreSimulator.SimRuntime.watchOS-26-0": [{ udid: "W1", name: "Watch", state: "Shutdown", isAvailable: true }],
  } });
  assert.deepEqual(s.map((x: any) => [x.udid, x.state, x.os]), [["U1", "Booted", "26.3"]]);
});

test("the device: the only one connected, or the one named by id, serial or name; never a guess among several", () => {
  const a = { id: "emulator-5554", name: "Pixel", kind: "android", state: "device" };
  const b = { id: "R58M", name: "Galaxy", kind: "android", state: "device" };
  assert.equal(pickDevice([a], "").device, a);
  assert.match(pickDevice([], "").problem!, /no device is connected/);
  const two = pickDevice([a, b], "");
  assert.match(two.problem!, /2 devices are connected/);
  assert.equal(two.candidates!.length, 2);
  assert.equal(pickDevice([a, b], "R58M").device, b);
  assert.equal(pickDevice([a, b], "galaxy").device, b, "a name, any case");
  assert.match(pickDevice([a, b], "nothing").problem!, /no device "nothing"/);
  const sim = { id: "U1", udid: "U1", name: "iPhone 17", kind: "simulator" };
  assert.match(pickDevice([], "").problem!, /no device is connected/, "a simulator is never chosen by itself");
  assert.equal(pickDevice([], "U1", [sim]).device, sim);
  assert.match(pickDevice([a, { ...a, id: "x" }], "Pixel").problem!, /2 devices are called "Pixel"/);
});

test("a team id is ten capital letters and digits", () => {
  assert.ok(validTeamId("ABCDE12345"));
  for (const bad of ["", "abcde12345", "ABCDE1234", "ABCDE123456", "ABCDE-2345", undefined]) assert.ok(!validTeamId(bad as any), String(bad));
});

test("known failures are explained, and an unknown one is not made up", () => {
  assert.match(explainFailure("error: No Account for Team \"ABCDE12345\"."), /Settings > Accounts/);
  assert.match(explainFailure("Failed to register bundle identifier. The app identifier \"x\" cannot be registered to your development team because it is not available."), /AIWB_IOS_BUNDLE_ID/);
  assert.match(explainFailure("ERROR: Your team has no devices from which to generate a provisioning profile."), /unlock/);
  assert.match(explainFailure("The device has Developer Mode disabled."), /Developer Mode/);
  assert.match(explainFailure("Verify that the profile has not been explicitly trusted by the user"), /Trust/);
  assert.match(explainFailure("adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]"), /adb uninstall/);
  assert.match(explainFailure("Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]"), /Install via USB/);
  assert.equal(explainFailure("BUILD FAILED: some error nobody foresaw"), "");
});

test("what the iOS install needs from the Apple account is told in the stop", () => {
  for (const word of ["Apple Account", "AIWB_IOS_TEAM_ID", "AIWB_IOS_BUNDLE_ID", "Developer Mode", "Trust This Computer", "docs/development.md"]) assert.ok(signingNeeds.includes(word), word);
});

test("--help prints the usage and stops with status 0; a missing platform is status 2", () => {
  const h = spawnSync("node", [script, "--help"], { encoding: "utf8" });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--platform android\|ios/);
  assert.match(h.stdout, /AIWB_IOS_TEAM_ID/);
  const bad = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--platform android\|ios is required/);
});

test("iOS without AIWB_IOS_TEAM_ID stops at the signing step and says what it needs; nothing is built", { skip: process.platform !== "darwin" }, () => {
  const env = { ...process.env }; delete env.AIWB_IOS_TEAM_ID;
  const r = spawnSync("node", [script, "--platform", "ios"], { encoding: "utf8", env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const text = r.stdout + r.stderr;
  if (/STOPPED at step 1\/8 \(tools\)/.test(text)) return; // a Mac without Xcode stops earlier, at the tools, and says which
  assert.match(text, /STOPPED at step 2\/8 \(signing\): AIWB_IOS_TEAM_ID is not set/);
  assert.match(text, /Xcode > Settings > Accounts/);
  assert.doesNotMatch(text, /step 3\/8/);
});
