package expo.modules.aiwbaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log

// The engine behind AiwbAudioModule (architecture VC-8). Its state changes on one thread of its own ("aiwb-audio", a looper), in the order
// the calls came; the microphone reads on its thread (MicCapture) and the player writes on its thread (PcmPlayer).
//
// **Listening** (from startMic until the microphone has stopped and the last of the reply has played): the audio focus is
// AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE, the microphone is VOICE_COMMUNICATION with the platform's echo canceller, the player's track has the
// usage USAGE_VOICE_COMMUNICATION (the canceller takes out what that stream plays) and, with echo cancellation asked for, the mode is
// MODE_IN_COMMUNICATION with the speaker as the device when no headset is there (that mode would use the earpiece). **Playback** (Read
// aloud with no microphone): the focus is AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK and the track's usage USAGE_ASSISTANT. A track's usage is fixed
// when it is made, so the microphone starting while Read aloud plays cuts it (the player says `drained`). When nothing runs any more the
// track is released, the mode and the device are put back and the focus is given up: at once after listening, after a short while after Read
// aloud (so the next sentence finds the track).

internal sealed class MicResult {
  class Started(val echoCancel: Boolean) : MicResult()
  object Blocked : MicResult()
  class Failed(val why: String) : MicResult()
}

internal class VoiceAudio(private val context: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  private val thread = HandlerThread("aiwb-audio").apply { start() }
  private val handler = Handler(thread.looper)
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val player = PcmPlayer(
    handler,
    onEvent = { body -> emit("onPlayer", body) },
    onDrained = { settle() },
  )

  private var mic: MicCapture? = null
  private var listening = false
  private var communication = false
  private var speakerSet = false
  private var focusGain = 0
  private var focusRequest: AudioFocusRequest? = null
  private var noisyRegistered = false
  private var idle: Runnable? = null
  private var clip: MediaPlayer? = null
  private var clipDone: ((Boolean) -> Unit)? = null

  private fun trace(s: String) {
    Log.d("aiwbaudio", s)
  }

  // ---- the microphone

  fun startMic(chunkMs: Int, echoCancel: Boolean, done: (MicResult) -> Unit) {
    handler.post {
      cancelIdle()
      if (context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        done(MicResult.Blocked)
        return@post
      }
      mic?.stop() // one microphone at a time: a new start replaces the old one
      mic = null
      if (!listening) {
        // The track (if any) was made for Read aloud: it is cut, and the next one is made for listening.
        if (player.stop()) emit("onPlayer", mapOf("kind" to "drained"))
        player.release()
        listening = true
      }
      player.usage = AudioAttributes.USAGE_VOICE_COMMUNICATION
      if (!takeFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)) {
        settle()
        done(MicResult.Failed("the audio is taken by another app or a call"))
        return@post
      }
      if (echoCancel) enterCommunication() else leaveCommunication()
      val started = try {
        MicCapture.start(chunkMs, echoCancel, onChunk = { pcm, level -> emit("onMic", mapOf("pcm" to pcm, "level" to level)) }, onFailed = {
          handler.post { interrupted("other") }
        })
      } catch (e: MicCapture.Failure) {
        settle()
        done(MicResult.Failed(e.why))
        return@post
      }
      mic = started
      registerNoisy()
      trace("mic on, echo cancel ${started.echoCancel}")
      done(MicResult.Started(started.echoCancel))
    }
  }

  fun setMicMuted(muted: Boolean) {
    handler.post { mic?.muted = muted }
  }

  fun stopMic(done: () -> Unit) {
    handler.post {
      mic?.stop()
      mic = null
      settle()
      done()
    }
  }

  // ---- the player

  fun write(pcm: ByteArray) {
    handler.post {
      cancelIdle()
      if (!listening) {
        player.usage = AudioAttributes.USAGE_ASSISTANT
        takeFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) // played even if refused: the person asked for it
      }
      registerNoisy()
      player.write(pcm)
    }
  }

  fun mark(id: Int) {
    handler.post { player.mark(id) }
  }

  fun stopPlayer() {
    handler.post {
      if (player.stop()) emit("onPlayer", mapOf("kind" to "level", "level" to 0.0))
      settle()
    }
  }

  // ---- the preview clip

  fun playClip(bytes: ByteArray, done: (Boolean) -> Unit) {
    handler.post {
      finishClip(true)
      cancelIdle()
      if (!listening) takeFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      val mp = MediaPlayer()
      try {
        mp.setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(if (listening) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        mp.setDataSource(BytesSource(bytes))
        mp.setOnPreparedListener { if (clip === it) it.start() }
        mp.setOnCompletionListener { if (clip === it) finishClip(true) }
        mp.setOnErrorListener { p, _, _ -> if (clip === p) finishClip(false); true }
        clip = mp
        clipDone = done
        mp.prepareAsync()
      } catch (e: Exception) {
        trace("clip: $e")
        mp.release()
        if (clip === mp) { clip = null; clipDone = null }
        settle()
        done(false)
      }
    }
  }

  fun stopClip() {
    handler.post { finishClip(true) }
  }

  /** Ends the clip (played, stopped, replaced or failed): its call resolves. */
  private fun finishClip(ok: Boolean) {
    val mp = clip ?: return
    clip = null
    try { mp.stop() } catch (_: IllegalStateException) { /* not started yet */ }
    mp.release()
    val done = clipDone
    clipDone = null
    done?.invoke(ok)
    settle()
  }

  // ---- focus, mode, route

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    handler.post {
      when (change) {
        AudioManager.AUDIOFOCUS_LOSS -> interrupted("other")
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> interrupted("call")
        else -> {} // a duck for another app's short sound is not an end
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun takeFocus(gain: Int): Boolean {
    if (focusGain == gain) return true
    dropFocus()
    val usage = if (gain == AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT
    val granted = if (Build.VERSION.SDK_INT >= 26) {
      val r = AudioFocusRequest.Builder(gain)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setOnAudioFocusChangeListener(focusListener, handler)
        .build()
      focusRequest = r
      audioManager.requestAudioFocus(r) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      val stream = if (usage == AudioAttributes.USAGE_VOICE_COMMUNICATION) AudioManager.STREAM_VOICE_CALL else AudioManager.STREAM_MUSIC
      audioManager.requestAudioFocus(focusListener, stream, gain) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
    focusGain = if (granted) gain else 0
    if (!granted) focusRequest = null
    return granted
  }

  @Suppress("DEPRECATION")
  private fun dropFocus() {
    if (focusGain == 0) return
    if (Build.VERSION.SDK_INT >= 26) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      audioManager.abandonAudioFocus(focusListener)
    }
    focusRequest = null
    focusGain = 0
  }

  private val headsets = setOf(
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_USB_HEADSET,
    26, // AudioDeviceInfo.TYPE_BLE_HEADSET (API 31)
  )

  /** The communication mode (the echo canceller works on it), on the speaker unless a headset is there. */
  @Suppress("DEPRECATION")
  private fun enterCommunication() {
    if (communication) return
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    communication = true
    if (Build.VERSION.SDK_INT >= 31) {
      val devices = audioManager.availableCommunicationDevices
      if (devices.none { it.type in headsets }) {
        devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { speakerSet = audioManager.setCommunicationDevice(it) }
      }
    } else if (audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).none { it.type in headsets }) {
      audioManager.isSpeakerphoneOn = true
      speakerSet = true
    }
  }

  @Suppress("DEPRECATION")
  private fun leaveCommunication() {
    if (!communication) return
    if (speakerSet) {
      if (Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice() else audioManager.isSpeakerphoneOn = false
    }
    speakerSet = false
    audioManager.mode = AudioManager.MODE_NORMAL
    communication = false
  }

  /** Headphones taken off: what was private would go to the speaker. */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) handler.post { interrupted("route") }
    }
  }

  private fun registerNoisy() {
    if (noisyRegistered) return
    val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(noisy, filter, null, handler, Context.RECEIVER_NOT_EXPORTED)
    else context.registerReceiver(noisy, filter, null, handler)
    noisyRegistered = true
  }

  private fun unregisterNoisy() {
    if (!noisyRegistered) return
    try { context.unregisterReceiver(noisy) } catch (_: IllegalArgumentException) { /* not registered */ }
    noisyRegistered = false
  }

  // ---- the end

  private fun cancelIdle() {
    idle?.let { handler.removeCallbacks(it) }
    idle = null
  }

  /** Nothing more is asked of the device: what was taken is given back when nothing needs it. */
  private fun settle() {
    if (mic != null || player.busy || clip != null) return
    if (listening) {
      // The microphone has stopped and the last of the reply has played: the mode and the focus are given back now.
      player.release()
      listening = false
      leaveCommunication()
      dropFocus()
      unregisterNoisy()
      trace("listening ended")
      return
    }
    cancelIdle()
    val work = Runnable {
      idle = null
      if (mic == null && !player.busy && clip == null && !listening) {
        player.release()
        dropFocus()
        unregisterNoisy()
      }
    }
    idle = work
    handler.postDelayed(work, 1500)
  }

  /** The system took the audio (a call, another app), the headphones were taken off, or the microphone died: everything stops and JS is
   *  told once. */
  private fun interrupted(reason: String) {
    if (mic == null && !player.busy && clip == null && !listening) return
    trace("interrupted: $reason")
    stopAll()
    emit("onInterrupted", mapOf("reason" to reason))
  }

  private fun stopAll() {
    cancelIdle()
    mic?.stop()
    mic = null
    player.stop()
    player.release()
    finishClip(true)
    listening = false
    leaveCommunication()
    dropFocus()
    unregisterNoisy()
  }

  /** The module is going away (a reload of the JS): everything stops, nobody is told. */
  fun shutdown() {
    handler.post {
      stopAll()
      player.close()
      thread.quitSafely()
    }
  }
}

/** The bytes of a preview clip, as MediaPlayer reads them. */
private class BytesSource(private val bytes: ByteArray) : MediaDataSource() {
  override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
    if (position >= bytes.size) return -1
    val n = minOf(size.toLong(), bytes.size - position).toInt()
    System.arraycopy(bytes, position.toInt(), buffer, offset, n)
    return n
  }

  override fun getSize(): Long = bytes.size.toLong()

  override fun close() {}
}
