package expo.modules.aiwbnet

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.io.IOException
import java.net.ConnectException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocket

/**
 * The one function of the module that builds an address (architecture AD-36): the scheme is the literal `https`, and a host
 * that holds `/`, `@`, `?`, `#` or a space is no host name (it is refused as `name_not_found`, no address is built from it).
 */
fun httpsURL(host: String, port: Int, path: String): HttpUrl {
  if (host.isEmpty() || host.any { it == '/' || it == '@' || it == '?' || it == '#' || it.isWhitespace() }) {
    throw NetFailure.problem("name_not_found", "$host is not a host name")
  }
  if (!path.startsWith("/")) throw NetFailure.net("reset", "a path starts with /")
  val shown = if (host.contains(':')) "[$host]" else host
  return "https://$shown:$port$path".toHttpUrl()
}

/** The IPv4 addresses of [host] (the desktop dials with `family: 4` too); no IPv4 address is a name that does not resolve. */
fun ipv4(host: String): List<InetAddress> {
  val all = InetAddress.getAllByName(host).filter { it is Inet4Address }
  if (all.isEmpty()) throw UnknownHostException(host)
  return all
}

private val NOT_TLS = Regex(
  "wrong version number|first record does not look like|http request|packet length too long|unable to parse tls packet header|not an ssl|record overflow",
  RegexOption.IGNORE_CASE,
)
private val REFUSED = Regex("refused|ECONNREFUSED", RegexOption.IGNORE_CASE)

/** What a failed dial or handshake is called (README.md, the mapping table): the [Problem] of `openSession` and `readCertificate`. */
fun problemOf(e: Throwable): NetFailure {
  var t: Throwable? = e
  while (t != null) {
    if (t is NetFailure) return t
    if (t is TrustFailure) return t.failure
    t = t.cause
  }
  val detail = oneLine(e)
  return when {
    e is UnknownHostException -> NetFailure.problem("name_not_found", detail)
    e is NoRouteToHostException -> NetFailure.problem("no_route", detail)
    e is ConnectException && REFUSED.containsMatchIn(detail) -> NetFailure.problem("refused", detail)
    e is ConnectException -> NetFailure.problem("no_route", detail)
    e is SocketTimeoutException -> NetFailure.problem("tls_timeout", detail)
    e is SSLException && NOT_TLS.containsMatchIn(detail) -> NetFailure.problem("not_https", detail)
    else -> NetFailure.problem("tls_error", detail)
  }
}

/** The sockets of a call to `openSession` or `readCertificate`, so that `cancel` can close them whatever it is doing. */
class Dial {
  @Volatile var cancelled = false
  @Volatile private var raw: WatchedSocket? = null
  @Volatile private var ssl: SSLSocket? = null
  @Volatile private var handedOver = false

  fun cancel() {
    cancelled = true
    closeAll()
  }

  /** Closes the connection, unless it was handed over to a session. */
  fun closeAll() {
    if (handedOver) return
    closeQuietly(ssl)
    closeQuietly(raw)
  }

  /** The connection as it is, judged and idle, for a session to use; nobody closes it here after this. */
  fun handOver(): Prepared? {
    val r = raw
    val s = ssl
    if (r == null || s == null || cancelled || r.isClosed) return null
    r.soTimeout = 0 // the handshake's limit is over; the session's reads have none of their own
    handedOver = true
    return Prepared(r, s)
  }

  /**
   * The TCP connect (within [dialMs]), then the TLS handshake under [trust] (within [handshakeMs]). Nothing is written:
   * a certificate that [trust] refuses ends the handshake. The negotiated protocol (`h2`) is read when [alpn] is asked for;
   * below API 29 the platform cannot tell it and it is "unknown". The caller closes the socket with [closeAll].
   */
  fun connect(host: String, port: Int, trust: AiwbTrust, dialMs: Int, handshakeMs: Int, alpn: Boolean): String {
    val address = try {
      InetSocketAddress(ipv4(host).first(), port)
    } catch (e: Throwable) {
      throw if (cancelled) NetFailure.aborted() else problemOf(e)
    }
    val socket = WatchedSocket()
    raw = socket
    if (cancelled) { closeAll(); throw NetFailure.aborted() }
    try {
      try {
        socket.connectedByHand(address, if (dialMs > 0) dialMs else 0)
      } catch (e: SocketTimeoutException) {
        throw NetFailure.problem("no_route", "the connection did not complete in $dialMs ms")
      }
      socket.soTimeout = if (handshakeMs > 0) handshakeMs else 0
      val s = trust.socketFactory().createSocket(socket, host, port, true) as SSLSocket
      ssl = s
      if (cancelled) { closeAll(); throw NetFailure.aborted() }
      s.enabledProtocols = s.supportedProtocols.filter { it == "TLSv1.3" || it == "TLSv1.2" }.toTypedArray()
      if (alpn && android.os.Build.VERSION.SDK_INT >= 29) {
        val p = s.sslParameters
        p.applicationProtocols = arrayOf("h2", "http/1.1")
        s.sslParameters = p
      }
      try {
        s.startHandshake()
      } catch (e: SocketTimeoutException) {
        throw NetFailure.problem("tls_timeout", "the handshake did not complete in $handshakeMs ms")
      }
      return if (android.os.Build.VERSION.SDK_INT >= 29) (s.applicationProtocol ?: "") else "unknown"
    } catch (e: Throwable) {
      closeAll()
      throw if (cancelled) NetFailure.aborted() else if (e is NetFailure) e else problemOf(e)
    }
  }
}

fun closeQuietly(s: Socket?) {
  try { s?.close() } catch (_: IOException) {}
}
