import Foundation
import Network

/// Learns whether a TCP connection to host:port can be made, writing nothing. URLSession's metrics of a task that was
/// cancelled while it dialed say nothing of how far it came, and the contract names a connect that never ended `no_route`
/// but a handshake that never ended `tls_timeout`: when a dial times out, this tells the two apart.
final class TcpProbe {
  private let connection: NWConnection
  private var done: ((Bool) -> Void)?

  init?(host: String, port: Int) {
    guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return nil }
    connection = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
  }

  /// `done(true)` when the connection was made within `ms`, else `done(false)`; called once, on `queue`.
  func run(within ms: Int, on queue: DispatchQueue, done: @escaping (Bool) -> Void) {
    self.done = done
    connection.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready: self?.finish(true)
      case .failed, .waiting: self?.finish(false) // refused, unreachable: the connect did not end
      default: break
      }
    }
    queue.asyncAfter(deadline: .now() + .milliseconds(ms)) { [weak self] in self?.finish(false) }
    connection.start(queue: queue)
  }

  private func finish(_ connected: Bool) {
    guard let d = done else { return }
    done = nil
    connection.stateUpdateHandler = nil
    connection.cancel()
    d(connected)
  }
}
