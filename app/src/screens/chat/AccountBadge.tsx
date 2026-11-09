// The badge of a chat on a Claude account (multiple-claude goal §1.4.4): a small pill with the account's name in the Claude colours, where
// the chat's header names its agent (the wide header's line, the phone's sub-line). A removed account's chat says "Claude account", the name
// agents.ts gives a kind no list has. Its name follows the list: the store feeds the names (setAliasNames) before it tells its subscribers.
import { StyleSheet, View } from "react-native";

import { agentName, isAliasKind } from "@aiwb/core/agents.ts";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { agentColours } from "./colour.ts";

/** Whether a chat's header carries an account's badge in place of the agent's name. */
export const hasBadge = (agent: string | undefined) => !!agent && isAliasKind(agent);

export function AccountBadge({ kind, size = 11 }: { kind: string; size?: number }) {
  const t = useTokens();
  useStore((s) => s.aliases); // (draws again when a list brings another name)
  const a = agentColours(t, kind);
  const name = agentName(kind);
  return (
    <View {...tid("chat-account-badge", { kind })} accessibilityLabel={`Account: ${name}`} style={[styles.pill, { backgroundColor: a.soft, borderColor: a.fg }]}>
      <Text size={size} weight="600" numberOfLines={1} style={[styles.text, { color: a.fg }]}>{name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexShrink: 1, minWidth: 0, maxWidth: "100%", borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 0 },
  text: { flexShrink: 1 },
});
