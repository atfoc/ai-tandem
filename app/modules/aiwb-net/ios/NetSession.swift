import Foundation
import Network
import Security

// One session of the contract (../README.md): one URLSession for one server, whose delegate judges the certificate.
// Everything that touches a session's tables runs on its serial queue `q`, which is also the delegate queue, so a
// delegate call and a timer never run at the same time. The module (AiwbNetModule.swift) only starts flights on it.

/// How a flight's certificate is judged.
enum Trust {
  /// Accept the leaf whose fingerprint is this text, and no other certificate.
  case pinned(String)
  /// The platform's own evaluation, a failure named in the Node connector's order.
  case system
  /// Take the leaf's fingerprint and cancel the challenge: nothing is written.
  case read
}

enum FlightKind { case fetch, stream, probe, read }

/// Why the flight's timer fired.
enum Timeout { case headers, dial }

/// One request of a session: a fetch, a stream, the probe that `openSession` makes, or the handshake of `readCertificate`.
final class Flight {
  let id: String
  let kind: FlightKind
  let url: URL
  let method: String
  let headers: [String: String]
  let body: Data?
  let maxBytes: Int
  /// Fetch and stream: the time the headers may take. Probe and read: the time to dial and to handshake.
  let timerMs: Int

  /// The one answer: the whole result of a fetch, a probe or a read, or the head of a stream.
  var reply: ((Result<[String: Any], NetFailure>) -> Void)?

  private let lock = NSLock()
  private var cancelled = false

  // Only on the session's queue.
  var task: URLSessionTask?
  var timer: DispatchSourceTimer?
  var timeout: Timeout?
  var tooLong = false
  var refused: NetFailure? // the certificate this task's challenge refused (per task, not per session)
  var accepted: String? // the fingerprint the trust accepted
  var presented: String? // `read`: the fingerprint it took
  var response: HTTPURLResponse?
  var received = Data()
  var protocolName = ""
  var handshakeBegan = false
  var tcpConnected = false // the verdict of the TcpProbe after a dial timed out
  var awaitingVerdict = false
  var held: (() -> Void)? // the completion that waits for the verdict
  var tcpProbe: TcpProbe? // kept alive until it answers
  var chunker = Utf8Chunker()
  var pendingText = ""
  var flush: DispatchSourceTimer?

  init(id: String, kind: FlightKind, url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil,
       maxBytes: Int = 0, timerMs: Int = 0) {
    self.id = id
    self.kind = kind
    self.url = url
    self.method = method
    self.headers = headers
    self.body = body
    self.maxBytes = maxBytes
    self.timerMs = timerMs
  }

  var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

  func markCancelled() { lock.lock(); cancelled = true; lock.unlock() }

  /// Runs `body` unless `cancel` was called: an event is sent only while this holds, so none comes after `cancel` returned.
  func ifLive(_ body: () -> Void) {
    lock.lock(); defer { lock.unlock() }
    if !cancelled { body() }
  }
}

final class NetSession: NSObject, URLSessionDataDelegate {
  let id = UUID().uuidString
  let host: String
  let port: Int
  let trust: Trust
  let q = DispatchQueue(label: "aiwb-net.session")
  private var urlSession: URLSession!
  private var flights: [Int: Flight] = [:] // by task identifier
  private var closing = false
  private var announced = false

  private let emit: (String, [String: Any]) -> Void
  private let ended: (String) -> Void // a request is over
  private let gone: (NetSession) -> Void // the session was invalidated

  init(host: String, port: Int, trust: Trust, emit: @escaping (String, [String: Any]) -> Void,
       ended: @escaping (String) -> Void, gone: @escaping (NetSession) -> Void) {
    self.host = host
    self.port = port
    self.trust = trust
    self.emit = emit
    self.ended = ended
    self.gone = gone
    super.init()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.underlyingQueue = q
    let cfg = URLSessionConfiguration.ephemeral
    cfg.urlCache = nil
    cfg.urlCredentialStorage = nil
    cfg.httpCookieStorage = nil
    cfg.httpShouldSetCookies = false
    cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    cfg.connectionProxyDictionary = [:] // direct, as Node's net.connect is: no system proxy
    cfg.waitsForConnectivity = false
    cfg.tlsMinimumSupportedProtocolVersion = .TLSv12
    cfg.httpMaximumConnectionsPerHost = 1 // every request of the session rides one HTTP/2 connection
    cfg.timeoutIntervalForRequest = 24 * 3600 // every wait is the shared code's (AD-14), not URLSession's
    cfg.timeoutIntervalForResource = 365 * 24 * 3600
    urlSession = URLSession(configuration: cfg, delegate: self, delegateQueue: queue)
  }

  // MARK: - Starting, cancelling, closing (any thread)

  func start(_ f: Flight) {
    q.async { [self] in
      if closing { return fail(f, .net("closed")) }
      if f.isCancelled { return fail(f, .aborted) }
      var req = URLRequest(url: f.url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 24 * 3600)
      req.httpMethod = f.method
      req.httpShouldHandleCookies = false
      req.assumesHTTP3Capable = false
      req.setValue("identity", forHTTPHeaderField: "Accept-Encoding") // nothing is compressed, nothing is decompressed
      for (k, v) in f.headers { req.setValue(v, forHTTPHeaderField: k) }
      req.httpBody = f.body
      let task = urlSession.dataTask(with: req)
      f.task = task
      flights[task.taskIdentifier] = f
      arm(f)
      task.resume()
    }
  }

  /// `cancel(request)`: the flight ends as `aborted`; a stream after its headers ends with no event.
  func cancel(_ f: Flight) {
    f.markCancelled()
    q.async { f.task?.cancel() }
  }

  /// `closeSession` and a connection that broke: every request ends (a fetch rejects `reset`, a stream gets `end`
  /// with `reset`), then `closed` is emitted once the URLSession is invalidated.
  func close() {
    q.async { [self] in shutdown() }
  }

  private func shutdown() {
    if closing { return }
    closing = true
    urlSession.invalidateAndCancel()
  }

  /// The session was announced to JS (`openSession` resolved): from now on its end is reported by `closed`.
  func announce() { q.async { [self] in announced = true } }

  // MARK: - Timers (on q)

  private func arm(_ f: Flight) {
    guard f.timerMs > 0 else { return }
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(f.timerMs))
    t.setEventHandler { [weak f] in
      guard let f = f else { return }
      f.timeout = (f.kind == .fetch || f.kind == .stream) ? .headers : .dial
      f.timer?.cancel(); f.timer = nil
      f.task?.cancel()
      if f.timeout == .dial, let host = f.url.host, let probe = TcpProbe(host: host, port: f.url.port ?? 443) {
        // How far did the dial come? A task cancelled while it dials has no dates, so ask the network once more.
        f.awaitingVerdict = true
        f.tcpProbe = probe
        probe.run(within: 1000, on: self.q) { [weak f] connected in
          guard let f = f else { return }
          f.tcpConnected = connected
          f.awaitingVerdict = false
          f.tcpProbe = nil
          if let held = f.held { f.held = nil; held() }
        }
      }
    }
    t.resume()
    f.timer = t
  }

  private func disarm(_ f: Flight) {
    f.timer?.cancel(); f.timer = nil
  }

  // MARK: - The trust (the only place a certificate is judged)

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let serverTrust = challenge.protectionSpace.serverTrust else {
      completionHandler(.cancelAuthenticationChallenge, nil) // no client certificate, no password
      return
    }
    let f = flights[task.taskIdentifier]
    guard let presented = leafFingerprint(serverTrust) else {
      f?.refused = .problem("tls_error", "the server presented no certificate")
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    switch trust {
    case .read:
      f?.presented = presented
      completionHandler(.cancelAuthenticationChallenge, nil) // not trusted: the handshake ends here, nothing is written
    case let .pinned(pin):
      if presented == pin {
        f?.accepted = presented
        // The pin is the rule: the system's verdict on the certificate (no root, ten years of validity, a name that does
        // not match) is not asked.
        completionHandler(.useCredential, URLCredential(trust: serverTrust))
      } else {
        f?.refused = .problem("cert_changed", "the server's certificate is not the pinned one", fingerprint: presented, pinned: pin)
        completionHandler(.cancelAuthenticationChallenge, nil)
      }
    case .system:
      if let failure = NetSession.classify(serverTrust, host: challenge.protectionSpace.host) {
        f?.refused = failure
        completionHandler(.cancelAuthenticationChallenge, nil)
      } else {
        f?.accepted = presented
        completionHandler(.performDefaultHandling, nil)
      }
    }
  }

  /// The platform's evaluation of a trust and, when it fails, why, in the Node connector's order: the name, then the
  /// dates, then a certificate with no root that signed itself, then anything else.
  static func classify(_ serverTrust: SecTrust, host: String) -> NetFailure? {
    var error: CFError?
    if SecTrustEvaluateWithError(serverTrust, &error) { return nil }
    let detail = error.map { CFErrorCopyDescription($0) as String } ?? "the certificate is not trusted"
    if let named = namedBy(error, detail) { return named }
    guard let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate], let leaf = chain.first else {
      return .problem("cert_untrusted", detail)
    }
    // With the leaf as the only anchor, the root is out of the way and only the name and the dates are left to fail.
    SecTrustSetAnchorCertificates(serverTrust, [leaf] as CFArray)
    SecTrustSetAnchorCertificatesOnly(serverTrust, true)
    var inner: CFError?
    if !SecTrustEvaluateWithError(serverTrust, &inner), let named = namedBy(inner, detail) { return named }
    // A certificate the platform finds not compliant is not judged on its name: read the name from the certificate.
    if let names = CertificateNames(der: SecCertificateCopyData(leaf) as Data), !names.covers(host) {
      return .problem("cert_name", "the certificate is not for \(host)")
    }
    let subject = SecCertificateCopyNormalizedSubjectSequence(leaf) as Data?
    let issuer = SecCertificateCopyNormalizedIssuerSequence(leaf) as Data?
    if subject != nil && subject == issuer { return .problem("self_signed", detail) }
    return .problem("cert_untrusted", detail)
  }

  /// `cert_name` or `cert_expired` when the error of an evaluation says so.
  private static func namedBy(_ error: CFError?, _ detail: String) -> NetFailure? {
    guard let error = error else { return nil }
    let code = CFErrorGetCode(error)
    let text = (CFErrorCopyDescription(error) as String).lowercased()
    if code == Int(errSecHostNameMismatch) || text.contains("host name") || text.contains("hostname") { return .problem("cert_name", detail) }
    if code == Int(errSecCertificateExpired) || code == Int(errSecCertificateNotValidYet) || text.contains("expired") || text.contains("not yet valid") {
      return .problem("cert_expired", detail)
    }
    return nil
  }

  // MARK: - The delegate

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let f = flights[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    f.response = http
    disarm(f)
    switch f.kind {
    case .probe:
      completionHandler(.cancel) // the answer is discarded: the protocol is read from the metrics
    case .read:
      completionHandler(.cancel)
    case .stream:
      if let reply = f.reply {
        f.reply = nil
        reply(.success(NetSession.head(http)))
      }
      completionHandler(.allow)
    case .fetch:
      if f.maxBytes > 0 && http.expectedContentLength > Int64(f.maxBytes) {
        f.tooLong = true
        completionHandler(.cancel)
      } else {
        completionHandler(.allow)
      }
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let f = flights[dataTask.taskIdentifier] else { return }
    switch f.kind {
    case .stream:
      let text = f.chunker.text(data)
      if text.isEmpty { return }
      f.pendingText += text
      if f.pendingText.utf8.count >= 64 * 1024 { flushText(f) } else { scheduleFlush(f) }
    case .fetch:
      if f.maxBytes > 0 && f.received.count + data.count > f.maxBytes {
        f.tooLong = true
        dataTask.cancel() // the stream only: the connection stays usable
        return
      }
      f.received.append(data)
    case .probe, .read:
      break
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard let f = flights[task.taskIdentifier], let last = metrics.transactionMetrics.last else { return }
    f.protocolName = last.networkProtocolName ?? ""
    f.handshakeBegan = last.secureConnectionStartDate != nil
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let f = flights.removeValue(forKey: task.taskIdentifier) else { return }
    disarm(f)
    ended(f.id)
    if f.awaitingVerdict { f.held = { [self] in finish(f, error) }; return }
    finish(f, error)
  }

  private func finish(_ f: Flight, _ error: Error?) {
    let failure = NetSession.failure(of: f, error: error, closing: closing)
    switch f.kind {
    case .fetch:
      if let failure = failure { complete(f, failure) } else if let http = f.response {
        var out = NetSession.head(http)
        out["body"] = f.received
        complete(f, nil, out)
      } else {
        complete(f, .net("reset", "no answer"))
      }
    case .stream:
      if let reply = f.reply { // no headers came
        f.reply = nil
        reply(.failure(failure ?? .net("reset", "the stream ended before its headers")))
      } else {
        finishStream(f, failure)
      }
    case .probe, .read:
      completeDial(f, failure)
    }
    // A connection that broke ends the session: the next request would only find it broken again.
    if let failure = failure, failure.isReset, f.kind != .read { shutdown() }
  }

  func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
    if announced { emit("closed", ["session": id]) }
    gone(self)
  }

  // MARK: - Ends

  private func complete(_ f: Flight, _ failure: NetFailure?, _ out: [String: Any] = [:]) {
    guard let reply = f.reply else { return }
    f.reply = nil
    reply(failure.map { .failure($0) } ?? .success(out))
  }

  /// A flight that never started.
  private func fail(_ f: Flight, _ failure: NetFailure) {
    ended(f.id)
    if let reply = f.reply {
      f.reply = nil
      reply(.failure(failure))
    }
  }

  /// The probe and the read: what the dial came to.
  private func completeDial(_ f: Flight, _ failure: NetFailure?) {
    if f.kind == .read {
      if let fp = f.presented { return complete(f, nil, ["fingerprint": fp]) }
      return complete(f, failure.map { NetSession.asProblem($0) } ?? .problem("tls_error", "no certificate was read"))
    }
    // The trust accepted the certificate and the connection speaks something else than h2 (even if the exchange then failed,
    // as it does with a server that answers before it is asked): not ours.
    if f.accepted != nil, !f.protocolName.isEmpty, f.protocolName != "h2" {
      return complete(f, .problem("not_aiwb", "the server does not speak HTTP/2 (\(f.protocolName))"))
    }
    // The probe: the answer's headers came on a connection whose certificate the trust accepted.
    if f.response != nil, let accepted = f.accepted {
      if f.protocolName == "h2" { return complete(f, nil, ["fingerprint": accepted]) }
      return complete(f, .problem("not_aiwb", "the server does not speak HTTP/2 (\(f.protocolName.isEmpty ? "no protocol" : f.protocolName))"))
    }
    complete(f, NetSession.asProblem(failure ?? .net("reset", "no answer")))
  }

  /// A failure of a dial is a problem; a `net` failure (a platform failure the table does not know) is `tls_error`.
  static func asProblem(_ failure: NetFailure) -> NetFailure {
    switch failure {
    case .problem, .aborted: return failure
    case let .net(code, detail): return .problem("tls_error", (detail ?? code))
    }
  }

  private func finishStream(_ f: Flight, _ failure: NetFailure?) {
    f.flush?.cancel(); f.flush = nil
    if f.isCancelled { return } // no chunk and no end after cancel
    let rest = f.chunker.finish()
    if !rest.isEmpty { f.pendingText += rest }
    flushText(f)
    let id = f.id
    f.ifLive {
      var e: [String: Any] = ["request": id]
      if failure != nil { e["error"] = "reset" }
      emit("end", e)
    }
  }

  private func scheduleFlush(_ f: Flight) {
    if f.flush != nil { return }
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + .milliseconds(16)) // bytes that arrive within 16 ms are one event
    t.setEventHandler { [weak self, weak f] in
      guard let self = self, let f = f else { return }
      self.flushText(f)
    }
    t.resume()
    f.flush = t
  }

  private func flushText(_ f: Flight) {
    f.flush?.cancel(); f.flush = nil
    if f.pendingText.isEmpty { return }
    let text = f.pendingText
    f.pendingText = ""
    let id = f.id
    f.ifLive { emit("chunk", ["request": id, "text": text]) }
  }

  // MARK: - Mapping

  static func head(_ r: HTTPURLResponse) -> [String: Any] {
    var headers: [String: String] = [:]
    for (k, v) in r.allHeaderFields { headers[String(describing: k).lowercased()] = String(describing: v) }
    return ["status": r.statusCode, "headers": headers]
  }

  /// What a flight's failure is, by the table of the README. Order: the certificate the trust refused, the limits the
  /// module set, the caller's cancel, the session's end, then the platform's error.
  static func failure(of f: Flight, error: Error?, closing: Bool) -> NetFailure? {
    if let refused = f.refused { return refused }
    if f.tooLong { return .net("too_long", "the body is larger than \(f.maxBytes) bytes") }
    if f.isCancelled { return .aborted }
    if f.kind == .probe && f.response != nil { return nil }
    if f.kind == .read && f.presented != nil { return nil }
    if f.timeout == .headers { return .net("timeout", "no headers within \(f.timerMs) ms") }
    if f.timeout == .dial {
      if LocalNetwork.shared.isDenied(nil) && !(f.handshakeBegan || f.tcpConnected) { return localNetworkDenied() }
      return (f.handshakeBegan || f.tcpConnected)
        ? .problem("tls_timeout", "the TLS handshake did not end in time")
        : .problem("no_route", "no answer to the connect in time")
    }
    guard let error = error else { return nil }
    if closing { return .net("reset", "the session ended") }
    return failure(of: error, kind: f.kind, handshakeBegan: f.handshakeBegan)
  }

  private static func localNetworkDenied() -> NetFailure {
    LocalNetwork.shared.setDenied()
    return .problem("local_network_denied", "the app may not use the local network")
  }

  /// The platform's error as the table says it. The connection-level errors of a dial are problems, those of a
  /// request on a session are `net reset`; the caller turns the rest of the problems of a request into a reset.
  static func failure(of error: Error, kind: FlightKind, handshakeBegan: Bool) -> NetFailure {
    let ns = error as NSError
    let detail = ns.localizedDescription
    let dialing = kind == .probe || kind == .read
    guard ns.domain == NSURLErrorDomain else { return dialing ? .problem("tls_error", detail) : .net("reset", detail) }
    // The POSIX error under a failed connect (Network.framework puts it in _kCFStreamErrorCodeKey).
    let posix = (ns.userInfo["_kCFStreamErrorCodeKey"] as? Int) ?? ((ns.userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0)
    let path = ns.userInfo["_NSURLErrorNWPathKey"] as? NWPath
    switch ns.code {
    case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
      return .problem("name_not_found", detail)
    case NSURLErrorCannotConnectToHost, NSURLErrorNotConnectedToInternet, NSURLErrorTimedOut, NSURLErrorDataNotAllowed:
      if dialing && LocalNetwork.shared.isDenied(path) { return localNetworkDenied() }
      if ns.code == NSURLErrorCannotConnectToHost && posix == Int(ECONNREFUSED) { return .problem("refused", detail) }
      if ns.code == NSURLErrorTimedOut && handshakeBegan { return .problem("tls_timeout", detail) }
      return dialing ? .problem("no_route", detail) : .net("reset", detail)
    case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate,
         NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected,
         NSURLErrorClientCertificateRequired:
      // A listener that answers plain HTTP (or anything but TLS) is "not_https".
      let ssl = posix
      if ssl == Int(errSSLProtocol) || ssl == Int(errSSLPeerProtocolVersion) || ssl == Int(errSSLRecordOverflow)
        || ssl == Int(errSSLUnexpectedRecord) {
        return dialing ? .problem("not_https", detail) : .net("reset", detail)
      }
      return dialing ? .problem("tls_error", "\(detail) [\(ns.code)/\(ssl)]") : .net("reset", detail)
    default:
      return dialing ? .problem("tls_error", "\(detail) [\(ns.domain) \(ns.code)]") : .net("reset", "\(detail) [\(ns.domain) \(ns.code)]")
    }
  }
}
