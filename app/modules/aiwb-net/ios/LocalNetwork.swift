import Foundation
import Network

/// What the module knows of the local network permission (README, `localNetwork()`): `granted` once a session to a
/// private address opened, `denied` from the path's `unsatisfiedReason` (`NWPathMonitor`, iOS 14.2+) or from a dial
/// that failed with it, else `unknown`. It never prompts: the system asks at the first connection to the local network.
final class LocalNetwork {
  static let shared = LocalNetwork()

  private let lock = NSLock()
  private var denied = false
  private var granted = false
  private let monitor = NWPathMonitor()

  private init() {
    monitor.pathUpdateHandler = { [weak self] path in
      if path.status != .satisfied && path.unsatisfiedReason == .localNetworkDenied { self?.setDenied() }
    }
    monitor.start(queue: DispatchQueue(label: "aiwb-net.path"))
  }

  var state: String {
    lock.lock(); defer { lock.unlock() }
    return denied ? "denied" : granted ? "granted" : "unknown"
  }

  func setDenied() {
    lock.lock(); denied = true; granted = false; lock.unlock()
  }

  /// A session to `host` opened: the permission is granted when the host is on the local network.
  func opened(host: String) {
    guard LocalNetwork.isPrivate(host) else { return }
    lock.lock(); granted = true; denied = false; lock.unlock()
  }

  /// Is the path (of a failed dial, or the current one) refused by the local network permission?
  func isDenied(_ path: NWPath?) -> Bool {
    if let path = path, path.status != .satisfied, path.unsatisfiedReason == .localNetworkDenied { return true }
    let current = monitor.currentPath
    return current.status != .satisfied && current.unsatisfiedReason == .localNetworkDenied
  }

  /// A private IPv4 or IPv6 address, a link-local one, a loopback one, or a `.local` name.
  static func isPrivate(_ host: String) -> Bool {
    let h = host.lowercased()
    if h == "localhost" || h.hasSuffix(".local") || h == "::1" { return true }
    if h.hasPrefix("fe80:") || h.hasPrefix("fc") || h.hasPrefix("fd") { return h.contains(":") }
    let p = h.split(separator: ".").compactMap { Int($0) }
    guard p.count == 4, p.allSatisfy({ (0...255).contains($0) }) else { return false }
    return p[0] == 10 || p[0] == 127 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
  }
}
