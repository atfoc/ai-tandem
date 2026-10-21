import AVFoundation
import Foundation

// The engine behind AiwbAudioModule (architecture VC-8). Everything that changes its state runs on one serial queue, in the order the
// calls came: a write, a mark and a stop are queued behind each other as JS made them. The microphone's tap runs on the engine's own
// thread and touches only its MicTap.
//
// The engine has two shapes. **Listening**: the session is `.playAndRecord` with the mode `.voiceChat`, the input node has voice
// processing on (when asked), a tap takes the microphone, and the player node plays on the same engine, so that what it plays is taken out
// of what the microphone hears. **Playback**: Read aloud with no microphone; the session is `.playback` with the mode `.spokenAudio` and the
// input node is never touched (no microphone is asked for and none shows as in use). Voice processing can only be switched with the engine
// stopped, so going from playback to listening builds the engine again, and what was playing then is cut (the player says `drained`).
// The engine is taken down, and the session given back to the other apps (`.notifyOthersOnDeactivation`), when nothing runs: at once when the
// microphone stops with nothing to play, after a short while when Read aloud has played to its end (so the next sentence finds it running).
//
// Devices (voice-devices VD-9, VD-10, VD-11, VD-18): the microphone can be chosen (`setPreferredInput`, after activation, before the engine
// starts); the output follows the system. A device lost while something runs is not an end: the microphone goes on from the system's input
// (`input-lost`, or `input-failed` when it cannot), the sound goes on from the system's output (`output-lost`), and when that would turn
// private sound public the player is paused at once, on the notification's own thread, and waits for `resume` (`held`). The player keeps
// every buffer it scheduled until it has played, and schedules them again when the engine has to be started again, so nothing is lost
// and nothing played is played again (at most the piece playing at that moment, from its own start).

enum MicFailure: Error {
  /// The system gives the app no microphone.
  case blocked
  /// The device could not start it; the text is the module's own, never a path or an address.
  case device(String)
}

/// The microphone's tap: converts what the input node gives to 16 kHz mono Int16 and emits it in chunks of `chunkFrames`. Runs on the
/// engine's tap thread; `muted` is the one thing set from another thread.
final class MicTap {
  private let converter: AVAudioConverter
  private let output: AVAudioFormat
  private let chunkFrames: Int
  private let emit: (String, [String: Any]) -> Void
  private var pending: [Int16] = []
  private let lock = NSLock()
  private var isMuted = false

  init?(from input: AVAudioFormat, chunkFrames: Int, emit: @escaping (String, [String: Any]) -> Void) {
    guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
          let converter = AVAudioConverter(from: input, to: output) else { return nil }
    converter.downmix = true
    self.converter = converter
    self.output = output
    self.chunkFrames = chunkFrames
    self.emit = emit
  }

  var muted: Bool {
    get { lock.lock(); defer { lock.unlock() }; return isMuted }
    set { lock.lock(); isMuted = newValue; lock.unlock() }
  }

  func take(_ buffer: AVAudioPCMBuffer) {
    // Muted: nothing of what is heard now is kept, so that nothing of it goes out when the mute ends (goal 4.8).
    if muted {
      pending.removeAll(keepingCapacity: true)
      return
    }
    let ratio = output.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
    guard capacity > 0, let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return }
    var given = false
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      // One buffer per call; the converter keeps what it needs of it for the next (the resampler's state).
      if given {
        inputStatus.pointee = .noDataNow
        return nil
      }
      given = true
      inputStatus.pointee = .haveData
      return buffer
    }
    guard status != .error, converted.frameLength > 0, let samples = converted.int16ChannelData else { return }
    pending.append(contentsOf: UnsafeBufferPointer(start: samples[0], count: Int(converted.frameLength)))
    while pending.count >= chunkFrames {
      let chunk = Array(pending[0..<chunkFrames])
      pending.removeFirst(chunkFrames)
      var sum = 0.0
      for s in chunk { sum += Double(s) * Double(s) }
      let level = min(1.0, (sum / Double(chunk.count)).squareRoot() / 32768.0)
      // Int16 in the machine's order, which is little-endian on every iPhone and iPad: s16le as the contract says.
      let bytes = chunk.withUnsafeBufferPointer { Data(buffer: $0) }
      emit("onMic", ["pcm": bytes.base64EncodedString(), "level": level])
    }
  }
}

/// The ports of the audio session as the contract's devices (NativeDevice of src/AiwbAudio.ts). Names are the system's; they are sent to JS
/// and never written to the log (goal 4.7): a trace names a port by its type only.
enum Ports {
  static let builtIn: Set<AVAudioSession.Port> = [.builtInMic, .builtInSpeaker, .builtInReceiver]

  /// Whether what this port plays is heard by the person alone (architecture VD-11, platforms.md §3). An input is private when it belongs to
  /// a headset.
  static func privacy(_ type: AVAudioSession.Port, output: Bool) -> String {
    if output {
      switch type {
      case .headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .builtInReceiver: return "private"
      case .builtInSpeaker, .HDMI, .airPlay, .carAudio: return "public"
      default: return "unknown"
      }
    }
    switch type {
    case .headsetMic, .bluetoothHFP, .bluetoothLE: return "private"
    case .builtInMic: return "public"
    default: return "unknown"
    }
  }

  static func device(_ p: AVAudioSessionPortDescription, output: Bool) -> [String: Any] {
    [
      "id": p.uid,
      "name": p.portName,
      "kind": output ? "output" : "input",
      "privacy": privacy(p.portType, output: output),
      "builtIn": builtIn.contains(p.portType),
    ]
  }

  static func deviceOrNull(_ p: AVAudioSessionPortDescription?, output: Bool) -> Any {
    p.map { device($0, output: output) } ?? NSNull()
  }

  /// The pause of VD-11: the lost output was private (or could not be told) and what the sound moves to is not known to be private.
  static func holds(lost: AVAudioSessionPortDescription?, now: AVAudioSessionPortDescription?) -> Bool {
    let was = lost.map { privacy($0.portType, output: true) } ?? "unknown"
    let next = now.map { privacy($0.portType, output: true) } ?? "unknown"
    return was != "public" && next != "private"
  }
}

final class VoiceAudio: NSObject, AVAudioPlayerDelegate {
  typealias Emit = (String, [String: Any]) -> Void

  private enum Shape { case playback, listening }

  private let emit: Emit
  private let queue = DispatchQueue(label: "aiwb.audio")

  // The engine, its shape and its player node.
  private var engine: AVAudioEngine?
  private var shape: Shape = .playback
  private var player: AVAudioPlayerNode?
  private var voiceProcessing = false
  /// What the listening engine was built with: echo cancellation asked for (the device may not have given it).
  private var echoAsked = false
  private var engineObserver: NSObjectProtocol?
  private var sessionObservers: [NSObjectProtocol] = []
  private var sessionActive = false
  private var idle: DispatchWorkItem?

  /// When the engine was last started again after a change of the hardware's format (restart), within the last two seconds.
  private var restarts: [Date] = []

  // The microphone, and the frames of a chunk it was started with.
  private var tap: MicTap?
  private var tapFrames = 1600

  // The devices. `preferredUid`: the input this module asked the session for (nil: the system's). `lastInput`, `lastOutput`: the route's
  // ports as last seen while something ran, to tell what a route change took away. `inputCache`: the last list of inputs that was not
  // empty, for a listing while a playback session is active (its category lists none).
  private var preferredUid: String?
  private var lastInput: AVAudioSessionPortDescription?
  private var lastOutput: AVAudioSessionPortDescription?
  private var inputCache: [AVAudioSessionPortDescription] = []

  // The player's queue. A buffer has a number (`seq`) and is kept in `unplayed` until it has played; `generation` changes when the node's
  // buffers are dropped (a stop, a restart), so that the completions of what it dropped are ignored.
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private var carry: UInt8?
  private var nextSeq = 0
  private var lastSeq = -1
  private var outstanding = 0
  private var unplayed: [(seq: Int, buffer: AVAudioPCMBuffer)] = []
  /// Marks reached when the buffer of that number has played (the mark came after it).
  private var marksAfter: [Int: [Int]] = [:]
  /// Marks that came when nothing was queued: reached when the next buffer starts.
  private var marksAtStart: [Int] = []
  /// A buffer was queued while held with nothing before it: its start (the marks at start, the level) is told at the resume.
  private var startPending = false
  private var levels: [Int: Double] = [:]

  // What other threads touch, under `gate`: the route notification pauses the node and the clip at once (VD-10); the node's completions
  // are taken in on the audio thread.
  private let gate = NSLock()
  private var held = false
  private var generation = 0
  private var completed: [Int] = []
  private var liveNode: AVAudioPlayerNode?
  private var liveClip: AVAudioPlayer?

  // The preview clip.
  private var clip: AVAudioPlayer?
  private var clipDone: ((Bool) -> Void)?

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    sessionObservers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] n in
      guard let raw = n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
      self?.queue.async { self?.interrupted("call") }
    })
    sessionObservers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] n in
      guard let self, let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
      let previous = n.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
      // Headphones taken off: the sound stops here, on the notification's thread, before any of it comes out of the speaker (VD-10).
      let lost = previous?.outputs.first
      var heldNow = false
      if reason == .oldDeviceUnavailable, let lost {
        let now = session.currentRoute.outputs.first
        if lost.uid != now?.uid && Ports.holds(lost: lost, now: now) { heldNow = self.holdIfPlaying() }
      }
      self.queue.async { self.routeChanged(reason, previous: lost, heldNow: heldNow) }
    })
    sessionObservers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
      self?.queue.async { self?.interrupted("other") }
    })
  }

  deinit {
    for o in sessionObservers { NotificationCenter.default.removeObserver(o) }
  }

  private func trace(_ s: @autoclosure () -> String) {
    #if DEBUG
    NSLog("aiwbaudio: %@", s())
    #endif
  }

  // MARK: permission

  static func permission() -> String {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return "granted"
      case .denied: return "denied"
      default: return "undetermined"
      }
    }
    switch AVAudioSession.sharedInstance().recordPermission {
    case .granted: return "granted"
    case .denied: return "denied"
    default: return "undetermined"
    }
  }

  static func requestPermission(_ done: @escaping (String) -> Void) {
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission { _ in done(permission()) }
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission { _ in done(permission()) }
    }
  }

  // MARK: the session and the engine

  private static var listeningOptions: AVAudioSession.CategoryOptions {
    #if compiler(>=6.2)
    return [.defaultToSpeaker, .allowBluetoothHFP]
    #else
    return [.defaultToSpeaker, .allowBluetooth]
    #endif
  }

  private func activate(_ want: Shape) throws {
    let session = AVAudioSession.sharedInstance()
    switch want {
    case .listening:
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: VoiceAudio.listeningOptions)
    case .playback:
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
    }
    try session.setActive(true)
    sessionActive = true
  }

  private func deactivateIfIdle() {
    guard sessionActive, engine == nil, clip == nil else { return }
    let session = AVAudioSession.sharedInstance()
    if preferredUid != nil {
      // The choice is this module's, for one listening; the session is left as the system would have it.
      do { try session.setPreferredInput(nil) } catch { trace("prefer none: \(error)") }
      preferredUid = nil
    }
    do {
      try session.setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      trace("deactivate: \(error)")
    }
    sessionActive = false
  }

  /// Builds the engine for `want` (none runs). Listening: voice processing when `echoCancel` and the device has it, on the input `inputId`.
  private func build(_ want: Shape, echoCancel: Bool, inputId: String? = nil) throws {
    try activate(want)
    // The preferred input is set with the session active and before the engine takes its formats (setPreferredInput's rule).
    if want == .listening { prefer(inputId) }
    let e = AVAudioEngine()
    var processing = false
    if want == .listening {
      // The input node is made before the engine starts, so that its I/O takes the microphone (a tap is put on it after). Voice processing
      // is switched before anything is connected: it changes the formats of the input and the output nodes.
      let input = e.inputNode
      if echoCancel {
        do {
          try input.setVoiceProcessingEnabled(true)
          processing = input.isVoiceProcessingEnabled
        } catch {
          trace("voice processing: \(error)")
        }
      }
    }
    let p = AVAudioPlayerNode()
    e.attach(p)
    // The mixer converts 24 kHz mono to what the output takes.
    e.connect(p, to: e.mainMixerNode, format: playFormat)
    e.prepare()
    try e.start()
    gate.lock()
    liveNode = p
    if !held { p.play() }
    gate.unlock()
    engine = e
    player = p
    shape = want
    voiceProcessing = processing
    echoAsked = want == .listening && echoCancel
    lastOutput = AVAudioSession.sharedInstance().currentRoute.outputs.first
    // The engine stops by itself when the hardware's format changes: voice processing does it as the engine starts (the input and the
    // output take its formats), and so does a headset plugged in or taken off. It is started again on the new formats (restart).
    engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: nil) { [weak self] _ in
      self?.queue.async { self?.restart(e) }
    }
    trace("built \(want == .listening ? "listening" : "playback"), voice processing \(processing)")
  }

  /// The engine `e` stopped by itself on a change of the hardware's format: it is started again. The tap is put back for the input's new
  /// format (muted if it was), and what the player had queued and not played is scheduled again, in order, with its marks (VD-10). A change
  /// that took private sound to a public output holds it first. Only an engine that does not start again, or that stops again and again,
  /// ends what runs: the microphone with `input-failed`, the player alone with `onInterrupted` "route".
  private func restart(_ e: AVAudioEngine) {
    guard engine === e, !e.isRunning else { return }
    let now = Date()
    restarts = restarts.filter { now.timeIntervalSince($0) < 2 } + [now]
    trace("configuration changed, restart \(restarts.count)")
    if restarts.count > 3 {
      engineFailed()
      return
    }
    // What has played before the engine stopped is counted as played; the node loses the rest with the engine, and it is scheduled again.
    drainCompleted()
    dropNodeBuffers()
    do {
      if let old = tap {
        e.inputNode.removeTap(onBus: 0)
        tap = nil
        let input = e.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, input.channelCount > 0 else { throw MicFailure.device("the device has no microphone input") }
        guard let fresh = MicTap(from: input, chunkFrames: tapFrames, emit: emit) else { throw MicFailure.device("no converter for the input") }
        fresh.muted = old.muted
        e.inputNode.installTap(onBus: 0, bufferSize: 4096, format: input) { buffer, _ in fresh.take(buffer) }
        tap = fresh
        trace("mic on again, input \(input.sampleRate) Hz x\(input.channelCount)")
      }
      e.prepare()
      try e.start()
    } catch {
      trace("restart: \(error)")
      engineFailed()
      return
    }
    if let p = player {
      for item in unplayed { schedule(item.buffer, item.seq, on: p) }
    }
    // The route may have changed with the format: a private output gone is held before the queue plays on.
    let route = AVAudioSession.sharedInstance().currentRoute
    if inUse { checkOutput(route, update: false, loss: false, previous: nil, heldNow: false) }
    if tap != nil { checkInput(route, update: false) }
    gate.lock()
    if !held { player?.play() }
    gate.unlock()
    settle()
  }

  /// The engine cannot run any more: everything stops, and JS is told once.
  private func engineFailed() {
    let hadMic = tap != nil
    let lost = lastInput
    let hadAudio = outstanding > 0
    if !hadMic {
      interrupted("route") // the output changed under the engine and it would not start again
      return
    }
    takeDown()
    finishClip()
    deactivateIfIdle()
    if hadAudio { emitPlayer(["kind": "drained"]) } // nothing will play: whoever waits for the end is not left waiting
    emitRoute("input-failed", lost: Ports.deviceOrNull(lost, output: false), now: NSNull(), held: false)
  }

  /// Takes the engine down. The player's queue is dropped (its completions are ignored). A hold stays until resumed or stopped.
  private func takeDown() {
    cancelIdle()
    guard let e = engine else { return }
    if let o = engineObserver { NotificationCenter.default.removeObserver(o) }
    engineObserver = nil
    if tap != nil { e.inputNode.removeTap(onBus: 0) }
    tap = nil
    clearQueue()
    player?.stop()
    e.stop()
    gate.lock()
    liveNode = nil
    gate.unlock()
    engine = nil
    player = nil
    voiceProcessing = false
    echoAsked = false
    lastInput = nil
    if clip == nil { lastOutput = nil }
    trace("taken down")
  }

  /// The node's scheduled buffers are about to be dropped (a stop, a restart): their completions are ignored from now on.
  private func dropNodeBuffers() {
    gate.lock()
    generation += 1
    completed = []
    gate.unlock()
    player?.stop()
  }

  private func clearQueue() {
    gate.lock()
    generation += 1
    completed = []
    gate.unlock()
    outstanding = 0
    unplayed = []
    marksAfter = [:]
    marksAtStart = []
    startPending = false
    levels = [:]
    carry = nil
  }

  private func cancelIdle() {
    idle?.cancel()
    idle = nil
  }

  /// Nothing more is queued: the engine is taken down when nothing needs it.
  private func settle() {
    guard engine != nil, tap == nil, outstanding == 0 else { return }
    if shape == .listening {
      // The microphone has stopped and the last of the reply has played: the microphone is given back now.
      takeDown()
      deactivateIfIdle()
      return
    }
    cancelIdle()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.tap == nil, self.outstanding == 0 else { return }
      let waiting = self.marksAtStart // reached when the next piece starts, on the engine built for it
      self.takeDown()
      self.marksAtStart = waiting
      self.deactivateIfIdle()
    }
    idle = work
    queue.asyncAfter(deadline: .now() + 1.5, execute: work)
  }

  // MARK: the devices

  /// The inputs (the output follows the system on iOS, so none is listed), the input the system would take and the output it uses now.
  /// Asks for no permission, and leaves another app's sound alone: the list is read as the session is; when that gives none (a category
  /// that records nothing), with `.playAndRecord` set and the session inactive; only when that gives none either, and the microphone is
  /// allowed (an activation that records could ask otherwise), with a short activation that mixes with the others (platforms.md §3).
  func listDevices(_ done: @escaping ([String: Any]) -> Void) {
    queue.async {
      let session = AVAudioSession.sharedInstance()
      var inputs = session.availableInputs ?? []
      var how = "as is"
      if inputs.isEmpty && !self.sessionActive {
        (inputs, how) = self.inputsOfRecording(session)
      }
      if inputs.isEmpty {
        inputs = self.inputCache
        how = "kept"
      } else {
        self.inputCache = inputs
      }
      self.trace("devices \(how): \(inputs.map { $0.portType.rawValue }.joined(separator: ","))")
      let route = session.currentRoute
      done([
        "devices": inputs.map { Ports.device($0, output: false) },
        "defaultInput": self.systemInput(inputs, route: route) ?? NSNull(),
        "defaultOutput": route.outputs.first?.uid ?? NSNull(),
      ])
    }
  }

  /// The inputs with the category of listening set on the inactive session; the category it had is put back.
  private func inputsOfRecording(_ session: AVAudioSession) -> ([AVAudioSessionPortDescription], String) {
    let was = (session.category, session.mode, session.categoryOptions)
    defer {
      do { try session.setCategory(was.0, mode: was.1, options: was.2) } catch { trace("category back: \(error)") }
    }
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: VoiceAudio.listeningOptions)
    } catch {
      trace("category to list: \(error)")
      return ([], "none")
    }
    let found = session.availableInputs ?? []
    if !found.isEmpty || VoiceAudio.permission() != "granted" { return (found, "category") }
    do {
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: VoiceAudio.listeningOptions.union(.mixWithOthers))
      try session.setActive(true)
      let active = session.availableInputs ?? []
      try session.setActive(false)
      return (active, "activation")
    } catch {
      trace("activation to list: \(error)")
      return ([], "none")
    }
  }

  /// The input the system takes when the app prefers none: the route's, when the route has one and this module prefers nothing; otherwise
  /// the last headset connected, else the built-in microphone (the system's rule: the last device in).
  private func systemInput(_ inputs: [AVAudioSessionPortDescription], route: AVAudioSessionRouteDescription) -> String? {
    if preferredUid == nil, let now = route.inputs.first, inputs.contains(where: { $0.uid == now.uid }) { return now.uid }
    return (inputs.last { $0.portType != .builtInMic } ?? inputs.first)?.uid
  }

  /// Asks the session for the input `id` (nil, or one that is not there: the system's). Only with the session active.
  private func prefer(_ id: String?) {
    let session = AVAudioSession.sharedInstance()
    let want = id.flatMap { id in (session.availableInputs ?? []).first { $0.uid == id } }
    if want?.uid == preferredUid && session.preferredInput?.uid == want?.uid { return }
    do {
      try session.setPreferredInput(want)
      preferredUid = want?.uid
    } catch {
      trace("prefer \(want?.portType.rawValue ?? "none"): \(error)")
      preferredUid = nil
    }
  }

  /// The output now (the system decides it): nothing is changed (VD-18, output ability "system").
  func currentOutput(_ done: @escaping ([String: Any]) -> Void) {
    queue.async {
      done(["device": Ports.deviceOrNull(AVAudioSession.sharedInstance().currentRoute.outputs.first, output: true)])
    }
  }

  /// Pauses the node and the clip at once if something plays or may play; answers whether it did. Any thread.
  private func holdIfPlaying() -> Bool {
    gate.lock()
    defer { gate.unlock() }
    guard liveNode != nil || liveClip != nil else { return false }
    held = true
    liveNode?.pause()
    liveClip?.pause()
    return true
  }

  /// Something is in use: the microphone, sound queued or playing, the clip. An engine idling before it is taken down is not.
  private var inUse: Bool { tap != nil || outstanding > 0 || clip != nil }

  /// A route change, on the queue: the list may have changed; a device in use that went away is told (VD-9, VD-10). `previous`: the output
  /// of the route before the change; `heldNow`: the notification's thread has already held the sound.
  private func routeChanged(_ reason: AVAudioSession.RouteChangeReason, previous: AVAudioSessionPortDescription?, heldNow: Bool) {
    if reason == .newDeviceAvailable || reason == .oldDeviceUnavailable { emit("onDevices", [:]) }
    let route = AVAudioSession.sharedInstance().currentRoute
    guard inUse else {
      // Nothing in use: nobody is told of a loss, and a hold made at once on the notification's thread is let go.
      if heldNow { release() }
      if engine != nil { lastOutput = route.outputs.first }
      return
    }
    checkOutput(route, update: true, loss: reason == .oldDeviceUnavailable, previous: previous, heldNow: heldNow)
    if tap != nil { checkInput(route, update: true) }
  }

  /// The output of `route` against the one last seen (or, when none was, the route's before the change). A loss (the old device went
  /// away), or a private output that gave way to one not known to be private (held), is told as `output-lost`; any other change (a device
  /// plugged in) is only noted when `update`.
  private func checkOutput(_ route: AVAudioSessionRouteDescription, update: Bool, loss: Bool, previous: AVAudioSessionPortDescription?, heldNow: Bool) {
    let now = route.outputs.first
    guard let was = lastOutput ?? previous else {
      if update { lastOutput = now }
      if heldNow { release() } // nothing known was lost
      return
    }
    if now?.uid == was.uid { return } // no change, or one already told (restart saw it first)
    let hold = heldNow || Ports.holds(lost: was, now: now)
    guard loss || hold else {
      if update { lastOutput = now }
      return
    }
    lastOutput = now
    if hold { _ = holdIfPlaying() }
    trace("output lost: \(was.portType.rawValue) -> \(now?.portType.rawValue ?? "none"), held \(hold)")
    emitRoute("output-lost", lost: Ports.device(was, output: true), now: Ports.deviceOrNull(now, output: true), held: hold)
  }

  /// The input of `route` against the one the microphone last listened to. The old one still there: the route moved, no loss (noted when
  /// `update`). Gone: the tap is already on the system's input (the engine follows the route, or restart put it back), and `input-lost` says
  /// so; no input at all: the microphone stops, `input-failed`.
  private func checkInput(_ route: AVAudioSessionRouteDescription, update: Bool) {
    let now = route.inputs.first
    guard let was = lastInput else {
      if update { lastInput = now }
      return
    }
    if now?.uid == was.uid { return }
    let session = AVAudioSession.sharedInstance()
    if (session.availableInputs ?? []).contains(where: { $0.uid == was.uid }) {
      if update { lastInput = now }
      return
    }
    lastInput = now
    if preferredUid == was.uid {
      // The chosen input went away: the system's is used, and the session is not left asking for one that is gone.
      do { try session.setPreferredInput(nil) } catch { trace("prefer none: \(error)") }
      preferredUid = nil
    }
    guard let now else {
      trace("input lost: \(was.portType.rawValue), none left")
      if let e = engine, tap != nil { e.inputNode.removeTap(onBus: 0) }
      tap = nil
      emitRoute("input-failed", lost: Ports.device(was, output: false), now: NSNull(), held: false)
      settle()
      return
    }
    trace("input lost: \(was.portType.rawValue) -> \(now.portType.rawValue)")
    emitRoute("input-lost", lost: Ports.device(was, output: false), now: Ports.device(now, output: false), held: false)
  }

  private func emitRoute(_ kind: String, lost: Any, now: Any, held: Bool) {
    emit("onRoute", ["kind": kind, "lost": lost, "now": now, "held": held])
  }

  // MARK: the microphone

  /// Starts the microphone on the input `inputId` (nil, or one that is not there: the system's). Answers whether voice processing runs
  /// and the input it listens to (nil: not known).
  func startMic(chunkMs: Double, echoCancel: Bool, inputId: String?, done: @escaping (Result<(Bool, [String: Any]?), MicFailure>) -> Void) {
    queue.async {
      guard VoiceAudio.permission() == "granted" else {
        done(.failure(.blocked))
        return
      }
      self.cancelIdle()
      if let e = self.engine, self.tap != nil {
        e.inputNode.removeTap(onBus: 0) // one microphone at a time: a new start replaces the old one
        self.tap = nil
      }
      // A listening engine of the same kind keeps playing what it plays; any other is built again (voice processing is switched only
      // with the engine stopped), which cuts what it played.
      if self.engine != nil && !(self.shape == .listening && self.echoAsked == echoCancel) {
        let hadAudio = self.outstanding > 0
        self.takeDown()
        if hadAudio { self.emitPlayer(["kind": "drained"]) }
      }
      do {
        if self.engine == nil {
          try self.build(.listening, echoCancel: echoCancel, inputId: inputId)
        } else {
          self.prefer(inputId) // a change of input stops the engine, and restart puts the tap back on the new one
        }
        guard let e = self.engine else { throw MicFailure.device("no engine") }
        let input = e.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, input.channelCount > 0 else { throw MicFailure.device("the device has no microphone input") }
        let frames = max(160, Int((16000.0 * chunkMs / 1000.0).rounded()))
        guard let tap = MicTap(from: input, chunkFrames: frames, emit: self.emit) else { throw MicFailure.device("no converter for the input") }
        e.inputNode.installTap(onBus: 0, bufferSize: 4096, format: input) { buffer, _ in tap.take(buffer) }
        self.tap = tap
        self.tapFrames = frames
        let opened = AVAudioSession.sharedInstance().currentRoute.inputs.first
        self.lastInput = opened
        self.trace("mic on, \(frames) frames a chunk, input \(opened?.portType.rawValue ?? "unknown") \(input.sampleRate) Hz x\(input.channelCount)")
        done(.success((self.voiceProcessing, opened.map { Ports.device($0, output: false) })))
      } catch let failure as MicFailure {
        self.takeDown()
        self.deactivateIfIdle()
        done(.failure(failure))
      } catch {
        self.takeDown()
        self.deactivateIfIdle()
        done(.failure(.device("the audio session or the engine did not start")))
      }
    }
  }

  func setMicMuted(_ muted: Bool) {
    queue.async { self.tap?.muted = muted }
  }

  func stopMic(_ done: @escaping () -> Void) {
    queue.async {
      if let e = self.engine, self.tap != nil {
        e.inputNode.removeTap(onBus: 0)
        self.tap = nil
        self.lastInput = nil
        self.trace("mic off")
      }
      self.settle()
      done()
    }
  }

  // MARK: the player

  private func emitPlayer(_ body: [String: Any]) {
    emit("onPlayer", body)
  }

  /// Schedules a buffer on the node; its completion is taken in on the audio thread and counted on the queue.
  private func schedule(_ buffer: AVAudioPCMBuffer, _ seq: Int, on p: AVAudioPlayerNode) {
    gate.lock()
    let g = generation
    gate.unlock()
    p.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self else { return }
      self.gate.lock()
      let current = g == self.generation
      if current { self.completed.append(seq) }
      self.gate.unlock()
      if current { self.queue.async { self.drainCompleted() } }
    }
  }

  /// The buffers the node has played since the last call, in order.
  private func drainCompleted() {
    gate.lock()
    let seqs = completed
    completed = []
    gate.unlock()
    for seq in seqs { played(seq) }
  }

  func write(_ data: Data) {
    queue.async {
      var bytes = data
      if let c = self.carry {
        bytes.insert(c, at: bytes.startIndex)
        self.carry = nil
      }
      if bytes.count % 2 == 1 { self.carry = bytes.removeLast() }
      let frames = bytes.count / 2
      guard frames > 0 else { return }
      self.cancelIdle()
      if self.engine == nil {
        do {
          try self.build(.playback, echoCancel: false)
        } catch {
          self.trace("player: \(error)")
          self.takeDown()
          self.deactivateIfIdle()
          self.emitPlayer(["kind": "drained"]) // nothing will play: whoever waits for the end is not left waiting
          return
        }
      }
      guard let p = self.player,
            let buffer = AVAudioPCMBuffer(pcmFormat: self.playFormat, frameCapacity: AVAudioFrameCount(frames)),
            let out = buffer.floatChannelData?[0] else { return }
      buffer.frameLength = AVAudioFrameCount(frames)
      var sum = 0.0
      bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        for i in 0..<frames {
          let s = Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))
          let f = Float(s) / 32768.0
          out[i] = f
          sum += Double(f) * Double(f)
        }
      }
      let level = min(1.0, (sum / Double(frames)).squareRoot())
      let seq = self.nextSeq
      self.nextSeq += 1
      self.lastSeq = seq
      self.levels[seq] = level
      let starts = self.outstanding == 0
      self.outstanding += 1
      self.unplayed.append((seq, buffer))
      self.schedule(buffer, seq, on: p)
      self.gate.lock()
      let isHeld = self.held
      if !isHeld && !p.isPlaying { p.play() }
      self.gate.unlock()
      if starts {
        if isHeld {
          self.startPending = true // told when the hold ends
        } else {
          // Nothing was queued: this buffer plays now, and the marks that waited for it are reached.
          self.started(level)
        }
      }
    }
  }

  /// The first buffer after an empty queue starts to play: the marks that waited for it are reached.
  private func started(_ level: Double) {
    for id in marksAtStart { emitPlayer(["kind": "mark", "id": id]) }
    marksAtStart = []
    emitPlayer(["kind": "level", "level": level])
  }

  private func played(_ seq: Int) {
    guard let at = unplayed.firstIndex(where: { $0.seq == seq }) else { return }
    unplayed.remove(at: at)
    outstanding -= 1
    levels[seq] = nil
    if let ids = marksAfter.removeValue(forKey: seq) {
      for id in ids { emitPlayer(["kind": "mark", "id": id]) }
    }
    if outstanding == 0 {
      emitPlayer(["kind": "level", "level": 0.0])
      emitPlayer(["kind": "drained"])
      settle()
    } else {
      emitPlayer(["kind": "level", "level": levels[seq + 1] ?? 0.0])
    }
  }

  func mark(_ id: Int) {
    queue.async {
      if self.outstanding == 0 {
        self.marksAtStart.append(id)
      } else {
        self.marksAfter[self.lastSeq, default: []].append(id)
      }
    }
  }

  func stopPlayer() {
    queue.async {
      let had = self.outstanding > 0
      self.gate.lock()
      self.held = false // a stop ends a hold: the next write plays
      self.gate.unlock()
      self.clearQueue()
      self.player?.stop() // the completions of the dropped buffers come with the old generation
      if had { self.emitPlayer(["kind": "level", "level": 0.0]) }
      self.settle()
    }
  }

  /// Pauses the sound where it is; writes are still queued (VD-1 `hold`).
  func hold() {
    queue.async {
      self.gate.lock()
      self.held = true
      self.liveNode?.pause()
      self.liveClip?.pause()
      self.gate.unlock()
    }
  }

  /// Plays on from where the hold (the app's or a held loss) stopped, on the output there is now.
  func resume() {
    queue.async { self.release() }
  }

  private func release() {
    gate.lock()
    held = false
    if let p = liveNode, engine?.isRunning == true, !unplayed.isEmpty { p.play() }
    if let c = liveClip, !c.isPlaying { c.play() }
    gate.unlock()
    if startPending {
      startPending = false
      if let first = unplayed.first { started(levels[first.seq] ?? 0.0) }
    }
  }

  // MARK: the preview clip

  func playClip(_ data: Data, done: @escaping (Bool) -> Void) {
    queue.async {
      self.finishClip()
      self.cancelIdle()
      do {
        let p = try AVAudioPlayer(data: data)
        // With the engine running, its session (playback or listening) plays the clip too.
        if self.engine == nil {
          try self.activate(.playback)
          self.lastOutput = AVAudioSession.sharedInstance().currentRoute.outputs.first
        }
        p.delegate = self
        self.clip = p
        self.clipDone = done
        self.gate.lock()
        self.liveClip = p
        self.gate.unlock()
        if !p.play() { self.finishClip() }
      } catch {
        self.trace("clip: \(error)")
        self.clip = nil
        self.deactivateIfIdle()
        done(false)
      }
    }
  }

  func stopClip() {
    queue.async { self.finishClip() }
  }

  /// Ends the clip (played, stopped or replaced): its call resolves.
  private func finishClip() {
    guard let p = clip else { return }
    p.delegate = nil
    p.stop()
    clip = nil
    gate.lock()
    liveClip = nil
    gate.unlock()
    let done = clipDone
    clipDone = nil
    done?(true)
    if engine == nil {
      lastOutput = nil
      deactivateIfIdle()
    } else {
      settle()
    }
  }

  func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully _: Bool) {
    queue.async { if self.clip === p { self.finishClip() } }
  }

  func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error _: Error?) {
    queue.async { if self.clip === p { self.finishClip() } }
  }

  // MARK: the end

  /// The system took the audio (a call, Siri, an alarm, the app going to the background, the audio server reset), or the engine of the
  /// player alone would not start again: the microphone and the player stop, and JS is told once. A lost device is not an end (onRoute).
  private func interrupted(_ reason: String) {
    guard engine != nil || clip != nil else { return }
    trace("interrupted: \(reason)")
    gate.lock()
    held = false
    gate.unlock()
    takeDown()
    finishClip()
    deactivateIfIdle()
    emit("onInterrupted", ["reason": reason])
  }

  /// The module is going away (a reload of the JS): everything stops, nobody is told.
  func shutdown() {
    queue.sync {
      takeDown()
      finishClip()
      deactivateIfIdle()
    }
  }
}
