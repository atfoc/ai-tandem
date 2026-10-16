// The parts of the device runner of the board bench that do not touch the machine (dev/bench/device.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error: a plain .mjs of the dev tools, without types
import * as dev from "../dev/bench/device.mjs";
// @ts-expect-error: a plain .mjs of the dev tools, without types
import { parseModes } from "../dev/bench/modeset.mjs";

// The shape of `xcrun devicectl list devices --json-output`, trimmed; names, identifiers and serials are made up.
const devicectl = {
  info: { commandType: "devicectl.list.devices", jsonVersion: 3, outcome: "success" },
  result: {
    devices: [
      {
        connectionProperties: { pairingState: "paired", tunnelState: "unavailable" },
        deviceProperties: { developerModeStatus: "enabled", name: "Test iPad", osVersionNumber: "26.5.2" },
        hardwareProperties: { deviceType: "iPad", marketingName: "iPad Air (4th generation)", platform: "iOS", productType: "iPad13,1", reality: "physical", serialNumber: "FAKESERIAL1", udid: "00008110-0000AAAA0000BBBB" },
        identifier: "11111111-2222-3333-4444-555555555501",
      },
      {
        connectionProperties: { pairingState: "paired", tunnelState: "connected" },
        deviceProperties: { developerModeStatus: "enabled", name: "Test Phone", osVersionNumber: "26.4" },
        hardwareProperties: { deviceType: "iPhone", marketingName: "iPhone 15 Pro", platform: "iOS", productType: "iPhone16,1", reality: "physical", serialNumber: "FAKESERIAL2", udid: "00008110-0000CCCC0000DDDD" },
        identifier: "11111111-2222-3333-4444-555555555502",
      },
      {
        connectionProperties: { pairingState: "paired", tunnelState: "connected" },
        deviceProperties: { name: "Test Watch", osVersionNumber: "12" },
        hardwareProperties: { deviceType: "appleWatch", marketingName: "Apple Watch", platform: "watchOS", reality: "physical", udid: "00008110-0000EEEE0000FFFF" },
        identifier: "11111111-2222-3333-4444-555555555503",
      },
    ],
  },
};

const simctl = {
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { udid: "AAAAAAAA-0000-0000-0000-000000000001", name: "xo-bench", state: "Shutdown", isAvailable: true },
      { udid: "AAAAAAAA-0000-0000-0000-000000000002", name: "gone", state: "Shutdown", isAvailable: false },
    ],
    "com.apple.CoreSimulator.SimRuntime.watchOS-12-0": [{ udid: "AAAAAAAA-0000-0000-0000-000000000003", name: "Watch", state: "Shutdown", isAvailable: true }],
  },
};

test("parseArgs: the options, the defaults and what is refused", () => {
  const a = dev.parseArgs(["--device", "Pedja", "--auto", "--port", "5555", "--timeout-min", "1.5", "--label", "dark css", "--out", "x"]);
  assert.deepEqual(a.errors, []);
  assert.equal(a.device, "Pedja");
  assert.equal(a.auto, true);
  assert.equal(a.port, 5555);
  assert.equal(a.timeoutMin, 1.5);
  assert.equal(a.label, "dark css");
  assert.equal(a.simulator, false);
  assert.equal(a.modes, "all", "the default is the biggest set");
  assert.equal(dev.parseArgs(["--device", "x", "--modes", "experiment"]).modes, "experiment");
  assert.equal(dev.parseArgs(["--device", "x", "--modes", "replacement,dark-css"]).errors.length, 0);
  assert.match(dev.parseArgs(["--device", "x", "--modes", "everything"]).errors.join(), /--modes is a set/);
  assert.match(dev.parseArgs(["--device", "x", "--modes", "light,nope"]).errors.join(), /--modes is a set/);
  const d = dev.parseArgs(["--device", "x", "--simulator", "--no-install"]);
  assert.equal(d.timeoutMin, 30);
  assert.equal(d.port, 0);
  assert.equal(d.simulator && d.noInstall, true);
  assert.match(dev.parseArgs([]).errors.join(), /--device/);
  assert.match(dev.parseArgs(["--device", "x", "--port", "4748"]).errors.join(), /4748/);
  assert.match(dev.parseArgs(["--device", "x", "--port", "6006"]).errors.join(), /6006/);
  assert.match(dev.parseArgs(["--device", "x", "--port", "99999"]).errors.join(), /--port/);
  assert.match(dev.parseArgs(["--device", "x", "--timeout-min", "0"]).errors.join(), /--timeout-min/);
  assert.match(dev.parseArgs(["--device"]).errors.join(), /needs a value/);
  assert.match(dev.parseArgs(["--device", "x", "--bogus"]).errors.join(), /unknown argument --bogus/);
  assert.equal(dev.parseArgs(["--help"]).errors.length, 0);
});

test("file names: the label or the device name, the local time", () => {
  const at = new Date(2026, 9, 5, 7, 3);
  assert.equal(dev.outputBase({ label: "", deviceName: "Ana’s iPad" }, at), "bench-ana-s-ipad-20261005-0703");
  assert.equal(dev.outputBase({ label: "Dark CSS / v2", deviceName: "Pedja" }, at), "bench-dark-css-v2-20261005-0703");
  assert.equal(dev.slug("   "), "device");
});

test("findDevice: by name or by any of its ids; reachable or not; no watches", () => {
  const phone = dev.findDevice(devicectl, "test phone");
  assert.equal(phone.device.name, "Test Phone");
  assert.equal(phone.device.usable, true);
  assert.equal(phone.device.model, "iPhone 15 Pro");
  assert.equal(phone.device.os, "26.4");
  assert.equal(dev.findDevice(devicectl, "00008110-0000AAAA0000BBBB").device.name, "Test iPad");
  assert.equal(dev.findDevice(devicectl, "11111111-2222-3333-4444-555555555501").device.usable, false);
  const none = dev.findDevice(devicectl, "Test Watch");
  assert.equal(none.device, undefined);
  assert.match(none.problem, /no device/);
  assert.deepEqual(none.candidates.map((d: any) => d.name), ["Test iPad", "Test Phone"]);
});

test("findSimulator: iOS simulators only, by name or udid", () => {
  assert.equal(dev.findSimulator(simctl, "xo-bench").device.state, "Shutdown");
  assert.equal(dev.findSimulator(simctl, "AAAAAAAA-0000-0000-0000-000000000001").device.name, "xo-bench");
  assert.ok(dev.findSimulator(simctl, "gone").problem);
  assert.ok(dev.findSimulator(simctl, "Watch").problem);
});

test("the address of this Mac: the interface of the default route, then its IPv4", () => {
  const route = `   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en0\n      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>\n`;
  assert.equal(dev.parseDefaultRoute(route), "en0");
  assert.equal(dev.parseDefaultRoute("route: writing to routing socket: not in table\n"), "");
  assert.equal(dev.parseIPv4("192.168.1.23\n"), "192.168.1.23");
  assert.equal(dev.parseIPv4(""), "");
  assert.equal(dev.parseIPv4("999.1.1.1\n"), "");
  assert.equal(dev.parseIPv4("not an address"), "");
});

test("the install command: the name cannot break out of its quotes", () => {
  assert.equal(dev.installCommandLine("Pedja"), 'node app/scripts/install.mjs --platform ios --device "Pedja"');
  assert.equal(dev.installCommandLine('a"; rm -rf ~; "$HOME`x`\\'), 'node app/scripts/install.mjs --platform ios --device "a\\"; rm -rf ~; \\"\\$HOME\\`x\\`\\\\"');
  assert.equal(dev.installCommandShown("Pedja"), `zsh -ic 'node app/scripts/install.mjs --platform ios --device "Pedja"'`);
  assert.equal(dev.installCommandShown("Ana's"), `zsh -ic 'node app/scripts/install.mjs --platform ios --device "Ana'\\''s"'`);
  assert.equal(dev.shQuote("plain-1.2"), "plain-1.2");
  assert.equal(dev.shQuote("two words"), "'two words'");
});

test("the install environment and what the person is told", () => {
  assert.deepEqual(dev.benchEnv({ ip: "192.168.1.23", port: 5555, auto: false }), {
    EXPO_PUBLIC_AIWB_SELFTEST: "1", AIWB_BOARD_BENCH: "1", AIWB_BOARD_BENCH_REPORT: "http://192.168.1.23:5555/report", AIWB_BOARD_BENCH_MODES: "all",
  });
  assert.equal(dev.benchEnv({ ip: "127.0.0.1", port: 1, auto: false, modes: "replacement,dark-css" }).AIWB_BOARD_BENCH_MODES, "replacement,dark-css");
  assert.equal(dev.benchEnv({ ip: "127.0.0.1", port: 1, auto: true }).AIWB_BOARD_BENCH_AUTO, "1");
  assert.equal(dev.benchEnv({ ip: "127.0.0.1", port: 1, auto: false }).TMPDIR, undefined);
  assert.equal(dev.benchEnv({ ip: "127.0.0.1", port: 1, auto: false, tmpdir: "/tmp/aiwb-bench-metro-x" }).TMPDIR, "/tmp/aiwb-bench-metro-x");
  assert.match(dev.phoneInstructions({ auto: false, minutes: 10 }), /Tap 'Run bench'/);
  assert.match(dev.phoneInstructions({ auto: true, minutes: 10 }), /by itself 10 s/);
  const msg = dev.unreachableMessage({ name: "Pedja", command: "node x --device Pedja" });
  assert.match(msg, /Connect Pedja to this Mac by cable \(or the same Wi-Fi with 'Connect via network' paired\), unlock it, keep the screen on, answer Trust This Computer;/);
  assert.match(msg, /shows `available`/);
  assert.match(msg, /then run again: node x --device Pedja$/);
});

test("the bundle check: SelfTestRoot in the bytes, the bundle found on disk", () => {
  const withMark = Buffer.concat([Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0, 0xff]), Buffer.from("App\0SelfTestRoot\0Home\0"), Buffer.alloc(64)]);
  assert.equal(dev.SELFTEST_MARK, "SelfTestRoot");
  assert.equal(dev.bundleHasSelfTest(withMark), true);
  assert.equal(dev.bundleHasSelfTest(Buffer.from("App\0SelfTest\0Root\0Home\0")), false);
  assert.equal(dev.bundleHasSelfTest(Buffer.alloc(0)), false);
  assert.match(dev.staleBundleMessage("x/main.jsbundle"), /^x\/main\.jsbundle was built without EXPO_PUBLIC_AIWB_SELFTEST \(Metro reused/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-bundle-test-"));
  try {
    assert.equal(dev.findBundle({ simulator: true, root }), "");
    const sim = path.join(root, "app/ios/build/Build/Products/Release-iphonesimulator/AIWhiteboard.app");
    fs.mkdirSync(sim, { recursive: true });
    assert.equal(dev.findBundle({ simulator: true, root }), "", "an .app without a bundle");
    fs.writeFileSync(path.join(sim, "main.jsbundle"), withMark);
    assert.equal(dev.findBundle({ simulator: true, root }), path.join(sim, "main.jsbundle"));
    assert.equal(dev.findBundle({ simulator: false, root }), "", "the device products folder is another one");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the install's output: logs folder found, a team id hidden", () => {
  assert.equal(dev.installLogDir("[   0s] install AI Whiteboard on ios (Pedja); logs in /var/folders/ab/T/aiwb-install-Xy12Zq"), "/var/folders/ab/T/aiwb-install-Xy12Zq");
  assert.equal(dev.installLogDir("nothing"), "");
  assert.equal(dev.redact("xcodebuild DEVELOPMENT_TEAM=ABCDE12345 CODE_SIGN_STYLE=Automatic"), "xcodebuild DEVELOPMENT_TEAM=********** CODE_SIGN_STYLE=Automatic");
});

test("the summary file: formatSummary with where it ran, then the command", () => {
  const run = { board: "large", mode: "light", gesture: "pan", rep: 1, fps: 60, p95Ms: 17, jankyPct: 0, moved: true };
  const result = { env: { userAgent: "WebKit", width: 393, height: 852, dpr: 3, isolated: true }, idleMs: 16.7, config: { reps: 1, gestureMs: 4000 }, runs: [run],
    summary: [{ board: "large", mode: "light", gesture: "pan", reps: 1, fps: { mean: 60, min: 60, max: 60 }, p95Ms: { mean: 17, min: 17, max: 17 }, jankyPct: { mean: 0, min: 0, max: 0 } }] };
  const md = dev.markdownReport({ result, device: { name: "Pedja", model: "iPhone 15 Pro", kind: "ios" }, os: "26.4", label: "baseline", command: "node x --device Pedja" });
  assert.match(md, /^### Pedja \(iPhone 15 Pro\), iOS 26\.4, Release build: baseline\n/);
  assert.match(md, /\| light \| pan \| 60 \(60–60\) \|/);
  assert.match(md, /```sh\nnode x --device Pedja\n```/);
});

test("the expected duration: the default set fits in about 20 minutes on a phone", () => {
  const all = dev.estimateRunMs({ modes: parseModes("all"), simulator: false });
  assert.ok(all <= 20 * 60_000, `the default set takes ${Math.round(all / 60_000)} min on a phone`);
  assert.ok(all >= 15 * 60_000, "(and it is not an estimate that forgets the loads)");
  assert.ok(dev.estimateRunMs({ modes: parseModes("experiment"), simulator: false }) < all);
  assert.ok(dev.estimateRunMs({ modes: parseModes("all"), simulator: true }) < all, "a simulator loads faster than a phone");
});
