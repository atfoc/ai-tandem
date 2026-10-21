package expo.modules.aiwbaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import kotlin.math.sqrt

// The player (architecture VC-8): one AudioTrack in MODE_STREAM, 24 kHz mono PCM 16, fed by a writer thread from a queue of PCM and marks,
// so that what is written plays after what was written before with no gap of its own. A mark is the number of frames written when the
// writer reached it; it is emitted when the track's playback head passes it. The head is read every 40 ms on the engine's thread while
// something plays (marks, the level of the piece that plays, and `drained` when the head has reached the end of what was written and
// nothing waits). Every method but the writer's loop runs on the engine's thread.
internal class PcmPlayer(
  private val handler: Handler,
  private val onEvent: (Map<String, Any?>) -> Unit,
  private val onDrained: () -> Unit,
) {
  private sealed class Item {
    class Pcm(val bytes: ByteArray, val level: Double) : Item()
    class Mark(val id: Int) : Item()
  }

  private class Piece(val from: Long, val to: Long, val level: Double)

  /** The usage of the next track that is made (a made track keeps its own). */
  var usage = AudioAttributes.USAGE_ASSISTANT

  /** Something was written that has not been played to its end. */
  var busy = false
    private set

  private val lock = Object()
  // Shared with the writer thread, under `lock`.
  private val items = ArrayDeque<Item>()
  private var track: AudioTrack? = null
  private var generation = 0
  private var written = 0L
  private var writing = false
  private var closed = false
  private val marks = ArrayDeque<Pair<Long, Int>>()
  private val pieces = ArrayDeque<Piece>()
  private var writer: Thread? = null

  // The engine thread's own.
  private var carry: Byte? = null
  private var polling = false
  private var lastHead = -1L
  private var stalls = 0
  private var padded = false

  fun write(pcm: ByteArray) {
    var bytes = pcm
    carry?.let { bytes = byteArrayOf(it) + bytes }
    carry = null
    if (bytes.size % 2 == 1) {
      carry = bytes[bytes.size - 1]
      bytes = bytes.copyOf(bytes.size - 1)
    }
    if (bytes.isEmpty()) return
    var sum = 0.0
    for (i in bytes.indices step 2) {
      val s = ((bytes[i].toInt() and 0xff) or (bytes[i + 1].toInt() shl 8)).toShort().toDouble()
      sum += s * s
    }
    val level = minOf(1.0, sqrt(sum / (bytes.size / 2)) / 32768.0)
    synchronized(lock) {
      items.addLast(Item.Pcm(bytes, level))
      if (track == null) track = makeTrack()
      lock.notifyAll()
    }
    busy = true
    padded = false
    startWriter()
    startPolling()
  }

  /** A mark with nothing playing is reached when the next piece starts, as one after a piece is reached when that piece has played. */
  fun mark(id: Int) {
    synchronized(lock) {
      items.addLast(Item.Mark(id))
      lock.notifyAll()
    }
    startWriter()
  }

  /** Stops at once and empties the queue. Answers whether something was playing. The track is let go (the next write makes another),
   *  so that no frame of what was cut is left in it and its head starts again from 0. */
  fun stop(): Boolean {
    val had = busy
    carry = null
    busy = false
    synchronized(lock) {
      items.clear()
      marks.clear()
      pieces.clear()
      track?.let {
        // pause() makes a blocking write return at once.
        try { it.pause(); it.flush() } catch (_: IllegalStateException) { /* released */ }
      }
    }
    release()
    return had
  }

  /** Releases the track (after stop, or with nothing playing); the next write makes a new one with the usage of then. */
  fun release() {
    synchronized(lock) {
      generation += 1
      written = 0
      // A mark that waits for the next piece (nothing plays now) is at the start of the next track.
      val waiting = marks.map { 0L to it.second }
      marks.clear()
      marks.addAll(waiting)
      val t = track ?: return@synchronized
      track = null
      // A writer still inside write() on it releases it when it returns.
      if (!writing) t.release() else retired = t
    }
    resetHead()
  }

  private var retired: AudioTrack? = null

  fun close() {
    stop()
    release()
    synchronized(lock) {
      closed = true
      lock.notifyAll()
    }
  }

  private fun resetHead() {
    lastHead = -1
    stalls = 0
    padded = false
  }

  private fun makeTrack(): AudioTrack {
    val min = AudioTrack.getMinBufferSize(RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val t = AudioTrack.Builder()
      .setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setBufferSizeInBytes(maxOf(min, 0) * 2)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    t.play()
    return t
  }

  private fun startWriter() {
    if (writer != null) return
    writer = Thread({ writeLoop() }, "aiwb-audio-player").also { it.start() }
  }

  private fun writeLoop() {
    while (true) {
      var pcm: Item.Pcm? = null
      var t: AudioTrack? = null
      var gen = 0
      var from = 0L
      synchronized(lock) {
        while (items.isEmpty() && !closed) lock.wait()
        if (closed) return
        when (val item = items.removeFirst()) {
          is Item.Mark -> marks.addLast(written to item.id)
          is Item.Pcm -> {
            if (track == null) track = makeTrack()
            pcm = item
            t = track
            gen = generation
            from = written
            pieces.addLast(Piece(from, from + item.bytes.size / 2, item.level))
            writing = true
          }
        }
      }
      val p = pcm ?: continue
      val out = t ?: continue
      var off = 0
      while (off < p.bytes.size) {
        val n = try { out.write(p.bytes, off, p.bytes.size - off, AudioTrack.WRITE_BLOCKING) } catch (_: IllegalStateException) { -1 }
        if (n <= 0) break
        off += n
        val current = synchronized(lock) {
          if (gen == generation) written += n / 2
          gen == generation
        }
        if (!current) break
      }
      synchronized(lock) {
        writing = false
        retired?.let { if (it === out) { it.release(); retired = null } }
        lock.notifyAll()
      }
    }
  }

  private fun startPolling() {
    if (polling) return
    polling = true
    handler.postDelayed(poll, POLL_MS)
  }

  private val poll = object : Runnable {
    override fun run() {
      if (!busy) {
        polling = false
        return
      }
      var drained = false
      var level = 0.0
      val reached = ArrayList<Int>()
      synchronized(lock) {
        val t = track
        val head = t?.playbackHeadPosition?.toLong()?.and(0xffffffffL) ?: written
        while (marks.isNotEmpty() && marks.first().first <= head) reached.add(marks.removeFirst().second)
        while (pieces.isNotEmpty() && pieces.first().to <= head) pieces.removeFirst()
        level = pieces.firstOrNull()?.takeIf { it.from <= head }?.level ?: 0.0
        val waiting = items.isNotEmpty() || writing
        if (!waiting && head >= written) {
          drained = true
        } else if (!waiting && t != null) {
          // The track starts and goes on only with enough frames in its buffer: the last piece of a short reply may be less. When the head
          // has not moved for a while with nothing more to come, a buffer of silence pushes the rest out (not counted as written).
          stalls = if (head == lastHead) stalls + 1 else 0
          if (stalls >= 3 && !padded) {
            padded = true
            try { t.write(ByteArray(t.bufferSizeInFrames * 2), 0, t.bufferSizeInFrames * 2, AudioTrack.WRITE_NON_BLOCKING) } catch (_: IllegalStateException) {}
          }
        }
        lastHead = head
      }
      for (id in reached) onEvent(mapOf("kind" to "mark", "id" to id))
      onEvent(mapOf("kind" to "level", "level" to level))
      if (drained) {
        busy = false
        polling = false
        onEvent(mapOf("kind" to "drained"))
        onDrained()
        return
      }
      handler.postDelayed(this, POLL_MS)
    }
  }

  private companion object {
    const val RATE = 24000
    const val POLL_MS = 40L
  }
}
