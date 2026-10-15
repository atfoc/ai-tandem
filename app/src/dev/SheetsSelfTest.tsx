// The self-test screen of the overlays on a phone (package P1; flow app/e2e/maestro/sheets.yaml): the real Sheet, Dialog, Popover and Menu of ui/ with the
// real text fields of the Servers form, on a device with its on-screen keyboard. A device test reads and presses what it shows:
//  - a sheet with three text boxes and its buttons below them keeps the box that has the focus and the buttons above the keyboard (the test
//    types, and presses a button while the keyboard is up: a button under the keyboard would not be pressed, a key would);
//  - a menu, a dialog (with a text box) and a second sheet each open from the sheet, declared twice: beside it (`-out`, as the confirm dialog
//    is, at the root of the shell) and inside its own content (`-in`), and each must show on iOS, where a second Modal beside an open one does not;
//  - the secret box of the form is the one of the Servers form, and closing the form after typing in it must not make the system offer to
//    save a password (the test waits for that and fails when the question comes); `sheets-secret-value` shows the real text it holds, so that
//    the test can type in the middle of it (the caret must stay where the edit left it) and read the result;
//  - a popover hung from the bottom of the screen (as the composer's model picker is, on the tablet layout) that holds an autofocused text box
//    and rows: it must rise with the keyboard's top, so that the box and the last row are above the keyboard (`sheets-<name>-geometry`, a line at the top of the popover (a popover is a `Modal`: the screen's own texts are out of reach while it is open), says where the
//    keyboard's top, the box and the last row are, and `ok` or `FAILED`; the test also presses the last row with the keyboard up). A second one
//    holds more rows than the room that is left, and must take that room;
//  - the composer's model picker and the library's insert popup, as the app opens them: a real `Overlay` (`ui/Overlay.tsx`: a sheet on the phone, a popover or a dialog on
//    the tablet), declared at the top of the screen and not inside another sheet, with an autofocused text box and rows. `sheets-toppop` (kind popover, hung from a
//    control at the bottom of the screen) and `sheets-topdlg` (kind dialog) open from the screen's bottom bar with no keyboard up, `sheets-topkb` (kind dialog)
//    from a button over a text box that already has the keyboard (the insert popup opened while the composer's box has the focus). With nothing typed, 6 s after
//    it opened, the overlay says where the keyboard's top and its own box and surface are (`sheets-<name>-geometry`: `ok` when the box is above the keyboard);
//    the test looks at the screen before and after a letter is typed, because what was wrong was a sheet that showed only after the first key. The box is controlled, as the
//    picker's search is (a render of the sheet is what brought the lost sheet back, so the test waits for the box, 4 s, before the measure's render). What fails without
//    the fix is that wait for `sheets-<name>-input`: Maestro reads the native views and the sheet drawn off-screen is not among them, while the `geometry` line said `ok`
//    even then (it reads the layout, not where the view was drawn). The sheet's rise is lengthened to 300 ms for these three (`sheetTiming` of ui/Sheet.tsx): the sheet
//    was lost when the keyboard's LayoutAnimation was still running as its rise ended; with the old code the simulator lost it at 180 and 300 ms every time and at 450 ms
//    one time in nine, so 300 ms is the middle of that window (5 of 5 for each case with the old code, 0 of 20 with the fix).
// The screen's `sheets-log` says what happened, as words a flow waits for.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Keyboard, Platform, StyleSheet, TextInput, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Field, PLAIN_INPUT, SECRET_INPUT } from "../screens/servers/parts.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog, DialogActions, DialogTitle } from "../ui/Dialog.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { Overlay } from "../ui/Overlay.tsx";
import { Popover } from "../ui/Popover.tsx";
import { Sheet, sheetTiming } from "../ui/Sheet.tsx";
import { Text } from "../ui/Text.tsx";
import { ThemeProvider, useTheme } from "../ui/theme.tsx";

/** A popover hung from a control at the bottom of the screen, with a text box that has the focus when it opens and `rows` rows; it measures itself
 *  against the keyboard's top, as the system reports it, once the keyboard is up. `last` is true when the last row can be measured (the rows fit). */
function BottomPopover({ id, rows, say }: { id: "bottom" | "tall"; rows: number; say(s: string): void }) {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [geometry, setGeometry] = useState("geometry: waiting");
  const anchor = useRef<View>(null);
  const input = useRef<TextInput>(null);
  const last = useRef<View>(null);
  const keyboardTop = useRef<number | null>(null);
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", (e) => { keyboardTop.current = e.endCoordinates.screenY; });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!open) return;
    // 1.5 s after the popover opened: the keyboard is up and the popover has settled above it
    const timer = setTimeout(() => {
      const top = keyboardTop.current;
      input.current?.measureInWindow((_x, y, _w, h) => {
        const inputBottom = Math.round(y + h);
        const report = (lastBottom: number | null) => {
          const fits = top !== null && inputBottom <= top && (lastBottom === null || lastBottom <= top);
          setGeometry(`geometry ${fits ? "ok" : "FAILED"}: keyboard top ${top === null ? "none" : Math.round(top)}, box bottom ${inputBottom}, last row bottom ${lastBottom ?? "n/a"}`);
        };
        if (id === "tall" || !last.current) report(null);
        else last.current.measureInWindow((_lx, ly, _lw, lh) => report(Math.round(ly + lh)));
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [open, id]);
  return (
    <>
      <View ref={anchor} collapsable={false} style={styles.anchor}>
        <Button size="sm" label={id === "bottom" ? "Bottom popover" : "Tall popover"} testID={`sheets-${id}-open`} onPress={() => setOpen(true)} />
      </View>
      <Popover open={open} onClose={() => setOpen(false)} label={`Popover ${id}`} anchor={anchor} up testID={`sheets-${id}-popover`}>
        <Text size={11} tone="muted" testID={`sheets-${id}-geometry`}>{geometry}</Text>
        <TextInput ref={input} testID={`sheets-${id}-input`} autoFocus placeholder="Search models" placeholderTextColor={t.faint} autoCorrect={false} autoCapitalize="none"
          style={[styles.search, { color: t.text, borderColor: t.line2, backgroundColor: t.bg }]} />
        <Menu label={`Rows ${id}`}>
          {Array.from({ length: rows }, (_, i) => i === rows - 1 ? (
            <View key={i} ref={last} collapsable={false}>
              <MenuItem label={`Row ${i + 1} (last)`} testID={`sheets-${id}-last`} onPress={() => { say(`${id} last picked`); setOpen(false); }} />
            </View>
          ) : <MenuItem key={i} label={`Row ${i + 1}`} testID={`sheets-${id}-row-${i + 1}`} onPress={() => { say(`${id} row ${i + 1} picked`); setOpen(false); }} />)}
        </Menu>
      </Popover>
    </>
  );
}

/** The composer's picker, as the app opens it (`screens/composer/Picker.tsx`): an `Overlay` declared here, at the top of the screen, with a text box that has the
 *  focus when it opens and `rows` rows. The control that opens it is the popover's anchor (`topkb`'s is over a text box that has the keyboard already).
 *  `GEOMETRY_MS` after it opened, with nothing typed, it measures the box and its surface against the keyboard's top: the one `keyboardDidShow` reported since it
 *  opened, or, when the keyboard was up before and no such event comes, the keyboard's frame now (`Keyboard.metrics()`). The box is controlled, as the picker's search
 *  is: on iOS a sheet whose box took the focus as it opened was drawn off-screen until the next render, and the flow's wait for `sheets-<id>-input` fails then (Maestro
 *  reads the native views), while the `geometry` line, which reads the layout and not where the view was drawn, says `ok`. The measure comes late, and the flow waits
 *  for the box before it: its own render brings a lost sheet back.
 *  The sheet rises over `RISE_MS` here, so that its rise ends in the middle of the keyboard's animation (`useKeyboardAvoid` ran a LayoutAnimation of the keyboard's
 *  duration, and the sheet was lost when its rise ended in it; the default 180 ms ends near the start of that window) (`sheetTiming`: set as the control is pressed,
 *  put back as the overlay closes). */
function TopOverlay({ id, kind, label, say }: { id: "toppop" | "topdlg" | "topkb"; kind: "popover" | "dialog"; label: string; say(s: string): void }) {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [geometry, setGeometry] = useState("geometry: waiting");
  const [query, setQuery] = useState(""); // controlled, as the picker's search is
  const anchor = useRef<View>(null);
  const input = useRef<TextInput>(null);
  const surface = useRef<View>(null);
  const keyboardTop = useRef<number | null>(null);
  const normalRise = useRef<number | null>(null);
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", (e) => { keyboardTop.current = e.endCoordinates.screenY; });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (open || normalRise.current === null) return;
    sheetTiming.riseMs = normalRise.current;
    normalRise.current = null;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    keyboardTop.current = null;
    setQuery("");
    setGeometry("geometry: waiting");
    // the keyboard is up and the overlay has settled above it
    const timer = setTimeout(() => {
      const top = keyboardTop.current ?? Keyboard.metrics()?.screenY ?? null;
      input.current?.measureInWindow((_x, y, _w, h) => {
        const boxBottom = Math.round(y + h);
        surface.current?.measureInWindow((_sx, sy, _sw, sh) => {
          const fits = top !== null && boxBottom <= top;
          setGeometry(`geometry ${fits ? "ok" : "FAILED"}: keyboard top ${top === null ? "none" : Math.round(top)}, box bottom ${boxBottom}, surface top ${Math.round(sy)}, surface bottom ${Math.round(sy + sh)}`);
        });
      });
    }, GEOMETRY_MS);
    return () => clearTimeout(timer);
  }, [open]);
  const close = () => setOpen(false);
  return (
    <>
      <View ref={anchor} collapsable={false} style={styles.anchor}>
        <Button size="sm" label={label} testID={`sheets-${id}-open`} onPress={() => { normalRise.current = sheetTiming.riseMs; sheetTiming.riseMs = RISE_MS; setOpen(true); }} />
      </View>
      <Overlay open={open} onClose={close} label={label} kind={kind} anchor={anchor} up testID={`sheets-${id}-overlay`}>
        <View ref={surface} collapsable={false}>
          <Text size={11} tone="muted" testID={`sheets-${id}-geometry`}>{geometry}</Text>
          <TextInput ref={input} testID={`sheets-${id}-input`} autoFocus value={query} onChangeText={setQuery} placeholder="Search models" placeholderTextColor={t.faint} autoCorrect={false} autoCapitalize="none"
            style={[styles.search, { color: t.text, borderColor: t.line2, backgroundColor: t.bg }]} />
          <Menu label={`Rows ${id}`}>
            {Array.from({ length: 6 }, (_, i) => (
              <MenuItem key={i} label={`Row ${i + 1}`} testID={`sheets-${id}-row-${i + 1}`} onPress={() => { say(`${id} row ${i + 1} picked`); close(); }} />
            ))}
          </Menu>
        </View>
      </Overlay>
    </>
  );
}

/** `sheets-topkb`: a text box at the bottom of the screen, which the test focuses first, and a button just over it, still above the keyboard, that opens the overlay
 *  (the composer's box with the insert popup's button). The bar rises with the keyboard as the composer does (`platform/keyboard`'s KeyboardLift). */
function TopKb({ say }: { say(s: string): void }) {
  const { tokens: t } = useTheme();
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const ios = Platform.OS === "ios";
    const move = (e: { endCoordinates: { height: number } }) => setLift(Math.max(0, e.endCoordinates.height));
    const subs = ios
      ? [Keyboard.addListener("keyboardWillChangeFrame", move), Keyboard.addListener("keyboardWillHide", () => setLift(0))]
      : [Keyboard.addListener("keyboardDidShow", move), Keyboard.addListener("keyboardDidHide", () => setLift(0))];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return (
    <View style={[styles.kbBar, { bottom: lift || KB_REST }]}>
      <TopOverlay id="topkb" kind="dialog" label="Open over the keyboard" say={say} />
      <TextInput testID="sheets-topkb-box" placeholder="Message" placeholderTextColor={t.faint} autoCorrect={false} autoCapitalize="none"
        style={[styles.search, styles.box, { color: t.text, borderColor: t.line2, backgroundColor: t.bg }]} />
    </View>
  );
}

type Where = "out" | "in";
type Kind = "menu" | "dialog" | "sheet";

/** The popups declared beside the form sheet, which its buttons open (the form sheet is drawn where they are declared: the root). */
const OutContext = createContext<(k: Kind) => void>(() => {});

/** One set of the three popups, with the buttons that open them: `node` goes where the popups are declared. */
function usePopups(where: Where, say: (s: string) => void) {
  const [shown, setShown] = useState<Kind | null>(null);
  const [text, setText] = useState("");
  const anchor = useRef<View>(null);
  const close = () => setShown(null);
  const node = (
    <>
      <Popover open={shown === "menu"} onClose={close} label={`Menu ${where}`} anchor={anchor}>
        <Menu label={`Menu ${where}`}>
          <MenuItem label={`Pick ${where}`} testID={`sheets-menu-pick-${where}`} onPress={() => { say(`menu-${where} picked`); close(); }} />
        </Menu>
      </Popover>
      <Dialog open={shown === "dialog"} onClose={close} label={`Dialog ${where}`} closeOnBackdrop={false}>
        <DialogTitle>{`Dialog ${where}`}</DialogTitle>
        <Field label="Note" field={`dialog-${where}`} value={text} onChangeText={setText} />
        <DialogActions>
          <Button size="sm" label="Cancel" onPress={close} />
          <Button size="sm" tone="primary" label="Save note" testID={`sheets-dialog-save-${where}`} onPress={() => { say(`dialog-${where} saved ${text}`); close(); }} />
        </DialogActions>
      </Dialog>
      <Sheet open={shown === "sheet"} onClose={close} label={`Second sheet ${where}`} testID={`sheets-second-${where}`}>
        <Text weight="600">{`Second sheet ${where}`}</Text>
        <View style={styles.row}><Button size="sm" label="Close second" testID={`sheets-second-close-${where}`} onPress={() => { say(`sheet-${where} closed`); close(); }} /></View>
      </Sheet>
    </>
  );
  return { node, anchor, show: setShown };
}

function FormSheet({ open, onClose, say, log }: { open: boolean; onClose(): void; say(s: string): void; log: string }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [secret, setSecret] = useState("");
  const showOut = useContext(OutContext);
  const inn = usePopups("in", say);
  return (
    <Sheet open={open} onClose={onClose} label="Form sheet" closeOnBackdrop={false}>
      <Text weight="600" testID="sheets-title">Form sheet</Text>
      <Field {...PLAIN_INPUT} label="Name" field="name" value={name} onChangeText={setName} placeholder="Studio" returnKeyType="go" onSubmitEditing={() => say("submit")} />
      <Field {...PLAIN_INPUT} label="Address" field="address" value={address} spellCheck={false} autoCapitalize="none" autoCorrect={false} keyboardType="url" onChangeText={setAddress} returnKeyType="go" onSubmitEditing={() => say("submit")} />
      <Field {...SECRET_INPUT} label="Secret" field="secret" value={secret} onChangeText={setSecret} returnKeyType="go" onSubmitEditing={() => say("submit")} />
      <View style={styles.row}>
        <Button size="sm" label="Menu out" testID="sheets-menu-out" onPress={() => showOut("menu")} />
        <Button size="sm" label="Dialog out" testID="sheets-dialog-out" onPress={() => showOut("dialog")} />
        <Button size="sm" label="Sheet out" testID="sheets-sheet-out" onPress={() => showOut("sheet")} />
      </View>
      <View ref={inn.anchor} style={styles.row}>
        <Button size="sm" label="Menu in" testID="sheets-menu-in" onPress={() => inn.show("menu")} />
        <Button size="sm" label="Dialog in" testID="sheets-dialog-in" onPress={() => inn.show("dialog")} />
        <Button size="sm" label="Sheet in" testID="sheets-sheet-in" onPress={() => inn.show("sheet")} />
      </View>
      <Text size={11} tone="muted" testID="sheets-secret-value">{`secret: ${secret}`}</Text>
      <Text size={11} tone="muted" testID="sheets-log" style={styles.log}>{log}</Text>
      <DialogActions>
        <Button size="sm" label="Save form" testID="sheets-save" onPress={() => say(`saved ${name}|${address}|${secret}`)} />
        <Button size="sm" tone="primary" label="Done" testID="sheets-done" onPress={() => { setSecret(""); onClose(); }} />
      </DialogActions>
      {inn.node}
    </Sheet>
  );
}

export function SheetsSelfTest() {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <ThemeProvider><Screen /></ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Screen() {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const say = (s: string) => setEvents((e) => [...e, s]);
  const out = usePopups("out", say);
  const log = `log: ${events.length ? events.join(" | ") : "none"}`;
  return (
    <View style={[styles.root, { backgroundColor: t.bg }]} testID="sheets-root">
      <Text weight="600" size={18}>Sheets self-test</Text>
      <View ref={out.anchor} style={styles.row}>
        <Button label="Open the form sheet" testID="sheets-open" onPress={() => setOpen(true)} />
      </View>
      <Text testID="sheets-state">{open ? "sheet: open" : "sheet: closed"}</Text>
      <Text testID="sheets-root-log">{log}</Text>
      <View style={styles.bottomBar}>
        <BottomPopover id="bottom" rows={8} say={say} />
        <BottomPopover id="tall" rows={60} say={say} />
        <TopOverlay id="toppop" kind="popover" label="Top popover" say={say} />
        <TopOverlay id="topdlg" kind="dialog" label="Top dialog" say={say} />
      </View>
      <TopKb say={say} />
      <OutContext.Provider value={out.show}>
        <FormSheet open={open} onClose={() => { setOpen(false); say("form closed"); }} say={say} log={log} />
      </OutContext.Provider>
      {out.node}
    </View>
  );
}

const KB_REST = 200;
/** When a top-level overlay measures itself, and how long its sheet takes to rise (see `TopOverlay`). */
const GEOMETRY_MS = 6000;
const RISE_MS = 300;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  root: { flex: 1, paddingTop: 70, paddingHorizontal: 16, gap: 10 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  log: { marginTop: 10 },
  bottomBar: { position: "absolute", left: 16, right: 16, bottom: 28, gap: 6 },
  /** Where the `topkb` bar rests with no keyboard: over the bottom bar's buttons. */
  kbBar: { position: "absolute", left: 16, right: 16, gap: 6 },
  anchor: { alignSelf: "flex-start" },
  box: { margin: 0 },
  search: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, margin: 4, fontSize: 15 },
});
