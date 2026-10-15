// The parts of the install script (scripts/install.mjs) that do not touch the machine: reading the arguments and the lists of
// devices, choosing one, and turning a tool's last lines into what the user has to do. Tested by test/install.test.ts.

/** The arguments of the script. `errors` lists what was wrong with them (the script prints it and stops with status 2). */
export function parseArgs(argv) {
  const r = { help: false, list: false, check: false, noOpen: false, ipa: false, serve: false, platform: "", device: "", out: "", method: "development", errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") r.help = true;
    else if (a === "--list") r.list = true;
    else if (a === "--check") r.check = true;
    else if (a === "--no-open") r.noOpen = true;
    else if (a === "--ipa") r.ipa = true;
    else if (a === "--serve") r.ipa = r.serve = true;
    else if (a === "--release") { /* the only kind of build there is; accepted so that the command of goal 4.9 reads the same */ }
    else if (a === "--platform" || a === "--device" || a === "--out" || a === "--method") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) r.errors.push(`${a} needs a value`);
      else { r[a.slice(2)] = v; i++; }
    } else r.errors.push(`unknown argument ${a}`);
  }
  if (r.platform && !["android", "ios"].includes(r.platform)) r.errors.push(`--platform is android or ios, not ${r.platform}`);
  if (!["development", "ad-hoc"].includes(r.method)) r.errors.push(`--method is development or ad-hoc, not ${r.method}`);
  if (r.ipa && r.platform && r.platform !== "ios") r.errors.push("--ipa is for --platform ios");
  if (!r.help && !r.platform && !r.errors.length) r.errors.push("--platform android|ios is required");
  return r;
}

/** `adb devices -l` → [{ id, state, name, kind: "android" }]. `state` is adb's: device | unauthorized | offline | ... */
export function parseAdbDevices(text) {
  const out = [];
  for (const line of text.split("\n").slice(1)) {
    const m = /^(\S+)\s+(device|unauthorized|offline|recovery|sideload|bootloader|no permissions[^ ]*)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /\bmodel:(\S+)/.exec(m[3])?.[1];
    out.push({ id: m[1], state: m[2], name: model ? model.replace(/_/g, " ") : m[1], kind: "android" });
  }
  return out;
}

/** `xcrun devicectl list devices --json-output` → the iPhones and iPads Xcode knows: [{ id, udid, name, model, os, usable, note, kind: "ios" }]. */
export function parseDevicectl(json) {
  const out = [];
  for (const d of json?.result?.devices ?? []) {
    const hw = d.hardwareProperties ?? {};
    if (hw.platform && hw.platform !== "iOS") continue; // watches, TVs, Macs
    if (hw.reality && hw.reality !== "physical") continue;
    const tunnel = d.connectionProperties?.tunnelState;
    const notes = [];
    if (tunnel === "unavailable") notes.push("not reachable now: connect it by cable and unlock it");
    if (d.deviceProperties?.developerModeStatus === "disabled") notes.push("Developer Mode is off");
    out.push({
      id: d.identifier, udid: hw.udid ?? d.identifier, name: d.deviceProperties?.name ?? hw.marketingName ?? d.identifier,
      model: hw.marketingName ?? hw.productType ?? "", os: d.deviceProperties?.osVersionNumber ?? "",
      serial: hw.serialNumber ?? "", usable: tunnel !== "unavailable", developerModeOff: d.deviceProperties?.developerModeStatus === "disabled", note: notes.join("; "), kind: "ios",
    });
  }
  return out;
}

/** `xcrun simctl list devices --json` → the iOS simulators: [{ id, udid, name, os, state, kind: "simulator" }]. */
export function parseSimctl(json) {
  const out = [];
  for (const [runtime, list] of Object.entries(json?.devices ?? {})) {
    if (!/\.iOS-/.test(runtime) && !/\biOS\b/.test(runtime)) continue;
    for (const d of list) if (d.isAvailable !== false) out.push({ id: d.udid, udid: d.udid, name: d.name, os: runtime.replace(/^.*\.iOS-/, "").replace(/-/g, "."), state: d.state, kind: "simulator" });
  }
  return out;
}

/**
 * Which device. `named` is what --device said (an id, a serial or a name); without it exactly one of `connected` must be there.
 * `others` are devices that are only chosen by name (the iOS simulators). → { device } or { problem } (one sentence, no hint).
 */
export function pickDevice(connected, named, others = []) {
  if (named) {
    const all = [...connected, ...others];
    const keys = (d) => [d.id, d.udid, d.serial].filter(Boolean);
    let hit = all.filter((d) => keys(d).includes(named));
    if (!hit.length) hit = all.filter((d) => d.name.toLowerCase() === named.toLowerCase());
    if (hit.length === 1) return { device: hit[0] };
    if (hit.length > 1) return { problem: `${hit.length} devices are called "${named}": name one by its id`, candidates: hit };
    return { problem: `no device "${named}"`, candidates: all };
  }
  if (connected.length === 1) return { device: connected[0] };
  if (!connected.length) return { problem: "no device is connected", candidates: [] };
  return { problem: `${connected.length} devices are connected and --device names none`, candidates: connected };
}

export const describeDevice = (d) => `${d.id}  ${d.name}${d.model && d.model !== d.name ? ` (${d.model})` : ""}${d.os ? `  ${d.kind === "simulator" ? "iOS " : d.kind === "ios" ? "iOS " : ""}${d.os}` : ""}${d.state && d.kind === "android" && d.state !== "device" ? `  [${d.state}]` : ""}${d.state && d.kind === "simulator" ? `  [simulator, ${d.state}]` : ""}${d.note ? `  [${d.note}]` : ""}`;

/** A team id is ten letters and digits (developer.apple.com > Membership, or the OU of the Apple Development certificate). */
export const validTeamId = (s) => /^[A-Z0-9]{10}$/.test(s ?? "");

export const signingNeeds = `An install on a real iPhone or iPad is signed with your own Apple developer team (no store, no TestFlight). It needs:
  1. An Apple Account (free or paid) signed in to Xcode: Xcode > Settings > Accounts > "+" > Apple ID. The free "Personal Team" is enough.
  2. The team's 10-character id in the environment, never in a file of the repository:
       export AIWB_IOS_TEAM_ID=ABCDE12345
     (Xcode > Settings > Accounts > the team > "Manage Certificates", or developer.apple.com > Membership details > Team ID; on a Mac that has
      built for a device once: security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject   shows it as OU=...)
  3. A bundle id that is yours alone, when the default (local.aiwhiteboard.app) is taken by another team:
       export AIWB_IOS_BUNDLE_ID=com.yourname.aiwhiteboard
  4. The device: connected by cable (or paired for wireless debugging), unlocked, "Trust This Computer" answered, and Developer Mode on
     (Settings > Privacy & Security > Developer Mode, then restart).
Everything is in docs/development.md, "Install the app on a phone or tablet".`;

/** Known failures of the tools → what the user has to do. The first rule that matches the log wins. */
const RULES = [
  // iOS signing
  [/No Account for Team|No accounts? with|Unable to log in with account|Your session has expired|provisioning profile.*(?:could not be created|not found)|Signing for ".*" requires a development team/i,
    "Xcode has no Apple Account for this team. Open Xcode > Settings > Accounts, add your Apple ID (the free personal team is enough), make sure it is signed in, and run again. The script cannot sign in for you."],
  [/Failed to register bundle identifier|The app identifier .* cannot be registered|is not available\. Please enter a different string|not available.*bundle identifier/i,
    "Apple will not register this bundle id to your team (another team has it). Choose your own and run again: export AIWB_IOS_BUNDLE_ID=com.yourname.aiwhiteboard"],
  [/maximum number of (?:registered )?(?:apps|App IDs)|cannot register more App IDs|reached the maximum number of/i,
    "A free Apple team may create only 10 App IDs per 7 days. Wait for the week to pass, reuse a bundle id you already used (AIWB_IOS_BUNDLE_ID), or use a paid membership."],
  [/Your team has no devices|no devices? from which to generate a provisioning profile|doesn't include the currently connected device|Failed to register device|device .* is not registered|maximum number of registered devices/i,
    "The team has no registration for this device and Xcode could not make one. Connect the device by cable, unlock it, and run again (Xcode registers it with -allowProvisioningUpdates). A free team may register 3 devices."],
  [/No signing certificate|Failed Registering Bundle Identifier|requires a provisioning profile|Code Signing Error/i,
    "Xcode could not make a signing certificate or profile. Check that Xcode is signed in to the Apple Account of this team (Settings > Accounts) and that AIWB_IOS_TEAM_ID is that team's id; then run again."],
  // iOS device
  [/Developer Mode (?:is )?(?:disabled|not enabled|turned off|off)|developer mode.*(?:required|must be|needs)|not in developer mode/i,
    "Developer Mode is off on the device. Settings > Privacy & Security > Developer Mode > on, restart the device, confirm, and run again (the switch shows after the device has been connected to Xcode once)."],
  [/profile has not been explicitly trusted|Untrusted Developer|invalid code signature, inadequate entitlements/i,
    "The device does not trust you yet. On the device: Settings > General > VPN & Device Management > your Apple Development entry > Trust. Then open the app (or run again)."],
  [/device is locked|is locked|Unlock .* to continue|kAMDMobileImageMounterDeviceLocked|DeviceLocked/i,
    "The device is locked. Unlock it and keep it awake, then run again."],
  [/not paired|Trust This Computer|failed to pair|pairing (?:failed|required)/i, "Pair the device: connect it by cable, unlock it and answer \"Trust This Computer\" on it; then run again."],
  [/xcodebuild: error: Unable to find a destination|Unable to find a device matching|Could not find .* device/i,
    "Xcode does not see the device. Connect it by cable, unlock it, check xcrun devicectl list devices, and run again."],
  [/CocoaPods|pod: command not found|pod install/i, "CocoaPods failed or is missing: brew install cocoapods, then run again."],
  // Android
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i,
    "An app with this package is installed with another signature. Uninstall it (this deletes its data, the list of servers included): adb uninstall <package>, then run again."],
  [/INSTALL_FAILED_USER_RESTRICTED|INSTALL_FAILED_ABORTED|Install canceled by user|INSTALL_FAILED_VERIFICATION/i,
    "The phone refused the install. On Xiaomi/Redmi/Poco, Oppo and Vivo phones turn on Developer options > \"Install via USB\" (it may ask you to sign in to the maker's account); on others, accept the install prompt on the screen."],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, "The phone is out of storage. Free some space and run again."],
  [/INSTALL_FAILED_OLDER_SDK/i, "The phone's Android is older than the app supports (Android 7.0, API 24)."],
  [/unauthorized/i, "The phone has not allowed this computer: unlock it and accept \"Allow USB debugging\" (tick \"Always allow\"), then run again."],
  [/SDK location not found|ANDROID_HOME|No toolchains found|Failed to install the following Android SDK packages|licen[sc]e/i,
    "Gradle cannot find or complete the Android SDK. Set ANDROID_HOME to the SDK (default ~/Library/Android/sdk) and accept its licences: $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses"],
  [/Unsupported class file major version|requires Java|Unsupported Java|JAVA_HOME/i, "Gradle needs a JDK 17: brew install openjdk@17 (or set JAVA_HOME to one) and run again."],
];

/** What the user has to do about this log (the end of what a tool printed), or "" when no known rule matches. */
export function explainFailure(log) {
  for (const [re, hint] of RULES) if (re.test(log)) return hint;
  return "";
}

export const tail = (text, n = 25) => text.split("\n").filter((l, i, a) => l.trim() || i < a.length - 1).slice(-n).join("\n");
