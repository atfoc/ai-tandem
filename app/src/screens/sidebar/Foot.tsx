// The foot of the sidebar: "Show archived" (one switch for every section), the Servers button (S3's), the prompt library's button, the
// Settings button (voice's) and the theme's picker, in that order (the old page's Sidebar.tsx, Library.tsx LibraryButton). The library's dialog is drawn by its own screen (S11) from
// the store's `libraryDialog`.
import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { themeMenu, themeTitle, type ThemePref } from "@aiwb/core/logic/theme.ts";
import { safeSet, setState } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { CupIcon, MoonIcon, SunIcon, SystemIcon } from "../../ui/icons.tsx";
import { Menu, MenuHead, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { SwitchLook } from "../../ui/Switch.tsx";
import { useTheme, useTokens } from "../../ui/theme.tsx";
import { tid, type DataSet } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { ServersButton } from "../servers";
import { SettingsButton } from "../voice/SettingsButton.tsx";
import { useSideHidden, Text } from "./parts.tsx";

export function Foot() {
  const t = useTokens();
  const showArchived = useStore((s) => s.showArchived);
  const set = (on: boolean) => { setState({ showArchived: on }); safeSet("aiwb.archived", on ? "1" : "0"); };
  return (
    <View {...tid("side-foot")} style={[styles.foot, { borderTopColor: t.line }]}>
      <Pressable {...tid("side-archived")} role="switch" aria-checked={showArchived} accessibilityState={{ checked: showArchived }} aria-label="Show archived"
        style={styles.archived} onPress={() => set(!showArchived)}>
        <SwitchLook on={showArchived} testID="side-switch" knobTestID="side-knob" />
        <Text size={12} tone="muted" numberOfLines={1}>Show archived</Text>
      </Pressable>
      <ServersButton />
      <View style={styles.end}><LibraryButton /><SettingsButton /><ThemePicker /></View>
    </View>
  );
}

/** A square button of the foot (`.servers-btn`, `.library-btn`): bordered, 28 × 26. */
function FootButton({ title, children, ...rest }: { title: string; children: React.ReactNode; testID: string; dataSet?: DataSet; onPress: () => void; "aria-haspopup"?: "dialog" }) {
  const t = useTokens();
  const tip = useControlRef(title);
  return (
    <Pressable {...rest} ref={tip} accessibilityRole="button" accessibilityLabel={title}
      style={[styles.footButton, { borderColor: t.line, backgroundColor: t.bg }, webStyle({ cursor: "pointer" })]}>
      {children}
    </Pressable>
  );
}

function LibraryButton() {
  const t = useTokens();
  return (
    <FootButton {...tid("library-btn")} title="Prompt library" aria-haspopup="dialog" onPress={() => setState({ libraryDialog: {} })}>
      <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={t.muted} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M3 2.5h8.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z" /><Path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H13M6 5.5h4M6 8h2.5" />
      </Svg>
    </FootButton>
  );
}

const THEME_ICONS: Record<ThemePref, (p: { color?: string }) => React.JSX.Element> = {
  light: SunIcon, dark: MoonIcon, system: SystemIcon, latte: CupIcon, frappe: CupIcon, macchiato: CupIcon, mocha: CupIcon,
};

/** The theme's picker: one button, which shows the choice's icon, and a menu that opens upward with the three themes and the four
 *  Catppuccin flavours (logic/theme.ts themeMenu), the choice marked and, as the menu opens, focused. The arrow keys, Home and End
 *  move through it (ui/Menu); a pick or Esc closes it and the focus is on the button again. */
function ThemePicker() {
  const t = useTokens();
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  const title = themeTitle(pref);
  const tip = useControlRef(title);
  const close = () => setOpen(false);
  const hidden = useSideHidden(close, open);
  const Icon = THEME_ICONS[pref];
  return (
    <View ref={anchor} collapsable={false}>
      <Pressable {...tid("theme-btn", { open })} ref={tip} accessibilityRole="button" accessibilityLabel={title} aria-haspopup="menu" aria-expanded={open}
        accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={[styles.themeButton, { borderColor: t.line, backgroundColor: t.bg }, webStyle({ cursor: "pointer" })]}>
        <Icon color={t.muted} />
        <Text size={9} tone="muted">▾</Text>
      </Pressable>
      {open && !hidden && (
        <Overlay open onClose={close} label="Theme" kind="popover" anchor={anchor} align="right" up>
          <Menu label="Theme" testID="theme-menu" minWidth={168}>
            {themeMenu(pref).map((g) => (
              <View key={g.head}>
                <MenuHead>{g.head}</MenuHead>
                {g.items.map((it) => {
                  const ItemIcon = THEME_ICONS[it.pref];
                  return (
                    <MenuItem key={it.pref} choice selected={it.on} autoFocus={it.on} dataSet={{ themePref: it.pref }} label={it.label}
                      icon={<ItemIcon color={it.on ? t.accent : t.muted} />} trailing={it.on ? <Text tone="accent">✓</Text> : null}
                      onPress={() => { setPref(it.pref); close(); }} />
                  );
                })}
              </View>
            ))}
          </Menu>
        </Overlay>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, rowGap: 6, paddingVertical: 7, paddingRight: 10, paddingLeft: 14, borderTopWidth: 1 },
  archived: { flexGrow: 1, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  footButton: { width: 28, height: 26, borderWidth: 1, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dot: { position: "absolute", top: -3, right: -3, width: 7, height: 7, borderRadius: 4 },
  end: { flexShrink: 0, flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, minWidth: 74, marginLeft: "auto" },
  themeButton: { height: 26, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 7, paddingRight: 6, borderWidth: 1, borderRadius: 7, flexShrink: 0 },
});
