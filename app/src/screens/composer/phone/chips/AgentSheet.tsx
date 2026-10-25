// The Agent picker of a new chat on the phone (ux-improvements goal 3.6, mockup "03 The pickers" co-03b): a P2 sheet (ui/PickerSheet.tsx)
// titled "Agent" with the chat's name as its sub-line; each row a 34-point glyph, the agent's name and a one-line description; a tap picks
// and closes (no Done, no Cancel); the chat's own agent, when its server lacks it, listed dimmed with the reason; under the list the line
// "A new agent starts with its own default model and effort." A pick is sent at once (pickAgent), as the wide toolbar's AgentPick does.
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { pickAgent, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { agentChoiceOn } from "@aiwb/core/logic/chatserver.ts";
import { getState, shownBranch, upsertChat } from "@aiwb/core/state/store.ts";
import type { AgentKind, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../../../state/useStore.ts";
import { agentColours } from "../../../chat/colour.ts";
import { useWhere } from "../../../chat/hooks.ts";
import { AgentGlyph, agentName } from "../../../../ui/icons.tsx";
import { TYPE } from "../../../../ui/metrics.ts";
import { PickerSheet, type PickerOption } from "../../../../ui/PickerSheet.tsx";
import { Text } from "../../../../ui/Text.tsx";
import { useTokens } from "../../../../ui/theme.tsx";
import { C2_IDS } from "./ids.ts";

export type AgentSheetProps = {
  open: boolean;
  onClose(): void;
  c: ChatView;
  /** The sheet's sub-line: the chat's name ("New chat"). */
  sub: string;
  /** A pick is being saved (the row takes no other pick meanwhile). */
  onBusy(busy: boolean): void;
  /** A refusal's words for the composer's error line ("" clears it). */
  onError(msg: string): void;
};

const NOTES: Record<string, string> = {
  claude: "The same session you get in a terminal",
  cursor: "Cursor's agent, with your Cursor models",
  pi: "pi, with the models of the providers you set up",
};

export function AgentSheet(p: AgentSheetProps) {
  const t = useTokens();
  const where = useWhere(p.c);
  const usable = useStore((s) => usableAgents(s, where.server));
  const choice = agentChoiceOn(where, usable, p.c.agent);
  const row = (a: AgentKind, disabledReason?: string): PickerOption<string> => ({
    value: a, label: agentName(a), note: NOTES[a] ?? undefined, disabledReason: disabledReason || undefined,
    icon: <View style={[styles.tile, { backgroundColor: agentColours(t, a).soft }]}><AgentGlyph agent={a} size={18} /></View>,
  });
  // the chat's own agent, when its server lacks it: first, dimmed, with the reason
  const options = [...(choice.missing && p.c.agent ? [row(p.c.agent as AgentKind, choice.reason)] : []), ...choice.options.map((a) => row(a))];
  const pick = (id: string) => {
    if (id === p.c.agent) return;
    p.onBusy(true);
    void pickAgent((body) => api.configure(p.c.id, shownBranch(getState(), p.c.id), body), id as AgentKind, upsertChat)
      .then(() => p.onError(""), (e) => p.onError(e.message)).finally(() => p.onBusy(false));
  };
  return (
    <PickerSheet open={p.open} onClose={p.onClose} title="Agent" sub={p.sub} options={options} value={p.c.agent || null} onPick={pick} testID={C2_IDS.agentSheet}
      foot={<Text size={TYPE.secondary} tone="muted">A new agent starts with its own default model and effort.</Text>} />
  );
}

const styles = StyleSheet.create({
  tile: { width: 34, height: 34, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
