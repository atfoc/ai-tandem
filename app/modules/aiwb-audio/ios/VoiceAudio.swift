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

  // The microphone.
  private var tap: MicTap?

  // The player's queue. A buffer has a number (`seq`); `generation` changes when the queue is stopped, so that the completions of the
  // buffers it dropped are ignored.
  private let playFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)!
  private var carry: UInt8?
  private var generation = 0
  private var nextSeq = 0
  private var lastSeq = -1
  private var outstanding = 0
  /// Marks reached when the buffer of that number has played (the mark came after it).
  private var marksAfter: [Int: [Int]] = [:]
  /// Marks that came when nothing was queued: reached when the next buffer starts.
  private var marksAtStart: [Int] = []
  private var levels: [Int: Double] = [:]

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
      // Headphones taken off: what was private would go to the speaker. Every other change (a category this module set, a new device) is
      // not an end; a new device that changes the engine's format stops the engine, which is seen below.
      guard let raw = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
      self?.queue.async { self?.interrupted("route") }
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

  private func activate(_ want: Shape) throws {
    let session = AVAudioSession.sharedInstance()
    switch want {
    case .listening:
      #if compiler(>=6.2)
      let bluetooth: AVAudioSession.CategoryOptions = .allowBluetoothHFP
      #else
      let bluetooth: AVAudioSession.CategoryOptions = .allowBluetooth
      #endif
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, bluetooth])
    case .playback:
      try session.setCategory(.playback, mode: .spokenAudio, options: [])
    }
    try session.setActive(true)
    sessionActive = true
  }

  private func deactivateIfIdle() {
    guard sessionActive, engine == nil, clip == nil else { return }
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      trace("deactivate: \(error)")
    }
    sessionActive = false
  }

  /// Builds the engine for `want` (none runs). Listening: voice processing when `echoCancel` and the device has it.
  private func build(_ want: Shape, echoCancel: Bool) throws {
    try activate(want)
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
    p.play()
    engine = e
    player = p
    shape = want
    voiceProcessing = processing
    echoAsked = want == .listening && echoCancel
    // The engine stops by itself when the hardware's format changes (a headset plugged in or taken off, AirPods): that ends what runs.
    engineObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: e, queue: nil) { [weak self] _ in
      self?.queue.async {
        guard let self, self.engine === e, !e.isRunning else { return }
        self.interrupted("route")
      }
    }
    trace("built \(want == .listening ? "listening" : "playback"), voice processing \(processing)")
  }

  /// Takes the engine down. The player's queue is dropped (its completions are ignored).
  private func takeDown() {
    cancelIdle()
    guard let e = engine else { return }
    if let o = engineObserver { NotificationCenter.default.removeObserver(o) }
    engineObserver = nil
    if tap != nil { e.inputNode.removeTap(onBus: 0) }
    tap = nil
    player?.stop()
    e.stop()
    engine = nil
    player = nil
    voiceProcessing = false
    echoAsked = false
    clearQueue()
    trace("taken down")
  }

  private func clearQueue() {
    generation += 1
    outstanding = 0
    marksAfter = [:]
    marksAtStart = []
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

  // MARK: the microphone

  func startMic(chunkMs: Double, echoCancel: Bool, done: @escaping (Result<Bool, MicFailure>) -> Void) {
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
        if self.engine == nil { try self.build(.listening, echoCancel: echoCancel) }
        guard let e = self.engine else { throw MicFailure.device("no engine") }
        let input = e.inputNode.outputFormat(forBus: 0)
        guard input.sampleRate > 0, input.channelCount > 0 else { throw MicFailure.device("the device has no microphone input") }
        let frames = max(160, Int((16000.0 * chunkMs / 1000.0).rounded()))
        guard let tap = MicTap(from: input, chunkFrames: frames, emit: self.emit) else { throw MicFailure.device("no converter for the input") }
        e.inputNode.installTap(onBus: 0, bufferSize: 4096, format: input) { buffer, _ in tap.take(buffer) }
        self.tap = tap
        self.trace("mic on, \(frames) frames a chunk, input \(input.sampleRate) Hz x\(input.channelCount)")
        done(.success(self.voiceProcessing))
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
      let generation = self.generation
      let starts = self.outstanding == 0
      self.outstanding += 1
      p.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        self?.queue.async { self?.played(seq, generation) }
      }
      if !p.isPlaying { p.play() }
      if starts {
        // Nothing was queued: this buffer plays now, and the marks that waited for it are reached.
        for id in self.marksAtStart { self.emitPlayer(["kind": "mark", "id": id]) }
        self.marksAtStart = []
        self.emitPlayer(["kind": "level", "level": level])
      }
    }
  }

  private func played(_ seq: Int, _ generation: Int) {
    guard generation == self.generation else { return }
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
      self.clearQueue()
      self.player?.stop() // the completions of the dropped buffers come with the old generation
      if had { self.emitPlayer(["kind": "level", "level": 0.0]) }
      self.settle()
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
        if self.engine == nil { try self.activate(.playback) }
        p.delegate = self
        self.clip = p
        self.clipDone = done
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
    let done = clipDone
    clipDone = nil
    done?(true)
    if engine == nil { deactivateIfIdle() } else { settle() }
  }

  func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully _: Bool) {
    queue.async { if self.clip === p { self.finishClip() } }
  }

  func audioPlayerDecodeErrorDidOccur(_ p: AVAudioPlayer, error _: Error?) {
    queue.async { if self.clip === p { self.finishClip() } }
  }

  // MARK: the end

  /// The system took the audio (a call, Siri, an alarm, the app going to the background), the headphones were taken off, or the engine
  /// stopped by itself: the microphone and the player stop, and JS is told once.
  private func interrupted(_ reason: String) {
    guard engine != nil || clip != nil else { return }
    trace("interrupted: \(reason)")
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
