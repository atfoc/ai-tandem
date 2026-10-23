// The subagent's drawer (the old page's Subagents.tsx SubThread, SubagentDrawer): the open subagent of the chat on screen, with its prompt, its own
// thread and its report. On the wide layouts it lies over the right of the window (700 points at most, 58 % of it); on the phone it is
// the pushed screen of the stack (AD-71: `drawer-screen`, whose bar has the back) and fills it. The store's `subDrawer` says which one is
// open; the drawer belongs to the chat on screen and closes with it (nav.ts), and a board chat's drawer shows only while its panel does.
//
// It closes by its ×, by the back and, on web, by Esc through the overlay stack (`useOverlayClose`): the layers that open over it (the large
// view of an image, a menu, the confirm dialog, the Subagents list) are on the stack above it and take their Esc first (B-SA-16, B-IM-09).
import React, { memo, useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { subInPrefix } from "@aiwb/core/logic/prefix.ts";
import { showReport, subAncestors, subagentOf, subLine, subReport, subStatus, subTree, subWaiting } from "@aiwb/core/logic/subagents.ts";
import { boardNames, shownView, subsOf, subThreadOf, threadOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useLayout } from "../../ui/useLayout.ts";
import { useOverlayClose } from "../../ui/useOverlayClose";
import { webStyle } from "../../ui/webstyle.ts";
import { Dots, ItemView, StickyList, chatMarkdownEnv, usePrefixEnd, useOffWhy } from "../chat/index.ts";
import { Markdown, MarkdownEnvProvider } from "../markdown/index.ts";
import { closeSub, openSub, useNow, useSubThread } from "./hooks.ts";
import { SubMark, SubName, SubStats } from "./Parts.tsx";

/** A chat's subagent as the drawer shows it: its state with what the Agent / Task call that started it says (the call is in the chat's
 *  thread, or in the outer subagent's). sa is undefined until the subagent is known. readOnly: it was started in the part copied from the
 *  thread's source, so its thread is read-only here (B-SA-17). */
function useSub(chat: string, sid: string) {
  const subs = useStore((s) => subsOf(s, chat));
  const raw = sid ? subs?.[sid] : undefined;
  const call = useStore((s) => (raw ? ((raw.parent ? subThreadOf(s, chat, raw.parent) : threadOf(s, chat))?.items ?? []).find((it) => it?.toolId === raw.tool) : undefined));
  const sa = useMemo(() => raw && (call ? subagentOf(call, subs, false) : { ...raw, status: subStatus(raw) }), [raw, call, subs]);
  const end = usePrefixEnd(chat);
  const readOnly = useStore((s) => subInPrefix(raw, subs, threadOf(s, chat)?.items, end));
  return { subs, call, sa, readOnly };
}

/** The drawer of the chat on screen: wide, over the right of the window; phone, the screen itself. */
export function SubagentDrawer() {
  const layout = useLayout();
  const win = useWindowDimensions();
  const t = useTokens();
  const d = useStore((s) => s.subDrawer);
  const phone = layout === "phone";
  const shown = useStore((s) => {
    const c = s.subDrawer && s.chats[s.subDrawer.chat];
    if (!c || s.sel.chat !== c.id) return false;
    return phone || !c.board || s.panel; // a board chat's drawer only while its panel shows (on the phone the chat is the screen)
  });
  const chat = useStore((s) => (d ? shownView(s, d.chat) : undefined));
  const { sa, readOnly } = useSub(d?.chat ?? "", d?.sub ?? "");
  const picking = useStore((s) => !!s.picking); // the wait for a point on the board ends with its own Esc
  const live = shown && !!chat && !!d && !!sa;
  useOverlayClose(live && !picking, closeSub);
  if (!live || !chat || !d || !sa) return null;
  const root = phone
    ? [styles.fill, { backgroundColor: t.bg }]
    : [styles.drawer, { width: Math.min(700, Math.round(win.width * 0.58)), backgroundColor: t.bg, borderLeftColor: t.line, boxShadow: t.shadowMd }];
  return (
    <MarkdownEnvProvider env={chatMarkdownEnv}>
      <View {...tid("sub-drawer", { status: sa.status, waiting: subWaiting(sa), readonly: readOnly, sub: sa.id, layout })} accessibilityLabel="Subagent" style={root as never}>
        <SubThread chat={chat} sid={d.sub} branch={d.branch} readOnly={readOnly} onClose={closeSub} onOpen={(sid) => openSub(chat.id, sid)} />
      </View>
    </MarkdownEnvProvider>
  );
}

type Row = { key: string; kind: "prompt" | "loading" | "item" | "starting" | "report"; item?: Item };

/** A subagent's prompt, live thread and report, with its header: what the drawer shows. chat: the chat whose subagent it is. branch: the
 *  branch the thread is of, where a card in it answers. onOpen: another subagent of the chat was chosen with ‹ › or a crumb. */
function SubThread({ chat, sid, branch, readOnly, onClose, onOpen }: { chat: ChatView; sid: string; branch: string; readOnly: boolean; onClose(): void; onOpen(sid: string): void }) {
  const t = useTokens();
  const { subs, call, sa } = useSub(chat.id, sid);
  const items = useSubThread(chat.id, sid, true);
  const off = useOffWhy(chat.id); // why a thread the app does not keep is not being loaded
  const server = serverOf(chat);
  const list = useMemo(() => subTree(subs).map((n) => n.sa), [subs]); // ‹ › goes through the tree: a subagent, then the ones it started
  const idx = sa ? list.findIndex((x) => x.id === sa.id) : -1;
  const above = subAncestors(sa, subs); // of a nested one: whose subagent it is, and the way back
  const running = sa?.status === "running";
  const waiting = !!sa && subWaiting(sa);
  const now = useNow(running);
  const names = boardNames(chat.id);
  const it: Item = call ?? { kind: "tool", toolId: sa?.tool };
  const report = sa && items && showReport(it, sa, items) ? subReport(it, sa, items) : "";
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (sa?.prompt) out.push({ key: "prompt", kind: "prompt" });
    if (!items) out.push({ key: "loading", kind: "loading" });
    (items ?? []).forEach((x, i) => { if (x) out.push({ key: `i${i}`, kind: "item", item: x }); });
    if (running && !waiting && items && !items.length) out.push({ key: "starting", kind: "starting" });
    if (report) out.push({ key: "report", kind: "report" });
    return out;
  }, [sa?.prompt, items, running, waiting, report]);
  const render = useCallback((row: Row) => (
    <View style={styles.row}>
      <RowView row={row} chat={chat} sa={sa!} branch={branch} readOnly={readOnly} off={off} report={report} />
    </View>
  ), [chat, sa, branch, readOnly, off, report]);
  if (!sa) return null;
  const line = subLine(it, sa, items, names, subs, now);
  const step = (by: number) => { const n = list[(idx + by + list.length) % list.length]; if (n) onOpen(n.id); };
  return (
    <>
      <View {...tid("sub-drawer-head")} style={[styles.head, { borderBottomColor: t.line }]}>
        {above.length > 0 && (
          <View {...tid("sub-crumbs")} style={styles.crumbs}>
            <Text size={11.5} tone="muted">Subagent of</Text>
            {above.map((p, i) => (
              <React.Fragment key={p.id}>
                {i > 0 && <Text size={11.5} tone="faint">›</Text>}
                <Pressable {...tid("sub-crumb", { sub: p.id })} role="button" accessibilityLabel={p.description || "Subagent"} onPress={() => onOpen(p.id)}
                  {...({ title: i === above.length - 1 ? "Open the subagent that started this one" : "Open this subagent" } as object)}>
                  <Text size={11.5} tone="accent" numberOfLines={1} style={styles.crumb}>{p.description || "Subagent"}</Text>
                </Pressable>
              </React.Fragment>
            ))}
          </View>
        )}
        <View {...tid("sub-drawer-top")} style={styles.top}>
          <SubMark status={sa.status} waiting={waiting} />
          <View style={styles.title}><SubName sa={sa} size={13} /></View>
          {list.length > 1 && (
            <View {...tid("sub-nav")} style={styles.nav}>
              <IconButton {...tid("sub-prev")} title="Previous subagent" size="sm" onPress={() => step(-1)}>{(c) => <Text size={14} style={{ color: c }}>‹</Text>}</IconButton>
              <Text {...tid("sub-pos")} size={11.5} tone="muted" style={styles.num}>{idx + 1}/{list.length}</Text>
              <IconButton {...tid("sub-next")} title="Next subagent" size="sm" onPress={() => step(1)}>{(c) => <Text size={14} style={{ color: c }}>›</Text>}</IconButton>
            </View>
          )}
          <IconButton {...tid("sub-close")} title="Close (Esc)" onPress={onClose}>{(c) => <Text size={15} style={{ color: c }}>×</Text>}</IconButton>
        </View>
        <Text {...tid("sub-line", { tone: line.tone })} size={11} numberOfLines={1} style={{ color: line.tone === "live" ? t.ok : line.tone === "error" ? t.danger : t.muted }}>{line.text}</Text>
        <View style={styles.statsRow}><SubStats sa={sa} items={items} now={now} server={server} wrap /></View>
      </View>
      <View {...tid("sub-drawer-body")} style={styles.body}>
        {/* a subagent at work follows the end of its thread; one that ended opens at its top (B-SM-10); another subagent starts over */}
        <StickyList rows={rows} renderRow={render} follow={running} resetKey={`${chat.id}/${sid}`} pad={14} />
      </View>
    </>
  );
}

const RowView = memo(function RowView({ row, chat, sa, branch, readOnly, off, report }: { row: Row; chat: ChatView; sa: NonNullable<ReturnType<typeof useSub>["sa"]>; branch: string; readOnly: boolean; off: string; report: string }) {
  switch (row.kind) {
    case "prompt": return <SubPrompt text={sa.prompt ?? ""} />;
    case "loading": return off
      ? <Text {...tid("sub-off")} size={12} tone="muted">{off}</Text>
      : <Line id="sub-loading" text="Loading…" />;
    case "starting": return <Line id="sub-starting" text="Starting…" />;
    case "item": return <ItemView item={row.item!} chat={chat} branch={branch} sub={sa} readOnly={readOnly} />;
    case "report": return (
      <View {...tid("sub-report")}>
        <Sub>Report</Sub>
        <Markdown text={report} board={chat.board} agent={chat.agent} of={chat.id} />
      </View>
    );
  }
});

/** The small upper-case heading above the prompt and the report (the card's `tool-sub`). */
function Sub({ children }: { children: string }) {
  return <Text size={10.5} tone="faint" style={styles.sub}>{children}</Text>;
}

function Line({ id, text }: { id: string; text: string }) {
  return (
    <View {...tid(id)} style={styles.line}>
      <Dots />
      <Text size={12} tone="muted">{text}</Text>
    </View>
  );
}

/** What the parent asked the subagent to do. Over 8 lines or 600 characters it is cut, with Show all and Show less (B-SA-11). */
function SubPrompt({ text }: { text: string }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const long = text.split("\n").length > 8 || text.length > 600;
  return (
    <View {...tid("sub-prompt")}>
      <Sub>Prompt</Sub>
      <View style={[styles.promptBox, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text {...tid("sub-prompt-text", { clamped: long && !all })} size={12} tone="muted" numberOfLines={long && !all ? 8 : undefined} style={styles.promptText}>{text}</Text>
      </View>
      {long ? (
        <Pressable {...tid("sub-prompt-more")} role="button" onPress={() => setAll(!all)} style={[styles.more, webStyle({ cursor: "pointer" })]}>
          <Text size={12} tone="accent">{all ? "Show less" : "Show all"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, minWidth: 0 },
  drawer: { position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 45, borderLeftWidth: 1, minHeight: 0 },
  head: { flexShrink: 0, rowGap: 4, paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1 },
  crumbs: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 4, rowGap: 2, minWidth: 0 },
  crumb: { maxWidth: 240 },
  top: { flexDirection: "row", alignItems: "center", columnGap: 8 },
  title: { flex: 1, minWidth: 0 },
  nav: { flexDirection: "row", alignItems: "center", columnGap: 2 },
  num: { fontVariant: ["tabular-nums"] },
  statsRow: { flexDirection: "row", minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  row: { paddingBottom: 8, minWidth: 0 },
  line: { flexDirection: "row", alignItems: "center", columnGap: 8, padding: 2 },
  sub: { textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 },
  promptBox: { borderWidth: 1, borderRadius: 7, paddingVertical: 7, paddingHorizontal: 9 },
  promptText: { flexShrink: 1 },
  more: { alignSelf: "flex-start", paddingVertical: 4 },
});
