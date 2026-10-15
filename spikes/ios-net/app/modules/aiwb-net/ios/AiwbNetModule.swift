import ExpoModulesCore
import Foundation
import CryptoKit
import Security

// The spike's native transport: the Connector (a session whose trust is a SHA-256 pin of the leaf certificate, and the
// reading of a certificate without trusting it) and the Session (a request with a response limit, a stream read as text
// chunks) over URLSession. The rules are those of desktop/conn: the certificate is judged before anything is written,
// it is accepted by its fingerprint and by nothing else, and every failure carries a code that is an outcome of
// desktop/conn/outcomes.js (cert_changed, fingerprint, refused, ...), or a NetError code (timeout, reset, too_long, closed).

// MARK: - Errors

/// A failure with the code JS maps to an outcome. `extra` carries the fingerprints of cert_changed.
struct NetFailure: Error {
  let code: String
  let detail: String
  var fingerprint: String = ""
  var pinned: String = ""

  var json: [String: Any] {
    ["code": code, "detail": detail, "fingerprint": fingerprint, "pinned": pinned]
  }
}

/// The message of a rejected promise is a JSON text so that JS gets the code and the fingerprints whole.
final class NetException: Exception {
  let failure: NetFailure
  init(_ failure: NetFailure) {
    self.failure = failure
    super.init(name: "AiwbNetError", description: NetException.encode(failure), code: failure.code)
  }
  static func encode(_ f: NetFailure) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: f.json), let s = String(data: data, encoding: .utf8) else {
      return "{\"code\":\"\(f.code)\"}"
    }
    return s
  }
}

// MARK: - Fingerprints

/// normalFingerprint is desktop/conn/list.js normalFingerprint: 64 hex digits, with or without ":", in uppercase pairs
/// joined by ":"; nil when the text is none.
func normalFingerprint(_ s: String) -> String? {
  let h = s.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ":", with: "")
  guard h.count == 64, h.allSatisfy({ $0.isHexDigit }) else { return nil }
  let up = Array(h.uppercased())
  return stride(from: 0, to: 64, by: 2).map { String(up[$0...$0 + 1]) }.joined(separator: ":")
}

/// fingerprintOf is desktop/conn/tls.js fingerprintOf: the SHA-256 of a DER certificate as uppercase hex pairs joined by ":".
func fingerprintOf(_ der: Data) -> String {
  SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
}

/// The leaf certificate's fingerprint of a trust, or nil when it presents none.
func leafFingerprint(_ trust: SecTrust) -> String? {
  guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
  return fingerprintOf(SecCertificateCopyData(leaf) as Data)
}

// MARK: - Error mapping

/// Maps the error of a URLSession task to the code of an outcome or of a NetError. `mismatch` is what the trust hook saw when it
/// refused a certificate: then the task's error is only the cancel, and the real reason is the pin.
func failure(of error: Error, mismatch: NetFailure?, cancelled: Bool, timedOutBy: String?) -> NetFailure {
  if let m = mismatch { return m }
  if let t = timedOutBy { return NetFailure(code: t, detail: "") }
  let ns = error as NSError
  let detail = ns.localizedDescription
  if ns.domain == NSURLErrorDomain {
    if ns.code == NSURLErrorCancelled { return NetFailure(code: cancelled ? "aborted" : "reset", detail: detail) }
    // The POSIX error under a failed connect (Network.framework puts it in _kCFStreamErrorCodeKey).
    let posix = (ns.userInfo["_kCFStreamErrorCodeKey"] as? Int) ?? ((ns.userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0)
    switch ns.code {
    case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return NetFailure(code: "name_not_found", detail: detail)
    case NSURLErrorCannotConnectToHost:
      return NetFailure(code: posix == Int(ECONNREFUSED) ? "refused" : "no_route", detail: detail)
    case NSURLErrorTimedOut: return NetFailure(code: "no_route", detail: "the connection timed out")
    case NSURLErrorNetworkConnectionLost: return NetFailure(code: "reset", detail: detail)
    case NSURLErrorNotConnectedToInternet: return NetFailure(code: "no_route", detail: detail)
    case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate,
      NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid, NSURLErrorClientCertificateRejected:
      // A server that answers plain HTTP (or something else than TLS) is "not_https".
      let sslCode = (ns.userInfo["_kCFStreamErrorCodeKey"] as? Int) ?? 0
      if sslCode == Int(errSSLProtocol) || sslCode == Int(errSSLPeerProtocolVersion) || sslCode == Int(errSSLRecordOverflow) ||
        sslCode == Int(errSSLUnexpectedRecord) || sslCode == Int(errSSLClosedAbort) && false {
        return NetFailure(code: "not_https", detail: detail)
      }
      return NetFailure(code: "tls_error", detail: "\(detail) [\(ns.code)/\(sslCode)]")
    default: break
    }
  }
  return NetFailure(code: "reset", detail: "\(detail) [\(ns.domain) \(ns.code)]")
}

// MARK: - The session

/// What is asked of one request or stream.
struct Call {
  var method: String
  var path: String
  var headers: [String: String]
  var body: Data?
  var maxBytes: Int
  var limitMs: Int
  var headersMs: Int
}

/// Decodes UTF-8 chunk by chunk: the end of a chunk may cut a character, whose bytes wait for the next one.
struct Utf8Chunker {
  private var pending = Data()
  mutating func text(_ chunk: Data) -> String {
    pending.append(chunk)
    // Back up over an incomplete sequence at the end: at most 3 bytes.
    var end = pending.count
    var back = 0
    while back < 4 && end - back > 0 {
      let b = pending[pending.startIndex + end - back - 1]
      if b & 0xC0 == 0x80 { back += 1; continue } // a continuation byte
      if b & 0x80 == 0 { break } // ASCII: complete
      let need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2
      if back + 1 < need { end = end - back - 1 } // the lead byte of an incomplete sequence: hold it back
      break
    }
    let head = pending.prefix(end)
    pending = Data(pending.suffix(from: pending.startIndex + end))
    return String(decoding: head, as: UTF8.self)
  }
}

/// One in-flight request: its result handlers and its state.
final class Flight {
  let id: String
  let call: Call
  let stream: Bool
  var task: URLSessionDataTask?
  var body = Data()
  var tooLong = false
  var aborted = false
  var timedOutBy: String?
  var timer: DispatchSourceTimer?
  var response: HTTPURLResponse?
  var protocolName = ""
  var reused = false
  var chunker = Utf8Chunker()
  var headReply: ((Result<[String: Any], NetFailure>) -> Void)?
  var doneReply: ((Result<[String: Any], NetFailure>) -> Void)?
  var onChunk: ((String) -> Void)?
  var onEnd: ((NetFailure?, [String: Any]) -> Void)?
  var bytes = 0

  init(id: String, call: Call, stream: Bool) { self.id = id; self.call = call; self.stream = stream }
}

/// One server: one URLSession whose delegate judges the certificate by the pin (and the session holds the HTTP/2
/// connection, so every request of the server goes over it).
final class NetSession: NSObject, URLSessionDataDelegate {
  let host: String
  let port: Int
  let pin: String
  var urlSession: URLSession!
  let queue = OperationQueue()
  var flights: [Int: Flight] = [:] // by task identifier
  var byId: [String: Flight] = [:]
  var mismatch: NetFailure? // the last certificate the pin refused
  var trusted: String = "" // the fingerprint of the accepted certificate
  var closed = false

  init(host: String, port: Int, pin: String) {
    self.host = host
    self.port = port
    self.pin = pin
    super.init()
    queue.maxConcurrentOperationCount = 1
    queue.name = "aiwb-net-\(host):\(port)"
    let cfg = URLSessionConfiguration.ephemeral
    cfg.urlCache = nil
    cfg.urlCredentialStorage = nil
    cfg.httpCookieStorage = nil
    cfg.httpShouldSetCookies = false
    cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    cfg.connectionProxyDictionary = [:] // direct, as Node's net.connect is: no system proxy
    cfg.waitsForConnectivity = false
    cfg.tlsMinimumSupportedProtocolVersion = .TLSv12
    cfg.timeoutIntervalForRequest = 24 * 3600 // the app's own watchdog decides when a stream is silent, not URLSession's 60 s
    cfg.timeoutIntervalForResource = 365 * 24 * 3600
    cfg.httpMaximumConnectionsPerHost = 4
    urlSession = URLSession(configuration: cfg, delegate: self, delegateQueue: queue)
  }

  // The trust hook. This is the only place a certificate is judged: the pin or nothing.
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust else {
      completionHandler(.cancelAuthenticationChallenge, nil) // no client certificates, no passwords
      return
    }
    guard let presented = leafFingerprint(trust) else {
      mismatch = NetFailure(code: "tls_error", detail: "the server presented no certificate")
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    if let pinned = normalFingerprint(pin), pinned == presented {
      trusted = presented
      mismatch = nil
      // The pin is the rule: the system's own verdict on the certificate (not issued by a root, valid for 10 years, a name that does not
      // match) is not asked. The spike tried anchoring the leaf and setting trust exceptions: neither changed any result.
      completionHandler(.useCredential, URLCredential(trust: trust))
    } else {
      mismatch = NetFailure(code: "cert_changed", detail: "", fingerprint: presented, pinned: normalFingerprint(pin) ?? pin)
      completionHandler(.cancelAuthenticationChallenge, nil)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let f = flights[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      return
    }
    f.response = http
    if f.stream, let reply = f.headReply {
      f.headReply = nil
      f.timer?.cancel(); f.timer = nil // the time for the headers is over
      reply(.success(Self.head(http)))
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let f = flights[dataTask.taskIdentifier] else { return }
    f.bytes += data.count
    if f.stream {
      let text = f.chunker.text(data)
      if !text.isEmpty { f.onChunk?(text) }
      return
    }
    if f.body.count + data.count > f.call.maxBytes {
      f.tooLong = true
      dataTask.cancel() // the body is not read further
      return
    }
    f.body.append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard let f = flights[task.taskIdentifier], let last = metrics.transactionMetrics.last else { return }
    f.protocolName = last.networkProtocolName ?? ""
    f.reused = last.isReusedConnection
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let f = flights.removeValue(forKey: task.taskIdentifier) else { return }
    byId.removeValue(forKey: f.id)
    f.timer?.cancel(); f.timer = nil
    var info: [String: Any] = ["protocol": f.protocolName, "reused": f.reused, "bytes": f.bytes]
    if let http = f.response { info["status"] = http.statusCode }
    let fail: NetFailure?
    if f.tooLong { fail = NetFailure(code: "too_long", detail: "") }
    else if let error = error { fail = failure(of: error, mismatch: mismatch, cancelled: f.aborted, timedOutBy: f.timedOutBy) }
    else { fail = nil }
    if f.stream {
      if let reply = f.headReply { // the stream never got its headers
        f.headReply = nil
        reply(.failure(fail ?? NetFailure(code: "reset", detail: "")))
      }
      f.onEnd?(fail, info)
      return
    }
    if let fail = fail { f.doneReply?(.failure(fail)); return }
    var out = Self.head(f.response!)
    out["body"] = f.body.base64EncodedString()
    out["protocol"] = f.protocolName
    out["reused"] = f.reused
    f.doneReply?(.success(out))
  }

  static func head(_ r: HTTPURLResponse) -> [String: Any] {
    var headers: [String: String] = [:]
    for (k, v) in r.allHeaderFields { headers[String(describing: k).lowercased()] = String(describing: v) }
    return ["status": r.statusCode, "headers": headers]
  }

  func urlRequest(_ c: Call) -> URLRequest {
    var req = URLRequest(url: URL(string: "https://\(host.contains(":") ? "[\(host)]" : host):\(port)\(c.path)")!)
    req.httpMethod = c.method
    for (k, v) in c.headers { req.setValue(v, forHTTPHeaderField: k) }
    req.httpBody = c.body
    req.timeoutInterval = 24 * 3600
    return req
  }

  /// start makes the task of a flight; headersMs bounds the wait for the headers (a stream) or limitMs the whole answer.
  func start(_ f: Flight) {
    queue.addOperation { [self] in
      if closed { fail(f, NetFailure(code: "closed", detail: "")); return }
      let task = urlSession.dataTask(with: urlRequest(f.call))
      f.task = task
      flights[task.taskIdentifier] = f
      byId[f.id] = f
      let ms = f.stream ? f.call.headersMs : f.call.limitMs
      if ms > 0 {
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "aiwb-net-timer"))
        t.schedule(deadline: .now() + .milliseconds(ms))
        t.setEventHandler { [weak self, weak f] in
          guard let f = f else { return }
          f.timedOutBy = "timeout"
          self?.queue.addOperation { f.task?.cancel() }
        }
        t.resume()
        f.timer = t
      }
      task.resume()
    }
  }

  func fail(_ f: Flight, _ failure: NetFailure) {
    if f.stream { f.headReply?(.failure(failure)); f.headReply = nil; f.onEnd?(failure, [:]) } else { f.doneReply?(.failure(failure)) }
  }

  func cancel(_ id: String) {
    queue.addOperation { [self] in
      if let f = byId[id] { f.aborted = true; f.task?.cancel() }
    }
  }

  func close() {
    queue.addOperation { [self] in
      closed = true
      for f in byId.values { f.aborted = true }
      urlSession.invalidateAndCancel()
    }
  }
}

// MARK: - Reading a certificate

/// One handshake that accepts any certificate, takes the leaf's fingerprint, and cancels the challenge: nothing is
/// written to the server (a handshake that sent no request).
final class CertReader: NSObject, URLSessionDelegate {
  var fingerprint: String?
  var session: URLSession!
  var done: ((Result<String, NetFailure>) -> Void)?

  func read(host: String, port: Int, timeoutMs: Int, done: @escaping (Result<String, NetFailure>) -> Void) {
    self.done = done
    let cfg = URLSessionConfiguration.ephemeral
    cfg.urlCache = nil
    cfg.urlCredentialStorage = nil
    cfg.connectionProxyDictionary = [:]
    cfg.timeoutIntervalForRequest = Double(timeoutMs) / 1000
    cfg.tlsMinimumSupportedProtocolVersion = .TLSv12
    session = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    let url = URL(string: "https://\(host.contains(":") ? "[\(host)]" : host):\(port)/")!
    let task = session.dataTask(with: url) { [self] _, _, error in
      defer { session.invalidateAndCancel() }
      if let fp = fingerprint { finish(.success(fp)); return }
      finish(.failure(failure(of: error ?? URLError(.unknown), mismatch: nil, cancelled: false, timedOutBy: nil)))
    }
    task.resume()
  }

  private var finished = false
  private func finish(_ r: Result<String, NetFailure>) {
    if finished { return }
    finished = true
    done?(r)
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
       let trust = challenge.protectionSpace.serverTrust, let fp = leafFingerprint(trust) {
      fingerprint = fp
    }
    completionHandler(.cancelAuthenticationChallenge, nil) // not trusted: the handshake ends here, no request is written
  }
}

// MARK: - The module

public class AiwbNetModule: Module {
  private var sessions: [String: NetSession] = [:]
  private let lock = NSLock()

  private static let logQueue = DispatchQueue(label: "aiwb-spike-log")
  private static func append(_ line: String) {
    logQueue.async {
      guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
      let url = dir.appendingPathComponent("aiwb-spike.log")
      let data = (line + "\n").data(using: .utf8)!
      if let h = try? FileHandle(forWritingTo: url) {
        h.seekToEndOfFile(); h.write(data); try? h.close()
      } else {
        try? data.write(to: url)
      }
    }
  }

  private func session(_ id: String) throws -> NetSession {
    lock.lock(); defer { lock.unlock() }
    guard let s = sessions[id] else { throw NetException(NetFailure(code: "closed", detail: "no such session")) }
    return s
  }

  /// A number from JS arrives as a Double (or an Int): both are read.
  private static func int(_ v: Any?) -> Int? {
    if let i = v as? Int { return i }
    if let d = v as? Double, d.isFinite { return d >= Double(Int.max) ? Int.max : Int(d) }
    return nil
  }

  private static func call(_ o: [String: Any]) -> Call {
    var body: Data?
    if let b64 = o["bodyBase64"] as? String { body = Data(base64Encoded: b64) }
    else if let text = o["body"] as? String { body = text.data(using: .utf8) }
    return Call(
      method: (o["method"] as? String) ?? "GET",
      path: (o["path"] as? String) ?? "/",
      headers: (o["headers"] as? [String: String]) ?? [:],
      body: body,
      maxBytes: int(o["maxBytes"]) ?? Int.max,
      limitMs: int(o["limitMs"]) ?? 0,
      headersMs: int(o["headersMs"]) ?? 0)
  }

  public func definition() -> ModuleDefinition {
    Name("AiwbNet")

    // A chunk of a stream's text, and the end of a stream (error is the JSON of a NetFailure, or "").
    Events("onStreamChunk", "onStreamEnd")

    // readCertificate(host, port, timeoutMs): the leaf certificate's fingerprint, without trusting it and without writing a request.
    AsyncFunction("readCertificate") { (host: String, port: Int, timeoutMs: Int, promise: Promise) in
      let reader = CertReader()
      reader.read(host: host, port: port, timeoutMs: timeoutMs) { result in
        switch result {
        case .success(let fp): promise.resolve(fp)
        case .failure(let f): promise.reject(NetException(f))
        }
      }
    }

    // openSession(host, port, pin): a session id. Nothing is dialed yet: URLSession connects at the first request, and the
    // pin is judged in that handshake, before any request byte. An empty pin is the outcome "fingerprint" (nothing to compare).
    AsyncFunction("openSession") { (host: String, port: Int, pin: String) -> String in
      if pin.trimmingCharacters(in: .whitespaces).isEmpty { throw NetException(NetFailure(code: "fingerprint", detail: "")) }
      let s = NetSession(host: host, port: port, pin: pin)
      let id = UUID().uuidString
      self.lock.lock(); self.sessions[id] = s; self.lock.unlock()
      return id
    }

    // request(sessionId, requestId, options): the whole answer {status, headers, body (base64), protocol, reused}, or a rejection with a
    // NetFailure; a body above maxBytes is not read and rejects with too_long; limitMs bounds all of it.
    AsyncFunction("request") { (sessionId: String, requestId: String, options: [String: Any], promise: Promise) in
      let s = try self.session(sessionId)
      let f = Flight(id: requestId, call: Self.call(options), stream: false)
      f.doneReply = { result in
        switch result {
        case .success(let v): promise.resolve(v)
        case .failure(let e): promise.reject(NetException(e))
        }
      }
      s.start(f)
    }

    // stream(sessionId, requestId, options): resolves with {status, headers} when the headers came; then onStreamChunk {requestId, text}
    // events follow, and onStreamEnd {requestId, error, protocol, reused, bytes} once at the end (error "" for a clean end).
    AsyncFunction("stream") { (sessionId: String, requestId: String, options: [String: Any], promise: Promise) in
      let s = try self.session(sessionId)
      let f = Flight(id: requestId, call: Self.call(options), stream: true)
      f.headReply = { result in
        switch result {
        case .success(let v): promise.resolve(v)
        case .failure(let e): promise.reject(NetException(e))
        }
      }
      f.onChunk = { [weak self] text in self?.sendEvent("onStreamChunk", ["requestId": requestId, "text": text]) }
      f.onEnd = { [weak self] error, info in
        var body: [String: Any] = info
        body["requestId"] = requestId
        body["error"] = error.map { NetException.encode($0) } ?? ""
        self?.sendEvent("onStreamEnd", body)
      }
      s.start(f)
    }

    // cancel(sessionId, requestId): ends the request or the stream; a pending call rejects with "aborted".
    Function("cancel") { (sessionId: String, requestId: String) in
      self.lock.lock(); let s = self.sessions[sessionId]; self.lock.unlock()
      s?.cancel(requestId)
    }

    // closeSession(sessionId): ends the session and everything on it.
    Function("closeSession") { (sessionId: String) in
      self.lock.lock(); let s = self.sessions.removeValue(forKey: sessionId); self.lock.unlock()
      s?.close()
    }

    // selfTestUtf8(text): feeds the UTF-8 of text to the chunker cut at every one and every two byte offsets and compares the pieces,
    // joined, with the text: how many cases ran, or a description of the first that failed.
    Function("selfTestUtf8") { (text: String) -> String in
      let bytes = Data(text.utf8)
      var cases = 0
      func run(_ cuts: [Int]) -> String? {
        var chunker = Utf8Chunker()
        var out = ""
        var from = 0
        for cut in cuts + [bytes.count] {
          let piece = chunker.text(bytes.subdata(in: from..<cut))
          if piece.contains("\u{FFFD}") && !text.contains("\u{FFFD}") { return "replacement character at cuts \(cuts)" }
          out += piece
          from = cut
        }
        cases += 1
        return out == text ? nil : "cuts \(cuts): got \(out.debugDescription)"
      }
      for i in 0...bytes.count {
        if let e = run([i]) { return e }
        for j in i...bytes.count { if let e = run([i, j]) { return e } }
      }
      return "ok \(cases) cases over \(bytes.count) bytes"
    }

    // The normal form of a pin (desktop/conn/list.js normalFingerprint), nil when the text is no fingerprint.
    Function("normalFingerprint") { (s: String) -> String? in normalFingerprint(s) }

    // What the spike's runner hands to the app: the AIWB_* variables of the launch (simctl passes SIMCTL_CHILD_AIWB_* as AIWB_*).
    Constants {
      let env = ProcessInfo.processInfo.environment.filter { $0.key.hasPrefix("AIWB_") }
      return ["env": env]
    }

    // log(line): NSLog with a fixed prefix, and the same line appended to Documents/aiwb-spike.log, which the runner reads from the
    // simulator's data container.
    Function("log") { (line: String) in
      NSLog("AIWB_SPIKE %@", line)
      Self.append(line)
    }
  }
}
