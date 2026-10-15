// The phone layout (AD-71): a React Navigation native stack whose routes are derived from the store (`stackOf`). The sidebar is the
// first screen; a board is pushed over it and a board's chat over its board (the board stays mounted beneath, AD-52); a plain chat
// is pushed over the list. A back (the bar's button, a swipe, the system's) sets the store (`select` with the chat or the board
// cleared), never the other way round: the stack follows the store, and a back the navigator made on its own is written to it.
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { NavigationContainer, StackActions, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { getState, setState } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { awayNow, pickPoint } from "../board/refs.ts";
import { BackButton, goBack } from "./BackButton.tsx";
import { BoardBar } from "./BoardBar.tsx";
import { Guard } from "./Guard.tsx";
import { select } from "./nav.ts";
import { useSlots } from "./slots.tsx";
import { sameRoutes, selForRoutes, stackOf, type Route } from "./stack.ts";
import { useRoutes, useShellView } from "./useShellView.ts";

export { BackButton, goBack };

const Stack = createNativeStackNavigator();
const navigation = createNavigationContainerRef();

const routesNow = (): Route[] => stackOf(getState());

/** The bar of a screen that has none of its own (the drawer): the back and a line. A chat has none: its own header carries the back
 *  on the phone (S8), so its title is shown once. */
function Bar({ title }: { title: string }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("phone-bar")} style={[styles.bar, { borderBottomColor: t.line, backgroundColor: t.bg }]}>
      <BackButton />
      <Text weight="600" numberOfLines={1} style={styles.title}>{title}</Text>
    </View>
  );
}

function SideScreen() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const chats = useStore((s) => s.chats);
  return <View {...tid("side-pane")} style={[styles.fill, { backgroundColor: t.panel }]}><Guard what="the sidebar" resetKey={chats}><slots.Sidebar /></Guard></View>;
}

function BoardScreen() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const view = useShellView();
  if (view.kind !== "board") return <View style={[styles.fill, { backgroundColor: t.bg }]} />;
  return (
    <View {...tid("board-stage")} style={[styles.fill, { backgroundColor: t.bg }]}>
      <BoardBar board={view.board} chatOpen={false} leading={<BackButton />} />
      <View style={styles.fill}><slots.Canvas board={view.board} /></View>
    </View>
  );
}

function ChatScreen() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const view = useShellView();
  const chat = view.kind === "home" ? null : view.chat;
  if (!chat) return <View style={[styles.fill, { backgroundColor: t.bg }]} />;
  return (
    <View {...tid("chat-page")} style={[styles.fill, { backgroundColor: t.bg }]}>
      <Guard what="this page" resetKey={chat}><slots.ChatView chat={chat} /></Guard>
    </View>
  );
}

function DrawerScreen() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  return (
    <View {...tid("drawer-screen")} style={[styles.fill, { backgroundColor: t.bg }]}>
      <Bar title="Subagent" />
      <slots.SubagentDrawer />
    </View>
  );
}

export function PhoneStack() {
  const { tokens: t } = useTheme();
  const routes = useRoutes();
  const key = routes.join(",");
  const waiting = useStore((s) => !!s.picking); // a point is waited for on the board: its swipe back is the wait's, not a way out of the board

  // the store changed: the navigator follows (a push, a pop, or, for anything else, a reset)
  useEffect(() => {
    if (!navigation.isReady()) return;
    const have = (navigation.getRootState()?.routes ?? []).map((r) => r.name as Route);
    if (sameRoutes(have, routes)) return;
    if (routes.length === have.length + 1 && sameRoutes(routes.slice(0, -1), have)) navigation.dispatch(StackActions.push(routes[routes.length - 1]));
    else if (have.length > routes.length && sameRoutes(have.slice(0, routes.length), routes)) navigation.dispatch(StackActions.pop(have.length - routes.length));
    else navigation.reset({ index: routes.length - 1, routes: routes.map((name) => ({ name })) });
  }, [key]);

  return (
    <NavigationContainer ref={navigation} documentTitle={{ enabled: false }}
      initialState={{ index: routes.length - 1, routes: routes.map((name) => ({ name })) }}
      theme={{ dark: false, colors: { primary: t.accent, background: t.bg, card: t.bg, text: t.text, border: t.line, notification: t.accent }, fonts: FONTS }}
      onStateChange={(state) => {
        // a back the navigator made by itself (a swipe, the system's back): written to the store, which the stack then follows
        const have = (state?.routes ?? []).map((r) => r.name as Route);
        const r = selForRoutes(have, routesNow(), getState().sel);
        if (!r) return;
        if (awayNow()) return pickPoint(null); // (a swipe or the system's back from the board while a point is waited for: the chat is opened again)
        if ("closeDrawer" in r) setState({ subDrawer: null }); else select(r.sel);
      }}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
        <Stack.Screen name="side" component={SideScreen} />
        <Stack.Screen name="board" component={BoardScreen} options={{ gestureEnabled: !waiting }} />
        <Stack.Screen name="chat" component={ChatScreen} />
        <Stack.Screen name="drawer" component={DrawerScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const FONT = { fontFamily: "System", fontWeight: "400" as const };
const FONTS = { regular: FONT, medium: { ...FONT, fontWeight: "500" as const }, bold: { ...FONT, fontWeight: "600" as const }, heavy: { ...FONT, fontWeight: "700" as const } };

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  bar: { height: 40, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, borderBottomWidth: 1 },
  title: { flex: 1 },
});
