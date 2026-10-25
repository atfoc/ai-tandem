// A run of steps that only read, folded to one card on the phone (ux-improvements goal 3.5, package T2; rows.ts `group` "steps"): two
// ✓, "3 steps", the files and searches in one line, and a chevron. A press opens it: the steps are drawn under the head inside the same
// card, each as its own step.
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { toolDone } from "@aiwb/core/logic/labels.ts";
import { groupSummary } from "@aiwb/core/logic/steps.ts";
import { boardNames } from "@aiwb/core/state/store.ts";

import { DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import type { GroupProps } from "../chat/parts.tsx";
import { T2_TID } from "./ids.ts";
import { plural } from "./Parts.tsx";
import { wrap } from "./webtext.ts";

/** The groups the person opened, by chat, branch and the run's first call: a group is open again when its row comes back into the thread's
 *  virtual list. */
const opened = new Set<string>();

export function StepGroup({ chat, branch, items, renderItem }: GroupProps) {
  const t = useTokens();
  const first = items[0]?.item.toolId;
  const key = first ? `${chat.id}:${branch}\n${first}` : "";
  const [open, setOpenNow] = useState(() => !!key && opened.has(key));
  const toggle = () => { if (key) { if (open) opened.delete(key); else opened.add(key); } setOpenNow(!open); };
  const names = boardNames(chat.id);
  const summary = useMemo(() => groupSummary(items.map(({ item }) => toolDone(typeof item.name === "string" ? item.name : "", item.input, typeof item.result === "string" ? item.result : undefined, names))), [items, names]);
  return (
    <View {...tid(T2_TID.stepGroup, { count: items.length, open })} style={[styles.card, { borderColor: t.line, backgroundColor: t.panel }]}>
      <Pressable role="button" aria-expanded={open} accessibilityLabel={`${plural(items.length, "step")}: ${summary}`} onPress={toggle} style={styles.head}>
        <Text size={TYPE.busy} weight="700" tone="ok" style={styles.mark}>✓✓</Text>
        <View style={styles.titles}>
          <Text size={TYPE.busy} weight="500">{plural(items.length, "step")}</Text>
          <Text {...tid(T2_TID.stepLine)} size={TYPE.secondary} tone="muted" numberOfLines={1} style={wrap}>{summary}</Text>
        </View>
        <View style={[styles.chev, { transform: [{ rotate: open ? "90deg" : "0deg" }] }]}><DisclosureChevron color={t.faint} /></View>
      </Pressable>
      {open && (
        <View style={[styles.body, { borderTopColor: t.line }]}>
          {items.map((x) => <View key={x.index}>{renderItem(x)}</View>)}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 8, minWidth: 0, alignSelf: "stretch", overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", columnGap: 10, minHeight: PHONE.target + 8, paddingVertical: 8, paddingHorizontal: 12, minWidth: 0 },
  mark: { width: 32, flexShrink: 0 },
  titles: { flex: 1, minWidth: 0 },
  chev: { flexShrink: 0, width: 16, alignItems: "center" },
  body: { borderTopWidth: 1, padding: 8, rowGap: 8, minWidth: 0 },
});
