import { useSyncExternalStore, type RefObject } from "react";
import type { View } from "react-native";

type Anchor = RefObject<View | null>;
let overview: { anchor?: Anchor; up: boolean } | null = null;
const listeners = new Set<() => void>();

export function openPlanOverview(anchor?: Anchor, up = false) {
  overview = { anchor, up };
  for (const notify of listeners) notify();
}

export function closePlanOverview() {
  overview = null;
  for (const notify of listeners) notify();
}

export function closeAnchoredPlanOverview(anchor: Anchor) {
  if (overview?.anchor === anchor) closePlanOverview();
}

export const subscribePlanOverview = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
export const planOverviewOpen = () => overview;
export const usePlanOverview = () => useSyncExternalStore(subscribePlanOverview, planOverviewOpen, () => null);
