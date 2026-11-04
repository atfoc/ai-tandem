// The UIScene life cycle (app/plugins/scene-life-cycle.js): an app built with the iOS 27 SDK stops at launch without it. The AppDelegate
// edit is checked on the template of the installed Expo (expo/template.tgz, the file `expo prebuild` starts from), so an Expo whose template
// changed fails here and not in a crash on a device; the Info.plist is checked as Expo makes it after every plugin (`expo config --type
// introspect`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import config from "../app.config.ts";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(app, "package.json"));
const plugin = require("./plugins/scene-life-cycle.js") as {
  editAppDelegate(src: string): string;
  sceneManifest: unknown;
};

function templateAppDelegate(): string {
  const tgz = join(dirname(require.resolve("expo/package.json")), "template.tgz");
  return execFileSync("tar", ["-xzOf", tgz, "package/ios/HelloWorld/AppDelegate.swift"], { encoding: "utf8" });
}

test("app config: the scene plugin is registered", () => {
  assert.ok(config.plugins?.includes("./plugins/scene-life-cycle.js"));
});

test("scene plugin: Expo's AppDelegate provides the factory and makes no window", () => {
  const src = templateAppDelegate();
  assert.match(src, /window = UIWindow\(frame: UIScreen\.main\.bounds\)/, "the template is the one the plugin was written for");
  const out = plugin.editAppDelegate(src);
  assert.match(out, /^class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{$/m);
  assert.doesNotMatch(out, /UIWindow\(frame:/);
  assert.doesNotMatch(out, /startReactNative\(/);
  assert.doesNotMatch(out, /#if os\(iOS\) \|\| os\(tvOS\)/);
  // What the scene delegate reads stays: the window property, the factory, and the overrides the scene's events are forwarded to.
  assert.match(out, /var window: UIWindow\?/);
  assert.match(out, /var reactNativeFactory: RCTReactNativeFactory\?/);
  assert.match(out, /reactNativeFactory = factory/);
  assert.match(out, /open url: URL,/);
  assert.match(out, /continue userActivity: NSUserActivity,/);
  assert.match(out, /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/);
});

test("scene plugin: a second run changes nothing, a template it does not know fails", () => {
  const once = plugin.editAppDelegate(templateAppDelegate());
  assert.equal(plugin.editAppDelegate(once), once);
  assert.throws(() => plugin.editAppDelegate("@main\nclass AppDelegate: UIResponder {\n}\n"), /template changed/);
  const otherWindow = templateAppDelegate().replace("window = UIWindow(frame: UIScreen.main.bounds)", "window = UIWindow()");
  assert.throws(() => plugin.editAppDelegate(otherWindow), /template changed/);
});

test("app config: after every plugin, Info.plist names Expo's scene delegate", () => {
  // As in appconfig.voice.test.ts: a folder of its own, so the answer is the one of a clean prebuild.
  const dir = mkdtempSync(join(app, ".configtest-"));
  try {
    for (const f of ["app.config.ts", "package.json"]) copyFileSync(join(app, f), join(dir, f));
    cpSync(join(app, "plugins"), join(dir, "plugins"), { recursive: true });
    const cli = require.resolve("expo/bin/cli");
    const out = execFileSync(process.execPath, [cli, "config", "--type", "introspect", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, EXPO_NO_TELEMETRY: "1" } });
    const plist = (JSON.parse(out) as { _internal: { modResults: { ios: { infoPlist: Record<string, unknown> } } } })._internal.modResults.ios.infoPlist;
    assert.deepEqual(plist.UIApplicationSceneManifest, {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" },
        ],
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
