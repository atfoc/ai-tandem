// The subagent as a screen of the phone's stack (ux-improvements goal 3.5, package T2): the kit's content bar (the chevron alone, the agent's
// tile, the task as the title and "Subagent 1 of 4 · Done" under it, no ×), the pills of its model, tools, time and context, then PROMPT,
// STEPS and REPORT, and a 44 pt bottom bar with the previous and the next subagent by name. The wide layouts keep `SubThread` of Drawer.tsx.
//
// A subagent that ended folds its steps to one row (a tap opens them in place, the row's head folds them again); one that still runs shows
// them open and follows the end of its thread, as the drawer does. A request that waits for an answer is never inside the fold: its card
// stands under the fold's row (X2, `fold.ts`).
import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { showReport, stepsLine, stepsSummary, subNeighbours, subReport, subScreenSub, subToolCount, subTree, subWaiting } from "@aiwb/core/logic/subagents.ts";
import { copyText } from "../../platform/clipboard";
import { haptic } from "../../platform/haptics";
import type { ChatView, Item, Subagent } from "@aiwb/core/types.ts";

import { ContentBar } from "../../ui/Bars.tsx";
import { AgentGlyph, DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { Dots, ItemView, StickyList, useOffWhy } from "../chat/index.ts";
import { StepSub } from "../tools/StepCard.tsx";
import { agentColours } from "../chat/colour.ts";
import { Markdown } from "../markdown/index.ts";
import { NavBack } from "../shell/BackButton.tsx";
import { T2_TID } from "../tools/ids.ts";
import { useNow, useSubThread } from "./hooks.ts";
import { foldedWaiting } from "./fold.ts";
import { SubPills } from "./Parts.tsx";

type Row =
  | { key: "pills" | "prompt" | "loading" | "starting" | "report" }
  | { key: "steps"; fold: boolean }
  | { key: string; item: Item };

/** The prompt, the steps and the report of one subagent under its bar, and the bar of its neighbours under them. sa: the subagent (the
 *  chat's record with what the call that started it says), call: that call, subs: the chat's subagents, onOpen: a neighbour was chosen. */
export function SubScreen({ chat, sa, call, subs, branch, readOnly, onOpen }: {
  chat: ChatView; sa: Subagent; call?: Item; subs: Record<string, Subagent> | undefined; branch: string; readOnly: boolean; onOpen(sid: string): void;
}) {
  const t = useTokens();
  const running = sa.status === "running";
  const waiting = subWaiting(sa);
  const items = useSubThread(chat.id, sa.id, true);
  const off = useOffWhy(chat.id); // why a thread the app does not keep is not being loaded
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const it: Item = call ?? { kind: "tool", toolId: sa.tool };
  const report = items && showReport(it, sa, items) ? subReport(it, sa, items) : "";
  const steps = subToolCount(sa, items);
  const folded = !running && !open && steps > 0; // an ended subagent's steps fold to one row; one at work shows them
  const waitingAsks = useMemo(() => foldedWaiting(items, readOnly), [items, readOnly]); // the requests the fold must not hide
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ key: "pills" }];
    if (sa.prompt) out.push({ key: "prompt" });
    if (steps > 0 || running || !items) out.push({ key: "steps", fold: !running && steps > 0 });
    if (!items) out.push({ key: "loading" });
    if (!folded) (items ?? []).forEach((x, i) => { if (x) out.push({ key: `i${i}`, item: x }); });
    else waitingAsks.forEach((i) => { const x = items?.[i]; if (x) out.push({ key: `i${i}`, item: x }); });
    if (running && !waiting && items && !items.length) out.push({ key: "starting" });
    if (report) out.push({ key: "report" });
    return out;
  }, [sa.prompt, items, running, waiting, report, steps, folded, waitingAsks]);
  const sum = useMemo(() => stepsSummary(items), [items]);
  const render = useCallback((row: Row) => (
    <View style={styles.row}>
      {"item" in row ? <StepSub.Provider value={sa.id}><ItemView item={row.item} chat={chat} branch={branch} sub={sa} readOnly={readOnly} /></StepSub.Provider> : (
        <Body row={row} chat={chat} sa={sa} items={items} now={now} off={off} report={report} open={open} onToggle={() => setOpen((o) => !o)}
          line={stepsLine(steps, sum)} />
      )}
    </View>
  ), [chat, sa, branch, readOnly, items, now, off, report, open, steps, sum]);
  const sub = subScreenSub(sa, subs);
  const a = agentColours(t, sa.kind ?? chat.agent);
  return (
    <View {...tid(T2_TID.subScreen, { sub: sa.id, status: sa.status })} style={styles.fill}>
      <ContentBar back={<NavBack />} title={sa.description || "Subagent"} sub={sub.text} subTone={sub.tone} titleTestID="sub-screen-title" subTestID="sub-screen-sub"
        leading={<View style={[styles.glyph, { backgroundColor: a.soft }]}><AgentGlyph agent={sa.kind ?? chat.agent} size={14} /></View>} />
      <View {...tid("sub-drawer-body")} style={styles.body}>
        {/* a subagent at work follows the end of its thread; one that ended opens at its top; another subagent starts over */}
        <StickyList rows={rows} renderRow={render} follow={running} resetKey={`${chat.id}/${sa.id}`} pad={12} padX={0} />
      </View>
      {subTree(subs).length > 1 ? <NeighbourBar sa={sa} subs={subs} onOpen={onOpen} /> : null}
    </View>
  );
}

const Body = memo(function Body({ row, chat, sa, items, now, off, report, open, onToggle, line }: {
  row: Exclude<Row, { item: Item }>; chat: ChatView; sa: Subagent; items?: Item[]; now: number; off: string; report: string; open: boolean; onToggle(): void; line: string;
}) {
  switch (row.key) {
    case "pills": return <View style={styles.pillsRow}><SubPills sa={sa} items={items} now={now} server={serverOf(chat)} /></View>;
    case "prompt": return <Prompt text={sa.prompt ?? ""} />;
    case "steps": return (
      <View {...tid("sub-steps-head")}>
        <Heading text="Steps" />
        {"fold" in row && row.fold ? <StepsFold line={line} open={open} onPress={onToggle} /> : null}
      </View>
    );
    case "loading": return off
      ? <Text {...tid("sub-off")} size={TYPE.secondary} tone="muted">{off}</Text>
      : <Line id="sub-loading" text="Loading…" />;
    case "starting": return <Line id="sub-starting" text="Starting…" />;
    case "report": return (
      <View {...tid("sub-report")}>
        <Heading text="Report" copy={{ id: T2_TID.subReportCopy, label: "Copy report", text: report }} />
        <Markdown text={report} board={chat.board} agent={chat.agent} of={chat.id} phone size={TYPE.body} />
      </View>
    );
  }
});

/** A heading above a part of the screen: 13 pt, upper case, muted, with its Copy (accent, a 44 pt target) at the right. */
function Heading({ text, copy }: { text: string; copy?: { id: string; label: string; text: string } }) {
  const press = () => {
    copyText(copy!.text).then(() => { haptic("select"); showToast({ text: "Copied" }); }, (e) => console.error(e));
  };
  return (
    <View style={styles.heading}>
      <Text size={TYPE.secondary} tone="muted" accessibilityRole="header" style={styles.headingText}>{text}</Text>
      {copy ? (
        <Pressable {...tid(copy.id)} role="button" accessibilityLabel={copy.label} onPress={press} style={[styles.copy, webStyle({ cursor: "pointer" })]}>
          <Text size={TYPE.busy} tone="accent">Copy</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** What the parent asked the subagent to do: 15 pt in a soft rounded box, cut past 8 lines or 600 characters with Show all (B-SA-11). */
function Prompt({ text }: { text: string }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const long = text.split("\n").length > 8 || text.length > 600;
  return (
    <View {...tid("sub-prompt")}>
      <Heading text="Prompt" copy={{ id: T2_TID.subPromptCopy, label: "Copy prompt", text }} />
      <View style={[styles.promptBox, { backgroundColor: t.panel, borderColor: t.line }]}>
        <Text {...tid("sub-prompt-text", { clamped: long && !all })} size={TYPE.busy} numberOfLines={long && !all ? 8 : undefined}>{text}</Text>
      </View>
      {long ? (
        <Pressable {...tid("sub-prompt-more")} role="button" accessibilityLabel={all ? "Show less of the prompt" : "Show all of the prompt"} onPress={() => setAll(!all)} style={styles.more}>
          <Text size={TYPE.busy} tone="accent">{all ? "Show less" : "Show all"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** An ended subagent's steps as one row in a dashed box: "14 steps · read 8 files". A tap opens them under it, a tap on it folds them. */
function StepsFold({ line, open, onPress }: { line: string; open: boolean; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(T2_TID.subSteps, { open })} role="button" accessibilityLabel={`${line}, ${open ? "fold the steps" : "show the steps"}`} accessibilityState={{ expanded: open }}
      onPress={onPress} style={[styles.fold, { borderColor: t.line2 }, webStyle({ cursor: "pointer" })]}>
      <View style={open ? styles.turned : undefined}><DisclosureChevron size={12} color={t.muted} /></View>
      <Text size={TYPE.busy} numberOfLines={1} style={styles.foldText}>{line}</Text>
    </Pressable>
  );
}

function Line({ id, text }: { id: string; text: string }) {
  return (
    <View {...tid(id)} style={styles.line}>
      <Dots />
      <Text size={TYPE.secondary} tone="muted">{text}</Text>
    </View>
  );
}

/** The bar under the screen when the chat has more than one subagent: the previous at the left and the next at the right by name, in the
 *  order of the chat's subagents and without wrapping round (the first has no previous, the last no next). The shell already keeps the
 *  home indicator's room under the screen. */
function NeighbourBar({ sa, subs, onOpen }: { sa: Subagent; subs: Record<string, Subagent> | undefined; onOpen(sid: string): void }) {
  const t = useTokens();
  const { prev, next } = subNeighbours(sa, subs);
  const side = (n: Subagent | undefined, id: string, label: string, left: boolean) => (
    <View style={[styles.side, left ? styles.sideLeft : styles.sideRight]}>
      {n ? (
        <Pressable {...tid(id, { sub: n.id })} role="button" accessibilityLabel={`${label}: ${n.description || "Subagent"}`} onPress={() => onOpen(n.id)}
          style={[styles.nav, left ? styles.navLeft : styles.navRight, webStyle({ cursor: "pointer" })]}>
          {left && <Text size={TYPE.busy} tone="accent" style={styles.arrow}>‹ </Text>}
          <Text size={TYPE.busy} tone="accent" numberOfLines={1} ellipsizeMode="tail" style={styles.navName}>{n.description || "Subagent"}</Text>
          {!left && <Text size={TYPE.busy} tone="accent" style={styles.arrow}> ›</Text>}
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View {...tid("sub-nav")} style={[styles.bar, { borderTopColor: t.line, backgroundColor: t.bg }]}>
      {side(prev, T2_TID.subPrev, "Previous subagent", true)}
      <View style={[styles.sep, { backgroundColor: t.line }]} />
      {side(next, T2_TID.subNext, "Next subagent", false)}
    </View>
  );
}

const styles = StyleSheet.create({
  navName: { flexShrink: 1, minWidth: 0 },
  fill: { flex: 1, minHeight: 0, minWidth: 0 },
  glyph: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minHeight: 0 },
  row: { paddingHorizontal: PHONE.margin, paddingBottom: 12, minWidth: 0 },
  pillsRow: { paddingTop: 10 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: PHONE.target },
  headingText: { textTransform: "uppercase", letterSpacing: 0.6 },
  copy: { minHeight: PHONE.target, minWidth: PHONE.target, justifyContent: "center", alignItems: "flex-end", marginRight: -4 },
  promptBox: { borderWidth: 1, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 14 },
  more: { alignSelf: "flex-start", minHeight: PHONE.target, justifyContent: "center" },
  fold: { minHeight: PHONE.target, flexDirection: "row", alignItems: "center", columnGap: 10, paddingHorizontal: 14, borderWidth: 1.5, borderStyle: "dashed", borderRadius: 14 },
  foldText: { flexShrink: 1 },
  turned: { transform: [{ rotate: "90deg" }] },
  line: { flexDirection: "row", alignItems: "center", columnGap: 8, padding: 2 },
  bar: { flexShrink: 0, height: PHONE.target, flexDirection: "row", alignItems: "center", borderTopWidth: StyleSheet.hairlineWidth },
  side: { flex: 1, minWidth: 0, height: PHONE.target, justifyContent: "center" },
  sideLeft: { alignItems: "flex-start" },
  sideRight: { alignItems: "flex-end" },
  nav: { minHeight: PHONE.target, maxWidth: "100%", minWidth: 0, flexShrink: 1, flexDirection: "row", flexWrap: "nowrap", alignItems: "center" },
  arrow: { flexShrink: 0 },
  navLeft: { paddingLeft: PHONE.margin, paddingRight: 12 },
  navRight: { paddingRight: PHONE.margin, paddingLeft: 12 },
  sep: { width: StyleSheet.hairlineWidth, height: 28 },
});
