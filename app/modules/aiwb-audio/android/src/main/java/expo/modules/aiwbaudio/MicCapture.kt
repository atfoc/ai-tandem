package expo.modules.aiwbaudio

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Handler
import android.util.Base64
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

// The microphone (architecture VC-8): AudioRecord at 16 kHz mono PCM 16 from the VOICE_COMMUNICATION source, with the platform's echo
// canceller and noise suppressor when asked for and the device has them. A thread of its own reads exactly one chunk at a time and gives
// it as base64 of its little-endian bytes, with its RMS level 0..1. Nothing is given while muted, and what was read then is dropped.
// A chosen input (voice-devices VD-18) is the record's preferred device (`setPreferredDevice`, before it starts); null keeps the system's
// routing. The device it is routed to is told on the engine's thread whenever it changes (`onRouted`), and is read with `routedDevice()`.
internal class MicCapture private constructor(
  private val record: AudioRecord,
  /** What it was started with, so that a new one can be made the same way on another device. */
  val chunkMs: Int,
  val echoAsked: Boolean,
  private val chunkFrames: Int,
  private val canceller: AcousticEchoCanceler?,
  private val suppressor: NoiseSuppressor?,
  private val onChunk: (String, Double) -> Unit,
  private val onFailed: () -> Unit,
) {
  class Failure(val why: String) : Exception(why)

  /** Whether the echo of what the device plays is taken out of what it hears (the answer of startMic). */
  val echoCancel: Boolean get() = canceller?.enabled == true

  @Volatile var muted = false
  @Volatile private var running = true
  private val reader = Thread({ read() }, "aiwb-audio-mic")

  private fun read() {
    val samples = ShortArray(chunkFrames)
    val bytes = ByteBuffer.allocate(chunkFrames * 2).order(ByteOrder.LITTLE_ENDIAN)
    while (running) {
      var got = 0
      while (got < chunkFrames && running) {
        val n = record.read(samples, got, chunkFrames - got)
        if (n < 0) {
          // The audio server died or the recorder was taken away: the session ends (not when this side stopped it).
          if (running) onFailed()
          return
        }
        got += n
      }
      if (!running) return
      if (muted) continue
      var sum = 0.0
      bytes.clear()
      for (s in samples) {
        sum += s.toDouble() * s
        bytes.putShort(s)
      }
      val level = minOf(1.0, sqrt(sum / chunkFrames) / 32768.0)
      onChunk(Base64.encodeToString(bytes.array(), Base64.NO_WRAP), level)
    }
  }

  /** The device the record is routed to now (null when the system does not say, e.g. not recording). */
  fun routedDevice(): AudioDeviceInfo? = try { record.routedDevice } catch (_: IllegalStateException) { null }

  /** Gives the routing back to the system (the preferred device has gone). */
  fun preferDefault() {
    try { record.setPreferredDevice(null) } catch (_: IllegalStateException) { /* released */ }
  }

  private var routing: AudioRouting.OnRoutingChangedListener? = null

  fun stop() {
    if (!running) return
    running = false
    routing?.let { record.removeOnRoutingChangedListener(it) }
    routing = null
    try { record.stop() } catch (_: IllegalStateException) { /* never started */ }
    reader.join(1000)
    canceller?.release()
    suppressor?.release()
    record.release()
  }

  companion object {
    private const val RATE = 16000

    /** Starts the microphone; the caller has checked RECORD_AUDIO. Throws Failure when the device cannot give it. `preferred`: the input
     *  to route to (null: the system's). `onRouted` is called on `handler` when the record's device changes. */
    @SuppressLint("MissingPermission")
    fun start(
      chunkMs: Int,
      echoCancel: Boolean,
      preferred: AudioDeviceInfo?,
      handler: Handler,
      onChunk: (String, Double) -> Unit,
      onFailed: (MicCapture) -> Unit,
      onRouted: (MicCapture, AudioDeviceInfo?) -> Unit,
    ): MicCapture {
      val chunkFrames = maxOf(160, RATE * chunkMs / 1000)
      val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (min <= 0) throw Failure("the device cannot record 16 kHz mono")
      val record = try {
        AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, chunkFrames * 2) * 2)
      } catch (e: Exception) {
        throw Failure("the microphone could not be opened")
      }
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        throw Failure("the microphone could not be opened")
      }
      // Before startRecording: the record is opened on that device when it starts (an id that has gone away gives the system's routing).
      if (preferred != null) record.setPreferredDevice(preferred)
      var canceller: AcousticEchoCanceler? = null
      var suppressor: NoiseSuppressor? = null
      if (echoCancel) {
        if (AcousticEchoCanceler.isAvailable()) canceller = AcousticEchoCanceler.create(record.audioSessionId)?.also { it.enabled = true }
        if (NoiseSuppressor.isAvailable()) suppressor = NoiseSuppressor.create(record.audioSessionId)?.also { it.enabled = true }
      }
      try {
        record.startRecording()
      } catch (e: IllegalStateException) {
        canceller?.release(); suppressor?.release(); record.release()
        throw Failure("the microphone could not be started")
      }
      if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
        canceller?.release(); suppressor?.release(); record.release()
        throw Failure("the microphone is in use")
      }
      lateinit var capture: MicCapture
      capture = MicCapture(record, chunkMs, echoCancel, chunkFrames, canceller, suppressor, onChunk) { onFailed(capture) }
      val routing = AudioRouting.OnRoutingChangedListener { r -> onRouted(capture, r.routedDevice) }
      record.addOnRoutingChangedListener(routing, handler)
      capture.routing = routing
      capture.reader.start()
      return capture
    }
  }
}
