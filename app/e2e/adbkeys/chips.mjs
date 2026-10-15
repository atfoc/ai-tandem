// The hardware keyboard on Android for the chip input (package K2, in the runner by package V3), as the XCUITest keys of xcuitest/chips on
// iOS: key events sent with `adb shell input`, which reach the field as a keyboard's keys do; what the box holds after each is its latest
// state report. It runs after maestro/composer-chips-gallery.yaml (the box alone on the dev gallery), whose `_chips-fresh.yaml` puts "ab <chip> cd"
// in it, since the buttons that make a chip there are the gallery's.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NBSP = " ", CHIP = `${NBSP}rectangle${NBSP}“API”${NBSP}`;

/** @param {{ adb(args: string[]): string, say(m: string): void, box(): object | null, maestro(file: string): Promise<{ status: number }> }} d */
export async function run({ adb, say, box, maestro }) {
  const problems = [];
  const T = {
    ok(cond, what, detail = "") { if (!cond) problems.push(`${what}${detail ? ` (${detail})` : ""}`); },
    eq(actual, expected, what) { this.ok(actual === expected, what, `expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`); },
  };
  const state = () => box() ?? { text: "", selection: { start: -1, end: -1 }, chips: [] };
  const key = async (...k) => { adb(["shell", "input", ...(k.length > 1 ? ["keycombination", ...k] : ["keyevent", k[0]])]); await sleep(500); return state(); };
  const fresh = async () => {
    const r = await maestro("_chips-fresh.yaml");
    await sleep(1000);
    if (r.status !== 0) throw new Error("the keys' setup flow failed");
    return state();
  };
  const inside = (p, c) => p > c[0] && p < c[1];

  let s = await fresh();
  const c = s.chips[0] ?? [-1, -1];
  T.ok(c[0] === 3 && c[1] === 20 && s.selection.start === 23, "keys: the box holds ab <chip> cd, the caret at its end", JSON.stringify(s));
  const left = [s.selection.start];
  // (to the text's start and no further: an arrow key at a field's end moves Android's focus to the next view)
  for (let i = 0; i < 26 && left[left.length - 1] > 0; i++) left.push((await key("KEYCODE_DPAD_LEFT")).selection.start);
  T.ok(left.every((p) => !inside(p, c)), "hardware keyboard: left arrows never stop inside the chip", JSON.stringify(left));
  T.eq(left[left.indexOf(c[1]) + 1], c[0], "hardware keyboard: one left arrow from the chip's end goes to its start");
  const right = [state().selection.start];
  for (let i = 0; i < 26 && right[right.length - 1] < 23; i++) right.push((await key("KEYCODE_DPAD_RIGHT")).selection.start);
  say(`  left arrows: ${left}\n  right arrows: ${right}`);
  T.ok(right.every((p) => !inside(p, c)), "hardware keyboard: right arrows never stop inside the chip", JSON.stringify(right));
  T.eq(right[right.indexOf(c[0]) + 1], c[1], "hardware keyboard: one right arrow from the chip's start goes to its end");

  for (let i = 0; i < 3; i++) await key("KEYCODE_DPAD_LEFT"); // to the chip's end
  s = await key("KEYCODE_SHIFT_LEFT", "KEYCODE_DPAD_LEFT");
  T.ok(Math.min(s.selection.start, s.selection.end) === c[0] && Math.max(s.selection.start, s.selection.end) === c[1], "hardware keyboard: shift+left from the chip's end selects it whole", JSON.stringify(s.selection));

  s = await fresh();
  for (let i = 0; i < 3; i++) s = await key("KEYCODE_DPAD_LEFT");
  s = await key("KEYCODE_DEL");
  T.eq(s.text, "ab  cd", "hardware keyboard: backspace at the chip's end removes it whole");
  s = await fresh();
  for (let i = 0; i < 4; i++) s = await key("KEYCODE_DPAD_LEFT"); // over the chip: at its start
  T.eq(s.selection.start, c[0], "hardware keyboard: …the caret at the chip's start");
  s = await key("KEYCODE_FORWARD_DEL");
  T.eq(s.text, "ab  cd", "hardware keyboard: forward delete at the chip's start removes it whole");

  s = await fresh();
  await key("KEYCODE_CTRL_LEFT", "KEYCODE_A");
  await key("KEYCODE_CTRL_LEFT", "KEYCODE_C");
  await key("KEYCODE_DPAD_RIGHT");
  s = await key("KEYCODE_CTRL_LEFT", "KEYCODE_V");
  T.eq(s.text.split(CHIP).length - 1, 2, "hardware keyboard: ctrl+A ctrl+C ctrl+V gives the chip twice (pasted back, it is a chip)");
  T.eq(s.chips.length, 2, "hardware keyboard: …both are chips");
  await key("KEYCODE_CTRL_LEFT", "KEYCODE_A");
  s = await key("KEYCODE_CTRL_LEFT", "KEYCODE_X");
  T.eq(s.text, "", "hardware keyboard: ctrl+X removes everything");
  return { ok: !problems.length, problems };
}
