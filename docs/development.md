# Build and develop

What you need to build and run AI Whiteboard from source, how to run the desktop app in development, how to build the macOS app, how to put the app on a phone or tablet, how to run the app's web build in a headless browser, how to try voice against a stand-in of ElevenLabs, and how to run the tests, the browser checks and the device tests.

## Prerequisites

- macOS (the desktop app build is macOS only; the server alone also builds for Linux, see
  [Build the server for another machine](remote-servers.md#build-the-server-for-another-machine))
- Go 1.25+
- Node.js 22.19+ and npm
- At least one agent CLI, installed and logged in:
  - [Claude Code](https://claude.com/claude-code): `claude` on your `PATH`
  - [Cursor CLI](https://cursor.com/cli): `agent` on your `PATH`
  - pi: `pi` on your `PATH`, with an authenticated model (no pi binary is bundled with the app)

## Run the desktop app in development

The desktop app shows the app's web build (`app/`, AD-40); it ships inside the app and no server
serves it. From the repo root, build the server program and the web build, then start the desktop
app from the checkout:

```sh
go build -o bin/ai-whiteboard ./cmd/ai-whiteboard
npm ci && (cd app && npm run build:web)
cd desktop && npm ci && npm start
```

The app loads `app/dist-web/index.html` with no packaging and runs `bin/ai-whiteboard` for this
computer's server. The server does not start until it has been set up, so run this once (the
app's first section shows the same command when you forget):

```sh
bin/ai-whiteboard remote setup
```

then press **Retry** in the section. `AIWB_HOME` makes the app use another data folder for its
server (set the server up there too, with `-home`), `AIWB_SERVER_BIN` another server program,
`AIWB_PAGE` another page file (the `index.html` of another web build) and `AIWB_USER_DATA` another folder for the app's own files (its
server list and window state). The MCP port 6006 is fixed, so a second server on the same machine
does not start while another runs.

## Build and install the macOS app

```sh
scripts/build-app.sh    # makes bin/AI Whiteboard.app
scripts/install-app.sh  # copies it to ~/Applications, so Spotlight finds it
```

The web build is built into the bundle (`Contents/Resources/web`), and so is the headless writer
(`Contents/Resources/headless`: its program, its manifest and the board engine with its fonts and the
native canvas, [The board engine in Node](architecture.md#the-board-engine-in-node)), so the macOS app is
one build of the app, its web build, the server program and the headless writer, all of one version. The
script builds the writer for this Mac's processor and fails, saying so, if that build fails. For a server on
another machine see [Build the server for another machine](remote-servers.md#build-the-server-for-another-machine).

## Install the app on a phone or tablet

One script builds the phone and tablet app from the current code and installs it on a device that is connected or named. There
is no store: no TestFlight, no Play Store, no store signing, and no credential in the repository.

```sh
node app/scripts/install.mjs --platform android              # the only Android device that adb sees
node app/scripts/install.mjs --platform ios --device "Ana's iPhone"
scripts/install-app-device.sh --platform ios                 # the same script, from anywhere
node app/scripts/install.mjs --help                          # the options and the environment
```

`--device` takes an adb serial, a UDID or CoreDevice id, or the device's name; without it exactly one device must be connected, and
with several the script lists them and stops. `--list` lists the devices, `--check` checks the tools, the signing and the device
and builds nothing, `--no-open` installs without opening the app. The script is repeatable: run again, it builds and installs the
current code. It says the step it is on (`step 4/8: dependencies`), prints the folder of its logs, and if it stops it says the
step, the reason, what to do when the reason is a known one, and the last lines of the tool's log. Nothing is left in `git
status` but ignored files: the generated `app/ios/` and `app/android/` (never committed), and the build.

What it does: (1) checks the tools; (2) checks the signing; (3) finds the device; (4) `npm ci` at the root when `node_modules`
is older than `package-lock.json`; (5) `npm run prebuild:board` in `app/` (the board's page, which the build takes as an asset)
and reads the app's config; (6) `npx expo prebuild --clean` (the native project is generated, never committed; `--clean`
because a key that the config no longer sets would stay in an old `Info.plist`); (7) the Release build, with the JavaScript and
the board's page inside the app (no Metro); (8) installs and opens the app.

The app's identity comes from the environment, never from a file: `AIWB_IOS_BUNDLE_ID` and `AIWB_ANDROID_PACKAGE` (both
default to `local.aiwhiteboard.app`) and `AIWB_IOS_TEAM_ID` (no default).

### Android: no account

You need:

- On the Mac: the Android SDK (Android Studio, or the command-line tools) with `platform-tools` (`adb`), platform 36, build-tools
  36.0.0, the NDK and CMake that Gradle asks for (Gradle fetches the missing ones if the SDK's licences are accepted:
  `$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses`), and a **JDK 17** (`brew install openjdk@17`; the script finds
  Homebrew's, Android Studio's and the system's, or `JAVA_HOME`). `ANDROID_HOME` defaults to `~/Library/Android/sdk`.
- On the phone or tablet: **Settings > About phone > tap "Build number" seven times**, then **Developer options > USB debugging**
  on; connect the cable; on the device answer **"Allow USB debugging"** for this Mac (tick "Always allow"). Some makers
  (Xiaomi/Redmi/Poco, Oppo, Vivo) have one more switch, **"Install via USB"**, and may ask you to sign in to the maker's account to
  turn it on; Samsung, Pixel and most others do not. `adb devices` must show the device as `device`, not `unauthorized`.
- Nothing from Google: no Google account, no Play Console. The Release APK is signed with the **debug key** that `expo prebuild`
  puts in the generated project (a public key with a well-known password, the same on every prebuild; it protects nothing and is
  no credential of yours). Because the key is always the same, an install over an earlier one of this script keeps the app's data;
  an app of the same package that came from another key must be uninstalled first (`adb uninstall local.aiwhiteboard.app`), which
  deletes its data, the list of servers included. The script says so and does not do it for you.
- The app reaches a server by its address on the network the phone is on; a server on the Mac itself is reached over USB with
  `adb reverse tcp:<port> tcp:<port>` (then add the server as `127.0.0.1`).

### iPhone and iPad: what the Apple account must provide

An iPhone or iPad accepts only an app that is signed, and the signing has to be yours. **A free Apple Account is enough**; a
paid membership is not needed for this script. What the install needs:

1. **A Mac with Xcode** (the `xcodebuild` and `xcrun devicectl` that come with it) **and CocoaPods** (`brew install cocoapods`).
2. **An Apple Account signed in to Xcode**: Xcode > Settings > Accounts > "+" > Apple ID. The script cannot sign in for you and
   reads no password; it uses the account Xcode is signed in to. Signing in creates the account's **Personal Team** (free) or
   shows the team of your **Apple Developer Program** membership (paid, 99 USD a year). You do not enrol in anything for the
   free team; nothing is sent to App Store Connect.
3. **The team's id in the environment**: ten letters and digits, like `ABCDE12345`. It is in Xcode > Settings > Accounts > the team,
   on developer.apple.com > Account > Membership details (paid), or, on a Mac that has signed anything for a device once, as `OU=`
   in `security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject`.

   ```sh
   export AIWB_IOS_TEAM_ID=ABCDE12345
   ```

   It is never read from a file of the repository. Without it the script stops at step 2 (the signing) and prints this list.
4. **A bundle id that no other team has taken.** Apple keeps bundle ids unique across all teams: if `local.aiwhiteboard.app`
   (the default) is already registered to another team, Xcode says it cannot register it, and you choose your own:
   `export AIWB_IOS_BUNDLE_ID=com.yourname.aiwhiteboard`. Keep using the same one afterwards (a free team may create only 10 App
   IDs in 7 days, and the same id is reused).
5. **The device**: connected by cable (or paired for wireless debugging in Xcode > Window > Devices and Simulators), **unlocked**,
   with **"Trust This Computer"** answered, and with **Developer Mode on**: Settings > Privacy & Security > Developer Mode > on,
   then restart the device and confirm. The switch appears only after the device has been connected to Xcode (or has had a
   development-signed app) once, so if you do not see it, run the script once and it will stop with this instruction. Developer
   Mode needs iOS 16 or newer.
6. **The device registered with the team.** You do not do this by hand: the script builds with automatic signing and Xcode's
   `-allowProvisioningUpdates`, so Xcode registers the connected device (its UDID) with the team, makes the development
   certificate (**Apple Development: your name**, in your keychain) and the provisioning profile. The first build may take a minute
   longer for that, and macOS may ask once for your login password to let Xcode use the certificate's key ("Always Allow").
7. **Trust the developer on the device**, the first time: if the app does not open and iOS says "Untrusted Developer", go to
   Settings > General > **VPN & Device Management** > Developer App > your *Apple Development: ...* entry > **Trust**. Then open the
   app (or run the script again).

**Free team or paid membership.** Both install the same app this way; they differ in how long it lasts and how much it can hold:

| | Free Apple Account (Personal Team) | Paid Apple Developer Program |
|---|---|---|
| Cost, enrolment | none, signing in to Xcode is all | 99 USD a year, enrolment at developer.apple.com |
| The installed app works for | **7 days**: the profile then expires and the app no longer opens; run the script again (the data stays) | a year (the development profile's life) |
| Apps on one device | up to 3 at a time from the free team | no such limit |
| Devices | up to 3 | up to 100 iPhones and 100 iPads a year |
| App IDs | 10 new ones in 7 days (so keep one bundle id) | no such limit |
| Store, TestFlight | no | yes, but this goal uses none |

The app uses no capability that a free team lacks (no push, iCloud or similar; the secure store is the keychain, the local
network and camera are Info.plist texts and runtime prompts). The iOS app asks "allow AI Whiteboard to find and connect to
devices on your local network?" when it first connects to a server on the local network, and for the camera when you scan a server's code: both are asked
when needed and may be answered later in Settings.

**Why the iOS app turns App Transport Security off.** The app sets `NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }`
(and nothing else in that dict). A server is the user's own and is reached by whatever name or address they give, with a pinned,
self-signed certificate; ATS would refuse a dotted DNS name without a trusted certificate, and its narrower exceptions cannot name
hosts nobody has typed yet. There is no store review that would ask for a reason. "No plain HTTP" is kept by the app's own code
instead (architecture AD-36): its only networking, `aiwb-net`, builds every URL with the literal scheme `https`, and a test
(`app/test/noplainhttp.test.ts`) fails on any other way out. Android keeps cleartext traffic off.

When it stops, the script names the known reasons and what to do: no Apple Account in Xcode; a bundle id that is taken; a device
that is locked, not trusted or has Developer Mode off; an install that the phone refused (Android: "Install via USB"); an app of
another signature already on the device. The logs of every step are in the folder it prints at the start.

An iOS simulator also works as a target (`--device <udid or name of the simulator>`; `xcrun simctl list devices`): it needs no
signing and no team, and tries the build part of the script.

### An .ipa file instead of an install

For a device that is not connected (or to keep a build to install later), `--ipa` archives the app and exports a signed file
instead of installing it:

```sh
AIWB_IOS_TEAM_ID=ABCDE12345 scripts/install-app-device.sh --platform ios --ipa                    # bin/ios/AIWhiteboard-<version>-development.ipa
AIWB_IOS_TEAM_ID=ABCDE12345 scripts/install-app-device.sh --platform ios --ipa --method ad-hoc   # with the Apple Distribution certificate
scripts/install-app-device.sh --platform ios --ipa --out ~/Downloads                               # another folder
```

No device is needed, but the device's UDID must be registered with the team: the profile that Xcode makes (automatic signing)
lists the registered devices, and the file installs only on those. `development` works with any team, the free one included, and
the file stops working when the profile expires (7 days for a free team, a year for a paid one). `ad-hoc` needs the paid Apple
Developer Program and an Apple Distribution certificate in the keychain. Install the file by dragging it onto the device in
Finder (or Apple Configurator), or open a link in Safari on the device (below).

#### Install by opening a link

```sh
AIWB_IOS_TEAM_ID=ABCDE12345 scripts/install-app-device.sh --platform ios --serve  # builds the .ipa, then serves it
node app/scripts/serve-ipa.mjs [--ipa <file>] [--port <n>]                        # serves a .ipa that is already built
```

iOS installs over the air only from **https with a certificate the device trusts**, so the script serves https on every address of
this computer, port 8443 (`--port`), for a device on the same network or VPN, and prints the addresses and two links:

1. Once per device: open `http://<address>:8444/` in Safari, download the certificate, install it (Settings > General > VPN &
   Device Management) and switch it on (Settings > General > About > Certificate Trust Settings).
2. Open `https://<address>:8443/<token>/` in Safari and tap **Install**; the app appears on the home screen. The first time, iOS
   may say "Untrusted Developer": Settings > General > VPN & Device Management > your Apple Development entry > Trust.

The authority is made on the first run in `~/.aiwb-install/ca` (mode 700; the key never leaves the computer) and is limited by name
constraints to private network addresses (10/8, 172.16/12, 192.168/16, 100.64/10) and `localhost`, so a leaked key could not sign
for a public site. A device that trusts it once needs no step 1 on later runs. The server certificate is made again at each run for
the addresses of that moment, so run again when the address changes. Delete the profile on the device, and `~/.aiwb-install`, to
undo it.

Every path carries a random 128-bit token and only the page, the manifest and this one `.ipa` are served, and the file installs only
on the devices of its profile. Ctrl-C stops the server, and the link stops working.

## The web build in a headless browser

The app is not used in a browser tab, but its web build can still be opened in a headless browser,
for the browser checks and for checking a change to a screen without the desktop app. The page then
reaches the network through a plain HTTP face on `127.0.0.1` instead of the app's main process. Two
programs serve it (Playwright is not a dependency: see [`AGENTS.md`](../AGENTS.md) for how it is
installed). The page's policy lets it reach only the files it came from, so the build for them is
made with `--connect-self`:

```sh
(cd app && npm run build:web -- --output-dir /tmp/aiwb-dist --connect-self)
node web/dev/host.mjs --dist /tmp/aiwb-dist --state-dir /tmp/aiwb-host   # the test host: a real server list, real servers
DIST=/tmp/aiwb-dist node web/dev/mock.mjs                              # the mock: a fake client, no server (port 4791, PORT=… to change)
```

The **test host** (`web/dev/host.mjs`) does for the page what the app's main process does: it holds
the server list and the secrets in the state folder, makes the pinned HTTPS connections with the
same module (`packages/conn`), and serves the page's files, calls, one event stream and pictures. With
`--local-bin PATH` (and `--local-home DIR`) it finds or starts this computer's server with that
server program as the app does. It prints `Host: http://127.0.0.1:<port>/` and listens on the
loopback address only. It is never shipped and no server serves it. The **mock** (`web/dev/mock.mjs`)
stands behind the same face with a made-up world, for working on a screen without a Go server;
it is not the contract, the server is. Nothing is injected into the page by either.

To work on the app with a live reload, `cd app && npm run web` (Expo's web server) or `npm start` (a development build on a
simulator, an emulator or a device; the native folders are generated, never committed).

## Voice without ElevenLabs

No test and no check of voice calls ElevenLabs, and none needs a key of the real service. The **stand-in voice service**
(`web/dev/voicestandin.mjs`, plain Node with no dependency) answers the parts of ElevenLabs that voice uses: the voices, a
single-use token, the text-to-speech stream (chunked PCM, a tone whose length follows the text), the preview clips and the
realtime transcription socket. It accepts a key that starts with `sk_test_` and refuses any other as ElevenLabs refuses a bad
key; its header lists every route and every failure it can be told to give. What it does is under your control: the words
the socket answers are a script by the number of audio chunks it has received, a failure can be set (`key_rejected`,
`no_credits`, `rate_limited`, `offline`), and its log lists every call (never a key) with what the page sent and whether it
sent anything against the protocol. The microphone is real, the page's or the simulator's own; the stand-in checks what it
hears (16 kHz, chunks of 100 ms) and answers the script, whatever the sound is.

It is mounted under `/voice` by the mock (`web/dev/mock.mjs`, its control is `voice` in `/mock/eval`) and by the test host
(`startHost({ voice: true })` returns it as `host.voice`), so the browser checks and the free scripts of `web/e2e` have it
with no step of yours. Alone:

```sh
node web/dev/voicestandin.mjs --port 5710                  # prints `Voice: http://127.0.0.1:5710/voice`; listens on 127.0.0.1 only
node web/dev/voicestandin.mjs --port 5710 --prefix /       # the same at the root of the origin
curl -X POST 127.0.0.1:5710/voice/_control/script -d '[{"after":3,"partial":"hel"},{"after":6,"committed":"hello"}]'
curl 127.0.0.1:5710/voice/_control/log                     # also POST …/_control/{fail,pace,reset}
```

Point the app at it with a variable of the build. **A phone or tablet:** `EXPO_PUBLIC_AIWB_VOICE_BASE` is the stand-in's address
with its prefix (`http://127.0.0.1:5710/voice`; a plain path of words, or none for a stand-in started with `--prefix /`). The
app reads it when Metro bundles, so set it when you start Metro or build the development app:
`cd app && EXPO_PUBLIC_AIWB_VOICE_BASE=http://127.0.0.1:5710/voice npm start`. It counts
only in a development build (`__DEV__`) and only for a host on this computer or its network (`localhost`, `127.x`, `10.0.2.2`,
a private IPv4 address); a Release build, such as the one the install script makes, and any other value are ignored, so the
app calls ElevenLabs. An iOS simulator reaches the Mac at `127.0.0.1` and an Android emulator at `10.0.2.2`; the stand-in
listens on loopback only, so a device cannot reach it. **The desktop app:**
`cd desktop && AIWB_VOICE_BASE=http://127.0.0.1:5710/voice npm start`, with the prefix of the stand-in. The main process honours
it only when the app is not packaged and the address is on this computer, and a packaged app ignores it. The key you type in
Settings is then written to `<user data>/client/voice-key` as always, so run with `AIWB_USER_DATA` set to another folder to
leave a real key alone. **The web build** needs no variable: served by the mock or the test host, it finds the stand-in at
`/voice` of its own origin, and the key lives in the page's memory until it is loaded again.

**The browser checks of voice** are `VC.1` to `VC.7` in `web/dev/checks` (`cd web && npm run uicheck -- VC`; the
`README.md` there has a row for each and the stand-in's controls). Their Chromium is started with three flags,
`--use-fake-ui-for-media-stream` (no prompt for the microphone), `--use-fake-device-for-media-stream` (a fake microphone)
and `--autoplay-policy=no-user-gesture-required`, and every page has the `microphone` permission (`BROWSER_ARGS` and
`launchChromium` in `web/dev/shot.mjs`); a blocked microphone is `window.__aiwbVoice.denyMic(true)`, which only a build for
the checks has. The Electron shim of `uicheck:electron` ignores both the flags and the permission.

On some machines Chromium's fake microphone never answers `getUserMedia`: Chromium 153 and 156 on macOS 15 with a virtual
audio driver such as "NDI Audio" installed, and then the whole browser stops answering clicks. The checks that listen get their
microphone from `web/dev/checks/mic.mjs`. It tries the browser's fake device once, in a browser of its own, and if that does not answer
within six seconds it puts a stand-in microphone into the page, an oscillator on the page's own audio context, which goes through
the same capture, conversion and framing from the stream on, and the check says that it did. `AIWB_MIC` sets the way: `device` never
falls back (a hang fails the check), `synthetic` never tries the device. Without it the probe decides.

The free scripts `web/e2e/voice.e2e.mjs` (a scratch server through the test host with the stand-in: a spoken turn becomes an
ordinary message, the reply is spoken sentence by sentence, the key is found nowhere it should not be, and a page that never
used voice makes no request to `/voice`) and the voice part of `desktop/e2e/app.e2e.mjs` (an Electron app at a standalone
stand-in through `AIWB_VOICE_BASE`: the key file, no key on the page, Read aloud through the main process, Remove) run on it too.
The microphone and the audio session of a phone are tested by a device flow, `voice-mic` (`app/e2e/README.md`), on a simulator;
echo cancellation and voice barge-in need a real phone and a real speaker, and are tried by a person.

## Development

```sh
go test ./...                                  # server tests, default set: fast, for while you work (about 15 seconds)
AIWB_TEST_FULL=1 go test -timeout 20m ./...    # server tests, full set: every test in full (about 40 seconds)
npm test && npm run check                      # at the root: the unit tests and the type checks of app/ and packages/* (core, conn, board-bridge, board-view, board-engine, headless)
cd web && npm test                             # the test host, the mock's face, the browser checks' own helpers
cd web && npm run uicheck                      # the browser checks of the app's web build on the mock (dev/checks; builds its own export; long)
cd web && npm run uicheck -- VC                # the browser checks of voice, on the mock's stand-in voice service
cd web && npm run uicheck:electron             # the same checks drawn by the desktop app's own Chromium (dev/electron); with no check named: L8
cd desktop && npm test                         # desktop app tests: the main process, the IPC face
cd desktop && npm run e2e                      # the app itself, with a stand-in server (opens a window for a few seconds; after `cd app && npm run build:web`)
node --test web/dev/host.test.mjs              # the test host
```

Which set to run when, what each costs and how to write a test for either set is in
[`AGENTS.md`](../AGENTS.md).

`web/e2e/newchat.e2e.mjs`, `twopages.e2e.mjs`, `remotechat.e2e.mjs` and `localserver.e2e.mjs`
drive the app's web build in headless Chrome, through a test host, against real servers they build and
start themselves, with the stand-in agent, and spend no money; `remotechat.e2e.mjs` runs this
computer's server and a remote server and shows the sections of the sidebar, an outage and the
return (also with `VIEWPORT=phone`), and `localserver.e2e.mjs` runs this computer's server in every state it can be
in. They serve the web build (`DIST=app/dist-web` after `cd app && npm run build:web`; without `DIST` a script builds its own),
except `localserver.e2e.mjs`, which builds what it needs. Each header says how to run it.

`web/e2e/app.e2e.mjs` runs an end-to-end pass in headless Chrome, through a test host, against
real agents. It uses cheap models but still spends a little money; its header explains how to run
it, and says that its page steps still read the page the app replaced and need moving onto `web/e2e/lib/ui.mjs` before they run
again. Stop the running AI Whiteboard app before a default run: the real-Cursor step needs exclusive
port 6006 (Cursor's org allowlist approves only `http://localhost:6006/mcp`). If 6006 is taken the
suite fails fast with an explicit message; set `AIWB_E2E_SKIP_CURSOR_MCP=1` to report the
real-Cursor MCP steps as skipped and run the rest on the hidden test-only MCP port override, so a
normal app instance may keep 6006.

### The device tests

What a browser cannot show (the native network and its certificate rule, the board in a web view, the hardware keyboard, the
sheets and the keyboard on a phone, the image picker and its permission) is tested on the iOS simulator and the Android emulator
by flows that Maestro runs, started by one command; they use a scratch server of their own and never the one you use:

```sh
node app/e2e/run.mjs conn-on-hermes --platform ios --device <simulator udid>
node app/e2e/run.mjs --list
```

`app/e2e/README.md` has the flows, what a run does, and how to name your own simulator or emulator. Maestro is fetched on first use
into a git-ignored folder, checked against a checksum written in the script; nothing is installed system-wide.
