package expo.modules.aiwbnet

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

// The Android side of `aiwb-net` (package N2): the contract of the module's README.md over OkHttp, starting from the
// code the Android spike proved (plans/rn-rewrite/spikes/android-net.md). It holds no decision of the app: it dials, judges
// the certificate by the pin, speaks HTTP/2 through the platform's stack and reports. The TypeScript of the contract is
// src/AiwbNet.ts; Trust.kt is the trust rule, Tls.kt the dial and the one address function, NetSession.kt the session,
// StreamPump.kt the events of a stream, NetFailure.kt the errors.

// ---- Options (typed, so that a number from JS is a number) and results ----

class OpenSessionArgs : Record {
  @Field var request: String = ""
  @Field var host: String = ""
  @Field var port: Int = 0
  @Field var selfSigned: Boolean = false
  @Field var pin: String = ""
  @Field var dialMs: Int = 0
  @Field var handshakeMs: Int = 0
}

class ReadCertificateArgs : Record {
  @Field var request: String = ""
  @Field var host: String = ""
  @Field var port: Int = 0
  @Field var dialMs: Int = 0
  @Field var handshakeMs: Int = 0
}

class FetchArgs : Record {
  @Field var session: String = ""
  @Field var request: String = ""
  @Field var method: String = "GET"
  @Field var path: String = "/"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var headersMs: Int = 0
  @Field var maxBytes: Double = 0.0
}

class StreamArgs : Record {
  @Field var session: String = ""
  @Field var request: String = ""
  @Field var method: String = "GET"
  @Field var path: String = "/"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var headersMs: Int = 0
}

class OpenedSession(@Field var session: String = "", @Field var fingerprint: String = "") : Record

class CertificateResult(@Field var fingerprint: String = "") : Record

class FetchResult(
  @Field var status: Int = 0,
  @Field var headers: Map<String, String> = emptyMap(),
  @Field var body: ByteArray = ByteArray(0),
) : Record

class StreamHead(@Field var status: Int = 0, @Field var headers: Map<String, String> = emptyMap()) : Record

/** A promise that is settled once: `cancel` rejects `aborted` at once, and the work that was under way finds it out later. */
private class Settle(private val promise: Promise) {
  private val done = AtomicBoolean(false)

  /** true: this call settled the promise. */
  fun resolve(value: Any?): Boolean {
    if (!done.compareAndSet(false, true)) return false
    promise.resolve(value)
    return true
  }

  fun reject(f: NetFailure): Boolean {
    if (!done.compareAndSet(false, true)) return false
    promise.reject(CodedException(CODE, f.json(), null))
    return true
  }

  companion object {
    /** The `code` of every rejection that is a NetErr (AiwbNet.ts: AIWB_NET); the message is its JSON text. */
    const val CODE = "AIWB_NET"
  }
}

class AiwbNetModule : Module() {
  private val sessions = ConcurrentHashMap<String, NetSession>()
  private val pool = Executors.newCachedThreadPool { r -> Thread(r, "aiwbnet").apply { isDaemon = true } }
  private val timers = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "aiwbnet-timer").apply { isDaemon = true } }.apply { removeOnCancelPolicy = true }

  // The requests that `cancel` can still end, by the id the caller made. `cancel` may come before the call has begun:
  // such an id is remembered, and the call that comes is aborted.
  private val ops = HashMap<String, Cancellable>()
  private val early = LinkedHashSet<String>()

  /** false: the request was cancelled before it began. */
  private fun begin(id: String, op: Cancellable): Boolean = synchronized(ops) {
    if (early.remove(id)) return false
    ops[id] = op
    true
  }

  private fun finish(id: String) { synchronized(ops) { ops.remove(id) } }

  private fun cancelRequest(id: String) {
    val op = synchronized(ops) {
      val o = ops[id]
      if (o == null) {
        early.add(id)
        while (early.size > REMEMBERED) early.remove(early.first())
      }
      o
    }
    op?.cancel()
  }

  private fun emit(name: String, body: Map<String, Any?>) {
    try { sendEvent(name, body) } catch (_: Throwable) { /* the module is gone */ }
  }

  private fun sessionEnded(s: NetSession) {
    sessions.remove(s.id, s)
    emit("closed", mapOf("session" to s.id))
  }

  /** What a call that failed says, for a call on a session (`fetch`, `stream`). */
  private fun failureOf(t: Tracked, s: NetSession?, e: Throwable): NetFailure {
    if (e is NetFailure) return e
    when (t.reason) {
      "aborted" -> return NetFailure.aborted()
      "timeout" -> return NetFailure.net("timeout", "no response headers in time")
      "too_long" -> return NetFailure.net("too_long")
      "reset" -> return NetFailure.net("reset", "the session ended")
    }
    // A failure of the transport that the module did not cause: the connection broke, was reset, or could not be made.
    if (e is IOException) s?.checkAlive()
    var cause: Throwable? = e
    while (cause != null) {
      if (cause is TrustFailure) return NetFailure.net("reset", "${cause.failure.outcome}: ${cause.failure.detail}")
      cause = cause.cause
    }
    return NetFailure.net("reset", oneLine(e))
  }

  /** The call, with the time limit of its headers armed (`headersMs`); it answers as soon as the headers are in. */
  private fun execute(call: okhttp3.Call, t: Tracked, headersMs: Int): okhttp3.Response {
    t.call = call
    t.reason?.let { call.cancel() }
    val timer = if (headersMs > 0) timers.schedule({ t.stop("timeout") }, headersMs.toLong(), TimeUnit.MILLISECONDS) else null
    try {
      return call.execute()
    } finally {
      timer?.cancel(false)
    }
  }

  private fun runFetch(o: FetchArgs, body: ByteArray?, st: Settle, t: Tracked) {
    var s: NetSession? = null
    try {
      s = sessions[o.session]?.takeIf { !it.ended } ?: throw NetFailure.net("closed", "the session has ended")
      val request = s.request(o.method, o.path, o.headers, body)
      s.calls[o.request] = t
      if (s.ended) throw NetFailure.net("closed", "the session has ended")
      val maxBytes = if (o.maxBytes > 0) o.maxBytes.toLong() else Long.MAX_VALUE
      val result = execute(s.client.newCall(request), t, o.headersMs).use { r ->
        val declared = r.body?.contentLength() ?: -1L
        if (declared > maxBytes) { t.stop("too_long"); throw NetFailure.net("too_long") }
        val buf = okio.Buffer()
        val src = r.body!!.source()
        while (true) {
          val n = src.read(buf, 64 * 1024)
          if (n < 0) break
          if (buf.size > maxBytes) { t.stop("too_long"); throw NetFailure.net("too_long") }
        }
        FetchResult(r.code, headersOf(r), buf.readByteArray())
      }
      st.resolve(result)
    } catch (e: Throwable) {
      st.reject(failureOf(t, s, e))
    } finally {
      s?.calls?.remove(o.request, t)
      finish(o.request)
    }
  }

  private fun runStream(o: StreamArgs, st: Settle, t: Tracked) {
    var s: NetSession? = null
    try {
      s = sessions[o.session]?.takeIf { !it.ended } ?: throw NetFailure.net("closed", "the session has ended")
      val request = s.request(o.method, o.path, o.headers, null)
      s.calls[o.request] = t
      if (s.ended) throw NetFailure.net("closed", "the session has ended")
      val r = execute(s.client.newCall(request), t, o.headersMs)
      val pump = StreamPump(o.request, timers, ::emit)
      t.pump = pump
      if (t.reason == "aborted") { r.close(); throw NetFailure.aborted() }
      if (!st.resolve(StreamHead(r.code, headersOf(r)))) { r.close(); return }
      // The body: text, in order, as it comes. The thread blocks in read() with no time limit: silence is the shared code's,
      // and a `cancel` ends the call, which ends the read.
      var cut = false
      try {
        r.use {
          val dec = Utf8Chunks()
          val input = r.body!!.byteStream()
          val buf = ByteArray(16 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            pump.push(dec.push(buf, n))
          }
          pump.push(dec.finish())
        }
      } catch (e: Throwable) {
        cut = true
        if (t.reason != "aborted" && e is IOException) s.checkAlive()
      }
      if (t.reason == "aborted") pump.silence() else pump.end(cut)
    } catch (e: Throwable) {
      st.reject(failureOf(t, s, e))
    } finally {
      s?.calls?.remove(o.request, t)
      finish(o.request)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AiwbNet")

    Events("chunk", "end", "closed")

    AsyncFunction("openSession") { o: OpenSessionArgs, promise: Promise ->
      val st = Settle(promise)
      val dial = Dial()
      if (!begin(o.request) { dial.cancel(); st.reject(NetFailure.aborted()) }) {
        st.reject(NetFailure.aborted())
        return@AsyncFunction
      }
      pool.execute {
        try {
          // Nothing is dialed without a pin that can be compared.
          if (o.selfSigned && o.pin.isEmpty()) throw NetFailure.problem("fingerprint", "no fingerprint to accept")
          httpsURL(o.host, o.port, "/")
          val trust: AiwbTrust = if (o.selfSigned) PinTrust(o.pin) else PlatformTrust(o.host)
          // The handshake is made and judged here, before the session exists, so a refused certificate is an error of
          // `openSession` and no request was ever written. The protocol is read from the handshake (no probe request).
          // OkHttp has no "connect now", so the judged connection is handed to it as it is (NetSession.kt): the session is that
          // one connection, and its first call rides it.
          val protocol = dial.connect(o.host, o.port, trust, o.dialMs, o.handshakeMs, alpn = true)
          val fingerprint = trust.presented
          if (dial.cancelled) { dial.closeAll(); throw NetFailure.aborted() }
          if (protocol != "h2" && protocol != "unknown") { dial.closeAll(); throw NetFailure.problem("not_aiwb", "the server does not speak HTTP/2") }
          val prepared = dial.handOver()
          val session = NetSession(UUID.randomUUID().toString(), o.host, o.port, trust, o.dialMs, prepared, ::sessionEnded)
          sessions[session.id] = session
          if (!st.resolve(OpenedSession(session.id, fingerprint))) {
            // `cancel` came while the session was made: nothing is left open.
            sessions.remove(session.id)
            session.discard()
          }
        } catch (e: Throwable) {
          st.reject(problemOf(e))
        } finally {
          dial.closeAll()
          finish(o.request)
        }
      }
    }

    AsyncFunction("readCertificate") { o: ReadCertificateArgs, promise: Promise ->
      val st = Settle(promise)
      val dial = Dial()
      if (!begin(o.request) { dial.cancel(); st.reject(NetFailure.aborted()) }) {
        st.reject(NetFailure.aborted())
        return@AsyncFunction
      }
      pool.execute {
        try {
          httpsURL(o.host, o.port, "/")
          val trust = AnyTrust() // takes anything: nothing is written on this connection
          dial.connect(o.host, o.port, trust, o.dialMs, o.handshakeMs, alpn = false)
          dial.closeAll()
          if (trust.presented.isEmpty()) throw NetFailure.problem("tls_error", "the server presented no certificate")
          st.resolve(CertificateResult(trust.presented))
        } catch (e: Throwable) {
          st.reject(problemOf(e))
        } finally {
          dial.closeAll()
          finish(o.request)
        }
      }
    }

    // The body is an argument of its own: Expo's bridge cannot carry a Uint8Array inside an options object (it arrives as a
    // map), only as an argument. AiwbNetModule.ts splits it off on Android.
    AsyncFunction("fetch") { o: FetchArgs, body: ByteArray?, promise: Promise ->
      val st = Settle(promise)
      val t = Tracked(o.request)
      if (!begin(o.request, t)) {
        st.reject(NetFailure.aborted())
        return@AsyncFunction
      }
      pool.execute { runFetch(o, body, st, t) }
    }

    AsyncFunction("stream") { o: StreamArgs, promise: Promise ->
      val st = Settle(promise)
      val t = Tracked(o.request)
      if (!begin(o.request, t)) {
        st.reject(NetFailure.aborted())
        return@AsyncFunction
      }
      pool.execute { runStream(o, st, t) }
    }

    // Android has no permission for the local network.
    AsyncFunction("localNetwork") { -> "granted" }

    Function("cancel") { request: String -> cancelRequest(request) }

    Function("closeSession") { session: String -> sessions.remove(session)?.end() }

    // Not part of the contract: the UTF-8 decoder of streams fed the UTF-8 of `text` cut at every one and every two byte
    // offsets: "ok <cases> cases over <bytes> bytes", or a description of the first case that failed (the device test calls it).
    Function("selfTestUtf8") { text: String -> Utf8Chunks.selfTest(text) }

    OnDestroy {
      for (s in sessions.values.toList()) s.discard()
      sessions.clear()
      pool.shutdownNow()
      timers.shutdownNow()
    }
  }

  companion object {
    private const val REMEMBERED = 256
  }
}
