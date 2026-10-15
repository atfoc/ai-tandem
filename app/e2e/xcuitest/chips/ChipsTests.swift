// The composer's chip input under a hardware keyboard, in the real app on the iOS simulator (package V3; from the composer spike's
// checks/ios-keys, which package K2 kept as app/e2e/ios-keys/KeysTests.swift on the dev gallery): the keys Maestro cannot send (arrows, Shift+arrows, forward delete, ⌘ shortcuts), sent by
// XCUITest as key events of a keyboard. It runs after maestro/composer-chips.yaml, which leaves the chat of a board open with a rectangle
// selected on the board (the context row's "Add 1 selected" puts a chip in the box). What the box holds and where its selection is
// XCUITest cannot read, so the app reports it to the runner after every change (src/dev/chipreport.ts) and the runner's control API
// answers it (`GET /box`, lib/serverctl.mjs, at __CONTROL_URL__): the string the field shows (a chip as its label between no-break
// spaces), the chips as [start, end] in it and the selection. __APP_ID__ is the app's bundle id.
import XCTest

final class ChipsTests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__APP_ID__")
    let control = "__CONTROL_URL__"

    override func setUp() {
        continueAfterFailure = false
        app.activate() // the app is running (the flow left it open): it is brought forward, not started again
        if !app.textViews["composer-input"].waitForExistence(timeout: 20) { XCTFail("the composer is not up: \(app.debugDescription)") }
    }

    /// The elements are accessible views with an identifier (React Native Pressable), not UIButtons.
    func addSelection() -> XCUIElement { app.descendants(matching: .any).matching(identifier: "ctx-act").element(boundBy: 0) }

    struct Box { var text: String; var chips: [NSRange]; var start: Int; var end: Int }

    /// The box as the app last reported it (a few tens of milliseconds after a change: the callers settle first).
    func box() -> Box {
        var out: Box?
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: URL(string: control + "/box")!) { data, _, _ in
            if let data = data, let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let b = j["box"] as? [String: Any],
               let text = b["text"] as? String, let chips = b["chips"] as? [[Int]], let sel = b["selection"] as? [String: Int] {
                out = Box(text: text, chips: chips.map { NSRange(location: $0[0], length: $0[1] - $0[0]) }, start: sel["start"]!, end: sel["end"]!)
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        guard let b = out else { XCTFail("the runner has no state of the box"); return Box(text: "", chips: [], start: -1, end: -1) }
        return b
    }
    func length(_ b: Box) -> Int { (b.text as NSString).length }
    func inside(_ b: Box, _ p: Int) -> Bool { b.chips.contains { p > $0.location && p < $0.location + $0.length } }

    func key(_ k: XCUIKeyboardKey, _ m: XCUIElement.KeyModifierFlags = []) { app.typeKey(k, modifierFlags: m) }
    func letter(_ k: String, _ m: XCUIElement.KeyModifierFlags = []) { app.typeKey(k, modifierFlags: m) }
    func settle() { Thread.sleep(forTimeInterval: 0.5) }
    /// The delete key of the keyboard (typeKey(.delete) does nothing on the simulator).
    func backspace() { app.typeText(XCUIKeyboardKey.delete.rawValue) }

    /// The box holds "ab <chip> cd" (the first letter may be capitalised by the keyboard), the caret at its end.
    func fresh() -> XCUIElement {
        let boxView = app.textViews["composer-input"]
        boxView.tap()
        letter("a", .command); settle()
        backspace(); settle() // whatever it held
        boxView.typeText("ab")
        addSelection().tap()
        boxView.typeText("cd")
        settle()
        let b = box()
        XCTAssertEqual(b.chips.count, 1, "the box holds one chip: \(b)")
        XCTAssertEqual(b.start, length(b), "the caret is at the end: \(b)")
        return boxView
    }

    func testArrowsNeverStopInsideAChip() {
        _ = fresh()
        let s0 = box()
        let c = s0.chips[0]
        let n = length(s0)
        var seen: [Int] = [s0.start]
        for _ in 0..<(n + 3) { key(.leftArrow); settle(); seen.append(box().start) }
        XCTAssertTrue(seen.allSatisfy { !($0 > c.location && $0 < c.location + c.length) }, "left arrows: \(seen)")
        XCTAssertTrue(seen.contains(c.location + c.length) && seen.contains(c.location), "the caret stops at both edges of the chip: \(seen)")
        // from the chip's end, one press crosses it
        let i = seen.firstIndex(of: c.location + c.length)!
        XCTAssertEqual(seen[i + 1], c.location, "one left arrow from the chip's end goes to its start: \(seen)")
        var right: [Int] = [box().start]
        for _ in 0..<(n + 3) { key(.rightArrow); settle(); right.append(box().start) }
        XCTAssertTrue(right.allSatisfy { !($0 > c.location && $0 < c.location + c.length) }, "right arrows: \(right)")
        let j = right.firstIndex(of: c.location)!
        XCTAssertEqual(right[j + 1], c.location + c.length, "one right arrow from the chip's start goes to its end: \(right)")
    }

    func testShiftArrowsSelectAChipWhole() {
        _ = fresh()
        let c = box().chips[0]
        for _ in 0..<(length(box()) - (c.location + c.length)) { key(.leftArrow) }
        settle()
        XCTAssertEqual(box().start, c.location + c.length)
        key(.leftArrow, .shift); settle()
        let s = box()
        XCTAssertEqual(min(s.start, s.end), c.location, "shift+left from the chip's end selects the whole chip: \(s)")
        XCTAssertEqual(max(s.start, s.end), c.location + c.length)
        key(.leftArrow, .shift); settle()
        let t = box()
        XCTAssertTrue(min(t.start, t.end) == c.location - 1 && max(t.start, t.end) == c.location + c.length, "…and one more shift+left goes on past it: \(t)")
    }

    func testDeleteKeysRemoveAChipWhole() throws {
        // does the simulator's text view take the forward delete key at all? On plain text first.
        let boxView = app.textViews["composer-input"]
        boxView.tap()
        letter("a", .command); settle()
        backspace(); settle()
        boxView.typeText("xyz")
        for _ in 0..<3 { key(.leftArrow); settle() }
        key(.forwardDelete); settle()
        let forward = box().text == "xz" || box().text == "Xz" || box().text.count == 2
        _ = fresh()
        var c = box().chips[0]
        for _ in 0..<30 where box().start > c.location { key(.leftArrow); settle() } // the arrows go over the chip in one step
        XCTAssertEqual(box().start, c.location)
        let before = box().text
        key(.forwardDelete); settle()
        if forward {
            XCTAssertTrue(box().chips.isEmpty, "forward delete at the chip's start removes the whole chip: \(box().text)")
            XCTAssertEqual(box().text, (before as NSString).replacingCharacters(in: c, with: ""))
        } else { print("NOTE forward delete does nothing in plain text on this simulator: not checked on a chip") }
        // and backspace from the other edge
        _ = fresh()
        c = box().chips[0]
        for _ in 0..<(length(box()) - (c.location + c.length)) { key(.leftArrow) }
        settle()
        let was = box().text
        backspace(); settle()
        XCTAssertTrue(box().chips.isEmpty, "backspace at the chip's end removes the whole chip: \(box().text)")
        XCTAssertEqual(box().text, (was as NSString).replacingCharacters(in: c, with: ""))
        // option + backspace (a word) from the end of the text
        _ = fresh()
        key(.delete, .option); settle()
        let word = box()
        if word.text.hasSuffix("cd") { print("NOTE option+delete does nothing in plain text on this simulator") }
        else { XCTAssertEqual(word.chips.count, 1, "option+delete took the word 'cd' and left the chip: \(word.text)") }
    }

    func testCommandKeysCopyCutPasteChips() {
        _ = fresh()
        letter("a", .command); settle()
        letter("c", .command); settle()
        key(.rightArrow); settle()
        letter("v", .command); settle()
        let s = box()
        XCTAssertEqual(s.chips.count, 2, "⌘A ⌘C ⌘V gives the chip twice, both chips: \(s.text)")
        letter("a", .command); settle()
        letter("x", .command); settle()
        XCTAssertEqual(box().text, "", "⌘X removes everything")
        XCTAssertTrue(box().chips.isEmpty)
    }
}
