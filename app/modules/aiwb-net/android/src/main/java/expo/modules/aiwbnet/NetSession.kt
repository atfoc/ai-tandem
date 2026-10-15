package expo.modules.aiwbnet

import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink
import java.net.InetAddress
import java.net.Proxy
import java.net.Socket
import java.net.SocketAddress
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.SocketFactory
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/** What `cancel(request)` ends: a dial (`openSession`, `readCertificate`) or a call on a session. */
fun interface Cancellable {
  fun cancel()
}

/**
 * A call on a session: [reason] says why the module cancelled it (`aborted` by `cancel`, `timeout` by `headersMs`, `too_long`
 * by `maxBytes`, `reset` by the end of its session). The first reason stays.
 */
class Tracked(val id: String) : Cancellable {
  @Volatile var call: Call? = null
  @Volatile var pump: StreamPump? = null
  @Volatile var reason: String? = null

  fun stop(why: String) {
    synchronized(this) { if (reason == null) reason = why }
    if (why == "aborted") pump?.silence()
    call?.cancel()
  }

  override fun cancel() = stop("aborted")
}

/** A request body of bytes, sent as they are: it names no content type of its own (the caller's header is the one sent). */
private class BytesBody(private val bytes: ByteArray) : RequestBody() {
  override fun contentType(): MediaType? = null
  override fun contentLength(): Long = bytes.size.toLong()
  override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
}

/**
 * The socket of a session's connection: it says when a connection is up and when it is gone, which is the only way to learn
 * the session's end (OkHttp has no event for it, README.md, "closeSession" and the Android spike).
 */
class WatchedSocket : Socket() {
  interface Listener {
    fun up()
    fun down(s: Socket)
  }

  @Volatile private var listener: Listener? = null
  private val live = AtomicBoolean(false)
  private val announced = AtomicBoolean(false)

  /** [l] is told of this connection: now when it is up already (a socket `openSession` connected), else when it connects. */
  fun listen(l: Listener) {
    listener = l
    if (isClosed) { l.down(this); return }
    if (live.get() && announced.compareAndSet(false, true)) l.up()
  }

  override fun connect(endpoint: SocketAddress?, timeout: Int) {
    // A socket that `openSession` connected and judged is handed to OkHttp as it is: there is nothing to connect.
    if (isConnected) return
    super.connect(endpoint, timeout)
    live.set(true)
    listener?.let { if (announced.compareAndSet(false, true)) it.up() }
  }

  /** Marks a socket that was connected by hand (before the session existed). */
  fun connectedByHand(endpoint: SocketAddress, timeout: Int) {
    super.connect(endpoint, timeout)
    live.set(true)
  }

  override fun close() {
    super.close()
    if (live.compareAndSet(true, false) && announced.get()) listener?.down(this)
  }
}

/** The connection `openSession` made and judged: the socket under the TLS socket, and the TLS socket. The session's first call
 *  rides it, so a session is one connection and the certificate that was accepted is the one that is used. */
class Prepared(val raw: WatchedSocket, val ssl: SSLSocket)

/**
 * One session: one OkHttp client (its own connection pool, so one HTTP/2 connection for every call and the event stream)
 * under one trust. The session ends, and `onEnded` says so once, when its last connection is gone (a GOAWAY, the network, a
 * reset of the whole connection, a certificate refused on a reconnect) or `end` is called (`closeSession`).
 */
class NetSession(
  val id: String,
  val host: String,
  val port: Int,
  val trust: AiwbTrust,
  dialMs: Int,
  prepared: Prepared?,
  private val onEnded: (NetSession) -> Unit,
) {
  val calls = ConcurrentHashMap<String, Tracked>()
  private val sockets: MutableSet<Socket> = Collections.newSetFromMap(ConcurrentHashMap())
  private val connections = AtomicInteger()
  private val over = AtomicBoolean(false)

  val ended: Boolean get() = over.get()

  private val listener = object : WatchedSocket.Listener {
    override fun up() { connections.incrementAndGet() }
    override fun down(s: Socket) { sockets.remove(s); if (connections.decrementAndGet() <= 0) end() }
  }

  /** The connection that was made and judged by `openSession`, until OkHttp takes it. */
  private val spare = AtomicReference(prepared)

  private fun watched(): WatchedSocket = WatchedSocket().also { sockets.add(it); it.listen(listener) }

  init {
    prepared?.let { sockets.add(it.raw); it.raw.listen(listener) }
  }

  /** TLS over a socket OkHttp asks for: the prepared one is already TLS (judged), any other (a connection made later) is made
   *  under the same trust. */
  private val layered = object : SSLSocketFactory() {
    private val base = trust.socketFactory()
    override fun getDefaultCipherSuites(): Array<String> = base.defaultCipherSuites
    override fun getSupportedCipherSuites(): Array<String> = base.supportedCipherSuites
    override fun createSocket(s: Socket, host: String?, port: Int, autoClose: Boolean): Socket =
      prepared?.takeIf { s === it.raw }?.ssl ?: base.createSocket(s, host, port, autoClose)
    override fun createSocket(host: String?, port: Int): Socket = throw UnsupportedOperationException()
    override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = throw UnsupportedOperationException()
    override fun createSocket(host: InetAddress?, port: Int): Socket = throw UnsupportedOperationException()
    override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = throw UnsupportedOperationException()
  }

  val client: OkHttpClient = OkHttpClient.Builder()
    .socketFactory(object : SocketFactory() {
      override fun createSocket(): Socket = spare.getAndSet(null)?.raw ?: watched()

      override fun createSocket(host: String?, port: Int): Socket = throw UnsupportedOperationException()
      override fun createSocket(host: String?, port: Int, localHost: InetAddress?, localPort: Int): Socket = throw UnsupportedOperationException()
      override fun createSocket(host: InetAddress?, port: Int): Socket = throw UnsupportedOperationException()
      override fun createSocket(address: InetAddress?, port: Int, localAddress: InetAddress?, localPort: Int): Socket = throw UnsupportedOperationException()
    })
    .sslSocketFactory(layered, trust)
    .hostnameVerifier { _, _ -> true }
    .dns(object : Dns { override fun lookup(hostname: String): List<InetAddress> = ipv4(hostname) })
    .protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))
    // The session is its connection: an idle one is kept, not evicted (that would end the session).
    .connectionPool(ConnectionPool(1, 1, TimeUnit.DAYS))
    .proxy(Proxy.NO_PROXY)
    .followRedirects(false)
    .followSslRedirects(false)
    .retryOnConnectionFailure(false)
    .connectTimeout(maxOf(dialMs, 0).toLong(), TimeUnit.MILLISECONDS)
    // No time limit but the module's own: every other wait is the shared code's (README.md, "fetch").
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .writeTimeout(0, TimeUnit.MILLISECONDS)
    .callTimeout(0, TimeUnit.MILLISECONDS)
    .build()

  /** The request as the caller gave it: its headers as they are (the module adds none but `Accept-Encoding: identity`). */
  fun request(method: String, path: String, headers: Map<String, String>, body: ByteArray?): Request {
    val b = Request.Builder().url(httpsURL(host, port, path))
    var encoding = false
    for ((k, v) in headers) {
      b.addHeader(k, v)
      if (k.equals("accept-encoding", ignoreCase = true)) encoding = true
    }
    if (!encoding) b.header("Accept-Encoding", "identity")
    val m = method.uppercase()
    val needsBody = m == "POST" || m == "PUT" || m == "PATCH"
    return b.method(m, if (body != null) BytesBody(body) else if (needsBody) BytesBody(ByteArray(0)) else null).build()
  }

  /** The session ends: its calls are reset, its connection is closed, `onEnded` says so (once). */
  fun end() {
    if (!over.compareAndSet(false, true)) return
    onEnded(this)
    for (t in calls.values) t.stop("reset")
    // Nothing waits for the calls to finish: the connection is closed under them.
    for (s in sockets.toList()) closeQuietly(s)
    client.connectionPool.evictAll()
  }

  /** A session nobody was told of (a `cancel` came while `openSession` made it): gone, with no event. */
  fun discard() {
    over.set(true)
    for (s in sockets.toList()) closeQuietly(s)
    client.connectionPool.evictAll()
  }

  /** After a call failed on the transport: when no connection is left, the session is over. */
  fun checkAlive() {
    if (connections.get() <= 0) end()
  }
}

/** The headers of a response: names in lower case, repeated headers joined with ", ". */
fun headersOf(r: Response): Map<String, String> {
  val m = LinkedHashMap<String, String>()
  for (name in r.headers.names()) m[name.lowercase()] = r.headers.values(name).joinToString(", ")
  return m
}
