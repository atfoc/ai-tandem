# @aiwb/headless

The headless writer: a Node process that is a client of the server's client API like a window (the connection module
`@aiwb/conn`, its own client id, the server's secret), runs the app's own board side (`createBoardSide` of `@aiwb/core`) with
no view and the board engine in Node, and answers an agent's board calls while no window holds the board. Architecture:
`plans/headless-board/architecture.md` (2.8–2.12, section 4), package W5.

```
node dist/headless.mjs            # the server starts it; the configuration is ONE line of JSON on stdin
```

```json
{"address":"127.0.0.1:4749","fingerprint":"AA:BB:…","secret":"…","clientId":"<uuid v4>","instanceId":"<uuid>","quietMs":60000,"handoverMs":8000,"version":"dev"}
```

`address` takes `host:port` or `https://host:port`; the certificate is accepted by `fingerprint` and by nothing else. The secret is
read from stdin and kept in memory only; every line the process prints goes through `redact`.

| File | What |
|---|---|
| `src/bin.ts` | the bundle's entry: the real client (`createClient` over `nodeConnector` and `memStore`) |
| `src/main.ts` | the configuration, the start (engine, then connection, within 20 s), the end (stdin, stream, SIGTERM) |
| `src/loop.ts` | the events → the board side; save before reply (D25), quiet time (D26), yielding (D17) |
| `src/api.ts` | the board side's `BoardApi` over the client; the writer takes no board by itself (D27) |
| `src/engine.ts` | the seam to the board engine: `createNodeEndpoint` of `@aiwb/board-engine/node` (`packages/board-engine`), joined to a board channel; tests give it a fake |
| `src/texts.ts` | the words of 2.10 that this process says |
| `src/memstore.ts` | the connection module's `Store` for one entry, in memory |
| `build.mjs` | esbuild → `dist/headless.mjs` (the engine's native canvas left out), the engine's files in `dist/engine/` (`engine.mjs`, `fonts/`, `node_modules/skia-canvas/lib/skia.node` for the target; another target's binary is fetched from npm), `dist/manifest.json` (`{version, os, arch}`, which the server checks against its own version unless it is a `dev` build) |

**Exit codes.** 0: stdin ended, SIGTERM, or the one stream ended after it was connected (it never reconnects). 3: the engine or the
first connection failed within the start limit, or the configuration is bad; the reason is on stderr.

**Test knob.** `AIWB_HEADLESS_TEST=hold-before-save`: after the `apply` of a call and before its save, the process prints
`HOLD apply <board>` to stderr (the server's log adds `headless:`) and waits for ever. `hold-before-save:2` holds the second `apply`
of the process instead (the first is saved and answered as usual).

```sh
npm test && npm run check && node build.mjs     # in this folder
node build.mjs --os linux --arch x64 --version 1.2.3 --out /tmp/headless   # a bundle for another target
```
