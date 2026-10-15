// The context split in the usage popup (the old page's Composer.tsx SplitView, SplitBar, SplitRow): a bar over the whole window with a segment per category
// in a fixed order and colour slot (logic/ctxsplit.ts), a row per category with its tokens and share of the window (a press opens its parts or its
// items), what is listed but not loaded, and the agent's facts. Pointing at a segment or a row marks both (a mouse hovers, a finger's press marks).
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type TextStyle } from "react-native";

import { agentName } from "@aiwb/core/agents.ts";
import { byTokens, deferred, freeTokens, partSegments, segments, share, tokensText, width, type Segment } from "@aiwb/core/logic/ctxsplit.ts";
import type { AgentKind, ContextSplit } from "@aiwb/core/types.ts";

import { Chevron } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import type { Tokens } from "../../ui/tokens.ts";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { useHovered } from "../../ui/useHovered";
import { webStyle } from "../../ui/webstyle.ts";

const TABULAR: TextStyle = { fontVariant: ["tabular-nums"] };

/** The colour of a segment's slot: 0 an unknown category (neutral), 1…8 the chart colours; the buffer is hatched, free space the line's colour. */
function fillOf(g: Segment, t: Tokens): object {
  if (g.cat.kind === "buffer") return webStyle({ backgroundImage: `repeating-linear-gradient(45deg, ${t.faint} 0 1.5px, ${t.line} 1.5px 4px)` }) ?? { backgroundColor: t.faint, opacity: 0.6 };
  if (g.cat.kind === "free") return { backgroundColor: t.line };
  if (g.cat.kind === "deferred") return {};
  const colour = [t.faint, t.viz1, t.viz2, t.viz3, t.viz4, t.viz5, t.viz6, t.viz7, t.viz8][g.slot] ?? t.faint;
  return { backgroundColor: colour };
}

/** Segments side by side over `win` tokens; the rest of the track is free space. */
function SplitBar({ segs, win, hover, setHover, nested }: { segs: Segment[]; win: number; hover: string; setHover: (id: string) => void; nested?: boolean }) {
  const t = useTokens();
  const marked = segs.some((g) => g.cat.id === hover); // a row of another bar leaves this one alone
  return (
    <View {...tid("split-bar")} role="img" aria-label={segs.map((g) => `${g.cat.label} ${share(g.cat.tokens, win)}`).join(", ")}
      style={[styles.bar, nested && styles.barNested]}>
      {segs.map((g) => <SegmentBox key={g.cat.id} g={g} win={win} dim={marked && hover !== g.cat.id} fill={fillOf(g, t)} setHover={setHover} />)}
      <View style={[styles.free, { backgroundColor: t.line }]} />
    </View>
  );
}

function SegmentBox({ g, win, dim, fill, setHover }: { g: Segment; win: number; dim: boolean; fill: object; setHover: (id: string) => void }) {
  const title = `${g.cat.label}: ${tokensText(g.cat.tokens)} tokens (${share(g.cat.tokens, win)})`;
  const ref = useControlRef(title);
  return (
    <Pressable ref={ref} {...tid("split-seg", { cat: g.cat.id, slot: g.slot })} accessible={false} focusable={false}
      onHoverIn={() => setHover(g.cat.id)} onPress={() => setHover(g.cat.id)}
      style={[styles.seg, { flexBasis: `${width(g.cat.tokens, win)}%` }, fill, dim && { opacity: 0.3 }]} />
  );
}

/** A category's row: swatch, label, tokens and share of the window. With parts (Claude's Messages) a press opens their own bar and rows; with
 *  items, a list of them, largest first. */
function SplitRow({ g, win, hover, setHover, depth = 0 }: { g: Segment; win: number; hover: string; setHover: (id: string) => void; depth?: number }) {
  const t = useTokens();
  const [open, setOpen] = useState(false);
  const { cat } = g;
  const parts = partSegments(cat.parts);
  const items = byTokens(cat.items);
  const more = parts.length > 0 || items.length > 0;
  const title = cat.chars ? `${tokensText(cat.chars)} characters` : undefined;
  const ref = useControlRef(title);
  const on = hover === cat.id;
  const body = (
    <>
      <View style={[styles.caret, open && { transform: [{ rotate: "90deg" }] }]}>{more && <Chevron color={t.faint} />}</View>
      <View style={[styles.sw, g.cat.kind === "deferred" && { borderWidth: 1, borderStyle: "dashed", borderColor: t.faint }, fillOf(g, t)]} />
      <Text size={12} tone={cat.kind === "deferred" ? "muted" : "text"} numberOfLines={1} style={styles.label} {...tid("split-label")}>{cat.label}</Text>
      <Text size={12} tone={cat.kind === "deferred" ? "muted" : "text"} style={[styles.num, TABULAR]} {...tid("split-num")}>{tokensText(cat.tokens)}</Text>
      <Text size={12} tone="muted" style={[styles.pct, TABULAR]} {...tid("split-pct")}>{share(cat.tokens, win)}</Text>
    </>
  );
  const row = [styles.row, { paddingLeft: 4 + depth * 12 }, on && { backgroundColor: t.hover2 }];
  const data = tid("split-row", { cat: cat.id, on: on || undefined });
  return (
    <>
      {more
        ? <Pressable ref={ref} {...data} role="button" aria-expanded={open} onPress={() => setOpen(!open)} onHoverIn={() => setHover(cat.id)}
            style={[row, webStyle({ cursor: "pointer" })]}>{body}</Pressable>
        : <Pressable ref={ref} {...data} accessible={false} focusable={false} onHoverIn={() => setHover(cat.id)} onPress={() => setHover(cat.id)} style={row}>{body}</Pressable>}
      {open && parts.length > 0 && (
        <View style={{ paddingLeft: 16 + depth * 12 }}>
          <SplitBar segs={parts} win={cat.tokens} hover={hover} setHover={setHover} nested />
        </View>
      )}
      {open && parts.map((p) => <SplitRow key={p.cat.id} g={p} win={win} hover={hover} setHover={setHover} depth={depth + 1} />)}
      {open && items.length > 0 && (
        <View style={{ paddingLeft: 30 + depth * 12, paddingRight: 8, paddingBottom: 4 }}>
          {items.map((it, i) => (
            <View key={i} {...tid("split-item")} style={styles.item}>
              <ItemName name={it.name} note={it.note} />
              <Text size={11.5} style={[styles.num, TABULAR]}>{tokensText(it.tokens)}</Text>
            </View>
          ))}
        </View>
      )}
    </>
  );
}

function ItemName({ name, note }: { name: string; note?: string }) {
  const ref = useControlRef(note ? `${name} (${note})` : name);
  return (
    <View ref={ref} style={styles.itemName}>
      <Text size={11.5} tone="muted" numberOfLines={1}>{name}{note ? <Text size={11.5} tone="faint">{` · ${note}`}</Text> : null}</Text>
    </View>
  );
}

/** The split: the bar over the whole window, a row per category, free space, what is listed but not loaded, the agent's facts and the foot. */
export function SplitView({ agent, s, loading }: { agent: AgentKind; s: ContextSplit; loading: boolean }) {
  const [hover, setHover] = useState("");
  const [ref, hovered] = useHovered();
  useEffect(() => { if (!hovered) setHover(""); }, [hovered]); // a mouse that leaves the split unmarks (a finger's mark stays)
  const win = s.window || s.total;
  const segs = segments(agent, s.categories);
  const free = freeTokens(s.categories, win);
  const notLoaded = deferred(s.categories);
  const row = (g: Segment) => <SplitRow key={g.cat.id} g={g} win={win} hover={hover} setHover={setHover} />;
  return (
    <View ref={ref} {...tid("split")} style={styles.split}>
      <SplitBar segs={segs} win={win} hover={hover} setHover={setHover} />
      {segs.map(row)}
      {free > 0 && <SplitRow g={{ cat: { id: "free", label: "Free space", tokens: free, kind: "free" }, slot: 0 }} win={win} hover={hover} setHover={setHover} />}
      {notLoaded.length > 0 && (
        <>
          <Text size={11} tone="muted" style={styles.sub}>Listed, loaded when used</Text>
          {notLoaded.map((cat) => row({ cat, slot: 0 }))}
        </>
      )}
      {!!s.facts?.length && (
        <View {...tid("split-facts")} style={styles.facts}>
          {s.facts.map((f) => (
            <View key={f.label} style={styles.fact}>
              <Text size={11} tone="muted">{f.label}</Text>
              <Text size={11} style={[styles.factValue, TABULAR]}>{f.value}</Text>
            </View>
          ))}
        </View>
      )}
      <Text {...tid("split-foot")} size={10.5} tone="faint" style={styles.foot}>
        {loading ? "Updating…" : `As of message ${s.atMessage} · ${tokensText(s.total)} tokens as ${agentName(agent)} counts them`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  split: { paddingTop: 2 },
  bar: { flexDirection: "row", gap: 2, height: 10, marginTop: 4, marginBottom: 6, marginHorizontal: 8, borderRadius: 4, overflow: "hidden" },
  barNested: { height: 6, marginTop: 2, marginBottom: 4, marginLeft: 0 },
  seg: { flexGrow: 0, flexShrink: 0, minWidth: 3, height: "100%" },
  free: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "stretch", paddingVertical: 2, paddingRight: 8, borderRadius: 4 },
  caret: { width: 12, alignItems: "center" },
  sw: { width: 8, height: 8, borderRadius: 2 },
  label: { flex: 1, minWidth: 0 },
  num: { textAlign: "right" },
  pct: { width: 38, textAlign: "right" },
  item: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 1, paddingRight: 46 },
  itemName: { flex: 1, minWidth: 0 },
  sub: { paddingTop: 6, paddingHorizontal: 8, paddingBottom: 2 },
  facts: { paddingTop: 6, paddingHorizontal: 8, gap: 1 },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  factValue: { textAlign: "right", flexShrink: 1 },
  foot: { paddingTop: 4, paddingHorizontal: 8 },
});
