// The routes of the screens pushed over the rest (a registered screen, an overlay of kind "screen") and of the subagent drawer.
import { useRef, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";

import { PlaceBar } from "../../../ui/Bars.tsx";
import { useStore } from "../../../state/useStore.ts";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { NavBack } from "../BackButton.tsx";
import { OVERLAY, pushedScreens, screenSpec, subscribePushed, usePushedContent, type Pushed, type ScreenSpec } from "../screens.ts";
import { useSlots } from "../slots.tsx";
import { F2_TID } from "./ids.ts";

/** The pushed screen `entry` now; the last one seen while it slides out, when it is already gone. */
function usePushed(entry: string): Pushed | null {
  const now = useSyncExternalStore(subscribePushed, pushedScreens, pushedScreens).find((p) => p.key === entry);
  const last = useRef<Pushed | null>(null);
  if (now) last.current = now;
  return last.current;
}

export function PushedRoute({ entry }: { entry: string }) {
  const { tokens: t } = useTheme();
  const p = usePushed(entry);
  const content = usePushedContent(entry);
  const spec = !p || p.name === OVERLAY ? undefined : (screenSpec(p.name) as ScreenSpec<unknown> | undefined);
  // The title follows the store: a spec's title may read the state (a server's name), so a rename shows in the bar at once.
  const title = useStore(() => (spec && p ? spec.title(p.params) : p?.title ?? ""));
  if (!p) return <View style={[styles.fill, { backgroundColor: t.bg }]} />;
  const Screen = spec?.component;
  const Right = spec?.right;
  const body = spec
    ? Screen ? <Screen params={p.params} /> : null
    : <View {...(p.testID ? tid(p.testID) : {})} style={styles.fill}>{content}</View>;
  return (
    <View {...tid(F2_TID.pushedScreen, { screen: p.name, entry })} style={[styles.fill, { backgroundColor: t.bg }]}>
      {spec?.kind === "content" ? null : <PlaceBar back={<NavBack />} title={title} right={Right ? <Right params={p.params} /> : undefined} />}
      {body}
    </View>
  );
}

/** The subagent drawer over its chat: the drawer's phone body is the screen and draws its own content bar with the back. */
export function DrawerRoute() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  return (
    <View {...tid("drawer-screen")} style={[styles.fill, { backgroundColor: t.bg }]}>
      <slots.SubagentDrawer />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
