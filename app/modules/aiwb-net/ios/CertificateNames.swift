import Foundation

/// The names a certificate says it is for: the `dNSName` and `iPAddress` entries of its subjectAltName extension, read from
/// the DER. The platform's evaluation names a host mismatch only for a certificate it finds compliant (an Apple rule: at most
/// 825 days, among others); a certificate of the user's own server may not be, and `cert_name` must still come first
/// (README, "The mapping table"), so the name is checked here when the evaluation cannot say.
struct CertificateNames {
  var dns: [String] = []
  var addresses: [Data] = []

  /// nil when the certificate has no subjectAltName extension.
  init?(der: Data) {
    let bytes = [UInt8](der)
    let oid: [UInt8] = [0x06, 0x03, 0x55, 0x1D, 0x11] // 2.5.29.17
    guard let at = CertificateNames.find(oid, in: bytes) else { return nil }
    var i = at + oid.count
    if i + 2 < bytes.count, bytes[i] == 0x01, bytes[i + 1] == 0x01 { i += 3 } // critical
    guard let (tag, start, end) = CertificateNames.element(bytes, at: i), tag == 0x04, // the OCTET STRING
          let (seq, from, to) = CertificateNames.element(bytes, at: start), seq == 0x30, to <= end else { return nil }
    var j = from
    while j < to, let (t, s, e) = CertificateNames.element(bytes, at: j) {
      if t == 0x82 { dns.append(String(decoding: bytes[s..<e], as: UTF8.self).lowercased()) }
      if t == 0x87 { addresses.append(Data(bytes[s..<e])) }
      j = e
    }
  }

  /// Is `host` one of the names? A wildcard stands for the first label only.
  func covers(_ host: String) -> Bool {
    var v4 = in_addr(), v6 = in6_addr()
    if inet_pton(AF_INET, host, &v4) == 1 { return addresses.contains(withUnsafeBytes(of: &v4) { Data($0) }) }
    if inet_pton(AF_INET6, host, &v6) == 1 { return addresses.contains(withUnsafeBytes(of: &v6) { Data($0) }) }
    let h = host.lowercased()
    return dns.contains { name in
      if name == h { return true }
      guard name.hasPrefix("*."), let dot = h.firstIndex(of: ".") else { return false }
      return String(h[dot...]) == String(name.dropFirst(1))
    }
  }

  private static func find(_ needle: [UInt8], in hay: [UInt8]) -> Int? {
    guard hay.count >= needle.count else { return nil }
    for i in 0...(hay.count - needle.count) where hay[i] == needle[0] && Array(hay[i..<(i + needle.count)]) == needle { return i }
    return nil
  }

  /// The DER element at `i`: its tag, and where its content starts and ends.
  private static func element(_ b: [UInt8], at i: Int) -> (UInt8, Int, Int)? {
    guard i + 2 <= b.count else { return nil }
    let tag = b[i]
    var length = Int(b[i + 1])
    var start = i + 2
    if length & 0x80 != 0 {
      let n = length & 0x7F
      guard n >= 1, n <= 4, start + n <= b.count else { return nil }
      length = b[start..<(start + n)].reduce(0) { $0 << 8 | Int($1) }
      start += n
    }
    guard start + length <= b.count else { return nil }
    return (tag, start, start + length)
  }
}
