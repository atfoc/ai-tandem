package expo.modules.aiwbaudio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import expo.modules.interfaces.permissions.PermissionsResponseListener
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// The Android side of `aiwb-audio` (architecture VC-8): the microphone as 16 kHz mono s16le chunks (AudioRecord), the PCM player of the
// voice's replies (AudioTrack), the audio focus and the communication mode (VoiceAudio.kt), the devices (Devices.kt, voice-devices VD-18). The contract it implements is ../README.md;
// the TypeScript of it is ../src/AiwbAudio.ts, whose function and event names app/test/aiwbaudio.test.ts reads here.

/** The code of `startMic`'s rejection when the system gives the app no microphone (MIC_BLOCKED of the contract). */
internal const val MIC_BLOCKED = "ERR_AIWB_MIC_BLOCKED"

class AiwbAudioModule : Module() {
  private var made: VoiceAudio? = null

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("no React context")

  private val audio: VoiceAudio
    get() = made ?: VoiceAudio(context) { name, body -> emit(name, body) }.also { made = it }

  private fun emit(name: String, body: Map<String, Any?>) {
    try { sendEvent(name, body) } catch (_: Throwable) { /* the module is gone */ }
  }

  /** RECORD_AUDIO as the contract says it. Android may ask once more after a first refusal: that is "undetermined" here too, so that the
   *  app asks (`requestMic`) rather than send the person to the settings. */
  private fun permission(promise: Promise, ask: Boolean) {
    val permissions = appContext.permissions
    if (permissions == null) {
      promise.resolve("denied")
      return
    }
    val listener = PermissionsResponseListener { result ->
      val r = result[Manifest.permission.RECORD_AUDIO]
      promise.resolve(
        when {
          r == null -> "denied"
          r.status == PermissionsStatus.GRANTED -> "granted"
          r.status == PermissionsStatus.UNDETERMINED -> "undetermined"
          r.canAskAgain && !ask -> "undetermined"
          else -> "denied"
        }
      )
    }
    if (ask) permissions.askForPermissions(listener, Manifest.permission.RECORD_AUDIO)
    else permissions.getPermissions(listener, Manifest.permission.RECORD_AUDIO)
  }

  override fun definition() = ModuleDefinition {
    Name("AiwbAudio")

    Events("onMic", "onPlayer", "onInterrupted", "onDevices", "onRoute")

    AsyncFunction("micPermission") { promise: Promise -> permission(promise, ask = false) }

    AsyncFunction("requestMic") { promise: Promise -> permission(promise, ask = true) }

    // inputId: the input to prefer (voice-devices VD-18), null for the system's; one that has gone away gives the system's. The answer
    // names the device the record is routed to.
    AsyncFunction("startMic") { chunkMs: Double, echoCancel: Boolean, inputId: String?, promise: Promise ->
      audio.startMic(chunkMs.toInt(), echoCancel, inputId) { result ->
        when (result) {
          is MicResult.Started -> promise.resolve(mapOf("echoCancel" to result.echoCancel, "device" to result.device))
          is MicResult.Blocked -> promise.reject(MIC_BLOCKED, "the microphone is not allowed", null)
          is MicResult.Failed -> promise.reject("ERR_AIWB_MIC", result.why, null)
        }
      }
    }

    Function("setMicMuted") { muted: Boolean -> audio.setMicMuted(muted) }

    AsyncFunction("stopMic") { promise: Promise -> audio.stopMic { promise.resolve(null) } }

    Function("playerWrite") { pcm: ByteArray -> audio.write(pcm) }

    Function("playerMark") { id: Double -> audio.mark(id.toInt()) }

    Function("playerStop") { audio.stopPlayer() }

    AsyncFunction("playClip") { bytes: ByteArray, promise: Promise ->
      audio.playClip(bytes) { ok ->
        if (ok) promise.resolve(null) else promise.reject("ERR_AIWB_CLIP", "the clip could not be played", null)
      }
    }

    Function("stopClip") { audio.stopClip() }

    // The devices (voice-devices VD-18; Devices.kt). Listing asks for no permission and opens nothing.
    AsyncFunction("listDevices") { promise: Promise -> audio.listDevices { promise.resolve(it) } }

    // A constant of the OS version; it makes nothing.
    Function("deviceAbility") { deviceAbility() }

    // The app's words for the built-in microphone and speaker (the system names both after the phone); kept for the process.
    Function("setBuiltInNames") { names: Map<String, String> ->
      names["mic"]?.trim()?.takeIf { it.isNotEmpty() }?.let { BuiltInNames.mic = it }
      names["speaker"]?.trim()?.takeIf { it.isNotEmpty() }?.let { BuiltInNames.speaker = it }
      Unit
    }

    AsyncFunction("setOutput") { outputId: String?, promise: Promise ->
      audio.setOutput(outputId) { device -> promise.resolve(mapOf("device" to device)) }
    }

    Function("playerHold") { audio.hold() }

    Function("playerResume") { audio.resume() }

    // The app's page in the system settings (the microphone's switch is there).
    AsyncFunction("openSettings") { promise: Promise ->
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
      val activity = appContext.currentActivity
      if (activity != null) activity.startActivity(intent)
      else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      promise.resolve(null)
    }

    OnDestroy { made?.shutdown() }
  }
}
