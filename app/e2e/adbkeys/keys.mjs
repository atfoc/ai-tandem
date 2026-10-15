// The hardware keyboard on Android (package N3, AD-73, AD-83): the shortcuts of the desktop sent as key events of a keyboard with
// `adb shell input keycombination` (Android 13+) to the keys self-test screen (src/dev/KeysSelfTest.tsx), which the Maestro flow keys.yaml
// has opened with its text box focused; what the screen says is read with uiautomator. The runner calls `run` after the flow when its
// header has `adbkeys=keys`. Ctrl is the command key here (keyPlatform: "Android").
const KEYCODE = { CTRL: 113, SHIFT: 59, N: 42, B: 30, J: 38, L: 40, P: 44, U: 49, ENTER: 66, ESCAPE: 111 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {{ adb(args: string[]): string, say(m: string): void }} d  adb already names the device. */
export async function run({ adb, say }) {
  const problems = [];
  let boxes = {};
  const texts = () => {
    boxes = {};
    adb(["shell", "uiautomator", "dump", "/sdcard/keys-ui.xml"]);
    const xml = adb(["exec-out", "cat", "/sdcard/keys-ui.xml"]);
    lastXml = xml;
    // uiautomator quotes an attribute with ' when its value holds a ", so both quotes are read
    const out = {};
    for (const [node] of xml.matchAll(/<node [^>]*>/g)) {
      const attr = (n) => { const m = new RegExp(`\\b${n}=(?:"([^"]*)"|'([^']*)')`).exec(node); return m ? (m[1] ?? m[2]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : ""; };
      const id = attr("resource-id").replace(/^.*:id\//, "");
      if (id) { out[id] ??= attr("text"); boxes[id] ??= attr("bounds"); }
    }
    return out;
  };
  let lastXml = "";
  /** A finger on the middle of the node with this id (a button of the screen). */
  const tap = async (id) => {
    texts();
    const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(boxes[id] ?? "");
    if (!m) { problems.push(`no node ${id} to tap`); return false; }
    adb(["shell", "input", "tap", String(Math.round((+m[1] + +m[3]) / 2)), String(Math.round((+m[2] + +m[4]) / 2))]);
    await sleep(600);
    return true;
  };
  const combo = (...keys) => adb(["shell", "input", "keycombination", ...keys.map(String)]);
  const expect = async (id, want, what) => {
    let got = "";
    for (let i = 0; i < 20; i++) { got = texts()[id] ?? ""; if (got === want) return; await sleep(400); }
    problems.push(`${what}: ${id} is "${got}", wanted "${want}"`);
    say(`  adbkeys| nodes with ${id}: ${(lastXml.match(new RegExp(`<node [^>]*${id}[^>]*>`, "g")) ?? []).join(" | ")}`);
  };
  const apart = () => sleep(800); // a second press of one shortcut within 0.65 s is reported as a repeat (README.md); android reports a real repeatCount, so this is not needed there, but costs nothing

  adb(["shell", "input", "text", "hello"]); // typing is the text box's
  await sleep(500);
  await expect("keys-typed", 'typed: "abhello"', "typing reaches the text box (after the flow typed ab)");
  const t0 = texts();
  if (!/^keys self-test waiting/.test(t0["keys-status"] ?? "")) problems.push(`before any shortcut the screen says "${t0["keys-status"]}"`);

  combo(KEYCODE.CTRL, KEYCODE.B); await expect("keys-side-state", "sidebar: hidden", "Ctrl+B hides the sidebar");
  await apart(); combo(KEYCODE.CTRL, KEYCODE.B); await expect("keys-side-state", "sidebar: shown", "Ctrl+B shows it");
  await expect("keys-typed", 'typed: "abhello"', "Ctrl+B typed nothing");
  combo(KEYCODE.CTRL, KEYCODE.N); await expect("keys-chats", "chats made: 1", "Ctrl+N makes a chat");
  combo(KEYCODE.CTRL, KEYCODE.J); await expect("keys-panel-state", "panel: hidden", "Ctrl+J hides the panel");
  await apart(); combo(KEYCODE.CTRL, KEYCODE.J); await expect("keys-panel-state", "panel: shown", "Ctrl+J shows it");
  combo(KEYCODE.CTRL, KEYCODE.SHIFT, KEYCODE.B); await sleep(500);
  combo(KEYCODE.CTRL, KEYCODE.L); await sleep(500);
  combo(KEYCODE.CTRL, KEYCODE.SHIFT, KEYCODE.L); await sleep(500);
  combo(KEYCODE.CTRL, KEYCODE.P); await sleep(500);
  combo(KEYCODE.CTRL, KEYCODE.ENTER); await sleep(500);
  adb(["shell", "input", "keyevent", String(KEYCODE.ESCAPE)]); await sleep(500);
  combo(KEYCODE.CTRL, KEYCODE.U); await sleep(500); // no shortcut: the module does not take it
  adb(["shell", "input", "text", "x"]);
  await expect("keys-typed", 'typed: "abhellox"', "the text box kept its text and took more");
  await expect("keys-status", "keys self-test ok", "every shortcut came, no other key did");
  // With the focus out of the text box (a button blurs it): the shortcuts come, and a typed letter goes nowhere.
  await tap("keys-blur");
  await expect("keys-focus", "focus: none", "the text box lost the focus");
  combo(KEYCODE.CTRL, KEYCODE.B); await expect("keys-side-state", "sidebar: hidden", "no focus: Ctrl+B hides the sidebar");
  await apart(); combo(KEYCODE.CTRL, KEYCODE.B); await expect("keys-side-state", "sidebar: shown", "no focus: Ctrl+B shows it");
  combo(KEYCODE.CTRL, KEYCODE.N); await expect("keys-chats", "chats made: 2", "no focus: Ctrl+N makes a chat");
  combo(KEYCODE.CTRL, KEYCODE.J); await expect("keys-panel-state", "panel: hidden", "no focus: Ctrl+J hides the panel");
  await apart(); combo(KEYCODE.CTRL, KEYCODE.J); await expect("keys-panel-state", "panel: shown", "no focus: Ctrl+J shows it");
  await expect("keys-typed", 'typed: "abhellox"', "no focus: the text box was not touched");
  // The limit N3 found: a React Native `Modal` is a window of its own. Reported, not failed: what the module does while one is open.
  const modal = {};
  if (await tap("keys-modal")) {
    await expect("keys-modal-state", "modal: open", "the modal opened");
    const before = texts()["keys-modal-side"] ?? "";
    combo(KEYCODE.CTRL, KEYCODE.B); await sleep(1500);
    modal.before = before; modal.ctrlB = texts()["keys-modal-side"] ?? "";
    adb(["shell", "input", "keyevent", String(KEYCODE.ESCAPE)]); await sleep(800);
    modal.stillOpen = (texts()["keys-modal-state"] ?? "") === "modal: open";
    if (modal.stillOpen) await tap("keys-modal-close");
    say(`  adbkeys| in an open Modal: Ctrl+B: ${JSON.stringify(modal.before)} -> ${JSON.stringify(modal.ctrlB)} (unchanged = the module did not get it: the Modal's window has the keys); Escape ${modal.stillOpen ? "left it open" : "closed it"}`);
  }
  say(`  adbkeys| screen: ${JSON.stringify(texts()["keys-status"])}, seen ${JSON.stringify(texts()["keys-seen"])}`);
  return { ok: problems.length === 0, problems };
}
