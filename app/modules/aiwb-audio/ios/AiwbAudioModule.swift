import AVFoundation
import ExpoModulesCore
import UIKit

// The iOS side of `aiwb-audio` (architecture VC-8): the microphone as 16 kHz mono s16le chunks, the PCM player of the voice's replies and
// the audio session, on one AVAudioEngine (VoiceAudio.swift), so that the voice processing of the input cancels the echo of what the same
// engine plays (VC-9). The contract it implements is ../README.md; the TypeScript of it is ../src/AiwbAudio.ts, whose function and event
// names app/test/aiwbaudio.test.ts reads here.

/// The code of `startMic`'s rejection when the system gives the app no microphone (MIC_BLOCKED of the contract).
let micBlockedCode = "ERR_AIWB_MIC_BLOCKED"

public class AiwbAudioModule: Module {
  private lazy var audio = VoiceAudio(emit: { [weak self] name, body in self?.sendEvent(name, body) })

  public func definition() -> ModuleDefinition {
    Name("AiwbAudio")

    Events("onMic", "onPlayer", "onInterrupted", "onDevices", "onRoute")

    AsyncFunction("micPermission") { () -> String in
      VoiceAudio.permission()
    }

    AsyncFunction("requestMic") { (promise: Promise) in
      VoiceAudio.requestPermission { promise.resolve($0) }
    }

    // inputId: the input to prefer (voice-devices VD-18); null, or one that has gone away, is the system's. Answers the input it listens to.
    AsyncFunction("startMic") { (chunkMs: Double, echoCancel: Bool, inputId: String?, promise: Promise) in
      self.audio.startMic(chunkMs: chunkMs, echoCancel: echoCancel, inputId: inputId) { result in
        switch result {
        case .success(let (on, device)): promise.resolve(["echoCancel": on, "device": device.map { $0 as Any } ?? NSNull()])
        case .failure(.blocked): promise.reject(micBlockedCode, "the microphone is not allowed")
        case .failure(.device(let why)): promise.reject("ERR_AIWB_MIC", why)
        }
      }
    }

    Function("setMicMuted") { (muted: Bool) in
      self.audio.setMicMuted(muted)
    }

    AsyncFunction("stopMic") { (promise: Promise) in
      self.audio.stopMic { promise.resolve() }
    }

    Function("playerWrite") { (pcm: Data) in
      self.audio.write(pcm)
    }

    Function("playerMark") { (id: Double) in
      self.audio.mark(Int(id))
    }

    Function("playerStop") {
      self.audio.stopPlayer()
    }

    AsyncFunction("playClip") { (bytes: Data, promise: Promise) in
      self.audio.playClip(bytes) { ok in
        if ok { promise.resolve() } else { promise.reject("ERR_AIWB_CLIP", "the clip could not be played") }
      }
    }

    Function("stopClip") {
      self.audio.stopClip()
    }

    // The devices (voice-devices VD-18, platforms.md §3). The input can be chosen (the session's available inputs); the output follows the
    // system (headphones or a headset when connected, else the speaker): iOS has no choice of output but its own route picker, which would
    // change the route of the whole device (goal 4.4).
    AsyncFunction("listDevices") { (promise: Promise) in
      self.audio.listDevices { promise.resolve($0) }
    }

    Function("deviceAbility") { () -> [String: Any] in
      ["input": "pick", "output": "system", "linked": false]
    }

    // iOS names its built-in ports itself ("iPhone Microphone", "Speaker"): the app's names are not needed.
    Function("setBuiltInNames") { (_: [String: String]) in
    }

    // The output is the system's: nothing changes, the answer is the route's output now.
    AsyncFunction("setOutput") { (_: String?, promise: Promise) in
      self.audio.currentOutput { promise.resolve($0) }
    }

    Function("playerHold") {
      self.audio.hold()
    }

    Function("playerResume") {
      self.audio.resume()
    }

    // The app's page in the Settings app. Its address is the system's own constant (`app-settings:`), not one this app makes: it is taken
    // apart by URLComponents: the one URL initializer the Swift of the modules may call is in httpsURL of aiwb-net (app/test/noplainhttp.test.ts).
    AsyncFunction("openSettings") { (promise: Promise) in
      guard let settings = URLComponents(string: UIApplication.openSettingsURLString)?.url else {
        promise.resolve()
        return
      }
      UIApplication.shared.open(settings, options: [:]) { _ in promise.resolve() }
    }.runOnQueue(.main)

    OnDestroy {
      self.audio.shutdown()
    }
  }
}
