# Work packages of the React Native rewrite (Part A)

The work of `react-native-rewrite-goal.md`, split into packages that one agent finishes in one run. Every decision a
package needs is in `architecture.md` (named **AD-n** here); what must keep working is in `parity-inventory.md`
(851 rows named by their IDs, e.g. `A-SC-*`; its "Checks and tests of this area" tables map each old check to its rows). How agents work is `ORCHESTRATION.md`; testing rules are `AGENTS.md`.

## How to read a package

- **Model**: `Sonnet` (Sonnet 5.5, effort high) or `Opus` (Opus 5.5, effort high), as `ORCHESTRATION.md` says;
  escalation as written there (two Sonnet runs, then Opus).
- **Needs**: the packages that must be merged into `react-native-rewrite` before this one starts, and the spike reports
  it must read (under `plans/rn-rewrite/spikes/`). A package does not start before its needs are merged.
- **Makes**: the files it creates or changes; it changes nothing else (the "Do not touch" line names what is easy to
  touch by mistake).
- **Interface**: what it must satisfy, by its AD.
- **Accept**: the exact commands that must pass in the package's worktree, run by the agent before it reports and by
  the orchestrator before it merges. Commands run from the repository root unless they `cd`. The browser checks need
  Playwright as `AGENTS.md` says (`npm install --no-save playwright && npx playwright install chromium` in `web/`).
  No paid test, ever.
- **Parity**: the rows of `parity-inventory.md` the package makes true on the new build; **Checks** the old browser
  checks it ports to `web/dev/checks-app/` (AD-80) with the viewports. A ported check keeps the old one's ID, seeds
  and assertions; only its selectors and navigation change. A package that ports a check also adds a `testID`/
  `dataSet`/role to every element its checks need (AD-80).
- **Revisions**: a package changed by what a spike or a merged package found says so with **(revised after spike
  X)** or **(revised after package X)**, as in `architecture.md`. A package's text and the AD it names agree; where
  an older line seems to differ from a revision, the revision holds.
- Every package ends with the root `npm test` and `npm run check` passing, and, while the old page lives, with
  `cd web && npm test && npm run check` passing (AD-43). It reports as `ORCHESTRATION.md` says.

## Tracks and the DAG

```
Track F  foundation      F1 ─┬──────────────────────────────────────────────┐
                         F2 ─┴─ F3 ──────────────┐                          │
Track C  connection      C1 ─┬─ C2 ─┬─ N0 ─┬─ C4 ┤                          │
                             │      │      │     │                          │
                             └─ C5 ─┼──────┘     │                          │
                         F2 ─ C6 ───┘            │                          │
                         F2 ─ C3 ────────────────┤                          │
Track N  native modules  N0 ─ N1 (iOS) , N0 ─ N2 (Android) , U3 ─ N3 (keys) │
Track U  ui foundation   F1+F2 ─ U1 ─ U2 ─ T1 ─ U3 (needs F3, C3, C6)       │
Track B  board           B1 ─ B2 ─┬─ B3 (needs F3) ─ B6 ─ B4 (needs U3) ─ B5│
Track S  screens         T1 ─ S1 ─ S2 ; T1 ─ S3 ; T1 ─ S4 ─ {S5, S6, S7, S8, S9, S10} ; S3+C4 ─ S12
Track K  composer        U2 ─ K1 ─ K2 (native, from the spike) ; K1+S4 ─ K3 ─ {K4, K5, S11}
Track D  desktop         C3+T1 ─ D1 ─ … every screen package … ─ D2 ─ R1
Track I  install         N1+N2+B5 ─ I1
Track V  device tests    V1 (needs N1/N2, C4, C5, S12) ; V2 (B5) ; V3 (K2) ; V4 (K4, S12) ; V5 (C2, N0)
Track R  retirement      R1 (last)
```

## Start immediately (no need is open)

| Package | Model | Why it can start |
|---|---|---|
| **F1** workspaces and the Expo skeleton | Sonnet | new files only (`package.json`, `app/`) |
| **F2** move the non-visual code into `@aiwb/core` | Sonnet | only `web/src`, `web/test`, new `packages/core` |
| **C1** split `desktop/conn` into `@aiwb/conn` with ports | Opus | only `desktop/`, `web/dev/host.mjs` (one line), new `packages/conn` |
| **B1** the board bridge messages | Sonnet | new `packages/board-bridge` only |

They touch disjoint files; the orchestrator can run all four at once. Next as soon as their needs merge: F3 and C6
(after F2), C2 and C5 (after C1), C3 (after F2), U1 (after F1, F2), B2 (after B1), N0 (after F1, C2).

**Spikes** (revised): `rn-spike-electron`, `rn-spike-board-webview`, `rn-spike-ios-net` and `rn-spike-composer` have
reported, all GO (reports in `plans/rn-rewrite/spikes/`, code under `spikes/`); N1, B4's native host, B5, B6 and K2
build on them. **Waiting**: N2 on `rn-spike-android-net` (still running). A no-go of a spike stops its track and goes
to the user (architecture AD-35, AD-58, AD-61; goal 9).

**State on 2026-10-14** (when `rn-arch2` revised this file): merged into `react-native-rewrite`: F1, F2, F3, C1, C2,
C3, C5, C6, B1, B2, B3, K1, U1, U2. Branches started: T1, N0. The text of a merged package is kept as the record of
what it was asked; where what it built differs from what it was asked, the package says so (revised after package X)
and the later packages that depend on it are revised.

---

## Track F — foundation

### F1 — Workspaces and the Expo skeleton · Sonnet · needs: none
- **Goal**: an Expo SDK 57 app in `app/` that builds for web and type-checks for web and native, inside npm workspaces.
- **Makes**: root `package.json` (`private`, `workspaces: ["app", "packages/*"]`, scripts `test` and `check` that run
  every workspace's with `--workspaces --if-present`), root `package-lock.json`, root `.gitignore` additions
  (`app/ios/`, `app/android/`, `app/dist-web/`, `app/.env.local`, `packages/*/dist*/`); `app/` from
  `npx create-expo-app@latest app --template blank-typescript`, then: `app.config.ts` (AD-5 identity from env, `web:
  {output: "single", bundler: "metro"}`), `metro.config.js` (monorepo, AD-1), `tsconfig.json` +
  `tsconfig.native.json` + `tsconfig.web.json` (AD-4), `public/index.html` (today's `web/index.html` head with the
  theme pre-paint script, AD-40), `experiments.baseUrl: "."` (AD-40), `scripts/export-web.mjs` (AD-40, AD-41: the CSP
  `<meta>`; the Excalidraw fonts step left as a no-op hook until B2), `package.json` scripts `check`, `test` (`node --test --experimental-strip-types
  'test/**/*.test.ts'`), `build:web`, dependencies of AD-3 that the skeleton uses (`react-native-web`, `react-dom`,
  `@react-navigation/native`, `@react-navigation/native-stack`, `react-native-screens`,
  `react-native-safe-area-context`, `react-native-svg`, `expo-dev-client`), `src/App.tsx` showing "AI Whiteboard" with
  a `testID="app-root"`, and `app/test/smoke.test.ts` (one test that imports a module of `app/src`).
- **Interface**: AD-1, AD-3, AD-4, AD-5, AD-40.
- **Accept**:
  ```sh
  npm ci && npm test && npm run check
  cd app && npm run check && npm test && npm run build:web && test -f dist-web/index.html
  cd app && npx expo install --check
  node -e "const h=require('fs').readFileSync('app/dist-web/index.html','utf8'); if(/(src|href)=\"\/_expo|\/assets\//.test(h)) process.exit(1)"
  ```
  and `npx expo prebuild --no-install --clean --platform ios` and `--platform android` succeed in a temporary copy of
  `app/` (then delete the generated folders; nothing generated is committed).
- **Do not touch**: `web/`, `desktop/`.
- **As built** (revised after package F1, merged): `app/` uses **TypeScript 6.0.3** (Expo SDK 57 pins it; the packages
  keep 7, AD-1); the theme pre-paint script is the file `app/public/theme-init.js` loaded by `<script src>`, since
  the CSP allows no inline script (AD-40).

### F2 — Move the non-visual code into `@aiwb/core`, unchanged · Sonnet · needs: none
- **Goal**: goal 4.2 "moves unchanged": the logic, types, api, transport interface and their tests live in
  `packages/core`, and the old page builds from there.
- **Makes**: `packages/core/{package.json, tsconfig.json}` (name `@aiwb/core`, `exports: {"./*": "./src/*"}`, scripts
  `test` = `node --test --experimental-strip-types 'test/*.test.ts'`, `check` = `tsc --noEmit`, devDependencies
  `typescript`, `@types/node`); `git mv` of exactly the files of AD-2's table (and the tests and fixtures that import
  only them; list each test file you move in the report, and any test you leave in `web/test` with why); the old
  page's import lines changed to `@aiwb/core/…`; `web/build.mjs` esbuild `alias`; `web/tsconfig.json` `paths` and
  `include`; `web/package.json` `test` script without the moved tests.
- **Interface**: AD-1 (path alias), AD-2. A moved file's text does not change (`git diff -M --stat` shows 100 %
  renames for them).
- **Accept**:
  ```sh
  cd packages/core && npm install && npm test && npm run check
  cd web && npm test && npm run check && npm run build
  cd web && npm run uicheck -- P0.3 SEC.1 PL4.1 A5.2      # the old page still shows what it showed
  git diff -M --name-status react-native-rewrite -- packages/core/src | grep -v '^R100'   # prints nothing: every moved file is a pure rename
  ```
- **Do not touch**: `desktop/`, `app/`, the text of a moved file.

### F3 — The page's state layer into `@aiwb/core`, with seams · Sonnet · needs: F2
- **Goal**: the store, the page's connection to its stream, drafts, uploads and fork actions are shared, behind the
  seams of AD-2, and the old page registers today's behaviour into them.
- **Makes**: `packages/core/src/state/{store,conn,uploads,chatdraft,keptdrafts,version,actions,ports}.ts` (moved from
  `web/src`, with only the seam changes of AD-2's second table); `ports.ts` with `Kv` (`setKv`), `Ui` (`setUi`:
  `openChat`, `select`, `focusComposer`, `reportError`, `confirm`), `BoardSide` (`setBoardSide`, the eight functions
  `conn.ts` calls today; **as built, ten**: `forgetBoard` and `boardUnsaved` were added for the store, revised after
  package F3, AD-2, AD-55), and `flushBeforeReload`; the old page: `web/src/useStore.ts` (React hook over core's
  `subscribe/getState`), registration of the seams in `web/src/main.tsx`, imports updated; tests:
  `packages/core/test/seams.test.ts` (a store over a memory Kv reads and writes the keys of today; `conn.ts` calls
  the registered BoardSide).
- **Interface**: AD-2, AD-12. `@aiwb/core` keeps no import of `react`, the DOM, `@excalidraw/*` or a `.tsx` file:
  `grep -rE "from \"(react|@excalidraw)|\\.tsx\"|document\\.|window\\.|localStorage" packages/core/src` finds nothing
  (comments excepted; the check is in `seams.test.ts`).
- **Accept**:
  ```sh
  cd packages/core && npm test && npm run check
  cd web && npm test && npm run check && npm run uicheck      # all old checks: the old page is unchanged in behaviour
  node web/e2e/newchat.e2e.mjs                                # after cd web && npm run build
  ```
- **Do not touch**: `web/src/board.ts`, `web/src/apply.ts` (they stay for the old page), `desktop/`.

---

## Track C — the connection

### C1 — `@aiwb/conn`: the shared connection code with its three ports · Opus · needs: none
- **Goal**: goal D9: `desktop/conn` becomes `packages/conn`, platform-free in `core/`, with Node ports in `node/`;
  the desktop app and the test host behave exactly as before.
- **Makes**: `packages/conn/` as AD-10 lays it out (`index.js`, `index.d.ts`, `ports.d.ts`, `core/*`, `node/*`,
  `package.json` with `exports` `"."` and `"./node"`, `test` script); `desktop/test/conn/*` moved to
  `packages/conn/test/` with requires retargeted; `test/purity.test.js` (AD-10 rule); `core/utf8.js`,
  `core/abort.js`; `EventReader` on text (AD-11); `Session.stream` with a `TextStream`; `Store` port with the file
  store; `LocalPort`; the outcome `local_network_denied` in `core/outcomes.js` (AD-11); `desktop/package.json`
  dependency `"@aiwb/conn": "file:../packages/conn"`; `desktop/main.js`, `desktop/test/faces.test.js`,
  `desktop/e2e/app.e2e.mjs`, `web/dev/host.mjs` take `createNodeClient` from `@aiwb/conn/node` (host: the relative
  path); `desktop/electron-builder.yml` (no `conn/**`; the FileSet only if the `file:` dependency is not packed, AD-1);
  `AGENTS.md` and `docs/` lines that name `desktop/conn` now name `packages/conn`.
- **Interface**: AD-10, AD-11, AD-14. Every public answer of the Client (`call`, `picture`, `app`, `subscribe`
  envelopes, views, test results, words) is the same as before for the same server behaviour.
- **As built** (revised after package C1, merged): without a LocalPort every `owner.*` answers 404 **`no_owner`**
  (not `no_op`, which stays for an operation the LocalPort does not know); AD-10 now says so.
- **Accept**:
  ```sh
  cd packages/conn && npm test
  cd desktop && npm ci && npm test
  node --test web/dev/host.test.mjs web/dev/hostface.test.mjs
  cd web && npm run build && cd .. && node web/e2e/newchat.e2e.mjs && node web/e2e/remotechat.e2e.mjs && node web/e2e/localserver.e2e.mjs
  cd desktop && npm run e2e
  scripts/build-app.sh && test -d "bin/AI Whiteboard.app"   # the packaged app holds @aiwb/conn (start it once with AIWB_USER_DATA=$(mktemp -d) and see the window)
  ```
- **Do not touch**: what the module decides (states, words, waits, limits); `web/src`.

### C2 — Fakes, the core-on-fakes cases and the port contract · Sonnet · needs: C1
- **Goal**: goal 7.2: the shared connection code runs against fake ports with the desktop's cases; one contract
  states "the same pin rule and the same errors".
- **Makes**: `packages/conn/test/fakes/{scripted-server,fake-connector,memory-store}.js`;
  `packages/conn/test/core.test.js` (the cases of AD-15, timing lowered, `jitter: 0`);
  `packages/conn/test/contract/connector-contract.js` (`runConnectorContract(makeConnector, env)`: open with the pin,
  wrong pin → `cert_changed` with both fingerprints, no pin → `fingerprint` without dialing, `readCertificate`,
  refused port → `refused`, a non-TLS listener → `not_https`, a non-h2 server → `not_aiwb`, the stream's text in
  order, `fetch` `maxBytes` → `too_long`, `headersMs` → `timeout`, abort → AbortError, `close` ends requests) and
  `contract/node.test.js` that runs it on the Node connector against the stand-in.
- **Interface**: AD-11, AD-15.
- **Accept**: `cd packages/conn && npm test` (the new tests among them, each under a second alone; default set only).
- **Do not touch**: `core/` behaviour (a bug found is reported, and fixed only with the orchestrator's word).

### C3 — The desktop bridge builds the transport · Sonnet · needs: F2 · reads: `plans/rn-rewrite/spikes/electron.md` and `spikes/electron/` on branch `rn-spike-electron`
- **Goal**: goal 4.6 / 4.10: the preload makes the IPC transport (`window.aiwbTransport`), the cancel crosses as an
  identifier made in the preload and an `abort` object made by the page; `window.aiwbApp` stays for the old page.
- **Makes**: `desktop/preload.js` (AD-22, both surfaces; the new one from the spike's `bridge/preload.js`);
  `desktop/test/preload.test.js` (the spike's `preload.test.mjs` cases: id per call, cancel `{id}` once, none when
  already aborted or after the end or during a Blob read, body forms, the stream, `app`, `picture()`, `pickImages`);
  `desktop/test/bridge-e2e.test.js` (the spike's `endtoend.test.mjs`: adapter → model of contextBridge → preload →
  the real `createIpcFace`); `packages/core/src/transport/desktop.ts` (`desktopTransport(bridge)`, the spike's
  `bridgeTransport.ts`, AD-22) and its test; `transport/index.ts` `wayOf` per AD-20 (without `native` if C6 is not
  merged yet).
- **Interface**: AD-22. The main process and `ipcface.js` do not change.
- **As built** (revised after package C3, merged): `desktopTransport(bridge)` takes its bridge **from the caller**,
  with no `window.aiwbTransport` default: core's purity scan (`packages/core/test/seams.test.ts`) forbids `window.`
  in `@aiwb/core`. The app passes it: U3's `transport.web.ts` calls
  `useTransport(desktopTransport(window.aiwbTransport))` (AD-20).
- **Accept**:
  ```sh
  cd desktop && npm test
  cd packages/core && npm test && npm run check
  cd web && npm test && npm run check && npm run build && cd ../desktop && npm run e2e   # the old page over aiwbApp still works
  ```
- **Do not touch**: `desktop/main.js`, `desktop/ipcface.js`.

### C4 — The native transport · Sonnet · needs: C1, C2, C5, C6, N0
- **Goal**: goal 4.6, D8: the in-process transport of iOS and Android, over the Client of `@aiwb/conn` with the
  native ports; background and return.
- **Makes**: `app/src/platform/transport.native.ts` (AD-21) (not `transport.web.ts`: U3 makes it, revised after
  package C3), `app/src/platform/picture.native.tsx`'s fetch-and-cache function `pictureFile()` (AD-25; the
  component is U2's shell, which asks the seam `setPictureAddress`; the native registration is
  `(s, c, i) => transport().picture(s, c, i)`, which ends in `pictureFile`), and in that shell the broken tile for an
  address that is not `file://` (AD-36 point 3, with a test), `app/src/platform/imagepick.native.ts` (AD-26); in `@aiwb/conn`: `Client.wake()` (AD-21) with a
  core test; `app/test/transport.native.test.ts`: the transport over `createClient` with the fake module (N0) and
  `memoryStore`, a call with abort, the stream's envelopes in order and `closed` after `wake` ends nothing,
  `app` ops answered as text, `picture()` writes once and answers the cached file the second time (fake
  `expo-file-system`), `pickImages` refuses a 6 MB file and a PDF.
- **Interface**: AD-20, AD-21, AD-25, AD-26.
- **As built** (revised after package C4): the logic is platform-free and tested on fakes under `node --test`, the
  `.native` files only wire the real modules: `nativetransport.ts` (`createNativeTransport(client, {appState, cache,
  pickImages})`), `picturefile.ts` (`pictureFile`, `PictureError` with `.status`, the cache path is validated),
  `picturecache.ts` (over a given `expo-file-system`; written beside its place and moved in), `imagepickcore.ts`
  (`pickImagesWith(picker, fs)`), `pictureuri.ts` (`isFileUri`). `transport.native.ts` exports `createNativeClient()`
  (connector `nativeConnector(AiwbNetModule)`, `serverStore()`, `local: null`, `timing` from
  `EXPO_PUBLIC_AIWB_APP_WAITS`, `random` from `expo-crypto`) and `nativeTransport(client)`; U3 calls
  `useTransport(nativeTransport(createNativeClient()))` and registers `setPictureAddress`. The `AppState` listener lives
  as long as the stream (`active` → `client.wake()`); the transport never reports `closed` by itself. `expo-file-system`
  and `expo-image-picker` were added; the `expo-image-picker` config plugin entry (photo-library text) is **not** in
  `app.config.ts`: N1/N2 add it (AD-5). `[not verified]`: RN's `AbortController` against the core's fake-port suite in a
  simulator (AD-10), and `File.move`/`write` of `expo-file-system` on a device.
- **Accept**: `cd app && npm test && npm run check`; `cd packages/conn && npm test`.
- **Do not touch**: `core/` behaviour of `@aiwb/conn` beyond `wake`.

### C5 — The phone's Store · Sonnet · needs: C1, F1
- **Goal**: goal D11: secrets in the secure storage, the rest of the list in MMKV, a generated client id.
- **Makes**: `app/src/platform/serverstore.native.ts` (AD-13) and `app/test/serverstore.test.ts` with fakes of
  `react-native-mmkv` and `expo-secure-store` (a list round-trips; no secret in MMKV; a missing secret sets the list
  aside with a notice; a removed entry's secret is deleted; `clientId` is made once); adds `react-native-mmkv`,
  `react-native-nitro-modules`, `expo-secure-store` to `app/package.json` with `npx expo install`; `kv.native.ts` and
  `kv.web.ts` (AD-12).
- **Interface**: AD-11 `Store`, AD-12, AD-13.
- **Accept**: `cd app && npm test && npm run check`.
- **As built** (revised after package C5, merged): the logic is `serverstorecore.ts` (platform-free, tested on
  fakes), `serverstore.native.ts` wires MMKV, `expo-secure-store` and `expo-crypto`'s `randomUUID`; secret deletes
  are asynchronous and kept in `pending-secret-deletes` until done (AD-13). `expo-crypto` was added. The
  `expo-secure-store` **config plugin entry is not in `app.config.ts`**: N1 adds it (AD-5).

### C6 — `picture()` on the transport · Sonnet · needs: F2
- **Goal**: goal D12: the address of a picture can be given asynchronously, without a screen knowing the platform.
- **Makes**: `packages/core/src/transport/{types,http,ipc}.ts` (`picture()` added, `pictureURL` optional, `way`
  gains `"native"`, `wayOf` gains `native`, AD-20); `logic/chatimage.ts` `imageAddress()` (an addition); tests in
  `packages/core/test/transport.test.ts` and `chatimage.test.ts`.
- **Accept**: `cd packages/core && npm test && npm run check`; `cd web && npm test && npm run check && npm run uicheck -- R3.12 IM3.5`.
- **Do not touch**: the old page's `imageUrl` callers.

---

## Track N — native modules

### N0 — `aiwb-net`: contract, fake and JS adapter · Sonnet · needs: F1, C2
- **Goal**: goal 6 "a native module has a contract, and the contract is tested against a fake".
- **Makes**: `app/modules/aiwb-net/` (Expo module scaffold: `npx create-expo-module@latest --local aiwb-net`, with the
  native sides left as stubs that reject `not implemented`), `src/AiwbNet.ts` (AD-30, the TypeScript of the contract),
  `src/fake.ts` (AD-33, the error table of AD-31/AD-32), `README.md` (the contract and the error mapping table, the
  text N1/N2 implement); `app/src/platform/net/nativeConnector.ts` (the `Connector`/`Session` ports over the module:
  timers for `limitMs`, abort → `cancel`, `chunk`/`end` events → `TextStream`); `app/test/nativeConnector.test.ts`
  running `runConnectorContract` (C2) on the adapter with the fake.
- **Interface**: AD-11, AD-30, AD-33.
- **Accept**: `cd app && npm test && npm run check`.

### N1 — `aiwb-net` on iOS · Sonnet (Opus if it fails twice) · needs: N0 · reads: `spikes/ios-net.md` and `spikes/ios-net/`
- **Goal**: goal D10 on iOS: the trust hook and the session of AD-31, behind N0's contract.
- **Makes** (revised after spike ios-net):
  - `app/modules/aiwb-net/ios/*.swift` from the spike's `spikes/ios-net/app/modules/aiwb-net/ios/AiwbNetModule.swift`
    (proven on the simulator), changed as AD-30/AD-31 now say: typed `Record` options and a coded exception (the
    spike's untyped numbers were silently ignored); `openSession` makes the **probe** `GET /api/hello` without the
    secret and judges `h2` on it (the spike's `openSession` did not dial); the refused certificate kept **per task**;
    the URL built in one function `httpsURL(host, port, path)` (AD-36); bodies as `Uint8Array` if Expo's typed
    arrays work, else base64 (AD-30); the spike's UTF-8 chunker and its every-cut self-test kept;
  - `app.config.ts`: `ios.infoPlist.NSAppTransportSecurity = { NSAllowsArbitraryLoads: true }` (exactly that dict,
    AD-36) and the `expo-secure-store` plugin entry (AD-5; check the option's name in the installed package);
  - `app/test/appconfig.test.ts` (the ATS dict is exactly `{NSAllowsArbitraryLoads: true}`) and
    `app/test/noplainhttp.test.ts` (the scan of AD-36 point 2);
  - the module's `README.md`: the error table as built, and how many times URLSession retried a dropped GET against a
    tripwire server (AD-31);
  - nothing else in JS but bug fixes of the adapter agreed with the orchestrator.
- **Accept**: on an iOS simulator of your own (`ORCHESTRATION.md`), with a scratch server: the dev build (prebuilt
  with `--clean`, AD-5) runs the contract self-test (`app/src/dev/NetSelfTest.tsx`, which runs
  `runConnectorContract` against the real module and a scratch server whose address/fingerprint/secret come from
  `EXPO_PUBLIC_AIWB_SELFTEST_*`) and shows "net self-test ok", once with the server reached as `127.0.0.1` and once
  by a **dotted name** (`localtest.me`, which resolves to 127.0.0.1, on the server's certificate by `remote setup
  -name localtest.me`): `node app/e2e/run.mjs net-selftest --platform ios` (the runner is V5's; until V5 merges, run
  the Maestro flow by hand as its README says and paste the output). Also `cd app && npm test && npm run check`, and
  `plutil -p` of the installed app's `Info.plist` shows the ATS dict of AD-36 and nothing else in it.

### N2 — `aiwb-net` on Android · Sonnet (Opus if it fails twice) · needs: N0 · reads: `rn-spike-android-net`
- **Goal and Makes**: as N1 for Android (`app/modules/aiwb-net/android/**/*.kt`, AD-32).
- **Accept**: as N1 with `--platform android` on the AVD `Medium_Phone_API_36.1`, under the emulator lock and with
  `adb reverse` (`ORCHESTRATION.md`).

### N3 — `aiwb-keys`: hardware-keyboard shortcuts · Sonnet · needs: U3
- **Goal**: goal 4.4: a tablet with a hardware keyboard has the desktop's shortcuts where they make sense.
- **Makes**: `app/modules/aiwb-keys/` (iOS `UIKeyCommand`, Android `dispatchKeyEvent`, AD-73), `app/src/platform/keys.native.ts`.
- **Accept**: `cd app && npm run check`; on an iPad simulator with the hardware keyboard on, ⌘B hides the sidebar and
  ⌘N makes a chat (a Maestro flow `keys.yaml` with `pressKey` where Maestro supports it, else by hand with a
  screenshot in the report).

---

## Track U — the UI foundation

### U1 — Theme tokens, theme, icons · Sonnet · needs: F1, F2
- **Makes**: `app/src/ui/tokens.ts` (AD-74) and `app/test/tokens.test.ts` (parses `web/src/styles.css` and
  `web/src/flavours.css` and compares every variable; after retirement it compares with a fixture it wrote, so the
  test keeps the colours), `app/src/ui/theme.tsx` (`ThemeProvider`, `useTokens`, `useTheme` over `logic/theme.ts` and
  the kv port; native follows `Appearance`), `app/src/ui/icons.tsx` (today's `icons.tsx` in `react-native-svg`).
- **Accept**: `cd app && npm test && npm run check && npm run build:web`.

### U2 — Primitives · Sonnet · needs: U1
- **Makes**: `app/src/ui/` `Text`, `Button`, `IconButton` (title → tooltip on web, accessibilityLabel everywhere),
  `Overlay` with `Popover`/`Dialog`/`Sheet` (AD-70), `Menu`, `Resizer`, `usePointer`, `breakpoints.ts` (`layoutOf`,
  `useLayout`, AD-72), `tid.ts` (AD-80 conventions, `dataSet` typing), `app/src/platform/keys.web.ts` (AD-73),
  `picture.web.tsx`/`picture.native.tsx` component shells (AD-25; native uses C4's `pictureFile` once merged, a
  placeholder until then); a gallery screen `app/src/dev/Gallery.tsx` (shown when the URL has `?gallery`, web only)
  that renders every primitive for the checks; tests of `layoutOf`.
- **Checks**: new `L1-primitives.mjs` at desktop, tablet, phone: each overlay opens, closes on Esc/backdrop/back,
  keeps focus inside on web, is a sheet on phone and a popover on desktop.
- **Accept**: `cd app && npm test && npm run check`; `cd web && APP=1 npm run uicheck -- L1` (after T1; until then
  the agent runs the check file directly as its header says).
- **As built** (revised after package U2, merged): `<Picture>` asks a **registered seam**, `setPictureAddress(fn)` in
  `app/src/platform/picturecommon.tsx` (with nothing registered it draws the broken tile); U3 registers it (AD-25).
  The overlays sit on RN `Modal`. `react-native-gesture-handler` is **2.32** (what SDK 57 pins; AD-3 said 3).

### U3 — The app shell · Sonnet (Opus if it fails twice) · needs: U2, F3, C3, C6
- **Goal**: the app starts as the page does and shows the right layout at every width.
- **Makes**: `app/src/App.tsx` bootstrap (AD-76), `app/src/screens/shell/` (`Layout` with the split view of today's
  `App.tsx` `Grouped` on tablet/desktop and the stack of AD-71 on phone: `stackOf(state)` and its test; `SideRail`,
  `Pane`, `Home`, `BoardBar` without the canvas, `Guard`), the shortcuts ⌘B, ⌘J, ⌘N through the keys port, the
  confirm dialog; web flush hooks and `window.aiwbFlush`; registration of the Ui seam;
  `app/src/platform/transport.web.ts` (revised after package C3: `wayOf()` → `ipc`:
  `useTransport(desktopTransport(window.aiwbTransport))`, `http`: `httpTransport()`, none: "AI Whiteboard runs in
  its app."; AD-20) with a test of the choice on fake windows; the registration of the picture address
  `setPictureAddress((s, c, i) => transport().picture(s, c, i))` (revised after package U2, AD-25).
- **Parity**: the shell rows of area A that are not the sidebar's (layout, panes, widths, hiding, home, keys).
- **Checks**: A1.2, A1.3, A1.4, A1.5, P7.2 (desktop, tablet; phone where the row says all); new `L2-layouts.mjs`
  (each width gives its layout; phone back/forward follows `sel`).
- **Accept**: `cd app && npm test && npm run check`; `cd web && APP=1 npm run uicheck -- A1 P7.2 L2`.

### T1 — The check harness for the new build · Sonnet · needs: U2
- **Goal**: goal 7.1: the browser checks run on the web build at three viewports.
- **Makes**: `web/dev/shot.mjs` `buildAppDist()` (AD-42), `check()` running a body per viewport with
  `{page, viewport, layout}`; `web/dev/viewports.mjs`; `web/dev/uicheck.mjs` `APP=1` (runs `dev/checks-app/`, builds
  the app's web build once, honours `DIST`); `web/package.json` script `uicheck:app`; `web/dev/checks-app/sel.mjs`
  (AD-80 helpers: `byTid`, `openChat`, `openBoard`, `back`, `openMenu`, `longPress`, `touchDrag`);
  `web/dev/checks-app/README.md` (how to port a check: what stays, what changes, how to declare viewports); the port
  of P0.7 (the driver's screenshot comparison, on the gallery); U2's `L1` moved under the runner. The tooling checks
  that measure the composer (P0.1, P0.5, P0.6) are ported by K3, and P0.3 (the smoke of every seeded state) grows with
  each screen package: each adds the states it draws.
- **Accept**: `cd web && npm run uicheck:app -- P0.7 L1` passes at its viewports; `cd web && npm run uicheck -- P0.3`
  (old) still passes.

---

## Track S — screens (each ports the checks of its area)

Every screen package: builds in `app/src/screens/<area>/` with `ui/` primitives (AD-70); uses only `@aiwb/core` for
behaviour; adds testIDs; ports its checks; **Accept** = `cd app && npm test && npm run check` and
`cd web && npm run uicheck:app -- <its checks>`, plus `cd web && npm run uicheck -- <the same IDs>` still passing on
the old page. A package lists in its report the inventory rows it made true and the `none` rows of its area for which it
added a check.

| ID | Package | Model | Needs | Parity rows | Checks to port (viewports) |
|---|---|---|---|---|---|
| **S1** | Sidebar: sections, heads and states, rows, groups, collapse, "+" menus, rename, archive, delete, show archived, foot, theme picker in the foot | Sonnet | T1, U3 | A-SB, A-SC, A-ST (sidebar side), A-TH (picker) | SEC.1, SEC.2, SEC.3, SEC.4, SEC.5, SEC.6, SEC.8, SEC.9, AAC.1, AAC.3, A6.1, A6.2 (all three) |
| **S2** | Sidebar drag and drop: mouse drag, touch long-press drag, the drop mark | Sonnet | S1 | A-DD | A3.2, A3.3 (desktop mouse, tablet touch) |
| **S3** | **Servers** dialog: list, add, edit, test (steps), accept the fingerprint, remove, notices; the owner's things for this computer (desktop) | Sonnet | T1, U3 | A-SV, A-OW | the Servers parts of SEC.2 and AAC.1/AAC.2 not ported by S1; new `L7-servers.mjs` (the add and edit flows, which have no browser check today: inventory finding 8) on the mock (all three) |
| **S4** | Chat view: header and chrome, thread list (LegendList), messages, streaming and scroll anchoring, empty and error states, read-only when the server is away | Sonnet | T1, U3 | B-TH, B-SM, B-HD, B-RO | SEC.10, SEC.7 and AAC.2 (chat side) (all three); new `L8-stream.mjs`: the thread stays at the end while an answer streams and stays put when the user scrolled up (B-SM rows, untested today: inventory finding 6) (all three) |
| **S5** | Markdown and code: remark → RN renderer, block memo, code highlight, displayed text (AD-75) | Sonnet | U1 | B-MD | the markdown parts of A6.3 (all three); a unit test that `displayedText` equals what `quoteDom.ts` reads for the fixtures of `web/test/quotes.test.ts` |
| **S6** | Tool cards and permission cards | Sonnet | S4, S5 | B-TC, B-PM | A5.2, A5.3, A5.4 (all three) |
| **S7** | Subagents: rows in the thread, the drawer (a pushed screen on phone), the Subagents settings chip | Sonnet | S4, K3 | B-SA, C-SS | S1.1 (all three) |
| **S8** | Branch and fork actions, waits of the fork flows, the chat tree popup, labels | Sonnet | S4, U2 | B-FK, B-TR, B-LB | A4.2, A4.3, A4.4 (all three) |
| **S9** | Context ring and usage popup | Sonnet | S4 | B-US | the usage parts of P0.3 and A2.4 (all three) |
| **S10** | Images in a sent message, the large view, `<Picture>` on every way | Sonnet | S4, C6 (C4 for native) | B-IM, D-PC | IM3.5, R3.12 (all three) |
| **S11** | Prompt library: the library popup, the insert popup (⌘P and Insert), the tree | Sonnet | K3 | C-PL | PL4.1, PL5.1, PL5.2, PL6.1 (all three) |
| **S12** | Adding a server on a phone: paste (address + secret, or the whole `remote setup` output), scan a code (`expo-camera`), accept the fingerprint, the local network explanation and `local_network_denied` (AD-34) | Sonnet | S3, C4 | goal 4.7 rows (new) | new `L3-addserver.mjs` at phone (paste path; scan is device-only, V4) — **the scan half waits for the user's answer on the code (architecture §13.1)** |

## Track K — the composer

### K1 — The chip input contract and its web implementation · Sonnet · needs: U2
- **Makes**: `app/src/platform/chipinput/{types.ts, ChipInput.web.tsx, ChipInput.native.tsx (a plain TextInput stub
  marked as such)}` (AD-60, AD-61 web), `app/test/chipvalue.test.ts` (value round trips through
  `parseRefs`/`serializeRef`), a gallery entry.
- **Parity**: C-RF rows (web).
- **Checks**: P7.4 (⌘L, ⌘⇧L; desktop, tablet with keyboard); new `L4-chips.mjs` (the chip behaviours of AD-60 at
  desktop and tablet touch).
- **Accept**: common, with those checks.
- (revised after spike composer) **Unchanged in approach**: the web box stays today's `contenteditable` (AD-61's
  decision). `types.ts` must hold the **whole** AD-60 contract (`insertRef`, `replaceBeforeCaret`, `set`,
  `openInsert`, `focus`; `placeholder`, `onChange(value, beforeCaret)`, `onKey`, `locked`, `readOnly`, `onImages`),
  with offsets in characters of the value, since K2 implements the same type.

### K2 — The chip input on iOS and Android · Opus · needs: K1 · reads: `spikes/composer.md` and `spikes/composer/`
- **Goal**: goal 9's hardest risk: a native text input that holds inline board-reference chips with the contract of
  AD-60, by the approach the spike proved on iOS (revised after spike composer: AD-61).
- **Makes**:
  - `app/src/platform/chipinput/chipdoc.ts` from `spikes/composer/src/logic/chipdoc.ts` (platform-free; `refs.ts`
    imported from `@aiwb/core`, never copied), and `app/test/chipdoc.test.ts` from the spike's 13 tests, plus tests of
    the offset mapping between the value and the shown string (`replaceBeforeCaret`, `beforeCaret`, AD-60);
  - `app/src/platform/chipinput/ChipInput.native.tsx` (replacing K1's stub) from the spike's `ChipInput.tsx` and
    `ChipField.tsx`: the controlled multiline `TextInput` with `Text` children and the `selection` prop, the whole
    AD-60 contract (`replaceBeforeCaret`, `openInsert`, `onKey` from `onKeyPress`, `locked`, `readOnly` as
    `editable={false}` with the chips still selectable and copyable, C-RF-25), and the **two rules** of AD-61 (tell
    the owner from the handler that made the change; never re-apply a selection the field just reported); no
    library added;
  - the dev-only gallery entry `?gallery=chipdoc` (the spike's `ChipField.web.tsx`, under `app/src/dev/`, never used
    by the composer) and `web/dev/checks-app/L4b-chipdoc.mjs` ported from the spike's `checks/web.mjs` (desktop and
    phone viewports);
  - **Android first**: before the rest, the spike's component on the emulator (lock held, `ORCHESTRATION.md`):
    fast typing with Gboard's suggestions on, the `selection` prop and arrows, a hardware keyboard. If it fails, stop
    and report: approach (c) on Android is the orchestrator's decision (AD-61);
  - a section in `docs/` or the component's header listing what does not hold on native (flat chips; copy out gives
    labels; IME, autocorrect next to a chip, undo, handle drag unverified), for the final report.
- K1's `types.ts` (merged) is the contract; its header says a copy puts the tags on the clipboard, which the native
  box does only within itself (AD-61): K2 adds that exception to the header rather than changing the contract.
- **Accept**: `cd app && npm test && npm run check`; `cd web && npm run uicheck:app -- L4b`; the Maestro flow
  `composer-chips.yaml` and the iOS XCUITest keys (V3's; until V3 merges, the spike's `checks/ios.mjs` way, output
  pasted) pass on the iOS simulator and the Android emulator.

### K3 — The composer · Sonnet (Opus if it fails twice) · needs: K1, S4
- **Makes**: `app/src/screens/composer/` (AD-62): toolbar chips (agent, folder, model, effort), the fit of
  `logic/composerfit.ts`, send/stop, Enter/Shift+Enter, the @ mention popup, the error line, drafts, read-only and
  locked, new-chat choices (ChatChoices), the "Add selection"/"Point at" buttons on touch.
- **Parity**: C-TX, C-MN, C-DR, C-CH, C-NC, C-RO.
- (revised after spike composer) The composer talks to the box only through the AD-60 contract, so it is the same on
  every target. On native, `onKeyPress` reports Enter but cannot keep the multiline field from taking it as a new
  line `[not verified]`, so K3 settles how Enter sends there against the C-TX rows (the chip input then removes the
  new line it took) and says so in its report; a hardware keyboard's other keys come through the keys port (AD-73). The native box's known differences
  (AD-61) are not the composer's to fix.
- **Checks**: A2.2, A2.3, A2.4, A2.5, A2.6, P7.1, P7.3, P0.1, P0.5, P0.6 (fixture written again) (all three where the
  rows say).

### K4 — Images in the composer · Sonnet · needs: K3, C4
- **Makes**: the image strip, paste (web), the attach button (desktop dialog / web file input / device picker,
  AD-26), upload states, limits and refusals, a model with no images.
- **Parity**: C-IM. **Checks**: IM3.2 (all three).

### K5 — Quotes · Sonnet · needs: K3, S5
- **Makes**: `app/src/platform/quote.web.ts` (today's `quoteDom.ts`), `quote.native.tsx` (the long-press Quote sheet,
  AD-64), the quote chips in the composer, showing where a quote points.
- **Parity**: B-QS, C-QT. **Checks**: the quote parts of P7.4 and P0.3 (desktop, tablet); new `L5-quote.mjs` at phone
  (the sheet path runs in the browser too: long press → sheet → select → Quote).

## Track B — the board

### B1 — The board bridge messages · Sonnet · needs: none
- **Makes**: `packages/board-bridge/` (`package.json`, `tsconfig.json`, `src/messages.ts`, `src/validate.ts`,
  `test/messages.test.ts`) exactly as AD-50, with the element, files and appState types loose (`El = Record<string,
  unknown>` with `id: string`, `version: number`).
- **Accept**: `cd packages/board-bridge && npm install && npm test && npm run check`.

### B2 — `@aiwb/board-view`: Excalidraw behind the endpoint · Sonnet (Opus if it fails twice) · needs: B1, F1
- **Makes**: `packages/board-view/` (AD-51): `src/endpoint.ts`, `src/apply.ts` (copy of `web/src/apply.ts`,
  imports only), `src/export.ts` (the drawing part of today's `getImage`), `src/CanvasFilters.tsx`, `src/BoardView.web.tsx`,
  `src/webview/{entry.tsx,index.html}`, `build.mjs` (`npm run build:webview` → `dist-webview/`); `app/scripts/export-web.mjs`
  copies Excalidraw's fonts (the hook of F1); a test page `packages/board-view/dev/harness.html` + a Playwright
  script `dev/harness.mjs` that loads `dist-webview/index.html` from `file://` in Chromium, sends `load`, `req apply`,
  `req export`, and checks the answers (the bridge without RN).
- **Accept**: `cd packages/board-view && npm test && npm run check && npm run build:webview && node dev/harness.mjs`.
- **As built** (revised after package B2, merged): as asked, with `dist-webview/` as a folder (`index.html`,
  `board.js`, `board.css`, `fonts/`) and `aiwbBoardReceive` through `injectJavaScript`, `changed` with the whole
  scene, and `export-web.mjs` copying Excalidraw's fonts. B2 found that Metro cannot take Excalidraw into the web
  build as planned (the `production` condition, ~127 chunks, an unlinked CSS, a font path that 404s, locales and
  Mermaid bundled); the decision is AD-40: Metro never bundles Excalidraw, the web build loads board-view's esbuild
  build. B6 makes the changes.

### B3 — The board side of the app · Opus · needs: B1, F3
- **Goal**: today's `board.ts` behaviour on the message channel (AD-55), registered as the BoardSide.
- **Makes**: `packages/core/src/board/` and `packages/core/test/board/*.test.ts` on a fake channel: load and restore,
  autosave debounce and order, revision conflicts, roles, flush with `snapshot`, each board tool's answers and errors
  (the texts of `web/src/board.ts`), selection and point refs, `buildContext`. The BoardSide it registers has the
  **ten** members of `packages/core/src/state/ports.ts` (revised after package F3: `forgetBoard`, `boardUnsaved`
  besides the eight). `changed` is still the whole scene when B3 is built; B6 turns the mirror to the deltas of
  AD-50 (revised after spike board-webview), so B3 keeps the mirror's update in **one function** that B6 replaces.
- **Accept**: `cd packages/core && npm test && npm run check`.

### B6 — board-view's two targets, `changed` as deltas, `postMessage` in · Sonnet (Opus if it fails twice) · needs: B2, B3 · reads: `spikes/board-webview.md`, `spikes/board-webview/`
- **Goal** (new, after spike board-webview and package B2): one esbuild build of Excalidraw for the web build and the
  web view (AD-40, AD-51), a `changed` that carries only what changed (AD-50), the web view page as the spike proved it.
- **Makes**:
  - `packages/board-view/build.mjs`: two targets from one configuration (the `slim` plugin, Xiaolai out):
    `npm run build:web [-- --out <dir>]` (default `../../app/public/board/`): `board.js` (IIFE defining
    `window.aiwbBoardView = { mount(element, post, options) → { receive, unmount } }`, wrapping `BoardView.web.tsx`),
    `board.css`, `fonts/`, with `EXCALIDRAW_ASSET_PATH` the folder `board.js` was loaded from; and
    `npm run build:webview`: **one** `dist-webview/board.html` with script, style and fonts inside and the CSP of
    AD-51 by hash (the spike's `webview/build.mjs` and `fontshim.js` are the template);
  - `src/web/entry.tsx` (the web target) and `src/web/api.ts` (the type of `window.aiwbBoardView`, **no** Excalidraw
    import, for the app's type check);
  - `src/webview/entry.tsx`: `message` listeners on `window` and `document` added before render, events with
    `source === null` only; `aiwbBoardReceive` kept for the harness only; `ready` after the handlers are bound (AD-50);
  - `packages/board-bridge`: `changed` as AD-50 now says (`elements` changed since last told, `order?`, `files?`
    added only), its validator and tests (a mirror fed with `load` + the `changed` of a scripted drawing equals the
    scene);
  - `src/endpoint.ts`: the per-board baseline (id → version from `load`, the last `snapshot`, each `changed`), sends
    the delta; `packages/core/src/board/side.ts`: B3's `changed(board, elements, appState, files, style)` applies the
    delta to the kept scene (elements by id and version, ordered by `order`, files **added** to the kept ones, where
    B3 replaces them whole), with tests beside B3's in `packages/core/test/board/`;
  - `app/scripts/export-web.mjs`: runs board-view's `build:web` before `expo export`, no longer copies the fonts into
    `dist-web/fonts/`; `app/public/index.html`: `<link rel="stylesheet" href="./board/board.css">` and
    `<script src="./board/board.js" defer>` before the app's bundle; `.gitignore`: `app/public/board/`;
  - `dev/harness.mjs`: drives `board.html` (one file) and the web target under the web build's CSP, with the new
    `changed`.
- **Interface**: AD-40, AD-50, AD-51. Metro gets no `unstable_conditionNames` change; the app imports nothing of
  board-view but `src/web/api.ts` types (and, on native, the `board.html` asset, B4/B5).
- **Accept**:
  ```sh
  cd packages/board-bridge && npm test && npm run check
  cd packages/board-view && npm test && npm run check && npm run build:web && npm run build:webview && node dev/harness.mjs
  cd packages/core && npm test && npm run check
  cd app && npm run build:web && test -f dist-web/board/board.js && test -f dist-web/board/board.css && test ! -d dist-web/fonts
  ```
- **Do not touch**: `web/src` (the old page keeps its board), the endpoint's behaviour beyond `changed` and the wiring.

### B4 — The board screen · Sonnet (Opus if it fails twice) · needs: B6, U3 · reads: `spikes/board-webview.md` and `spikes/board-webview/app/BoardView.tsx`
- **Makes**: `app/src/platform/board.web.tsx` (mounts `window.aiwbBoardView`, AD-40, AD-52) and `board.native.tsx`
  (AD-52 as revised: `originWhitelist={["*"]}` with `onShouldStartLoadWithRequest` allowing only the page's own
  file, a refused `http(s)` URL offered to the user by a confirm dialog; iOS `allowingReadAccessToURL`, Android
  `allowFileAccess` and `setSupportMultipleWindows={false}`; `incognito`, no cache, no injected JavaScript, messages in
  by `postMessage`; a `key` and the process-ended handler that loads again from the mirror; a queue until `ready`;
  **one web view first**: board-not-on-screen requests to the visible view, a hidden engine view only when none is
  mounted, ended 60 s after its last request; `textInteractionEnabled` tried with the text tool and chosen, the
  report says which),
  `app/src/screens/board/` (the canvas area, overlays, `TakeoverPanel`, `BoardOff`, `SaveBanner`, the board bar with
  its chats button, ⌘L/⌘⇧L board side, the pick layer), registration of the BoardSide.
- **Parity**: D-BD, D-SV, D-AG, D-TK, D-CT, D-SL, D-RB. **Checks**: P7.5 (all three), the board parts of P7.4, SEC.7,
  AAC.2 (all three); and, because no free check covers an agent's board tools today (inventory finding 3), an `rpc`
  knob in `web/dev/mock.mjs` (it sends a board tool call as the server relays one, and records the page's answer) with
  the new check `L6-agenttools.mjs`: `apply`, `delete_elements`, `get_image` (a PNG comes back with its bounds) and
  `show_board` through the page, at desktop and phone, on the web build and, as the reference, on the old page.
- **Accept**: common; plus `node web/e2e/newchat.e2e.mjs` with `APP=1 DIST=app/dist-web` (after D-scripts exist: AD-82).

### B5 — Shipping the board page in the native app · Sonnet · needs: B4 · reads: `spikes/board-webview.md`
- **Makes** (revised after spike board-webview): the page as a **Metro asset** (AD-56): `app/metro.config.js` adds
  `"html"` to `resolver.assetExts`, `expo-asset` added with `npx expo install`, `board.native.tsx` loads
  `require("@aiwb/board-view/dist-webview/board.html")`; the `app` script `prebuild:board` (runs `build:webview`)
  that the install script, the device-test runner and a developer's build go through; **Android**: the order of
  AD-56 (Metro asset, then `source={{html, baseUrl}}`, then `app/plugins/withBoardAssets.js` copying into
  `android_asset`), the first that loads in a **Release** build on the emulator, and the report says which and why;
  check that the page receives `postMessage` on Android (`window` or `document`, AD-51);
  `app/src/dev/BoardSelfTest.tsx` (AD-83 flow 2), `app/e2e/maestro/board-webview.yaml`.
- **Accept**: the flow passes on the iOS simulator and, in a Release build, on the Android emulator (V2 runs it; this
  package runs it once); no `withBoardAssets` on iOS.

## Track D — the desktop app on the web build

### D1 — The window runs the web build · Sonnet · needs: C3, T1, U3 · reads: `rn-spike-electron`
- **Goal**: goal 7.3 on the web build, not yet the default.
- **Makes**: `app/scripts/export-web.mjs` relative-path rewrite proved under `file://` (AD-41), with the board's
  `./board/` files of AD-40 (B6) loading there too (revised after package B2);
  `desktop/e2e/app.e2e.mjs` on `AIWB_PAGE` (AD-44) observing through `aiwbTransport`; nothing in `main.js` but what
  the web build needs (none expected). Needs B6 merged for the board part of the check; without it D1 proves the
  rest and says so.
- **Also**: `main.js` reports a blank page (AD-41: `window.aiwbReady` not set within 10 s after `did-finish-load`),
  with a test in `desktop/test/`; the e2e's `window.process` assertion as AD-44 says; Excalidraw in the page works
  under the CSP's `connect-src 'none'` (or the report says what it needed).
- **Accept**: `cd app && npm run build:web && cd ../desktop && npm test && AIWB_PAGE=../app/dist-web/index.html npm run e2e`;
  `cd desktop && npm run e2e` (old page) still passes.

### D-e2e — The web e2e scripts on the web build · Sonnet · needs: D1, S1, S4, K3, B4
- **Makes**: AD-82 in `web/e2e/*.e2e.mjs` and `web/e2e/lib/rig.mjs` (`DIST`, `APP=1` selectors from `sel.mjs`).
- **Accept**: `cd app && npm run build:web && cd .. && APP=1 DIST=app/dist-web node web/e2e/newchat.e2e.mjs`, the same
  for `twopages`, `remotechat` (desktop and phone viewport), `localserver`; and each without `APP` on the old page.

### D2 — The desktop app switches to the web build · Sonnet · needs: every S, K, B package, D-e2e, U3, and every
ported check passing
- **Makes**: `desktop/lib.js` `pagePath` default to the web build (AD-41), `scripts/build-app.sh` builds `app/dist-web`,
  `desktop/electron-builder.yml` `extraResources` from `../app/dist-web`, docs lines.
- **Accept**: `cd web && npm run uicheck:app` (every ported check); `cd desktop && npm test && npm run e2e`;
  `scripts/build-app.sh` and a start of the built app with a scratch `AIWB_USER_DATA` shows the window with "This
  computer", and the packaged `Resources/web` holds every file of `app/dist-web` (a `node_modules` folder among the
  assets included: AD-41); the by-hand check of goal 7.5 "the desktop app from the web build, used as it is used today" is listed in
  the report for the user.

## Track I — the install script

### I1 — Install on a device · Sonnet · needs: N1, N2, B5
- **Makes**: `app/scripts/install.mjs`, `scripts/install-app-device.sh` (§10), `app/plugins/withAiwbPermissions.js`
  (AD-5), the app icon and name from `assets/icon`, `docs/development.md` section "Install the app on a phone or tablet".
  (revised after spikes ios-net and board-webview) The script runs `prebuild:board` (B5) before the build and
  `npx expo prebuild --clean` (a stale Info.plist key such as `NSAllowsLocalNetworking` survives a prebuild without
  it, AD-5); ATS and the secure-store plugin are N1's entries of `app.config.ts`, not this package's; the doc says
  that the iOS app turns ATS off and why (AD-36).
- **Accept**: `node app/scripts/install.mjs --help`; `node app/scripts/install.mjs --platform android --device
  emulator-5554` installs on the emulator (lock held) and the app opens; `--platform ios` without
  `AIWB_IOS_TEAM_ID` stops at the signing step and says what it needs (a real device install is by hand, goal 7.5);
  nothing in `git status` after a run but ignored files.

## Track V — device and simulator tests (goal 7.4)

| ID | Flow (AD-83) | Model | Needs | Accept |
|---|---|---|---|---|
| **V5** | the runner `app/e2e/run.mjs` (scratch server, env, Maestro), `app/e2e/get-maestro.sh` (Maestro **2.11.0** pinned by a sha256 written in the script, a JRE 17, into git-ignored `app/e2e/.tools/`, nothing system-wide; AD-83, revised after spikes ios-net and composer), `conn-on-hermes.yaml`, `net-selftest.yaml` | Sonnet | N0, C2 | `node app/e2e/run.mjs conn-on-hermes --platform ios` passes; `app/e2e/get-maestro.sh` run twice fetches once and fails on a changed checksum (a test with a wrong sum) |
| **V1** | `net-pinned-stream.yaml`, with the server reached once by a dotted name (`localtest.me`, AD-36) | Sonnet | N1, N2, C4, C5, S12 | passes on iOS simulator and Android emulator |
| **V2** | `board-webview.yaml` (in a Release build on Android, AD-56) | Sonnet | B5 | passes on both |
| **V3** | `composer-chips.yaml` and, on iOS, the XCUITest hardware-key target generated by the runner (the composer spike's `checks/ios-keys/`, AD-83) (revised after spike composer) | Sonnet | K2, K3 | passes on both (the keys: iOS) |
| **V4** | `storage-picker-permission.yaml` (and the scan path of S12 when it exists) | Sonnet | K4, S12, C5 | passes on both (permission prompt: iOS only) |

## Track R — retirement

### R1 — Retire the old page · Sonnet · needs: D2 and everything else
- **Makes**: architecture §11, all of it, and the documentation.
- **Accept**: `npm test && npm run check` (root); `cd web && npm test && npm run uicheck` (now the ported checks,
  renamed); `cd desktop && npm test && npm run e2e`; the four free web e2e scripts; `scripts/build-app.sh`;
  `git grep -n "web/src\|aiwbApp\|desktop/conn"` finds nothing outside history notes.

---

## Size and order, in short

- About 46 packages: 5 for Opus by design (C1, B3, K2, and escalations), the rest Sonnet.
- Critical path: F1/F2 → U1 → U2 → T1 → U3 (with F3, C3, C6) → S4 → K3 → (S11, K4, K5) → D-e2e → D2 → R1, with
  B1 → B2 → B3 → B6 → B4 beside it.
- Native path, independent of the web path until V1: C1 → C2 → N0 → (N1, N2) → C4 → S12 → V1.
- The browser-check ports are inside the screen packages, so parity is shown package by package; D2 runs them all.
