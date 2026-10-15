// How the toolbar learns what its controls ask for (AD-62: "the widths are measured with onLayout, the rules stay"). A control whose width
// is not kept yet is drawn once in a layer nobody sees (the measuring layer: opacity 0, over the row, takes no press) and reports its width
// from there; the row draws only controls whose width is known, so a control never stands past the box for a frame. What is drawn in
// that layer has no testID: a check finds each control once.
import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Sized } from "../../platform/sized";
import { zoom } from "../../platform/zoom";
import { tid } from "../../ui/tid.ts";
import { createWidths } from "./widths.ts";

/** The kept widths of this app: one zoom at a time (the browser's zoom; platform/zoom.ts). */
export const widths = createWidths(zoom);

// A build made for the browser checks (version "uicheck", `buildAppDist`) shows the kept widths' counter on `window`: a change of zoom measures
// the controls again, a resize does not (A2.2). No other build does.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") (window as unknown as { __aiwbWidths?: typeof widths }).__aiwbWidths = widths;

const Measuring = createContext(false);

/** Counts the changes of zoom: a control measured at another zoom is drawn anew, so that its layout is reported again. */
export const MeasureEpoch = createContext(0);

/** Whether the control is being measured in the hidden layer (it then draws no testID and takes no press). */
export const useMeasuring = (): boolean => useContext(Measuring);

/** Draws `children` as one control of the row and keeps the width they ask for under `k` (the first measurement stays). `onKept`: told
 *  when a new width was kept, so the toolbar fits again. `part`: what it is in the row, for a check (dataSet.part of the testID "part"). */
export function Measure({ k, onKept, children, style, part }: { k: string; onKept(): void; children: ReactNode; style?: object; part?: string }) {
  const measuring = useMeasuring();
  const epoch = useContext(MeasureEpoch);
  return (
    // (keyed by what it measures and by the zoom: a control that stays and asks for another width key, or whose widths were dropped with
    // a change of zoom, is drawn anew, so its layout is reported again)
    <Sized key={`${k}#${epoch}`} {...(part && !measuring ? tid("part", { part }) : {})} style={[styles.control, style]} onWidth={(w) => { if (widths.keep(k, w)) onKept(); }}>
      {children}
    </Sized>
  );
}

/** The layer where controls with no kept width are drawn to be measured. */
export function MeasuringLayer({ children }: { children: ReactNode }) {
  return (
    <Measuring.Provider value>
      <View pointerEvents="none" aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.layer}>
        <View style={styles.wide}>{children}</View>
      </View>
    </Measuring.Provider>
  );
}

const styles = StyleSheet.create({
  // (a control is as wide as it asks for: it neither grows nor shrinks to the row)
  control: { flexDirection: "row", alignItems: "center", gap: 4, flexGrow: 0, flexShrink: 0 },
  // (clipped to a point: the page does not scroll for what is in it)
  layer: { position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "hidden", opacity: 0 },
  // (and wide: the controls in it keep their own widths. Yoga lays a child out within the width of its parent, so a text in a layer of one
  // point is wrapped at its longest word and reports that: the first device run drew every control of the row, Send past the screen's edge)
  wide: { position: "absolute", left: 0, top: 0, width: 4000, flexDirection: "row", alignItems: "flex-start", gap: 4 },
});
