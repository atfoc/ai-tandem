import ExpoModulesCore
import Foundation
import CryptoKit
import Security

// The failures of the module as the contract says them (../README.md, "Errors"), the exception that carries one to
// JS, the fingerprint of a certificate and the one function that builds the address of a request.

/// What a failed call says: why no session was made (`problem`), why a request got no usable answer (`net`), or that
/// `cancel` ended it (`aborted`). `info` is the `NetErr` of src/AiwbNet.ts.
enum NetFailure: Error {
  case problem(String, String, fingerprint: String? = nil, pinned: String? = nil)
  case net(String, String? = nil)
  case aborted

  var info: [String: Any] {
    switch self {
    case let .problem(outcome, detail, fingerprint, pinned):
      var o: [String: Any] = ["kind": "problem", "outcome": outcome, "detail": oneLine(detail)]
      if let fingerprint = fingerprint { o["fingerprint"] = fingerprint }
      if let pinned = pinned { o["pinned"] = pinned }
      return o
    case let .net(code, detail):
      var o: [String: Any] = ["kind": "net", "code": code]
      if let detail = detail, !detail.isEmpty { o["detail"] = oneLine(detail) }
      return o
    case .aborted:
      return ["kind": "aborted"]
    }
  }

  /// The JSON text of `info`: the message of the exception ends with it, which is how `netInfoOf` reads it.
  var json: String {
    guard let data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { return "{\"kind\":\"aborted\"}" }
    return text
  }

  var isReset: Bool {
    if case .net("reset", _) = self { return true }
    return false
  }
}

/// A detail is one line.
func oneLine(_ s: String) -> String {
  s.split(whereSeparator: { $0.isNewline }).joined(separator: " ")
}

/// The rejection of a function: code `AIWB_NET`, the `NetErr` as the last `{...}` of the message.
final class NetException: Exception, @unchecked Sendable {
  let failure: NetFailure
  init(_ failure: NetFailure) {
    self.failure = failure
    super.init(name: "AiwbNetError", description: failure.json, code: "AIWB_NET")
  }
}

// MARK: - The address

/// The one place of the app's native code that builds the address of a request, and so the one place that names a
/// scheme: `https`. The contract has no scheme (AD-36); a host that holds `/`, `@`, `?`, `#` or a blank, a path that
/// does not start with `/` and a port outside 1...65535 are refused (nil).
func httpsURL(_ host: String, _ port: Int, _ path: String) -> URL? {
  if host.isEmpty || host.contains(where: { "/@?#".contains($0) || $0.isWhitespace }) { return nil }
  if !path.hasPrefix("/") || !(1...65535).contains(port) { return nil }
  let authority = host.contains(":") ? "[\(host)]" : host // an IPv6 literal
  return URL(string: "https://\(authority):\(port)\(path)")
}

// MARK: - Fingerprints

/// The SHA-256 of a DER certificate as upper-case hex pairs joined by ":" (`fingerprintOf` of packages/conn/node/tls.js).
func fingerprintOf(_ der: Data) -> String {
  SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
}

/// The fingerprint of the leaf (the first certificate the server presents) of a trust, or nil when it presents none.
func leafFingerprint(_ trust: SecTrust) -> String? {
  guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
  return fingerprintOf(SecCertificateCopyData(leaf) as Data)
}
