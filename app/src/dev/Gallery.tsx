// The gallery of the primitives of ui/ (package U2): every one of them drawn on one page for the browser checks
// (web/dev/checks/L1-primitives.mjs). The web build shows it when the URL has `?gallery` (App.tsx); it is not part of
// any screen. Everything a check reads has a testID (AD-80); the readouts say what was pressed, the layout and the
// pointer the primitives see, the width the resizer reports and the last key the keys port gave.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";

import { MIN_STAGE, PANES } from "@aiwb/core/logic/layout.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";
import { onKey } from "../platform/keys";
import { Picture } from "../platform/picture";
import { ChipGallery } from "./ChipGallery.tsx";
import { MarkdownGallery } from "./MarkdownGallery.tsx";
import { Button } from "../ui/Button.tsx";
import { Dialog, DialogActions, DialogBody, DialogTitle } from "../ui/Dialog.tsx";
import { IconButton } from "../ui/IconButton.tsx";
import { BoardIcon, ChatIcon, MoonIcon, MoreIcon, SideIcon, SunIcon } from "../ui/icons.tsx";
import { Menu, MenuEmpty, MenuGroupHead, MenuHead, MenuItem, MenuSep } from "../ui/Menu.tsx";
import { Overlay } from "../ui/Overlay.tsx";
import { Popover } from "../ui/Popover.tsx";
import { ToolCard } from "../screens/tools/ToolCard.tsx";
import { Resizer } from "../ui/Resizer.tsx";
import { Sheet } from "../ui/Sheet.tsx";
import { Text } from "../ui/Text.tsx";
import { useTheme } from "../ui/theme.tsx";
import { useLayout } from "../ui/useLayout.ts";
import { usePointer } from "../ui/usePointer";

const SWATCH = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#6965db"/><circle cx="24" cy="24" r="12" fill="#fff"/></svg>');

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { tokens: t } = useTheme();
  return (
    <View style={[styles.section, { borderColor: t.line }]}>
      <Text weight="600" tone="muted" size={11} style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** A tool call whose item cannot be drawn (reading its input throws), then the same call as it is once it is mended: a different item, so
 *  the card's fence (shell/Guard.tsx, resetKey) draws it again. */
const BROKEN = { kind: "tool", toolId: "gallery-tool", name: "Bash", get input(): unknown { throw new Error("The input of this call is broken."); } } as unknown as Item;
const MENDED = { kind: "tool", toolId: "gallery-tool", name: "Bash", input: { command: "ls" }, result: "a b c" } as unknown as Item;
const CARD_CHAT = { id: "gallery-chat", cwd: "/tmp" } as unknown as ChatView;
/** The section is drawn only when asked for, `/?gallery&fence` (L1): the fence logs what it caught, and the other checks of the gallery fail on a
 *  console error. */
const FENCE = Platform.OS === "web" && new URLSearchParams(window.location.search).has("fence");

/** The items every overlay of the gallery holds: a menu, as the pages' popups are. */
function Items({ pick, close, confirm }: { pick(what: string): void; close(): void; confirm(): void }) {
  const [on, setOn] = useState("light");
  return (
    <Menu label="Gallery menu">
      <MenuHead>Choices</MenuHead>
      {["light", "dark"].map((v) => (
        <MenuItem key={v} choice selected={on === v} label={v === "light" ? "Light" : "Dark"} testID="gallery-choice"
          icon={v === "light" ? <SunIcon /> : <MoonIcon />} onPress={() => { setOn(v); pick(`choice ${v}`); }} />
      ))}
      <MenuSep />
      <MenuGroupHead>Actions</MenuGroupHead>
      <MenuItem label="New chat" icon={<ChatIcon />} onPress={() => { pick("new chat"); close(); }} />
      <MenuItem label="New whiteboard" icon={<BoardIcon />} onPress={() => { pick("new whiteboard"); close(); }} />
      <MenuItem label="Not available" disabled onPress={() => pick("disabled")} />
      <MenuItem label="Delete…" tone="danger" onPress={confirm} />
    </Menu>
  );
}

export function Gallery() {
  const { tokens: t, theme, setPref } = useTheme();
  const win = useWindowDimensions();
  const layout = useLayout();
  const pointer = usePointer();
  const [last, setLast] = useState("");
  const [key, setKey] = useState("");
  const [open, setOpen] = useState<"" | "overlay-menu" | "overlay-dialog" | "popover" | "dialog" | "sheet">("");
  const [confirm, setConfirm] = useState(false);
  const [width, setWidth] = useState(PANES.side.def);
  const [saved, setSaved] = useState(0);
  const [mended, setMended] = useState(false);
  const menuAnchor = useRef<View>(null), popAnchor = useRef<View>(null);
  const close = () => setOpen("");

  useEffect(() => onKey((e) => setKey(`${e.key}${e.metaKey ? "+meta" : ""}${e.ctrlKey ? "+ctrl" : ""}`)), []);

  const items = <Items pick={setLast} close={close} confirm={() => setConfirm(true)} />;
  return (
    <ScrollView testID="gallery" style={{ backgroundColor: t.bg }} contentContainerStyle={styles.page}>
      <Text size={18} weight="600">Gallery</Text>
      <View style={styles.row}>
        <Text testID="gallery-layout" dataSet={{ layout }}>{layout}</Text>
        <Text testID="gallery-pointer" tone="muted">{pointer}</Text>
        <Text testID="gallery-window" tone="faint">{`${Math.round(win.width)}×${Math.round(win.height)}`}</Text>
        <Text testID="gallery-theme" tone="faint">{theme}</Text>
        <Button size="sm" label="Light" testID="gallery-theme-light" onPress={() => setPref("light")} />
        <Button size="sm" label="Dark" testID="gallery-theme-dark" onPress={() => setPref("dark")} />
      </View>

      <Section title="Text">
        <Text>Body text, 13 px over 1.45.</Text>
        <Text tone="muted">Muted text.</Text>
        <Text tone="faint">Faint text.</Text>
        <Text tone="accent">Accent text.</Text>
        <Text tone="danger">Danger text.</Text>
        <Text mono size={12}>const mono = "mono";</Text>
      </Section>

      <Section title="Buttons">
        <View style={styles.row}>
          <Button label="Default" testID="gallery-btn" onPress={() => setLast("default")} />
          <Button label="Primary" tone="primary" onPress={() => setLast("primary")} />
          <Button label="Danger" tone="danger" onPress={() => setLast("danger")} />
          <Button label="Ghost" tone="ghost" onPress={() => setLast("ghost")} />
          <Button label="Small" size="sm" onPress={() => setLast("small")} />
          <Button label="With icon" icon={<ChatIcon />} onPress={() => setLast("icon")} />
          <Button label="Disabled" disabled testID="gallery-btn-disabled" onPress={() => setLast("disabled button")} />
        </View>
        <View style={styles.row}>
          <IconButton title="Hide the sidebar" testID="gallery-icon-btn" onPress={() => setLast("icon button")}>{(c) => <SideIcon color={c} />}</IconButton>
          <IconButton title="More" size="sm" onPress={() => setLast("small icon button")}>{(c) => <MoreIcon color={c} />}</IconButton>
          <IconButton title="New" filled onPress={() => setLast("new")}>{(c) => <ChatIcon color={c} />}</IconButton>
        </View>
        <Text testID="gallery-last" tone="muted">{last}</Text>
      </Section>

      <Section title="Overlays (by the layout)">
        <View style={styles.row}>
          <View ref={menuAnchor} collapsable={false}>
            <Button label="Overlay menu" testID="gallery-open-overlay-menu" onPress={() => setOpen("overlay-menu")} />
          </View>
          <Button label="Overlay dialog" testID="gallery-open-overlay-dialog" onPress={() => setOpen("overlay-dialog")} />
        </View>
      </Section>

      <Section title="Overlays (each form)">
        <View style={styles.row}>
          <View ref={popAnchor} collapsable={false}>
            <Button label="Popover" testID="gallery-open-popover" onPress={() => setOpen("popover")} />
          </View>
          <Button label="Dialog" testID="gallery-open-dialog" onPress={() => setOpen("dialog")} />
          <Button label="Sheet" testID="gallery-open-sheet" onPress={() => setOpen("sheet")} />
        </View>
        <TextInput testID="gallery-input" placeholder="A field outside the overlays" placeholderTextColor={t.faint}
          style={[styles.input, { borderColor: t.line2, color: t.text }]} />
      </Section>

      <Section title="Resizer">
        <View style={styles.pane}>
          <View testID="gallery-pane" style={[styles.paneBody, { width, backgroundColor: t.panel, borderColor: t.line }]}>
            <Text tone="muted">Pane</Text>
            <Resizer pane="side" width={width} room={400} onResize={(w, final) => { setWidth(w); if (final) setSaved(w); }} />
          </View>
          <View style={[styles.stage, { backgroundColor: t.bg }]}><Text tone="faint">Stage (the pane stops at 400, MIN_STAGE {MIN_STAGE})</Text></View>
        </View>
        <Text testID="gallery-pane-width" tone="muted">{String(width)}</Text>
        <Text testID="gallery-pane-saved" tone="faint">{String(saved)}</Text>
      </Section>

      <Section title="Keys">
        <Text testID="gallery-key" tone="muted">{key}</Text>
      </Section>

      <Section title="Picture">
        <View style={styles.row}>
          <Picture server="local" chat="c1" image="i1" name="Swatch" uri={SWATCH} style={{ width: 48, height: 48, borderRadius: 6 }} />
          <Picture server="local" chat="c1" image="missing" name="Missing image" style={{ width: 96, height: 48 }} />
        </View>
      </Section>

      <Section title="Chip input">
        <ChipGallery />
      </Section>

      <Section title="Markdown">
        <MarkdownGallery />
      </Section>

      {FENCE && (
        <Section title="Guard (a tool card that cannot be drawn)">
          <ToolCard item={mended ? MENDED : BROKEN} chat={CARD_CHAT} />
          <Button size="sm" label={mended ? "Break it" : "Mend it"} testID="gallery-guard-toggle" onPress={() => setMended(!mended)} />
          <Text testID="gallery-guard-after" tone="faint">Drawn after the card.</Text>
        </Section>
      )}

      <Section title="Empty menu">
        <View style={{ width: 200 }}><Menu><MenuEmpty>Nothing here</MenuEmpty></Menu></View>
      </Section>

      <Overlay open={open === "overlay-menu"} onClose={close} label="Overlay menu" kind="popover" anchor={menuAnchor}>{items}</Overlay>
      <Overlay open={open === "overlay-dialog"} onClose={close} label="Overlay dialog" kind="dialog">
        <DialogTitle>Overlay dialog</DialogTitle>
        <DialogBody>A dialog on tablet and desktop, a sheet on the phone.</DialogBody>
        <DialogActions>
          <Button size="sm" label="Cancel" testID="gallery-dialog-cancel" onPress={close} />
          <Button size="sm" tone="primary" label="Ok" testID="gallery-dialog-ok" autoFocus onPress={() => { setLast("ok"); close(); }} />
        </DialogActions>
      </Overlay>
      <Popover open={open === "popover"} onClose={close} label="Popover" anchor={popAnchor}>{items}</Popover>
      <Dialog open={open === "dialog"} onClose={close} label="Dialog">
        <DialogTitle>Dialog</DialogTitle>
        <DialogBody>Always a dialog.</DialogBody>
        <DialogActions>
          <Button size="sm" label="Cancel" testID="gallery-dialog-cancel" onPress={close} />
          <Button size="sm" tone="primary" label="Ok" testID="gallery-dialog-ok" autoFocus onPress={() => { setLast("ok"); close(); }} />
        </DialogActions>
      </Dialog>
      <Sheet open={open === "sheet"} onClose={close} label="Sheet">{items}</Sheet>
      <Dialog open={confirm} onClose={() => setConfirm(false)} label="Delete this?">
        <DialogTitle>Delete this?</DialogTitle>
        <DialogActions>
          <Button size="sm" label="Cancel" testID="gallery-confirm-cancel" onPress={() => setConfirm(false)} />
          <Button size="sm" tone="danger" label="Delete" testID="gallery-confirm-ok" autoFocus onPress={() => { setLast("deleted"); setConfirm(false); }} />
        </DialogActions>
      </Dialog>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  section: { borderTopWidth: 1, paddingTop: 8, gap: 6 },
  sectionTitle: { textTransform: "uppercase", letterSpacing: 0.4 },
  input: { borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8, alignSelf: "flex-start", minWidth: 220 },
  pane: { flexDirection: "row", height: 80 },
  paneBody: { borderWidth: 1, padding: 8, position: "relative" },
  stage: { flex: 1, padding: 8 },
});
