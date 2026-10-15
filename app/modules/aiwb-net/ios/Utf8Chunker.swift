import Foundation

/// Decodes UTF-8 chunk by chunk (README, "stream"): a character cut between two chunks waits for the rest, so the
/// text that comes out is always whole characters. An invalid sequence becomes U+FFFD, as Node's StringDecoder does.
/// Nothing is kept between chunks but the (at most 3) bytes of an incomplete character.
struct Utf8Chunker {
  private var pending = Data()

  mutating func text(_ chunk: Data) -> String {
    pending.append(chunk)
    let cut = Utf8Chunker.completeLength(pending)
    let head = pending.prefix(cut)
    pending = Data(pending.suffix(from: pending.startIndex + cut))
    return String(decoding: head, as: UTF8.self)
  }

  /// The bytes that wait for the next chunk, decoded: at the end of a stream they are an invalid sequence.
  mutating func finish() -> String {
    let rest = pending
    pending = Data()
    return rest.isEmpty ? "" : String(decoding: rest, as: UTF8.self)
  }

  /// How many leading bytes of `data` do not end inside a character: the last lead byte, and the continuation
  /// bytes after it, are left out when the character they begin is not whole yet.
  static func completeLength(_ data: Data) -> Int {
    let n = data.count
    var i = n
    var back = 0
    while i > 0 && back < 4 {
      let b = data[data.startIndex + i - 1]
      if b & 0xC0 == 0x80 { i -= 1; back += 1; continue } // a continuation byte
      if b & 0x80 == 0 { return n } // ASCII: the end is whole
      let need = b >= 0xF0 ? 4 : b >= 0xE0 ? 3 : 2
      return n - i + 1 < need ? i - 1 : n
    }
    return n // only continuation bytes: not a character that can be completed
  }

  /// Feeds the UTF-8 of `text` cut at every one and every two byte offsets and compares the pieces, joined, with the
  /// text: "ok <cases> cases over <bytes> bytes", or a description of the first case that failed.
  static func selfTest(_ text: String) -> String {
    let bytes = Data(text.utf8)
    var cases = 0
    func run(_ cuts: [Int]) -> String? {
      var chunker = Utf8Chunker()
      var out = ""
      var from = 0
      for cut in cuts + [bytes.count] {
        let piece = chunker.text(bytes.subdata(in: from..<cut))
        if piece.contains("\u{FFFD}") && !text.contains("\u{FFFD}") { return "a replacement character at cuts \(cuts)" }
        out += piece
        from = cut
      }
      out += chunker.finish()
      cases += 1
      return out == text ? nil : "cuts \(cuts): got \(out.debugDescription)"
    }
    for i in 0...bytes.count {
      if let e = run([i]) { return e }
      for j in i...bytes.count { if let e = run([i, j]) { return e } }
    }
    return "ok \(cases) cases over \(bytes.count) bytes"
  }
}
