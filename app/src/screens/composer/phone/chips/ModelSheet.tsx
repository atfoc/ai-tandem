// The Model and effort menu on the phone (plans/model-effort-menu/design.md 2.1, 2.6; ux-improvements goal 3.6, mockup "03 The pickers" co-03a,
// caption co-03e): the same menu as the desktop's popover (../../ModelEffortMenu.tsx), as a sheet. Its pinned head holds the SheetHead (Cancel at
// the left, the title "Model and effort" over the sub-line "<chat's name> · <agent>", Done at the right), the held line, the search field and the
// effort (a segmented control and one line on what effort costs); the list of models is the sheet's scrolling body: 50-pt rows with the model's
// name and a second line of its note and its context size, under provider headings when the catalog names more than one (pi). Large detent past
// eight models, else `fit`. A tap on a row or a segment changes the draft only; Done applies it (the caller: a session's PATCH, a fork's restart
// or a pending move's choice), Cancel, a swipe and the dimmed page close and apply nothing.
import { StyleSheet, View } from "react-native";

import type { ChatView } from "@aiwb/core/types.ts";

import { Menu } from "../../../../ui/Menu.tsx";
import { Sheet } from "../../../../ui/Sheet.tsx";
import { SheetHead } from "../../../../ui/SheetHead.tsx";
import { useTokens } from "../../../../ui/theme.tsx";
import { EffortSection, HeldLine, MENU_IDS, MODEL_MENU_TITLE, MenuField, ModelList, useModelEffortMenu, type ModelEffortMenuProps } from "../../ModelEffortMenu.tsx";
import { C2_IDS } from "./ids.ts";

export type ModelSheetProps = ModelEffortMenuProps & {
  c: ChatView;
  /** "<chat's name> · <agent's name>". */
  sub: string;
};

export function ModelSheet(p: ModelSheetProps) {
  const t = useTokens();
  const menu = useModelEffortMenu(p);
  const head = (
    <View style={[styles.head, { borderBottomColor: t.line }]}>
      <SheetHead title={MODEL_MENU_TITLE} sub={p.sub} left={{ label: "Cancel", onPress: p.onClose, testID: MENU_IDS.cancel }}
        right={{ label: "Done", strong: true, onPress: menu.apply, disabled: !menu.ok, testID: MENU_IDS.done }} />
      <HeldLine menu={menu} phone />
      <MenuField menu={menu} phone />
      <EffortSection menu={menu} phone />
    </View>
  );
  return (
    <Sheet open={p.open} onClose={p.onClose} label={MODEL_MENU_TITLE} testID={C2_IDS.modelSheet} detent={p.cat.models.length > 8 ? "large" : "fit"} head={head}
      scrollRef={menu.list.scroll} onScroll={menu.list.onScroll} onViewport={menu.list.onViewport}>
      <Menu label="Models">
        <ModelList menu={menu} phone />
      </Menu>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { borderBottomWidth: StyleSheet.hairlineWidth },
});
