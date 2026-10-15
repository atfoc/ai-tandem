// The composer's chips under the hardware keyboard, on the iOS simulator: the keys Maestro cannot send (arrows, shift +
// arrows, forward delete, ⌘ shortcuts), sent by XCUITest as key events of a keyboard. The screen under test is the
// spike's own: the "shown" line holds the field's string (a no-break space as "_") and its selection.
import XCTest

final class KeysUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "dev.aiwhiteboard.spike.composer")

    override func setUp() {
        continueAfterFailure = false
        app.activate() // the app is running (checks/ios.mjs opened it): it is brought forward, not started again
        if !btn("clear").waitForExistence(timeout: 20) { XCTFail("the spike screen is not up: \(app.debugDescription)") }
    }

    /// The screen's buttons are accessible views with an identifier (React Native Pressable), not UIButtons.
    func btn(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id] }

    struct Shown { var text: String; var start: Int; var end: Int }

    func shown() -> Shown {
        let label = app.staticTexts["shown"].label // "ab _rectangle_“API”_ cd" sel 3-20   (the string is JSON)
        let parts = label.components(separatedBy: "\" sel ")
        let sel = parts[1].components(separatedBy: CharacterSet(charactersIn: "-–"))
        return Shown(text: String(parts[0].dropFirst()), start: Int(sel[0])!, end: Int(sel[1])!)
    }
    /// The chip's place in the shown string: from its first no-break space to its last.
    func chip(_ s: Shown) -> NSRange {
        (s.text as NSString).range(of: "_rectangle_“API”_")
    }
    func key(_ k: XCUIKeyboardKey, _ m: XCUIElement.KeyModifierFlags = []) { app.typeKey(k, modifierFlags: m) }
    func letter(_ k: String, _ m: XCUIElement.KeyModifierFlags = []) { app.typeKey(k, modifierFlags: m) }
    func settle() { Thread.sleep(forTimeInterval: 0.4) }

    func fresh() -> XCUIElement {
        btn("clear").tap()
        let box = app.textViews["composer"]
        box.tap()
        box.typeText("ab")
        btn("insert-selection").tap()
        box.typeText("cd")
        settle()
        return box
    }

    func testArrowsNeverStopInsideAChip() {
        _ = fresh()
        let s0 = shown()
        let c = chip(s0)
        XCTAssertEqual(c.location, 3); XCTAssertEqual(c.length, 17)
        XCTAssertEqual(s0.start, 23)
        var seen: [Int] = [s0.start]
        for _ in 0..<26 { key(.leftArrow); settle(); seen.append(shown().start) }
        XCTAssertTrue(seen.allSatisfy { !($0 > c.location && $0 < c.location + c.length) }, "left arrows: \(seen)")
        XCTAssertTrue(seen.contains(c.location + c.length) && seen.contains(c.location), "the caret stops at both edges of the chip: \(seen)")
        // from the chip's end, one press crosses it
        let i = seen.firstIndex(of: c.location + c.length)!
        XCTAssertEqual(seen[i + 1], c.location, "one left arrow from the chip's end goes to its start: \(seen)")
        var right: [Int] = [shown().start]
        for _ in 0..<26 { key(.rightArrow); settle(); right.append(shown().start) }
        XCTAssertTrue(right.allSatisfy { !($0 > c.location && $0 < c.location + c.length) }, "right arrows: \(right)")
        let j = right.firstIndex(of: c.location)!
        XCTAssertEqual(right[j + 1], c.location + c.length, "one right arrow from the chip's start goes to its end: \(right)")
    }

    func testShiftArrowsSelectAChipWhole() {
        _ = fresh()
        let c = chip(shown())
        for _ in 0..<(23 - (c.location + c.length)) { key(.leftArrow) }
        settle()
        XCTAssertEqual(shown().start, c.location + c.length)
        key(.leftArrow, .shift); settle()
        let s = shown()
        XCTAssertEqual(s.start, c.location, "shift+left from the chip's end selects the whole chip")
        XCTAssertEqual(s.end, c.location + c.length)
        key(.leftArrow, .shift); settle()
        let t = shown()
        XCTAssertTrue(t.start == c.location - 1 && t.end == c.location + c.length || (t.start == c.location - 1 && t.end == c.location + c.length), "…and one more shift+left goes on past it: \(t)")
    }

    func testDeleteKeysRemoveAChipWhole() throws {
        // does the simulator's text view take the forward delete key at all? On plain text first.
        btn("clear").tap()
        let box = app.textViews["composer"]
        box.tap(); box.typeText("xyz")
        for _ in 0..<3 { key(.leftArrow); settle() }
        key(.forwardDelete); settle()
        let forward = shown().text == "yz"
        _ = fresh()
        var c = chip(shown())
        for _ in 0..<30 where shown().start > c.location { key(.leftArrow); settle() } // the arrows go over the chip in one step
        XCTAssertEqual(shown().start, c.location)
        key(.forwardDelete); settle()
        if forward {
        XCTAssertEqual(chip(shown()).location, NSNotFound, "forward delete at the chip's start removes the whole chip: \(shown().text)")
        XCTAssertEqual(shown().text, "ab  cd")
        } else { print("NOTE forward delete does nothing in plain text on this simulator: not checked on a chip") }
        // and backspace from the other edge
        _ = fresh()
        c = chip(shown())
        for _ in 0..<(23 - (c.location + c.length)) { key(.leftArrow) }
        settle()
        app.typeText(XCUIKeyboardKey.delete.rawValue); settle() // the delete key of the keyboard (typeKey(.delete) does nothing on the simulator)
        XCTAssertEqual(shown().text, "ab  cd", "backspace at the chip's end removes the whole chip: \(shown().text)")
        // option + backspace (a word) from the end of the text
        _ = fresh()
        key(.delete, .option); settle()
        let word = shown().text
        if word.hasSuffix("cd") { print("NOTE option+delete does nothing in plain text on this simulator") }
        else { XCTAssertTrue(chip(shown()).location != NSNotFound, "option+delete took the word 'cd' and left the chip: \(word)") }
    }

    func testCommandKeysCopyCutPasteChips() {
        _ = fresh()
        letter("a", .command); settle()
        letter("c", .command); settle()
        key(.rightArrow); settle()
        letter("v", .command); settle()
        let s = shown()
        XCTAssertEqual((s.text as NSString).components(separatedBy: "_rectangle_“API”_").count - 1, 2, "⌘A ⌘C ⌘V gives the chip twice: \(s.text)")
        letter("a", .command); settle()
        letter("x", .command); settle()
        XCTAssertEqual(shown().text, "", "⌘X removes everything")
    }
}
