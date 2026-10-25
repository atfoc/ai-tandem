// A permission request (the old page's ChatView.tsx PermCard; B-PM): "Allow <tool>?" with the agent's description and what it asks for, and Allow
// and Don't while it waits. Decided it says "Approved" or "Denied". closed: it is in the copied part of the thread, where an undecided one
// cannot be answered (the server closes those in a copy; this is the same rule here). In a chat that is shown as it was (its server is not
// connected, or no longer has it: useOffWhy) an undecided one has no buttons, and says why in their place: it may have been answered elsewhere
// meanwhile, and is shown as it is when the server is back. An answer that fails shows its error under the card and the card stays pending.
//
// On the phone (ux T2) the card says who asks for what in words, gives the agent's title and the whole command, and answers with two 48 pt
// buttons; once answered it folds to one line (the dock above the composer, PermDock, answers the same request while the card is off screen).
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { agentMeta } from "@aiwb/core/agents.ts";
import { permAnswer } from "@aiwb/core/logic/perms.ts";
import { permClock, permTitle, permWhat, permWho } from "@aiwb/core/logic/permwords.ts";
import { isLegacy, subsOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { DisclosureChevron, AgentGlyph } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { useOffWhy } from "../chat/hooks.ts";
import { Code } from "./Code.tsx";
import { T2_TID } from "./ids.ts";
import { answeredAt, observePerm } from "./permtimes.ts";
import { wrap } from "./webtext.ts";

const short = (n: string) => n.replace(/^mcp__board__/, "");

type CardProps = { item: Item; chat: ChatView; branch: string; closed?: boolean };

export function PermCard(p: CardProps) {
  return usePhone() ? <PermCardPhone {...p} /> : <PermCardWide {...p} />;
}

function PermCardWide({ item, chat, branch, closed }: CardProps) {
  const t = useTokens();
  const off = useOffWhy(chat.id);
  const [err, setErr] = useState("");
  const asker = useStore((s) => (item.subagent ? subsOf(s, chat.id)?.[item.subagent] : undefined));
  const input = (item.input ?? {}) as { command?: unknown; file_path?: unknown; url?: unknown; notebook_path?: unknown; description?: unknown };
  const decide = (allow: boolean) => api.decide(chat.id, branch, permAnswer(item, allow)).then(() => setErr(""), (e: Error) => setErr(e.message));
  const what = input.command ?? input.file_path ?? input.url ?? input.notebook_path ?? null;
  const state = item.decided || (closed ? "deny" : "pending");
  const decided = state !== "pending";
  return (
    <View {...tid("perm", { state, closed: closed && !item.decided ? true : undefined })}
      style={[styles.card, { borderColor: decided ? t.line : t.warn, backgroundColor: decided ? t.panel : t.warnSoft }]}>
      {item.subagent ? <Text {...tid("perm-sub")} tone="muted" size={11} style={styles.sub}>Asked by subagent · {asker?.description || "Subagent"}</Text> : null}
      <Text {...tid("perm-title")} weight="600" style={wrap}>Allow {short(String(item.toolName ?? ""))}?</Text>
      {input.description ? <Text {...tid("perm-reason")} tone="muted" style={[styles.reason, wrap]}>{String(input.description)}</Text> : null}
      {what ? (
        <View {...tid("perm-what")} style={[styles.what, { backgroundColor: t.bg, borderColor: t.line }]}>
          <Code text={String(what)} />
        </View>
      ) : null}
      {item.decided ? (
        <Text {...tid("perm-done")} tone="muted" size={12} style={styles.done}>{item.decided === "allow" ? "Approved" : "Denied"}</Text>
      ) : closed ? (
        <Text {...tid("perm-done")} tone="muted" size={12} style={styles.done}>Closed: it was asked in the thread this was copied from</Text>
      ) : chat.archived || isLegacy(chat) ? null : off ? (
        <Text {...tid("perm-done")} tone="muted" size={12} style={styles.done}>{off}</Text>
      ) : (
        <View {...tid("perm-actions")} style={styles.actions}>
          <Button testID="perm-allow" tone="danger" size="sm" label="Allow" onPress={() => decide(true)} />
          <Button testID="perm-deny" size="sm" label="Don't" onPress={() => decide(false)} />
        </View>
      )}
      {err ? <Text {...tid("perm-error")} size={11.5} tone="danger" style={styles.err}>{err}</Text> : null}
    </View>
  );
}

/** The words of a request and its answer, as the phone's card and dock read them: who asks for what, the title, the command, and the call
 *  that answers it (the error of a failed one stays in `err` until the next answer). */
export function usePermWords(item: Item, chat: ChatView, branch: string) {
  const [err, setErr] = useState("");
  const asker = useStore((s) => (item.subagent ? subsOf(s, chat.id)?.[item.subagent]?.description : undefined));
  const decide = (allow: boolean) => api.decide(chat.id, branch, permAnswer(item, allow)).then(() => setErr(""), (e: Error) => setErr(e.message));
  return { who: permWho(item, agentMeta(chat.agent ?? "").short, asker || undefined), title: permTitle(item), what: permWhat(item), decide, err };
}

/** The command of a request in a mono box, wrapped and never cut; `lines` cuts it (the dock's two lines). */
export function PermCommand({ what, id, lines, boxed }: { what: string; id?: string; lines?: number; boxed?: boolean }) {
  const t = useTokens();
  const text = <Text {...tid(id ?? T2_TID.permCommand)} mono size={TYPE.secondary} numberOfLines={lines} style={wrap}>{what}</Text>;
  return boxed
    ? <View {...tid("perm-what")} style={[styles.box, { backgroundColor: t.bg, borderColor: t.line }]}>{text}</View>
    : text;
}

/** Deny (bordered) and Allow (the accent), side by side at the same width, 48 pt high. */
export function PermButtons({ onAnswer, deny, allow }: { onAnswer: (allow: boolean) => void; deny: string; allow: string }) {
  return (
    <View {...tid("perm-actions")} style={styles.buttons}>
      <Button testID={deny} size="touch" label="Deny" style={styles.big} onPress={() => onAnswer(false)} />
      <Button testID={allow} size="touch" tone="primary" label="Allow" style={styles.big} onPress={() => onAnswer(true)} />
    </View>
  );
}

/** The phone's card: pending, it is the amber card with the two buttons; answered, it is one line a tap opens. */
function PermCardPhone({ item, chat, branch, closed }: CardProps) {
  const t = useTokens();
  const off = useOffWhy(chat.id);
  const { who, title, what, decide, err } = usePermWords(item, chat, branch);
  const [open, setOpen] = useState(false);
  // the app's own record of an answer: this card sees a request pending, and later decided
  observePerm(chat.id, item);
  const at = item.decided ? answeredAt(chat.id, item) : undefined;
  const state = item.decided || (closed ? "deny" : "pending");
  const decided = state !== "pending";
  const head = (
    <View style={styles.who}>
      <AgentGlyph agent={chat.agent ?? ""} size={14} />
      <Text {...tid(T2_TID.permWho)} tone="muted" size={TYPE.secondary} style={[styles.whoText, wrap]}>{who}</Text>
    </View>
  );
  if (item.decided && !open) {
    const allowed = item.decided === "allow";
    const said = `${allowed ? "Allowed" : "Denied"} \u00b7 ${title || who}`;
    return (
      <View {...tid("perm", { state })} style={[styles.card, styles.cardFolded, { borderColor: t.line, backgroundColor: t.panel }]}>
        <Pressable {...tid(T2_TID.permFolded)} role="button" accessibilityLabel={`${said}. Show the request`} onPress={() => setOpen(true)} style={styles.folded}>
          <View style={styles.foldedHead}>
            <Text tone={allowed ? "ok" : "danger"} size={TYPE.control} weight="700" style={styles.mark}>{allowed ? "\u2713" : "\u2715"}</Text>
            <Text size={TYPE.control} weight="500" numberOfLines={1} style={styles.foldedTitle}>{said}</Text>
            {at !== undefined ? <Text {...tid(T2_TID.permTime)} tone="muted" size={TYPE.secondary}>{permClock(at)}</Text> : null}
          </View>
          {what ? <Text mono tone="muted" size={TYPE.secondary} numberOfLines={1} style={styles.foldedWhat}>{what}</Text> : null}
        </Pressable>
      </View>
    );
  }
  return (
    <View {...tid("perm", { state, closed: closed && !item.decided ? true : undefined })}
      style={[styles.card, styles.cardPhone, { borderColor: decided ? t.line : t.warn, backgroundColor: decided ? t.panel : t.warnSoft }]}>
      {item.decided ? (
        <Pressable role="button" accessibilityLabel="Hide the request" onPress={() => setOpen(false)} style={styles.openHead}>
          {head}
          <View style={styles.fold}><DisclosureChevron color={t.muted} /></View>
        </Pressable>
      ) : head}
      {title ? <Text {...tid("perm-title")} size={TYPE.control} weight="600" style={[styles.titlePhone, wrap]}>{title}</Text> : null}
      {what ? <View style={styles.whatPhone}><PermCommand what={what} boxed /></View> : null}
      {item.decided ? (
        <Text {...tid("perm-done")} tone="muted" size={TYPE.secondary} style={styles.done}>{item.decided === "allow" ? "Approved" : "Denied"}</Text>
      ) : closed ? (
        <Text {...tid("perm-done")} tone="muted" size={TYPE.secondary} style={styles.done}>Closed: it was asked in the thread this was copied from</Text>
      ) : chat.archived || isLegacy(chat) ? null : off ? (
        <Text {...tid("perm-done")} tone="muted" size={TYPE.secondary} style={styles.done}>{off}</Text>
      ) : (
        <View style={styles.answer}><PermButtons onAnswer={decide} deny="perm-deny" allow="perm-allow" /></View>
      )}
      {err ? <Text {...tid("perm-error")} size={TYPE.secondary} tone="danger" style={styles.err}>{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  cardPhone: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 14 },
  who: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  whoText: { flexShrink: 1, minWidth: 0 },
  titlePhone: { marginTop: 6 },
  whatPhone: { marginTop: 10 },
  box: { borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12 },
  answer: { marginTop: 14 },
  buttons: { flexDirection: "row", gap: 12, alignSelf: "stretch" },
  big: { minHeight: 48, flex: 1 },
  cardFolded: { borderRadius: 12, paddingVertical: 2, paddingHorizontal: 14 },
  folded: { minHeight: PHONE.target, justifyContent: "center", paddingVertical: 6 },
  foldedHead: { flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 },
  mark: { width: 18, textAlign: "center" },
  foldedTitle: { flex: 1, minWidth: 0 },
  foldedWhat: { marginLeft: 28, marginTop: 2 },
  openHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: PHONE.target - 14, marginVertical: -4 },
  fold: { transform: [{ rotate: "-90deg" }], paddingHorizontal: 4 },
  card: { borderWidth: 1, borderRadius: 9, paddingVertical: 10, paddingHorizontal: 12, alignSelf: "stretch", minWidth: 0 },
  sub: { marginBottom: 2 },
  reason: { marginTop: 2 },
  // (the page's `.perm-what`: at most 120 px, then it scrolls)
  what: { marginTop: 6, borderWidth: 1, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 7, maxHeight: 120, overflow: "hidden" },
  actions: { flexDirection: "row", columnGap: 6, marginTop: 8 },
  done: { marginTop: 4 },
  err: { paddingHorizontal: 4, paddingTop: 4 },
});
