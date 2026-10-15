package expo.modules.aiwbnet

import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * The events of one stream (README.md, "The events"): the text that arrives within 16 ms is one `chunk` event, no more than
 * [MAX_CHARS] characters wait before one is sent, `end` comes once and after the last `chunk`, and after [silence] (what
 * `cancel` does) nothing is sent at all. Every event is sent under one lock, so their order is the order of the calls.
 */
class StreamPump(
  private val request: String,
  private val timers: ScheduledExecutorService,
  private val emit: (String, Map<String, Any?>) -> Unit,
) {
  private val lock = Any()
  private val pending = StringBuilder()
  private var flushing: ScheduledFuture<*>? = null
  private var silenced = false
  private var ended = false

  fun push(text: String) {
    if (text.isEmpty()) return
    synchronized(lock) {
      if (silenced || ended) return
      pending.append(text)
      if (pending.length >= MAX_CHARS) {
        flushLocked()
      } else if (flushing == null) {
        flushing = timers.schedule({ synchronized(lock) { flushLocked() } }, WINDOW_MS, TimeUnit.MILLISECONDS)
      }
    }
  }

  /** The stream is over: the text that waits is sent, then `end` (with `error: "reset"` when it was cut). */
  fun end(cut: Boolean) {
    synchronized(lock) {
      if (silenced || ended) return
      flushLocked()
      ended = true
      emit("end", if (cut) mapOf("request" to request, "error" to "reset") else mapOf("request" to request))
    }
  }

  /** `cancel`: no `chunk` and no `end` is sent from now on, and what waits is dropped. */
  fun silence() {
    synchronized(lock) {
      silenced = true
      pending.setLength(0)
      flushing?.cancel(false)
      flushing = null
    }
  }

  private fun flushLocked() {
    flushing?.cancel(false)
    flushing = null
    if (pending.isEmpty() || silenced) return
    val text = pending.toString()
    pending.setLength(0)
    emit("chunk", mapOf("request" to request, "text" to text))
  }

  companion object {
    /** 16 ms of text is one event. */
    const val WINDOW_MS = 16L

    /** 32 Ki characters are 64 KiB of memory: never more waits before it is sent. */
    const val MAX_CHARS = 32 * 1024
  }
}
