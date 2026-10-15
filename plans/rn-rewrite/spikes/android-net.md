# Spike: the native transport on Android (pinned TLS, HTTP/2, a long event stream)

Goal 4.6 and the first rows of risk 9. Branch `rn-spike-android-net`, code in `spikes/android-net/`. Everything below was
measured on the **Android emulator** (AVD `Medium_Phone_API_36.1`: `sdk_gphone64_arm64`, API 36, arm64-v8a, Google Play
image) against a **scratch Go server** (never the user's on 4748), reached through `adb reverse`. **Nothing was run on a
physical device**; see "What this does not prove".

## Verdict

| # | Point | Verdict |
|---|---|---|
| 1 | Connector: accept the certificate iff the SHA-256 of its leaf equals the pin, refuse before any request byte, `cert_changed`; read a fingerprint without trusting | **GO** |
| 2 | HTTP/2 negotiated (`response.protocol == h2`) | **GO** |
| 3 | A request with headers, body and a response size limit | **GO** |
| 4 | The event stream as text chunks to JS, parsed in JS; cancel/close | **GO** |
| 5 | Memory over a 20 minute stream | **GO** for 21 minutes (three runs, PSS flat after warm-up: 77 MB in the last run, ±1 MB from minute 3 to minute 18; the first run drifted up 5 MB over 15 minutes, see below); hours not measured |

Overall for the Android transport: **GO**. Nothing had to be worked around. Unlike iOS there is no ATS-like switch: a
pinned self-signed certificate reached by a dotted DNS name worked with no manifest change (check
`hello_by_dotted_dns_name`). The things the real implementation must do differently are at the end.

## Versions

Expo SDK **57.0.28** (`expo` ~57.0.28, `expo-modules-core` 57.0.22), React Native **0.86.3**, React 19.2.3, Hermes (new
architecture on, the SDK 57 default), TypeScript 6.0.3, template `blank-typescript`, created with `create-expo-app`.
The app is an Expo **dev build** (`expo prebuild` + Gradle, the same as `npx expo run:android`; not Expo Go) built in the
**release** variant, so the JS bundle is inside the APK and no Metro is needed (release is also the build whose memory means
something). Android: Gradle 9.3.1, Android Gradle Plugin 8.12.0, Kotlin 2.1.20, compileSdk/targetSdk 36, minSdk 24, NDK
27.1.12297006, CMake 3.22.1, build-tools 36.0.0 (the version React Native pins). **OkHttp 4.9.2**, the version React Native 0.86 ships (it is in
`react-native/gradle/libs.versions.toml`); the module declares exactly that version so Gradle resolves one. The module is
a **local** Expo module (`app/modules/aiwb-net`, autolinked, Expo Modules API, Kotlin).
Machine: macOS 15 on Apple silicon, Node 24.3.0, Go 1.25.1, `openssl` (LibreSSL) for the probe's certificate.

**SDK packages added:** React Native 0.86 wants `platforms;android-36` and `build-tools;36.0.0`; the machine had only
`android-36.1` and build-tools 35.0.0/36.1.0, so Gradle downloaded the two into `~/Library/Android/sdk` on the first build (the
licences were already accepted). They are still there; nothing else was added to the SDK.

**JDK:** none was on `PATH` and `/usr/libexec/java_home` found none. Android Studio is not installed (no bundled JBR). I used
the **Homebrew `openjdk@17` (17.0.15) that was already installed** at `/opt/homebrew/opt/openjdk@17`, with `JAVA_HOME` set
in `run.mjs`; nothing was installed.

Cost: first cold Gradle build about 3 minutes (the one that failed at the Kotlin compile), then 10-20 s for a changed module
or bundle. The release APK is 68.7 MB (four ABIs, `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`).

## How to run it (repeatable, no clicking)

```sh
node spikes/android-net/run.mjs --minutes 0            # the 26 short checks, about 1 minute after the first build
node spikes/android-net/run.mjs                        # the same plus the 21 minute stream with memory samples (about 26 minutes)
node spikes/android-net/run.mjs --minutes 21 --idle-minutes 3 --sample-every 180 --keep-emulator   # the options
```

`run.mjs` does, in order: takes `/tmp/aiwb-android-emulator.lock`; builds the Go server and starts a **scratch server** (its own
`-home` in a temp folder and a free port, as `web/e2e/lib/rig.mjs` does; it is set up for the names `127.0.0.1` and
`localtest.me`); starts the **stand-ins** (below); boots the AVD when no emulator runs, keeps the screen on, and
`adb reverse`s the ports; runs `expo prebuild` if `android/` is missing, `gradlew app:assembleRelease` (it does not need
Metro), and `adb install -r`; launches the app with `adb shell am start -a VIEW -d 'aiwbspike://run?cfg=<json>'` (the
port, the pin, the secret of the scratch server: the app reads it with `Linking.getInitialURL()`); reads the lines the app
logs with the tag `AIWBSPIKE` from `adb logcat`; samples `adb shell dumpsys meminfo dev.aiwb.netspike` at the start of the
long stream and every 180 s and at its end; checks the stand-ins' counts; writes `spikes/android-net/out/` (not committed:
`lines.jsonl`, `result.json`, `meminfo.txt`); and cleans up (stops the scratch server, the stand-ins, `adb reverse
--remove`, the app, `stayon false`, **the emulator** unless `--keep-emulator`, the lock, also after an uncaught error). It exits 0
only when every check passed, the wrong-pin stand-in received **0 bytes** and the control stand-in received more than 0.
The last full run: 28 check lines, 0 failed (`android-net-evidence/final-run.log`, `final-lines.jsonl`, `final-result.json`,
`final-meminfo.txt`).

Stand-ins started by the runner (all in `run.mjs`): two **TLS servers** with a certificate that is not the Go server's, that
count the application bytes written to them after the handshake (the *tripwires*: one for the wrong pin, one for the right
pin as the control); a plain TCP server that answers `HTTP/1.1 400`; a closed port; a **Node HTTP/2** server (the probe's
certificate) with an event stream that ends, one whose connection is dropped, and one that goes silent.

## The native module as built

`import AiwbNet from './modules/aiwb-net/src/AiwbNetModule'`; `app/src/net.ts` is the JS layer over it (`Session`,
`readCertificate`, `EventReader`, `Problem`, `stateOf`).

Kotlin (`modules/aiwb-net/android/src/main/java/expo/modules/aiwbnet/`: `Trust.kt`, `Net.kt`, `AiwbNetModule.kt`):

| Function | Does |
|---|---|
| `readCertificate(host, port, dialMs, handshakeMs): Promise<string>` | TCP connect (IPv4), TLS handshake with a trust manager that takes anything, returns the **leaf's** fingerprint (`AA:BB:…`, uppercase, 32 pairs: the format of `fingerprintOf` in `tls.js`), closes the socket. No application byte is written |
| `openSession(host, port, pin, dialMs, handshakeMs, preflight): Promise<{id, fingerprint, alpn}>` | an empty pin rejects `fingerprint` and dials nothing. With `preflight` (the default in JS) it makes **its own TCP+TLS handshake under the pin** and closes it (so a wrong pin is an error of `openSession`), and checks ALPN is `h2` (`not_aiwb` otherwise; API 29+). It then builds the session: one `OkHttpClient` (one connection pool) with the pin trust manager. `preflight=false` exists only for the test that shows the requests' own connection judges too |
| `request(opts): Promise<{status, headers, protocol, body, bytes}>` | `opts`: `session, id, method, path, headers, body \| bodyBase64, limitMs, headersMs, maxBytes, responseEncoding (utf8\|base64)`. The whole answer. `limitMs` = OkHttp `callTimeout` → `timeout`; `headersMs` = a timer that cancels the call → `timeout`; more than `maxBytes` (declared by `Content-Length` or counted while reading) cancels the h2 stream and rejects `too_long`. `protocol` is `response.protocol` (`"h2"`) |
| `startStream(opts): Promise<{status, headers, protocol}>` | resolves at the response headers. The body arrives as events `onStream {id, kind:'chunk', text}` and one `{id, kind:'end', error}` (`error` is `""` for the server's clean end, else `aborted`, `reset`, `timeout`…). No read timeout and no call timeout: silence is JS's (the watchdog of `conn.js`) |
| `cancel(id)` / `closeSession(sessionId)` | cancel one request or stream (its promise rejects / its `end` event says `aborted`) / cancel all, shut the dispatcher, evict the pool |
| `sessionStats(id)`, `echoBytes(bytes)`, `memory()`, `log(line)` | spike plumbing: connections made by a session, a `Uint8Array` round trip, Debug memory, `Log.i("AIWBSPIKE", …)` |

**The trust rule** (`Trust.kt`, the only place a certificate is judged): `PinTrust : X509TrustManager`. `checkServerTrusted`
takes the **leaf** `chain[0]`, SHA-256 of its DER, compares with the normalized pin (`normalFingerprint`, a port of `list.js`:
colons and case do not matter, a pin that is no fingerprint fits no certificate). Equal → return; anything else → throw
`PinMismatch(presented, pinned)`, a `CertificateException`, **inside the handshake**. `checkClientTrusted` throws, the accepted
issuers are empty. The system roots, the dates and the name are never asked. The OkHttp client has `hostnameVerifier { _, _ -> true }`
(the pin is the rule; the desktop accepts any name too) and a DNS that returns IPv4 only (the desktop dials `family: 4`).
`classify()` (`Net.kt`) walks the exception's cause chain for the `PinMismatch` (so it works for a failure inside OkHttp too) and
maps the rest like `dialProblem`/`tlsProblem` of `tls.js`: `ECONNREFUSED` → `refused`, `UnknownHostException` → `name_not_found`,
other connect failures and connect timeouts → `no_route`, a handshake timeout → `tls_timeout`, "Unable to parse TLS packet
header" / "wrong version number" → `not_https`, other `SSLException` → `tls_error`, `InterruptedIOException("timeout")` → `timeout`,
the rest → `reset`.

Failures reject with an Expo `CodedException` whose `code` is the outcome (the names of `desktop/conn/outcomes.js`: `refused`,
`name_not_found`, `no_route`, `tls_timeout`, `not_https`, `fingerprint`, `cert_changed`, `tls_error`, `not_aiwb`) or the
`NetError` code of `session.js` (`timeout`, `reset`, `too_long`, `closed`) or `aborted`, and whose `message` holds the JSON
`{detail, fingerprint, pinned}` (the Expo error object has `code` and `message` only; there is no place for a structured
`info`, so the JSON rides in the message). `net.ts` `toProblem()` turns it into the `Problem` of `outcomes.js`; `stateOf`
(copied) gives `certificate_changed` for `cert_changed`.

The UTF-8 chunker (`Utf8Chunks`) decodes incrementally and keeps the bytes of a cut character for the next read, so JS only
ever sees whole characters.

## Evidence per point

### 1. Connector (GO)

Lines from `android-net-evidence/final-lines.jsonl` (final run; fingerprints shortened):

```
cert_read_without_trust        PASS  fingerprint C8:DB:90:…:37:4C (equal to the one `remote setup` printed)
cert_read_refused_port         PASS  outcome refused, state unreachable   (ECONNREFUSED)
cert_read_plain_http_port      PASS  outcome not_https   (Unable to parse TLS packet header)
session_open_right_pin         PASS  alpn h2, fingerprint C8:DB:90:…:37:4C
session_open_lowercase_pin_no_colons PASS
session_open_wrong_pin_real_server   PASS  cert_changed, state certificate_changed, presented=C8:DB:…  pinned=A8:DB:…
session_open_no_pin            PASS  outcome fingerprint, state fingerprint_not_accepted
session_open_garbage_pin       PASS  cert_changed, pinned "not a fingerprint"
```

**Refused before any request byte.** Two ways, both against a TLS server that is not the Go one and counts the bytes written
to it after the handshake. (a) `openSession` with a wrong pin (`wrong_pin_probe_server_sends_nothing`); (b) a session that
skipped the preflight, so the **request's own connection** (OkHttp, the path a reconnect takes) judges the certificate, and
the request carries the secret header and a path (`wrong_pin_on_the_requests_own_connection_probe_gets_nothing`): the error
is `cert_changed` with the probe's real fingerprint as `presented` in both. The stand-in counted:

```
probe wrongPinBytes 0, wrongPinConnections 2 ({"secure":false,"bytes":0,"tlsClientError":true} twice)
probe controlBytes 448   (two right-pin sessions: the preflight connection 0 bytes, the connection of the request 224 bytes each: the HTTP/2 preface and SETTINGS of OkHttp)
```

so the tripwire does see what is written, the two wrong-pin connections ended in a client abort of the handshake
(`tlsClientError`) with **0 application bytes**, and the secret never left the phone. The control with the right pin is
`right_pin_probe_server_gets_request_and_times_out`: the handshake is accepted, the request is written, the stand-in never
answers, the call rejects `timeout` after 2.5 s. `readCertificate` never writes (it is a handshake and a close; the tripwire
is not used for it, the code has no write).

### 2. HTTP/2 (GO)

```
hello_h2   PASS  status 200, protocol "h2", hello {"app":"ai-whiteboard","featureLevel":6,…}
state_authenticated PASS  status 200, protocol h2, 938 bytes
stream_snapshot_first_then_events_and_cancel PASS  stream head protocol "h2"
one_h2_connection_for_a_stream_and_8_concurrent_requests PASS  {"connects":1}
```

`protocol` is `response.protocol.toString()` of every response; the stream and eight parallel requests started at the same
moment on a fresh session shared **one** TCP+TLS connection (an `EventListener` counts `connectEnd`). The ALPN of the
preflight handshake also says `h2` (`session_open_right_pin`). The Node HTTP/2 stand-in is spoken to as well (3 checks), so it
is not only the Go server's HTTP/2.

### 3. Requests (GO)

```
state_authenticated        PASS  GET /api/state with X-AIWB-Secret/-Client/-Level: 200, keys agents,catalogs,home,…,chats (the list is empty: no agent on the scratch server)
state_wrong_secret_is_401  PASS  401 {"error":"unauthorized"}
response_size_limit        PASS  too_long for maxBytes 10 on /api/state (938 bytes); the same session answers the next hello
post_with_json_body        PASS  POST /api/groups, content-type application/json, body {"name":"spike ünïcödé ✓"} → 200 {"id":"g_…","name":"spike ünïcödé ✓"}
abort_a_request            PASS  AbortSignal at 300 ms → rejects aborted
right_pin_probe_…_times_out PASS  limitMs 2500 → timeout
hello_by_dotted_dns_name   PASS  localtest.me (resolves to 127.0.0.1), the scratch server set up for that name too: 200 over h2
```

The "chats list" is `GET /api/state` (it has `chats`; the scratch server has no agent, so no chat could be made and the
list is empty; the parsing of a non-empty one is not exercised). The three headers are sent on every call. A body goes as UTF-8
text or as base64 (`bodyBase64`), a response comes as text or base64 (`responseEncoding`).

### 4. The event stream (GO)

```
stream_snapshot_first_then_events_and_cancel  PASS  types ["hello","snapshot","groups"], cancel → end(aborted) 4 ms later
stream_open_cancel_x10_then_session_still_works PASS
stream_ends_when_session_closes                PASS  closeSession → end(aborted)
stream_ended_by_the_server_is_end_with_no_error PASS  clean end → error "" ; "héllo ✓" arrives intact
stream_cut_by_a_dropped_connection_is_end_with_reset PASS  TCP socket destroyed by the server → error "reset"; the next request opens a new connection (connects 2)
silent_stream_is_cut_by_a_js_watchdog_with_cancel PASS  3.0 s without a byte, then cancel → end(aborted) 3 ms later
long_stream_held                               PASS  21 min 1 s, never ended
idle_stream_gets_pings                         PASS  last 181 s with no change: 9 pings, the longest gap 20.0 s
```

The server opens the stream with a `hello` event, then the `snapshot`, then the events (`groups`), then pings (`: ping`, every
20 s whether or not events flow: 63 pings in 21 minutes). JS parses them with `EventReader` (a line-for-line port of `sse.js`,
on text). Cancel works on a live stream, on a silent one, in a loop of ten, and `closeSession` ends the streams of the
session. The reading thread blocks in `read()` with **no timeout**; the call ends because `Call.cancel()` closes the
stream; an idle HTTP/2 stream held with only pings for three minutes was not closed by OkHttp or the emulator.

### 5. Memory over a long stream (GO for 21 minutes)

Final run: the app held one event stream for 1261 s (21 min), and changed the board's groups once a second for the first 18
minutes (40 groups of about 100 characters, so every `groups` event was some kilobytes: the whole list), then nothing for the last 3
minutes. Counters from the app at the end: **1380 chunks, 5,740,289 characters (5.5 MiB) of text, 1019 events (1 hello,
1 snapshot, 1017 `groups`), 63 pings**, 1016 changes made, the longest gap between two chunks 23 s (at the switch to the idle phase, before the first ping), no end of the stream. `dumpsys meminfo dev.aiwb.netspike`, all in KB:

| Sample | Time into the stream | TOTAL PSS | TOTAL RSS | Java Heap | Native Heap |
|---|---|---|---|---|---|
| start | 12 s | 68,301 | 169,276 | 4,744 | 14,932 |
| | 192 s | 76,514 | 179,236 | 10,240 | 13,236 |
| | 373 s | 76,983 | 180,052 | 10,132 | 13,268 |
| middle | 553 s | 77,586 | 180,696 | 10,112 | 13,252 |
| | 734 s | 78,187 | 180,992 | 10,200 | 13,312 |
| | 914 s | 77,955 | 180,788 | 9,988 | 13,260 |
| | 1095 s (idle) | 75,148 | 177,664 | 7,904 | 13,228 |
| end | 1261 s | 74,203 | 176,692 | 7,704 | 13,200 |

(`final-meminfo.txt` holds the full `dumpsys` of each sample.) PSS rose 8 MB from the start sample to minute 3 (the JS engine,
JIT and first allocations warming up; the sample at 12 s is the first one) and then stayed within 1.7 MB (76.5-78.2 MB) until the idle phase, ending 4.0 MB below its highest sample. Native heap is flat to within 0.1 MB (13.2-13.3 MB) for 20 minutes, so nothing accumulates on the
Kotlin/OkHttp side; the Java heap saws between 5 and 10 MB with the garbage collector.

The two earlier full runs of the same code (the first without the 3 minute idle phase and with fewer checks, the second like
the final one) are in the evidence folder and agree on the shape, with other baselines (the baseline depends on the process,
not on the run's length): run 1 (`run1-result-no-idle-phase.json`): PSS 62.6 MB at 14 s, 49.1 at 194 s, then 52.8, 53.3, 54.3,
54.0, 54.5 and **58.0 MB at the end** (+9 MB from minute 3, of which 4 came in the last sample, taken just after the stream
ended); run 2 (`run2-run.log`): 73.5, 85.0, 85.1, 85.7, 85.6, 85.4, 84.6, 82.5 MB. Native heap did not grow in either
(run 1: 8.3 MB at 194 s, 7.2 at the lowest, 7.8 at the end; run 2: 12.9-13.3 MB). So in three runs: a warm-up step, then a plateau, no growth with the number of events. **One run, the first,
drifted up 5 MB over 15 minutes and 9 MB to the end.** Whether that is JS heap that the collector had not yet taken or a slow
leak, 21 minutes cannot say. What this does not prove: *hours*. The volume (about 5 KB per second, 5.5 MiB of text in the 21 minutes)
is small next to a long chat. A soak of several hours with `Debug.dumpHprofData` at the start and the end is the proof 4.8
asks for; it was not made.

## Problems met, and how they were solved

- **No JDK.** `java` was not on `PATH`; Android Studio is not installed. The Homebrew `openjdk@17` was installed and sufficed.
  `run.mjs` sets `JAVA_HOME` itself (`$JAVA_HOME` wins when set).
- **`create-expo-module --local` with a path argument** made `modules/modules/aiwb-net`. Moved by hand. Its template has a `web`
  stub and a view; both were deleted.
- **OkHttp 4.9.2's `Dns` is not a `fun interface`**: `Dns { … }` does not compile (`Interface 'Dns' does not have constructors`);
  an `object : Dns` does. Also the Kotlin API of 4.9.2 is the 4.x one (`toRequestBody`, `toHeaders`), fine.
- **The probe's certificate was refused by Android**: macOS `openssl` is LibreSSL and `-newkey ec` writes explicit curve
  parameters that BoringSSL rejects (`DECODE_ERROR … ec_asn1`), before our trust manager runs. An RSA key works. (Go's certificate is fine.)
- **"Unable to parse TLS packet header"** is what Conscrypt says when the peer answers plain HTTP; it was not in the `not_https`
  patterns of `tls.js` (those are OpenSSL's texts). Added.
- **`callTimeout`** surfaces as `InterruptedIOException("timeout")`, which first mapped to `reset`; now `timeout`.
- **The stream begins with a `hello` event**, then the snapshot (`Bridge.Serve`); a check that wants the snapshot "first" must
  allow it (`conn.js` holds events before the snapshot, as `before`).
- **Node `http2` refuses `session.socket.destroy()`** (`ERR_HTTP2_NO_SOCKET_MANIPULATION`) in the stand-in; the raw TCP socket is
  kept from the server's `connection` event. A thrown error in a timer had also left the lock and a scratch server behind once;
  `run.mjs` now cleans up on `uncaughtException` too.
- **`expo run:android` opens `aiwbspike://expo-development-client/?url=…`** on the device when it installs; the app's launch
  handler only takes `aiwbspike://run?…`.
- **macOS has no `timeout`**; `adb` prints `device offline` right after an emulator boot: the boot wait retries.

## What the real implementation should do differently

1. **Keep the preflight, or drop it knowingly.** OkHttp has no public "connect now". The module judges the certificate twice
   per session: in the preflight handshake (so `open()` can fail with `cert_changed`/`not_aiwb` before any call, as the
   `Connector` contract in AD-30 says) and again in the handshake the first request makes. The pin check is in the trust
   manager, so the second one is also safe (tested with `preflight=false`); the cost is one extra handshake per session
   (an RTT or two over a VPN). Dropping it means the first call (hello) carries the trust errors and `h2` is judged from
   `response.protocol`; that changes the `Connector` contract.
2. **OkHttp does not tell the session is gone.** There is no `closed` event for the connection (OkHttp 4.9.2 has no hook for it;
   `EventListener` has `connectionReleased` per call, not a close). A dropped connection ends the stream with `reset` and the
   next call **silently opens a new connection** (`connects` 2; the trust manager judges again, so it stays safe). The AD-30
   `closed {session}` event therefore has to be made by the JS adapter: treat a stream end with `reset` or a `reset` of a call
   as the session closed, close it, and let `Conn` open a new one (what `attempt()` already does when the stream ends).
3. **Errors carry `code` + JSON in `message`**, not `code: 'AIWB_NET'` with `info` (AD-30): Expo's JS error has no other field.
   The adapter parses the message (`toProblem`). If AD-30's shape is wanted, wrap in the adapter.
4. **Coalesce chunk events.** The spike sends one event per `read()` (16 KB buffer, usually one h2 DATA frame); 1380 events for 5.5 MiB were
   fine, but AD-30's "coalesce within 16 ms, never hold more than 64 KiB" is cheap to add and bounds the bridge's queue: native
   pushes whether or not JS keeps up (`sendEvent` has no backpressure).
5. **Binary bodies.** The spike moved bodies as UTF-8 text or base64 and also tried a `Uint8Array` through an Expo function
   (`ByteArray` in Kotlin): it **works both ways in SDK 57** (`uint8array_round_trip_through_the_bridge`: 1 MiB each way, 48 ms
   in the final run, 153 ms in an earlier cold one). AD-30's `[not verified]` for Android is thus answered for small buffers.
   Not measured: a 5 MB picture or a 128 MiB scene (the latter, at 50-150 ms per MiB each way, would be several seconds of
   copying and a lot of memory: chunk it, or add the `fetchToFile` the architecture mentions).
6. **`selfSigned: false` is not built.** Only the pin mode was asked for. The other mode is the default trust manager and
   hostname verifier with the exception chain mapped to `cert_name`/`cert_expired`/`self_signed`/`cert_untrusted`
   (`CertificateExpiredException`, `CertPathValidatorException` with `NO_TRUST_ANCHOR`, the hostname verifier's failure); it
   was not tried here.
7. **Timeouts are the module's, silence is JS's**: `headersMs` is a scheduled cancel, `limitMs` the OkHttp `callTimeout` (a
   `client.newBuilder()` per call shares the pool, so one HTTP/2 connection is kept), and a stream has no timeout at all:
   `conn.js`'s watchdog (`silence`) must stay in the shared code, and a cancel after it ends the call in milliseconds (checked).
8. **One OkHttp client per session, with `retryOnConnectionFailure(false)`** (no hidden retry of a request that may have
   reached the server), an IPv4-only DNS (as the desktop), `readTimeout 0`, `writeTimeout 30 s`.
9. **Old OkHttp.** 4.9.2 is what React Native 0.86 pins (from 2021); overriding it risks the RN modules that share it. It
   negotiated h2 and TLS 1.3 here (API 36). **Below API 29** Conscrypt's ALPN API is reflected through OkHttp's platform class
   and the preflight skips its ALPN check (`alpn: "unknown"`); minSdk is 24 and nothing below 36 was run.
10. **Keep a log tag.** `Log.i("AIWBSPIKE", …)` through `adb logcat -s AIWBSPIKE:I` was the whole reporting channel, and made
    the run scripted; the real app's own device-test script (7.4) can use the same.

## What the Android install needs (for the final report of 4.9)

The spike installed with `adb install -r app-release.apk` on the emulator. For a **real device over USB** the user needs:

- **No account**, no Google account, no Play Console, no store: the APK is installed by `adb`.
- On the phone: **Developer options → USB debugging** on (tap *Build number* seven times first), the USB cable, and *Allow USB
  debugging* for the Mac's RSA key when asked. Some makers (Xiaomi/MIUI, Oppo, Vivo) have a further switch, *Install via USB*,
  and may ask for a login to the maker's account to turn it on `[not verified]`.
- On the Mac: the Android SDK platform-tools (`adb`), and for building: the SDK platform 36, build-tools 36.0.0, NDK 27.1.12297006 and CMake
  3.22.1 (Gradle fetches the first two when missing; all are in `~/Library/Android/sdk` here), and a **JDK 17** (Homebrew's `openjdk@17` worked).
- **Signing needs no secret and no keystore of the user's.** `expo prebuild` copies a standard **debug keystore** into
  `android/app/debug.keystore` (the template's; I ran prebuild twice into two folders and the file's MD5 was the same,
  `4d3dbe54…`), and the template signs the `release` build type with it too (`signingConfig signingConfigs.debug`, "Caution!
  In production, you need to generate your own keystore"). It is a public key with the well-known password, not a credential.
  Because it is the same file on every prebuild, `adb install -r` over an earlier build works; an app installed from
  another machine/template key would need `adb uninstall dev.aiwb.netspike` first (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
  Store signing (Play, an upload key) is out of the goal.
- The device reaching a server: nothing in the manifest but `INTERNET` (the template has it); no `networkSecurityConfig` and no
  cleartext (the trust manager is custom, so the platform's Network Security Config for the default trust does not apply, and
  there is no cleartext). Servers on the LAN or a VPN need the phone on that network. `adb reverse tcp:<port> tcp:<port>` also
  works with a USB device if the server is on the Mac (the spike used it on the emulator).
- A newer Android version may put access to the local network behind a permission `[not verified]`: the emulator on API 36
  asked for nothing, and a loopback connection through `adb reverse` is not the case such a permission is about.

## What this does not prove

- **A physical device.** Only an arm64 emulator on API 36 (Google Play image). A real network (Wi-Fi, a VPN, mobile data), a
  real TLS stack of a maker's build, a battery saver, and the permission for the local network were not exercised.
- **Hours.** 21 minutes, three runs; the first drifted by 9 MB (above). The volume of text was small.
- **Background.** The app stayed in the foreground with the screen on (`svc power stayon true`). What Android does to the
  stream when the app is suspended, Doze, a network change (Wi-Fi → mobile) and a half-open connection (packets dropped,
  not refused) were not tested. The silent-stream check is a server that is alive and says nothing, over a good link.
- **`selfSigned: false`**, IPv6, a server certificate with an unusual chain, an expired or not-yet-valid certificate (the pin
  accepts them; checked only with the Go server's 10-year certificate and the probe's 2-day one).
- **A real chat.** The scratch server has no agent, so the events were `groups` changes, not a streaming answer; no picture and
  no big scene were fetched or sent.
- **Android below API 36**, and 32-bit ABIs (they build; nothing ran).

## Files

- `spikes/android-net/run.mjs`: the repeatable run (above).
- `spikes/android-net/app/`: the Expo app (`App.tsx` reads the launch URL; `src/checks.ts` the checks; `src/net.ts` the JS layer),
  `app.json` (scheme `aiwbspike`, package `dev.aiwb.netspike`), `modules/aiwb-net/` (the Kotlin module and its TypeScript
  declarations). `android/`, `node_modules/` and the module's `android/build/` are not committed.
- `plans/rn-rewrite/spikes/android-net-evidence/`: the lines of the final run (`final-lines.jsonl`, `final-run.log`), the result
  with the probe's counts and the memory samples (`final-result.json`), the `dumpsys meminfo` text of every sample
  (`final-meminfo.txt`), and the two earlier full runs.
- Note for the integration branch: `desktop/conn` is `packages/conn` there now; this report uses the old paths of the code the
  spike read (`tls.js`, `session.js`, `sse.js`, `conn.js`, `outcomes.js`), the semantics are the same.
