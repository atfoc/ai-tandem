import ExpoModulesCore
import Foundation

// The iOS side of `aiwb-net` (package N1): the contract of ../README.md over URLSession, starting from the code the
// iOS spike proved (plans/rn-rewrite/spikes/ios-net.md). It holds no decision of the app: it dials, judges the
// certificate by the pin, speaks HTTP/2 through the system's stack and reports. The TypeScript of the contract is
// ../src/AiwbNet.ts; NetSession.swift is the session, NetFailure.swift the errors and the one address function.

// MARK: - Options (typed, so that a number from JS is a number: the spike's untyped dictionary lost its limits)

struct OpenSessionOptions: Record {
  @Field var request: String = ""
  @Field var host: String = ""
  @Field var port: Int = 0
  @Field var selfSigned: Bool = false
  @Field var pin: String = ""
  @Field var dialMs: Int = 0
  @Field var handshakeMs: Int = 0
}

struct ReadCertificateOptions: Record {
  @Field var request: String = ""
  @Field var host: String = ""
  @Field var port: Int = 0
  @Field var dialMs: Int = 0
  @Field var handshakeMs: Int = 0
}

struct FetchOptions: Record {
  @Field var session: String = ""
  @Field var request: String = ""
  @Field var method: String = "GET"
  @Field var path: String = "/"
  @Field var headers: [String: String] = [:]
  @Field var body: Data?
  @Field var headersMs: Int = 0
  @Field var maxBytes: Int = 0
}

struct StreamOptions: Record {
  @Field var session: String = ""
  @Field var request: String = ""
  @Field var method: String = "GET"
  @Field var path: String = "/"
  @Field var headers: [String: String] = [:]
  @Field var headersMs: Int = 0
}

// MARK: - What is open

/// The sessions by id, and the requests that can still be cancelled by their id (a `request` is made by the caller, so
/// `cancel` may come before the call has started: such an id is remembered, and the call that comes is aborted).
final class NetRegistry {
  private let lock = NSLock()
  private var sessions: [String: NetSession] = [:]
  private var cancellers: [String: () -> Void] = [:]
  private var cancelled: [String] = [] // FIFO of ids cancelled before they started
  private static let remembered = 256

  func add(_ s: NetSession) { lock.lock(); sessions[s.id] = s; lock.unlock() }
  func remove(_ id: String) { lock.lock(); sessions[id] = nil; lock.unlock() }
  func session(_ id: String) -> NetSession? { lock.lock(); defer { lock.unlock() }; return sessions[id] }

  /// false: the request was cancelled before it began.
  func begin(_ id: String, cancel: @escaping () -> Void) -> Bool {
    lock.lock(); defer { lock.unlock() }
    if let i = cancelled.firstIndex(of: id) { cancelled.remove(at: i); return false }
    cancellers[id] = cancel
    return true
  }

  func end(_ id: String) { lock.lock(); cancellers[id] = nil; lock.unlock() }

  func cancel(_ id: String) {
    lock.lock()
    let c = cancellers[id]
    if c == nil {
      cancelled.append(id)
      if cancelled.count > NetRegistry.remembered { cancelled.removeFirst() }
    }
    lock.unlock()
    c?()
  }
}

// MARK: - The module

public class AiwbNetModule: Module {
  private let registry = NetRegistry()

  private func reject(_ promise: Promise, _ failure: NetFailure) {
    promise.reject(NetException(failure))
  }

  private func makeSession(host: String, port: Int, trust: Trust) -> NetSession {
    NetSession(
      host: host, port: port, trust: trust,
      emit: { [weak self] name, body in self?.sendEvent(name, body) },
      ended: { [weak self] id in self?.registry.end(id) },
      gone: { [weak self] s in self?.registry.remove(s.id) })
  }

  /// A dial: the probe of `openSession` or the read of `readCertificate`, on a session of its own.
  private func dial(request: String, host: String, port: Int, dialMs: Int, handshakeMs: Int, trust: Trust, kind: FlightKind,
                    promise: Promise, finish: @escaping (NetSession, [String: Any]) -> [String: Any]?) {
    guard let url = httpsURL(host, port, kind == .probe ? "/api/hello" : "/") else {
      return reject(promise, .problem("name_not_found", "\(host) is not a host name or an address"))
    }
    let session = makeSession(host: host, port: port, trust: trust)
    let f = Flight(id: request, kind: kind, url: url, timerMs: dialMs + handshakeMs)
    f.reply = { [weak self] result in
      guard let self = self else { return }
      switch result {
      case let .failure(failure):
        session.close()
        self.reject(promise, failure)
      case let .success(out):
        if f.isCancelled { // the session that was made at that moment is closed: nothing is left open
          session.close()
          return self.reject(promise, .aborted)
        }
        if let answer = finish(session, out) { promise.resolve(answer) } else { session.close(); self.reject(promise, .aborted) }
      }
    }
    if !registry.begin(request, cancel: { session.cancel(f) }) {
      session.close()
      return reject(promise, .aborted)
    }
    session.start(f)
  }

  public func definition() -> ModuleDefinition {
    Name("AiwbNet")

    Events("chunk", "end", "closed")

    // A session to host:port: a TCP connection, a TLS handshake whose certificate passed the trust, and h2. URLSession
    // connects at the first request, so the probe (GET /api/hello, no secret, no app header, its answer discarded) makes
    // the connection and its metrics tell the protocol; nothing was written before the trust accepted the certificate.
    AsyncFunction("openSession") { (o: OpenSessionOptions, promise: Promise) in
      if o.selfSigned && o.pin.isEmpty {
        return self.reject(promise, .problem("fingerprint", "no fingerprint to compare the certificate with")) // nothing is dialed
      }
      self.dial(request: o.request, host: o.host, port: o.port, dialMs: o.dialMs, handshakeMs: o.handshakeMs,
                trust: o.selfSigned ? .pinned(o.pin) : .system, kind: .probe, promise: promise) { session, out in
        guard let fingerprint = out["fingerprint"] as? String else { return nil }
        self.registry.add(session)
        session.announce()
        LocalNetwork.shared.opened(host: o.host)
        return ["session": session.id, "fingerprint": fingerprint]
      }
    }

    // The handshake that takes any certificate: its leaf's fingerprint, and nothing written.
    AsyncFunction("readCertificate") { (o: ReadCertificateOptions, promise: Promise) in
      self.dial(request: o.request, host: o.host, port: o.port, dialMs: o.dialMs, handshakeMs: o.handshakeMs,
                trust: .read, kind: .read, promise: promise) { session, out in
        session.close()
        return out
      }
    }

    AsyncFunction("fetch") { (o: FetchOptions, promise: Promise) in
      guard let session = self.registry.session(o.session) else { return self.reject(promise, .net("closed")) }
      guard let url = httpsURL(session.host, session.port, o.path) else {
        return self.reject(promise, .net("reset", "\(o.path) is not a path of the client API"))
      }
      let f = Flight(id: o.request, kind: .fetch, url: url, method: o.method, headers: o.headers, body: o.body,
                     maxBytes: o.maxBytes, timerMs: o.headersMs)
      f.reply = { [weak self] result in
        switch result {
        case let .success(answer): promise.resolve(answer)
        case let .failure(failure): self?.reject(promise, failure)
        }
      }
      if !self.registry.begin(o.request, cancel: { session.cancel(f) }) { return self.reject(promise, .aborted) }
      session.start(f)
    }

    // Resolves at the headers; the body follows as `chunk` events and one `end`.
    AsyncFunction("stream") { (o: StreamOptions, promise: Promise) in
      guard let session = self.registry.session(o.session) else { return self.reject(promise, .net("closed")) }
      guard let url = httpsURL(session.host, session.port, o.path) else {
        return self.reject(promise, .net("reset", "\(o.path) is not a path of the client API"))
      }
      let f = Flight(id: o.request, kind: .stream, url: url, method: o.method, headers: o.headers, timerMs: o.headersMs)
      f.reply = { [weak self] result in
        switch result {
        case let .success(head): promise.resolve(head)
        case let .failure(failure): self?.reject(promise, failure)
        }
      }
      if !self.registry.begin(o.request, cancel: { session.cancel(f) }) { return self.reject(promise, .aborted) }
      session.start(f)
    }

    // Never throws; a request that is over or never was is nothing.
    Function("cancel") { (request: String) in
      self.registry.cancel(request)
    }

    // Ends the session and every request on it; `closed` follows once. A session that is gone: nothing.
    Function("closeSession") { (session: String) in
      guard let s = self.registry.session(session) else { return }
      self.registry.remove(session)
      s.close()
    }

    AsyncFunction("localNetwork") { () -> String in
      LocalNetwork.shared.state
    }

    // Not part of the contract: the UTF-8 chunker fed the UTF-8 of `text` cut at every one and every two byte offsets.
    // "ok <cases> cases over <bytes> bytes", or a description of the first case that failed (the device test calls it).
    Function("selfTestUtf8") { (text: String) -> String in
      Utf8Chunker.selfTest(text)
    }
  }
}
