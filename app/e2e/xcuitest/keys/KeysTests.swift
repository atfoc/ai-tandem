// The hardware keyboard on the iOS simulator (package N3, AD-73, AD-83): the shortcuts of the desktop sent as key events of a keyboard
// to the keys self-test screen (src/dev/KeysSelfTest.tsx), which the Maestro flow keys.yaml has opened. The screen answers with what it
// received; this test reads the screen. The bundle id of the app is put in place of __APP_ID__ by the runner (lib/xcuitest.mjs).
import XCTest

final class KeysUITests: XCTestCase {
    let app = XCUIApplication(bundleIdentifier: "__APP_ID__")

    override func setUp() {
        continueAfterFailure = false
        app.activate() // the app is running (the runner opened it and the flow went to the screen): brought forward, not started again
        if !text("keys-status").waitForExistence(timeout: 30) { XCTFail("the keys screen is not up: \(app.debugDescription)") }
    }

    func text(_ id: String) -> XCUIElement { app.staticTexts[id] }
    func label(_ id: String) -> String { text(id).label }
    func settle() { Thread.sleep(forTimeInterval: 0.4) }
    /// The module reports a command that fires again within 0.65 s as the repeat of a held key (README.md): a second press of the same
    /// shortcut waits that out, as a person's second press does.
    func apart() { Thread.sleep(forTimeInterval: 0.8) }

    /// Waits until the screen's line `id` says `want` (the event goes native → JS → render).
    func expect(_ id: String, _ want: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(8)
        while label(id) != want && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertEqual(label(id), want, what, file: file, line: line)
    }
    func expectLast(contains part: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let deadline = Date().addingTimeInterval(8)
        while !label("keys-last").contains(part) && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
        XCTAssertTrue(label("keys-last").contains(part), "\(what): \(label("keys-last"))", file: file, line: line)
    }
    func typed() -> String { label("keys-typed") }

    func testShortcutsComeAndTypingStaysInTheTextBox() {
        // 1. The text box keeps typing: letters that are shortcut letters with ⌘ are letters here, and nothing reaches the shortcuts.
        let box = app.textViews["keys-input"].exists ? app.textViews["keys-input"] : app.textFields["keys-input"]
        XCTAssertTrue(box.waitForExistence(timeout: 10), "the text box is on the screen")
        app.descendants(matching: .any)["keys-clear"].tap()
        box.tap()
        box.typeText("hello bnjlp")
        settle()
        XCTAssertEqual(typed(), "typed: \"hello bnjlp\"", "typing is the text box's")
        XCTAssertEqual(label("keys-seen"), "seen: 0 of 9", "no typed letter was taken as a shortcut")
        XCTAssertEqual(label("keys-last"), "last key: none")
        XCTAssertTrue(label("keys-status").contains("waiting"), label("keys-status"))

        // 2. ⌘B hides the sidebar and shows it again, from inside the text box, and types nothing.
        XCTAssertEqual(label("keys-side-state"), "sidebar: shown")
        // The first key with ⌘ after typing is lost on its way to the app in this harness (the same key sent again arrives); a key that is
        // not in the module's list, ⌘U, is sent first and is heard by nobody.
        app.typeKey("u", modifierFlags: .command)
        settle()
        XCTAssertEqual(label("keys-last"), "last key: none", "⌘U is no shortcut: the module does not take it")
        app.typeKey("b", modifierFlags: .command)
        expect("keys-side-state", "sidebar: hidden", "⌘B hides the sidebar")
        XCTAssertFalse(app.descendants(matching: .any)["keys-sidebar"].exists, "the sidebar is gone")
        expectLast(contains: "key=b code=KeyB meta", "⌘B arrives as the page's key")
        apart()
        app.typeKey("b", modifierFlags: .command)
        expect("keys-side-state", "sidebar: shown", "⌘B shows it again")
        XCTAssertEqual(typed(), "typed: \"hello bnjlp\"", "⌘B typed nothing")

        // 3. ⌘N makes a chat where the user is.
        XCTAssertEqual(label("keys-chats"), "chats made: 0")
        app.typeKey("n", modifierFlags: .command)
        expect("keys-chats", "chats made: 1", "⌘N makes a chat")
        XCTAssertTrue(label("keys-chat-last").contains("__ungrouped__"), label("keys-chat-last"))

        // 4. ⌘J hides the chat panel and shows it.
        XCTAssertEqual(label("keys-panel-state"), "panel: shown")
        app.typeKey("j", modifierFlags: .command)
        expect("keys-panel-state", "panel: hidden", "⌘J hides the panel")
        apart()
        app.typeKey("j", modifierFlags: .command)
        expect("keys-panel-state", "panel: shown", "⌘J shows it")

        // 5. The rest of the list reaches the page's handlers with the keys the page reads.
        app.typeKey("b", modifierFlags: [.command, .shift])
        expectLast(contains: "key=B code=KeyB meta shift", "⌘⇧B")
        expect("keys-side-state", "sidebar: shown", "⌘⇧B is the tree's, not the sidebar's")
        app.typeKey("l", modifierFlags: .command)
        expectLast(contains: "key=l code=KeyL meta", "⌘L")
        app.typeKey("l", modifierFlags: [.command, .shift])
        expectLast(contains: "key=L code=KeyL meta shift", "⌘⇧L")
        app.typeKey("p", modifierFlags: .command)
        expectLast(contains: "key=p code=KeyP meta", "⌘P")
        // ⌘Enter and Escape: XCUITest on the simulator does not deliver the special keys at all (a plain Return typed into the text box
        // does nothing either), so they are sent as a try and what came is written to the log; the screen does not wait for them on iOS.
        box.tap()
        app.typeKey(.return, modifierFlags: .command)
        app.typeKey(.escape, modifierFlags: [])
        Thread.sleep(forTimeInterval: 1.0)
        NSLog("NOTE ⌘Enter and Escape sent; the screen's last key: \(label("keys-last")); seen \(label("keys-seen"))")

        // 6. Nothing but the list reached the shortcuts, and the text box still holds what was typed.
        box.typeText("x")
        settle()
        XCTAssertEqual(typed(), "typed: \"hello bnjlpx\"", "the text box kept its text and took more")
        XCTAssertTrue(label("keys-seen").hasPrefix("seen: "), label("keys-seen"))
        expect("keys-status", "keys self-test ok", "every shortcut came, no other key did")
        NSLog("NOTE the screen's report line: \(label("keys-report"))")
        settle() // the screen stays up for the runner's screenshot
    }
}
