// The thread of a chat that has no message yet (the old page's ChatView.tsx's EmptyThread): the agent's big glyph and name, a line by kind of
// chat, the agent's configuration hint, and suggestions that send their text as the first message. A chat that takes no message says
// why in place of its usual line, and offers no suggestion.
import { Pressable, StyleSheet, View } from "react-native";

import { agentLabel, configHint, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { emptyReason, sendOff } from "@aiwb/core/logic/chatserver.ts";
import { chipKinds, setupHint } from "@aiwb/core/logic/chiprow.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { isLegacy } from "@aiwb/core/state/store.ts";
import type { ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, BoardIcon, BranchIcon, ChatIcon, InsertIcon, type IconProps } from "../../ui/icons.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { C2_IDS } from "../composer/phone/chips/ids.ts";
import { agentColours } from "./colour.ts";
import { base, useWhere } from "./hooks.ts";
import { chatParts } from "./parts.tsx";

const BOARD_SUGGESTIONS = ["Sketch a 3-tier web architecture here", "Summarize what's on this board", "Tidy up the selected shapes into a row"];
const CHAT_SUGGESTIONS = ["What is this project?", "What changed in the last few commits?"];

/** gone: the chat is no longer on its server. */
export function EmptyThread({ c, gone }: { c: ChatView; gone: boolean }) {
  return usePhone() ? <PhoneEmptyThread c={c} gone={gone} /> : <WideEmptyThread c={c} gone={gone} />;
}

function WideEmptyThread({ c, gone }: { c: ChatView; gone: boolean }) {
  const t = useTokens();
  const board = useStore((s) => (c.board ? s.boards[c.board] : undefined));
  const usable = useStore((s) => usableAgents(s, serverOf(c)));
  const where = useWhere(c);
  const off = sendOff(where); // its server is not connected: no agent is shown, and nothing is to be picked
  const reason = emptyReason(where, usable, c, gone);
  const agent = off ? "" : c.agent;
  const hint = off ? "" : configHint(usable, c.agent);
  // (a chat with no agent, or whose server is not connected or no longer has it, takes no message: it says why, and offers none to send)
  const suggest = reason ? [] : c.board ? BOARD_SUGGESTIONS : CHAT_SUGGESTIONS;
  return (
    <View {...tid("empty-thread")} style={styles.empty}>
      <View style={[styles.glyph, { backgroundColor: agentColours(t, agent).soft }]}><AgentGlyph agent={agent} size={28} /></View>
      <Text {...tid("empty-title")} weight="600" style={styles.title}>{agentLabel(agent)}</Text>
      {reason
        ? <Text {...tid("empty-reason")} tone="muted" style={styles.line}>{reason}</Text>
        : c.board
        ? <Text tone="muted" style={styles.line}>Ask about or change <Text weight="700">{board?.name ?? "this board"}</Text>. Type <Text mono size={12}>@</Text> to point at other boards.</Text>
        : <Text tone="muted" style={styles.line}>The same session you get in a terminal, started in <Text mono weight="700" size={12}>{base(c.cwd) || "/"}</Text>.</Text>}
      {!c.locked && !c.archived && !isLegacy(c) && hint ? <Text {...tid("config-hint")} size={12} tone="accent" style={styles.line}>{hint}</Text> : null}
      {!c.archived && !isLegacy(c) && suggest.length > 0 && (
        <View {...tid("suggestions")} style={styles.suggestions}>
          {suggest.map((s) => (
            <Pressable key={s} {...tid("suggestion")} accessibilityRole="button" onPress={() => void chatParts().sendMessage(c.id, s).catch((e) => console.error(e))}
              style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.chip, { backgroundColor: t.bg, borderColor: hovered ? t.accent : t.line2 }]}>
              {({ hovered }: { hovered?: boolean; pressed: boolean }) => <Text size={12} tone={hovered ? "accent" : "text"}>{s}</Text>}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const STARTER_ICONS: ((p: IconProps) => React.JSX.Element)[] = [BoardIcon, BranchIcon, InsertIcon];

/** The phone's empty thread (ux-improvements goal 3.5, package C2): a larger welcome, the hint to the chips above the box in quiet grey, and
 *  "Try asking" with full-width starters at the foot, right above the composer (the short thread lets this row fill its height). */
function PhoneEmptyThread({ c, gone }: { c: ChatView; gone: boolean }) {
  const t = useTokens();
  const board = useStore((s) => (c.board ? s.boards[c.board] : undefined));
  const usable = useStore((s) => usableAgents(s, serverOf(c)));
  const move = useStore((s) => !!s.moves[c.id]);
  const where = useWhere(c);
  const off = sendOff(where);
  const reason = emptyReason(where, usable, c, gone);
  const agent = off ? "" : c.agent;
  const noAgent = !c.agent && !usable.length; // (the no-agent bar stands in the box's place: no chips above it for a hint to point at)
  const hint = c.archived || isLegacy(c) || noAgent ? "" : setupHint(chipKinds(c, { frozen: off || gone, move }));
  const suggest = reason ? [] : c.board ? BOARD_SUGGESTIONS : CHAT_SUGGESTIONS;
  // (what the composer's block says in the box's or the toolbar's place — offline, gone, no agent installed — is said there once, not here too:
  // goal 3.7.1, package V1's composer/blocked.ts; "Choose an agent" is no block, and stays)
  const said = off || gone || noAgent ? "" : reason;
  return (
    <View {...tid("empty-thread")} style={phoneStyles.empty}>
      <View style={phoneStyles.welcome}>
        <View style={[phoneStyles.glyph, { backgroundColor: agentColours(t, agent).soft }]}><AgentGlyph agent={agent} size={28} /></View>
        <Text {...tid("empty-title")} weight="600" size={22} style={phoneStyles.title}>{agentLabel(agent)}</Text>
        {said
          ? <Text {...tid("empty-reason")} tone="muted" size={TYPE.body} style={phoneStyles.line}>{said}</Text>
          : reason ? null
          : c.board
          ? <Text tone="muted" size={TYPE.body} style={phoneStyles.line}>Ask about or change <Text size={TYPE.body} weight="600">{board?.name ?? "this board"}</Text>. Type <Text mono size={TYPE.secondary}>@</Text> to point at other boards.</Text>
          : <Text tone="muted" size={TYPE.body} style={phoneStyles.line}>The same session you get in a terminal, started in <Text mono weight="600" size={TYPE.secondary}>{base(c.cwd) || "/"}</Text>.</Text>}
        {hint ? <Text {...tid("config-hint")} tone="muted" size={TYPE.busy} style={phoneStyles.hint}>{hint}</Text> : null}
      </View>
      {!c.archived && !isLegacy(c) && suggest.length > 0 && (
        <View {...tid(C2_IDS.starters)} style={phoneStyles.starters}>
          <Text tone="muted" size={TYPE.secondary} weight="600" style={phoneStyles.label}>TRY ASKING</Text>
          {suggest.map((s, i) => {
            const Icon = STARTER_ICONS[i % STARTER_ICONS.length];
            return (
              <Pressable key={s} {...tid("suggestion")} accessibilityRole="button" accessibilityLabel={s}
                onPress={() => void chatParts().sendMessage(c.id, s).catch((e) => console.error(e))}
                style={({ pressed }: { pressed: boolean }) => [phoneStyles.starter, { borderColor: t.line2, backgroundColor: pressed ? t.panel : t.bg }]}>
                <Icon size={16} color={t.accent} />
                <Text size={TYPE.body} style={phoneStyles.starterText}>{s}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const phoneStyles = StyleSheet.create({
  empty: { flexGrow: 1, paddingTop: 24, paddingBottom: 16 },
  welcome: { flexGrow: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 8 },
  glyph: { width: 56, height: 56, borderRadius: 14, marginBottom: 14, alignItems: "center", justifyContent: "center" },
  title: { marginBottom: 6 },
  line: { textAlign: "center" },
  hint: { textAlign: "center", marginTop: 12 },
  starters: { marginTop: 32, gap: 8 },
  label: { letterSpacing: 0.6, marginBottom: 2 },
  starter: { minHeight: 48, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  starterText: { flex: 1, minWidth: 0 },
});

const styles = StyleSheet.create({
  empty: { alignItems: "center", paddingTop: 10, paddingHorizontal: 8, paddingBottom: 24 },
  glyph: { width: 52, height: 52, borderRadius: 14, marginBottom: 10, alignItems: "center", justifyContent: "center" },
  title: { marginBottom: 4 },
  line: { textAlign: "center" },
  suggestions: { gap: 6, alignItems: "center", marginTop: 14 },
  chip: { borderWidth: 1, borderRadius: 14, paddingVertical: 4, paddingHorizontal: 11 },
});
