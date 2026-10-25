// The phone layout (AD-71): a React Navigation native stack whose routes are the entries of the stack derived from the store
// (`stackOf`, f2-design.md): Home, the groups browsed, the board, its chat, the subagent drawer and the pushed screens, each one
// route with its entry's key as its param. A back (the bar's button, a swipe, the system's) sets the store (goback.ts), never the
// other way round: the stack follows the store, and a back the navigator made on its own is written to it.
import { useEffect, useRef, type ComponentType } from "react";
import { NavigationContainer, StackActions, createNavigationContainerRef } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useStore } from "../../state/useStore.ts";
import { setScreenPresenter, type PushedScreenProps } from "../../ui/pushedscreen.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { awayNow, pickPoint } from "../board/refs.ts";
import { BackButton, goBack } from "./BackButton.tsx";
import { entriesNow, popTo } from "./goback.ts";
import { popScreen, pushOverlay, pushedScreens, screenSpec, setPushedContent } from "./screens.ts";
import { useStack } from "./useShellView.ts";
import { BoardRoute } from "./phone/BoardRoute.tsx";
import { ChatRoute } from "./phone/ChatRoute.tsx";
import { EntryKeyContext } from "./phone/entry.ts";
import { GroupRoute, HomeRoute } from "./phone/HomeRoute.tsx";
import { DrawerRoute, PushedRoute } from "./phone/PushedRoute.tsx";
import { follow, keepRoutes, navigatorPopped } from "./phone/reconcile.ts";
import "./phone/seam.ts";
import type { StackEntry } from "./stack.ts";

export { BackButton, goBack };

type Params = { entry: string };
type ParamList = Record<StackEntry["route"], Params>;

const Stack = createNativeStackNavigator<ParamList>();
const navigation = createNavigationContainerRef<ParamList>();

/** A route's component, inside the context of its entry's key. */
const routeOf = (Screen: ComponentType<Params>) =>
  function Route({ route }: { route: { params: Params } }) {
    return <EntryKeyContext.Provider value={route.params.entry}><Screen entry={route.params.entry} /></EntryKeyContext.Provider>;
  };

const Home = routeOf(HomeRoute);
const Group = routeOf(GroupRoute);
const Board = routeOf(BoardRoute);
const Chat = routeOf(ChatRoute);
const Drawer = routeOf(DrawerRoute);
const Pushed = routeOf(PushedRoute);

/** The presenter of ui/pushedscreen.tsx (an overlay of kind "screen" on the phone): while open it is a pushed screen of this stack,
 *  and draws nothing itself; its children are the pushed screen's content. */
function ScreenPresenter({ open, onClose, title, testID, children }: PushedScreenProps) {
  const key = useRef<string | null>(null);
  const close = useRef(onClose);
  close.current = onClose; // (a back closes through the latest onClose, not the one of the render that opened it)
  useEffect(() => {
    if (!open) return;
    const k = key.current = pushOverlay({ title, testID, onPop: () => close.current() });
    return () => { key.current = null; popScreen(k, { quiet: true }); };
  }, [open]);
  useEffect(() => { if (open && key.current) setPushedContent(key.current, children); });
  return null;
}

setScreenPresenter(ScreenPresenter);

const routes = (entries: readonly StackEntry[]) => entries.map((e) => ({ name: e.route, params: { entry: e.key } }));
/** The routes of a reset: those the navigator holds already keep their keys, and so their screens (a chat stays mounted when a group under it goes). */
const resetTo = (entries: readonly StackEntry[]) => {
  const held = (navigation.getRootState()?.routes ?? []).map((r) => ({ key: r.key, entry: (r.params as Params).entry }));
  return keepRoutes(entries, held);
};
const keysOf = (state: { routes: readonly { params?: object }[] } | undefined): string[] => (state?.routes ?? []).map((r) => (r.params as Params).entry);

export function PhoneStack() {
  const { tokens: t } = useTheme();
  const entries = useStack();
  const key = entries.map((e) => e.key).join(",");
  const picking = useStore((s) => !!s.picking); // a point is waited for on the board: its swipe back is the wait's, not a way out of the screen
  const sliding = useRef<string | null>(null); // the keys of the reset that a slide makes before its push, which the navigator reports as a back

  // the store changed: the navigator follows (a push, a pop, a slide in, or, for anything else, a reset)
  useEffect(() => {
    if (!navigation.isReady()) return;
    const have = keysOf(navigation.getRootState());
    const want = entries.map((e) => e.key);
    const how = follow(have, want);
    if (how.kind === "push") navigation.dispatch(StackActions.push(entries[entries.length - 1]!.route, { entry: want[want.length - 1]! }));
    else if (how.kind === "pop") navigation.dispatch(StackActions.pop(how.n));
    else if (how.kind === "slide") {
      sliding.current = want.slice(0, -1).join(",");
      navigation.reset({ index: entries.length - 2, routes: resetTo(entries.slice(0, -1)) });
      navigation.dispatch(StackActions.push(entries[entries.length - 1]!.route, { entry: want[want.length - 1]! }));
    } else if (how.kind === "reset") navigation.reset({ index: entries.length - 1, routes: resetTo(entries) });
  }, [key]);

  const gesture = (entry: string | undefined, route: string): boolean => {
    if (route === "board" || picking) return false; // the board's canvas owns the edge (D15)
    const p = route === "pushed" ? pushedScreens().find((x) => x.key === entry) : undefined;
    return !p || (screenSpec(p.name)?.edgeSwipe ?? true);
  };

  return (
    <NavigationContainer ref={navigation} documentTitle={{ enabled: false }}
      initialState={{ index: entries.length - 1, routes: routes(entries) }}
      theme={{ dark: false, colors: { primary: t.accent, background: t.bg, card: t.bg, text: t.text, border: t.line, notification: t.accent }, fonts: FONTS }}
      onStateChange={(state) => {
        // a back the navigator made by itself (a swipe, the system's back): written to the store, which the stack then follows
        const have = keysOf(state);
        const mid = sliding.current;
        sliding.current = null;
        if (mid !== null && have.join(",") === mid) return; // (between the reset and the push of a slide)
        const top = navigatorPopped(have, entriesNow().map((e) => e.key));
        if (top === null) return;
        if (awayNow()) return pickPoint(null); // (a swipe or the system's back from the board while a point is waited for: the chat is opened again)
        popTo(top);
      }}>
      <Stack.Navigator screenOptions={({ route }) => ({ headerShown: false, contentStyle: { backgroundColor: t.bg }, gestureEnabled: gesture(route.params?.entry, route.name) })}>
        <Stack.Screen name="home" component={Home} />
        <Stack.Screen name="group" component={Group} />
        <Stack.Screen name="board" component={Board} />
        <Stack.Screen name="chat" component={Chat} />
        <Stack.Screen name="drawer" component={Drawer} />
        <Stack.Screen name="pushed" component={Pushed} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const FONT = { fontFamily: "System", fontWeight: "400" as const };
const FONTS = { regular: FONT, medium: { ...FONT, fontWeight: "500" as const }, bold: { ...FONT, fontWeight: "600" as const }, heavy: { ...FONT, fontWeight: "700" as const } };
