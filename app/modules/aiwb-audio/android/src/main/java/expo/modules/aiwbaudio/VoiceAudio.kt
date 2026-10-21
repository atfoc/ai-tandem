package expo.modules.aiwbaudio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
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
//
// **Devices** (voice-devices VD-9, VD-10, VD-11, VD-18; ids and names in Devices.kt). The chosen input is the record's preferred device.
// The chosen output (Android 12+) is, in communication mode, the communication device (the platform takes the matching microphone with
// it), and for plain playback the track's (and the clip's) preferred device. In communication mode a chosen headset is used for both: the
// communication device is the chosen output, else the chosen input's own headset, else today's rule (the speaker unless a headset is
// there). A chosen Bluetooth microphone needs the headset's call link even for dictation: the communication device on Android 12+,
// `startBluetoothSco` before. Everything set is cleared when listening ends. A device that goes away while in use: the output is held
// (the track paused, nothing comes out of the loudspeaker) when it was private or unknown and what the sound moves to is not private,
// `ACTION_AUDIO_BECOMING_NOISY` counting as a private loss; the input is reopened on the system's routing (`input-failed` when it cannot
// be). JS is told with `onRoute`; `onInterrupted` keeps calls ("call") and the rest ("other"): "route" is no longer sent for a lost device.

internal sealed class MicResult {
  class Started(val echoCancel: Boolean, val device: Map<String, Any?>?) : MicResult()
  object Blocked : MicResult()
  class Failed(val why: String) : MicResult()
}

internal class VoiceAudio(private val context: Context, private val emit: (String, Map<String, Any?>) -> Unit) {
  private val thread = HandlerThread("aiwb-audio").apply { start() }
  private val handler = Handler(thread.looper)
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val devices = Devices(audioManager)

  private val player = PcmPlayer(
    handler,
    onEvent = { body -> emit("onPlayer", body) },
    onDrained = { settle() },
    onRouted = { d -> outputRouted(d) },
  )

  private var mic: MicCapture? = null
  private var listening = false
  private var communication = false
  private var focusGain = 0
  private var focusRequest: AudioFocusRequest? = null
  private var noisyRegistered = false
  private var idle: Runnable? = null
  private var clip: MediaPlayer? = null
  private var clipDone: ((Boolean) -> Unit)? = null

  // The devices. The chosen ones are found once, when asked for (a device that comes back later is not switched to).
  private var chosenInput: AudioDeviceInfo? = null
  private var chosenOutputId: String? = null
  private var playbackDevice: AudioDeviceInfo? = null
  /** The communication device this module set (Android 12+), or the speakerphone / SCO it turned on (before). Cleared when listening ends. */
  private var commDevice: AudioDeviceInfo? = null
  private var speakerphoneSet = false
  private var scoStarted = false
  /** What the microphone listens to and what the sound goes to, as last known: a loss is a device in use that is no longer there. */
  private var micDevice: Dev? = null
  private var outputDevice: Dev? = null
  private var lastOutputLoss = 0L

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
      emit("onDevices", emptyMap())
    }

    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
      emit("onDevices", emptyMap())
      devicesRemoved(removedDevices?.toList().orEmpty())
    }
  }

  init {
    // Told of what is plugged and unplugged; it lists nothing by itself, asks for nothing and opens nothing.
    audioManager.registerAudioDeviceCallback(deviceCallback, handler)
  }

  private fun trace(s: String) {
    Log.d("aiwbaudio", s) // never a device's name (goal 4.7)
  }

  // ---- the devices

  fun listDevices(done: (Map<String, Any?>) -> Unit) {
    handler.post {
      val list = devices.inputs().map { devices.dev(it).toMap() } + devices.outputs().map { devices.dev(it).toMap() }
      done(
        mapOf(
          "devices" to list,
          "defaultInput" to devices.defaultInput(commDevice)?.let { devices.idOf(it) },
          "defaultOutput" to devices.defaultOutput(if (communication) commDevice else null, null)?.let { devices.idOf(it) },
        )
      )
    }
  }

  /** Where the player (and the clip) plays from now on. Before Android 12 the output follows the system: nothing changes. */
  fun setOutput(outputId: String?, done: (Map<String, Any?>?) -> Unit) {
    handler.post {
      if (Build.VERSION.SDK_INT >= 31) {
        chosenOutputId = outputId?.takeIf { devices.findCommOutput(it) != null }
        playbackDevice = devices.findPlaybackOutput(chosenOutputId)
        if (!communication) {
          player.prefer(playbackDevice)
          clip?.setPreferredDevice(playbackDevice)
        }
        if (listening) applyRoute(null)
      }
      // A chosen output that is connected is what is answered, also when a chosen headset microphone takes the communication device (the
      // linked rule, which Settings says); otherwise where the sound goes.
      val got = devices.findCommOutput(chosenOutputId)
        ?: (if (communication) commDevice else null)
        ?: devices.defaultOutput(null, null)
      outputDevice = got?.let { devices.dev(it) }
      done(outputDevice?.toMap())
    }
  }

  // ---- the microphone

  fun startMic(chunkMs: Int, echoCancel: Boolean, inputId: String?, done: (MicResult) -> Unit) {
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
      chosenInput = devices.findInput(inputId) // gone, or none asked: the system's routing
      if (echoCancel) enterCommunication() else leaveCommunication()
      applyRoute(null)
      player.prefer(if (communication) null else playbackDevice)
      val started = try {
        openMic(chunkMs, echoCancel, chosenInput)
      } catch (e: MicCapture.Failure) {
        settle()
        done(MicResult.Failed(e.why))
        return@post
      }
      mic = started
      micDevice = (started.routedDevice() ?: chosenInput ?: devices.defaultInput(commDevice))?.let { devices.dev(it) }
      if (outputDevice == null) outputDevice = currentOutput(null)?.let { devices.dev(it) }
      registerNoisy()
      trace("mic on, echo cancel ${started.echoCancel}, chosen ${chosenInput != null}")
      done(MicResult.Started(started.echoCancel, micDevice?.toMap()))
    }
  }

  private fun openMic(chunkMs: Int, echoCancel: Boolean, preferred: AudioDeviceInfo?): MicCapture =
    MicCapture.start(
      chunkMs, echoCancel, preferred, handler,
      onChunk = { pcm, level -> emit("onMic", mapOf("pcm" to pcm, "level" to level)) },
      onFailed = { cap -> handler.post { micFailed(cap) } },
      onRouted = { cap, d -> micRouted(cap, d) },
    )

  fun setMicMuted(muted: Boolean) {
    handler.post { mic?.muted = muted }
  }

  fun stopMic(done: () -> Unit) {
    handler.post {
      mic?.stop()
      mic = null
      micDevice = null
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
        player.prefer(playbackDevice)
        takeFocus(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK) // played even if refused: the person asked for it
      }
      if (outputDevice == null) outputDevice = currentOutput(null)?.let { devices.dev(it) }
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

  fun hold() {
    handler.post { player.hold() }
  }

  fun resume() {
    handler.post { player.resume() }
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
        if (!communication && playbackDevice != null && Build.VERSION.SDK_INT >= 28) mp.setPreferredDevice(playbackDevice)
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

  /** The communication mode (the echo canceller works on it); its device is applyRoute's. */
  private fun enterCommunication() {
    if (communication) return
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    communication = true
  }

  private fun leaveCommunication() {
    if (!communication) return
    clearRoute()
    audioManager.mode = AudioManager.MODE_NORMAL
    communication = false
  }

  /** The communication device to set in communication mode (Android 12+), null for the platform's own (a connected headset). A headset
   *  is used for both: the chosen output when it is a headset or no headset microphone is chosen, else the chosen microphone's headset
   *  (a Bluetooth one gives sound only on its own call link), else the speaker unless a headset is there. `excluding`: going away. */
  private fun commTarget(excluding: String?): AudioDeviceInfo? {
    val input = chosenInput?.takeIf { devices.idOf(it) != excluding }
    val headsetIn = input?.let { i -> devices.findCommOutput(devices.idOf(i)) }?.takeIf { it.type in Devices.HEADSETS }
    val out = devices.findCommOutput(chosenOutputId)?.takeIf { devices.idOf(it) != excluding }
    return when {
      out != null && (out.type in Devices.HEADSETS || headsetIn == null) -> out
      headsetIn != null -> headsetIn
      devices.hasHeadset(excluding) -> null
      else -> devices.builtInSpeaker()
    }
  }

  /** Where communication goes now (see the head of the file). `excluding`: a device that is going away. */
  @Suppress("DEPRECATION")
  private fun applyRoute(excluding: String?) {
    val input = chosenInput?.takeIf { devices.idOf(it) != excluding }
    val bluetoothInput = input != null && input.type in BLUETOOTH_INPUTS
    if (Build.VERSION.SDK_INT >= 31) {
      val target: AudioDeviceInfo? = when {
        communication -> commTarget(excluding)
        bluetoothInput -> devices.findCommOutput(devices.idOf(input!!))
        else -> null
      }
      if (target != null && (commDevice?.id != target.id) && audioManager.setCommunicationDevice(target)) {
        commDevice = target
      } else if (target == null && commDevice != null) {
        audioManager.clearCommunicationDevice()
        commDevice = null
      }
    } else {
      val speaker = communication && !devices.hasHeadset(excluding)
      if (speaker != speakerphoneSet) {
        audioManager.isSpeakerphoneOn = speaker
        speakerphoneSet = speaker
      }
      if (bluetoothInput && !scoStarted) {
        try {
          audioManager.startBluetoothSco()
          audioManager.isBluetoothScoOn = true
          scoStarted = true
        } catch (e: RuntimeException) {
          trace("sco: $e") // no call link: the record falls back to the system's routing
        }
      } else if (!bluetoothInput && scoStarted) {
        stopSco()
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun stopSco() {
    try {
      audioManager.isBluetoothScoOn = false
      audioManager.stopBluetoothSco()
    } catch (_: RuntimeException) { /* the link is gone already */ }
    scoStarted = false
  }

  /** Every device this module set is given back. */
  @Suppress("DEPRECATION")
  private fun clearRoute() {
    if (commDevice != null && Build.VERSION.SDK_INT >= 31) audioManager.clearCommunicationDevice()
    commDevice = null
    if (speakerphoneSet) audioManager.isSpeakerphoneOn = false
    speakerphoneSet = false
    if (scoStarted) stopSco()
  }

  /** The output sound goes to now, as well as the module can tell. */
  private fun currentOutput(excluding: String?): AudioDeviceInfo? =
    player.routedDevice()?.takeIf { devices.idOf(it) != excluding }
      ?: (if (communication) commDevice else playbackDevice)?.takeIf { devices.idOf(it) != excluding }
      ?: devices.defaultOutput(if (communication) commDevice else null, excluding)

  /** Headphones taken off: what was private would go to the speaker (the platform says it before it moves the sound). */
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, intent: Intent?) {
      if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) handler.post { becameNoisy() }
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

  // ---- devices that go away (VD-9, VD-10, VD-11)

  private fun outputInUse() = listening || player.busy || player.hasTrack || clip != null

  private fun becameNoisy() {
    if (!outputInUse()) return
    // The loss already handled from the device list or the track's routing, or a device that was not ours (sound on the loudspeaker).
    if (SystemClock.elapsedRealtime() - lastOutputLoss < 2000) return
    val lost = outputDevice
    if (lost != null && lost.privacy == "public") return
    outputLost(lost, noisy = true, observed = null)
  }

  private fun devicesRemoved(removed: List<AudioDeviceInfo>) {
    val out = outputDevice
    if (out != null && outputInUse() && removed.any { it.isSink && devices.idOf(it) == out.id } && !devices.present(out.id, input = false)) {
      outputLost(out, noisy = false, observed = null)
    }
    val m = mic
    val md = micDevice
    if (m != null && md != null && removed.any { it.isSource && devices.idOf(it) == md.id } && !devices.present(md.id, input = true)) {
      inputLost(m, md)
    }
  }

  /** The track moved: to a device plugged in (the system's routing follows it), or away from one that is gone (a loss seen late). */
  private fun outputRouted(d: AudioDeviceInfo?) {
    val now = d?.let { devices.dev(it) } ?: return
    val prev = outputDevice
    if (prev != null && prev.id != now.id && !devices.present(prev.id, input = false) && outputInUse()) outputLost(prev, noisy = false, observed = d)
    else outputDevice = now
  }

  /** The output in use went away. Held when it was private (or not known) and the sound would move to something not private: the track
   *  is paused before anything else, so nothing of it comes out of the loudspeaker. Then the route is moved, and JS is told. */
  private fun outputLost(lost: Dev?, noisy: Boolean, observed: AudioDeviceInfo?) {
    lastOutputLoss = SystemClock.elapsedRealtime()
    val lostId = lost?.id
    val lostPrivacy = if (noisy) "private" else lost?.privacy ?: "unknown"
    // Where the sound goes: in communication mode what applyRoute will set (the speaker unless another headset is there), else the
    // system's routing without the lost device.
    val next: AudioDeviceInfo? = observed ?: if (communication) {
      (if (Build.VERSION.SDK_INT >= 31) commTarget(lostId) else null) ?: devices.commHeadset(lostId) ?: devices.builtInSpeaker()
    } else {
      devices.defaultOutput(null, lostId)
    }
    val now = next?.let { devices.dev(it) }
    val held = lostPrivacy != "public" && now?.privacy != "private"
    if (held) {
      player.hold()
      finishClip(true) // a preview is short: it stops rather than wait
    }
    if (chosenOutputId != null && chosenOutputId == lostId) {
      chosenOutputId = null
      playbackDevice = null
    }
    if (communication || commDevice != null || speakerphoneSet) {
      if (commDevice != null && devices.idOf(commDevice!!) == lostId) commDevice = null // the platform drops it on disconnect
      applyRoute(lostId)
    } else {
      player.prefer(playbackDevice)
    }
    outputDevice = now
    trace("output lost, held $held")
    emit("onRoute", mapOf("kind" to "output-lost", "lost" to lost?.toMap(), "now" to now?.toMap(), "held" to held))
  }

  private fun micRouted(cap: MicCapture, d: AudioDeviceInfo?) {
    if (cap !== mic) return
    val now = d?.let { devices.dev(it) } ?: return
    val prev = micDevice
    if (prev != null && prev.id != now.id && !devices.present(prev.id, input = true)) {
      // The system has moved the record to its own routing already: it goes on there.
      cap.preferDefault()
      chosenInput = null
      micDevice = now
      trace("input lost, rerouted")
      emit("onRoute", mapOf("kind" to "input-lost", "lost" to prev.toMap(), "now" to now.toMap(), "held" to false))
    } else {
      micDevice = now
    }
  }

  /** The record failed: a lost device (made again on the default), or the audio server (the end, as before). */
  private fun micFailed(cap: MicCapture) {
    if (cap !== mic) return
    val md = micDevice
    if (md != null && !devices.present(md.id, input = true)) inputLost(cap, md) else interrupted("other")
  }

  /** The input in use went away: listening goes on from the system's routing, into the same onMic. If it cannot, the microphone stops
   *  and JS is told `input-failed` (the session ends as with a microphone that does not start). */
  private fun inputLost(old: MicCapture, lost: Dev) {
    val muted = old.muted
    old.stop()
    mic = null
    chosenInput = null
    applyRoute(lost.id)
    val again = try {
      openMic(old.chunkMs, old.echoAsked, null)
    } catch (e: MicCapture.Failure) {
      null
    }
    if (again == null) {
      micDevice = null
      trace("input lost, not reopened")
      emit("onRoute", mapOf("kind" to "input-failed", "lost" to lost.toMap(), "now" to null, "held" to false))
      settle()
      return
    }
    again.muted = muted
    mic = again
    micDevice = (again.routedDevice() ?: devices.defaultInput(commDevice))?.let { devices.dev(it) }
    trace("input lost, reopened")
    emit("onRoute", mapOf("kind" to "input-lost", "lost" to lost.toMap(), "now" to micDevice?.toMap(), "held" to false))
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
      // The microphone has stopped and the last of the reply has played: the mode, the devices and the focus are given back now. A hold
      // with nothing queued (a loss while only listening) ends with the listening.
      player.clearHold()
      player.release()
      listening = false
      leaveCommunication()
      clearRoute()
      chosenInput = null
      micDevice = null
      outputDevice = null
      dropFocus()
      unregisterNoisy()
      trace("listening ended")
      return
    }
    cancelIdle()
    val work = Runnable {
      idle = null
      if (mic == null && !player.busy && clip == null && !listening) {
        player.clearHold()
        player.release()
        outputDevice = null
        dropFocus()
        unregisterNoisy()
      }
    }
    idle = work
    handler.postDelayed(work, 1500)
  }

  /** The system took the audio (a call, another app) or the microphone died: everything stops and JS is told once. */
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
    clearRoute()
    chosenInput = null
    micDevice = null
    outputDevice = null
    dropFocus()
    unregisterNoisy()
  }

  /** The module is going away (a reload of the JS): everything stops, nobody is told. */
  fun shutdown() {
    handler.post {
      stopAll()
      audioManager.unregisterAudioDeviceCallback(deviceCallback)
      player.close()
      thread.quitSafely()
    }
  }

  private companion object {
    /** Inputs that give sound only over the headset's call link (SCO, or LE audio's). */
    val BLUETOOTH_INPUTS = setOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO, Devices.TYPE_BLE_HEADSET)
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
