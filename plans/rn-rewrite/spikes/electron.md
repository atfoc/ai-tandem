# Spike: the desktop (Electron) side of the React Native rewrite

Branch `rn-spike-electron`, code in `spikes/electron/`. Goal sections: 4.1, 4.6, 4.10, 7.3, 9 of
`react-native-rewrite-goal.md`, and the transport and the IPC face of `app-as-client-goal.md`.

## Verdict

| Point | Verdict | In one line |
|---|---|---|
| 1. A cancel signal cannot cross `contextBridge`; cancel by identifier works | **GO**, with one correction to the goal's wording | The `AbortSignal` arrives in the preload as `{}`. A call gets an identifier in the preload, a page-supplied `abort` object (one function) carries the abort into the preload, and the preload sends `{ id }` on `aiwb:cancel`. The IPC face and its channels are **unchanged** and the main process aborts the request. The correction: the preload cannot build *all* of the transport; a ~25-line page-side adapter stays (see "What does not work"). |
| 2. The Electron window loads an Expo (react-native-web) web export | **GO**, with changes | It loads from `file://` as the page does today, **only if** the export is made with `experiments.baseUrl: "."` (Expo's default absolute `/_expo/...` paths give a blank window under `file://`). It also loads, unchanged, from an app-owned scheme. It runs under a strict CSP that needs `style-src 'unsafe-inline'` (and `'wasm-unsafe-eval'` only if WebAssembly is used). The loaded page sees the bridge and calls through it. |

Everything below was run, not argued: `node spikes/electron/run.mjs` (about 35 s, windows open for a few seconds each)
passed all steps on this machine.

## How to repeat

```sh
node spikes/electron/run.mjs            # all of it, from the repository root
node spikes/electron/run.mjs --quick    # tests, probe, and one app run (file://, no CSP)
cd spikes/electron && npm test          # only the node tests (no Electron)
```

`run.mjs` installs into `spikes/electron/` only (`node_modules`, git-ignored; Electron 44.4.5 is the same version as
`desktop/`), exports the Expo app twice, runs the node tests, runs the contextBridge probe in Electron, and runs the
Expo export in the window in 8 ways (matrix below). It calls no network and no paid model, uses a temporary Electron
user data folder, and writes its results to `spikes/electron/.out/*.json` (git-ignored). Nothing in `desktop/` or `web/`
was changed; `cd desktop && npm test` passes (209 tests).

| Path | What it is |
|---|---|
| `spikes/electron/bridge/preload.js` | The bridge: one self-contained file; builds the transport and exposes `window.aiwbApp` |
| `spikes/electron/app/src/bridgeTransport.ts` | The page-side adapter: `window.aiwbApp` -> the page's real `Transport` (imports the real `web/src/transport/types.ts`) |
| `spikes/electron/app/` | The minimal Expo app (SDK 57); `App.tsx` makes the calls and records what it finds in `window.__spike` |
| `spikes/electron/main.js` | A separate Electron main: the **real** `desktop/ipcface.js` with a fake client in place of `desktop/conn`; loads the probe or the export |
| `spikes/electron/probe/` | The raw contextBridge probe (a preload that hands back every kind of value, and a page that records what arrived) |
| `spikes/electron/test/` | `node --test`: the preload against a fake `ipcRenderer`; the whole path against the real IPC face; a model of contextBridge |
| `spikes/electron/run.mjs` | The repeatable script with the assertions |

## How the window loads the page today (facts read from the code)

- `desktop/main.js` calls `win.loadFile(page)`: the page is a `file://` URL (`web/dist/index.html`; in the packaged app
  `Contents/Resources/web/index.html`). There is no custom scheme for the page; the only scheme is `aiwb-picture`
  (pictures).
- **There is no CSP today**: not in `web/index.html`, not in a header, not in `main.js`. (Electron's console warns about
  it on every run; the spike's console shows the same warning.)
- `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, `sandbox` left at Electron's default, which is
  **on**. The probe confirms `process.sandboxed === true` in the preload.
- `desktop/preload.js` exposes `window.aiwbApp` with seven functions (`call`, `cancel`, `stream`, `onEvents`,
  `onStreamState`, `app`, `pickImages`). The page-side `web/src/transport/ipc.ts` turns an `AbortSignal` into
  `call` + `cancel(id)`.
- The IPC face (`desktop/ipcface.js`) accepts a call only from the main frame of the main window while it is on `pageURL`
  (`fromAppWindow`: compares the frame's URL without its hash), registers the call under the page's `id`, aborts it on
  `aiwb:cancel { id }`.
- `electron-builder.yml` puts only `main.js preload.js lib.js ipcface.js conn/**` into `app.asar`, and the page under
  `Resources/web` as `extraResources`.

## Point 1: contextBridge, cancel by identifier

### What contextBridge can and cannot carry (measured in Electron 44.4.5, sandboxed preload, `probe/`)

"Page" is the main world, "preload" the isolated world. Both directions behave the same unless said.

| Value | Result |
|---|---|
| Strings, numbers, booleans, null, plain objects and arrays | Carried, **deep-copied**. The two worlds never share an object: a mutation on one side is not seen on the other, identity is lost (circular references inside one value are kept). |
| Functions | Carried as **proxies**, in both directions, as arguments, as return values and as properties of objects. A page callback given to the preload can be called later (timers, events) and kept for good. A function's return value is copied. |
| `Promise` | Carried when it is the return value (or the argument): the other side gets a real `Promise` of the copied value. **Properties set on a promise are dropped** (`promise.cancel` is `undefined`). A promise nested as a property of an object is carried (`{ id, done: Promise, cancel() }` works). |
| Rejection with an `Error` | Arrives as a plain `Error` with **the message only**: `name` becomes `"Error"` (a `RangeError` and an `Error` named `TransportError` both arrive as `Error`), `code`, `cause` and every other property are lost. A thrown synchronous error is the same. |
| Rejection with a `DOMException` (`AbortError`) | Arrives as a plain `{}`: **not even an `Error`** (`instanceof Error` is false; no name, no message). |
| Rejection with a plain object | Carried as a plain object. |
| **`AbortSignal`** | Arrives as **`{}`**: no `aborted`, no `addEventListener`, nothing. Same inside an object (`{ signal }` gives `{ signal: {} }`). This is the thing the goal expected not to cross, and it does not. |
| `Uint8Array`, other typed arrays, `DataView`, `ArrayBuffer` | Carried as the same type. A Node `Buffer` arrives as a `Uint8Array` in the page. `SharedArrayBuffer` does not exist in the page. |
| A typed array that is a **view** | Carried **with its whole underlying buffer** (a 10-byte view into a 50 MB buffer arrives as a view with `byteOffset: 100` and a 50 MB `buffer`). |
| `Blob`, `File` | Carried as a `Blob`/`File` (by reference: cheap). The receiving side reads it with `await blob.arrayBuffer()`. |
| `Date`, `Map`, `Set`, `RegExp`, `BigInt` | Carried as the same type. |
| Symbol-keyed properties, getters | Symbol keys are carried (own, enumerable). A getter is **evaluated** and arrives as a plain value. |
| Class instances | Own data properties are carried; the prototype and its methods are **lost** (`{ a: 1 }`, `m` is `undefined`). |
| **Async iteration** | An **async generator or a sync generator cannot be returned**: `An object could not be cloned`. A plain object with an own `[Symbol.asyncIterator]()` method, or with own `next()`/`return()` functions, **works**: `for await (const v of obj)` gave `[1, 2, 3]`, manual `next()` too. Generator *objects* have their methods on the prototype, so they do not cross; an object built from own functions does. |
| `ReadableStream`, `MessagePort` | Arrive as `{}`. (They cannot be a way to carry a stream through contextBridge.) |

**Bytes: cost and shape** (page -> preload; 50 MB, this Mac, one run each; `run.mjs` prints the numbers it measures
and asserts the ratio):

| Page sends | Time |
|---|---|
| `Uint8Array` | **about 950 ms** (about 50 MB/s: a typed array is copied element by element) |
| `ArrayBuffer` (e.g. `bytes.buffer`) | about 12-25 ms |
| `Blob`, preload reads it with `blob.arrayBuffer()` | about 14-40 ms |
| view, 10 bytes into a 50 MB buffer | about 16 ms, **and the preload gets the whole 50 MB buffer** |

Preload -> page: a 50 MB `Uint8Array` takes about 12-20 ms. So: **send bytes into the preload as an `ArrayBuffer` or
a `Blob`, never as a `Uint8Array`, and cut a view to its own bytes first.** The message limit is 5 MB per image and 10
images per message (50 MB at most), so the slow path would cost up to a second per message; the fast path costs tens of
milliseconds. In the full spike path (page -> adapter -> bridge -> `ipcRenderer.invoke` -> the real face) a 20 MB body
takes 38 ms.

**Other facts of the preload.** It is sandboxed: `require('node:fs')` and `require('./local.js')` both fail with
`module not found`; only `electron` (and a few polyfilled built-ins) can be required, and `Buffer`, `process` (a
subset) and `crypto.randomUUID` exist. **A preload that shares code with the app must be one bundled file.**
`electron-builder.yml` also lists `preload.js` alone. In the page `window.require`, `window.Buffer` and Node's
`window.process` do not exist.

### The cancel-by-id scheme as built

```
page                         adapter (page)                    bridge (preload)                    main (desktop/ipcface.js, unchanged)
 transport.call({server,method,path,body?,signal})
   |  signal.aborted? -> reject abortError(signal)
   |  abort = { aborted:false, listen(cb){ signal.addEventListener('abort', cb,{once:true}); return remove } }
   |  body  = Blob as is | Uint8Array -> its ArrayBuffer (view cut)
   +--> bridge.call({server,method,path,body?,abort}) -->  id = crypto.randomUUID()
                                                            off = abort.listen(onAbort)   <- a page function, proxied
                                                            body -> Uint8Array (a Blob is read here)
                                                            ipcRenderer.invoke('aiwb:call',{id,server,method,path,body?}) --> pending.set(id, new AbortController())
                                                                                                                                client.call({..., signal})
   page aborts the signal ----------------------------->  onAbort(): ipcRenderer.send('aiwb:cancel',{id})  --> pending.get(id).abort()  -> the request ends
                                                            reject(AbortError)  (at once, not when main answers)
   <-- adapter: signal.aborted ? throw abortError(signal) (the signal's own reason, so `e === signal.reason`)
```

- **Identifier**: made in the preload (`crypto.randomUUID()`), unique per call (tested over 1000 calls). The page never
  sees it. The face already keys `pending` by the id and refuses an id in use.
- **Abort function**: `abort = { aborted, listen(cb) -> off }`. `aborted` is a snapshot (the adapter has already
  checked the signal); `listen` registers the preload's callback on the real signal in the page. This works because
  functions cross as proxies in both directions (probe: `in.signalLikePlainObject`, `in.callbackLater`).
- **Cancel before the body is read** (a 30 MB Blob still being read in the preload): the call ends and nothing is
  sent (`cancel.duringBlobRead`). **Already aborted**: nothing is sent. **Abort after the call finished**: nothing is
  sent, the listener is removed. **A second abort**: one `aiwb:cancel` only (the node tests found a double send in a
  first version; fixed).
- **Errors**: the preload rejects with `Error`s that have a message (names do not survive); the adapter makes the real
  errors: `abortError(signal)` when `signal.aborted`, else `TransportError(message)`. `Transport.call`'s contract
  (rejects only on abort or `TransportError`) holds.
- **The rest of the transport** is built in the preload: `stream(onEnvelope, onState) -> { close }` (callbacks cross as
  proxies; envelopes arrive in order, a 50,000-character one whole; `close` ends the subscription in main),
  `pictureURL`, `app`, `pickImages`. Same channels as today (`aiwb:call`, `aiwb:cancel`, `aiwb:stream`, `aiwb:events`,
  `aiwb:stream-state`, `aiwb:app`, `aiwb:pick-images`). Latency of a call through the whole path to a fake client:
  0.05 ms in a row.

### Evidence

1. **`node --test` (21 tests, no Electron)**, `spikes/electron/test/`:
   - `preload.test.mjs`: against a fake `ipcRenderer`: the id, the five fields of a call, ids not repeating, the cancel
     carried as `{ id }` once, no cancel after the call finished, nothing sent when already aborted or aborted during a
     Blob read, the body forms (JSON, `Uint8Array`, a cut view, `ArrayBuffer`, `Blob`), failures, the stream, `app`,
     `pictureURL`, `pickImages`.
   - `endtoend.test.mjs`: the adapter -> a **model of contextBridge** -> the preload -> a fake `ipcRenderer` -> the
     **real `createIpcFace`** -> a client whose calls end on abort: the cancel reaches the client's `signal`
     (`aborted === true`); the signal's own reason comes back; 40 concurrent calls, the odd ones cancelled, no
     cross-talk; bytes intact; the face still refuses a call from another page and a method it does not know; a test
     that shows a bridge taking the signal itself loses the cancel. The model (`helpers.mjs`) is written from the probe
     below; it is a model, the Electron run is the proof.
2. **Electron, the probe** (`probe/`, run by `run.mjs`): every row of the table above, with assertions on the ones the
   design rests on (signal is `{}`; function proxies work later and kept; errors keep only the message; no generators;
   `Uint8Array` at least 3x slower than `ArrayBuffer`).
3. **Electron, the Expo page** (`app/App.tsx`, through the adapter and the real face): a slow call cancelled at 200 ms
   rejects after 202 ms with the signal's own `AbortError`; with a custom reason the call rejects with that very
   object; the **main process's log shows `abortedWhileWaiting: true`** for each cancelled call (`/api/slow/1`,
   `/api/slow/2` and the 20 odd of 40 concurrent calls) and no entry at all for the calls that were cancelled before
   they were sent; the even ones finished with their own answers; bytes as `Uint8Array`, as a view and as a `Blob`
   arrive with the same SHA-256; the stream gave 5 events in order and its subscription was closed in main.

## Point 2: the Expo web export in the window

### What was built

`spikes/electron/app/`: Expo SDK 57 (`create-expo-app` blank-typescript + `react-dom`, `react-native-web`,
`@expo/metro-runtime`, `expo-font`, `@expo/vector-icons`), config in `app.config.js` (a dynamic config, so that the
base path can be switched by `SPIKE_BASE_URL`). `npx expo export --platform web` takes about 3 s and gives
`dist/index.html`, one 852 KB script `_expo/static/js/web/index-<hash>.js`, one 205-byte lazy chunk (from `import()`),
`favicon.ico`, and `dist/assets/` (5.2 MB in all: the app's icon and **all 20 icon-font families** of
`@expo/vector-icons`, 4.3 MB; importing the barrel `@expo/vector-icons` is the likely cause, a direct
`@expo/vector-icons/Ionicons` import was not tried).

The page the window loaded (`App.tsx`) does, through the page's real `Transport` type (it imports the repository's
`web/src/transport/types.ts` through Metro's `watchFolders`: `TransportError` and `abortError` are the real ones):
JSON and bytes calls, the cancels above, the stream, `pictureURL`, `app`, an `import()` chunk, an `<Image>` from
`require('./assets/icon.png')`, a web font through `expo-font`, a WebAssembly compile, and a `new Function`.

### The 8 ways it was loaded (all run by `run.mjs`)

`main.js` loads the export either with `win.loadFile` (`file://`, as `desktop/main.js` does today) or from
`aiwb-app://app/index.html`, a `standard`, `secure` scheme served by `protocol.handle` from the same folder.
The CSP is a `<meta http-equiv>` in a copy of `index.html` under `file://` (a `file://` response has no headers) and a
header under the scheme. The CSP "strict-wasm" is:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:;
font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'
```

("strict" is the same without `'wasm-unsafe-eval'`; "strict-no-inline-style" has `style-src 'self'` and no wasm.)

| Way | Result |
|---|---|
| `file://`, no CSP (**today's way**), export with `baseUrl "."` | **Works**: bridge seen, every call, cancel, bytes, stream, lazy chunk, image, font, wasm. No console error. |
| `file://`, CSP "strict-wasm" (meta) | **Works**, 0 violations from the app (the only one is my deliberate `new Function`). `script-src 'self'` matches under `file://`. |
| `file://`, CSP "strict" | Works except the wasm probe (`script-src` violation `wasm-eval`). |
| `file://`, CSP "strict-no-inline-style" | The page runs but **react-native-web gets no styles** (0 rules in its stylesheet, against 59): "Applying inline style violates ... style-src 'self'". |
| `aiwb-app://`, no CSP, export with `baseUrl "."` | Works. |
| `aiwb-app://`, CSP "strict-wasm" (header) | Works, 0 violations from the app. |
| `aiwb-app://`, no CSP, the **default export** (absolute `/_expo/...`) | **Works** (the scheme's root is the export's root). |
| `file://`, no CSP, the **default export** (absolute `/_expo/...`) | **Does not load**: the script URL becomes `file:///_expo/static/js/web/...` (not found), the window stays empty (`body.innerText === ""`). The preload ran (the bridge exists), but nothing uses it. `did-fail-load` does **not** fire for a missing script, so `main.js`'s error dialog would say nothing. |

### Every change the export needs to load in the window

1. **Paths** (`file://` only): set `experiments.baseUrl` to `"."` (in `app.json`, or in `app.config.js` as here). The
   export then writes `./_expo/...` and `./favicon.ico`, and the runtime (the lazy chunk, the asset and the font URLs,
   which Metro resolves against the page) follows: the lazy chunk, the image (`assets/assets/icon.<hash>.png`, 1024 px
   decoded) and the font (`ionicons` face `loaded`) all loaded under `file://`. With the default `baseUrl` the window
   is blank. An app-owned scheme needs no change.
2. **CSP: `style-src 'unsafe-inline'` is required.** The export has one inline `<style id="expo-reset">` in
   `index.html`, and react-native-web inserts its own `<style id="react-native-stylesheet">` at run time; with
   `style-src 'self'` both are blocked and the app is unstyled. Hashes/nonces were **not** tried (the run-time rules
   are many and change). Nothing else needed `unsafe-inline`.
3. **CSP: no inline script, no `eval`.** `index.html` has no inline `<script>`; the one script is a classic
   `<script src defer>`, not a module. The production export ran under `script-src 'self'` with no `'unsafe-eval'`. (A
   dev-server bundle was not tried and is known to use `eval`.)
4. **CSP: WebAssembly needs `'wasm-unsafe-eval'` in `script-src`.** The hello app's export contains no wasm; this is
   from a probe in the page (`WebAssembly.compile` blocked without it). Needed only if a dependency uses wasm
   (`expo-sqlite` on the web does; not used here).
5. **CSP: fonts** are fetched from the page's own origin (`font-src 'self'`); **images** from `'self'` (and
   `aiwb-picture:` for pictures: the picture scheme was not registered in the spike, so it is not tested here);
   `connect-src` was `'self'` but the spike's page makes no `fetch`, since the transport is IPC. The CSP must not
   forbid `blob:`/`data:` for images if the app shows them (not tested).
6. **`window.process` exists in the page** (an `{ env }` shim from the Metro bundle). `desktop/e2e/app.e2e.mjs` asserts
   `typeof window.process === 'undefined'` and would fail; assert instead that Node's process is not there
   (`process.versions === undefined`, which the spike's `run.mjs` does). `window.require` and `window.Buffer` are
   undefined.
7. **The export contains a directory named `node_modules`** (`dist/assets/node_modules/@expo/vector-icons/.../*.ttf`).
   Anything that filters `node_modules` out (this repository's `.gitignore` pattern `node_modules/` would, for
   one) could drop the fonts. `desktop/electron-builder.yml` copies `web/dist`
   with `extraResources`; **whether electron-builder copies a `node_modules` directory from there was not tried**.
   Check it when packaging.
8. **The window's own checks keep working with the export's URL.** `fromAppWindow` / `atPage` compared the frame's
   URL with `pageURL`; both `file:///.../dist/index.html` and `aiwb-app://app/index.html` passed, so calls from the
   export were answered and calls from another page are refused (tested with a different sender URL).
9. **Not needed**: no change to `desktop/` for the page to load, no change to the IPC face, no wasm file, no inline
   script, no service worker.

## What does not work (said plainly)

- **The preload cannot build the whole transport.** An `AbortSignal` cannot be read in the preload at all, and an
  `Error` loses its name, so (a) the page must hand the abort over as a function and (b) the real errors
  (`AbortError` with the signal's reason, `TransportError`) must be made on the page's side. That is
  `app/src/bridgeTransport.ts`: about 25 lines, no network and no IPC in it, one per web build. The goal's 4.6 says "the
  translation from the page's calls to the IPC messages is made there [in the bridge]": that holds (id, body, channels,
  stream, picture address, app calls are all in the preload), except for these two conversions. The page's callers do
  not change: they still call `transport().call({ signal })`.
- **A typed array is a trap**: slow in (50 MB/s) and a view drags its whole buffer. Use `ArrayBuffer`/`Blob`.
- **No generators, no `ReadableStream`, no `MessagePort`** through contextBridge. Streams must be callbacks (as the
  transport already has) or hand-made objects of own functions. Zero-copy transfer of a large buffer is not available
  through contextBridge (everything is copied; `postMessage` with transfer was not tried).
- **Error names do not cross.** Code that tests `e.name === 'AbortError'` on what the bridge returns must run after the
  adapter.
- **A preload cannot import the app's code** (sandbox). Shared code must be bundled into one file, or the sandbox
  turned off (not recommended; the app's security rests on it). The bundling was **not tried** here: the spike's preload is
  one hand-written file.
- **`file://` with Expo's defaults does not load**, and fails silently (item 1 above).
- **Not covered by this spike** (stated so no one assumes): a built app (`electron-builder`) with the export; the
  real `desktop/conn`; the picture scheme next to the export; a router (`expo-router` with path URLs would not work
  under `file://`; it was not installed); Excalidraw inside the export; `localStorage` carried over from the old page
  (a different origin if the scheme changes; a different page anyway); Windows/Linux; the `aiwb-picture` CSP entry.

## What the real implementation should do

1. **Keep the IPC face and its channels as they are.** The spike's bridge speaks to the real `desktop/ipcface.js`
   unchanged, including its sender checks and the pending map. Only `preload.js` and its test (`test/preload.test.js`)
   change: the exposed shape becomes `way, call, stream, pictureURL, app, pickImages` (no `cancel`, `onEvents`,
   `onStreamState`), and `desktop/e2e/app.e2e.mjs`'s assertion on the keys and on `window.process` changes.
2. **Write the bridge as in `bridge/preload.js`** (id in the preload; `abort = { aborted, listen }`; JSON or bytes;
   cancel by `{ id }`, once; reject with plain `Error`s; the stream and the rest). Build it as **one file** (bundle with
   a bundler if it shares code with the app) and list it in `electron-builder.yml`.
3. **Keep a page-side adapter**, `transportFromBridge` (`app/src/bridgeTransport.ts`), as the desktop web build's
   transport (`index.web`/desktop file of the transport folder, chosen where `wayOf` is chosen today: `window.aiwbApp`
   present). It imports the real transport types, so the types stay the single source of truth. Keep it with the same
   tests (`test/endtoend.test.mjs` is the template, with the model of contextBridge).
4. **Bytes**: the adapter passes `Blob` as is and a `Uint8Array` as its `ArrayBuffer` (cut if it is a view); never a
   typed array. Pictures stay on the `aiwb-picture` scheme as today.
5. **Loading**: both ways work. Recommendation: keep `win.loadFile` and the page at `file://` for the first build, make
   the export with `experiments.baseUrl: "."`, add the CSP as a `<meta>` to the export's `index.html` (a post-export
   step, or an Expo `+html`/template if one is used), and make `main.js` report a **blank page** (a script that
   did not load: `did-fail-load` will not). Choose the app-owned scheme (`aiwb-app://`, `protocol.handle`, the traversal
   check in `main.js` of the spike, a CSP header) instead **if** the new app uses path routing (an SPA fallback to
   `index.html` is only possible there) or if a real origin is wanted (a header CSP incl. `frame-ancestors`, a
   standard secure origin). The cost of the scheme: `loadURL` in `main.js`, `pageURL`/`atPage`/`attachLinkHandlers` use
   the scheme's URL, and a new origin for the page's storage. That is a decision for the architecture.
6. **CSP to adopt** (start from "strict-wasm", drop `'wasm-unsafe-eval'` if no wasm): `default-src 'none'; script-src
   'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: aiwb-picture:; font-src 'self' data:;
   connect-src 'none'; base-uri 'none'; form-action 'none'`. `connect-src 'none'` was not tried (the spike used
   `'self'`); the transport is IPC and the picture scheme is an `img` source, so it should hold: try it.
7. **Fix the export for the window**: import single icon sets (not the barrel) to keep `dist/` small; check that the
   `assets/node_modules/...` fonts survive packaging; keep `window.process` out of the e2e assertion.
8. **Update the goal's 4.6/9 wording**: the cancel scheme is confirmed; the risk row "a cancel signal cannot cross the
   window's bridge" can be closed with the correction above (the preload builds the transport except for the signal
   and the error classes, which a small page-side adapter makes).

## Versions used

| | |
|---|---|
| macOS / arch | 15.7.9, arm64 |
| Node (run.mjs, tests) | 24.3.0 (Electron's own: 24.21.0) |
| Electron | 44.4.5 (Chromium 152.0.7977.130, V8 15.2), the version `desktop/package.json` locks |
| Expo SDK | 57 (`expo` 57.0.28, `latest` on npm on 2026-10-14) |
| React / React DOM | 19.2.3 |
| React Native | 0.86.3 |
| react-native-web | 0.21.4 |
| `@expo/metro-runtime` / `expo-font` / `@expo/vector-icons` | 57.0.16 / 57.0.4 / 15.1.1 |
| Metro | 0.84.5 |
| TypeScript (app template) | 6.0.3 (not run: the app is type-stripped by Babel; the adapter is also loaded by `node --test` through Node's type stripping, so it uses erasable syntax only) |

## Decisions made while building

- `window.aiwbApp` keeps its name, with the new shape above (the spike does not load `desktop/preload.js`).
- `desktop/` and `web/` are untouched; the spike has its own `main.js` (it `require`s `desktop/ipcface.js`).
- The Expo app uses `app.config.js`, not `app.json`; the template's `.claude/` and `AGENTS.md` were removed.
- `spikes/electron/app/package-lock.json` is committed so the install is repeatable; `node_modules`, `dist`,
  `dist-abs`, `.expo` and `.out` are not.
