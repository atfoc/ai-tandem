// What stands before folder, model and effort in the composer's toolbar (the old page's ChatChoices.tsx): the name of the chat's server, for a
// chat of a section (showsServer), and the chat's agent. The server is where the chat was made, and is no choice; the agent can be changed
// until the first message, in a chat that is neither a fork nor a branch (agentOpen), and the toolbar shows it only then. The toolbar draws
// each in its row or in its "more" popup, and keeps the chip's width by what decides it (useServerChip, useAgentChip); the line that says
// why a chat has no agent is a component of its own (AgentReason). `useWhere` and `useOffWhy` are screens/chat's.
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { pickAgent, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { agentChoiceOn, toolbarLine } from "@aiwb/core/logic/chatserver.ts";
import { widthKey } from "@aiwb/core/logic/composerfit.ts";
import { serverFixed } from "@aiwb/core/logic/serverlists.ts";
import { getState, shownBranch, upsertChat } from "@aiwb/core/state/store.ts";
import type { AgentKind, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, WarnIcon, agentName } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useWhere } from "../chat/hooks.ts";
import { ChipName, TChip } from "./Chip.tsx";
import { Picker } from "./Picker.tsx";

type Menu = { disabled: boolean; open: boolean; onOpenChange(open: boolean): void };
type Saves = { c: ChatView; onBusy(busy: boolean): void; onError(msg: string): void };

/** The name of a chat's server: a chip that is no choice, with why in its title (serverFixed), greyed while that server is not connected. */
export function ServerChip({ c }: { c: ChatView }) {
  const w = useWhere(c);
  const fixed = serverFixed(c);
  return <TChip kind="server" testID="tchip" title={`Server — ${fixed}`} off={!w.connected} data={{ connected: w.connected }}><ChipName muted full={`${w.name} — ${fixed}`}>{w.name}</ChipName></TChip>;
}

/** What decides the width of ServerChip: the server's name. */
export function useServerChip(c: ChatView): string {
  return widthKey("server", useWhere(c).name, { fixed: true });
}

/** The agent choice: only the agents the chat's server can run. A pick is sent at once, and the answer is the chat with the model and
 *  effort the server chose for that agent. An agent the chat has and the server lacks is marked and is not among the options; with none to
 *  offer, and on a server that is not connected, the chip says "No agent". The line under the toolbar (AgentReason) says why, as it does
 *  for a chat with no agent. onBusy: a pick is being saved, and the toolbar's pickers take none meanwhile. */
export function AgentPick({ c, disabled, open, onOpenChange, onBusy, onError }: Menu & Saves) {
  const { tokens: t } = useTheme();
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, c.agent);
  const glyph = (a: AgentKind) => <AgentGlyph agent={a} size={12} />;
  const pick = (id: string) => {
    onBusy(true);
    void pickAgent((p) => api.configure(c.id, shownBranch(getState(), c.id), p), id as AgentKind, upsertChat)
      .then(() => onError(""), (e) => onError(e.message)).finally(() => onBusy(false));
  };
  if (!choice.options.length) return <TChip kind="agent" title={`Agent — ${choice.reason}`} missing><ChipName missing>No agent</ChipName></TChip>;
  return (
    <Picker kind="agent" label={c.agent ? agentName(c.agent) : "No agent"} title="Agent" hint={choice.reason || undefined} value={c.agent}
      icon={!c.agent ? undefined : choice.missing ? <WarnIcon color={t.danger} size={12} /> : glyph(c.agent)}
      options={choice.options.map((a) => ({ id: a, label: agentName(a), icon: glyph(a) }))}
      disabled={disabled} open={open} onOpenChange={onOpenChange} onPick={pick} />
  );
}

/** What decides the width of AgentPick's chip: the agent's name or "No agent", whether it is a choice or a fixed chip, and the glyph or the
 *  mark before the name. */
export function useAgentChip(c: ChatView): string {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, c.agent);
  const fixed = !choice.options.length;
  const named = !!c.agent && !fixed;
  return widthKey("agent", named ? agentName(c.agent as AgentKind) : "No agent", { fixed, mark: !named ? "" : !fixed && choice.missing ? "warn" : "glyph" });
}

/** The line under the toolbar's controls of a chat whose agent can be chosen (toolbarLine): why it has none, or cannot use its own. A line
 *  of the toolbar's row, also while the agent's chip is in the "more" popup. */
export function AgentReason({ c }: { c: ChatView }) {
  const w = useWhere(c);
  const usable = useStore((s) => usableAgents(s, w.server));
  const gone = useStore((s) => !!s.gone[c.id]);
  const line = toolbarLine(w, usable, c, gone);
  if (!line.text) return null;
  return (
    <View {...tid("agent-reason", { tone: line.tone || undefined })} style={styles.reason}>
      <Text size={12} tone={line.tone === "missing" ? "danger" : "muted"}>{line.text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  reason: { width: "100%", flexShrink: 0, paddingTop: 3, paddingHorizontal: 2, paddingBottom: 1 },
});
