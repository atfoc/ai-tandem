package expo.modules.aiwbnet

import okhttp3.Call
import okhttp3.Dns
import okhttp3.Headers.Companion.toHeaders
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.ConnectException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLSocket

/** Port of tls.js dialProblem / tlsProblem: what a failed dial or handshake is called. */
fun classify(e: Throwable): Failure {
  var t: Throwable? = e
  while (t != null) {
    if (t is Failure) return t
    if (t is PinMismatch) return Failure("cert_changed", "", t.presented, t.pinned)
    t = t.cause
  }
  val detail = (e.message ?: e.toString()).replace(Regex("\\s+"), " ").take(300)
  return when {
    e is java.io.InterruptedIOException && e.message == "timeout" -> Failure("timeout", detail)
    e is UnknownHostException -> Failure("name_not_found", detail)
    e is ConnectException && Regex("refused|ECONNREFUSED", RegexOption.IGNORE_CASE).containsMatchIn(detail) -> Failure("refused", detail)
    e is ConnectException || e is NoRouteToHostException -> Failure("no_route", detail)
    e is SocketTimeoutException && Regex("connect", RegexOption.IGNORE_CASE).containsMatchIn(detail) -> Failure("no_route", detail)
    e is SSLException && Regex("wrong version number|first record does not look like|http request|packet length too long|unable to parse tls packet header", RegexOption.IGNORE_CASE).containsMatchIn(detail) -> Failure("not_https", detail)
    e is SSLException -> Failure("tls_error", detail)
    else -> Failure("reset", detail)
  }
}

/** The IPv4 addresses of host (desktop dials with family: 4). */
private fun ipv4(host: String): List<InetAddress> {
  val all = InetAddress.getAllByName(host).filter { it is Inet4Address }
  if (all.isEmpty()) throw UnknownHostException(host)
  return all
}

/** The TCP connect, then TLS on it with [trust], within dialMs and handshakeMs; nothing is written. Same two steps as tls.js. */
fun connectTls(host: String, port: Int, trust: PinTrust, dialMs: Int, handshakeMs: Int, alpn: Boolean): Pair<SSLSocket, String> {
  val raw = Socket()
  try {
    try {
      raw.connect(InetSocketAddress(ipv4(host).first(), port), dialMs)
    } catch (e: SocketTimeoutException) {
      throw Failure("no_route", "the connection timed out")
    }
    raw.soTimeout = handshakeMs
    val ssl = trust.socketFactory().createSocket(raw, host, port, true) as SSLSocket
    try {
      ssl.enabledProtocols = ssl.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
      if (alpn && android.os.Build.VERSION.SDK_INT >= 29) {
        val p = ssl.sslParameters
        p.applicationProtocols = arrayOf("h2", "http/1.1")
        ssl.sslParameters = p
      }
      ssl.startHandshake()
      val negotiated = if (android.os.Build.VERSION.SDK_INT >= 29) (ssl.applicationProtocol ?: "") else "unknown"
      return Pair(ssl, negotiated)
    } catch (e: SocketTimeoutException) {
      ssl.close()
      throw Failure("tls_timeout", "")
    } catch (e: Throwable) {
      ssl.close()
      throw classify(e)
    }
  } catch (e: Throwable) {
    try { raw.close() } catch (_: IOException) {}
    throw if (e is Failure) e else classify(e)
  }
}

/** A call in flight: [reason] says why it was cancelled by us (aborted, timeout, too_long). */
class Tracked(val call: Call) {
  @Volatile var reason: String? = null
  fun stop(why: String) {
    if (reason == null) reason = why
    call.cancel()
  }
}

/** One session: one OkHttp client (one connection pool, so one HTTP/2 connection) under one pin. */
class Session(val id: String, val host: String, val port: Int, val trust: PinTrust, dialMs: Int) {
  /** How many TCP+TLS connections this session's client made (an HTTP/2 session should make one). */
  val connects = java.util.concurrent.atomic.AtomicInteger()
  val client: OkHttpClient = OkHttpClient.Builder()
    .eventListener(object : okhttp3.EventListener() {
      override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: java.net.Proxy, protocol: Protocol?) { connects.incrementAndGet() }
    })
    .sslSocketFactory(trust.socketFactory(), trust)
    // The pin is the rule: the name is no part of it (as in tls.js, where the box accepts any name).
    .hostnameVerifier { _, _ -> true }
    .dns(object : Dns { override fun lookup(hostname: String): List<InetAddress> = ipv4(hostname) })
    .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
    .connectTimeout(dialMs.toLong(), java.util.concurrent.TimeUnit.MILLISECONDS)
    .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
    .writeTimeout(30_000, java.util.concurrent.TimeUnit.MILLISECONDS)
    .callTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
    .retryOnConnectionFailure(false)
    .build()
  val calls = ConcurrentHashMap<String, Tracked>()
  @Volatile var closed = false

  fun newCall(opts: Map<String, Any?>, limitMs: Long): Pair<Tracked, Request> {
    val method = (opts["method"] as? String ?: "GET").uppercase()
    val path = opts["path"] as String
    val headers = ((opts["headers"] as? Map<*, *>) ?: emptyMap<String, String>())
      .entries.associate { it.key.toString() to it.value.toString() }.toMutableMap()
    val bodyText = opts["body"] as? String
    val bodyB64 = opts["bodyBase64"] as? String
    val contentType = headers.entries.firstOrNull { it.key.equals("content-type", true) }
    val bytes: ByteArray? = when {
      bodyB64 != null -> android.util.Base64.decode(bodyB64, android.util.Base64.DEFAULT)
      bodyText != null -> bodyText.toByteArray(Charsets.UTF_8)
      else -> null
    }
    if (bytes != null) headers.keys.removeAll { it.equals("content-type", true) }
    val body = bytes?.toRequestBody(contentType?.value?.toMediaTypeOrNull())
    val req = Request.Builder().url("https://$host:$port$path").headers(headers.toHeaders()).method(method, body ?: if (method == "GET" || method == "HEAD") null else ByteArray(0).toRequestBody(null)).build()
    val c = if (limitMs > 0) client.newBuilder().callTimeout(limitMs, java.util.concurrent.TimeUnit.MILLISECONDS).build() else client
    return Pair(Tracked(c.newCall(req)), req)
  }

  fun close() {
    closed = true
    for (t in calls.values) t.stop("aborted")
    client.dispatcher.executorService.shutdown()
    client.connectionPool.evictAll()
  }
}

fun headerMap(r: Response): Map<String, String> {
  val m = LinkedHashMap<String, String>()
  for (name in r.headers.names()) m[name.lowercase()] = r.headers.values(name).joinToString(", ")
  return m
}

/** UTF-8 to text, chunk by chunk: bytes of a character cut by a chunk wait for the next one. */
class Utf8Chunks {
  private val dec = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE)
  private val inBuf = ByteBuffer.allocate(64 * 1024 + 8)
  private val outBuf = CharBuffer.allocate(64 * 1024 + 8)

  fun push(b: ByteArray, n: Int): String {
    val sb = StringBuilder()
    var off = 0
    while (off < n) {
      val take = minOf(n - off, inBuf.remaining())
      inBuf.put(b, off, take)
      off += take
      inBuf.flip()
      outBuf.clear()
      dec.decode(inBuf, outBuf, false)
      outBuf.flip()
      sb.append(outBuf)
      inBuf.compact()
    }
    return sb.toString()
  }
}
