// The UIScene life cycle on iOS. From the iOS 27 SDK on, UIKit stops an app at launch unless it uses scenes; Expo 57's template still
// makes the window in AppDelegate.application(_:didFinishLaunchingWithOptions:) and has no scene manifest, so an app built with Xcode 27
// crashes as it opens on iOS 27. Expo 57 ships the scene delegate (ExpoAppSceneDelegate, `EXExpoAppSceneDelegate` to Objective-C) and
// Expo 58's template uses it; this plugin makes the same change to the generated project (ios/ is never committed, AD-5):
// - Info.plist: a scene manifest whose one configuration names EXExpoAppSceneDelegate (no SceneDelegate.swift to add to the project);
// - AppDelegate.swift: the class conforms to ExpoReactNativeFactoryProvider, and the block that made the window and started React Native
//   is gone. The delegate still makes the factory and keeps it in `reactNativeFactory`; the scene delegate reads it, makes the window from
//   the scene and starts React Native in it, with the URL or activity that cold-started the app. The open-URL and user-activity overrides
//   stay: Expo forwards the scene's events to them.
// Each AppDelegate edit finds its template text exactly once or throws, so a changed template fails the prebuild instead of building an
// app that crashes. Once Expo's own template does this (Expo 58), this plugin goes.
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE = "EXExpoAppSceneDelegate";

const sceneManifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [
      { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: SCENE_DELEGATE },
    ],
  },
};

const CLASS_LINE = /^class AppDelegate: ExpoAppDelegate \{$/m;
const CLASS_LINE_DONE = /^class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider \{$/m;
// The window block of the template, from its #if to its #endif, with the newline after it.
const WINDOW_BLOCK = /^#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([^)]*\)\n#endif\n/m;

/** Replaces the one match of `find` in `src`; throws when there is none or more than one. `done` matching means the edit was made before. */
function replaceOnce(src, find, replacement, done, what) {
  if (done && done.test(src) && !find.test(src)) return src;
  const all = src.match(new RegExp(find.source, find.flags.includes("g") ? find.flags : find.flags + "g"));
  if (!all || all.length !== 1) {
    throw new Error(`scene-life-cycle: AppDelegate.swift has ${all ? all.length : 0} matches of ${what}, not 1; the Expo template changed, update app/plugins/scene-life-cycle.js`);
  }
  return src.replace(find, replacement);
}

function editAppDelegate(src) {
  let out = replaceOnce(src, CLASS_LINE, "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {", CLASS_LINE_DONE, "the AppDelegate class line");
  const windowGone = /startReactNative\(/.test(out) === false;
  if (!windowGone) out = replaceOnce(out, WINDOW_BLOCK, "", null, "the block that makes the window and starts React Native");
  if (/UIWindow\(frame:|startReactNative\(/.test(out)) throw new Error("scene-life-cycle: AppDelegate.swift still makes a window or starts React Native");
  if (!/reactNativeFactory = factory/.test(out)) throw new Error("scene-life-cycle: AppDelegate.swift no longer keeps the factory in reactNativeFactory");
  return out;
}

/** @param {import("expo/config").ExpoConfig} config */
function withSceneLifeCycle(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = sceneManifest;
    return c;
  });
  config = withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error(`scene-life-cycle: AppDelegate is ${c.modResults.language}, the plugin edits Swift`);
    c.modResults.contents = editAppDelegate(c.modResults.contents);
    return c;
  });
  return config;
}

module.exports = withSceneLifeCycle;
module.exports.editAppDelegate = editAppDelegate;
module.exports.sceneManifest = sceneManifest;
