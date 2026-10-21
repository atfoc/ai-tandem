// The parts of the chat view that other packages fill (the same idea as the shell's slots, screens/shell/slots.tsx): the chat view
// draws the header, the thread and its rows, and these places in them are the screens of the packages that come after it. A package
// registers with `setChatPart(name, value)` from its own `screens/<area>/index.ts` (imported by `screens/register.ts`), once, at
// import. Until it does a part draws the stand-in here (a plain line carrying the testID the checks wait for) or nothing.
//
//   Composer       K3: the composer under the thread, given the chat's key. The chat view draws no composer of its own. Until K3 registers
//                  its own, the stand-in is a bar with the context ring (S9, screens/usage): K3 draws `ContextMeter` in its toolbar.
//   ToolCard       S6: a tool call's card (B-TC); `live`: the card's item may still change.
//   PermCard       S6: a permission request (B-PM); `closed`: it is in the part copied from the source of a fork.
//   SubagentRow    S7: the row of a tool call that started a subagent; `within`: it is drawn in that subagent's own thread (the drawer).
//   SubResultRow   S7: the row that carries a subagent's result into the thread.
//   MessageExtras  S8: a message's fork actions, label and branch marker, inside the message after its text; given the item's index and
//                  whether the pointer is over the message (a mouse's: the actions show on it).
//   MessageImages  S10: the images of a sent message (B-IM); `alone`: no words follow them; `again`: fetch those that failed.
//   HeaderCrumb    S8: the branch crumb at the end of the header's second line (nested Text, " · " first); nothing for a chat never split.
//   HeaderTail     S8: the header's branch alert and its Tree button, before the × (they are views of their own, in a row).
//   Banner         S8: the pending move's banner, between the thread and the composer (nothing when the chat has no move).
//   showQuote      K5: what a press on a quote of a sent message does: shows where it is from.
//   useMessageHold K5: a hook that gives a message of the thread the props and style that open the Quote sheet on a long press (the sheet path of
//                  quotes: native, and the phone layout of the web build); `{}` where the platform's own selection quotes. Called for every message.
//   MessageFlash   K5: drawn inside a message (user or agent) and over it: the flash that shows where a quote points on native (null at rest).
//   sendMessage    K3: a suggestion's chip sends its text as the chat's first message (a board chat sends its context with it).
//   MessageMark    voice (VC-23): the mic mark of a message that was spoken, drawn inside the message; nothing at rest.
//   useReadAloud   voice (VC-24): a hook that gives a message its Read aloud action, or null where it has none (no text to say). Called for every message.
//
// The thread draws each message in a wrapper that carries `testID="msg"` and `dataSet { role, item, quotable, streaming }`: a part that
// is drawn inside a message does not change them.
import type { ComponentType, RefObject } from "react";
import { useSyncExternalStore } from "react";
import { StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { sendAt } from "@aiwb/core/state/actions.ts";
import type { ChatImage, ChatView, Item, Reference, Subagent } from "@aiwb/core/types.ts";

import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import { useTokens } from "../../ui/theme.tsx";
import { ContextMeter } from "../usage/ContextMeter.tsx";

export type ChatParts = {
  Composer: ComponentType<{ chat: string }>;
  ToolCard: ComponentType<{ item: Item; chat: ChatView; live: boolean }>;
  PermCard: ComponentType<{ item: Item; chat: ChatView; branch: string; closed?: boolean }>;
  SubagentRow: ComponentType<{ item: Item; chat: ChatView; within?: Subagent }>;
  SubResultRow: ComponentType<{ item: Item; chat: ChatView }>;
  MessageExtras: ComponentType<{ chat: ChatView; index: number; item: Item; hovered: boolean }>;
  MessageImages: ComponentType<{ chat: string; images: ChatImage[]; alone: boolean; again: boolean }>;
  HeaderCrumb: ComponentType<{ chat: string }>;
  HeaderTail: ComponentType<{ chat: string }>;
  Banner: ComponentType<{ chat: string }>;
  showQuote: (chat: string, ref: Reference) => void;
  useMessageHold: (chat: ChatView, index: number | undefined, item: Item) => MessageHold;
  MessageFlash: ComponentType<{ chat: string; index: number }>;
  sendMessage: (chat: string, text: string) => Promise<unknown>;
  MessageMark: ComponentType<{ chat: ChatView; index: number; item: Item }>;
  useReadAloud: (chat: ChatView, branch: string, index: number, item: Item) => ReadAloudAction | null;
};

/** A message's Read aloud action: `reading` while it is read (the action then stops it), `title` the action's words, `run` what a press does,
 *  `anchor` the control the problem popover hangs from. */
export type ReadAloudAction = { reading: boolean; title: string; run(): void; anchor: RefObject<View | null> };

/** What a long press on a message adds to its view: touch handlers, and the style that keeps the platform's own selection from starting under the finger. */
export type MessageHold = { props: Pick<ViewProps, "onTouchStart" | "onTouchMove" | "onTouchEnd" | "onTouchCancel">; style?: ViewStyle };
const NO_HOLD: MessageHold = { props: {} };

const Nothing = () => null;

/** The composer's place until K3: a bar with the context ring and its popup (S9), where the checks of the ring and the popup run. */
function ComposerStandIn({ chat }: { chat: string }) {
  const t = useTokens();
  return (
    <View {...tid("composer-standin")} style={[styles.bar, { borderColor: t.line }]}>
      <ContextMeter chat={chat} />
    </View>
  );
}

function ToolCardStandIn({ item }: { item: Item; chat: ChatView; live: boolean }) {
  const t = useTokens();
  return (
    <View {...tid("tool-card")} style={[styles.standIn, { borderColor: t.line }]}>
      <Text tone="muted" size={12} numberOfLines={1}>{String(item.name ?? "").replace(/^mcp__board__/, "")}</Text>
    </View>
  );
}

function PermCardStandIn({ item }: { item: Item; chat: ChatView; branch: string; closed?: boolean }) {
  const t = useTokens();
  return (
    <View {...tid("perm", { state: item.decided || "pending" })} style={[styles.standIn, { borderColor: t.line2 }]}>
      <Text size={12}>Allow {String(item.toolName ?? "").replace(/^mcp__board__/, "")}?</Text>
    </View>
  );
}

function SubagentRowStandIn({ item }: { item: Item; chat: ChatView; within?: Subagent }) {
  const t = useTokens();
  return (
    <View {...tid("sub-row")} style={[styles.standIn, { borderColor: t.line }]}>
      <Text tone="muted" size={12} numberOfLines={1}>{String((item.input as { description?: string } | undefined)?.description ?? "Subagent")}</Text>
    </View>
  );
}

/** The first message of a chat, from a suggestion: a plain chat sends the text alone. K3 registers the composer's own, which sends a
 *  board chat's context with it. */
const sendFirst = (chat: string, text: string): Promise<unknown> =>
  sendAt(chat, (branch, target) => api.send(chat, branch, text, "", [], target, []), { text, references: [] });

let parts: ChatParts = {
  Composer: ComposerStandIn, ToolCard: ToolCardStandIn, PermCard: PermCardStandIn, SubagentRow: SubagentRowStandIn, SubResultRow: Nothing,
  MessageExtras: Nothing, MessageImages: Nothing, HeaderCrumb: Nothing, HeaderTail: Nothing, Banner: Nothing, showQuote: () => {},
  useMessageHold: () => NO_HOLD, MessageFlash: Nothing, sendMessage: sendFirst,
  MessageMark: Nothing, useReadAloud: () => null,
};
const listeners = new Set<() => void>();

/** Registers a part (once, at import: before the first render). */
export function setChatPart<K extends keyof ChatParts>(name: K, value: ChatParts[K]): void {
  parts = { ...parts, [name]: value };
  for (const l of listeners) l();
}

/** The parts now. */
export function useChatParts(): ChatParts {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => parts);
}

/** The parts now, outside a component (a handler). */
export const chatParts = (): ChatParts => parts;

const styles = StyleSheet.create({
  bar: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", paddingVertical: 4, paddingHorizontal: 8, borderTopWidth: 1 },
  standIn: { borderWidth: 1, borderRadius: 6, paddingVertical: 4, paddingHorizontal: 8, alignSelf: "flex-start", maxWidth: "100%" },
});
