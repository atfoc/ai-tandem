# aiwb-net

The native network of the phone app: it dials a server, judges its certificate by the rule below, speaks HTTP/2
through the system's stack, and reports. It holds **no decision of the app** (hello, levels, retries, back-off,
silence, route checks, limits of a call): those are `@aiwb/conn`'s, and they are the same on the desktop. This
file is the text the iOS package (N1) and the Android package (N2) implement; `src/AiwbNet.ts` is the same
contract as TypeScript, `src/fake.ts` is it in JS, and `app/src/platform/net/nativeConnector.ts` turns it into the
`Connector` and `Session` ports of `packages/conn/ports.d.ts`. Architecture: AD-11, AD-30..AD-34.

| File | What |
|---|---|
| `src/AiwbNet.ts` | the contract: types of the functions, events and errors (no run-time import) |
| `src/AiwbNetModule.ts` | the native module, `requireNativeModule<AiwbNetModule>("AiwbNet")`; on Android it passes `fetch`'s `body` as an argument of its own (Expo's bridge cannot carry a `Uint8Array` inside an options object there; iOS can) |
| `src/AiwbNetModule.web.ts`, `src/unavailable.ts` | the web build has no native network: every function rejects `not implemented` |
| `src/fake.ts` | `createFakeAiwbNet(server)`: the module in JS over `packages/conn`'s scripted server, with the table below |
| `ios/*.swift` | the iOS side (N1, built): `AiwbNetModule.swift` (functions, typed options, the registry of sessions and cancellable requests), `NetSession.swift` (one URLSession, the trust, the flights), `NetFailure.swift` (the errors, `httpsURL`, fingerprints), `Utf8Chunker.swift`, `CertificateNames.swift`, `TcpProbe.swift`, `LocalNetwork.swift` |
| `android/.../*.kt` | the Android side (N2, built): `AiwbNetModule.kt` (functions, typed options, the registry of sessions and cancellable requests, the calls), `NetSession.kt` (one OkHttp client over the one judged connection, the socket that tells when it is gone), `Trust.kt` (the trust rule: pin, any, the platform's own), `Tls.kt` (the dial and handshake, `httpsURL`, the table's mapping), `StreamPump.kt` (the events of a stream), `Utf8Chunks.kt`, `NetFailure.kt` |
| `dev/control.mjs` | the control server of the scriptable stand-in of the device self-test (below) |
| `../../src/platform/net/nativeConnector.ts` | the adapter: `nativeConnector(module): Connector` |
| `../../test/nativeConnector.test.ts`, `../../test/aiwbnet.test.ts` | the adapter over the fake passes `runConnectorContract`; the fake's table |
| `../../src/dev/netSelfTest.ts`, `standinControl.ts` | the device self-test (V5 made the runner and the screen): `runConnectorContract` on the real module, cases against the real server, cases of the module |
| `../../test/appconfig.test.ts`, `../../test/noplainhttp.test.ts` | the ATS dict is exactly `{NSAllowsArbitraryLoads: true}`; "no plain HTTP" by the code (AD-36) |

The Expo module is named `AiwbNet`. Use typed `Record`/`Field` options for the arguments (the iOS spike lost limits
because numbers cross as `Double`; read every number as a number, not as `Int`).

## The functions

All of them are `AsyncFunction`s except `cancel` and `closeSession`. `request` is a string **made by the caller**, unique
among the requests of the module (those of `openSession`, `readCertificate`, `fetch` and `stream` share one space):
`cancel` and the events name a request by it, so the caller can cancel before the call has answered.

```ts
openSession(o: { request, host: string, port: number, selfSigned: boolean, pin: string, dialMs: number, handshakeMs: number })
  : Promise<{ session: string, fingerprint: string }>
readCertificate(o: { request, host, port, dialMs, handshakeMs }): Promise<{ fingerprint: string }>
fetch(o: { session, request, method, path, headers, body: Uint8Array | null, headersMs, maxBytes })
  : Promise<{ status: number, headers: Record<string,string>, body: Uint8Array }>
stream(o: { session, request, method, path, headers, headersMs }): Promise<{ status, headers }>
cancel(request: string): void
closeSession(session: string): void
localNetwork(): Promise<'granted' | 'denied' | 'unknown'>
```

### `openSession`

Resolves with a **session id** (made by the module) and the **fingerprint** of the leaf the trust accepted, after a TCP
connection, a TLS handshake whose certificate passed the trust rule, **and** a negotiated protocol of `h2`. A session
is one HTTP/2 connection to one server: every request on it rides that connection (the platform's connection
pool for the session is one connection; a platform that cannot promise it says so in its report). Nothing is written
before the trust was judged (below). `dialMs` is the time to connect, `handshakeMs` the time the TLS handshake may take
once connected. A platform that cannot tell the two apart (URLSession) runs one timer of the sum and names the failure
by the last phase it reached (connected → `tls_timeout`, not connected → `no_route`).

The trust rule, the one place a certificate is judged:

- `selfSigned: true`: accept the **leaf** (the first certificate the server presents) iff the SHA-256 of its DER,
  written as upper-case hex pairs joined by `:` (`AA:BB:…`, 32 pairs), **equals `pin` as text**. Nothing else is checked: not the
  chain, not the dates, not the name, not the system's roots. The adapter puts a pin that is a fingerprint into this
  form before the call; a pin that is no fingerprint is sent as it is and so fits no certificate. A native side
  does **not** normalise or parse the pin, it compares text. `pin: ""` with `selfSigned: true` rejects
  `fingerprint` **without dialing** (the adapter does not even call; the native side must still do it).
- `selfSigned: false`: the platform's own evaluation (its roots, the host name, the dates). `pin` is ignored. A failure
  is named by the order the Node connector uses: the name (`cert_name`), then the dates (`cert_expired`), then a certificate
  with no root that is self-signed (`self_signed`), then anything else (`cert_untrusted`).
- A refused certificate ends the handshake. On `cert_changed` the Problem carries `fingerprint` (the presented, normal
  form) and `pinned` (the pin **as it was given**); on `fingerprint` neither (nothing was dialed).
- The trust is judged **before** the protocol: a pinned certificate on a server that does not speak h2 is `not_aiwb`, a
  wrong pin on the same server is `cert_changed`.

What the module writes: nothing to a certificate that was not accepted (a wrong pin, `readCertificate`). After the trust
accepted, `openSession` writes nothing, **except** on a platform that cannot learn the negotiated protocol
from the handshake (URLSession: AD-31): it may then send one probe `GET /api/hello` with **no secret and no `x-aiwb-*` header**,
discard the answer, and read the protocol from the request's metrics. That is the only request `openSession` may
write, and the secret never goes out in it. (The contract suite checks "`open` wrote no request" only against servers
that can list their requests; the fake and the Node connector write none, a real Go server cannot say.)

### `readCertificate`

The handshake that takes **any** certificate, resolves with the leaf's fingerprint (same form) and closes. It writes
nothing, to any certificate, and it keeps no session. Failures before the handshake ended are the same as `openSession`'s
(`refused`, `name_not_found`, `no_route`, `local_network_denied`, `tls_timeout`, `not_https`, `tls_error`).

### `fetch`

One request, its whole answer. `method` is `GET|POST|PUT|PATCH|DELETE`, `path` is the path and query of the client API
(starts with `/`), `headers` are sent **as given** (the secret is among them: the module never adds or reads one), `body` is
the request body or `null`. The module sets the authority to `host:port` of the session. It adds no cookie, follows
**no redirect** (a 3xx is an answer), caches nothing, ignores system proxies, asks for no compression and decompresses
nothing (a platform that adds `Accept-Encoding` by itself sets it to `identity`), and does not retry what it sent
(as far as the platform allows). A status of 4xx or 5xx is an answer, not an error.

- Resolves with the status, the response headers (**names in lower case**; repeated headers joined with `, `) and the
  body as bytes.
- `headersMs` (0: none): if the response's headers are not in `headersMs` ms after the request was written, the
  request is cancelled (the HTTP/2 stream only, the session stays) and `fetch` rejects `net timeout`.
- `maxBytes` (0: none): if the body is larger, the request is cancelled (the stream only) and `fetch` rejects
  `net too_long`. A body of exactly `maxBytes` is whole.
- There is no other time limit: the whole-request limit `limitMs` of the port is the **adapter's** (a timer that calls
  `cancel`). The module must not end a request on a clock of its own (the iOS spike set a day).
- Several requests at once on one session are normal (HTTP/2): fetches and the event stream together.

The binary body crosses as `Uint8Array` (Expo `Data`/`ByteArray`). `[not verified]` on both platforms in SDK 57. If a
platform's bridge cannot carry it, the package that finds it changes this one contract in `AiwbNet.ts` and the adapter
(base64 text both ways: pictures are at most 5 MB, a scene upload up to 128 MiB, which would then need `fetchToFile`).

### `stream`

A request whose body is read as **text** as it comes (the event stream). It takes no body. It resolves at the headers
with `{status, headers}` (a non-200 status is an answer; its body is delivered as chunks too), and from then on the body
arrives as events (below). `headersMs` as for `fetch` (`net timeout`).

The text: the native side decodes the bytes as UTF-8 **incrementally** (a code point cut between two reads waits for the
rest; an invalid sequence becomes U+FFFD, as `StringDecoder` does), so JS only ever sees whole characters. It coalesces
bytes that arrive within 16 ms into one `chunk` event and never holds more than 64 KiB before sending. A stream held for
hours keeps nothing on the native side but its decoder state.

### `cancel(request)`

Ends a request, for any function that took one:

- `openSession`, `readCertificate`, `fetch`, and `stream` before its headers: the promise rejects `aborted`. A session that
  `openSession` had already made at that moment is closed (nothing is left open).
- `stream` after its headers: the body stops. **No `chunk` and no `end` event after `cancel` returns.** The HTTP/2 stream
  is reset; the session goes on.
- A request that is over, a request that never was: nothing (no error). `cancel` never throws.

### `closeSession(session)`

Ends the session and **every request on it**: each `fetch` in flight rejects `net reset`, each open stream gets an
`end` event with `error: "reset"`, and the connection is closed. Then `closed` is emitted (once per session, also
when `closeSession` caused it). A request begun on a session that has ended rejects `net closed`. A session id that is gone:
nothing. (AD-30 said the in-flight `fetch` rejects `closed`; the contract suite and the Node session say `reset`, and
`closed` is for a request that finds the session already over. This README is the text.)

### `localNetwork()`

`'denied'` when the platform has said that the app may not reach the local network, `'granted'` when a session to a
private address has opened (or the platform has no such permission: **Android always `granted`**), else `'unknown'`.
It never prompts; the system's prompt is shown by the platform at the first connection to the local network
(`NSLocalNetworkUsageDescription` says why). A dial that failed because of the permission is `local_network_denied`
(AD-34), not `refused`. The fake: `unknown`, then `granted` after a session opened, `denied` after a `local_network_denied`.

## The events

`module.addListener(name, f): { remove() }`. Three events:

| Event | Payload | When |
|---|---|---|
| `chunk` | `{ request, text }` | the text of a stream's body, **in order** |
| `end` | `{ request, error? }` | **once** per stream, after its last `chunk`; `error: "reset"` when the stream was cut (the network, the server's reset of the stream, a GOAWAY, `closeSession`, the session gone), none when the server ended it cleanly. Never after `cancel`. |
| `closed` | `{ session }` | the session ended for any reason (GOAWAY, the network, `closeSession`), once |

Rules: no event for a request before the call that made it; after `end` (or `cancel`) no `chunk` and no `end` of that
request; the events of a `stream` may reach JS **before or after** its promise resolves, so the adapter listens before it
calls and holds the text until the reader is there. An error never travels in an event except `error: "reset"`.
A stream cut by the network or by `closeSession` ends with `error: "reset"`, never with a silent end (AD-31; the Node
session had a bug of that kind, fixed with this package).

## Errors

Every function that can fail rejects with an `Error` whose `code` is `"AIWB_NET"` and whose `info` is a `NetErr`:

```ts
type NetErr = { kind: 'problem'; outcome: ProblemOutcome; detail: string; fingerprint?: string; pinned?: string }
            | { kind: 'net'; code: 'timeout' | 'reset' | 'too_long' | 'closed'; detail?: string }
            | { kind: 'aborted' };
```

`problem` is why no session was made (`openSession`, `readCertificate`), `net` is why a request got no usable answer
(`fetch`, `stream`; also what `closeSession` does to the requests), `aborted` is what `cancel` does. Expo's bridges may not carry a custom `info`
property: then the native side rejects with `code` `"AIWB_NET"` and a **message that contains the JSON text of the `NetErr`
as its last `{…}`** (the iOS spike's rejections looked like `FunctionCallException … Caused by: AiwbNetError: {json} (at …)`);
`netInfoOf(err)` in `AiwbNet.ts` reads either form, and the adapter uses only that. **As built, iOS carries the second form**
(`code` `AIWB_NET`, `info` undefined, message `AiwbNetError: {json}`: an Expo `Exception` has a code and a text, no payload), checked on the
simulator, **and so does Android** (`code` `AIWB_NET`, message exactly the JSON). A failure that is none of these
(a bug, a platform failure the table does not know) is `problem` `tls_error` for `openSession`/`readCertificate` and `net reset`
for the others, with the platform's text in `detail`. The adapter maps an error that is no `NetErr` the same way, so the
stub's `not implemented` shows up as `tls_error`/`reset` with that detail.

`detail` is the platform's text, for the user to see, one line, no secret (the module never has one).

### The mapping table

The first two columns are the contract. The platform columns are what AD-31, AD-32 and the spikes found; N1 and N2
correct them where the device says otherwise (the contract's outcome stays). The fake implements the first two columns
and the device test (AD-83) checks the native sides against a real server. `ProblemOutcome` is an outcome of `packages/conn/core/outcomes.js`.

| Situation | `NetErr` | iOS (URLSession, AD-31) | Android (OkHttp, AD-32) |
|---|---|---|---|
| `selfSigned` and `pin == ""` | problem `fingerprint` (no dial) | checked before anything | checked before anything |
| nothing listens at the port | problem `refused` | `NSURLErrorCannotConnectToHost` (-1004) with `_kCFStreamErrorCodeKey` 61 (`ECONNREFUSED`); other codes under it are `no_route` | `ConnectException` whose text has `refused` (`failed to connect to /127.0.0.1 (port N) … ECONNREFUSED (Connection refused)`, measured). **A port that `adb reverse` forwards with nothing behind it is not refused: the emulator accepts and the connection closes at once, which is `tls_error` "connection closed" (measured)**; the device test leaves its closed port out of the reverse |
| the name does not resolve | problem `name_not_found` | `NSURLErrorCannotFindHost`, `NSURLErrorDNSLookupFailed` | `UnknownHostException` (`Unable to resolve host "x": No address associated with hostname`, measured); only IPv4 addresses are used (as the desktop does), so a name with no A record is this too; a host that holds `/ @ ? #` or a blank is refused as this before any address is built |
| no answer to the connect within `dialMs`, no route, network unreachable | problem `no_route` | the module's one timer (`dialMs + handshakeMs`) fired and a `TcpProbe` (a plain `NWConnection`, nothing written) could not connect within one more second; POSIX `EHOSTUNREACH`/`ENETUNREACH`, `NSURLErrorNotConnectedToInternet` | the module's own connect did not finish within `dialMs` (`SocketTimeoutException`, measured against `192.0.2.1` and `10.255.255.1` from the emulator: both time out, neither is a `NoRouteToHostException`); `NoRouteToHostException` and a `ConnectException` that is not a refusal are this too (not measured) |
| the dial failed because the app may not use the local network | problem `local_network_denied` | the failed path's `unsatisfiedReason == .localNetworkDenied` (`NWPathMonitor`, iOS 14+); wins over `refused`/`no_route` | never (no such permission) |
| connected, but the handshake did not end within `handshakeMs` | problem `tls_timeout` | the same timer fired and the `TcpProbe` connected. **URLSession's metrics of a task cancelled while it dials hold no date but the start** (measured), so they cannot say how far the dial came; URLSession's own timeouts are a day and never fire | `SocketTimeoutException` of the handshake read (`soTimeout` = `handshakeMs`; a listener that takes the connection and says nothing, measured) |
| the listener does not speak TLS | problem `not_https` | `NSURLErrorSecureConnectionFailed` (-1200) with `_kCFStreamErrorCodeKey` `errSSLProtocol`, `errSSLPeerProtocolVersion`, `errSSLRecordOverflow` or `errSSLUnexpectedRecord` (a plain HTTP listener, measured) | `SSLException` "Unable to parse TLS packet header" (Conscrypt's text for a plain HTTP listener, measured; the OpenSSL texts "wrong version number", "first record does not look like a TLS handshake", "http request", "packet length too long" are also matched, none was seen) |
| any other TLS failure (alert, no certificate, protocol error) | problem `tls_error` | other `NSURLErrorSecureConnectionFailed`, `-1200`; any other error of a dial, and a connection that broke during it, with the code in `detail` | other `SSLException`, and any other failure of the handshake (a connection that closed during it: "connection closed", measured) |
| `selfSigned`, leaf fingerprint ≠ `pin` | problem `cert_changed`, `fingerprint` = presented, `pinned` = pin as given | the task-level `urlSession(_:task:didReceive:)` answers `.cancelAuthenticationChallenge` and keeps the reason **on that task** (a `Flight`), not on the session; the task then fails with `-999`, which the reason overrides | the trust manager (`PinTrust`) throws a `TrustFailure` inside the handshake, found in the cause chain; nothing is written (a TLS listener that counts bytes saw 0, measured) |
| not `selfSigned`, wrong name | problem `cert_name` | `SecTrustEvaluateWithError`, its error code (`errSecHostNameMismatch`) read first on the trust as given, then on a trust with the leaf as the only anchor (the root out of the way); **a certificate the platform finds "not standards compliant" (-67901: more than 825 days, as the Go server's is) is not judged on its name at all**, so the names in its subjectAltName are read from the DER (`CertificateNames`) and compared with the host | `PlatformTrust`: the name from the certificate's subjectAltName (a `*.` label matches one label) or its common name, **before** the chain, as the Node order says |
| not `selfSigned`, expired or not yet valid | problem `cert_expired` | the same two evaluations (`errSecCertificateExpired`, `errSecCertificateNotValidYet`); the dates of a non-compliant certificate are not read | same |
| not `selfSigned`, self-signed, no root | problem `self_signed` | the leaf's normalized issuer equals its subject | same |
| not `selfSigned`, any other failure | problem `cert_untrusted` | same | same |
| trust accepted, protocol not `h2` | problem `not_aiwb` | the probe's metrics `networkProtocolName != "h2"` | the ALPN of the handshake `openSession` made (`SSLSocket.applicationProtocol`, API 29+; below it the protocol is not known and is accepted); no request is written |
| `cancel` on a call that has not answered | `aborted` | `Flight` marked cancelled, task cancelled; a `cancel` that comes before the call began is remembered (256 ids) and aborts it | the dial's sockets are closed and its promise rejected at once; a call: `Call.cancel()` (one h2 stream reset); a `cancel` that comes before the call began is remembered (256 ids) and aborts it (measured: an `open` in a handshake that never ends is aborted in the time it takes to call) |
| a `fetch`/`stream` on a session that has ended | net `closed` | the session is gone from the registry, or its URLSession is invalidated | the session is gone from the registry or marked ended |
| `headersMs` passed with no headers | net `timeout` | the module's timer; cancels the task (an h2 stream reset). **A stream's head is delivered by URLSession with the first byte of the body**: a response of headers alone waits (measured: 2017 ms for a write after 2000 ms), so on iOS `stream` resolves at the first byte and `headersMs` bounds that. The real server sends `hello` at once | the module's timer cancels the call (one h2 stream reset). OkHttp answers at the headers, so `stream` resolves at the headers (the stand-in's preamble is not needed) |
| body above `maxBytes` | net `too_long` | cancels the task; the connection stays usable | cancels the call (declared `Content-Length` or counted while reading); the connection stays usable (measured) |
| the connection broke, the stream was reset, GOAWAY, `closeSession` while a request was in flight | net `reset` (a stream: `end` with `error: "reset"`) | `NSURLErrorNetworkConnectionLost` (-1005, `_kCFStreamErrorCodeKey` 54 for a TCP reset) and any other error after the headers; a reset ends the session too (`closed`). `closeSession` invalidates the URLSession, so every task fails `-999` with the session closing → reset. **A GOAWAY followed by the server closing the connection politely (FIN) completes the task with no error: the stream "ended cleanly", the session is not closed** (measured with Node's `session.destroy()`; a TCP reset is a reset). The Conn does not tell the two apart (`onEnd(over)`) and opens a new session for each attempt | `IOException` after the headers. A TCP connection that the server destroys reads `StreamResetException: stream was reset: CANCEL` (measured), a reset of the connection the same. **OkHttp has no event for the end of a connection**: the session's socket is a `WatchedSocket`, and when the last connection of the session is closed (the network, a reset, a GOAWAY once its streams are done, `closeSession`) the module ends the session, resets its calls and emits `closed` (once). A failure that left no connection (a connect that failed) ends it too. A server that closes the connection politely after a GOAWAY is a `closed` once the connection is down; `end` is `reset` for a stream that was cut and none for one the server finished (not measured against a GOAWAY) |
| a stream the server ended cleanly | `end` without `error` | task completes with no error | `read()` returns -1: `end` without `error` (measured) |

The fake (`src/fake.ts`) gets the first group of rows from the scripted server of `packages/conn/test/fakes`
(`dialError`, `handshakeHang`, `transport`, `verdict`, the pin) and maps by the **names** `Problem`, `NetError`, `AbortError`.

## Platform notes (not part of the contract, found by the spikes)

- **iOS and ATS.** App Transport Security makes a connection to a **dotted DNS name** with a pinned self-signed certificate fail
  (`-1200`, `-9802`) after the trust hook said yes, unless the app's `Info.plist` has `NSAppTransportSecurity =
  { NSAllowsArbitraryLoads: true }` **and no** `NSAllowsLocalNetworking` (it makes ATS apply again). IP addresses and
  `localhost` work with Expo's default. This is the app's configuration (`app.config.ts`, N1), not the module's. App Store
  acceptance of it is `[not verified]` (`plans/rn-rewrite/spikes/ios-net.md`).
- **iOS and the connection.** URLSession connects at the first request, so `openSession` has to cause one (the probe above),
  or use a connection-level API that can read the ALPN result. One `URLSession` per session id, ephemeral, no cache,
  no cookies, no credential storage, `connectionProxyDictionary = [:]`, `httpMaximumConnectionsPerHost = 1`, `Accept-Encoding: identity`,
  `assumesHTTP3Capable = false`; its delegate queue is the session's serial queue, which also runs the timers.
- **iOS retries a dropped GET by itself.** Measured against a stand-in that resets the TCP connection when it gets `/api/drop`
  (the self-test case "a dropped GET and a dropped POST"): **a GET reaches the server 3 times** before the call fails `reset`, a POST
  once (the spike saw 9 against a server that dropped the TLS handshake). Setting the request apart (a body-less `uploadTask`) did not
  change it; no switch of `URLSessionConfiguration` or `URLRequest` turns it off, and none was found `[not verified]` for a task.
  So a `fetch` of the module may reach a server up to three times, at once, before it rejects `reset` (the Conn's back-off, of seconds,
  comes after, once per call it makes). The calls whose repeat would matter are the POSTs, which are not retried. Whether a stream
  dropped before its headers is retried the same way was not measured `[not verified]`; after its headers it is not (the cut case).
- **iOS and the first byte.** A response is handed to the delegate with the first byte of its body, so `stream` on iOS resolves
  at the first byte (above). The device self-test's stand-in therefore opens its streams with a comment line (`: stream\n\n`),
  which the test takes off the text before the contract sees it, so that the contract's stream cases, which wait for the head of a
  stream that has said nothing, can run (`src/dev/standinControl.ts`, `PREAMBLE`).
- **iOS and the name of a certificate.** The platform judges a name only for a certificate it finds compliant (at most 825 days);
  `cert_name` for the Go server's own ten-year certificate is read from its subjectAltName. A pinned connection never asks.
- **Android, as built (N2).** OkHttp is the one React Native ships (4.9.2, declared as exactly that version). One client per session
  id with a connection pool of one, a trust manager of ours (`Trust.kt`) and a host-name verifier that accepts any name (the trust
  decides, the name included when not `selfSigned`); no proxy, no redirect, no retry (`retryOnConnectionFailure(false)`), `Accept-Encoding:
  identity` unless the caller gave one, IPv4 only (as the desktop), no time limit of its own (`readTimeout`, `writeTimeout`, `callTimeout` 0).
  - **A session is one connection, and it is the one that was judged.** `openSession` makes its own TCP connect and TLS handshake
    under the trust (ALPN `h2`, `http/1.1`), reads the negotiated protocol from it, and hands that very socket to OkHttp as the
    session's connection (the client's socket factory returns it, its TLS socket factory returns the TLS socket made over it):
    **no probe request, one TCP connection** (the contract's "one connection" case counts it), and the certificate that was accepted
    is the one used. A second connection is made only when OkHttp asks for one (a race of calls; a reconnect is not made: a lost
    connection ends the session). Before this was done the module made two (a handshake to judge, another for the calls): the contract's
    "one session carries what is asked of it at once" failed with `got 2, want 1`.
  - **`closed` is made by the module** from the close of the connection's socket (above), not by OkHttp.
  - **The body of a `fetch` is an argument of its own.** An Expo Kotlin `Record` field of type `ByteArray` fails with `DynamicFromMap
    cannot be cast to byte[]` when the options object holds a `Uint8Array`; as an argument of its own it crosses (the spike's finding).
    `src/AiwbNetModule.ts` splits it off on Android; the result's `body` (a `ByteArray` in a `Record`) arrives as a `Uint8Array`
    (1 MiB: 6-11 ms down, 73-157 ms up and down on the emulator).
  - **Events** are coalesced by `StreamPump`: text within 16 ms is one `chunk`, 32 Ki characters (64 KiB in memory) are sent at once,
    `end` follows the last `chunk`, and after `cancel` nothing is sent from the native side (events already queued to the JS thread
    are dropped by the adapter, which ignores a stream it cancelled). At 50 events a second (20 ms apart, more than the window) every event is its own chunk. Measured on the emulator against a Node HTTP/2
    stand-in that wrote 50 events a second (200 bytes each, numbered), read in JS: 240 s, 11,042 events in 10,744 chunks, in order, none
    lost, PSS 109 MB at 14 s, 117 MB at 44 s, then 115 MB to the end, native heap 31.8 → 32.3 MB; and, after the hand-over above, 180 s,
    8,363 events in 8,139 chunks, PSS 136 MB at 14 s, 132 MB at 44 s, 131 MB to the end, native heap 37.6 → 38.0 MB. A warm-up, then flat
    (minutes, not hours; the spike's 21-minute run is the long one).
  - **Retries.** OkHttp does not retry what it sent: a GET and a POST that the server drops each reach it once (self-test case, counted).
  - **Not built / not measured:** a GOAWAY with the connection kept open; IPv6; Android below API 29 (the protocol is then taken as
    `h2`); a physical device; the permission for the local network (none on Android).
- **Flow control.** Node's session takes a 4 MiB window per stream; the platform defaults (64 KiB) slow a picture or a scene over a
  VPN. A platform that can set a bigger window should.

## How it is tested

1. **The fake**, in `node --test` (`cd app && npm test`): `app/test/aiwbnet.test.ts` (the error shape, the table through the fake, the events).
2. **The adapter over the fake**, the same contract the Node connector passes (`packages/conn/test/contract/connector-contract.js`,
   `runConnectorContract(makeConnector, env)`): `app/test/nativeConnector.test.ts`.
3. **The real module on a simulator or emulator** (N1, N2, V5): `node app/e2e/run.mjs net-selftest --platform ios|android --device <id>`
   builds the development build, starts a scratch Go server and the stand-ins, and the screen `src/dev/SelfTestRoot.tsx` runs
   `runNetSelfTest` (`src/dev/netSelfTest.ts`) twice, with the server reached as `127.0.0.1` and by a dotted name
   (`localtest.me`, AD-36): `runConnectorContract` with `nativeConnector(AiwbNetModule)`, cases against the real Go server (the pin,
   the secret, the event stream, the limits, a POST of non-ASCII bytes, the platform's own trust, a name that does not resolve, a
   host with `/`), the retries, and cases of the module (the UTF-8 chunker at every cut, `localNetwork`, the form of a rejection).
   A real Go server cannot list its requests, cut its connections or hang a path; so the contract's kind `aiwb` is the stand-in
   of `@aiwb/conn`'s tests, which can, driven from the device through the control server of `dev/control.mjs`
   (`src/dev/standinControl.ts`): **the whole contract runs** on the device (without the control server, 13 of its 19 cases are
   skipped). The stand-in's `requests()` leaves out the probe of `openSession` (iOS only: `probe`, off on Android, which writes none);
   its `cut()` resets the TCP connection (above: a polite GOAWAY is a clean end on iOS); it opens each event stream with a comment
   (above: the first byte). Android runs the same self-test (N2), reaching the computer through `adb reverse`: the runner reverses
   the ports it knows, **and every server the control server starts** (one per case: `expose`/`unexpose` of `startControl`), but **not**
   the closed port (a reversed port is never refused). Result on the emulator `Medium_Phone_API_36.1` (API 36, arm64): 37 passed with
   the server reached as `127.0.0.1`; 36 passed and 1 skipped (`localNetwork` on a name that is not private) as `localtest.me`.
