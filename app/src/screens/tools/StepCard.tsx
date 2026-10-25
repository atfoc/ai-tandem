// A tool call's card on the phone (ux-improvements goal 3.5, package T2): a step of two lines, at least 44 pt high: the mark, the label and
// (for an edit) what it adds and removes, then the command or the file; a press opens it. A failed step opens by itself with its exit
// code, the whole command (with Copy) and the last lines of its output; an edit shows its diff with line numbers under a fade, at most ten
// rows of it, and Show full diff. The wide layouts keep ToolCard.tsx's card; what it shows is decided by core's logic/toolcard.ts and
// logic/steps.ts, the parts of the wide card (Parts.tsx) are not used here.
//
// The testIDs: the root keeps the wide card's (`tool-card` with its dataSet) and holds the step's own (T2_TID.step), so that a check that
// reads either finds the card; the header is `tool-row`, the label `tool-label` inside the title `step-title`, the line `step-line` holds
// `tool-hint` or `step-exit`.
import { createContext, useContext, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { toolDone, toolVerb } from "@aiwb/core/logic/labels.ts";
import { keyOn, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { linesOf, numbered, anchorOf, type NumberedRow } from "@aiwb/core/logic/linediff.ts";
import { listsOf, serverOf } from "@aiwb/core/logic/serverlists.ts";
import { capRows, exitCode, headLine, lastLines, rowNumber, unifiedText } from "@aiwb/core/logic/steps.ts";
import { cardParts, cardRow, hintBeside, type Part, type Where } from "@aiwb/core/logic/toolcard.ts";
import { boardNames, shownBranch } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { copyText } from "../../platform/clipboard";
import { useStore } from "../../state/useStore.ts";
import { MONO } from "../../ui/fonts.ts";
import { DisclosureChevron } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { alpha } from "../chat/colour.ts";
import { select } from "../shell/nav.ts";
import { Code } from "./Code.tsx";
import { openFullDiff } from "./diff.ts";
import { T2_TID } from "./ids.ts";
import { BOX, plural } from "./Parts.tsx";
import { pre, wrap } from "./webtext.ts";

/** The subagent whose thread the step is in: the card of a subagent's own thread says so here (undefined in the chat's own thread), and
 *  Show full diff names the call by it. */
export const StepSub = createContext<string | undefined>(undefined);

/** What the person chose for a step, by chat, branch and call: a step that was opened (or closed) is as it was when its row comes back
 *  into the thread's virtual list. A step with no choice follows its own default: open when it failed. */
const choice = new Map<string, boolean>();

/** The most rows of an edit's diff a step draws, and how many lines of an output before "Show all output". */
const ROWS = 10, LAST = 6;
/** The size of the words of a step's buttons and the type of its code. */
const WORD = 15, CODE = 13;

const copy = (text: string, what = "Copied") => {
  copyText(text).then(() => showToast({ text: what }), (e) => console.error(e));
};

export function StepCard({ item, chat, live = true }: { item: Item; chat: ChatView; live?: boolean }) {
  const t = useTokens();
  const branch = useStore((s) => shownBranch(s, chat.id));
  const key = item.toolId ? `${chat.id}:${branch}\n${item.toolId}` : "";
  const [picked, setPicked] = useState<boolean | undefined>(() => (key ? choice.get(key) : undefined));
  const failed = !!item.isError;
  const open = picked ?? failed; // a step that failed is open until the person closes it
  const toggle = () => { if (key) choice.set(key, !open); setPicked(!open); };
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
  const bad = failed || !!item.denied;
  const label = item.denied ? `${toolVerb(name, input, boardName)} — denied`
    : cut ? `${toolVerb(name, input, boardName)} — stopped`
    : running ? toolVerb(name, input, boardName) + "…"
    : toolDone(name, item.input, item.result, boardName);
  const row = useMemo(() => cardRow(item, live, where), [item, live, where]);
  const code = failed && row.kind === "shell" ? exitCode(item) : null;
  const hint = hintBeside(label, row.hint);
  const counts = useMemo(() => (open || row.kind === "edit" || row.kind === "write" || row.kind === "delete" ? countsOf(item, live, where) : null), [item, live, where, open, row.kind]);
  const border = failed ? t.danger : t.line;
  return (
    <View {...tid("tool-card", { kind: row.kind, state: row.state, running: running || undefined, err: bad || undefined, open })}>
      <View {...tid(T2_TID.step, { kind: row.kind, state: row.state, failed, open })}
        style={[styles.card, { borderColor: border, backgroundColor: failed ? alpha(t.danger, 0.06) : t.panel }]}>
        <Pressable {...tid("tool-row")} role="button" aria-expanded={open} accessibilityLabel={`${label}${failed ? ", failed" : ""}`} onPress={toggle} style={styles.head}>
          <Mark running={running} cut={cut} bad={bad} />
          <View style={styles.titles}>
            <View style={styles.titleRow}>
              <Text {...tid(T2_TID.stepTitle)} size={TYPE.busy} weight="500" tone={failed ? "danger" : "text"} style={[styles.title, wrap]}>
                <Text {...tid("tool-label")} size={TYPE.busy} weight="500" tone={failed ? "danger" : "text"}>{label}</Text>{failed ? " · failed" : ""}
              </Text>
              {counts && counts.added + counts.removed > 0 && (
                <Text {...tid(T2_TID.stepCounts)} size={TYPE.busy} weight="500" style={styles.flat}>
                  <Text size={TYPE.busy} weight="500" tone="ok">+{counts.added}</Text>{counts.removed > 0 || counts.kind !== "write" ? <>{" "}<Text size={TYPE.busy} weight="500" tone="danger">−{counts.removed}</Text></> : null}
                </Text>
              )}
            </View>
            {(code !== null || hint) && (
              code !== null
                ? <Text {...tid(T2_TID.stepLine)} size={TYPE.secondary} tone="muted" numberOfLines={1}><Text {...tid(T2_TID.stepExit)} size={TYPE.secondary} tone="muted">exit code {code}</Text></Text>
                : <Text {...tid(T2_TID.stepLine)} mono size={TYPE.secondary} tone="muted" numberOfLines={1}><Text {...tid("tool-hint")} mono size={TYPE.secondary} tone="muted">{hint}</Text></Text>
            )}
          </View>
          {target && !running && (
            <Pressable testID="tool-show" role="button" accessibilityLabel="Show the board" onPress={() => select({ board: target, chat: target === chat.board ? chat.id : null })} style={styles.show}>
              <Text size={WORD} tone="accent">Show</Text>
            </Pressable>
          )}
          <View style={[styles.chev, { transform: [{ rotate: open ? "90deg" : "0deg" }] }]}><DisclosureChevron color={t.faint} /></View>
        </Pressable>
        {open && <Body item={item} chat={chat} branch={branch} live={live} where={where} kind={row.kind} failed={failed} />}
      </View>
    </View>
  );
}

const safeParse = (s?: string) => { try { return s ? JSON.parse(s) : {}; } catch { return s ? { "…": s } : {}; } };

/** The mark at the head's left: a ✓, a red disc with "!", a spinner while it runs, ■ when its subagent ended before it did. */
function Mark({ running, cut, bad }: { running: boolean; cut: boolean; bad: boolean }) {
  const t = useTokens();
  return (
    <View style={styles.mark}>
      {running ? <ActivityIndicator {...tid("tool-spin")} size="small" color={t.muted} />
        : bad ? <View style={[styles.disc, { backgroundColor: t.dangerFill }]}><Text {...tid("tool-icon")} size={13} weight="700" tone="onDanger" style={styles.bang}>!</Text></View>
        : <Text {...tid("tool-icon")} size={TYPE.busy} weight="700" tone={cut ? "muted" : "ok"}>{cut ? "■" : "✓"}</Text>}
    </View>
  );
}

/** What an edit, a write or a delete adds and removes, from the parts of its card (the same numbers the wide card's path line has). */
function countsOf(item: Item, live: boolean, where: Where): { added: number; removed: number; kind: "write" | "edit" } | null {
  const p = cardParts(item, live, where).find((x) => x.part === "path");
  if (!p || p.part !== "path") return null;
  if (p.added !== undefined) return { added: p.added, removed: p.removed ?? 0, kind: "edit" };
  if (p.lines !== undefined) return { added: p.lines, removed: 0, kind: "write" };
  return null;
}

/** The open step: by its kind, the command and the output, or the diff, or a tool's input and result; then the notes of the card. */
function Body({ item, chat, branch, live, where, kind, failed }: { item: Item; chat: ChatView; branch: string; live: boolean; where: Where; kind: string; failed: boolean }) {
  const t = useTokens();
  const made = useMemo(() => cardParts(item, live, where), [item, live, where]);
  const files = kind === "edit" || kind === "write" || kind === "delete";
  const changes = made.filter((p): p is Extract<Part, { part: "change" }> => p.part === "change");
  const content = kind === "write" ? made.find((p): p is Extract<Part, { part: "text" }> => p.part === "text" && p.title === "Content") : undefined;
  const flush = files && (changes.length > 0 || !!content); // the diff's rows run from the head's line down
  return (
    <View {...tid("tool-detail")} style={[styles.body, flush && styles.flush, { borderTopColor: failed ? alpha(t.danger, 0.35) : t.line }]}>
      {made.map((p, i) => {
        switch (p.part) {
          case "path": return null;
          case "note": return <Text key={i} {...tid("tool-note")} size={TYPE.secondary} tone="muted" style={[styles.pad, wrap]}>{p.text}</Text>;
          case "change": return null;
          case "text":
            if (files && p === content) return null;
            if (p.title === "Command") return <CommandBox key={i} text={p.text} />;
            return <Output key={i} title={p.title} text={p.text} failed={!!p.failed} />;
        }
      })}
      {files && (changes.length > 0 || content) && <Diff item={item} chat={chat} branch={branch} changes={changes} content={content?.text} where={where} />}
    </View>
  );
}

/** "$ " and the whole command, wrapped and never cut, with Copy (a 44 pt target) at its right. */
function CommandBox({ text }: { text: string }) {
  const t = useTokens();
  return (
    <View {...tid(T2_TID.stepCommand)} style={[styles.command, styles.pad, { borderColor: t.line2, backgroundColor: t.bg }]}>
      <Text mono size={CODE} style={[styles.commandText, wrap]} selectable>{`$ ${text}`}</Text>
      <Pressable {...tid(T2_TID.stepCommandCopy)} role="button" accessibilityLabel="Copy command" onPress={() => copy(text)} style={[styles.commandCopy, { borderLeftColor: t.line2 }]}>
        <Text size={WORD} tone="accent">Copy</Text>
      </Pressable>
    </View>
  );
}

/** A titled text of the call (its output, a result, a tool's input): the last lines of it in a box, "Show all output" for the rest, and Copy. */
function Output({ title, text, failed }: { title: string; text: string; failed: boolean }) {
  const t = useTokens();
  const [all, setAll] = useState(false);
  const last = useMemo(() => lastLines(text, LAST), [text]);
  const more = last.total > LAST;
  const whole = all && more;
  const shown = (whole ? text.replace(/\n$/, "") : last.text).replace(/\t/g, "    "); // (a tab is four columns, as in the wide card)
  const tone = failed ? "danger" : "muted";
  const box = [styles.box, { backgroundColor: failed ? alpha(t.danger, 0.04) : t.bg, borderColor: failed ? alpha(t.danger, 0.5) : t.line2 }];
  const word = title === "Output" ? "Show all output" : "Show all";
  return (
    <View style={[styles.pad, styles.output]}>
      <View style={styles.outHead}>
        <Text size={TYPE.secondary} tone={tone} weight={failed ? "500" : undefined} style={[styles.outTitle, wrap]}>{title}</Text>
        {more && <Text size={TYPE.secondary} tone="muted">{whole ? `all ${last.total} lines` : `last ${last.shown} of ${last.total} lines`}</Text>}
      </View>
      {text ? (
        whole
          ? <ScrollView {...tid(T2_TID.stepOutput)} nestedScrollEnabled style={[box, { maxHeight: BOX }]}><View style={styles.boxIn}><Code text={shown} size={CODE} /></View></ScrollView>
          : <View {...tid(T2_TID.stepOutput)} style={box}><View style={styles.boxIn}><Code text={shown} size={CODE} /></View></View>
      ) : null}
      <View style={styles.buttons}>
        {more && (
          <Button {...tid(T2_TID.stepOutputAll)} size="touch" accessibilityLabel={whole ? "Show less" : `${word}, ${plural(last.total, "line")}`} onPress={() => setAll(!whole)} style={styles.grow}>
            <Text size={WORD}>{whole ? "Show less" : word}</Text>{!whole && <Text size={WORD} tone="muted"> · {plural(last.total, "line")}</Text>}
          </Button>
        )}
        <Button {...tid(T2_TID.stepOutputCopy)} size="touch" accessibilityLabel={`Copy ${title.toLowerCase()}`} onPress={() => copy(text)} style={styles.copy}>
          <Text size={WORD}>Copy</Text>
        </Button>
      </View>
    </View>
  );
}

/** The text a Write put in its file, an edit's first new text: what `anchorOf` looks for in the result's numbered lines. */
function firstNew(input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [];
  const v = i.new_string ?? i.newText ?? edits[0]?.new_string ?? edits[0]?.newText;
  return typeof v === "string" ? v : "";
}

type Shown = { head: number | null; rows: NumberedRow[] };

/** A change's rows from one line before its first changed one: the card's ten rows go to what changed (the head says the line), the
 *  lines before it are in the full diff. The numbers were counted on all the rows, so they stay the file's. */
function fromChange(rows: NumberedRow[]): NumberedRow[] {
  const first = rows.findIndex((r) => r.kind === "add" || r.kind === "del");
  if (first <= 1) return rows;
  const from = rows[first - 1].kind === "skip" ? first : first - 1;
  return rows.slice(from);
}

/** An edit's, a write's or a delete's change as rows with one line-number column and a sign, ten rows of the whole card at most under a fade,
 *  then Show full diff and Copy. The file's line numbers are known only for the first change and only when the result shows them. */
function Diff({ item, chat, branch, changes, content, where }: { item: Item; chat: ChatView; branch: string; changes: Extract<Part, { part: "change" }>[]; content?: string; where: Where }) {
  const t = useTokens();
  const sub = useContext(StepSub);
  const made = useMemo(() => {
    const result = typeof item.result === "string" ? item.result : undefined;
    const anchor = anchorOf(result, firstNew(item.input));
    const groups: Shown[] = content !== undefined
      ? [{ head: null, rows: numbered(linesOf(content).map((text) => ({ kind: "add" as const, text }))) }]
      : changes.map((c, n) => {
        const rows = fromChange(numbered(c.diff.rows, anchor !== null && n === 0 ? { a: anchor, b: anchor } : undefined));
        return { head: anchor !== null && n === 0 ? headLine(rows) : null, rows };
      });
    return groups;
  }, [item.result, item.input, changes, content]);
  const cap = useMemo(() => capRows(made.map((g) => g.rows), ROWS), [made]);
  const width = useMemo(() => {
    let top = 0;
    for (const rows of cap.changes) for (const r of rows) top = Math.max(top, rowNumber(r) ?? 0);
    return String(top).length * 8 + 14;
  }, [cap]);
  const file = (item.input as { file_path?: string; path?: string } | undefined);
  const path = file?.file_path ?? file?.path ?? "";
  const base = path.split("/").filter(Boolean).pop() ?? path;
  const fade = cap.left > 0;
  return (
    <View style={styles.diff}>
      <View style={styles.rowsWrap}>
        {cap.changes.map((rows, n) => (
          <View key={n} {...tid(T2_TID.stepDiff)}>
            {made[n].head !== null && <Text size={TYPE.secondary} tone="muted" style={[styles.pad, styles.headLine]}>line {made[n].head}</Text>}
            {rows.map((r, i) => <DiffRow key={i} row={r} width={width} />)}
          </View>
        ))}
        {fade && <Fade color={t.panel} />}
      </View>
      <View style={[styles.pad, styles.buttons]}>
        <Button {...tid(T2_TID.stepDiffFull)} size="touch" accessibilityLabel="Show full diff" style={styles.grow}
          onPress={() => openFullDiff({ chat: chat.id, branch, tool: item.toolId ?? "", sub, file: base })}>
          <Text size={WORD}>Show full diff</Text>{fade && <Text size={WORD} tone="muted"> · {plural(cap.left, "more line")}</Text>}
        </Button>
        <Button {...tid(T2_TID.stepDiffCopy)} size="touch" accessibilityLabel="Copy the diff" style={styles.copy}
          onPress={() => copy(content !== undefined ? content : unifiedText(changes.map((c) => c.diff.rows)))}>
          <Text size={WORD}>Copy</Text>
        </Button>
      </View>
    </View>
  );
}

/** A row of the diff: its number, its sign, its line on one line (the full diff wraps or scrolls sideways); a stretch of unchanged lines is told in one row. */
function DiffRow({ row, width }: { row: NumberedRow; width: number }) {
  const t = useTokens();
  if (row.kind === "skip") {
    return <View {...tid("diff-row", { kind: "skip", a: row.a, b: row.b })} style={[styles.skip, styles.pad]}><Text size={TYPE.secondary} tone="faint" selectable={false}>⋯ {plural(row.count, "unchanged line")}</Text></View>;
  }
  const add = row.kind === "add", del = row.kind === "del";
  const ink = add ? t.ok : del ? t.danger : t.faint;
  return (
    // (an added row's tint is 10 %: its "+" in the theme's green stays at 3:1 on the step's panel ground in Latte, where 15 % gave 2.91:1)
    <View {...tid("diff-row", { kind: row.kind, a: row.a, b: row.b })} style={[styles.diffRow, add && { backgroundColor: alpha(t.ok, 0.1) }, del && { backgroundColor: alpha(t.danger, 0.13) }]}>
      <Text selectable={false} mono size={CODE} style={[styles.num, { width, color: ink }]}>{rowNumber(row)}</Text>
      <Text {...tid("diff-sign")} selectable={false} mono size={CODE} style={[styles.sign, { color: ink }]}>{add ? "+" : del ? "−" : " "}</Text>
      <Text {...tid("diff-text")} mono size={CODE} numberOfLines={1} style={[styles.diffText, pre]}>{row.text.replace(/\t/g, "  ")}</Text>
    </View>
  );
}

/** The fade at the bottom of the rows: the card's colour, from clear to solid (a CSS gradient on the web, a few bands where there is none). */
function Fade({ color }: { color: string }) {
  const web = webStyle({ backgroundImage: `linear-gradient(to bottom, ${alpha(color, 0)}, ${color})` });
  return (
    <View pointerEvents="none" style={[styles.fade, web]}>
      {web ? null : [0.2, 0.45, 0.7, 0.92].map((a) => <View key={a} style={[styles.band, { backgroundColor: alpha(color, a) }]} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  outTitle: { flexShrink: 1, minWidth: 0 },
  card: { borderWidth: 1, borderRadius: 8, minWidth: 0, alignSelf: "stretch", overflow: "hidden" },
  head: { flexDirection: "row", alignItems: "center", columnGap: 10, minHeight: PHONE.target + 8, paddingVertical: 8, paddingHorizontal: 12, minWidth: 0 },
  mark: { width: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  disc: { width: 20, height: 20, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bang: { lineHeight: 16 },
  titles: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: "row", alignItems: "baseline", columnGap: 8, minWidth: 0 },
  title: { flexShrink: 1, minWidth: 0 },
  flat: { flexShrink: 0 },
  show: { minHeight: PHONE.target, justifyContent: "center", paddingHorizontal: 6, flexShrink: 0 },
  chev: { flexShrink: 0, width: 16, alignItems: "center" },
  body: { borderTopWidth: 1, paddingTop: 12, paddingBottom: 12, rowGap: 12, minWidth: 0 },
  flush: { paddingTop: 0 },
  pad: { marginHorizontal: 12 },
  command: { flexDirection: "row", alignItems: "stretch", borderWidth: 1, borderRadius: 6, minWidth: 0 },
  commandText: { flex: 1, minWidth: 0, paddingVertical: 10, paddingHorizontal: 10 },
  commandCopy: { minWidth: 72, minHeight: PHONE.target, alignItems: "center", justifyContent: "center", borderLeftWidth: 1 },
  output: { rowGap: 6, minWidth: 0 },
  outHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", columnGap: 8 },
  box: { borderWidth: 1, borderRadius: 6, overflow: "hidden", minWidth: 0 },
  boxIn: { paddingVertical: 8, paddingHorizontal: 10 },
  buttons: { flexDirection: "row", columnGap: 8, alignItems: "stretch" },
  grow: { flex: 1, alignSelf: "stretch", minWidth: 0 },
  copy: { alignSelf: "stretch", minWidth: 79 },
  diff: { rowGap: 12, minWidth: 0 },
  rowsWrap: { position: "relative", minWidth: 0 },
  headLine: { paddingVertical: 4 },
  diffRow: { flexDirection: "row", alignItems: "flex-start", paddingRight: 8 },
  num: { textAlign: "right", paddingRight: 6, fontFamily: MONO, flexShrink: 0 },
  sign: { width: 16, textAlign: "center", fontFamily: MONO, flexShrink: 0 },
  diffText: { flex: 1, minWidth: 0 },
  skip: { paddingVertical: 2 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 36, justifyContent: "flex-end" },
  band: { flex: 1 },
});
