import ExpoModulesCore
import UIKit

// The iOS side of `aiwb-keys` (package N3, AD-73): the hardware keyboard's shortcuts of the desktop page as UIKeyCommands added to
// the root view controller of every window, so they are found along the responder chain from whatever has the focus (a text box,
// the board's web view). While nobody listens to "onKey" no command is added and the keyboard is the system's. The contract it
// implements is ../README.md; the TypeScript of it is ../src/AiwbKeys.ts.

/// One shortcut the module takes. The list below is the one of src/AiwbKeys.ts `SHORTCUTS` (app/test/nativekeys.test.ts compares them).
struct KeysShortcut {
  let code: String
  let key: String
  let mod: Bool
  let shift: Bool
  let label: String

  /// The `input` of the UIKeyCommand: the letter, "\r" for Enter, the escape constant for Escape.
  var input: String {
    switch code {
    case "Enter": return "\r"
    case "Escape": return UIKeyCommand.inputEscape
    default: return key
    }
  }

  var flags: UIKeyModifierFlags {
    var f: UIKeyModifierFlags = []
    if mod { f.insert(.command) }
    if shift { f.insert(.shift) }
    return f
  }

  /// The event's `key`: a letter is upper case with Shift, as a browser makes it.
  var eventKey: String { shift && key.count == 1 && key.first!.isLetter ? key.uppercased() : key }
}

let keysShortcuts: [KeysShortcut] = [
  KeysShortcut(code: "KeyN", key: "n", mod: true, shift: false, label: "New chat"),
  KeysShortcut(code: "KeyB", key: "b", mod: true, shift: false, label: "Hide or show the sidebar"),
  KeysShortcut(code: "KeyB", key: "b", mod: true, shift: true, label: "Tree of the chat"),
  KeysShortcut(code: "KeyJ", key: "j", mod: true, shift: false, label: "Hide or show the chat panel"),
  KeysShortcut(code: "KeyL", key: "l", mod: true, shift: false, label: "Quote the selection or add it to the message"),
  KeysShortcut(code: "KeyL", key: "l", mod: true, shift: true, label: "Pick a point on the board"),
  KeysShortcut(code: "KeyP", key: "p", mod: true, shift: false, label: "Insert a prompt"),
  KeysShortcut(code: "Enter", key: "Enter", mod: true, shift: false, label: "Save"),
  KeysShortcut(code: "Escape", key: "Escape", mod: false, shift: false, label: "Close"),
]

extension UIViewController {
  /// The action of every command (the system sends it along the responder chain to the first responder that has it).
  @objc func aiwbKeysFire(_ command: UIKeyCommand) {
    KeyCommandCenter.shared.fire(command)
  }
}

/// Adds the commands to the root view controllers while there is a listener, and turns a fired command into an event.
final class KeyCommandCenter {
  static let shared = KeyCommandCenter()

  private func trace(_ s: @autoclosure () -> String) {
    #if DEBUG
    NSLog("aiwbkeys: %@", s())
    #endif
  }

  /// A key held down fires its command again and again; a second fire of the same command this soon after the last is its repeat.
  /// (UIKit does not say which it is. The system's delay before a held key repeats is about half a second.)
  private static let repeatWithin: CFTimeInterval = 0.65

  private var emit: (([String: Any]) -> Void)?
  private let commands = NSMapTable<UIViewController, NSArray>.weakToStrongObjects()
  private var lastFire: [Int: CFTimeInterval] = [:]
  private var observers: [NSObjectProtocol] = []
  private var recheck: Timer?

  func start(_ emit: @escaping ([String: Any]) -> Void) {
    DispatchQueue.main.async {
      self.trace("start")
      self.emit = emit
      self.install()
      let center = NotificationCenter.default
      // A window that becomes the key one later (a second scene of an iPad, a window made after the start) gets the commands too.
      self.observers = [UIWindow.didBecomeKeyNotification, UIScene.didActivateNotification].map { name in
        center.addObserver(forName: name, object: nil, queue: .main) { _ in self.install() }
      }
      // The root view controller is replaced after the start (the development client's launcher gives way to the app's) and nothing
      // announces it: while somebody listens, a root view controller without the commands gets them within a second.
      self.recheck?.invalidate()
      self.recheck = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in self.install() }
    }
  }

  func stop() {
    DispatchQueue.main.async {
      self.trace("stop")
      self.emit = nil
      self.recheck?.invalidate()
      self.recheck = nil
      for o in self.observers { NotificationCenter.default.removeObserver(o) }
      self.observers = []
      for vc in self.commands.keyEnumerator().allObjects as! [UIViewController] {
        for c in (self.commands.object(forKey: vc) as? [UIKeyCommand]) ?? [] { vc.removeKeyCommand(c) }
      }
      self.commands.removeAllObjects()
      self.lastFire = [:]
    }
  }

  private func rootViewControllers() -> [UIViewController] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .filter { $0.windowLevel == .normal }
      .compactMap { $0.rootViewController }
  }

  private func install() {
    guard emit != nil else { return }
    for vc in rootViewControllers() where commands.object(forKey: vc) == nil {
      var made: [UIKeyCommand] = []
      for (i, s) in keysShortcuts.enumerated() {
        let c = UIKeyCommand(title: s.label, image: nil, action: #selector(UIViewController.aiwbKeysFire(_:)), input: s.input,
                             modifierFlags: s.flags, propertyList: String(i), alternates: [], discoverabilityTitle: s.label,
                             attributes: [], state: .off)
        // The shortcuts of the page work in a text box as well (⌘J, ⌘N, ⌘B, ⌘P, ⌘L, ⌘Enter): they win over the text editing's own.
        // Escape does not: it stays what the system makes of it.
        c.wantsPriorityOverSystemBehavior = s.mod
        vc.addKeyCommand(c)
        made.append(c)
      }
      commands.setObject(made as NSArray, forKey: vc)
      trace("installed \(made.count) commands on \(type(of: vc))")
    }
  }

  func fire(_ command: UIKeyCommand) {
    trace("fired \(command.input ?? "?") \(command.propertyList ?? "")")
    guard let emit = emit, let id = (command.propertyList as? String).flatMap({ Int($0) }), keysShortcuts.indices.contains(id) else { return }
    let s = keysShortcuts[id]
    let now = CACurrentMediaTime()
    let repeating = lastFire[id].map { now - $0 < KeyCommandCenter.repeatWithin } ?? false
    lastFire[id] = now
    emit([
      "key": s.eventKey, "code": s.code,
      "metaKey": s.mod, "ctrlKey": false, "shiftKey": s.shift, "altKey": false,
      "repeat": repeating,
    ])
  }
}

public class AiwbKeysModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AiwbKeys")

    Events("onKey")

    OnStartObserving {
      KeyCommandCenter.shared.start { [weak self] event in self?.sendEvent("onKey", event) }
    }

    OnStopObserving {
      KeyCommandCenter.shared.stop()
    }
  }
}
