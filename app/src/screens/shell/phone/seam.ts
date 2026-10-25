// The seam of the browser checks (version "uicheck" only, as chat/index.ts's `__aiwbMd`): the stack on `window.__aiwbStack`, and two
// stand-in screens to push (`uicheck-place`, `uicheck-content`). No other build has any of it.
import { createElement } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../../../ui/Text.tsx";
import { tid } from "../../../ui/tid.ts";
import { NavBack, goBack } from "../BackButton.tsx";
import { entriesNow, popTo } from "../goback.ts";
import { getHomePlace, pushGroup, setHomeServer } from "../homeplace.ts";
import { select } from "../nav.ts";
import { popScreen, pushScreen, registerScreen } from "../screens.ts";
import { F2_TID } from "./ids.ts";

if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbStack?: unknown }).__aiwbStack = {
    entries: () => entriesNow().map(({ key, title, kind, route }) => ({ key, title, kind, route })),
    goBack, popTo, pushGroup, setHomeServer, home: getHomePlace, select, push: pushScreen, pop: popScreen,
  };
  registerScreen<{ title: string }>("uicheck-place", {
    kind: "place",
    title: (p) => p.title,
    component: ({ params }) => createElement(Text, tid(F2_TID.uicheckScreen), params.title),
  });
  registerScreen<{ title: string }>("uicheck-content", {
    kind: "content",
    title: (p) => p.title,
    component: ({ params }) => createElement(View, { style: styles.bar }, createElement(NavBack), createElement(Text, { weight: "600" }, params.title)),
  });
}

const styles = StyleSheet.create({ bar: { height: 40, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10 } });
