package expo.modules.aiwbnet

import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

/**
 * UTF-8 to text, chunk by chunk (README.md, "stream"): the bytes of a character cut by a read wait for the next one, so the
 * text that comes out is always whole characters. An invalid sequence becomes U+FFFD, as Node's StringDecoder does. Nothing is
 * kept between chunks but the (at most 3) bytes of an incomplete character.
 */
class Utf8Chunks {
  private val dec = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE)
  private val inBuf = ByteBuffer.allocate(64 * 1024 + 8)
  private val outBuf = CharBuffer.allocate(64 * 1024 + 8)

  fun push(b: ByteArray, n: Int): String {
    val sb = StringBuilder()
    var off = 0
    while (off < n) {
      val take = minOf(n - off, inBuf.remaining())
      inBuf.put(b, off, take)
      off += take
      inBuf.flip()
      outBuf.clear()
      dec.decode(inBuf, outBuf, false)
      outBuf.flip()
      sb.append(outBuf)
      inBuf.compact()
    }
    return sb.toString()
  }

  /** The bytes that wait for the next chunk, decoded: at the end of a stream they are an invalid sequence. */
  fun finish(): String {
    inBuf.flip()
    outBuf.clear()
    dec.decode(inBuf, outBuf, true)
    dec.flush(outBuf)
    outBuf.flip()
    val s = outBuf.toString()
    inBuf.clear()
    dec.reset()
    return s
  }

  companion object {
    /** Feeds the UTF-8 of [text] cut at every one and every two byte offsets and compares the pieces, joined, with the text:
     *  "ok <cases> cases over <bytes> bytes", or a description of the first case that failed (the device test calls it). */
    fun selfTest(text: String): String {
      val bytes = text.toByteArray(Charsets.UTF_8)
      var cases = 0
      fun run(cuts: List<Int>): String? {
        val d = Utf8Chunks()
        val out = StringBuilder()
        var from = 0
        for (cut in cuts + bytes.size) {
          val piece = d.push(bytes.copyOfRange(from, cut), cut - from)
          if (piece.contains('�') && !text.contains('�')) return "a replacement character at cuts $cuts"
          out.append(piece)
          from = cut
        }
        out.append(d.finish())
        cases++
        return if (out.toString() == text) null else "cuts $cuts: got $out"
      }
      for (i in 0..bytes.size) {
        run(listOf(i))?.let { return it }
        for (j in i..bytes.size) run(listOf(i, j))?.let { return it }
      }
      return "ok $cases cases over ${bytes.size} bytes"
    }
  }
}
