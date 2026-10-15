# Architecture of the React Native rewrite (Part A)

The decisions every implementer needs, so that a package can be built without making an architecture choice.
It stands on `react-native-rewrite-goal.md` ("the goal") and `app-as-client-goal.md` ("the client goal"); where this
file and the goal differ, the goal holds and this file is wrong. The work packages are in `packages.md`, the parity
reference in `parity-inventory.md`. How agents work (models, worktrees, the shared machine) is in `ORCHESTRATION.md`.

**Marks**, as in the goal: `[user]` the user decided it; `[proposed]` decided here, not by the user (a statement with no
mark is `[proposed]`); `[not verified]` an assumption nobody has checked yet. A decision is numbered **AD-n** so that a
package can name it. Where a feasibility spike of goal section 9 is still open, the decision says what it assumes and
what changes if the spike fails (**If the spike fails**).

Spikes beside this plan (reports in `plans/rn-rewrite/spikes/`, code under `spikes/`): `rn-spike-electron`
(`electron.md`), `rn-spike-board-webview` (`board-webview.md`), `rn-spike-ios-net` (`ios-net.md`) and
`rn-spike-composer` (`composer.md`) have reported, **all GO**. `rn-spike-android-net` (AD-32) is still running: what
this file says of Android is still the assumption it was.

**Revisions.** A decision changed by what a spike or a merged package found carries the mark **(revised after spike
X)** or **(revised after package X)** at the place that changed, with the reason. Where a revision and an older
sentence of this file seem to differ, the revision holds. The second architect's pass (branch `rn-arch2`) made these
revisions; the packages they touch are revised in `packages.md` the same way.

---

## 0. The shape in one page

```
            ┌──────────────── one React Native codebase: app/ (Expo SDK 57, RN 0.86, react-native-web) ───────────────┐
            │ screens (RN primitives, width breakpoints)                                                             │
            │   │ useStore / actions                                                                                 │
            │ @aiwb/core  (moved unchanged: logic, types, api, transport interface; with seams: store, conn, drafts…) │
            │   │ transport()                         │ BoardHost (typed messages: @aiwb/board-bridge)               │
            └───┼─────────────────────────────────────┼──────────────────────────────────────────────────────────────┘
     ┌──────────┼──────────────┬──────────────┐      ├── web build: Excalidraw in the page (@aiwb/board-view's esbuild bundle board.js, in-process; Metro never bundles Excalidraw)
     │ ipc      │ http         │ native       │      └── iOS/Android: Excalidraw in a web view (the same esbuild build, as one board.html)
     │ (desktop)│ (test host,  │ (iOS/Android,│
     │          │  mock)       │  in-process) │
 preload builds │ fetch +      │ Client of    │
 the transport  │ EventSource  │ @aiwb/conn   │
     │ IPC      │ HTTP         │ with ports:  │
 main process:  │ web/dev/     │  Session+Connector = native module aiwb-net (Swift URLSession / Kotlin OkHttp, pin by SHA-256)
 ipcface + Client host.mjs:    │  Store = MMKV + SecureStore
 of @aiwb/conn  │ Client of    │
 (Node ports)   │ @aiwb/conn   │
                │ (Node ports) │
```

- **One client, four targets**: the desktop app's window loads the app's **web build** (react-native-web, exported by
  Expo/Metro); iPhone, iPad and Android run it natively. `[proposed]` (goal D1, D2)
- **One shared connection module** `@aiwb/conn` (today's `desktop/conn`, made platform-free) is the Client, the
  Manager and the Conn on every platform; the platform fills three ports (Session, Connector, Store). (goal D9)
- **Three transport ways** with one interface: `ipc` (desktop; built in the preload), `http` (test host and mock),
  `native` (in-process, phone and tablet). (goal D8)
- **One board component** `@aiwb/board-view` that runs Excalidraw, driven only by typed messages; in the page on the
  web build, in a web view on native; **one esbuild build of Excalidraw for both** (revised after package B2, AD-51).
  (goal D7)
- **The old page** (`web/src`) keeps building from the same `@aiwb/core` until it is retired. (goal D15)

---

## 1. Repository layout, packages and tools

### AD-1 Layout `[proposed]`

```
package.json              NEW. Private root with npm workspaces: ["app", "packages/*"]. No code. Root package-lock.json.
app/                      NEW. The Expo project: the app on all four targets (name "@aiwb/app").
  app.config.ts           Expo config (name, slug, ids from env, plugins, web output "single", iOS ATS of AD-36)
  index.ts                registerRootComponent(App)
  metro.config.js         getDefaultConfig + monorepo (watchFolders = repo root); "html" added to assetExts for the
                          board's page (AD-56). No resolver change for Excalidraw: Metro never bundles it (AD-51)
  tsconfig.json           base; tsconfig.native.json / tsconfig.web.json (moduleSuffixes) for the two type checks
  public/index.html       the web build's HTML template (as web/index.html today), with the tags of public/board/
  public/theme-init.js    the theme set before first paint: a file, since the CSP allows no inline script (revised
                          after package F1)
  public/board/           generated, not committed: @aiwb/board-view's web target (board.js, board.css, fonts/), AD-51
  src/
    App.tsx               the root: providers, bootstrap (§6.1), layout shell
    platform/             what differs per platform, each as a port with .web.ts/.native.ts files (§1, AD-9):
      transport.*.ts        which transport way (AD-20); .web by U3, .native by C4
      kv.*.ts               key-value storage (AD-12)
      serverstore*.ts       the phone's Store (AD-13): serverstorecore.ts (platform-free) + serverstore.native.ts
      keys.*.ts             keyboard shortcuts (AD-73)
      picture.*.tsx         showing a picture of a chat (AD-25); picturecommon.tsx holds the address seam
      board.*.tsx           the board host: in page / web view (AD-52)
      chipinput/            the composer's text box with chips (AD-60, AD-61)
      quote.*.ts(x)         taking a quote (AD-64)
      imagepick.*.ts        picking images (AD-26)
    ui/                   primitives and theme (§5): tokens.ts, theme.tsx, Text, Button, IconButton, Popover, Menu,
                          Sheet, Dialog, Resizer, icons.tsx (react-native-svg), tid.ts (test ids), breakpoints.ts
    screens/              the screens, by area: shell/, sidebar/, servers/, chat/, markdown/, toolcards/, subagents/,
                          fork/, composer/, library/, board/, images/
    dev/                  self-test screens for device tests (AD-83), compiled in only when EXPO_PUBLIC_AIWB_SELFTEST=1
  modules/aiwb-net/       the native module of the connection (Expo Modules API): ios/*.swift, android/**/*.kt,
                          src/AiwbNet.ts (the contract), src/fake.ts (the fake), expo-module.config.json
  modules/aiwb-keys/      hardware-keyboard shortcuts on iPad and Android (AD-73), Expo module
  plugins/                config plugins (AD-5): withAiwbPermissions; withBoardAssets only if Android needs it (AD-56)
  e2e/maestro/            device and simulator flows (AD-83)
  e2e/get-maestro.sh      fetches the pinned Maestro and a JRE into app/e2e/.tools/ (git-ignored), AD-83
  scripts/install.mjs     the install script (goal 4.9, §9)
packages/
  core/                   @aiwb/core: the page's non-visual code (AD-2). TypeScript, no runtime dependency.
  conn/                   @aiwb/conn: the shared connection code (AD-10). CommonJS + JSDoc + .d.ts, Node and Hermes.
  board-bridge/           @aiwb/board-bridge: the typed board messages and their validators (AD-50). TS, no dependency.
  board-view/             @aiwb/board-view: Excalidraw and its endpoint (AD-51); its own esbuild builds Excalidraw for
                          both the web build and the web view.
web/                      the old page (web/src, until retired) and what outlives it: web/dev (test host, mock, checks,
                          uicheck), web/e2e. web/dev/checks-app/ holds the checks of the new build (AD-80).
desktop/                  Electron: main.js, preload.js (builds the transport, AD-40), ipcface.js, lib.js; no conn/ any more.
```

- `web` and `desktop` stay **outside** the npm workspaces, with their own `package-lock.json`, so the old page, the
  Electron packaging (electron-builder, which handles hoisted workspaces badly) and their tests do not change by
  being moved. They reach the packages by path:
  - the old page: an esbuild `alias` `{"@aiwb/core": "../packages/core/src"}` in `web/build.mjs`, and
    `"paths": {"@aiwb/core/*": ["../packages/core/src/*"]}` in `web/tsconfig.json`; `web/dev/shot.mjs` `buildDist`
    builds through `web/build.mjs`, so it follows;
  - the test host: `require("../../packages/conn/node")` (it is never packaged);
  - the desktop app: the dependency `"@aiwb/conn": "file:../packages/conn"` in `desktop/package.json`, so that
    electron-builder packs it into `app.asar` like any dependency. `[not verified]`: electron-builder 26 copies a
    `file:` dependency into the asar. **If not**: `files` gets the FileSet `{from: "../packages/conn", to:
    "node_modules/@aiwb/conn"}`. The package that moves the module (C1) checks it with `scripts/build-app.sh`.
- A package's code imports another package by its name (`@aiwb/core/logic/keys.ts`), never by a relative path that
  leaves the package, except the three path uses above.
- Every package has `npm test` (`node --test`, Node 22.19+, `--experimental-strip-types` for TS) and, when it has
  TypeScript, `npm run check` (`tsc --noEmit`). The root has `npm test` and `npm run check` that run every
  workspace's.
- **TypeScript versions** (revised after package F1): `packages/*` and `web/` use TypeScript 7; **`app/` uses
  TypeScript 6.0.3**, the version Expo SDK 57 pins (`npx expo install --check` would flag another). The app's check
  type-checks the core files it imports with 6.0.3 too, so code in `packages/` that the app imports must pass both
  (nothing TypeScript-7-only in it).

### AD-2 What "moves unchanged" means `[proposed]` (goal 4.2, D5)

`@aiwb/core` gets, by `git mv` with **no change to their text**, the files whose tests import nothing visual:

| From `web/src` | To `packages/core/src` |
|---|---|
| `logic/*.ts` (all 63 files) | `logic/*.ts` |
| `types.ts`, `api.ts`, `agents.ts`, `format.ts`, `libraryapi.ts`, `serversapi.ts` | same names |
| `transport/{types,http,ipc,index}.ts` | `transport/` |
| `web/test/*.test.ts` and `web/test/fixtures/*` that import only the above | `packages/core/test/` |

The relative imports inside them (`../types.ts`, `./transport/index.ts`, `../src/logic/x.ts` in the tests) stay valid
because the folder shape is kept. The old page's own files change only their import lines (`./logic/x.ts` →
`@aiwb/core/logic/x.ts`). Proof that nothing moved but the place: `cd packages/core && npm test` runs the same tests
with the same results as `cd web && npm test` did, and the old page passes `npm run check` and `npm run uicheck`.

**Moves with seams** (package F3): the page's state layer, which today reaches React, the DOM, Excalidraw or a screen.
Each seam is a small registered interface, and the old page registers today's behaviour, so the old page behaves as
before (proved by its uicheck):

| File (to `packages/core/src/state/`) | Today it reaches | Seam |
|---|---|---|
| `store.ts` | `react` (useStore), `localStorage`, `Dialogs.tsx` (type) | `useStore` leaves core: each UI makes it with its own React (`useSyncExternalStore(subscribe, …)`); `safeGet/safeSet/safeRemove/safeKeys` call the **kv port** `setKv(kv)`; `ConfirmRequest` type moves to core |
| `conn.ts`, `store.ts` | `board.ts` (runTool, flushAll, granted…, and the store's forgetting of a board) | the **BoardSide** interface `setBoardSide(side)` (AD-55); **ten members** (revised after package F3): the eight `conn.ts` calls plus `forgetBoard(id)` and `boardUnsaved(id)`, which the store needed |
| `fork/actions.ts` → `state/actions.ts` | `Sidebar.openChat`, `Composer.focusComposer`, `Dialogs.reportError` | the **Ui** interface `setUi({openChat, select, focusComposer, reportError, confirm})` |
| `uploads.ts`, `version.ts` | `Dialogs.reportError/confirm`, `window.aiwbFlush` | the Ui interface; `flushBeforeReload` callback |
| `chatdraft.ts`, `keptdrafts.ts` | (store) | none beyond store's |

`board.ts` and `apply.ts` do **not** move: the old page keeps them until retirement, and the app gets a new board
side built on messages (AD-55). `theme.ts` (writes `document.documentElement.dataset`) stays a UI file of each
client; `logic/theme.ts` and `logic/flavours.ts` are already in core.

### AD-3 Expo SDK and libraries `[proposed]`

Pinned by the skeleton package (F1) with `npx expo install` (which picks the versions of the SDK); the versions
below are what `npm view` gave on 2026-10-14 and are the floor.

| Need | Choice | Why / note |
|---|---|---|
| SDK | **Expo SDK 57** (`expo` 57.0.x), the React Native it pins (0.86.3 and React 19.2.3 in `rn-spike-electron`), New Architecture on, Hermes | current; Expo Modules API for our native code |
| Web | `react-native-web` 0.21, `react-dom` | the web build (goal 4.1) |
| Navigation | **React Navigation 7** (`@react-navigation/native`, `native-stack`), **no expo-router**, `linking` off | the window loads the web build from a file (AD-41): no URLs to route; the page has no routes today; the state of what is shown is the store's `sel`, as today (AD-71) |
| Lists | **`@legendapp/list` 3** for the thread and long sidebar trees | made for chat: `maintainScrollAtEnd`, `maintainVisibleContentPosition`, works on web. Fallback: `FlatList` |
| Markdown | **remark** (`unified`, `remark-parse`, `remark-gfm`, `remark-breaks`, as the page today) to mdast, and **our own mdast → RN renderer** | the same parsing as today means the same text shown (parity); a library renderer would parse differently. Code: `lowlight` + `highlight.js` (as today) to tokens rendered as nested `Text`. `[not verified]`: micromark runs on Hermes (it uses Unicode property escapes in RegExp). **If not**: `react-native-marked` for native, our renderer stays on web |
| Fast key-value storage | **`react-native-mmkv` 4** (needs `react-native-nitro-modules`) on native; `localStorage` on web | synchronous, which the store's `safeGet/safeSet` need (AD-12) |
| Secure storage | **`expo-secure-store`** (Keychain / Android Keystore), its synchronous `getItem/setItem` | goal D11; synchronous so the Store port stays synchronous (AD-13) |
| Image picker | **`expo-image-picker`**; bytes read with **`expo-file-system`** (`File.bytes()`) | goal 4.2 |
| Camera (scan a code) | **`expo-camera`** barcode scanning | goal 4.7 |
| Files (picture cache) | **`expo-file-system`** (new `File`/`Directory` API) | AD-25 |
| Web view | **`react-native-webview`**, the version `npx expo install` picks for SDK 57 (**13.16.1** in the board spike, not the 14 this row said before) (revised after spike board-webview) | AD-52 |
| Board page as an asset | **`expo-asset`** (the board's one `board.html` as a Metro asset, its file URI at run time) (revised after spike board-webview) | AD-56 |
| Gestures | **`react-native-gesture-handler` 2.32** (what SDK 57 pins; `GestureDetector`, Pan with long-press activation on touch) (revised after package U2: not 3) | drag and drop, resizer, sheet drag; works on web |
| Animation | React Native `Animated` (and `react-native-reanimated` 4 only where a library requires it) | keep the web build light |
| Sheets, popovers, dialogs | **our own** `Sheet`, `Popover`, `Menu`, `Dialog` on RN `Modal` (AD-70) | they must behave the same in the browser tests at the phone viewport; `@gorhom/bottom-sheet` is not dependable on web |
| Icons | **`react-native-svg`** (today's `icons.tsx` are SVG) | works on web |
| Clipboard | **`expo-clipboard`** (native); `navigator.clipboard` (web) | copy actions |
| Safe areas | `react-native-safe-area-context` | |
| Keyboard avoidance | **`react-native-keyboard-controller`** (native) | composer above the keyboard |
| Random | `expo-crypto` (`getRandomValues` installed as `globalThis.crypto.getRandomValues` at start on native; `randomUUID` for the client id, AD-13) | ids in `@aiwb/conn` (AD-11) |
| Rich text with chips (native) | **none**: a controlled multiline `TextInput` with nested `Text` children, our own code (revised after spike composer; `react-native-enriched` is not used) | AD-61 |
| Device UI tests | **Maestro 2.11.0**, pinned, fetched with its sha256 checked into the git-ignored `app/e2e/.tools/` by `app/e2e/get-maestro.sh`, with a JRE 17 beside it; nothing installed system-wide (revised after spikes ios-net and composer) | AD-83 |

No other UI kit. A library not on this list is added by a package only when its package text names it.

### AD-4 Language and checks `[proposed]`

- App, core, bridge and board-view: TypeScript, `strict`, imports with explicit `.ts`/`.tsx` extensions
  (`allowImportingTsExtensions`, as `web/` does) so that the moved files keep their text. `[not verified]`: Metro
  resolves imports that carry the `.ts` extension; F1 proves it (a core import in the web export).
- `@aiwb/conn` stays **CommonJS JavaScript** with `// @ts-check` and JSDoc, plus `ports.d.ts` and `index.d.ts`
  (AD-10): the Electron main process and the test host load it with no build step, and Metro takes CommonJS.
- "The type check passes for every target" (goal 7.2): `cd app && npm run check` runs
  `tsc -p tsconfig.native.json` (`moduleSuffixes: [".native", ".ios", ".android", ""]`) and
  `tsc -p tsconfig.web.json` (`moduleSuffixes: [".web", ""]`); `packages/*` run their own `tsc`.

### AD-5 Native folders: Continuous Native Generation `[proposed]`

- `app/ios/` and `app/android/` are **generated** by `npx expo prebuild` and **never committed** (`app/.gitignore`).
  Every native setting is a config plugin in `app/plugins/` or an entry of `app.config.ts`; native code of ours is only
  in `app/modules/*` (autolinked local Expo modules).
- Plugins: `withAiwbPermissions` (iOS `NSLocalNetworkUsageDescription`, `NSCameraUsageDescription`,
  `NSPhotoLibraryUsageDescription`; Android `CAMERA`; no cleartext traffic, no `network_security_config`: our trust
  manager is our own); `withBoardAssets` only if Android needs it (AD-56; iOS does not, revised after spike
  board-webview).
- Entries of `app.config.ts` (revised after spike ios-net and package C5):
  - `ios.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }`, exactly that dict, replacing Expo's
    default (AD-36);
  - `plugins: [["expo-secure-store", { configureAndroidBackup: true }]]` (keeps the secure store's data out of
    Android's auto backup, whose restore could not decrypt it; no `faceIDPermission`: no secret asks for Face ID).
    `[not verified]`: the option's name in SDK 57's plugin; N1 reads it in the installed package. C5 added the
    library but not this entry; N1 adds it (packages.md).
- `npx expo prebuild` does **not** remove an Info.plist key that the config no longer sets (found by spike ios-net):
  every build that matters (the install script, the device tests) prebuilds with `--clean`.
- Identity from the environment, never from the repository (goal 4.9): `app.config.ts` reads
  `AIWB_IOS_BUNDLE_ID` (default `local.aiwhiteboard.app`), `AIWB_ANDROID_PACKAGE` (default `local.aiwhiteboard.app`),
  `AIWB_IOS_TEAM_ID` (no default; only the install script and a device build need it).
- Development: an Expo development client (`expo-dev-client`) for simulators/emulators; the install script builds a
  Release with the JS bundle inside (§9).

---

## 2. The shared connection code: `@aiwb/conn` (goal 4.6, D8, D9)

### AD-10 The split of `desktop/conn` `[proposed]`

`desktop/conn` moves to `packages/conn` and is split in two:

```
packages/conn/
  index.js        createClient({ connector, store, local?, timing?, log?, random? }) → Client   (platform-free)
  index.d.ts      the types of the Client, the ports, the answers
  ports.d.ts      Session, Connector, Store, LocalPort (below)
  core/           platform-free: manager.js, conn.js, calls.js, picture.js, test.js, sse.js, outcomes.js, text.js,
                  address.js, timing.js, list.js (validation and the List; no fs), routes.json, utf8.js, abort.js
  node/           the Node ports and today's entry:
    index.js      createNodeClient(options) — exactly today's createClient(options): stateDir, local, timing, log,
                  dial, roots — wiring nodeConnector({dial, roots}), fileStore(stateDir), nodeLocal(local)
    session.js    the Session over node:http2 (today's session.js)
    connector.js  the Connector over node:tls (today's tls.js + openSession)
    store.js      the Store over servers.json and client-id (today's file parts of list.js)
    local.js      this computer's server (today's local.js: Starter, LocalConn, ownerOp; child_process)
  test/           today's desktop/test/conn/* (moved), plus fakes/ and contract/ (AD-15)
```

- `desktop/main.js` and `web/dev/host.mjs` change one line each: `createClient` comes from
  `@aiwb/conn/node` (`createNodeClient`) with the same options. Their behaviour does not change.
- **Rule for `core/`**: no `require('node:…')`, no `Buffer`, no `process`, no `DOMException`, no
  `setTimeout(...).refresh()`, no `StringDecoder`, no `TextDecoder` (absent on Hermes): bytes are `Uint8Array`,
  text from bytes goes through `core/utf8.js` (a fatal UTF-8 decoder, as `TextDecoder('utf-8', {fatal: true})`), an
  aborted operation rejects with `core/abort.js` `abortError()` (an `Error` with `name === 'AbortError'`), a timer is
  re-armed by clearing and setting it. A test (`test/purity.test.js`) reads every file of `core/` and fails on any of
  these names. `[not verified]`: RN's `AbortController`/`AbortSignal` (`addEventListener(…, {once: true})`,
  `signal.reason`) behave as Node's for what `core/` uses; the native transport package (C4) runs the core's fake-port
  suite in the simulator once to prove it (AD-83).
- `local.js` stays Node-only. The Manager takes `local` as a **LocalPort** (`ports.d.ts`): `null` on a phone
  (goal 4.1: no "This computer" there), `nodeLocal({bin, home, env, run})` on the desktop and in the host. The
  Manager's `owner.*` operations go to the LocalPort. **Without a LocalPort every `owner.*` answers 404 `no_owner`**
  ("this app has no server of its own"); an operation the LocalPort does not know answers 404 `no_op` (revised after
  package C1, `core/manager.js`: kept, since "no server of its own" and "no such operation" are different answers).
  A phone screen that could call an `owner.*` operation does not show the action at all (goal 4.1).
- What the module does stays what it does: the same states, words, retries, waits, checks of an entry, route checks,
  body limits, picture byte check. Reconnect, back-off, silence and the too-old wait stay in `core/` (goal D9) and are
  lowered by `timing` (and `AIWB_APP_WAITS` on the desktop and the host) as today.

### AD-11 The ports, exactly `[proposed]`

`packages/conn/ports.d.ts` (the implementation packages copy these names):

```ts
/** A header map with lower-case names. */
export type Headers = Record<string, string>;

/** Why a request on a session got no usable answer. code: 'timeout' | 'reset' (the connection or stream ended) |
 *  'too_long' (above maxBytes) | 'closed' (the session is gone). Thrown by Session methods. */
export interface NetError extends Error { name: 'NetError'; code: 'timeout' | 'reset' | 'too_long' | 'closed' }

/** Why no session was made: an outcome of core/outcomes.js OUTCOMES (step 2 or 3, or 'not_aiwb' for a server that does
 *  not speak HTTP/2), its text, and for 'cert_changed' the presented and the pinned fingerprint; for 'fingerprint' the
 *  presented one. Thrown by Connector methods. core/outcomes.js exports the class (`Problem`). */
export interface Problem extends Error {
  name: 'Problem';
  outcome: 'refused' | 'name_not_found' | 'no_route' | 'local_network_denied' | 'tls_timeout' | 'not_https'
    | 'fingerprint' | 'cert_changed' | 'cert_name' | 'cert_expired' | 'self_signed' | 'cert_untrusted' | 'tls_error'
    | 'not_aiwb';
  detail: string; fingerprint: string; pinned: string;
}

/** The trust rule of a connection. selfSigned: accept by the pin (SHA-256 of the leaf's DER, upper-case hex pairs
 *  joined by ':') and by nothing else; otherwise by the platform's roots and the host name. */
export type Trust = { selfSigned: boolean; pin: string };

/** The body of a streamed answer, read as text. Chunks come in order; end comes once, after the last chunk, with an
 *  error when the stream did not end cleanly. cancel() ends it (no end callback after). */
export interface TextStream {
  onChunk(f: (text: string) => void): void;
  onEnd(f: (err?: NetError) => void): void;
  cancel(): void;
}

export type SendRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                 // path and query of the client API
  headers: Headers;             // the secret among them: only ever sent on a session whose trust was judged
  body: Uint8Array | null;
  signal?: AbortSignal;         // abort cancels the request (an AbortError)
  headersMs?: number;           // time for the answer's headers after the request was written (NetError 'timeout')
};

/** One session per server entry: every call, the stream and the pictures of that server go over it (HTTP/2). */
export interface Session {
  readonly fingerprint: string;   // of the certificate the trust accepted
  isClosed(): boolean;
  onClose(f: () => void): void;   // once, when the session ended for any reason (at once if it has)
  /** A request and its whole body. limitMs: the whole of it; maxBytes: the body's most (NetError 'too_long'). */
  fetch(r: SendRequest & { limitMs?: number; maxBytes?: number }): Promise<{ status: number; headers: Headers; body: Uint8Array }>;
  /** A request whose body is read as text as it comes (the event stream). Resolves at the headers. */
  stream(r: SendRequest): Promise<{ status: number; headers: Headers; body: TextStream }>;
  close(): void;                  // ends the session and every request on it
}

export interface Connector {
  /** A session to host:port whose certificate passed `trust`, after a TLS handshake that negotiated h2. Nothing is
   *  written to the server before the trust was judged, and the secret is never sent by open itself. Throws a Problem
   *  or an AbortError. A selfSigned trust with no pin throws Problem 'fingerprint' without dialing. */
  open(o: { host: string; port: string; trust: Trust; dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<Session>;
  /** The handshake that reads the server's certificate and sends no request: any certificate, its leaf's fingerprint. */
  readCertificate(o: { host: string; port: string; dialMs: number; handshakeMs: number; signal?: AbortSignal }): Promise<string>;
}

/** An entry of the server list as stored, secret included. */
export type StoredEntry = { id: string; name: string; address: string; secret: string; selfSigned: boolean; pin: string; instanceId: string };

/** Where the server list and the client id are kept. Synchronous: the List writes before it changes (as today). */
export interface Store {
  /** For the notice: "/…/servers.json", or "the app's storage". */
  readonly where: string;
  /** The saved list: null when none was saved; { version, servers } as saved (core/list.js checks every entry and
   *  refuses a later version). Throws when it cannot be read (the List then calls setAside). */
  read(): { version: number; servers: unknown[] } | null;
  /** Saves the whole list (version is core's FILE_VERSION) atomically, or throws and keeps the old one. */
  write(list: { version: number; servers: StoredEntry[] }): void;
  /** Puts an unreadable saved list out of the way; answers the name it now has (for the notice), or throws. */
  setAside(why: string): string;
  /** The app's id: a lower-case UUID v4, made once and kept. */
  clientId(): string;
}

/** This computer's server (desktop and test host only). The Manager makes its LocalConn with it. */
export interface LocalPort { /* today's Starter + ownerOp, unchanged; typed in local.d.ts by C1 */ }
```

- `core/sse.js` `EventReader.push(text)` takes **text** (the Node Session decodes with `setEncoding('utf8')`; the
  native module sends text, AD-31). Its limit counts characters, as it already does.
- Node's `Session.stream` is today's `send` with the body as a `TextStream`; `fetch` is today's `fetch` with the body a
  `Uint8Array` (a `Buffer` is one). `conn.js` `follow()` and `readSmall()` read a `TextStream`.
- The entry ids (`s_` + 12 hex) and nothing else use `random`: `createClient({random})`, default
  `globalThis.crypto.getRandomValues`.
- The outcome **`local_network_denied`** is new (step 2, "This app may not reach the local network: allow it in the
  system settings"; state `unreachable`, which retries): only a phone gives it (AD-34), the desktop never does. It is
  the one change of the outcome table (goal 4.7: a refused permission is a state the user is shown).

### AD-12 The kv port of the page `[proposed]`

`@aiwb/core/state/ports.ts`: `type Kv = { get(k): string | null; set(k, v): void; remove(k): void; keys(): string[] }`,
set with `setKv(kv)` before the store is read. Web (old page and web build): `localStorage`, same keys as today
(`aiwb.theme`, `aiwb.widths`, …; whatever the old page left in the same origin is read as the page would read it, it is
not migrated, goal 4.2). Native: one MMKV instance `aiwb.page` (synchronous). The keys stay the page's.

### AD-13 The phone's Store `[proposed]` (goal D11)

As built (revised after package C5): the logic is `app/src/platform/serverstorecore.ts`, `createServerStore({kv,
vault, randomUUID, now?})`, platform-free over two small interfaces (`StoreKv`: MMKV's own methods; `SecretVault`:
`get`/`set` synchronous, `delete` a promise) and tested on fakes under `node --test`; `serverstore.native.ts`'s
`serverStore()` gives it MMKV, `expo-secure-store` and `expo-crypto`'s `randomUUID`. It implements `Store`:
- secrets in `expo-secure-store` under `aiwb.secret.<entry id>` (`keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`);
- the list without secrets (`{version, servers: [{…entry, secret: ''}]}`) in MMKV instance `aiwb.servers`, key `list`;
- `read()` joins them; an entry whose secret is missing is returned with `secret: ''`, which `core/list.js` refuses
  as `bad_secret`, so the list is set aside with a notice (no silent loss);
- `write()` writes the secrets first (a secret that cannot be saved throws before the list is touched), then the
  list, then starts deleting the secrets of removed entries. `expo-secure-store` has **no synchronous delete**, so a
  deletion is started (`deleteItemAsync`) and the ids not yet deleted are kept, without secrets, under the MMKV key
  `pending-secret-deletes` and tried again at the next `read()` or `write()`;
- `clientId()`: MMKV `client-id`, made with `expo-crypto` `randomUUID` once (a saved one of the wrong form is made again);
- `where`: "the app's storage"; `setAside(why)` moves `list` to `list.unreadable-<UTC stamp>` (`-2`, `-3`… if taken)
  and answers that name.
- The `expo-secure-store` config plugin entry is AD-5's; C5 did not add it.
"A secret never leaves secure storage except to be sent to its server": the secret is read into the Manager's memory
(the Conn's target), as on the desktop, and goes nowhere but the `x-aiwb-secret` header; no secret is ever in an
`AppEvent`, a log line or a view (the module's rule today).

### AD-14 Timing stays in the shared code `[proposed]`

`core/timing.js` is today's file. The desktop and the host keep `parseAppWaits(process.env.AIWB_APP_WAITS)`. The
native transport passes `timing` from `EXPO_PUBLIC_AIWB_APP_WAITS` (inlined at build; empty in a release build), so a
device test can lower the waits the same way.

### AD-15 Tests of the shared code `[proposed]` (goal 7.2)

- `packages/conn/test/*.test.js`: today's `desktop/test/conn/*` tests, moved, with their requires retargeted; they run
  the Node ports against the stand-in server (`standin.js`) with fixture certificates, as today.
- `packages/conn/test/fakes/`: `fakeConnector({script})`, `fakeSession`, `memoryStore()`; a scripted server answers
  hello, the stream (text chunks, pings, silence), calls and pictures, and can refuse the secret or change its
  certificate.
- `packages/conn/test/core.test.js`: the cases of goal 7.2 on fake ports: retry intervals (with `jitter: 0`), a silent
  stream ending at `silence`, a refused secret ending the trying until the entry changes, a changed certificate
  (`certificate_changed` with both fingerprints), the stream starting with a snapshot, too old and its wait.
- `packages/conn/test/contract/`: one **port contract suite** (`runConnectorContract(makeConnector, server)`) that the
  Node connector passes against the stand-in, and the native module's JS adapter passes against its fake (AD-33). It is
  the statement of "the same pin rule and the same errors" (goal D10).
- `desktop/test/*` (ipcface, preload, faces, lib, closeflush, links, pickimages) stay in `desktop/` and keep passing;
  `faces.test.js` takes the client from `@aiwb/conn/node`.
- `node --test web/dev/host.test.mjs` and `web/dev/hostface.test.mjs` keep passing unchanged.

---

## 3. The native module `aiwb-net` (goal 4.6, D10)

### AD-30 Contract `[proposed]`

`app/modules/aiwb-net/src/AiwbNet.ts` declares the module's functions; the Swift and Kotlin code implement them; the
JS adapter `app/src/platform/net/nativeConnector.ts` turns them into the `Connector`/`Session` ports. Native code holds
**no app decision** (goal 6): it dials, does TLS with the trust rule, speaks HTTP/2 through the system stack, and
reports. Everything else (hello, levels, retries, timeouts, route checks, limits) is `@aiwb/conn`'s.

```ts
type NetErr = { kind: 'problem'; outcome: Problem['outcome']; detail: string; fingerprint?: string; pinned?: string }
            | { kind: 'net'; code: 'timeout' | 'reset' | 'too_long' | 'closed' }
            | { kind: 'aborted' };
// every function rejects with an Error whose `code` is 'AIWB_NET' and whose `info` is a NetErr

openSession(o: { host: string; port: number; selfSigned: boolean; pin: string; dialMs: number; handshakeMs: number }): Promise<{ session: string; fingerprint: string }>;
readCertificate(o: { host: string; port: number; dialMs: number; handshakeMs: number }): Promise<{ fingerprint: string }>;
fetch(o: { session: string; request: string; method: string; path: string; headers: Record<string, string>;
           body: Uint8Array | null; headersMs: number; maxBytes: number }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
stream(o: { session: string; request: string; method: string; path: string; headers: Record<string, string>;
            headersMs: number }): Promise<{ status: number; headers: Record<string, string> }>;
cancel(request: string): void;               // fetch rejects {kind:'aborted'}; a stream ends with no 'end' event
closeSession(session: string): void;         // every request on it ends: fetch rejects net 'closed', stream 'end' {code:'reset'}
localNetwork(): Promise<'granted' | 'denied' | 'unknown'>;
// events (Expo module events):
'chunk'   { request: string; text: string }        // the stream's body as text, in order
'end'     { request: string; error?: 'reset' }     // once per stream
'closed'  { session: string }                      // the session ended (a GOAWAY, the network, closeSession)
```

- **Text chunks** (goal 4.6): the native side decodes the stream's bytes as UTF-8 incrementally (it keeps an
  incomplete code point for the next chunk) and sends text. It coalesces bytes that arrive within 16 ms into one event,
  and never holds more than 64 KiB before sending: a stream held for hours keeps nothing on the native side but its
  decoder state `[not verified]` (goal 4.8; measured by hand, 7.5).
- `limitMs` and the AbortSignal are handled by the JS adapter (timers and `cancel`), `maxBytes` and `headersMs` by
  the native side (it cuts the body and rejects `too_long`; it rejects `timeout` when the headers are late).
- The binary body of `fetch` and its result are `Uint8Array` (Expo Modules `Data`/`ByteArray` ↔ `Uint8Array`).
  `[not verified]` for both platforms in SDK 57; the iOS/Android spikes report. **If not**: base64 strings in both
  directions (pictures are at most 5 MB, a scene upload at most 128 MiB: the latter would need chunking; the N1/N2
  packages then add `fetchToFile`). (Spike ios-net used base64 for bodies and did not try typed arrays: still
  `[not verified]`; N1 tries `Uint8Array` first and falls back as said.)
- **Typed options and errors** (revised after spike ios-net): the Swift and Kotlin functions take their options as
  Expo Modules `Record`s with typed `Field`s (the spike's untyped dictionary read every JS number as a `Double`, so
  `as? Int` was nil and limits were silently ignored), and reject with a coded exception whose `code` is `AIWB_NET`
  and whose info is the `NetErr` (the spike had to cut JSON out of a wrapped message text).

### AD-31 iOS implementation `[proposed]`, spike `rn-spike-ios-net`: **GO** (revised after spike ios-net)

The spike (`spikes/ios-net/`, report `spikes/ios-net.md`) proved on the simulator against a scratch server: the pin
rule with nothing written to a refused certificate (a tripwire server counted 0 bytes), `h2` with one connection
for calls and the stream, the size limit, the timeout, cancel, the stream as text chunks with a UTF-8 decoder that
holds back a cut character (every cut of a test string), and 20 minutes of streaming without growth (31 → 35 → 35 MB).
N1 starts from its `ios/AiwbNetModule.swift`. What it changes here is marked below; the rest stands.

- One `URLSession` per session id, ephemeral configuration (no cache, no cookies, no credential store,
  `httpMaximumConnectionsPerHost = 1` so that every request rides one HTTP/2 connection), its own delegate queue;
  `connectionProxyDictionary = [:]` (system proxies ignored, as Node's `net.connect` does) and
  `waitsForConnectivity = false`; request timeouts set long (the spike: a day), since every wait is the shared
  code's (AD-14).
- **URLSession retries an idempotent request on a dropped connection by itself** (the spike saw 9 attempts of a GET
  against a server that dropped it; POSTs were not retried) (revised after spike ios-net). The Conn's back-off must
  not be multiplied by it: a request the module was asked for once is reported once; N1 checks with a tripwire
  server how many attempts a dropped GET makes and states it in the module's README `[not verified]` whether it can
  be turned off for a task.
- **A silent stream is ended by a JS timer**, not by URLSession (its timeouts are a day): the spike proved a timer
  plus `cancel()` ends it and leaves the connection usable. That is `core/conn.js`'s `silence` already (AD-14);
  nothing native is added for it.
- Trust in `urlSession(_:didReceive:completionHandler:)` for `NSURLAuthenticationMethodServerTrust`: the leaf of
  `SecTrustCopyCertificateChain`, its DER's SHA-256 (CryptoKit) in the normal form; `selfSigned`: equal to the pin →
  `.useCredential(URLCredential(trust:))`, else `.cancelAuthenticationChallenge` and the session's problem is
  `cert_changed` (with both fingerprints); not selfSigned: `SecTrustEvaluateWithError` and the error classified as
  `cert_name` / `cert_expired` / `self_signed` / `cert_untrusted` (the Node order: name, then dates, then self-signed).
- `openSession` resolves only after a TLS handshake whose trust passed **and** whose protocol is `h2`. How: a probe
  `GET /api/hello` **without the secret or any app header**, whose answer is discarded and whose
  `URLSessionTaskTransactionMetrics.networkProtocolName` must be `h2` (else Problem `not_aiwb`). This sends a request
  after the trust was judged and before anything else, so the rule "nothing is written to a certificate that was not
  accepted" holds and no secret goes out. **The probe is required** (revised after spike ios-net): URLSession
  connects lazily, at the first request, so a session made without one cannot fail with `refused` or `cert_changed`
  by itself; the spike's `openSession` did not dial, and its report asks for exactly this. The probe's
  `networkProtocolName` is read from the task's metrics (a stream's metrics arrive only when it ends, so `h2` is
  judged on the probe, not on the stream).
- **The refused certificate is remembered per task** (per challenge), not per session (revised after spike ios-net:
  the spike kept one `mismatch` per session and blamed it on whichever task failed next).
- `readCertificate`: a session whose challenge handler records the fingerprint and **cancels** the challenge; the
  probe task's failure is expected; nothing is written.
- Errors: `NSURLErrorCannotConnectToHost` → `refused`; `NSURLErrorCannotFindHost`/`DNSLookupFailed` → `name_not_found`;
  `NSURLErrorTimedOut` before the handshake → `no_route`, during it → `tls_timeout`;
  `NSURLErrorSecureConnectionFailed` with a non-TLS answer → `not_https`, other TLS failures → `tls_error`;
  a path whose `unsatisfiedReason == .localNetworkDenied` (`NWPathMonitor`, iOS 14+) → `local_network_denied`.
  The mapping table is the module's README and is checked by the device test (AD-83) against a real server, and
  the fake (AD-33) implements the same table.
- `localNetwork()`: `granted` once a session to a private address opened, `denied` from the path monitor's reason,
  else `unknown`. The permission prompt is the system's, shown at the first connection to the local network
  (`NSLocalNetworkUsageDescription` says why, AD-5). (Not exercised by the spike: the simulator never prompts; a
  device check, goal 7.5.)
- **App Transport Security** (revised after spike ios-net): with a pinned self-signed certificate, a server reached
  by IP address or `localhost` works under Expo's default ATS, but one reached by a **dotted DNS name** (a Tailscale
  name, `host.example.com`, a VPN host name) fails in the TLS layer right after the delegate accepted the pin
  (`-1200` / `-9802`). Only `NSAllowsArbitraryLoads: true` **alone** fixes it: adding `NSAllowsLocalNetworking`
  (Expo's default has it) makes ATS apply again and breaks it; no trust-object trick (leaf as the only anchor,
  `SecTrustSetExceptions`) replaces the key. Decision and its bounds: AD-36.

### AD-32 Android implementation `[proposed]`, spike `rn-spike-android-net`

- One `OkHttpClient` per session id (its own `ConnectionPool(1, …)`, `protocols(HTTP_2, HTTP_1_1)`), with a trust
  manager of ours: `selfSigned` → an `X509TrustManager` that accepts exactly the leaf whose SHA-256 is the pin (and a
  `HostnameVerifier` that accepts the host, since the pin decides), recording `cert_changed` otherwise; not
  selfSigned → the platform's default trust manager and verifier, failures classified as on iOS.
- `openSession`: the same probe `GET /api/hello` without secret; `response.protocol` must be `h2` (else `not_aiwb`).
- The stream: `response.body.source()` read on a background thread, UTF-8 decoded with a `CharsetDecoder` that
  keeps a partial code point, coalesced as on iOS, sent as `chunk` events.
- Errors: `ConnectException` → `refused`; `UnknownHostException` → `name_not_found`; `SocketTimeoutException` in
  connect → `no_route`, in the handshake → `tls_timeout`; `SSLException` on a non-TLS answer → `not_https`, others
  `tls_error`. Android has no local-network permission (`localNetwork()` → `granted`).
- OkHttp is the one React Native already ships; the module uses it, not a second copy.

### AD-33 The fake and the contract tests `[proposed]` (goal 6: "a native module has a contract, tested against a fake")

- `app/modules/aiwb-net/src/fake.ts`: `createFakeAiwbNet(server: ScriptedServer)` implements the module's API in
  JS with the same error table; `ScriptedServer` is `packages/conn/test/fakes`' scripted server.
- `app/src/platform/net/nativeConnector.test.ts` runs `runConnectorContract(() => nativeConnector(fakeModule), …)`
  under `node --test`: the adapter plus the fake pass the same contract as the Node connector.
- The real module is checked on simulators/emulators against a real Go server (AD-83, goal 7.4).

### AD-34 Local network permission `[proposed]` (goal 4.7)

A connection refused by the permission ends as `local_network_denied` (AD-11), so the section and **Servers** show
it in the module's words; the phone's add-server screen (S-phone package) says before the first connection why the
system will ask, and on `local_network_denied` shows the way to the system settings (`Linking.openSettings()`).

### AD-35 If a network spike fails `[not verified]`

If a trust hook in the system's network stack cannot pin with HTTP/2 and a long text stream, goal section 9 says the
rewrite is **reconsidered, not worked around quietly**: the orchestrator stops the native tracks (N, C4, C5, the
device tests) and asks the user. The web build and the desktop app do not depend on it and go on.
(iOS: GO, AD-31. Android: the spike is still running.)

### AD-36 ATS off on iOS, and "no plain HTTP" enforced by the app's code `[proposed]` (new, after spike ios-net)

**Decision**: the iOS app sets `NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }` and nothing else in that
dict (AD-5). Reasons: the goal's servers are the user's own, reached by whatever name the user gives, and a dotted
name cannot be reached any other way (AD-31); there is no store distribution (goal D13, §10: the app is installed by
the user's own script), so App Store review's demand for a justification does not apply; the narrower
`NSExceptionDomains` cannot list names the user has not typed yet. What ATS was guarding is then the app's own
duty, and the goal's bound "no plain HTTP" is kept **by the code**, checked by tests, not by the system:

1. **One way out.** The only code of the app that opens a connection to a server is `aiwb-net` (AD-30). Its contract
   has no scheme: it takes a host, a port and a path, and the Swift and Kotlin code build the URL with the literal
   scheme `https` in **one** function each (`httpsURL(host, port, path)`), which also refuses a host that holds `/`,
   `@`, `?` or `#`. A plain HTTP listener is refused as `not_https` (AD-31, checked by the contract suite, AD-33).
2. **No other networking in the app's JS.** `app/test/noplainhttp.test.ts` (N1 writes it) reads every file of
   `app/src/` and `app/modules/*/src/` (not `dev/`) and fails on a call of `fetch(`, `new XMLHttpRequest`,
   `new WebSocket`, `new EventSource`, and on any `http://` text outside comments; it also reads the Swift and Kotlin
   sources of `app/modules/` and fails on `http://` and on any `URL(string:`/`URL(` other than the one function of
   point 1. `@aiwb/conn`'s `core/` already holds no network code (AD-10's purity rule).
3. **Images**: RN `<Image>` is given only `file://` addresses of the picture cache (AD-25) and bundled assets;
   `Picture.native` draws the broken tile for an address of any other scheme (C4 adds this to U2's shell and tests
   it).
4. **The board's web view** reaches nothing: its CSP has `connect-src 'none'`, `default-src 'none'` (AD-51), and the
   host refuses every navigation but its own page (AD-52).
5. **The config**: `app/test/appconfig.test.ts` (N1) loads `app.config.ts` and asserts the iOS ATS dict is exactly
   `{NSAllowsArbitraryLoads: true}` (so a later edit that adds `NSAllowsLocalNetworking` back, which breaks dotted
   names, fails a test); Android keeps cleartext off (AD-5).
   Core's `transport/http.ts` (fetch and EventSource to the test host, same origin) is in the native bundle but is
   chosen only for a page loaded over `http:`; `wayOf()` answers `native` first on React Native (AD-20).
6. **Development builds** talk to Metro over plain HTTP on the Mac; that is the dev client's own loading, not the
   app's code, and a release build (the install script, §10) has no Metro.

`[not verified]`: a physical device behaves as the simulator here (the spike ran only on the simulator); the first
device install (goal 7.5) connects to a server by a dotted name and says so in the report.

---

## 4. Transports (goal 4.6, D8, D12)

### AD-20 The interface `[proposed]`

`@aiwb/core/transport/types.ts` keeps today's `Transport` with three changes, each proved by `transport.test.ts`:

```ts
readonly way: "ipc" | "http" | "native";
/** The address of a picture, given when it can be shown: at once on ipc and http, after the fetch on native (D12). */
picture(server: ServerId, chat: string, image: string, signal?: AbortSignal): Promise<string>;
/** Today's synchronous address: ipc and http only, kept for the old page until retirement, then removed. */
pictureURL?(server: ServerId, chat: string, image: string): string;
/** Picking images: the desktop's own dialog (ipc), the device's picker (native); absent on http (the page's file input). */
pickImages?(): Promise<DesktopPick>;
```

- A screen of the app never asks for an address itself: it renders `<Picture chat image />` (AD-25), which asks
  `transport().picture(...)` and shows a placeholder until the promise resolves; so no screen knows the platform.
  The old page keeps calling `imageUrl()` (sync, `pictureURL`) and does not change; the app uses
  `imageAddress(chat, id): Promise<string>`, added beside `imageUrl` in `logic/chatimage.ts` (an addition to a moved
  file; package C6).
- `wayOf()` in `transport/index.ts`: `native` when `navigator.product === "ReactNative"`; else `ipc` when the window
  has `aiwbTransport` (the new bridge) **or** `aiwbApp` (the old one, until retirement); else `http` when loaded
  over `http:`; else none.
- The transport is set once at start by the client (`useTransport(t)` exists already); on native the app calls
  `useTransport(nativeTransport(client))` before `connect()`. On the web build (revised after package C3)
  `app/src/platform/transport.web.ts` (U3 writes it; C4 writes only the `.native` one) does what core cannot: core's
  purity scan forbids `window.` in `@aiwb/core` (`packages/core/test/seams.test.ts`), so `desktopTransport(bridge)`
  has **no default bridge** and the app passes it: way `ipc` with `window.aiwbTransport` →
  `useTransport(desktopTransport(window.aiwbTransport))`; way `http` → `httpTransport()`; no way → the "runs in its
  app" screen (AD-76).

### AD-21 The native transport `[proposed]` (goal 4.6: in-process, nothing between)

`app/src/platform/transport.native.ts`, `nativeTransport(client)` with `client = createClient({connector:
nativeConnector(AiwbNet), store: nativeStore(), local: null, timing})`:

- `call(req)` → `client.call({...req, body: bytes})` directly, the `AbortSignal` passed through (no id, no
  serialization); a `Blob` body is turned into a `Uint8Array` first.
- `stream(onEnvelope, onState)` → `client.subscribe(onEnvelope)`; `onState("open")` at once; `close()` ends the
  subscription. There is no batching and no queue: envelopes are delivered as the Manager emits them. A subscription
  ended by the transport itself (the app going to the background, below) reports `closed`, and the page opens it again
  as it does today.
- `app(op, args)` → `client.app(op, args)` → `{status, text: JSON.stringify(body)}` (what `ipcface.js` does).
- `picture()` → AD-25 (no `pictureURL`). `pickImages` → AD-26.
- **Background** (goal 4.8): on `AppState` `background` nothing is done (the system may suspend; streams may end);
  on `active` the transport calls `client.wake()` — a new Client method (C4 adds it to `@aiwb/conn`) that makes every
  connection in its back-off try now (`retryIfBackingOff` on each), so the sections fill again as when the app opens.
- No `x-aiwb-*` header, no secret and no path check happens here: the Client does all of it, as in the main process.

### AD-22 The desktop bridge builds the transport `[proposed]` (goal 4.6, 4.10; spike `rn-spike-electron`: go)

What the spike measured in Electron 44 (sandboxed preload): an `AbortSignal` arrives in the preload as `{}`; functions
cross as proxies both ways and can be kept and called later; an `Error` loses its name and keeps only its message; a
`Uint8Array` is copied at about 50 MB/s while an `ArrayBuffer` or a `Blob` takes tens of milliseconds (and a view drags
its whole buffer); generators, `ReadableStream` and `MessagePort` do not cross; a sandboxed preload can require only
`electron`, so it is **one file**.

- `desktop/preload.js` exposes `window.aiwbTransport` (beside `window.aiwbApp`, which stays for the old page until
  retirement), as the spike's `spikes/electron/bridge/preload.js` builds it:

  ```js
  aiwbTransport = {
    way: 'ipc',
    call({ server, method, path, body?, abort }),   // body: {json} | {bytes: ArrayBuffer | Blob, type}; → {status, text, sceneRev}
                                                    // abort: { aborted: boolean, listen(cb) → off } made by the page
    stream(onEnvelope, onState),                    // subscribes, unbatches 'aiwb:events', forwards 'aiwb:stream-state'; → {close()}
    picture(server, chat, image),                   // → Promise<'aiwb-picture://p/…'>
    app(op, args), pickImages(),
  }
  ```

  The preload makes the call's identifier (`crypto.randomUUID()`, never seen by the page), registers its own callback
  through `abort.listen`, and on abort sends `aiwb:cancel {id}` once (not when already aborted, not after the call
  ended) and rejects at once. It reads a `Blob` body into bytes, builds the IPC request, unbatches the events, and makes
  the picture address: all translation to IPC messages is there, plain sandboxed JavaScript (goal 8). If it ever shares
  code with the app it is bundled into one file; today it is hand-written, as in the spike.
- **The page-side adapter** `@aiwb/core/transport/desktop.ts` (`desktopTransport(bridge)`, about 25 lines, the spike's
  `bridgeTransport.ts`; the bridge is always the caller's argument, with no `window` default, revised after package
  C3, see AD-20): checks `signal.aborted` first, hands over `abort = {aborted, listen}` built on the real
  signal, passes a `Blob` as it is and a `Uint8Array` as its own `ArrayBuffer` (a view cut first), and turns the plain
  `Error`s of the bridge into the transport's errors: `abortError(signal)` when the signal aborted (so the rejection
  is the signal's own reason), else `TransportError(message)`. Error names do not cross, so nothing tests
  `e.name` on what the bridge returns before the adapter has made it. This is the correction the spike made to the
  goal's wording: the bridge builds the transport **except** for the signal and the error classes. The old page's
  `transport/ipc.ts` is deleted at retirement.
- The main process and `ipcface.js` do not change: same channels, same checks (sender frame, op list, body shapes).
- Tested with a fake `ipcRenderer` and a model of `contextBridge` in `desktop/test/preload.test.js` and an end-to-end
  test of adapter → bridge → the real `createIpcFace` (the spike's `test/endtoend.test.mjs` is the template) (goal 7.3:
  "the window's bridge is tested with a fake IPC renderer, not by the page's tests").

### AD-23 The HTTP way and the mock `[proposed]`

`transport/http.ts` and `web/dev/{host,hostface,mock}.mjs` stay as they are (goal 4.2), with `picture()` added (it answers the address at once).
The host and the mock serve any built client: `--dist`/`DIST` points them at the web build's export folder (AD-42).

### AD-25 Pictures `[proposed]` (goal 4.6, D12)

- `<Picture server chat image style />` in `app/src/platform/picture.*.tsx`:
  - web: `<img loading="lazy">` (a DOM element in a `.web.tsx` file) with the address the transport gives at once,
    so the browser's lazy loading and cancelling stay as the client goal has them in the desktop app;
  - native: `const uri = await imageAddress(chat, image)` then RN `<Image source={{uri}}>`.
  - both get the address through a **registered seam** (revised after package U2): `picturecommon.tsx` holds
    `setPictureAddress(fn)` with `fn: (server, chat, image, signal?) => string | Promise<string>`, and `pictureAddress()`
    that the two shells call; with nothing registered a shell draws the broken tile. The app shell (U3, AD-76)
    registers `(s, c, i, signal) => transport().picture(s, c, i, signal)` once the transport is set (on web it resolves at once to
    `aiwb-picture://…` (ipc) or `/host/picture/…` (http); on native after C4's `pictureFile`). `<Picture>` also takes
    `uri` (an address drawn as it is: the gallery, a picture still uploading) and `name` (alt text, the broken
    tile's words). `imageAddress(chatKey, id)` of `logic/chatimage.ts` (C6) stays for code that holds a chat's key rather than its server.
  - (integration sweep, D-PC-08) native `<Picture>` passes a signal and aborts it when it unmounts or its address changes
    before the bytes came (`platform/pictureask.ts`); the web passes none (the browser drops the `<img>`). Native
    `picture()` shares one fetch per (server, chat, image) among its callers and aborts it, down to the session or out of
    the queue of eight, only when no caller is left; it rejects with the signal's own reason, and nothing is cached for
    an aborted fetch (`app/test/transport.native.test.ts`).
- Native `picture()`: `client.picture({server, chat, image, signal})` (which fetches over the pinned session and
  checks the bytes: PNG/JPEG/GIF/WebP, at most 5 MB, at most 8 at a time per server — today's `picture.js`), then the
  bytes are written to `Paths.cache/aiwb-pictures/<server>/<image id>` (the image id is the SHA-256 of the bytes, so a
  file there never goes stale) and the answer is its `file://` URI. A file already there is answered without a fetch.
  A refusal rejects with the answer's status, and `<Picture>` shows the broken state the web build shows for a failed
  `<img>`. The cache folder is the system's (it may be cleared by the system); nothing else of a server is kept.

### AD-26 Picking images `[proposed]`

- desktop (ipc): today's `pickImages` (the app's own dialog), through `aiwbTransport.pickImages`.
- native: `expo-image-picker` `launchImageLibraryAsync({mediaTypes: ['images'], allowsMultipleSelection: true,
  quality: 1})`; each asset's bytes read with `expo-file-system`; answered as `DesktopPick` (`{files: [{name, type,
  data}], skipped: [{name, reason}]}`) with the same checks as `lib.js` `pickImages` (type from the bytes, 5 MB); the
  composer's checks (`logic/chatimage.ts`) then apply as for every way in.
- http (headless browser): no `pickImages`; the attach button uses a file `<input>` (a `.web.tsx` primitive), and a
  paste of an image works as today.
- The share sheet (goal 4.2 "drops … become … the share sheet"): receiving images shared from other apps is **not**
  built in Part A (no share extension); dropping files on the desktop window keeps working on the web build.

---

## 5. The web build in the Electron window (goal 4.1, D2, D15)

### AD-40 How it is built `[proposed]`

`cd app && npx expo export --platform web --output-dir dist-web` with `web.output: "single"` (one `index.html`,
no server rendering) and `EXPO_PUBLIC_AIWB_VERSION` for the build's version (today's `AIWB_VERSION`/`__APP_VERSION__`;
`pageVersion()` reads it). `app/public/index.html` is the template: today's `web/index.html` head, icons, and
`<div id="root">`; the theme set before the first paint (from `localStorage "aiwb.theme"`, same rule) is the file
**`public/theme-init.js`** loaded by a `<script src>`, since the CSP allows no inline script (revised after package
F1); its test runs that file against `logic/theme.ts`. `app.config.ts` sets **`experiments.baseUrl: "."`**, so the
export names its bundle, its lazy chunks, its assets and its fonts relative to the page (AD-41). A post-export step
(`app/scripts/export-web.mjs`) adds the CSP of AD-41 as a `<meta>` and the `<script>` of the bundle to `index.html`.
`npm run build:web` in `app/` runs it all. Icons are imported one set at a time, never the `@expo/vector-icons`
barrel (the barrel puts 4.3 MB of fonts into the export); the app uses `react-native-svg` icons anyway (AD-3).

**How the web build gets Excalidraw** (revised after package B2). B2 found that letting Metro bundle Excalidraw
(through `BoardView.web.tsx`) does not fit the web build: Metro resolves `@excalidraw/excalidraw/index.css` only with
`"production"` in `resolver.unstable_conditionNames`; the export then has about 127 chunks (runtime, common, entry,
every locale, Mermaid…), which breaks `export-web.mjs`'s one-bundle step; Expo writes the CSS separately and the
page does not link it; Excalidraw's `@font-face` for Assistant resolves relative to `_expo/static/css/` and 404s;
and Metro bundles the locales and Mermaid that board-view's esbuild build drops. **Decision: Metro never bundles
Excalidraw.** The web build loads **board-view's own esbuild build of it**, the same build (same `slim` plugin, same
Excalidraw, same endpoint) as the web view's page:

- `@aiwb/board-view` `npm run build:web` (B6, packages.md) writes its **web target** into `app/public/board/`
  (generated, git-ignored): `board.js` (an IIFE that defines `window.aiwbBoardView = { mount(element, post, options)
  → { receive(m), unmount() } }`, carrying Excalidraw, its own React and the endpoint), `board.css`, `fonts/`
  (Xiaolai left out). `EXCALIDRAW_ASSET_PATH` is the folder `board.js` was loaded from (`./board/`).
- `app/public/index.html` has `<link rel="stylesheet" href="./board/board.css">` and `<script src="./board/board.js"
  defer>` before the app's bundle, so Expo copies them into the export and the dev server serves them too. The
  page loads Excalidraw at start, as today's page does (it is in `web/dist`'s one bundle today).
- `app/scripts/export-web.mjs` runs board-view's `build:web` before `expo export` (so a stale board never ships), keeps
  its one-bundle check for the app's own bundle, and no longer copies Excalidraw's fonts into `dist-web/fonts/` (they
  are in `dist-web/board/fonts/`).
- `app/src/platform/board.web.tsx` renders a `View`, takes its DOM element, and calls `window.aiwbBoardView.mount`
  with an in-process `post`; messages are objects passed in-process, validated both ways as on native. The types of
  that global are in a board-view module with no Excalidraw import (`src/web/api.ts`), so the app's type check never
  reads Excalidraw's sources. `app/metro.config.js` gets **no** `unstable_conditionNames` change.
- Cost: the web build carries a second React (about 60 KB gzipped) inside `board.js`; the two React roots share
  nothing but the DOM element. Gain: one Excalidraw build for all four targets, so every board check of the web
  build tests the bytes the phone runs, and the web build stays one app bundle under a strict CSP.

### AD-41 How the window loads it `[proposed]`, spike `rn-spike-electron`

- Exactly as today: `win.loadFile(pagePath)`, a `file://` URL; `pagePath` default becomes
  `resources/web/index.html` (packaged) and `../app/dist-web/index.html` (from a checkout) at the switch (package D2);
  `AIWB_PAGE` still picks another page.
- Proved by the spike: an Expo SDK 57 export loads from `file://` **only with `experiments.baseUrl: "."`**; with the
  default absolute `/_expo/…` paths the window is blank and `did-fail-load` does not fire. So `main.js` also reports a
  **blank page** (the page did not set `window.aiwbReady` within 10 s of `did-finish-load` → today's error dialog). The
  app-owned scheme the spike also tried is **not** used: the client goal keeps the app's own scheme for pictures only
  `[user]`, and the app has no path routing that would need it (AD-3, AD-71).
- **CSP** (new: the page has none today), as a `<meta>` in the export's `index.html`: `default-src 'none'; script-src
  'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:; font-src 'self' data:;
  connect-src 'none'; base-uri 'none'; form-action 'none'`. `style-src 'unsafe-inline'` is required (react-native-web
  inserts its style sheet at run time); no `eval`, no inline script, no WebAssembly. `connect-src 'none'` was not tried
  by the spike `[not verified]`: Excalidraw in the page must work under it (D1 checks; if it needs `'self'` for its
  fonts, that is the one widening). B2's harness ran the in-page view under this CSP with no violation, and the
  board spike's page ran under a stricter one (AD-51) (revised after package B2 and spike board-webview); the
  `./board/` files of AD-40 are `'self'`.
- The export holds a folder `assets/node_modules/…` when a dependency ships font assets. `[not verified]` that
  electron-builder's `extraResources` copies a folder named `node_modules`: package D2 checks the packaged app.
- The window keeps everything it has today around the page: `aiwbFlush` (the page sets `window.aiwbFlush` as
  `main.tsx` does), link handling, close/quit waiting for unsaved drawing, the picture scheme (the web build's
  `<Picture>` uses `<img src="aiwb-picture://…">` as today), single instance, window state.

### AD-42 The test host and the mock drive the web build `[proposed]`

The host and the mock serve a folder (`--dist`, `DIST`): pointed at `app/dist-web`, the web build runs over HTTP
in the headless browser exactly as the old page does (absolute `/_expo/…` paths are fine over HTTP; the rewrite to
relative paths of AD-41 work over HTTP too). `web/dev/shot.mjs` gets `buildAppDist()` beside `buildDist()`: it runs
`npm run build:web` in `app/` once per `uicheck` run into a temporary folder, with
`EXPO_PUBLIC_AIWB_VERSION=uicheck` (the page shows no update notice on version "dev", as today).

### AD-43 The old page keeps building `[proposed]` (goal D15)

Until retirement (§10): `web/build.mjs`, `web/dist`, `npm run uicheck` (old checks), `web/e2e/*` on `web/dist`, the
desktop app's default page and `scripts/build-app.sh` stay as they are; the old page is built from `web/src` +
`@aiwb/core`. Every change to `@aiwb/core` keeps the old page's `npm test`, `npm run check` and the checks of the
area it touched passing. The desktop app switches to the web build in one package (D2) once its parity is shown. (done in D2: `pagePath`'s default is `app/dist-web` and the packaged `Resources/web`, `scripts/build-app.sh` builds the web build, `AIWB_PAGE=web/dist/index.html` still loads the old page until R1; the app's `file://` window with a `node_modules` folder among the assets was checked in the packaged app.)
- (integration sweep) Defects found in the old page while the new one was built are not fixed there unless a check of
  the old page needs it: the old folder browser (`web/src/Composer.tsx`) keeps the race of a late listing that the new
  one was fixed for (`screens/composer/Folder.tsx`, L16); R1 deletes it.

### AD-44 The desktop app's tests on the web build `[proposed]` (goal 7.3, 6)

`desktop/e2e/app.e2e.mjs` takes the page from `AIWB_PAGE` (default `web/dist/index.html` until the switch, then
`app/dist-web/index.html`) and observes through `window.aiwbTransport` (new) as it does through `window.aiwbApp`
today. Its assertion that `window.process` is undefined becomes "Node's process is not there"
(`window.process?.versions === undefined`): the Metro bundle puts an `{env}` shim at `window.process`. It checks the page over IPC with a call, a stream that is cut and comes back, a picture from the app's own scheme from a
self-signed server. It must pass on the web build before the switch (goal 6: "the desktop app is released from the
web build only when the desktop app's own tests pass with it").

---

## 6. Screens (goal 4.2, 4.3, 4.4)

### AD-70 Rebuilt from the same parts, in RN primitives `[proposed]`

- Every component of `web/src/*.tsx` gets a counterpart in `app/src/screens/<area>/` with the **same behaviour and
  the same words** (the strings move with the component; the logic they call is `@aiwb/core`'s, unchanged). The
  parity inventory (`parity-inventory.md`) is the list of what must hold; the package of a screen names its rows.
- Primitives only from `app/src/ui` and React Native: `View`, `Text`, `Pressable`, `TextInput`, `ScrollView`,
  `Image`, `Modal`. A `.web.tsx`/`.native.tsx` split is allowed only in `app/src/platform/` (ports) and
  `app/src/ui/` (primitives), never in `screens/` (goal 6: "no copy of a screen per platform").
- **Popups**: one primitive `Overlay` decides by the layout (AD-72): on the wide layouts an anchored `Popover`
  (menus, the "+" menus, the insert popup, the theme menu, the usage popup) or a centred `Dialog` (Servers, the
  library, the confirm dialog, the tree popup); on the phone layout every one of them is a bottom `Sheet`. The words,
  items, order and keyboard handling inside are the same component.
- **Hover** actions (a message's actions, a row's menu button) show on hover with a mouse (`Pressable`
  `onHoverIn`), and always (or on a long press for row menus) with touch: the component reads `usePointer()`
  (`"mouse" | "touch"`, from the last pointer event on web and `"touch"` on native).
- **Drag and drop** (sidebar rows and groups, today HTML drag events with the drop mark of `logic/dropmark.ts`): a
  gesture-handler Pan that starts at once with a mouse and after a long press (300 ms) with touch; the drop target
  and the mark are computed by the same `logic/dropmark.ts`. Dropping image files onto the desktop window stays a
  web-only handler in `platform/`.
- **Resizer**: a Pan gesture on the pane edge, desktop and tablet; widths in the store as today
  (`aiwb.widths`).

- **Overlays over overlays, the keyboard, secrets** (P1, `p1-sheets-keyboard.md`): an overlay that opens while another is open draws its `Modal` inside the
  topmost one (`ui/overlayhost.tsx`; iOS cannot present a second `Modal` beside an open one); `Sheet` and `Dialog` keep the focused box above the on-screen keyboard
  (`ui/useKeyboardAvoid`), and a sheet keeps its `DialogActions` below its scroll view on native; a secret box is `ui/SecretInput` (on iOS a box of our own showing
  bullets, since any hidden iOS box is offered to the keychain as a password).
  (integration sweep) A native `Popover` is placed in the part of the window the keyboard leaves (`ui/placement.ts` `covered`): an `up`
  popover whose anchor is under the keyboard rises to its top, one that does not fit gets the height left and scrolls (the model picker
  and the folder browser on an iPad; the `sheets` flow on an iPhone and an iPad, Android not yet run). The iOS secret box's caret
  moving to the end (P1) did not reproduce on iOS 26.3 with React Native 0.86; `maskededit` answers the caret after each edit all the
  same. Copying out of that box gives the bullets, by design (a hidden secret is not copied out, as from a password field).
- **The overlays' focus on web** (integration sweep): `Popover`, `Dialog` and `Sheet` are drawn in `ui/modal.web.tsx`, not in
  react-native-web's `Modal`, whose focus trap pulled any focus that landed outside it back in and, on its way out, focused whatever
  had the focus when it opened (so a field a menu opened lost the focus, and screens worked around it with timers). The rule is the
  old page's: an overlay that opens takes the focus (what the screen autofocuses, else its first focusable); Tab and Shift+Tab cycle
  inside the top overlay only; when it closes, the focus goes back to the control that opened it only if the focus is still inside the
  overlay or nowhere (a field a screen focuses as a menu closes keeps it); if that control is gone, to the control that opened the
  overlay it was in, then to a popover's anchor. No screen waits for an overlay to be gone. Native keeps RN's `Modal`. Check `L21`.
- **Esc, one layer at a time** (integration sweep, B-SA-16): popups that are not `Overlay`s (the composer's @ list, the quote float,
  the inline name fields) take Esc through `ui/useEscLayer` (web), which gives them a place on the overlay stack: one Esc closes the
  innermost thing (the @ list, then the float, then the drawer), and Esc in a busy chat's composer with nothing open stops it.
- **The focus ring** (integration sweep): the old page's 2 px accent ring on `:focus-visible` of the rail's controls, menu items and
  chips is back on the web build (`ui/focusring.ts`, the theme's accent); other controls keep the browser's ring, as on the old page.

### AD-71 Navigation follows the store `[proposed]`

What is on screen stays what the store's `sel` (`{board, chat}`), `panel`, `sideHidden`, `subDrawer` and
`treeNav` say, as today; screens set them through the actions they use today (`select`, `openChat`, …).
- **Wide layouts**: one screen, the split view of today's `App.tsx` `Grouped` (sidebar pane, board stage and its chat
  panel, or the chat page, or home), rebuilt in RN.
- **Phone layout**: a React Navigation native stack whose routes are **derived from the store** by a pure function
  `stackOf(state) → ["side"] | ["side", "board"] | ["side", "board", "chat"] | ["side", "chat"]` plus overlays
  (subagent drawer as a pushed screen, Servers, library and tree as sheets). A back gesture/button sets the store
  (`select` with the chat or board cleared), never the other way round. On a phone a board chat opens over its board
  (so the board's host stays mounted beneath, AD-52).
- (integration sweep, D-SL-10/11) **A point on the phone.** "Point at" (and ⌘⇧L) goes to the board with the wait kept
  (`screens/board/refs.ts` `startPick(chat, away)`); the pick layer and its hint show there. A tap, Cancel, Esc, ⌘⇧L and the
  stack's back end the wait (`pickPoint(null)`) and open the chat again; the board screen's swipe is off meanwhile. A reference made
  while the chat's box is not mounted is held per chat (module state of `refs.ts`, app-only) and put in when the composer mounts, at the
  caret the box had. The composer's unmount ends a wait, except the phone's. `P7.4-board` at the three viewports.

### AD-72 Width breakpoints `[proposed]` (goal 4.4, D6)

`app/src/ui/breakpoints.ts`: `layoutOf(width) = width < 700 ? "phone" : width < 1100 ? "tablet" : "desktop"`, from
`useWindowDimensions()`, on every target (a narrow browser window is the phone layout).
- `phone`: the stack (AD-71); sheets; no resizer; the sidebar is the first screen.
- `tablet`: the split view; the sidebar starts hidden when the width cannot hold sidebar + chat + board at their
  minimum widths (`logic/layout.ts` minimums), and shows as an overlay pane; board and chat side by side
  (goal 3.5); resizer by touch.
- `desktop`: today's layout and behaviour, all of it (goal 4.3: the desktop is not worse).
- Part B (goal 11) redesigns these three on purpose; nothing here ties a screen to a platform, so Part B changes
  arrangements in `screens/` and the breakpoints, not the logic.

### AD-73 Keyboard shortcuts `[proposed]`

- Today's shortcut logic (`logic/keys.ts`, `layout.ts isSideKey`, `newchatwhere.ts isNewChatKey`, `insert.ts
  isInsertKey`, `treepopup.ts`) takes a KeyboardEvent-like `{key, code, metaKey, ctrlKey, shiftKey, altKey,
  repeat}`; that is the shape of the **keys port** `onKey(handler) → off` in `app/src/platform/keys.*.ts`:
  - web: `window.addEventListener("keydown", …, true)` as today (the capture order of today's handlers is kept);
  - native: the Expo module `aiwb-keys`: on iPadOS `UIKeyCommand`s registered on the root view controller for the
    shortcuts the page has (⌘N, ⌘B, ⌘J, ⌘L, ⌘⇧L, ⌘P, ⌘⇧B, Esc, ⌘Enter where the page has it) and on Android
    `dispatchKeyEvent` of the activity for the same with Ctrl; each emits the KeyboardEvent-like object.
- Inside the composer, Enter/Shift+Enter and the chip keys are the chip input's (AD-60).
- Shortcuts that make no sense on touch (hover-only) are not invented on phone; a tablet with a hardware keyboard
  has the same set as the desktop where its screen has the action (goal 4.4).
- (integration sweep) **Android: no shortcut reaches the app while an overlay is open.** An overlay is an RN `Modal`,
  which Android draws as a `Dialog` window of its own; the activity's `dispatchKeyEvent` does not see its keys (V2,
  measured). Accepted: Escape (the system's Back) still closes the overlay, and the shortcuts that matter under an
  overlay are none (the desktop page holds ⌘B and ⌘N to do nothing under a dialog, A1.4). iPadOS and the web build
  are not affected.

### AD-74 Theming `[proposed]` (goal 4.2)

- `app/src/ui/tokens.ts`: for each theme (`light`, `dark`) and flavour (`latte`, `frappe`, `macchiato`, `mocha`) the
  same variables `web/src/styles.css` and `flavours.css` define today, as a map `{name: colour}`; components read them
  with `useTokens()`. A test parses the two CSS files and asserts the tokens equal them, so the colours are the same.
- Theme choice, resolution and storage stay `logic/theme.ts`/`logic/flavours.ts` (core) and `aiwb.theme` (kv); on
  web the pre-paint script stays, as the file `app/public/theme-init.js` (revised after package F1: the CSP forbids
  an inline script); native follows `Appearance` for "system".
- **The canvas filter** (`logic/canvastheme.ts`, the SVG filter of the board, architecture "the canvas follows the
  theme as a view of the board"): the filter's definition is computed in core as today and sent to the board view
  in the `theme` message (AD-50); `@aiwb/board-view` renders `CanvasFilters` inside its own document (the page's on
  web, the web view's on native) and sets Excalidraw's `--theme-filter` to it, as the page does today. The board file
  keeps Excalidraw's default colours.
- **The chrome of Excalidraw** (toolbar, panels, menus, dialogs; revised after package B7): in a flavour the `theme` message also
  carries `chrome`, a map from a closed list of custom properties (`@aiwb/board-bridge` `chrome.ts` `CHROME_VARS`: the ones
  `web/src/flavours-canvas.css` sets, plus `--aiwb-line` and `--aiwb-faint`) to `#rrggbb` colours, validated (an unknown name or
  another form of value is refused: nothing else can ride into the page's style). Core makes it from the flavour's tokens and
  palette (`logic/canvaschrome.ts`); `@aiwb/board-view` `theme.ts` `chromeCss` lays it over `.excalidraw` (same weight as the
  filter's rules) with the few fixed rules a property cannot say (the islands' ring, a shortcut's colour). `app/test/canvaschrome.test.ts`
  parses `flavours-canvas.css` and holds the map to it per flavour; plain light and dark send `null` (Excalidraw's own).

### AD-75 Markdown, code and long chats `[proposed]` (goal 4.2, 4.8)

- `app/src/screens/markdown/`: `parse(text) → mdast` (remark, as today), `Markdown` renders top-level blocks as
  separate memoized components keyed by their source text, so a growing answer re-renders only its last block.
- Code blocks: lowlight tokens → `Text` spans with token colours from the tokens; the code header (language, Copy) as
  today; long lines scroll horizontally.
- The thread is a `LegendList` with `maintainScrollAtEnd` while the user is at the end, and the position kept when
  the user scrolled up (today's behaviour, parity rows of area B).
- **Displayed text** (for quotes, AD-64): the renderer exports `displayedText(mdast)`, the text leaves in order
  without code headers — the same string `quoteDom.ts` reads from the DOM today — so a quote's stored position means
  the same on every target.

### AD-76 Bootstrapping `[proposed]`

`app/src/App.tsx` does what `web/src/main.tsx` does, in order: set the kv port, `initTheme`, choose the transport
(AD-20/21/22; on web through `platform/transport.web.ts`, which passes `window.aiwbTransport` to
`desktopTransport`), register the picture address (`setPictureAddress`, AD-25), the Ui and BoardSide seams, `watchKeptDrafts()`, `connect()`, render. Web: the flush hooks
(`visibilitychange`, `pagehide`, `beforeunload`, `window.aiwbFlush`) and `window.aiwbReady = true` once the root
rendered (the window's blank-page check, AD-41); native: `AppState` `background` → `flushAll()`
(goal 4.5: "a drawing is saved before … the screen goes away"). A web build loaded with no way shows "AI Whiteboard
runs in its app." as today.

---

## 7. The board (goal 4.5, D7)

### AD-50 One typed bridge `[proposed]`

`packages/board-bridge/src/messages.ts` defines every message both ways, and `validate.ts` a validator per message
(the app validates everything that comes from the board view; the view validates what comes from the app). The
messages are JSON-safe (no functions, no Blobs; pictures as base64).

```ts
// app → board view
type ToBoard =
  | { t: "load"; board: string; scene: { elements: El[]; files: Files; appState: SavedAppState }; viewMode: boolean;
      theme: ThemeMsg; style: CurrentItemStyle }            // shows a board (replaces the one shown)
  | { t: "unload" }                                         // shows nothing (the view keeps running)
  | { t: "viewMode"; on: boolean }
  | { t: "theme"; theme: ThemeMsg }                         // light/dark + the canvas filter of logic/canvastheme.ts
  | { t: "select"; ids: string[] }                          // selects elements (showRef)
  | { t: "scrollTo"; ids: string[]; animate: boolean }      // brings elements into view (showRef, show_board)
  | { t: "req"; id: number; op: EngineOp };                 // a request answered by { t: "res" } (below)

type EngineOp =
  | { op: "apply"; target: "live" | { elements: El[] }; params: ApplyParams; rev: number }       // apply.ts applyChanges
  | { op: "delete"; target: "live" | { elements: El[] }; refs: Ref[]; cascade: boolean; rev: number }
  | { op: "restore"; elements: unknown[] }                                                         // restoreElements
  | { op: "export"; target: "live" | { elements: El[]; files: Files; appState: SavedAppState };
      ids: string[]; scale: number; background: boolean }  // get_image: PNG base64 and the bounds measured
  | { op: "snapshot" };                                     // the live scene now, at once (save before going away)

// board view → app
type FromBoard =
  | { t: "ready"; version: string }                         // the view runs; the app then sends theme and load
  | { t: "loaded"; board: string }
  | { t: "changed"; board: string; elements: El[]; files?: Files; appState: SavedAppState; style: CurrentItemStyle }
                                                            // the scene changed (sent at most every 250 ms, and at once
                                                            // after a snapshot request); files only when their set changed
                                                            // REVISED: a delta with `order?`, see below (B6)
  | { t: "view"; board: string; scrollX: number; scrollY: number; zoom: number; width: number; height: number }
  | { t: "selection"; board: string; ids: string[] }        // the selected element ids, bound text left out
  | { t: "res"; id: number; ok: true; value: unknown } | { t: "res"; id: number; ok: false; code: string; message: string }
  | { t: "error"; message: string };                        // the view failed (shown as "Couldn't open this board")
```

- **`changed` carries only what changed** (revised after spike board-webview: the whole scene of 2,000 elements is
  1.32 MB of JSON per message, sent on every debounce while drawing, and more with images). B1 and B2 built it with
  the whole scene; B6 (packages.md) changes it to:

  ```ts
  | { t: "changed"; board: string;
      elements: El[];        // the elements whose version differs from what the app last heard for this board (new
                             // ones and deleted ones among them: Excalidraw keeps a deleted element, isDeleted: true)
      order?: string[];      // every element id in scene order, sent when the order or the set of ids changed
      files?: Files;         // only the files added since the last changed (files are never changed in place)
      appState: SavedAppState; style: CurrentItemStyle }
  ```

  The baseline is per board: what `load` gave (or the scene of the last `snapshot`), then each `changed`. The app's
  board side (AD-55) keeps the **mirror**: elements by id, replaced when their version differs, ordered by the last
  `order` (an id that `order` no longer names is dropped); it is the whole scene when it is saved. The whole scene crosses only in `snapshot`'s answer (and in
  `load`). A test in `packages/board-bridge` and one in `packages/core/test/board/` prove that a mirror fed with
  `load` + the `changed` messages of a scripted drawing equals the view's own scene.
- **`ready` is sent only when the view can take a message** (revised after spike board-webview, where `ready` came
  before the handlers were bound and the first request waited out its timeout): the page adds its message listener
  before it renders, and `ready` is posted from the mount effect of the component that holds Excalidraw (B2's
  `Board.tsx` does this already; keep it). The host also queues what it sends until `ready` (AD-52).
- The bridge carries no address, no secret, no server and no call (goal 6): the view can ask for nothing but to tell
  the board's own state. The validator rejects anything else; a rejected message is logged and dropped.
- The spike's envelope (`kind` + `type`, string ids, a `Requests` map that types params and result together) is
  equivalent and is **not** adopted: B1's `t`-tagged messages and B2's `EngineValues` (a value type per request,
  `validateEngineValue`) are merged and stay.
- `ThemeMsg`, `SavedAppState` (scrollX, scrollY, zoom, viewBackgroundColor), `CurrentItemStyle` (the `currentItem*`
  keys `Canvas.tsx` remembers) are defined there too. A test per message (round trip through JSON, validator accepts
  the valid and rejects the rest) is the "bridge messages tested as shared types" of goal 7.2.

### AD-51 `@aiwb/board-view`: the board side of the bridge `[proposed]`

- `src/endpoint.ts`: `createEndpoint(post: (m: FromBoard) => void)` → `{ receive(m: ToBoard), mount: React component }`.
  It holds the Excalidraw element (`<Excalidraw>` with today's `UIOptions`, `viewModeEnabled`, `initialData`,
  `theme`, the scene-drop block of `Canvas.tsx`), runs `apply.ts` (moved here from `web/src`, unchanged but for its
  imports; the old page keeps its copy) and `exportToBlob` (today's `getImage` drawing part, with `getDimensions` and
  the size limits of `logic/image.ts`), and answers `req`s. With `target: { elements }` it works on the given
  elements without touching the live canvas (for a board that is not on screen).
- `src/BoardView.web.tsx`: mounts the endpoint in a page, wired in-process (`post` is a function call; `receive` is
  called directly). So **the web build runs the same message protocol as the web view**, and the browser checks
  test the bridge logic on every board check. (revised after package B2:) the app does not import it through Metro;
  it is the inside of board-view's **web target** `board.js` (AD-40), which exposes it as
  `window.aiwbBoardView.mount(element, post, options)`.
- **Two build targets, one esbuild configuration** (`build.mjs`, the `slim` plugin that drops locales and Mermaid,
  Xiaolai left out) (revised after spike board-webview and package B2):
  - `npm run build:web` → `app/public/board/` (`--out` to change): `board.js`, `board.css`, `fonts/` for the web
    build (AD-40);
  - `npm run build:webview` → `dist-webview/board.html`, **one file** (revised after spike board-webview, in place of
    B2's `index.html` + `board.js` + `board.css` + `fonts/`): script, style and fonts inside (fonts as `data:` URLs,
    33 % larger, 576 KB; a font shim swaps each `FontFace` address for its data URL), about 4.0 MB (1.7 MB
    gzipped). The spike's `webview/build.mjs` and `fontshim.js` are the template.
- **Wiring of the web view page** (revised after spike board-webview): `postMessage` **both ways**.
  Out: `window.ReactNativeWebView.postMessage(JSON.stringify(m))`. In: the app calls the web view's `postMessage(json)`
  and the page listens to `message` events on `window` **and** `document` (iOS dispatches on `window`; react-native-
  webview's Android side dispatches on `document` `[not verified]`, B5 checks), taking only events whose `source` is
  `null` (what the web view dispatches). No `injectJavaScript` (a 1.27 MB message went through `postMessage` in
  111 ms round trip). `window.aiwbBoardReceive(json)` stays only as the entry of the plain-browser harness
  (`dev/harness.mjs`); the app never calls it.
- **The web view page's CSP** (revised after spike board-webview: stricter than this AD said, and it blocked 12 of
  12 network attempts of six kinds): `default-src 'none'; script-src 'sha256-…' (each inline script, by hash,
  computed by the build); style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none';
  worker-src blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`. No `unsafe-eval`, no
  inline script but the hashed ones. A navigation is not covered by CSP in WebKit: the host refuses it (AD-52).
- `ready` carries the view's Excalidraw version (B2 does), so the host can log a page built from another version.

### AD-52 The board host in the app `[proposed]`, spike `rn-spike-board-webview`: **GO** on iPad (revised after spike board-webview)

`app/src/platform/board.*.tsx` exports `BoardHost` (a component placed where the canvas goes) and
`useBoardChannel()` (send `ToBoard`, receive `FromBoard`, request/response with timeouts from `timing.scene`).
- (integration sweep, D-SL-12) While a chat waits for a point (`picking`), the board is in view mode (`viewModeOf` of core's
  `board/side.ts`) and the pick layer takes no pointer, so the wheel, a drag and a pinch reach Excalidraw as without a wait. The tap
  is heard by `PickSurface` around the canvas (web: the box's pointer events in the capture phase, left alone; native: a
  gesture-handler `Tap` on the box of the web view); a pan, a pinch or a second finger puts no point (`taps.ts`). The native half is
  not yet run on a device.
Every host **queues what it sends until the view said `ready`** (AD-50), and sends `theme` then `load` first.
- web: mounts board-view's web target in-process (`window.aiwbBoardView.mount`, AD-40), not a Metro import.
- native: `react-native-webview` with the page from the app's files (AD-56), and these settings (the spike's
  `spikes/board-webview/app/BoardView.tsx` is the template):
  - **`originWhitelist={["*"]}`** (revised after spike board-webview: with `["file://*"]` the library does not ask
    `onShouldStartLoadWithRequest` about a URL that fails the whitelist but hands it to `Linking.openURL`, so a
    `window.open` or `location.assign` from the page **opened Safari** and put the app in the background; Excalidraw
    opens an element's link, so a scene drawn by an agent can do this). The guard is the handler:
    `onShouldStartLoadWithRequest` allows only the page's own file URL and refuses everything else. A refused
    `http(s)` URL is offered to the user by the app (a confirm dialog naming the address, then `Linking.openURL`);
    any other scheme is dropped and logged; nothing is opened without the user's yes.
  - iOS: `allowingReadAccessToURL` = the page's folder; Android: `allowFileAccess` for it, and
    `setSupportMultipleWindows={false}` (revised after spike board-webview: `allowFileAccess` is Android's only).
  - `javaScriptEnabled`, `incognito`, `cacheEnabled={false}`, no `injectedJavaScript*`, no `injectJavaScript`
    (messages go in by `postMessage`, AD-51), scroll and bounce of the web view off (Excalidraw pans and zooms; the
    spike's strokes did not scroll the page).
  - `textInteractionEnabled`: **open** `[not verified]`: the spike set it to `false` and did not try the text tool;
    B4 tries Excalidraw's text tool with the on-screen keyboard on the simulator and picks the value that lets it
    type, and says which in its report.
  - a **`key`** on the web view and `onContentProcessDidTerminate` (iOS; `onRenderProcessGone` on Android): the
    host rejects the requests in flight, makes a new view (new `key`) and sends `load` again from the board side's
    mirror (built in the spike, never triggered: untested).
- **One web view first** (revised after spike board-webview: one view costs 50–52 MB footprint with an empty board
  and 125–130 MB with 2,000 elements, plus the GPU process 21 / 45 MB, on the simulator; a second was not measured
  and would likely add 50–100 MB on a phone; and the memory is **not given back** when an empty board replaces a
  large one, only when the view ends). So what was the fallback is the design:
  - requests for a board that is not on screen (`target: {elements}`, an agent drawing on a board while the phone
    shows something else, goal 3.4) go to the **visible** view while one exists (on a phone a board chat opens over
    its board, so its view stays mounted beneath, AD-71);
  - only when no board view is mounted does the host make a **hidden engine view** (0×0, at the root) for those
    requests, and it **ends it** (unmounts) 60 s after its last request, so its memory comes back;
  - the visible view ends when its board screen is left (phone) or the board panel closes (wide layouts), for the
    same reason. Measuring a real phone is a by-hand check (goal 7.5).
- Overlays drawn by the app over the host, not inside the view: the flash boxes, the "agent is working" pill, the
  pick layer of ⌘⇧L (a tap converted to board coordinates with the last `view` message), the save banner, the
  dropped-edit note, `TakeoverPanel` and `BoardOff` in place of the host, the board bar.

### AD-55 The board side of the app `[proposed]`

`packages/core/src/board/` (new; the app's, while the old page keeps `web/src/board.ts`):
- the same responsibilities and behaviour as `web/src/board.ts`: scenes by key, `loadScene`, autosave (debounce
  500 ms, one write in flight, revision based), roles/take/grant/lost/handOver, flush, `runTool` (`read_board`,
  `get_view`, `get_image`, `apply`, `delete_elements`, `show_board`), `buildContext`, selection and point refs;
- written against a **`BoardChannel`** (`send`, `request`, `on`) instead of `liveApi`: the live scene is mirrored from
  `load` plus the **delta** `changed` messages (AD-50, revised after spike board-webview), and from
  `selection`/`view`; engine work goes through `req` (the live view for the board on screen; for others
  `target: {elements}` on the visible view, or on the hidden engine view when none is mounted, AD-52); `restore` and
  the scene version (sum of element versions, as Excalidraw's `getSceneVersion`) are computed as today;
- it registers as the **BoardSide**, the seam of AD-2, with its **ten** members (revised after package F3):
  `runTool, flushAll, boardLost, granted, handOver, streamOpened, takeAfterSnapshot, sectionBack` (called by
  `conn.ts`) and `forgetBoard(id)` (the store let go of a board: drop its scene and its pending save) and
  `boardUnsaved(id)` (whether a board has an edit waiting to be saved), as `packages/core/src/state/ports.ts` has them;
- **save before going away**: `flush(board)` first sends `{op: "snapshot"}` to the view that shows the board and
  writes what it answers; on native `AppState` `background` and the board screen's blur call `flushAll()`; on web the
  window hooks do (AD-76);
- unit tests in `packages/core/test/board/` run against a fake channel that answers scripted results (Excalidraw
  needs a DOM, so the real engine is not run under `node --test`); the real engine is exercised by every board check
  of the web build (AD-51 wires it in-process) and by the device self-test (AD-83).

### AD-56 Shipping the web-view page `[proposed]` (revised after spike board-webview)

- `packages/board-view` `npm run build:webview` produces `dist-webview/board.html`, one file (AD-51), not committed.
- **iOS: a Metro asset, no config plugin** (proved by the spike in a Release build: load start to end 98 ms):
  `app/metro.config.js` adds `"html"` to `resolver.assetExts`; `board.native.tsx` does
  `require("@aiwb/board-view/dist-webview/board.html")`, `expo-asset` gives its file URI inside the app, and the web
  view loads it with `allowingReadAccessToURL` its folder. The file must exist when Metro bundles: `build:webview`
  runs before every app build (the install script, the device-test runner, and an `app` script `prebuild:board`
  that a developer's `npx expo run:*` goes through).
- **Android: (1) loads** (package V2, `v2-android.md`: `expo-asset` copies the `res/raw` resource into the cache and `localUri` is a `file:///data/user/…/cache/ExponentAsset-….html`; no `withBoardAssets`). Before it ran: untested `[not verified]`. A Release APK keeps assets inside the APK, so `expo-asset`'s `localUri` may
  not be loadable by `file://`. B5 tries, in order: (1) the Metro asset as on iOS; (2) the page read into a string
  and given as `source={{html, baseUrl}}`; (3) `withBoardAssets` copying `board.html` into
  `android/app/src/main/assets/board/` and loading `file:///android_asset/board/board.html`. The first that loads in
  a Release build on the emulator is kept; `withBoardAssets` is written only if (3) is the one.
- Size (measured): **4.0 MB** (1.7 MB gzipped; js 3,208 KB, css 248 KB, fonts 576 KB) with Mermaid, Xiaolai and the
  locales but English left out. Launch to a board that answers about 1.2 s on the simulator. Memory: AD-52.
  Pencil, pressure, palm rejection, pinch, a phone-width layout of Excalidraw's panels and a real device's memory are
  by hand (goal 7.5): the spike could not test them.

### AD-58 If the board spike fails `[not verified]`

If Excalidraw in a web view cannot draw by touch or does not fit in a phone's memory, goal 9 says the rewrite is
reconsidered: the orchestrator stops the board tracks for native and asks the user. The web build's in-page board is
not affected. **Result** (revised after spike board-webview): **GO** on the iPad simulator: finger drawing (three
swipes made three `freedraw` elements through the bridge) and memory within reach; Android, Pencil and a phone
are not yet tried (AD-56's by-hand list, and B5 for Android).

---

## 8. The composer (goal 4.2, the hardest risk)

### AD-60 One contract for the box with chips `[proposed]`

The text box's value is today's: **the message text with each reference as its inline tag** (`logic/refs.ts`
`serializeRef`/`parseRefs`), so drafts, sending, the thread and the agent are unchanged. The contract
(`app/src/platform/chipinput/types.ts`) is `RefInput.tsx`'s:

```ts
type ChipInputHandle = {
  insertRef(ref: Ref): void;               // a chip at the caret (or where it last was, or at the end)
  replaceBeforeCaret(n: number, s: string): void;  // the @ mention being typed
  set(text: string): void;                 // replaces everything (tags become chips)
  openInsert(): void;                      // the insert popup at the caret (⌘P)
  focus(): void;
};
type ChipInputProps = {
  placeholder: string;
  onChange(value: string, beforeCaret: string): void;
  onKey(e: KeyLike): boolean;              // the composer's keys (Enter to send, Esc, ↑ …); true = handled
  locked?: boolean; readOnly?: boolean;
  onImages?(files: Picked[]): void;        // a paste of images (web); native pastes images through the picker only
};
```

Behaviour that both implementations must show (and the browser checks and the device test check): a chip is one
unit for the caret, selection, Backspace/Delete, cut, copy and paste (what a copy or a paste with chips gives is
what the C-RF rows say today's box gives), a chip cannot be edited inside, the value always round-trips through
`parseRefs`/`serializeRef`. Undo of a chip is **not** required: today's box has none (C-RF-20). The full list is the
C-RF rows of the parity inventory.

`chipinput/types.ts` (K1 writes it) holds this whole contract, `replaceBeforeCaret`, `openInsert`, `onKey`, `locked`,
`readOnly` and `onImages` included, so that K2 implements the same type. Offsets the composer passes in
(`replaceBeforeCaret(n, …)`, `beforeCaret`) count characters of the **value** (the serialized text), as
`logic/insert.ts` and the @ mention code count them; an implementation that shows other characters (native, AD-61)
maps between the two itself. On native, `onKey` gets what the field reports (`onKeyPress`: Enter, Backspace, the
characters) and a hardware keyboard's other keys come through the keys port (AD-73).

### AD-61 The two implementations `[proposed]`, spike `rn-spike-composer`: **GO** (revised after spike composer)

**Decision: two implementations behind the one contract of AD-60, not one shared implementation.** The web build
keeps today's `contenteditable` box (K1); iOS and Android use the spike's approach (K2).

- **web** (`chipinput/ChipInput.web.tsx`, K1): today's `RefInput.tsx`, a `contenteditable` element whose DOM is owned
  by the component, moved into a `.web.tsx` primitive with RN props around it. It is a port of a primitive (allowed
  by AD-70), not a second screen. Unchanged by the spike.
- **native** (`chipinput/ChipInput.native.tsx` + `chipinput/chipdoc.ts`, K2): the spike's approach **(a)**: a
  controlled multiline `TextInput` whose text is given as **children** (no `value`): plain runs as `Text`, each chip
  as a nested `Text` with a background, showing its **label between two no-break spaces**; the truth is a
  **document** `Doc = (string | Ref)[]` beside it (`chipdoc.ts`, platform-free, no React): `applyChange` diffs what
  the field reports against the string shown (common prefix and suffix, the previous selection as a hint) and maps
  the edit onto the document (an edit touching a chip removes it whole; an insertion inside one goes to its nearer
  edge; pasted tags become chips; a pasted label this input has held becomes its chip again); `snap` moves a caret or
  selection out of a chip (an arrow step crosses it, a tap goes to the nearer edge, a selection ending inside takes
  it whole) and the input is told through the `selection` prop; `insertRef` applies the page's space rules; the
  value is `serializeRef` of `logic/refs.ts`, imported from core, never copied. `react-native-enriched` is not used.
  The spike's `spikes/composer/src/{logic/chipdoc.ts, ChipInput.tsx, ChipField.tsx}` and its 13 unit tests are the
  start. Proved on the iOS simulator (26 Maestro checks, 4 XCUITest hardware-key tests: arrows, Shift+arrows,
  ⌘A/C/V/X, delete).

**Why not one shared implementation** (the spike's `ChipInput` also ran on the web build, with a transparent
`<textarea>` over a layer of `Text` that draws the pills, 42 Chromium checks passing):
1. **The desktop must not get worse** (goal 4.3), and the shared one makes it worse where today's box is used most:
   (i) undo: today's box edits through `execCommand("insertText")`, which keeps the browser's undo (C-RF-20, checked
   by `PL5.1`: ⌘Z takes an inserted prompt out); a controlled `<textarea>` whose value React sets is expected to
   lose the browser's undo across every programmatic edit (a chip put in, a chip taken out, a snap): the spike says
   "likely lost" and did not test it, and the risk falls on the desktop; (ii) a chip's **hover tooltip** (C-RF-05) cannot be had: the pointer is over the transparent textarea, not
   the drawn chip; (iii) a chip's **dashed square or dot icon** (C-RF-14) has no place in a run of characters whose
   widths must equal the textarea's; (iv) the pills are placed only because two elements break their lines alike, a
   coupling every font, padding or scrollbar change can break, on the target that is used all day.
2. **The one-codebase bound holds either way.** Goal 6 and AD-70 allow a platform port in `app/src/platform/`; the
   screens see one `ChipInput` with one contract, and the composer, drafts, mentions and insert logic are shared
   (core). What is per platform is the box alone, as for the board host and the picture.
3. **Cost.** K1 is today's proven box moved (358 lines, covered by `P7.4`, `PL5.1`, `PL5.2`), being built now;
   making the web the spike's box would mean proving every C-RF row again on the desktop and losing the three things
   above. The price of two implementations is that the browser checks test only the web one; the native one is held
   to the same contract by `chipdoc.ts`'s unit tests (`node --test`), its browser checks on a dev gallery entry
   (below), the Maestro flow and the XCUITest keys (AD-83).
- **The native logic is also checked in Chromium** (cheap, since the checks exist): K2 keeps the spike's web field as
  a **dev-only** gallery entry (`app/src/dev/` with `?gallery=chipdoc`, never used by the composer) and ports the
  spike's `checks/web.mjs` (34 checks with real key events) as `web/dev/checks-app/L4b-chipdoc.mjs`, so a change to
  `chipdoc.ts` or the native `ChipInput` logic is caught without a simulator.

**Rules the spike found, which K2 keeps** (revised after spike composer):
- **React's nested-update limit**: the owner is told of a change **from the handler that made it** (both state
  updates in one render), never from an effect that runs after every key: the effect version hit "Maximum update
  depth exceeded" (#185) in about half the production-build runs when a burst of keys wrapped a line.
- **Do not re-apply a selection the field has just reported**: the `selection` prop is set only when the snapped
  selection differs from what the field said; React Native 0.86 (Fabric) applies it when it differs from the last
  one reported.
- Chips are **flat on native**: a nested `Text` takes a background but no radius and no padding (the two no-break
  spaces are the padding); a double tap selects the whole chip (no-break spaces make it one word for UIKit). Rounded
  pills on native would need a native text view module (approach (c)); not in Part A unless the user asks (Part B's
  design may).
- **Copy out of the input on iOS gives the label text**, not the tags (C-RF-18 holds on the web, not fully on
  native): a paste back into the same input restores the chip; a paste elsewhere gives the label. Closing it needs a
  native module or a clipboard hook `TextInput` does not offer. This is a **known difference of the native box**,
  listed in the final report for the user, not a blocker.
- Not verified on any device: IME composition, autocorrect replacing a word next to a chip (unit-tested only),
  undo/redo, dragging the selection handles across a chip: by-hand checks (goal 7.5).
- **Android is untested** `[not verified]` (the emulator was taken): React Native's Android `TextInput` takes nested
  `Text` spans with a background too, so the same field is expected to work. K2 checks Android **first**: fast
  typing with Gboard's composition while the text is re-set (duplicated or lost characters are the known failure of
  controlled Android inputs), the `selection` prop and arrow keys, a hardware keyboard. **If Android fails**: approach
  (c) on Android only, a small Kotlin view (`ReplacementSpan` chips) as a local Expo module with a contract tested
  against a fake (goal 6), `chipdoc.ts` unchanged; the orchestrator decides that, with an Opus package.
- **If neither holds the contract** on a platform (goal 9): the rewrite is reconsidered with the user; the stop-gap
  the orchestrator may propose then is chips in a row above a plain `TextInput`, with their tags at the end of the
  text, which changes the user-visible behaviour and so needs the user's word.

### AD-62 The rest of the composer `[proposed]`

`Composer.tsx` (1,400 lines) is rebuilt in `screens/composer/` from the same parts and the same core logic: the
toolbar chips (agent, folder, model, effort, Subagents), the context ring, send/stop, the fit rules of
`logic/composerfit.ts` (as a layout of RN views: the widths are measured with `onLayout`, the rules stay), the @
mention popup, the error line, the image strip, the read-only and locked states, drafts (`chatdraft.ts`,
`keptdrafts.ts`, core). On native the composer sits above the keyboard (`react-native-keyboard-controller`
`KeyboardStickyView`), and ⌘L/⌘⇧L have on-screen buttons on touch (the "Add selection" and "Point at" actions,
visible while a board chat has its board).

### AD-64 Quotes `[proposed]` (goal 4.2)

- The quote model is today's (`logic/quotes.ts`: a quote is a span of a message's displayed text, AD-75).
- web: today's browser selection and ⌘L (`quoteDom.ts`, moved into `platform/quote.web.ts`, measuring the rendered
  DOM's text nodes as today; highlights with the CSS Custom Highlight API as today).
- native: a **long press** on a message opens the "Quote" sheet: the message's displayed text in a read-only,
  selectable `TextInput` (`editable={false}`, `selection` events), the system's own selection handles, a **Quote**
  button (quote the selection) and **Quote whole message**; the span is the selection in the displayed text. Where the
  platform's selection menu can take an item of ours (`UITextView` edit menu on iOS, the text `ActionMode` on
  Android), a later package may add "Quote" there; not in Part A's first pass.
- (integration sweep) **The web build on a wide layout quotes by the keyboard only**, as the old page did: the browser's
  selection and ⌘L (the old page had no other way to quote: no button, no item of the selection menu). A touch-screen
  laptop running the desktop app has its keyboard; a desktop window narrower than 700 px is the phone layout and takes
  the sheet path (a long press). A web build at a tablet width with touch and no keyboard exists only in the browser
  checks (a browser tab is not a target, goal 4.1); the iPad app takes the sheet path. Not a loss of the desktop page.
- Showing where a quote points (today's highlight): on native, the message scrolls into view and flashes its
  background; the span is highlighted in the Quote sheet.

---

## 9. Tests (goal 7)

### AD-80 Browser checks of the new build at three viewports `[proposed]` (goal 7.1)

- **Where**: `web/dev/checks-app/<ID>-<word>.mjs`, one per check, with the **same ID** as the old check it ports
  (`SEC.2-states.mjs`), plus new IDs for behaviour only the new build has (`L*`: layouts and touch). The runner is
  `web/dev/uicheck.mjs` with `APP=1` (or `npm run uicheck:app`), which builds the web build once (`buildAppDist`) and
  runs each check at each of its viewports. The old checks stay in `web/dev/checks/` and run on the old page until
  retirement: **they are the parity reference** — a ported check proves at least what its old one proves (same
  seeds of the mock, same assertions, other selectors), and the package that ports it says so in the check's first
  comment.
- **Viewports** (`web/dev/viewports.mjs`): `desktop` 1280×800, mouse; `tablet` Playwright device "iPad Pro 11"
  (834×1194, `hasTouch`, `isMobile`, scale 2) in Chromium; `phone` device "iPhone 15" (393×852, `hasTouch`,
  `isMobile`, scale 3) in Chromium. A check declares `export const viewports = ["desktop", "tablet", "phone"]`, the
  ones where its behaviour applies (the parity rows' "Note for the app"); `check()` of `shot.mjs` runs its body once
  per viewport with `{page, viewport, layout}` and names the viewport in each failure.
- **Selectors** (`app/src/ui/tid.ts` and `web/dev/checks-app/sel.mjs`):
  - identity by **`testID`** (react-native-web renders `data-testid`): kebab-case names that reuse today's class
    names where one exists (`side-tree`, `side-section`, `side-row`, `composer`, `ref-chip`, `tool-card`…), so a
    check's port is mostly mechanical; a list of the same thing uses one testID and is told apart by text or value;
  - values a check reads (a section's server id, a state's tone, a chip's kind) by **`dataSet`** (react-native-web
    renders `data-*`): `dataSet={{server: id, tone}}` (typed in `tid.ts` by module augmentation; ignored on native);
  - states by **roles and ARIA** (`role`, `aria-selected`, `aria-expanded`, `aria-disabled`, `aria-checked`,
    `aria-busy`), which both web and native accessibility read;
  - words by **text** (`getByText`), since the words are the parity.
  - Maestro (AD-83) uses the same `testID`s (`id:`) and text.
- **Navigating per layout**: `sel.mjs` has `openChat(page, key)`, `openBoard(page, key)`, `back(page)`,
  `openMenu(page, testID)` that click through the stack on `phone` and the panes on `tablet`/`desktop`; checks use
  them instead of clicking rows directly where the layout changes the path.
- **Touch**: on `tablet`/`phone` a check uses `page.tap`, `page.touchscreen` and the long-press helper
  `longPress(page, locator)`; drag checks use `touchDrag` (long press then move) there and `dragger` with a mouse on
  `desktop`.
- Pixel fixtures (P0.6 composer widths, screenshots of P0.7) are **written again for the new build**, not compared
  with the old page's.
- The mock and the test host are unchanged (they are the contract's stand-ins, goal 4.2).

### AD-81 Unit tests that stay and are added `[proposed]` (goal 7.2)

| Suite | Command | What |
|---|---|---|
| core | `cd packages/core && npm test && npm run check` | the moved tests, unchanged; tests of the seams; `board/` tests on a fake channel |
| conn | `cd packages/conn && npm test` | the moved conn tests (Node ports, stand-in TLS server), core-on-fakes cases, the port contract, the purity test |
| board-bridge | `cd packages/board-bridge && npm test && npm run check` | every message: JSON round trip, validator accepts/rejects |
| app | `cd app && npm test && npm run check` | `node --test --experimental-strip-types` on non-visual app code (native transport on the fake module, the phone Store on fakes of MMKV/SecureStore, tokens = CSS, stackOf, layoutOf, chip value model, `chipdoc.ts`, the no-plain-HTTP scan and the ATS config of AD-36); type check web + native (TypeScript 6.0.3, AD-1) |
| old page | `cd web && npm test && npm run check` | until retirement (then only `dev/` tests remain) |
| desktop | `cd desktop && npm test` | main process, ipcface, preload (building the transport, cancel by id) with fakes |

No component tests in Jest: screens are covered by the browser checks at three viewports (goal D16).

### AD-82 The end-to-end scripts `[proposed]`

`web/e2e/{newchat,twopages,remotechat,localserver}.e2e.mjs` take `DIST` (default `web/dist`) and get ported
selectors from `checks-app/sel.mjs` when `APP=1`; each is run on the web build at the desktop viewport (and
`remotechat` at the phone viewport too, since sections are the phone's whole sidebar). `web/e2e/app.e2e.mjs` is
paid: never run unless the user asks.
- (integration sweep) `remotechat`'s `asksWhere` ("nothing asks where it should live") counts the old page's
  `board-choice`. The old page dropped that question (where a new thing lives) in `bfb97f9`, before the rewrite, and the
  new build never had it, so the count is 0 on both: no behaviour was lost. On both builds the same steps assert what
  replaced the question (the thing is made at once, on the section's server, in no group, or in the group whose "+" was
  pressed). R1 may drop the guard with the old page.

### AD-83 Device and simulator tests `[proposed]` (goal 7.4, D16)

- Tool: **Maestro 2.11.0** (revised after spikes ios-net and composer, which both used it): `app/e2e/get-maestro.sh`
  (V5) downloads `maestro.zip` of release `cli-2.11.0` and a Temurin JRE 17 into `app/e2e/.tools/` (git-ignored),
  and checks the zip against a **sha256 written in the script** (taken once from the release's
  `checksums_sha256.txt`, so a changed download fails); nothing is installed system-wide, and the runner uses that
  Maestro and that JRE (`JAVA_HOME`). The composer spike's `spikes/composer/checks/get-maestro.sh` is the template
  (it checks against the release's list fetched at run time; the pin in the script is the change). Hardware keys
  on iOS, which Maestro cannot send, are an **XCUITest** target generated by the runner, as the composer spike's
  `checks/ios-keys/` does (V3).
- Flows in `app/e2e/maestro/*.yaml`, run against a development build on the iOS simulator and the
  Android emulator (the emulator lock and `adb reverse` of `ORCHESTRATION.md`), each started by
  `node app/e2e/run.mjs <flow> --platform ios|android`, which starts a **scratch Go server** as `web/e2e/lib/rig.mjs`
  `Scratch` does, passes its address, fingerprint and secret to the flow as env, and stops it at the end.
- The short list, and nothing a browser can show:
  1. `net-pinned-stream.yaml`: add the scratch server by pasting address and secret, accept the fingerprint, the
     section connects and shows its tree (the pinned certificate, HTTP/2 and the stream); restart the server with a
     new certificate (`remote setup --replace`… as the rig can) → "Certificate changed".
  2. `board-webview.yaml`: the self-test screen `dev/BoardSelfTest` loads a board in the web view, applies a change
     through `req apply`, exports a PNG through `req export`, and shows "board self-test ok"; then a board of the
     scratch server is opened and a swipe draws a line that is saved (the server's scene revision rises).
  3. `composer-chips.yaml`: on a board chat, insert a selection chip, type around it, move the caret across it,
     delete it in two Backspaces (the space after it, then the chip), copy and paste it back in the same box; send;
     the sent message shows the chip; plus the XCUITest keys on iOS (arrows and Shift+arrows never stop inside a
     chip, ⌘A/C/V/X, delete). (revised after spike composer: "undo" is out, since it is not defined for a chip,
     C-RF-20, and was not testable; the spike's `checks/ios/composer.yaml` and `checks/ios-keys/` are the
     templates.)
  4. `storage-picker-permission.yaml`: the secret is in the secure storage (the self-test screen reads that
     `aiwb.secret.<id>` exists and that MMKV holds no secret); pick an image with the picker (a seeded photo in the
     simulator) and it shows in the composer; iOS: the local network prompt appears and its denial shows
     `local_network_denied` in the section.
  5. `conn-on-hermes.yaml`: the self-test screen `dev/ConnSelfTest` runs `@aiwb/conn`'s core-on-fake-ports cases
     inside Hermes and shows "conn self-test ok" (proves AD-10's purity on the real engine).
- The local network on a real device, the install script, hours of streaming, finger/pencil drawing and suspend/resume
  are **by hand** (goal 7.5); the final report lists them as done or not.

---

## 10. The install script (goal 4.9, D13) `[user]` for what, `[proposed]` for how

`node app/scripts/install.mjs --platform android|ios [--device <serial|udid|name>] [--release]` (and
`scripts/install-app-device.sh`, a two-line wrapper, so it is found beside `scripts/install-app.sh`):

1. Checks the tools it needs and says which is missing and how to get it (Node, npm, Xcode + `xcrun devicectl` for
   iOS, JDK 17 + Android SDK + `adb` for Android), and that exactly one device is connected or named (lists them
   otherwise).
2. `npm ci` at the root if `node_modules` is older than the lock; `npm run build:webview` in `packages/board-view`.
3. `npx expo prebuild --platform <p> --clean` (CNG; nothing native is committed).
4. Android: `npx expo run:android --variant release --device <serial>` — a release APK signed with the debug key
   the generated project carries (no account, no key of the user's), installed with `adb install -r`.
   iOS: needs `AIWB_IOS_TEAM_ID` (from the environment only, never a file; revised after package I1); `xcodebuild` of the
   generated workspace in Release with automatic signing (`-allowProvisioningUpdates`, `DEVELOPMENT_TEAM`) and
   `xcrun devicectl device install app` / `process launch`. An iOS simulator named with `--device` is built without signing
   and installed with `simctl`. (As built: `app/scripts/install.mjs`, its decisions in `app/scripts/lib/install-core.mjs`; the
   Android tool locations are shared with `app/e2e/run.mjs` in `app/scripts/lib/devtools.mjs`. `withAiwbPermissions` was not
   needed: the Info.plist texts and the camera are entries of `app.config.ts`, N1's and S12's.)
5. Says what it did (device, platform, version, bundle id) and, if it stops, the step and why, with the tool's last
   lines.
- Run again it rebuilds and reinstalls the current code (goal 4.9: repeatable).
- What the user must give for iOS is **reported at the end of the work** (goal 4.9, D13), not asked now. What is known
  now, for that report: an Apple ID in Xcode with a team (a free personal team works for 7-day installs, 3 apps;
  a paid membership for a year), the device registered by Xcode on first run with Developer Mode on, a bundle id that
  is unique for a free team (`AIWB_IOS_BUNDLE_ID`). Android: USB debugging on; no account.
- No store, no TestFlight, no upload (goal 10).

---

## 11. Retirement of the old page (goal 6, D15) — the last package

Only after: the desktop app runs the web build by default (package D2) **and** every check of `web/dev/checks` has its
port in `web/dev/checks-app` passing at its viewports **and** the desktop app's tests pass on the web build
(`cd desktop && npm test && npm run e2e`) **and** the web e2e scripts pass on it. Then, in one package:
- delete `web/src`, `web/index.html`, `web/build.mjs`, `web/public` (moved to `app/public` earlier), the old page's
  `web/test` leftovers, `web/dev/checks/` (the old checks; their ports keep their IDs), `transport/ipc.ts` and
  `window.aiwbApp` in the preload, `web/src`'s copies of `board.ts`/`apply.ts`;
- `web/` keeps `dev/` (host, hostface, mock, mock-ui, shot, uicheck with `checks-app/` renamed `checks/`) and `e2e/`;
- `scripts/build-app.sh` builds `app/dist-web`; `desktop/electron-builder.yml` takes it as `web`;
- `README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/development.md` say what is true then (the app, the
  packages, the commands, the device tests, the install script).

---

## 12. What Part B needs from Part A (goal 11) `[proposed]`

- Layout is three named width layouts in one place (AD-72) and screens are composed from parts in `screens/`, so a
  redesign changes arrangement, size and gesture there; no logic lives in a screen that Part B would have to move.
- Tokens (AD-74) carry the identity; Part B keeps them.
- Every interactive element has a `testID` and role (AD-80), so Part B's checks at the three viewports are written
  the same way.
- Input of each kind is reachable already: pointer/touch (`usePointer`), hardware keys (keys port), pencil through
  Excalidraw in the web view.

---

## 13. Open questions for the user (asked by the orchestrator when they block, not before)

1. **The code to scan** (goal 4.7) — the server is not touched (D4) and prints no code today. Proposed: the phone's
   add-server screen takes a paste of the whole output of `remote setup` (address, fingerprint, secret parsed from
   it) and a QR code of the same text made by a small script on the server's machine
   (`scripts/server-code.sh`, `qrencode` if installed); the user accepts the fingerprint as always. Needs the user's
   yes before the script package runs.
2. Any spike's no-go (AD-35, AD-58, AD-61). (Electron, board web view, iOS net and composer: GO. Android net: open.)
   What the user is told at the end, from the spikes: the native composer's chips are flat and copy out as labels
   (AD-61); the iOS app turns ATS off and keeps "no plain HTTP" in code (AD-36).
3. (Settled by `rn-spike-electron`: the window keeps loading the page from `file://`; no question about a page scheme.)
