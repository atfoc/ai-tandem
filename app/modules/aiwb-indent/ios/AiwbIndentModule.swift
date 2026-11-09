import ExpoModulesCore
import UIKit

// The iOS side of `aiwb-indent`: the hanging indent of the composer's text box. When a line of the box wraps, its continuation lines
// start where its text starts after its leading tabs and spaces, and a tab is drawn `tabWidth` columns wide. The contract is
// ../src/AiwbIndent.ts (the rules `indentColumns`, `paragraphs`, `hangWidth`, `tabInterval`, which the code below follows exactly);
// how it is used is ../README.md and app/src/platform/chipinput/hang.ts.
//
// Why it is done this way. The box is React Native's TextInput, whose Fabric view (RCTTextInputComponentView) holds a UITextView
// (RCTUITextView). On every render from JS it compares the attributed string JS sends with the text view's own
// (RCTIsAttributedStringEffectivelySame, which wants the very same attribute runs) and sets `attributedText` again when they differ.
// Paragraph styles added to the text storage would make every render from JS set the text again: the caret jumps, autocorrect and
// the input method lose their state, and the string it remembers (`_lastStringStateWasUpdatedWith`) no longer matches, which sends
// an extra onChange. So the indent is drawn only, and the text storage is never changed: RCTUITextView lays out with TextKit 2
// (`textLayoutManager` is not nil; its NSTextContentStorage had no delegate), and the content storage asks its delegate for each
// paragraph it lays out (`textContentStorage(_:textParagraphWith:)`). For a paragraph with an indent or a tab, the delegate below
// answers an NSTextParagraph whose attributed string is the paragraph's own with every paragraph style copied and changed:
// `headIndent` the hang (`hangWidth`), no tab stops of its own and `defaultTabInterval` the tab interval (`tabInterval`);
// `firstLineHeadIndent` is left as it is (the first line's own spaces and tabs put its text where it starts). Any other paragraph
// is the previous delegate's (or the storage's own, nil). React Native reads the text storage, and finds exactly its own text.
//
// `textView.layoutManager` is never read here: reading it switches a UITextView to TextKit 1 for good. A text view that is on
// TextKit 1 anyway (no `textLayoutManager`, or its content manager is not an NSTextContentStorage) gets no indent and no heights;
// `setIndent` still answers true for it (the view was found), and the box is drawn as React Native draws it.
//
// React Native measures the box's height from JS's attributed string, without the indent (a wrapped line may take one more line
// here, or one fewer with narrow tabs), so the module emits the height the text takes as drawn (`onDrawnHeight`, the text view's
// contentSize, which includes the textContainerInset, React Native's padding) and the field takes it as its height.
//
// Everything here runs on the main thread (`setIndent` runs on the main queue; KVO and TextKit call back there).

/// The share of the text's width an indent may take at most (src/AiwbIndent.ts MAX_INDENT_SHARE; app/test/aiwbindent.native.test.ts
/// compares the two).
let maxIndentShare: CGFloat = 0.5

/// The columns of a line's indent (src/AiwbIndent.ts `indentColumns`): its leading spaces and tabs, a space one column, a tab up to
/// the next multiple of `tabWidth`; stops at the first other character. UTF-16 units, as NSString counts.
func indentColumns(_ line: NSString, tabWidth: Int) -> Int {
  var cols = 0
  var i = 0
  while i < line.length {
    let c = line.character(at: i)
    if c == 32 { cols += 1 } else if c == 9 { cols += tabWidth - cols % tabWidth } else { break }
    i += 1
  }
  return cols
}

/// How far the continuation lines start (src/AiwbIndent.ts `hangWidth`): the columns times the width of a space, at most
/// maxIndentShare of the text's width; no cap while the width is not known (0 or less).
func hangWidth(columns: Int, spaceWidth: CGFloat, textWidth: CGFloat) -> CGFloat {
  let w = CGFloat(columns) * spaceWidth
  return textWidth > 0 ? min(w, textWidth * maxIndentShare) : w
}

/// The distance between two tab stops (src/AiwbIndent.ts `tabInterval`): `tabWidth` spaces of the font.
func tabInterval(tabWidth: Int, spaceWidth: CGFloat) -> CGFloat {
  CGFloat(tabWidth) * spaceWidth
}

/// The first UITextView in a view's tree, depth first (the component view of a TextInput holds its RCTUITextView).
private func findTextView(_ view: UIView) -> UITextView? {
  if let t = view as? UITextView { return t }
  for s in view.subviews {
    if let t = findTextView(s) { return t }
  }
  return nil
}

/// The indent of one text view: the delegate of its content storage while attached, the observer of its width and of its content
/// height. Kept on the text view as an associated object (so it lives as long as the view, and a second `setIndent` finds it).
final class IndentController: NSObject, NSTextContentStorageDelegate {
  /// The key of the associated object on the UITextView.
  static var key: UInt8 = 0

  weak var textView: UITextView?
  /// The component view the module found by the tag. Fabric sets its `tag` to the React tag when it mounts it and to 0 when it
  /// recycles it (RCTComponentViewRegistry), so a host whose tag is no longer ours is a view now used, or about to be used, by
  /// another TextInput: then the controller behaves as if it were detached until `setIndent` is called for the new tag.
  weak var host: UIView?
  let tag: Int
  var tabWidth: Int
  /// The content storage's delegate before ours, given back on detach; the paragraphs we do not change are its.
  weak var previous: NSTextContentStorageDelegate?
  weak var module: AiwbIndentModule?
  private var observations: [NSKeyValueObservation] = []
  /// The text width the paragraphs were last made with (the cap depends on it).
  private var madeWidth: CGFloat = -1
  /// The last height emitted, so a change smaller than half a point is not sent.
  private var lastHeight: CGFloat = -1
  private var widthCheckPending = false

  init(textView: UITextView, host: UIView, tag: Int, tabWidth: Int, module: AiwbIndentModule?) {
    self.textView = textView
    self.host = host
    self.tag = tag
    self.tabWidth = tabWidth
    self.module = module
    super.init()
  }

  /// Whether the host still is the view of our tag (see `host`).
  private var current: Bool { host != nil && host?.tag == tag }

  private var storage: NSTextContentStorage? {
    textView?.textLayoutManager?.textContentManager as? NSTextContentStorage
  }

  /// The text's width: the text container's less its line fragment padding (React Native's padding is the textContainerInset, not
  /// part of it). 0 or less: not known yet, no cap.
  private var textWidth: CGFloat {
    guard let tv = textView else { return 0 }
    return tv.textContainer.size.width - 2 * tv.textContainer.lineFragmentPadding
  }

  // MARK: attach, change, detach

  /// Becomes the storage's delegate (keeping the one before), observes the view, makes the paragraphs again and emits the height.
  func attach(to storage: NSTextContentStorage) {
    guard let tv = textView else { return }
    if storage.delegate !== self {
      previous = storage.delegate
      storage.delegate = self
    }
    observations = [
      tv.observe(\.contentSize, options: [.new]) { [weak self] _, _ in self?.contentSizeChanged() },
      // A change of the frame does not always send one of the bounds; either may carry a new width.
      tv.observe(\.bounds, options: [.new]) { [weak self] _, _ in self?.scheduleWidthCheck() },
      tv.observe(\.frame, options: [.new]) { [weak self] _, _ in self?.scheduleWidthCheck() },
    ]
    remake(force: true)
  }

  /// A new tab width: the paragraphs again, with it.
  func setTabWidth(_ w: Int) {
    guard w != tabWidth else { return }
    tabWidth = w
    remake(force: true)
  }

  /// Gives the storage its delegate back, stops observing, forgets itself on the view and makes the paragraphs again (as React
  /// Native's own).
  func detach() {
    observations.forEach { $0.invalidate() }
    observations = []
    if let s = storage, s.delegate === self { s.delegate = previous }
    if let tv = textView {
      objc_setAssociatedObject(tv, &IndentController.key, nil, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }
    if let s = storage { IndentController.refresh(s) }
  }

  /// Makes every paragraph again: an edit of the attributes over the whole text, inside a transaction of the content storage, which
  /// asks the delegate for each paragraph anew. The text and its attributes are not changed.
  static func refresh(_ storage: NSTextContentStorage) {
    guard let ts = storage.textStorage, ts.length > 0 else { return }
    storage.performEditingTransaction {
      ts.edited(.editedAttributes, range: NSRange(location: 0, length: ts.length), changeInLength: 0)
    }
  }

  /// The paragraphs again with the current width and tab width, then the height as now drawn (`force`: emitted even when it did not
  /// change, so the field has one at once).
  private func remake(force: Bool) {
    guard let tv = textView, let s = storage else { return }
    madeWidth = textWidth
    IndentController.refresh(s)
    tv.layoutIfNeeded()
    emitHeight(force: force)
  }

  // MARK: width and height

  /// The width is read after the layout that changed the bounds has set the text container's size, on the next turn of the main loop.
  private func scheduleWidthCheck() {
    guard !widthCheckPending else { return }
    widthCheckPending = true
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.widthCheckPending = false
      self.checkWidth()
    }
  }

  private func checkWidth() {
    guard current, textView != nil else { return }
    if abs(textWidth - madeWidth) >= 0.5 { remake(force: true) }
  }

  private func contentSizeChanged() {
    guard current else { return }
    // The text container can get its new width in the same layout pass that changes the content size.
    if abs(textWidth - madeWidth) >= 0.5 {
      scheduleWidthCheck()
    }
    emitHeight(force: false)
  }

  private func emitHeight(force: Bool) {
    guard current, let tv = textView else { return }
    let h = tv.contentSize.height
    if !force && abs(h - lastHeight) < 0.5 { return }
    lastHeight = h
    module?.sendEvent("onDrawnHeight", ["tag": tag, "height": Double(h)])
  }

  // MARK: NSTextContentStorageDelegate

  func textContentStorage(_ textContentStorage: NSTextContentStorage, textParagraphWith range: NSRange) -> NSTextParagraph? {
    let forward = { [weak self] () -> NSTextParagraph? in
      self?.previous?.textContentStorage?(textContentStorage, textParagraphWith: range)
    }
    guard current, tabWidth > 0, let text = textContentStorage.textStorage, range.length > 0, NSMaxRange(range) <= text.length else {
      return forward()
    }
    let sub = text.attributedSubstring(from: range)
    let line = sub.string as NSString
    let cols = indentColumns(line, tabWidth: tabWidth)
    let hasTab = line.range(of: "\t").location != NSNotFound
    if cols == 0 && !hasTab { return forward() }

    let font = (sub.attribute(.font, at: 0, effectiveRange: nil) as? UIFont) ?? textView?.font ?? UIFont.systemFont(ofSize: 17)
    let space = (" " as NSString).size(withAttributes: [.font: font]).width
    let indent = hangWidth(columns: cols, spaceWidth: space, textWidth: textWidth)
    let interval = tabInterval(tabWidth: tabWidth, spaceWidth: space)

    let out = NSMutableAttributedString(attributedString: sub)
    out.enumerateAttribute(.paragraphStyle, in: NSRange(location: 0, length: out.length)) { value, r, _ in
      let p = ((value as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle) ?? NSMutableParagraphStyle()
      p.headIndent = indent
      p.tabStops = []
      p.defaultTabInterval = interval
      out.addAttribute(.paragraphStyle, value: p, range: r)
    }
    return NSTextParagraph(attributedString: out)
  }

  // The other methods of the delegate protocols (NSTextContentManagerDelegate) go to the previous delegate, if it has them.
  override func responds(to aSelector: Selector!) -> Bool {
    if super.responds(to: aSelector) { return true }
    return previous?.responds(to: aSelector) ?? false
  }

  override func forwardingTarget(for aSelector: Selector!) -> Any? {
    if let p = previous, p.responds(to: aSelector) { return p }
    return super.forwardingTarget(for: aSelector)
  }
}

public class AiwbIndentModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AiwbIndent")

    Events("onDrawnHeight")

    // The contract is src/AiwbIndent.ts `setIndent`: true when the view was found (the indent is now as asked, or the view is on
    // TextKit 1 and gets none), false when it was not. Never throws.
    AsyncFunction("setIndent") { [weak self] (tag: Int, tabWidth: Int) -> Bool in
      guard let self = self,
            let host = self.appContext?.findView(withTag: tag, ofType: UIView.self),
            let tv = findTextView(host) else { return false }
      var controller = objc_getAssociatedObject(tv, &IndentController.key) as? IndentController
      // The component view was recycled and is now another TextInput's: the old controller goes first.
      if let c = controller, c.tag != tag {
        c.detach()
        controller = nil
      }
      if tabWidth <= 0 {
        controller?.detach()
        return true
      }
      if let c = controller {
        c.host = host
        c.setTabWidth(tabWidth)
        return true
      }
      // TextKit 1: no indent (the header says why the layout manager is never asked for).
      guard let storage = tv.textLayoutManager?.textContentManager as? NSTextContentStorage else { return true }
      let c = IndentController(textView: tv, host: host, tag: tag, tabWidth: tabWidth, module: self)
      objc_setAssociatedObject(tv, &IndentController.key, c, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
      c.attach(to: storage)
      return true
    }.runOnQueue(.main)
  }
}
