// The parts of an open card (the old page's ToolCard.tsx PartView, decided by core's logic/toolcard.ts): the file with what a change adds
// and removes, a titled text, a change as rows, a note. A long text or change is its first and last part until "Show all"; shown whole
// it lies in a box of at most BOX points that scrolls. Nothing wider than the card: lines wrap, a name with nowhere to break is cut by the
// platform's own rule (overflow-wrap: anywhere).
import { memo, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { clipRows, clipText, leftText, type Left, type Part } from "@aiwb/core/logic/toolcard.ts";
import type { DiffRow } from "@aiwb/core/logic/linediff.ts";

import { MONO } from "../../ui/fonts.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { alpha } from "../chat/colour.ts";
import { Code, CODE_LINE, CODE_SIZE, codeStyle } from "./Code.tsx";
import { noSelect, wrap } from "./webtext.ts";

/** The tallest box of a part shown whole (styles.css `.tool-text.all`): what is over it scrolls in the box. */
export const BOX = 480;

export const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** A link-like control of a card ("Show all", "Show less", "Show"). */
export function CardLink({ label, onPress, id }: { label: string; onPress: () => void; id: string }) {
  const t = useTokens();
  return (
    <Pressable testID={id} role="button" onPress={onPress} hitSlop={6} style={styles.link}>
      {({ hovered }: { hovered?: boolean; pressed: boolean }) => <Text size={12} style={{ color: t.accent, textDecorationLine: hovered ? "underline" : "none" }}>{label}</Text>}
    </Pressable>
  );
}

export const PartView = memo(function PartView({ part, children }: { part: Part; children?: ReactNode }) {
  switch (part.part) {
    case "path": return <PathPart part={part} />;
    case "text": return <TextPart part={part} />;
    case "change": return <><ChangePart part={part} />{children}</>;
    case "note": return <Text {...tid("tool-note")} tone="muted" size={12} style={wrap}>{part.text}</Text>;
  }
});

function PathPart({ part }: { part: Extract<Part, { part: "path" }> }) {
  const t = useTokens();
  const ref = useControlRef(part.full);
  return (
    <View ref={ref} {...tid("tool-path", { full: part.full })} style={styles.path}>
      <Text {...tid("tool-path-name")} mono size={11.5} style={[styles.pathName, wrap]}>{part.path}</Text>
      {part.added !== undefined && (
        <Text {...tid("tool-counts")} mono size={11.5} style={styles.flat}>
          <Text mono size={11.5} style={{ color: t.ok }}>+{part.added}</Text>{" "}<Text mono size={11.5} style={{ color: t.danger }}>−{part.removed}</Text>
        </Text>
      )}
      {part.lines !== undefined && <Text {...tid("tool-lines")} mono size={11.5} tone="faint" style={styles.flat}>{plural(part.lines, "line")}</Text>}
    </View>
  );
}

/** What lies between a long part's first and last, and the control that shows all of it. */
function Omitted({ text, onAll, pad }: { text: string; onAll: () => void; pad?: boolean }) {
  return (
    <View {...tid("tool-omit")} style={[styles.omit, pad && styles.omitPad]}>
      <Text {...tid("tool-omit-text")} size={11} tone="faint" selectable={false} style={noSelect}>{text}</Text>
      <CardLink id="tool-show-all" label="Show all" onPress={onAll} />
    </View>
  );
}
const Less = ({ onLess }: { onLess: () => void }) => <View {...tid("tool-omit")} style={styles.omit}><CardLink id="tool-show-less" label="Show less" onPress={onLess} /></View>;

/** The box of a long part: it keeps what it holds out of the card's width, and, shown whole, scrolls in BOX points. */
function Box({ id, data, all, failed, children }: { id: string; data?: Record<string, string | number | boolean | undefined>; all: boolean; failed?: boolean; children: ReactNode }) {
  const t = useTokens();
  const box = [styles.box, { backgroundColor: failed ? alpha(t.danger, 0.05) : t.bg, borderColor: failed ? `${alpha(t.danger, 0.55)}` : t.line }];
  return all
    ? <ScrollView {...tid(id, data)} nestedScrollEnabled style={[box, { maxHeight: BOX }]}>{children}</ScrollView>
    : <View {...tid(id, data)} style={box}>{children}</View>;
}

/** A titled text: the command, the output, a written file's content, an input, a result. A long one is its first and last part until all of
 *  it is asked for. */
function TextPart({ part }: { part: Extract<Part, { part: "text" }> }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipText(part.text), [part.text]);
  const whole = all && !!clip.left;
  return (
    <View {...tid("tool-part", { failed: part.failed || undefined })} style={styles.part}>
      <Sub title={part.title}>{part.failed && <Text size={10.5} style={{ color: t.danger }}>{" · failed"}</Text>}</Sub>
      {part.lead ? <Text {...tid("tool-lead")} tone="muted" size={12} style={[styles.lead, wrap]}>{part.lead}</Text> : null}
      {part.text ? (
        <Box id="tool-text" all={whole} failed={part.failed}>
          <View style={styles.textIn}>
            <Code text={whole ? part.text : clip.head} lang={part.lang} />
            {!whole && clip.left && <Omitted text={`⋯ ${leftText(clip.left)}`} onAll={() => setAll(true)} />}
            {!whole && clip.tail ? <Code text={clip.tail} lang={part.lang} /> : null}
          </View>
        </Box>
      ) : null}
      {whole && <Less onLess={() => setAll(false)} />}
    </View>
  );
}

function Sub({ title, children }: { title: string; children?: ReactNode }) {
  return <Text {...tid("tool-sub")} tone="faint" size={10.5} style={[styles.sub, wrap]}>{title}{children}</Text>;
}

/** One edit's change: its lines removed and added, with the unchanged ones around them. */
function ChangePart({ part }: { part: Extract<Part, { part: "change" }> }) {
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipRows(part.diff.rows), [part.diff]);
  const whole = all && !!clip.left;
  const head = whole ? part.diff.rows : clip.head;
  return (
    <View {...tid("tool-part")} style={styles.part}>
      <Sub title={part.title} />
      <Box id="tool-diff" all={whole}>
        {head.map((r, i) => <Row key={i} row={r} />)}
        {!whole && clip.left && <Omitted pad text={`⋯ ${leftText(clip.left satisfies Left)}`} onAll={() => setAll(true)} />}
        {!whole && clip.tail.map((r, i) => <Row key={head.length + i} row={r} />)}
      </Box>
      {whole && <Less onLess={() => setAll(false)} />}
    </View>
  );
}

/** A row of a change. The sign is not part of what is selected with the line: a copied change is its lines (B-TC-15). */
const Row = memo(function Row({ row }: { row: DiffRow }) {
  const t = useTokens();
  if (row.kind === "skip") {
    return <View {...tid("diff-row", { kind: "skip" })} style={styles.skip}><Text selectable={false} tone="faint" size={11} style={noSelect}>⋯ {plural(row.count, "unchanged line")}</Text></View>;
  }
  const add = row.kind === "add", del = row.kind === "del";
  return (
    <View {...tid("diff-row", { kind: row.kind })} style={[styles.row, add && { backgroundColor: alpha(t.ok, 0.15) }, del && { backgroundColor: alpha(t.danger, 0.13) }]}>
      <Text {...tid("diff-sign")} selectable={false} mono size={CODE_SIZE} style={[styles.sign, { color: add ? t.ok : del ? t.danger : t.faint }, noSelect]}>{add ? "+" : del ? "-" : " "}</Text>
      <Text {...tid("diff-text")} style={[codeStyle, styles.diffText, { color: t.text }]}>{row.text}</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  link: { paddingHorizontal: 4 },
  path: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 10, rowGap: 2, minWidth: 0 },
  pathName: { minWidth: 0, flexShrink: 1 },
  flat: { flexShrink: 0 },
  omit: { flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 3 },
  omitPad: { paddingHorizontal: 7 },
  box: { marginTop: 3, overflow: "hidden", borderWidth: 1, borderRadius: 5 },
  part: { minWidth: 0 },
  textIn: { paddingVertical: 5, paddingHorizontal: 7 },
  sub: { textTransform: "uppercase", letterSpacing: 0.42 },
  lead: { marginTop: 2 },
  row: { flexDirection: "row" },
  sign: { width: 14, textAlign: "center", fontFamily: MONO },
  diffText: { flex: 1, minWidth: 0, minHeight: CODE_SIZE * CODE_LINE, paddingRight: 7 },
  skip: { paddingVertical: 2, paddingHorizontal: 7 },
});
