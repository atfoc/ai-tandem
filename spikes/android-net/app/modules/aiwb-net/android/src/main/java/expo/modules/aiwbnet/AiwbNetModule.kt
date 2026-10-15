package expo.modules.aiwbnet

import android.os.Debug
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

/**
 * The native side of the Connector and the Session of 4.6 of the goal.
 *
 *  readCertificate(host, port, dialMs, handshakeMs) -> fingerprint        (trusts nothing, sends nothing)
 *  openSession(host, port, pin, dialMs, handshakeMs, preflight) -> {id, fingerprint, alpn}
 *  request(opts) -> {status, headers, protocol, body, bytes}              (fetch with limits)
 *  startStream(opts) -> {status, headers, protocol}; then events "onStream" {id, kind: chunk|end, text|error}
 *  cancel(id), closeSession(sessionId), sessionStats(id), echoBytes(bytes), memory(), log(line)
 *
 * Every rejection has code = an outcome of desktop/conn/outcomes.js (refused, name_not_found, no_route, tls_timeout,
 * not_https, fingerprint, cert_changed, tls_error, not_aiwb) or a NetError code of session.js (timeout, reset,
 * too_long, closed) or aborted; its message is JSON {detail, fingerprint, pinned}.
 */
class AiwbNetModule : Module() {
  private val sessions = ConcurrentHashMap<String, Session>()
  private val pool = Executors.newCachedThreadPool()
  private val timers = ScheduledThreadPoolExecutor(1).apply { removeOnCancelPolicy = true }

  private fun reject(promise: Promise, e: Throwable) {
    val f = classify(e)
    val msg = JSONObject().put("detail", f.detail).put("fingerprint", f.fingerprint).put("pinned", f.pinned).toString()
    promise.reject(CodedException(f.outcome, msg, null))
  }

  private fun num(m: Map<String, Any?>, k: String): Long = (m[k] as? Number)?.toLong() ?: 0L

  /** Runs f on the pool; whatever it throws rejects the promise. */
  private fun async(promise: Promise, f: () -> Any?) {
    pool.execute {
      try { promise.resolve(f()) } catch (e: Throwable) { reject(promise, e) }
    }
  }

  /** Executes the call and arms the time limit of the headers; the call is tracked under id while it runs. */
  private fun execute(s: Session, id: String, t: Tracked, headersMs: Long): Response {
    if (s.closed) throw Failure("closed")
    s.calls[id] = t
    val timer = if (headersMs > 0) timers.schedule({ t.stop("timeout") }, headersMs, TimeUnit.MILLISECONDS) else null
    try {
      return t.call.execute()
    } catch (e: Throwable) {
      throw t.reason?.let { Failure(it) } ?: classify(e)
    } finally {
      timer?.cancel(false)
    }
  }

  private fun session(id: String): Session = sessions[id] ?: throw Failure("closed")

  override fun definition() = ModuleDefinition {
    Name("AiwbNet")

    Events("onStream")

    AsyncFunction("readCertificate") { host: String, port: Int, dialMs: Int, handshakeMs: Int, promise: Promise ->
      async(promise) {
        val trust = PinTrust(null) // accepts anything: nothing is written on this connection
        val (ssl, _) = connectTls(host, port, trust, dialMs, handshakeMs, alpn = false)
        try { trust.presented.ifEmpty { throw Failure("tls_error", "the server presented no certificate") } } finally { ssl.close() }
      }
    }

    AsyncFunction("openSession") { host: String, port: Int, pin: String, dialMs: Int, handshakeMs: Int, preflight: Boolean, promise: Promise ->
      async(promise) {
        if (pin.isBlank()) throw Failure("fingerprint")
        val trust = PinTrust(pin)
        // The handshake is made and judged here, before the session exists, so a refused certificate is
        // an error of openSession and no request was ever built. The requests then connect themselves
        // with the same trust object, which judges again.
        // (preflight = false is for the test that shows the requests' own connection judges too.)
        var alpn = "unknown"
        if (preflight) {
          val (ssl, a) = connectTls(host, port, trust, dialMs, handshakeMs, alpn = true)
          ssl.close()
          alpn = a
        }
        if (alpn != "h2" && alpn != "unknown") throw Failure("not_aiwb", "the server does not speak HTTP/2")
        val id = UUID.randomUUID().toString()
        sessions[id] = Session(id, host, port, trust, dialMs)
        mapOf("id" to id, "fingerprint" to trust.presented, "alpn" to alpn)
      }
    }

    // opts: session, id, method, path, headers, body | bodyBase64, limitMs, headersMs, maxBytes, responseEncoding (utf8|base64)
    AsyncFunction("request") { opts: Map<String, Any?>, promise: Promise ->
      async(promise) {
        val s = session(opts["session"] as String)
        val id = opts["id"] as String
        val maxBytes = num(opts, "maxBytes").let { if (it <= 0) Long.MAX_VALUE else it }
        val (t, _) = s.newCall(opts, num(opts, "limitMs"))
        try {
          execute(s, id, t, num(opts, "headersMs")).use { r ->
            val declared = r.body?.contentLength() ?: -1
            if (declared > maxBytes) { t.stop("too_long"); throw Failure("too_long") }
            val src = r.body!!.source()
            val buf = okio.Buffer()
            try {
              while (true) {
                val n = src.read(buf, 8192)
                if (n < 0) break
                if (buf.size > maxBytes) { t.stop("too_long"); throw Failure("too_long") }
              }
            } catch (e: Throwable) {
              throw if (e is Failure) e else (t.reason?.let { Failure(it) } ?: classify(e))
            }
            val bytes = buf.readByteArray()
            val body = if (opts["responseEncoding"] == "base64") android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP) else String(bytes, Charsets.UTF_8)
            mapOf("status" to r.code, "headers" to headerMap(r), "protocol" to r.protocol.toString(), "body" to body, "bytes" to bytes.size)
          }
        } finally {
          s.calls.remove(id)
        }
      }
    }

    // opts: session, id, path, headers, headersMs. Resolves with the response's head; then the body arrives as
    // "onStream" events until a kind "end", whose error is "" when the server ended the stream.
    AsyncFunction("startStream") { opts: Map<String, Any?>, promise: Promise ->
      pool.execute {
        val id = opts["id"] as String
        var s: Session? = null
        try {
          s = session(opts["session"] as String)
          val (t, _) = s.newCall(opts + mapOf("method" to "GET"), 0)
          val r = execute(s, id, t, num(opts, "headersMs"))
          promise.resolve(mapOf("status" to r.code, "headers" to headerMap(r), "protocol" to r.protocol.toString()))
          var error = ""
          try {
            r.use {
              val src = r.body!!.source()
              val dec = Utf8Chunks()
              val buf = ByteArray(16 * 1024)
              val stream = src.inputStream()
              while (true) {
                val n = stream.read(buf)
                if (n < 0) break
                val text = dec.push(buf, n)
                if (text.isNotEmpty()) sendEvent("onStream", mapOf("id" to id, "kind" to "chunk", "text" to text))
              }
            }
          } catch (e: Throwable) {
            error = t.reason ?: (e as? IOException)?.let { classify(it).outcome } ?: "reset"
          }
          sendEvent("onStream", mapOf("id" to id, "kind" to "end", "error" to error))
        } catch (e: Throwable) {
          reject(promise, e)
        } finally {
          s?.calls?.remove(id)
        }
      }
    }

    // Ends the request or the stream with this id (a rejection "aborted", or an end event with error "aborted").
    Function("cancel") { id: String ->
      for (s in sessions.values) s.calls[id]?.stop("aborted")
      null
    }

    Function("closeSession") { id: String ->
      sessions.remove(id)?.close()
      null
    }

    Function("sessionStats") { id: String ->
      val s = session(id)
      mapOf("connects" to s.connects.get(), "open" to s.calls.size)
    }

    // Spike: does a Uint8Array survive the bridge both ways (SDK 57)? Returns the bytes reversed.
    Function("echoBytes") { data: ByteArray -> data.reversedArray() }

    Function("memory") {
      val mi = Debug.MemoryInfo()
      Debug.getMemoryInfo(mi)
      val rt = Runtime.getRuntime()
      mapOf(
        "totalPssKb" to mi.totalPss,
        "javaHeapKb" to (rt.totalMemory() - rt.freeMemory()) / 1024,
        "nativeHeapKb" to Debug.getNativeHeapAllocatedSize() / 1024,
      )
    }

    Function("log") { line: String ->
      Log.i("AIWBSPIKE", line)
      null
    }

    OnDestroy {
      for (s in sessions.values) s.close()
      sessions.clear()
      pool.shutdownNow()
      timers.shutdownNow()
    }
  }
}
