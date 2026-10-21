package expo.modules.aiwbaudio

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRouting
import android.media.AudioTrack
import android.os.Handler
import kotlin.math.sqrt

// The player (architecture VC-8): one AudioTrack in MODE_STREAM, 24 kHz mono PCM 16, fed by a writer thread from a queue of PCM and marks,
// so that what is written plays after what was written before with no gap of its own. A mark is the number of frames written when the
// writer reached it; it is emitted when the track's playback head passes it. The head is read every 40 ms on the engine's thread while
// something plays (marks, the level of the piece that plays, and `drained` when the head has reached the end of what was written and
// nothing waits). Every method but the writer's loop runs on the engine's thread.
//
// Devices (voice-devices VD-10): `prefer` routes the track to a chosen output (null: the system's routing), the track made next too; the
// device the track plays on is told through `onRouted` when it changes. `hold` pauses the track where it is and keeps everything: what is
// in the track's buffer, what waits in the queue, and what is written while held (the writer waits instead of dropping a piece that the
// paused track does not take). `resume` plays on from there. While held no `drained` is emitted and no silence is pushed.
internal class PcmPlayer(
  private val handler: Handler,
  private val onEvent: (Map<String, Any?>) -> Unit,
  private val onDrained: () -> Unit,
  private val onRouted: (AudioDeviceInfo?) -> Unit,
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
  private var held = false
  /** How many holds there have been: a write given back by a hold's pause is told from one given back by stop(). */
  private var holds = 0
  private var preferred: AudioDeviceInfo? = null

  /** The track's routing changes, told on the engine's thread (only for the track in use). */
  private val routing = AudioRouting.OnRoutingChangedListener { r ->
    val current = synchronized(lock) { r === track }
    if (current) onRouted(r.routedDevice)
  }

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

  /** Whether a track is made (something plays, or played a moment ago). */
  val hasTrack: Boolean get() = synchronized(lock) { track != null }

  /** The device the track plays on now (null: no track, or not playing). */
  fun routedDevice(): AudioDeviceInfo? = synchronized(lock) {
    try { track?.routedDevice } catch (_: IllegalStateException) { null }
  }

  /** The output to route to (null: the system's routing), for the track now and the ones made after. */
  fun prefer(d: AudioDeviceInfo?) {
    synchronized(lock) {
      if (preferred?.id == d?.id) return
      preferred = d
      track?.let { try { it.setPreferredDevice(d) } catch (_: IllegalStateException) { /* released */ } }
    }
  }

  val isHeld: Boolean get() = synchronized(lock) { held }

  /** Pauses the sound where it is; the queue and the track's buffer are kept, and writes are still queued. */
  fun hold() {
    synchronized(lock) {
      if (held) return
      held = true
      holds += 1
      track?.let { try { it.pause() } catch (_: IllegalStateException) { /* released */ } }
    }
    if (busy) onEvent(mapOf("kind" to "level", "level" to 0.0))
  }

  /** Plays on from where hold() stopped. */
  fun resume() {
    synchronized(lock) {
      if (!held) return
      held = false
      track?.let { try { it.play() } catch (_: IllegalStateException) { /* released */ } }
      lock.notifyAll()
    }
    resetHead()
    if (busy) startPolling()
  }

  /** Ends a hold that holds nothing (nothing was written while held): the next track plays at once. */
  fun clearHold() {
    synchronized(lock) {
      if (busy) return
      held = false
      lock.notifyAll()
    }
  }

  /** Stops at once and empties the queue (a hold ends with it). Answers whether something was playing. The track is let go (the next
   *  write makes another), so that no frame of what was cut is left in it and its head starts again from 0. */
  fun stop(): Boolean {
    val had = busy
    carry = null
    busy = false
    synchronized(lock) {
      // A writer that waits on a hold, or is inside write(), lets the piece go: the generation is no longer its own.
      generation += 1
      held = false
      lock.notifyAll()
      items.clear()
      marks.clear()
      pieces.clear()
      track?.let {
        // pause() makes a blocking write return at once; stop() does it for a track that a hold had paused already.
        try { it.pause(); it.flush(); it.stop() } catch (_: IllegalStateException) { /* released */ }
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
    preferred?.let { t.setPreferredDevice(it) }
    t.addOnRoutingChangedListener(routing, handler)
    if (!held) t.play()
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
        // Held: no write goes into the paused track (it would wait there for room); the writer waits here for resume, or for stop.
        val holdsBefore = synchronized(lock) {
          while (held && gen == generation && !closed) lock.wait()
          if (gen != generation || closed) -1 else holds
        }
        if (holdsBefore < 0) break
        val n = try { out.write(p.bytes, off, p.bytes.size - off, AudioTrack.WRITE_BLOCKING) } catch (_: IllegalStateException) { -1 }
        if (n < 0) break
        if (n == 0) {
          // The pause of a hold gives a blocking write back early: the rest is written after the resume. A pause of stop(): cut, as before.
          val heldSince = synchronized(lock) { held || holds != holdsBefore }
          if (heldSince) continue
          break
        }
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
      if (!busy || isHeld) {
        // Held: the head stands still on purpose; resume() starts the polling again.
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
