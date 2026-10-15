// A tool call's card (the old page's ToolCard.tsx): in a chat's thread and in a subagent's drawer, both through the chat view's ItemView. Closed it
// is one row: the mark, the label, and beside it the command's first line or the file's path. Open it shows the call in parts, by its kind.
// What it shows is decided from the item by core's logic/toolcard.ts (the diffs by logic/linediff.ts); this file and Parts.tsx draw that.
// Nothing of an open card is made while the card is closed (B-TC-34). An item the card cannot draw costs its own card (B-TH-17).
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { toolDone, toolVerb } from "@aiwb/core/logic/labels.ts";
import { keyOn, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { listsOf, serverOf } from "@aiwb/core/logic/serverlists.ts";
import { cardParts, cardRow, hintBeside, shownParts, type Where } from "@aiwb/core/logic/toolcard.ts";
import { boardNames, shownBranch } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { Guard } from "../shell/Guard.tsx";
import { select } from "../shell/nav.ts";
import { CardLink, PartView, plural } from "./Parts.tsx";
import { wrap } from "./webtext.ts";

const safeParse = (s?: string) => { try { return s ? JSON.parse(s) : {}; } catch { return s ? { "…": s } : {}; } };

/** A tool call. live is false in a subagent's thread once it ended: a call with no result was cut. An item the card cannot draw costs its
 *  own card, not the thread: "Couldn't show this tool call." with the cause, and the card is drawn again when its item changes. */
export function ToolCard(p: { item: Item; chat: ChatView; live?: boolean }) {
  return <Guard what="this tool call" resetKey={p.item}><Card {...p} /></Guard>;
}

/** The cards the user opened, by chat, branch and call: the thread is a virtual list that lets a row go when it is far off screen, and a card
 *  that was opened is open again when its row comes back. Another branch's thread is a thread of its own (B-TH-18): a call of the part
 *  that two branches share is closed there. */
const opened = new Set<string>();

function Card({ item, chat, live = true }: { item: Item; chat: ChatView; live?: boolean }) {
  const t = useTokens();
  const branch = useStore((s) => shownBranch(s, chat.id));
  const key = item.toolId ? `${chat.id}:${branch}\n${item.toolId}` : "";
  const [open, setOpenNow] = useState(() => !!key && opened.has(key));
  const setOpen = (on: boolean) => { if (key) { if (on) opened.add(key); else opened.delete(key); } setOpenNow(on); };
  const name = typeof item.name === "string" ? item.name : "";
  const target = useStore((s) => {
    const id = (item.input as { board?: unknown } | undefined)?.board;
    if (!id || !name.startsWith("mcp__board__")) return undefined;
    const b = s.boards[keyOn(serverOfKey(chat.id), String(id))]; // the agent names a board by its id on the chat's own server
    return b && !b.archived ? b.id : undefined;
  });
  const boardName = boardNames(chat.id);
  const home = useStore((s) => listsOf(s, serverOf(chat))?.home);
  const where = useMemo<Where>(() => ({ cwd: chat.cwd, home }), [chat.cwd, home]);
  const input = (item.input ?? safeParse(item.partial)) as Record<string, unknown>;
  const running = live && item.result === undefined && !item.denied;
  const cut = !live && item.result === undefined && !item.denied; // its subagent ended mid-call
  const err = !!(item.isError || item.denied);
  const label = item.denied ? `${toolVerb(name, input, boardName)} — denied`
    : cut ? `${toolVerb(name, input, boardName)} — stopped`
    : running ? toolVerb(name, input, boardName) + "…"
    : toolDone(name, item.input, item.result, boardName);
  const row = useMemo(() => cardRow(item, live, where), [item, live, where]);
  const hint = hintBeside(label, row.hint);
  const show = () => {
    if (target) select({ board: target, chat: target === chat.board ? chat.id : null });
  };
  return (
    <View {...tid("tool-card", { kind: row.kind, state: row.state, running: running || undefined, err: err || undefined, open })}
      style={[styles.card, { borderColor: t.line, backgroundColor: t.panel }]}>
      <Pressable {...tid("tool-row")} role="button" aria-expanded={open} accessibilityLabel={label} onPress={() => setOpen(!open)} style={styles.row}>
        <View style={styles.icon}>
          {running
            ? <ActivityIndicator {...tid("tool-spin")} size="small" color={t.muted} style={styles.spin} />
            : <Text {...tid("tool-icon")} size={12} weight="700" style={{ color: err || cut ? (cut ? t.muted : t.danger) : t.ok }}>{cut ? "■" : err ? "!" : "✓"}</Text>}
        </View>
        <Text {...tid("tool-label")} size={12} tone={running ? "text" : "muted"} style={[styles.label, wrap]}>{label}</Text>
        <Text {...tid("tool-hint")} mono size={11} tone="faint" numberOfLines={1} style={styles.hint}>{hint}</Text>
        {target && !running && <CardLink id="tool-show" label="Show" onPress={show} />}
        <Text {...tid("tool-chev")} size={10} tone="faint" style={styles.chev}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open && <Detail item={item} live={live} where={where} />}
    </View>
  );
}

/** The open card: its parts in order. A card of many edits draws the first of them until asked. */
function Detail({ item, live, where }: { item: Item; live: boolean; where: Where }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const made = useMemo(() => cardParts(item, live, where), [item, live, where]);
  const { parts, left } = shownParts(made, all);
  const last = parts.findLastIndex((p) => p.part === "change"); // the edits not drawn follow the last one that is
  return (
    <View {...tid("tool-detail")} style={[styles.detail, { borderTopColor: t.line }]}>
      {parts.map((p, i) => (
        <PartView key={i} part={p}>
          {i === last && left > 0 && (
            <View {...tid("tool-more")} style={styles.more}>
              <Text {...tid("tool-more-text")} size={11} tone="faint" selectable={false}>⋯ {plural(left, "more edit")}</Text>
              <CardLink id="tool-show-all" label="Show all" onPress={() => setAll(true)} />
            </View>
          )}
        </PartView>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 7, minWidth: 0, alignSelf: "stretch" },
  row: { flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 5, paddingHorizontal: 8, minWidth: 0 },
  icon: { width: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  spin: { transform: [{ scale: 0.55 }], width: 14, height: 14 },
  label: { flexShrink: 1, minWidth: 0 },
  hint: { flex: 1, minWidth: 0 },
  chev: { flexShrink: 0 },
  detail: { borderTopWidth: 1, paddingTop: 7, paddingHorizontal: 8, paddingBottom: 8, rowGap: 7, minWidth: 0 },
  more: { flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 3 },
});
