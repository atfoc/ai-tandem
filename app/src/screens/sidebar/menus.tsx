// The menus of the sidebar: a row's or a head's "…" (a list of items, one of which may open a second list in the menu's place), a
// "+" that offers what can be made there, and the board row's "+", which makes a chat at once. Each is a popover on the wide layouts
// and a sheet on the phone (ui/Overlay); its button shows under the pointer, or always with a finger (parts.tsx Hover).
import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { IconButton } from "../../ui/IconButton.tsx";
import { MoreIcon } from "../../ui/icons.tsx";
import { Menu, MenuHead, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { tid } from "../../ui/tid.ts";
import { Hover, useSideHidden, Text } from "./parts.tsx";

/** Runs what a menu's pick does once the menu is gone: a second modal (the confirm dialog) cannot rise while the first goes on iOS. On web the pick is
 *  run at once: the menu's overlay leaves a focus that is outside it alone, so what the pick focuses (a rename box) keeps it. */
export const later = (run: () => void): void => { if (Platform.OS === "web") run(); else setTimeout(run, 60); };

export type RowItem = { label: string; run: () => void; tone?: "danger" };

/** The items of a menu stand in a press that goes no further: a press on the menu's own ground is no press on the row it hangs from. */
export function Still({ children }: { children: ReactNode }) {
  return <Pressable accessible={false} focusable={false}>{children}</Pressable>;
}

/** sub: the item opens a second list in the menu's place ("Move to…": the groups). */
export function RowMenu({ items, label, hovered }: { items: (RowItem & { sub?: RowItem[] })[]; label: string; hovered: boolean }) {
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<RowItem[] | null>(null);
  const anchor = useRef<View>(null);
  const close = () => { setOpen(false); setSub(null); };
  const hidden = useSideHidden(close, open);
  return (
    <Hover shown={hovered || open}>
      <View ref={anchor} collapsable={false}>
        <IconButton {...tid("side-more")} size="sm" title={label} on={open} onPress={() => (open ? close() : setOpen(true))}>
          {(color) => <MoreIcon color={color} />}
        </IconButton>
      </View>
      {open && !hidden && (
        <Overlay open onClose={close} label={label} kind="popover" anchor={anchor} align="right">
          <Still>
            <Menu>
              {sub
                ? sub.map((it, i) => <MenuItem key={i} label={it.label} title={it.label} onPress={() => { close(); later(it.run); }} />)
                : items.map((it) => <MenuItem key={it.label} label={it.label} tone={it.tone} onPress={() => { if (it.sub) return setSub(it.sub); close(); later(it.run); }} />)}
            </Menu>
          </Still>
        </Overlay>
      )}
    </Hover>
  );
}

/** A "+" that opens a menu headed `head`; children draw the items and are given the function that closes it. */
export function AddMenu({ title, head, hovered, children }: { title: string; head: string; hovered: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  const close = () => setOpen(false);
  const hidden = useSideHidden(close, open);
  return (
    <Hover shown={hovered || open}>
      <View ref={anchor} collapsable={false}>
        <IconButton {...tid("side-add")} size="sm" title={title} on={open} onPress={() => setOpen(!open)}>
          {(color) => <Text size={15} style={{ color, marginTop: -1 }}>+</Text>}
        </IconButton>
      </View>
      {open && !hidden && (
        <Overlay open onClose={close} label={title} kind="popover" anchor={anchor} align="right">
          <Still>
            <Menu>
              <MenuHead>{head}</MenuHead>
              {children(close)}
            </Menu>
          </Still>
        </Overlay>
      )}
    </Hover>
  );
}

/** A board row's "+", which makes a chat at once: AddMenu's button with no menu. */
export function AddChat({ title, hovered, onPress }: { title: string; hovered: boolean; onPress: () => void }) {
  return (
    <Hover shown={hovered}>
      <IconButton {...tid("side-add")} size="sm" title={title} onPress={onPress}>
        {(color) => <Text size={15} style={{ color, marginTop: -1 }}>+</Text>}
      </IconButton>
    </Hover>
  );
}
