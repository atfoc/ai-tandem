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
// voice's replies (AudioTrack), the audio focus and the communication mode (VoiceAudio.kt). The contract it implements is ../README.md;
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

    Events("onMic", "onPlayer", "onInterrupted")

    AsyncFunction("micPermission") { promise: Promise -> permission(promise, ask = false) }

    AsyncFunction("requestMic") { promise: Promise -> permission(promise, ask = true) }

    AsyncFunction("startMic") { chunkMs: Double, echoCancel: Boolean, promise: Promise ->
      audio.startMic(chunkMs.toInt(), echoCancel) { result ->
        when (result) {
          is MicResult.Started -> promise.resolve(mapOf("echoCancel" to result.echoCancel))
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
