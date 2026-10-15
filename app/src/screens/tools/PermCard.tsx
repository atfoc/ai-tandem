// A permission request (the old page's ChatView.tsx PermCard; B-PM): "Allow <tool>?" with the agent's description and what it asks for, and Allow
// and Don't while it waits. Decided it says "Approved" or "Denied". closed: it is in the copied part of the thread, where an undecided one
// cannot be answered (the server closes those in a copy; this is the same rule here). In a chat that is shown as it was (its server is not
// connected, or no longer has it: useOffWhy) an undecided one has no buttons, and says why in their place: it may have been answered elsewhere
// meanwhile, and is shown as it is when the server is back. An answer that fails shows its error under the card and the card stays pending.
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { api } from "@aiwb/core/api.ts";
import { permAnswer } from "@aiwb/core/logic/perms.ts";
import { isLegacy, subsOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useOffWhy } from "../chat/hooks.ts";
import { Code } from "./Code.tsx";
import { wrap } from "./webtext.ts";

const short = (n: string) => n.replace(/^mcp__board__/, "");

export function PermCard({ item, chat, branch, closed }: { item: Item; chat: ChatView; branch: string; closed?: boolean }) {
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

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 9, paddingVertical: 10, paddingHorizontal: 12, alignSelf: "stretch", minWidth: 0 },
  sub: { marginBottom: 2 },
  reason: { marginTop: 2 },
  // (the page's `.perm-what`: at most 120 px, then it scrolls)
  what: { marginTop: 6, borderWidth: 1, borderRadius: 5, paddingVertical: 5, paddingHorizontal: 7, maxHeight: 120, overflow: "hidden" },
  actions: { flexDirection: "row", columnGap: 6, marginTop: 8 },
  done: { marginTop: 4 },
  err: { paddingHorizontal: 4, paddingTop: 4 },
});
