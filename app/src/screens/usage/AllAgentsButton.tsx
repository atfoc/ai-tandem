import { useEffect, useRef } from "react";
import { View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { closeUsage } from "./open.ts";
import { closeAnchoredPlanOverview, openPlanOverview } from "./overviewOpen.ts";

export function AllAgentsButton({ phone = false }: { phone?: boolean }) {
  const anchor = useRef<View>(null);
  useEffect(() => () => closeAnchoredPlanOverview(anchor), []);
  return (
    <View ref={anchor} collapsable={false}>
      <Button label="All agents…" testID="usage-all-agents" tone="ghost" size={phone ? "touch" : "sm"} onPress={() => {
        if (phone) {
          closeUsage();
          openPlanOverview();
        } else {
          openPlanOverview(anchor, true);
        }
      }} />
    </View>
  );
}
