package expo.modules.aiwbaudio

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

// The devices of voice (voice-devices VD-4, VD-5, VD-11, VD-18): what the module lists, the ids it makes, the names and the privacy it
// answers, and what the system uses when nothing is chosen. Android has no lasting id for a device (`getId()` is a port handle), so the
// module makes one: `<family>:<address>`, or `<family>:<name>` when the address is empty. A Bluetooth headset's SCO and A2DP entries share
// one id, and the built-in microphones (a phone may report two or three, "bottom", "back") are one entry per kind, `builtin:mic` and
// `builtin:speaker`, named with the words the app gives (`setBuiltInNames`), since the system names them after the phone's model.

/** A device as the contract's NativeDevice. */
internal data class Dev(val id: String, val name: String, val kind: String, val privacy: String, val builtIn: Boolean) {
  fun toMap(): Map<String, Any?> = mapOf("id" to id, "name" to name, "kind" to kind, "privacy" to privacy, "builtIn" to builtIn)
}

/** The names of the built-in devices (the app's words, `setBuiltInNames`); kept for the process, so setting them starts nothing. */
internal object BuiltInNames {
  @Volatile var mic = "Phone microphone"
  @Volatile var speaker = "Phone speaker"
}

/** What voice can choose on this version (platforms.md §4): the input always; the output from Android 12, where the communication device
 *  can be set, and there a headset chosen for one is used for both while voice talks to a chat. */
internal fun deviceAbility(): Map<String, Any> =
  if (Build.VERSION.SDK_INT >= 31) mapOf("input" to "pick", "output" to "pick", "linked" to true)
  else mapOf("input" to "pick", "output" to "system", "linked" to false)

internal class Devices(private val audioManager: AudioManager) {

  /** The family of a type, the first part of the id; null for what is never listed (telephony, remote submix, FM, bus, echo reference). */
  private fun family(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_MIC, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE, TYPE_BUILTIN_SPEAKER_SAFE -> "builtin"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_LINE_ANALOG -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bt"
    TYPE_BLE_HEADSET, TYPE_BLE_SPEAKER, TYPE_BLE_BROADCAST -> "ble"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, TYPE_HDMI_EARC -> "hdmi"
    AudioDeviceInfo.TYPE_HEARING_AID -> "hearing"
    AudioDeviceInfo.TYPE_TELEPHONY, AudioDeviceInfo.TYPE_FM, AudioDeviceInfo.TYPE_FM_TUNER, AudioDeviceInfo.TYPE_TV_TUNER,
    AudioDeviceInfo.TYPE_BUS, TYPE_REMOTE_SUBMIX, TYPE_ECHO_REFERENCE -> null
    else -> "other"
  }

  /** Whether `d` is one voice lists at all. */
  private fun listed(d: AudioDeviceInfo) = family(d.type) != null

  /** The name the system gives: the port's name, or the phone's model when the port has none (AudioDeviceInfo.getProductName). */
  private fun portName(d: AudioDeviceInfo): String = d.productName?.toString()?.trim().orEmpty()

  fun idOf(d: AudioDeviceInfo): String {
    val f = family(d.type) ?: "other"
    if (f == "builtin") {
      return when (d.type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin:mic"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "builtin:earpiece"
        else -> "builtin:speaker"
      }
    }
    val address = d.address.trim()
    return "$f:" + address.ifEmpty { portName(d) }
  }

  /** VD-11 by type (platforms.md §4): headphones and headsets are private, a loudspeaker is public, a USB device or a line is unknown. */
  fun privacyOf(d: AudioDeviceInfo): String = when (d.type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_HEARING_AID, AudioDeviceInfo.TYPE_USB_HEADSET,
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "private"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, TYPE_BUILTIN_SPEAKER_SAFE, AudioDeviceInfo.TYPE_BUILTIN_MIC, AudioDeviceInfo.TYPE_HDMI,
    AudioDeviceInfo.TYPE_HDMI_ARC, TYPE_HDMI_EARC, TYPE_BLE_SPEAKER, TYPE_BLE_BROADCAST, AudioDeviceInfo.TYPE_DOCK, TYPE_DOCK_ANALOG -> "public"
    else -> "unknown"
  }

  /** VD-5: the system's name, but the app's words for the built-ins, and the kind of device for one whose port has no name of its own
   *  (the system would answer the phone's model for a wired headset too). */
  fun nameOf(d: AudioDeviceInfo): String {
    when (d.type) {
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> return BuiltInNames.mic
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, TYPE_BUILTIN_SPEAKER_SAFE, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> return BuiltInNames.speaker
    }
    val name = portName(d)
    if (name.isNotEmpty() && name != Build.MODEL) return name
    return when (d.type) {
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired headset"
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headphones"
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP, TYPE_BLE_HEADSET -> "Bluetooth headset"
      TYPE_BLE_SPEAKER, TYPE_BLE_BROADCAST -> "Bluetooth speaker"
      AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY, AudioDeviceInfo.TYPE_USB_HEADSET -> "USB audio"
      AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, TYPE_HDMI_EARC -> "HDMI"
      AudioDeviceInfo.TYPE_HEARING_AID -> "Hearing aid"
      else -> name.ifEmpty { "Audio device" }
    }
  }

  fun dev(d: AudioDeviceInfo): Dev =
    Dev(idOf(d), nameOf(d), if (d.isSink) "output" else "input", privacyOf(d), family(d.type) == "builtin")

  /** One entry per id, in the system's order (the first of a group stands for it). */
  private fun grouped(all: List<AudioDeviceInfo>): List<AudioDeviceInfo> {
    val seen = HashSet<String>()
    return all.filter { listed(it) && seen.add(idOf(it)) }
  }

  /** Every input voice can listen to. */
  fun inputs(): List<AudioDeviceInfo> = grouped(audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).toList())

  /** The outputs voice can choose (Android 12+): the communication devices without the earpiece, since speech mode can be routed only
   *  to those. Empty before Android 12, where the output follows the system. */
  fun outputs(): List<AudioDeviceInfo> {
    if (Build.VERSION.SDK_INT < 31) return emptyList()
    return grouped(audioManager.availableCommunicationDevices.filter { it.type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE })
  }

  fun findInput(id: String?): AudioDeviceInfo? = id?.let { want -> inputs().firstOrNull { idOf(it) == want } }

  /** The communication device of an output id (the SCO entry of a Bluetooth headset). */
  fun findCommOutput(id: String?): AudioDeviceInfo? = id?.let { want -> outputs().firstOrNull { idOf(it) == want } }

  /** The entry of an output id that plain playback uses: of a Bluetooth headset the A2DP (or LE) one, not the SCO one of calls. */
  fun findPlaybackOutput(id: String?): AudioDeviceInfo? {
    val want = id ?: return null
    val all = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { listed(it) && idOf(it) == want }
    return all.firstOrNull { it.type != AudioDeviceInfo.TYPE_BLUETOOTH_SCO } ?: all.firstOrNull()
  }

  /** Whether a device with this id and kind is connected now. */
  fun present(id: String, input: Boolean): Boolean =
    audioManager.getDevices(if (input) AudioManager.GET_DEVICES_INPUTS else AudioManager.GET_DEVICES_OUTPUTS).any { listed(it) && idOf(it) == id }

  /** The headset among the communication devices (the system routes a call there by itself when one is connected), apart from `excluding`. */
  fun commHeadset(excluding: String?): AudioDeviceInfo? {
    if (Build.VERSION.SDK_INT < 31) return null
    return audioManager.availableCommunicationDevices.firstOrNull { it.type in HEADSETS && idOf(it) != excluding }
  }

  fun hasHeadset(excluding: String?): Boolean =
    if (Build.VERSION.SDK_INT >= 31) commHeadset(excluding) != null
    else audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in HEADSETS && idOf(it) != excluding }

  fun builtInSpeaker(): AudioDeviceInfo? =
    if (Build.VERSION.SDK_INT >= 31) audioManager.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
    else audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }

  /** What the voice-communication source listens to when no input is chosen: the system's order (the headset that routes the call, a wired
   *  or USB headset's microphone, the phone's). Android has no call that answers it, so this is that order, read from what is connected. */
  @Suppress("DEPRECATION")
  fun defaultInput(commDevice: AudioDeviceInfo?): AudioDeviceInfo? {
    val ins = inputs()
    commDevice?.takeIf { it.type in HEADSETS }?.let { c -> ins.firstOrNull { idOf(it) == idOf(c) }?.let { return it } }
    for (type in INPUT_ORDER) {
      if (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO && !audioManager.isBluetoothScoOn) continue
      ins.firstOrNull { it.type == type }?.let { return it }
    }
    return ins.firstOrNull()
  }

  /** Where sound goes when no output is chosen: in communication mode the communication device, otherwise where the system routes speech
   *  (Android 13+ answers it; before, the system's order of what is connected). `excluding`: a device that is going away. */
  fun defaultOutput(commDevice: AudioDeviceInfo?, excluding: String?): AudioDeviceInfo? {
    commDevice?.takeIf { idOf(it) != excluding && it.type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }?.let { return it }
    val outs = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).filter { listed(it) && idOf(it) != excluding }
    if (Build.VERSION.SDK_INT >= 33 && excluding == null) {
      val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      audioManager.getAudioDevicesForAttributes(attrs).firstOrNull()?.let { routed -> outs.firstOrNull { it.id == routed.id }?.let { return it } }
    }
    for (type in OUTPUT_ORDER) outs.firstOrNull { it.type == type }?.let { return it }
    return outs.firstOrNull()
  }

  companion object {
    // Types newer than API 24 (the minimum), by value, so that the module builds for every level.
    const val TYPE_BUILTIN_SPEAKER_SAFE = 24  // API 30
    const val TYPE_REMOTE_SUBMIX = 25         // API 23 as a constant, never listed
    const val TYPE_BLE_HEADSET = 26           // API 31
    const val TYPE_BLE_SPEAKER = 27           // API 31
    const val TYPE_ECHO_REFERENCE = 28        // API 31, never listed
    const val TYPE_HDMI_EARC = 29             // API 31
    const val TYPE_BLE_BROADCAST = 30         // API 33
    const val TYPE_DOCK_ANALOG = 31           // API 34

    /** The devices that carry a call by themselves: with one connected, communication mode does not need the speaker. */
    val HEADSETS = setOf(
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      TYPE_BLE_HEADSET,
    )

    private val INPUT_ORDER = listOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_BUILTIN_MIC,
    )

    private val OUTPUT_ORDER = listOf(
      TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_HEARING_AID,
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
    )
  }
}
